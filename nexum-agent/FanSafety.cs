using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// Fan-control policy and fail-safe (CONTRACT §1.2, §1.5, MF-13): admin gate, write-ahead flag,
/// thermal override and the failsafe latch. Wraps <see cref="FanController"/>; every member must be
/// called while holding <see cref="TelemetryService.SyncRoot"/>.
/// Presets are fixed duty cycles that ignore temperature; this class is what keeps them safe.
/// </summary>
internal sealed class FanSafety
{
    public const double CpuTriggerC = 85.0;
    public const double CpuReleaseC = 75.0;
    public const double GpuHotspotTriggerC = 100.0;
    public const double GpuEdgeTriggerC = 90.0;
    public const double HysteresisC = 10.0;
    public const int Consecutive = 3;

    /// <summary>The override must be evaluated at least this often while manual control is active.</summary>
    public const int MaxEvalGapMs = 1000;

    public const string MsgNeedsAdmin = "Fan control needs administrator rights";
    public const string MsgLocked = "Fan control is locked at 100% after an interruption. Restart the PC to return fans to BIOS control.";
    public const string MsgUnsafeFolder = "Fan control is unavailable: unsafe state folder";
    public const string MsgFlagFailed = "Fan control is unavailable: could not record the fan-control state";
    public const string MsgSavedCpu = "Saved. Fans stay at 100% until the CPU cools to 75 °C.";
    public const string MsgSavedGpu = "Saved. Fans stay at 100% until the GPU cools.";
    public const string MsgSavedSensor = "Saved. Fans stay at 100% until the temperature sensor reads again.";

    public const string ReasonFailsafe = "failsafe";
    public const string ReasonSensorMissing = "sensorMissing";
    public const string ReasonCpuTemp = "cpuTemp";
    public const string ReasonGpuTemp = "gpuTemp";

    internal sealed class TempState
    {
        public bool Hot;
        public bool Missing;
        public int MissingStreak;
        public int ReleaseStreak;
        public bool Active => Hot || Missing;
    }

    private readonly FanController _fans;
    private readonly IFanFlagStore _store;
    private readonly bool _elevated;
    private readonly TempState _cpu = new();
    private readonly Dictionary<string, TempState> _gpus = new(StringComparer.OrdinalIgnoreCase);
    private bool _failsafe;
    private bool _flagWritten;
    private string? _lastReason;
    private long _lastEvalMs = Environment.TickCount64;

    public FanSafety(FanController fans, bool elevated, string startupFlag, IFanFlagStore? store = null)
    {
        _fans = fans;
        _elevated = elevated;
        _store = store ?? new FileFanFlagStore();
        StartupFlag = startupFlag;
    }

    /// <summary>Result of the write-ahead flag check at start (hello.fanFlag).</summary>
    public string StartupFlag { get; }

    public FanController Fans => _fans;

    public bool Failsafe => _failsafe;

    public bool ManualActive => _elevated && (_failsafe || _fans.HasTouched);

    public bool OverrideActive => _failsafe || _cpu.Active || _gpus.Values.Any(g => g.Active);

    /// <summary>Precedence failsafe &gt; sensorMissing &gt; cpuTemp &gt; gpuTemp; null when no override.</summary>
    public string? Reason
    {
        get
        {
            if (_failsafe) return ReasonFailsafe;
            if (_cpu.Missing || _gpus.Values.Any(g => g.Missing)) return ReasonSensorMissing;
            if (_cpu.Hot) return ReasonCpuTemp;
            if (_gpus.Values.Any(g => g.Hot)) return ReasonGpuTemp;
            return null;
        }
    }

    public FanSafetyTelemetry Snapshot()
    {
        if (!_elevated) return new FanSafetyTelemetry();
        return new FanSafetyTelemetry
        {
            ManualActive = ManualActive,
            OverrideActive = OverrideActive,
            Reason = Reason,
            Failsafe = _failsafe,
        };
    }

    /// <summary>GPU hardware ids whose fans are under manual control (their temperatures feed the override).</summary>
    public IReadOnlyCollection<string> ManualGpuIds => _fans.TouchedGpuHwIds;

    /// <summary>True when an extra CPU/GPU-only evaluation is due (poll interval longer than 1 s).</summary>
    public bool ExtraEvaluationDue => ManualActive && !_failsafe && Environment.TickCount64 - _lastEvalMs >= MaxEvalGapMs;

    // ---------------------------------------------------------------------------------------------
    // Failsafe (CONTRACT §1.5.4)

    /// <summary>Called once after the hardware is open and fans are enumerated.</summary>
    public void EnterFailsafeIfNeeded()
    {
        if (StartupFlag != FanFlag.FlagInterrupted || !_elevated) return;

        _failsafe = true;
        var (count, errors) = _fans.ForceAll(100f);
        if (!_store.Write(FanFlag.ModeFailsafe, out var err))
        {
            Program.Log($"Failsafe: could not rewrite the fan flag ({err})");
        }
        _flagWritten = true;
        Program.Log($"FAILSAFE: fan control was interrupted in this boot. {count} fan(s) set to 100% and latched until restart" +
                    (errors.Count > 0 ? $" ({errors.Count} failed: {string.Join("; ", errors)})" : ""));
    }

