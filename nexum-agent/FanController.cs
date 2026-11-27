using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// Fan enumeration, telemetry and software fan control (CONTRACT §1.2).
/// Not thread-safe by itself: every public member must be called while holding
/// <see cref="TelemetryService.SyncRoot"/>, the same lock that guards sensor updates.
/// </summary>
internal sealed class FanController
{
    public const string PresetAuto = "auto";
    public const string PresetSilent = "silent";
    public const string PresetBalanced = "balanced";
    public const string PresetTurbo = "turbo";
    public const string PresetCustom = "custom";

    /// <summary>Hard floor for any software duty cycle (presets and fanSet). Only "auto" goes lower, by releasing to BIOS.</summary>
    public const float MinSafeDutyPct = 20f;

    /// <summary>Minimum duty applied (by presets and fanSet) to anything that looks like a pump.</summary>
    private const float PumpMinPresetPct = 60f;

    private sealed class FanEntry
    {
        public required string Id { get; init; }
        public required ISensor Fan { get; init; }
        public required IHardware Hardware { get; init; }
        public ISensor? Control { get; init; }

        /// <summary>Presets only drive motherboard / Super I/O / EC / cooler-controller fans.</summary>
        public bool PresetEligible =>
            Control?.Control is not null &&
            Hardware.HardwareType is HardwareType.Motherboard or HardwareType.SuperIO
                or HardwareType.EmbeddedController or HardwareType.Cooler;

        public bool LooksLikePump
        {
            get
            {
                var n = (Fan.Name ?? "") + " " + (Control?.Name ?? "");
                return n.Contains("pump", StringComparison.OrdinalIgnoreCase) ||
                       n.Contains("aio", StringComparison.OrdinalIgnoreCase);
            }
        }
    }

    private readonly List<FanEntry> _fans = new();
    private readonly Dictionary<string, FanEntry> _byFanId = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FanEntry> _byControlId = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Controls we have switched to software mode (keyed by control sensor identifier).</summary>
    private readonly Dictionary<string, ISensor> _touched = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Last fanSet values per control identifier, used by the "custom" preset.</summary>
    private readonly Dictionary<string, float> _custom = new(StringComparer.OrdinalIgnoreCase);

    public string CurrentPreset { get; private set; } = PresetAuto;

    public int ControllableCount => _fans.Count(f => f.Control?.Control is not null);

    /// <summary>
    /// Re-enumerates fan sensors and pairs each with the Control sensor of the same index on the same hardware.
    /// GPU fans are deliberately excluded: they are reported in <c>gpu.fanRpm/fanPct</c> and are never
    /// software-controlled by Nexum (the GPU driver's own curve must stay in charge).
    /// </summary>
    public void Refresh(IEnumerable<IHardware> allHardwareFlattened)
    {
        _fans.Clear();
        _byFanId.Clear();
        _byControlId.Clear();

        foreach (var hw in allHardwareFlattened)
        {
            if (GpuMonitor.IsGpu(hw)) continue;
            var sensors = SensorsOf(hw);
            if (sensors.Length == 0) continue;

            var controls = sensors.Where(s => s is not null && s.SensorType == SensorType.Control).ToList();
            foreach (var fan in sensors.Where(s => s is not null && s.SensorType == SensorType.Fan).OrderBy(s => s.Index))
            {
                var id = SafeId(fan);
                if (id.Length == 0 || _byFanId.ContainsKey(id)) continue;

                ISensor? control = controls.FirstOrDefault(c => c.Index == fan.Index);
                var entry = new FanEntry { Id = id, Fan = fan, Hardware = hw, Control = control };
                _fans.Add(entry);
                _byFanId[id] = entry;
                if (control is not null)
                {
                    var cid = SafeId(control);
                    if (cid.Length > 0) _byControlId.TryAdd(cid, entry);
                }
            }
        }
    }

