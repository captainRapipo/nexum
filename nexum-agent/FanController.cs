using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// Fan enumeration, telemetry and the low-level software fan writes (CONTRACT §1.2). Policy (who may
/// write when: admin, override, failsafe, write-ahead flag) lives in <see cref="FanSafety"/>.
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
        public required string HwId { get; init; }
        public ISensor? Control { get; init; }
        public string ControlId { get; init; } = "";

        /// <summary>
        /// GPU fans are listed (CONTRACT §1.1.1) but never written by Nexum: the GPU driver's own curve
        /// stays in charge. They are therefore reported as not controllable.
        /// </summary>
        public bool IsGpu => GpuMonitor.IsGpu(Hardware);

        public bool Controllable
        {
            get
            {
                if (IsGpu || ControlId.Length == 0) return false;
                try { return Control?.Control is not null; } catch { return false; }
            }
        }

        /// <summary>Presets and the override drive motherboard / Super I/O / EC / cooler-controller fans only.</summary>
        public bool PresetEligible =>
            Controllable &&
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

    /// <summary>Controls this process has switched to software mode (keyed by control sensor identifier).</summary>
    private readonly Dictionary<string, ISensor> _touched = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The user's current target duty per control id (presets and fanSet). Applied unless the override holds 100%.</summary>
    private readonly Dictionary<string, float> _intent = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Last fanSet values per control identifier, used by the "custom" preset.</summary>
    private readonly Dictionary<string, float> _custom = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Last REQUESTED preset (CONTRACT telemetry.fanPreset).</summary>
    public string CurrentPreset { get; private set; } = PresetAuto;

    /// <summary>True while at least one control is in software mode written by this process.</summary>
    public bool HasTouched => _touched.Count > 0;

    public int ControllableCount => _fans.Count(f => f.Controllable);

    /// <summary>Hardware ids of GPUs that own a control this process touched (always empty under the current policy).</summary>
    public IReadOnlyCollection<string> TouchedGpuHwIds =>
        _touched.Values.Select(s => s.Hardware).Where(h => h is not null && GpuMonitor.IsGpu(h)).Select(SafeId)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>Re-enumerates fan sensors and pairs each with the Control sensor of the same index on the same hardware.</summary>
    public void Refresh(IEnumerable<IHardware> allHardwareFlattened)
    {
        _fans.Clear();
        _byFanId.Clear();
        _byControlId.Clear();

        foreach (var hw in allHardwareFlattened)
        {
            var sensors = SensorsOf(hw);
            if (sensors.Length == 0) continue;
            var hwId = SafeId(hw);

            var controls = sensors.Where(s => s is not null && s.SensorType == SensorType.Control).ToList();
            foreach (var fan in sensors.Where(s => s is not null && s.SensorType == SensorType.Fan).OrderBy(s => s.Index))
            {
                var id = SafeId(fan);
                if (id.Length == 0 || _byFanId.ContainsKey(id)) continue;

                ISensor? control = controls.FirstOrDefault(c => c.Index == fan.Index);
                var entry = new FanEntry
                {
                    Id = id, Fan = fan, Hardware = hw, HwId = hwId, Control = control,
                    ControlId = control is null ? "" : SafeId(control),
                };
                _fans.Add(entry);
                _byFanId[id] = entry;
                if (entry.ControlId.Length > 0) _byControlId.TryAdd(entry.ControlId, entry);
            }
        }
    }

    public List<FanTelemetry> BuildTelemetry()
    {
        var list = new List<FanTelemetry>(_fans.Count);
        foreach (var f in _fans)
        {
            double? pct = null;
            try { pct = Clamp(Round(f.Control?.Value), 0, 100); } catch { /* ignore */ }

            double rpm = 0;
            double? min = null, max = null;
            try
            {
                rpm = RoundOr(f.Fan.Value, 0, 0);
                min = Round(f.Fan.Min, 0);
                max = Round(f.Fan.Max, 0);
            }
            catch { /* ignore */ }

            list.Add(new FanTelemetry
            {
                Id = f.Id,
                Name = string.IsNullOrWhiteSpace(f.Fan.Name) ? "Fan" : f.Fan.Name.Trim(),
                Hardware = SafeName(f.Hardware),
                HwId = f.HwId,
                Rpm = Math.Max(0, rpm),
                RpmMin = min.HasValue ? Math.Max(0, min.Value) : null,
                RpmMax = max.HasValue ? Math.Max(0, max.Value) : null,
                Controllable = f.Controllable,
                ControlPct = pct,
            });
        }
        return list;
    }

    // ---------------------------------------------------------------------------------------------
    // Intent (what the user asked for). Does not write hardware.

    internal sealed record IntentSnapshot(string Preset, Dictionary<string, float> Intent, Dictionary<string, float> Custom);

    public IntentSnapshot SaveIntent() =>
        new(CurrentPreset, new Dictionary<string, float>(_intent, StringComparer.OrdinalIgnoreCase),
            new Dictionary<string, float>(_custom, StringComparer.OrdinalIgnoreCase));

    public void RestoreIntent(IntentSnapshot s)
    {
        CurrentPreset = s.Preset;
        _intent.Clear();
        foreach (var kv in s.Intent) _intent[kv.Key] = kv.Value;
        _custom.Clear();
        foreach (var kv in s.Custom) _custom[kv.Key] = kv.Value;
    }

    /// <summary>Records a non-auto preset as the target. Returns false (and leaves the intent untouched) when it cannot apply.</summary>
    public (bool Ok, string Message, string Label) SetPresetIntent(string? preset)
    {
        var p = (preset ?? "").Trim().ToLowerInvariant();
        switch (p)
        {
            case PresetSilent: return SetFixedIntent(PresetSilent, "Silent", 30f);
            case PresetBalanced: return SetFixedIntent(PresetBalanced, "Balanced", 50f);
            case PresetTurbo: return SetFixedIntent(PresetTurbo, "Turbo", 100f);
            case PresetCustom:
            {
                var valid = _custom.Where(kv => _byControlId.TryGetValue(kv.Key, out var f) && f.Controllable).ToList();
                if (valid.Count == 0) return (false, "No custom fan values set yet", "Custom");
                _intent.Clear();
                foreach (var kv in valid) _intent[kv.Key] = kv.Value;
                CurrentPreset = PresetCustom;
                return (true, "", "Custom");
            }
            default:
                return (false, $"Unknown fan preset '{preset}'", "");
        }
    }

    private (bool Ok, string Message, string Label) SetFixedIntent(string key, string label, float pct)
    {
        var targets = _fans.Where(f => f.PresetEligible).ToList();
        if (targets.Count == 0) return (false, "No controllable motherboard fans detected", label);

        _intent.Clear();
        foreach (var f in targets)
        {
            _intent[f.ControlId] = f.LooksLikePump ? Math.Max(pct, PumpMinPresetPct) : pct;
        }
        CurrentPreset = key;
        return (true, "", label);
    }

    /// <summary>Records one fan's duty (by fan id or control id). Returns the human message for the ack.</summary>
    public (bool Ok, string Message) SetFanIntent(string? id, double pct)
    {
        if (string.IsNullOrWhiteSpace(id)) return (false, "Missing fan id");
        if (double.IsNaN(pct) || double.IsInfinity(pct)) return (false, "Invalid duty value");

        if (!_byFanId.TryGetValue(id, out var f) && !_byControlId.TryGetValue(id, out f))
        {
            return (false, $"Fan '{id}' not found");
        }
        if (!f.Controllable)
        {
            return (false, f.IsGpu
                ? $"{f.Fan.Name} is controlled by the graphics driver; Nexum does not change GPU fans"
                : $"{f.Fan.Name} is not software-controllable");
        }

        // Safety: never below MinSafeDutyPct (stall / overheating risk); pumps never below PumpMinPresetPct.
        float requested = (float)Math.Clamp(pct, 0, 100);
        float duty = Math.Max(requested, f.LooksLikePump ? PumpMinPresetPct : MinSafeDutyPct);

        // Switching from a fixed preset to per-fan values keeps the other fans at their preset duty.
        _intent[f.ControlId] = duty;
        _custom[f.ControlId] = duty;
        CurrentPreset = PresetCustom;

        var msg = $"Set {f.Fan.Name} to {Math.Round(duty)}%";
        if (duty > requested + 0.5f) msg += $" (raised from {Math.Round(requested)}% to the safe minimum)";
        return (true, msg);
    }

    /// <summary>Forgets all targets (used by the auto preset).</summary>
    public void ClearIntent()
    {
        _intent.Clear();
        _custom.Clear();
        CurrentPreset = PresetAuto;
    }

    // ---------------------------------------------------------------------------------------------
    // Hardware writes

    /// <summary>Writes the intent: every target control gets its duty; touched controls without a target return to default.</summary>
    public (int Applied, List<string> Errors) ApplyIntent()
    {
        int applied = 0;
        var errors = new List<string>();
        foreach (var (cid, duty) in _intent.ToList())
        {
            if (!_byControlId.TryGetValue(cid, out var f))
            {
                errors.Add($"{cid}: not found");
                continue;
            }
            if (TrySetSoftware(f, duty, out var err)) applied++;
            else errors.Add(err);
        }

        foreach (var (cid, sensor) in _touched.Where(kv => !_intent.ContainsKey(kv.Key)).ToList())
        {
            try
            {
                sensor.Control?.SetDefault();
                _touched.Remove(cid);
            }
            catch (Exception ex)
            {
                Program.Log($"SetDefault failed for {cid}: {ex.Message}");
                errors.Add($"{cid}: {ex.Message}");
            }
        }
        return (applied, errors);
    }

    /// <summary>
    /// Override / failsafe: drives every preset-eligible control (and anything already touched) to <paramref name="pct"/>.
    /// With <paramref name="onlyIfBelow"/> a control already at or above the duty is not rewritten.
    /// </summary>
    public (int Count, List<string> Errors) ForceAll(float pct, bool onlyIfBelow = false)
    {
        int count = 0;
        var errors = new List<string>();
        var targets = _fans.Where(f => f.PresetEligible).ToList();
        foreach (var cid in _touched.Keys.ToList())
        {
            if (_byControlId.TryGetValue(cid, out var f) && f.Controllable && !targets.Contains(f)) targets.Add(f);
        }

        foreach (var f in targets)
        {
            if (onlyIfBelow && _touched.ContainsKey(f.ControlId))
            {
                float? current = null;
                try { current = Finite(f.Control?.Value); } catch { /* ignore */ }
                if (current.HasValue && current.Value >= pct - 1f) { count++; continue; }
            }
            if (TrySetSoftware(f, pct, out var err)) count++;
            else errors.Add(err);
        }
        return (count, errors);
    }

    /// <summary>
    /// Returns controls to their default (BIOS) mode: every touched control and, with
    /// <paramref name="includeAllEligible"/>, every preset-eligible control. AllOk is true when every
    /// touched control was restored.
    /// </summary>
    public (int Restored, bool AllOk) ReleaseAll(bool includeAllEligible)
    {
        var targets = new Dictionary<string, ISensor>(_touched, StringComparer.OrdinalIgnoreCase);
        if (includeAllEligible)
        {
            foreach (var f in _fans.Where(x => x.PresetEligible))
            {
                if (f.ControlId.Length > 0 && f.Control is not null) targets.TryAdd(f.ControlId, f.Control);
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
        return (restored, _touched.Count == 0);
    }

    private bool TrySetSoftware(FanEntry f, float pct, out string error)
    {
        error = "";
        if (!f.Controllable)
        {
            error = $"{f.Fan.Name}: not controllable";
            return false;
        }
        var sensor = f.Control!;
        IControl? ctrl = null;
        try { ctrl = sensor.Control; } catch { /* ignore */ }
        if (ctrl is null)
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
            _touched[f.ControlId] = sensor;
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