    // ---------------------------------------------------------------------------------------------
    // Commands

    public (bool Ok, string Message) HandlePreset(string? preset)
    {
        if (!_elevated) return (false, MsgNeedsAdmin);
        if (_failsafe) return (false, MsgLocked);

        var p = (preset ?? "").Trim().ToLowerInvariant();
        if (p == FanController.PresetAuto)
        {
            // BIOS control is always safe: applies immediately, ends manual mode and the override.
            var (restored, allOk) = _fans.ReleaseAll(includeAllEligible: true);
            _fans.ClearIntent();
            ResetOverride("auto preset");
            if (allOk)
            {
                _store.Delete();
                _flagWritten = false;
            }
            else
            {
                Program.Log("Some fans could not be returned to BIOS control; keeping the fan flag");
            }
            return (allOk, allOk
                ? restored == 0
                    ? "Fan control released to BIOS (no software-controlled fans)"
                    : $"Released {restored} fan{(restored == 1 ? "" : "s")} to BIOS control"
                : "Some fans could not be returned to BIOS control");
        }

        var before = _fans.SaveIntent();
        var (ok, msg, label) = _fans.SetPresetIntent(p);
        if (!ok) return (false, msg);

        if (!EnsureFlag(FanFlag.ModePreset, out var refusal))
        {
            _fans.RestoreIntent(before);
            return (false, refusal);
        }

        if (OverrideActive) return (true, SavedMessage());

        var (applied, errors) = _fans.ApplyIntent();
        if (applied == 0)
        {
            _fans.RestoreIntent(before);
            AfterFailedWrite();
            return (false, $"Failed to apply {label}: {string.Join("; ", errors.Distinct())}");
        }
        var result = $"Applied {label} to {applied} fan{(applied == 1 ? "" : "s")}";
        if (errors.Count > 0) result += $" ({errors.Count} failed)";
        return (true, result);
    }

    public (bool Ok, string Message) HandleFanSet(string? id, double pct)
    {
        if (!_elevated) return (false, MsgNeedsAdmin);
        if (_failsafe) return (false, MsgLocked);

        var before = _fans.SaveIntent();
        var (ok, msg) = _fans.SetFanIntent(id, pct);
        if (!ok) return (false, msg);

        if (!EnsureFlag(FanFlag.ModeFanSet, out var refusal))
        {
            _fans.RestoreIntent(before);
            return (false, refusal);
        }

        if (OverrideActive) return (true, SavedMessage());

        var (applied, errors) = _fans.ApplyIntent();
        if (applied == 0 || errors.Count > 0)
        {
            // The requested fan itself may have failed; report the first error.
            if (applied == 0)
            {
                _fans.RestoreIntent(before);
                AfterFailedWrite();
                return (false, errors.FirstOrDefault() ?? "Fan control failed");
            }
            Program.Log($"fanSet: {errors.Count} control(s) failed: {string.Join("; ", errors)}");
        }
        return (true, msg);
    }

    private string SavedMessage() => Reason switch
    {
        ReasonSensorMissing => MsgSavedSensor,
        ReasonGpuTemp => MsgSavedGpu,
        _ => MsgSavedCpu,
    };

    /// <summary>Write-ahead: the flag exists (and the folder is safe) before any manual write.</summary>
    private bool EnsureFlag(string mode, out string refusal)
    {
        refusal = "";
        if (!_store.EnsureSecureFolder(out var folderErr))
        {
            Program.Log($"Refusing manual fan control: {folderErr}");
            refusal = MsgUnsafeFolder;
            return false;
        }
        if (!_store.Write(mode, out var err))
        {
            Program.Log($"Refusing manual fan control: fan flag write failed ({err})");
            refusal = MsgFlagFailed;
            return false;
        }
        _flagWritten = true;
        return true;
    }