    public List<FanTelemetry> BuildTelemetry()
    {
        var list = new List<FanTelemetry>(_fans.Count);
        foreach (var f in _fans)
        {
            IControl? ctrl = null;
            try { ctrl = f.Control?.Control; } catch { /* ignore */ }

            double? pct = null;
            try { pct = Clamp(Round(f.Control?.Value), 0, 100); } catch { /* ignore */ }

            double rpm = 0;
            try { rpm = RoundOr(f.Fan.Value, 0); } catch { /* ignore */ }

            list.Add(new FanTelemetry
            {
                Id = f.Id,
                Name = string.IsNullOrWhiteSpace(f.Fan.Name) ? "Fan" : f.Fan.Name.Trim(),
                Hardware = SafeName(f.Hardware),
                Rpm = Math.Max(0, rpm),
                Controllable = ctrl is not null,
                ControlPct = pct,
            });
        }
        return list;
    }

    /// <summary>Applies a named preset. Returns ok + human message for the ack.</summary>
    public (bool Ok, string Message) ApplyPreset(string? preset)
    {
        var p = (preset ?? "").Trim().ToLowerInvariant();
        switch (p)
        {
            case PresetAuto:
            {
                int n = ReleaseToDefault(includeAllEligible: true);
                CurrentPreset = PresetAuto;
                _custom.Clear();
                return (true, n == 0
                    ? "Fan control released to BIOS (no software-controlled fans)"
                    : $"Released {n} fan{(n == 1 ? "" : "s")} to BIOS control");
            }
            case PresetSilent:
                return ApplyFixed(PresetSilent, "Silent", 30f);
            case PresetBalanced:
                return ApplyFixed(PresetBalanced, "Balanced", 50f);
            case PresetTurbo:
                return ApplyFixed(PresetTurbo, "Turbo", 100f);
            case PresetCustom:
                return ApplyCustom();
            default:
                return (false, $"Unknown fan preset '{preset}'");
        }
    }

    private (bool Ok, string Message) ApplyFixed(string key, string label, float pct)
    {
        var targets = _fans.Where(f => f.PresetEligible).ToList();
        if (targets.Count == 0)
        {
            return (false, Program.IsAdmin
                ? "No controllable motherboard fans detected"
                : "No controllable fans: administrator rights are required for fan control");
        }

        // Any control a previous fanSet switched to software mode but that this preset does not
        // drive (e.g. a cooler-controller channel that disappeared) goes back to its default curve.
        var targetIds = new HashSet<string>(targets.Select(f => SafeId(f.Control!)), StringComparer.OrdinalIgnoreCase);
        foreach (var (cid, sensor) in _touched.Where(kv => !targetIds.Contains(kv.Key)).ToList())
        {
            try
            {
                sensor.Control?.SetDefault();
                _touched.Remove(cid);
            }
            catch (Exception ex)
            {
                Program.Log($"SetDefault failed for {cid}: {ex.Message}");
            }
        }

        int applied = 0;
        var errors = new List<string>();
        foreach (var f in targets)
        {
            float duty = f.LooksLikePump ? Math.Max(pct, PumpMinPresetPct) : pct;
            if (TrySetSoftware(f, duty, out var err)) applied++;
            else errors.Add(err);
        }

        if (applied == 0)
        {
            return (false, $"Failed to apply {label}: {string.Join("; ", errors.Distinct())}");
        }

        CurrentPreset = key;
        var msg = $"Applied {label} to {applied} fan{(applied == 1 ? "" : "s")}";
        if (errors.Count > 0) msg += $" ({errors.Count} failed)";
        return (true, msg);
    }

    private (bool Ok, string Message) ApplyCustom()
    {
        if (_custom.Count == 0) return (false, "No custom fan values set yet");
        int applied = 0;
        foreach (var (controlId, pct) in _custom.ToList())
        {
            if (_byControlId.TryGetValue(controlId, out var f) && TrySetSoftware(f, pct, out _)) applied++;
        }
        if (applied == 0) return (false, "Custom fan values could not be applied");
        CurrentPreset = PresetCustom;
        return (true, $"Applied Custom to {applied} fan{(applied == 1 ? "" : "s")}");
    }