    /// <summary>
    /// A manual request wrote nothing (its intent was already rolled back): bring the hardware back in
    /// line with the previous intent, and drop the flag if no control is in software mode any more.
    /// </summary>
    private void AfterFailedWrite()
    {
        if (_fans.HasTouched)
        {
            var (_, errors) = _fans.ApplyIntent();
            if (errors.Count > 0) Program.Log($"Re-applying the previous fan target: {string.Join("; ", errors)}");
        }
        if (!_fans.HasTouched && !_failsafe)
        {
            _store.Delete();
            _flagWritten = false;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Thermal override (CONTRACT §1.5.2)

    /// <summary>
    /// One override evaluation. <paramref name="cpuTemp"/> is the value published as cpu.packageTempC;
    /// <paramref name="gpuTemps"/> maps GPU hardware id → (hot spot, edge).
    /// </summary>
    public void Evaluate(double? cpuTemp, IReadOnlyDictionary<string, (double? Hotspot, double? Edge)> gpuTemps)
    {
        _lastEvalMs = Environment.TickCount64;
        if (!_elevated) return;
        if (_failsafe)
        {
            // Keep the latch true: re-assert 100% on any control that reads back lower (a write LHM
            // dropped, or another tool rewrote the register).
            var (_, errors) = _fans.ForceAll(100f, onlyIfBelow: true);
            if (errors.Count > 0) Program.LogThrottled("failsafe-reassert", $"Failsafe: {errors.Count} fan(s) could not be set to 100%: {string.Join("; ", errors)}");
            return;
        }
        if (!_fans.HasTouched)
        {
            if (OverrideActive) ResetOverride("no manual fans");
            return;
        }

        bool before = OverrideActive;

        Step(_cpu, Finite(cpuTemp), CpuTriggerC, CpuReleaseC);

        var manualGpus = ManualGpuIds;
        foreach (var gone in _gpus.Keys.Where(k => !manualGpus.Contains(k, StringComparer.OrdinalIgnoreCase)).ToList())
        {
            _gpus.Remove(gone);
        }
        foreach (var gid in manualGpus)
        {
            if (!_gpus.TryGetValue(gid, out var st)) _gpus[gid] = st = new TempState();
            gpuTemps.TryGetValue(gid, out var t);
            double? hot = Finite(t.Hotspot), edge = Finite(t.Edge);
            double? value = hot ?? edge;
            double trigger = hot.HasValue ? GpuHotspotTriggerC : GpuEdgeTriggerC;
            Step(st, value, trigger, trigger - HysteresisC);
        }

        bool after = OverrideActive;
        var reason = Reason;
        if (after && !before)
        {
            var (count, errors) = _fans.ForceAll(100f);
            if (!_store.Write(FanFlag.ModeOverride, out var err)) Program.Log($"Override: fan flag rewrite failed ({err})");
            Program.Log($"FAN OVERRIDE ON ({reason}; CPU {Fmt(cpuTemp)}): {count} fan(s) at 100%" +
                        (errors.Count > 0 ? $"; {errors.Count} failed: {string.Join("; ", errors)}" : ""));
        }
        else if (after)
        {
            if (reason != _lastReason) Program.Log($"Fan override reason changed: {_lastReason} -> {reason} (CPU {Fmt(cpuTemp)})");
            _fans.ForceAll(100f, onlyIfBelow: true); // retry anything that did not take
        }
        else if (before)
        {
            var (applied, errors) = _fans.ApplyIntent();
            var mode = _fans.CurrentPreset == FanController.PresetCustom ? FanFlag.ModeFanSet : FanFlag.ModePreset;
            if (_fans.HasTouched && !_store.Write(mode, out var err)) Program.Log($"Override release: fan flag rewrite failed ({err})");
            Program.Log($"FAN OVERRIDE OFF (CPU {Fmt(cpuTemp)}): restored target '{_fans.CurrentPreset}' on {applied} fan(s)" +
                        (errors.Count > 0 ? $"; {errors.Count} failed: {string.Join("; ", errors)}" : ""));
        }
        _lastReason = reason;
    }

    /// <summary>Hysteresis step for one temperature source.</summary>
    internal static void Step(TempState s, double? t, double trigger, double release)
    {
        if (!t.HasValue)
        {
            s.MissingStreak++;
            s.ReleaseStreak = 0;
            if (s.MissingStreak >= Consecutive) s.Missing = true;
            return;
        }

        s.MissingStreak = 0;
        if (t.Value >= trigger)
        {
            s.Hot = true;
            s.ReleaseStreak = 0;
        }
        else if (t.Value <= release)
        {
            s.ReleaseStreak++;
            if (s.ReleaseStreak >= Consecutive)
            {
                s.Hot = false;
                s.Missing = false;
            }
        }
        else
        {
            s.ReleaseStreak = 0;
        }
    }


    private void ResetOverride(string why)
    {
        if (OverrideActive && !_failsafe) Program.Log($"Fan override cleared ({why})");
        _cpu.Hot = _cpu.Missing = false;
        _cpu.MissingStreak = _cpu.ReleaseStreak = 0;
        _gpus.Clear();
        _lastReason = null;
    }

    private static string Fmt(double? t) => t.HasValue ? $"{t.Value:0.0} C" : "n/a";

    // ---------------------------------------------------------------------------------------------
    // Shutdown

    /// <summary>
    /// Graceful exit: return touched controls to BIOS and delete the flag once every one succeeded.
    /// In failsafe mode nothing is restored (SetDefault would restore this process's stale "defaults")
    /// and the flag stays.
    /// </summary>
    public void OnShutdown()
    {
        if (_failsafe)
        {
            Program.Log("Failsafe mode: leaving fans at 100% and the fan flag in place");
            return;
        }
        if (!_elevated) return;

        var (restored, allOk) = _fans.ReleaseAll(includeAllEligible: false);
        Program.Log($"Restored default fan control on {restored} control(s)");
        if (allOk && _flagWritten)
        {
            _store.Delete();
            _flagWritten = false;
        }
        else if (!allOk)
        {
            Program.Log("Some fans could not be returned to BIOS control; the fan flag stays");
        }
    }
}