    /// <summary>Sets one fan (by fan id, or by its control id) to a fixed duty.</summary>
    public (bool Ok, string Message) SetFan(string? id, double pct)
    {
        if (string.IsNullOrWhiteSpace(id)) return (false, "Missing fan id");
        if (double.IsNaN(pct) || double.IsInfinity(pct)) return (false, "Invalid duty value");

        if (!_byFanId.TryGetValue(id, out var f) && !_byControlId.TryGetValue(id, out f))
        {
            return (false, $"Fan '{id}' not found");
        }
        if (f.Control?.Control is null)
        {
            return (false, $"{f.Fan.Name} is not software-controllable");
        }

        // Safety: never below MinSafeDutyPct (stall / overheating risk); pumps never below PumpMinPresetPct.
        float requested = (float)Math.Clamp(pct, 0, 100);
        float duty = Math.Max(requested, f.LooksLikePump ? PumpMinPresetPct : MinSafeDutyPct);
        if (!TrySetSoftware(f, duty, out var err)) return (false, err);

        _custom[SafeId(f.Control)] = duty;
        CurrentPreset = PresetCustom;
        var msg = $"Set {f.Fan.Name} to {Math.Round(duty)}%";
        if (duty > requested + 0.5f) msg += $" (raised from {Math.Round(requested)}% to the safe minimum)";
        return (true, msg);
    }

    /// <summary>Restores every control we touched (and, for "auto", every eligible control) to default.</summary>
    public int RestoreAll() => ReleaseToDefault(includeAllEligible: false, resetPreset: true);

    private int ReleaseToDefault(bool includeAllEligible, bool resetPreset = false)
    {
        var targets = new Dictionary<string, ISensor>(_touched, StringComparer.OrdinalIgnoreCase);
        if (includeAllEligible)
        {
            foreach (var f in _fans.Where(x => x.PresetEligible))
            {
                var cid = SafeId(f.Control!);
                if (cid.Length > 0) targets.TryAdd(cid, f.Control!);
            }
        }

        int restored = 0;
        foreach (var (cid, sensor) in targets)
        {
            try
            {
                var ctrl = sensor.Control;
                if (ctrl is null) continue;
                ctrl.SetDefault();
                restored++;
                _touched.Remove(cid);
            }
            catch (Exception ex)
            {
                Program.Log($"SetDefault failed for {cid}: {ex.Message}");
            }
        }

        if (resetPreset)
        {
            CurrentPreset = PresetAuto;
        }
        return restored;
    }

    private bool TrySetSoftware(FanEntry f, float pct, out string error)
    {
        error = "";
        var sensor = f.Control;
        IControl? ctrl = null;
        try { ctrl = sensor?.Control; } catch { /* ignore */ }
        if (sensor is null || ctrl is null)
        {
            error = $"{f.Fan.Name}: not controllable";
            return false;
        }

        try
        {
            // Effective window = [MinSafeDutyPct, 100] intersected with the control's own software range.
            float min = MinSafeDutyPct, max = 100f;
            try
            {
                float lo = ctrl.MinSoftwareValue, hi = ctrl.MaxSoftwareValue;
                if (float.IsFinite(lo) && float.IsFinite(hi) && lo <= hi)
                {
                    min = Math.Max(MinSafeDutyPct, lo);
                    max = Math.Min(100f, hi);
                }
            }
            catch { /* use MinSafeDutyPct..100 */ }

            if (min > max)
            {
                error = $"{f.Fan.Name}: control range does not allow a safe duty (>= {MinSafeDutyPct}%)";
                return false;
            }
            float target = float.IsFinite(pct) ? pct : 100f;
            ctrl.SetSoftware(Math.Clamp(target, min, max));
            var cid = SafeId(sensor);
            if (cid.Length > 0) _touched[cid] = sensor;
            return true;
        }
        catch (Exception ex)
        {
            error = $"{f.Fan.Name}: {ex.Message}";
            Program.Log($"SetSoftware failed for {f.Id}: {ex}");
            return false;
        }
    }
}
