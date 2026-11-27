using LibreHardwareMonitor.Hardware;

namespace NexumAgent;

/// <summary>
/// Fan-policy scenarios for `--selftest`, run against in-memory fake hardware and an in-memory flag
/// store. Nothing here touches real fans, LHM drivers or the file system.
/// </summary>
internal static class SelfTestFans
{
    private sealed class MemoryFlagStore : IFanFlagStore
    {
        public bool Exists;
        public string? Mode;
        public bool FailWrite;
        public bool UnsafeFolder;

        public bool EnsureSecureFolder(out string error)
        {
            error = UnsafeFolder ? "test: unsafe" : "";
            return !UnsafeFolder;
        }

        public bool Write(string mode, out string error)
        {
            error = FailWrite ? "test: write failed" : "";
            if (FailWrite) return false;
            Exists = true;
            Mode = mode;
            return true;
        }

        public void Delete()
        {
            Exists = false;
            Mode = null;
        }
    }

    private sealed class FakeControl : IControl
    {
        public FakeControl(ISensor sensor) { Sensor = sensor; Identifier = sensor.Identifier; }
        public ControlMode ControlMode { get; private set; } = ControlMode.Undefined;
        public Identifier Identifier { get; }
        public float MaxSoftwareValue => 100;
        public float MinSoftwareValue => 0;
        public ISensor Sensor { get; }
        public float SoftwareValue { get; private set; }
        public int Writes { get; private set; }

        public void SetDefault()
        {
            ControlMode = ControlMode.Default;
            ((FakeSensor)Sensor).Value = null;
        }

        public void SetSoftware(float value)
        {
            ControlMode = ControlMode.Software;
            SoftwareValue = value;
            Writes++;
            ((FakeSensor)Sensor).Value = value;
        }
    }

    private sealed class FakeSensor : ISensor
    {
        public FakeSensor(IHardware hw, SensorType type, int index, string name)
        {
            Hardware = hw;
            SensorType = type;
            Index = index;
            Name = name;
            Identifier = new Identifier(hw.Identifier, type.ToString().ToLowerInvariant(), index.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        public IControl? Control { get; set; }
        public IHardware Hardware { get; }
        public Identifier Identifier { get; }
        public int Index { get; }
        public bool IsDefaultHidden => false;
        public float? Max { get; set; }
        public float? Min { get; set; }
        public string Name { get; set; }
        public IReadOnlyList<IParameter> Parameters => Array.Empty<IParameter>();
        public SensorType SensorType { get; }
        public float? Value { get; set; }
        public IEnumerable<SensorValue> Values => Array.Empty<SensorValue>();
        public TimeSpan ValuesTimeWindow { get; set; }
        public void ResetMin() => Min = null;
        public void ResetMax() => Max = null;
        public void ClearValues() { }
        public void Accept(IVisitor visitor) { }
        public void Traverse(IVisitor visitor) { }
    }

    private sealed class FakeHardware : IHardware
    {
        public FakeHardware(HardwareType type, string name, params string[] id)
        {
            HardwareType = type;
            Name = name;
            Identifier = new Identifier(id);
        }

        public List<ISensor> SensorList { get; } = new();
        public HardwareType HardwareType { get; }
        public Identifier Identifier { get; }
        public string Name { get; set; }
        public IHardware? Parent => null;
        public ISensor[] Sensors => SensorList.ToArray();
        public IHardware[] SubHardware => Array.Empty<IHardware>();
        public IDictionary<string, string> Properties { get; } = new Dictionary<string, string>();
#pragma warning disable CS0067 // events required by the interface, never raised by the fake
        public event SensorEventHandler? SensorAdded;
        public event SensorEventHandler? SensorRemoved;
#pragma warning restore CS0067
        public string GetReport() => "";
        public void Update() { }
        public void Accept(IVisitor visitor) { }
        public void Traverse(IVisitor visitor) { }

        public (FakeSensor Fan, FakeControl Control) AddFan(int index, string name)
        {
            var fan = new FakeSensor(this, SensorType.Fan, index, name) { Value = 900 };
            var ctl = new FakeSensor(this, SensorType.Control, index, name);
            var control = new FakeControl(ctl);
            ctl.Control = control;
            SensorList.Add(fan);
            SensorList.Add(ctl);
            return (fan, control);
        }
    }

    public static void Run(Action<string, bool, string> check)
    {
        void Check(string name, bool ok, string detail = "") => check(name, ok, detail);

        var board = new FakeHardware(HardwareType.SuperIO, "ITE IT8688E", "lpc", "it8688e", "0");
        var (cpuFan, cpuCtl) = board.AddFan(0, "CPU Fan");
        var (_, sysCtl) = board.AddFan(1, "System Fan #1");
        var gpu = new FakeHardware(HardwareType.GpuAmd, "Test GPU", "gpu-amd", "0");
        var (gpuFan, gpuCtl) = gpu.AddFan(0, "GPU Fan");
        var all = new List<IHardware> { board, gpu };

        // ── Normal session ──
        var store = new MemoryFlagStore();
        var fans = new FanController();
        var safety = new FanSafety(fans, elevated: true, FanFlag.FlagNone, store);
        fans.Refresh(all);

        var telemetry = fans.BuildTelemetry();
        Check("fans.listsGpu", telemetry.Any(f => f.HwId == "/gpu-amd/0" && !f.Controllable));
        Check("fans.boardControllable", telemetry.Count(f => f.HwId == "/lpc/it8688e/0" && f.Controllable) == 2);

        var r = safety.HandlePreset("silent");
        Check("silent.ok", r.Ok, r.Message);
        Check("silent.flagFirst", store.Exists && store.Mode == FanFlag.ModePreset);
        Check("silent.duty", cpuCtl.SoftwareValue == 30 && sysCtl.SoftwareValue == 30);
        Check("silent.manual", safety.ManualActive && !safety.OverrideActive);

        var gpuSet = safety.HandleFanSet(gpuFan.Identifier.ToString(), 40);
        Check("gpu.refused", !gpuSet.Ok, gpuSet.Message);
        Check("gpu.untouched", gpuCtl.ControlMode == ControlMode.Undefined && gpuCtl.Writes == 0);

        var none = new Dictionary<string, (double?, double?)>();
        safety.Evaluate(60, none);
        Check("eval.cool", !safety.OverrideActive);
        safety.Evaluate(85.0, none);
        Check("override.on", safety.OverrideActive && safety.Reason == FanSafety.ReasonCpuTemp);
        Check("override.100", cpuCtl.SoftwareValue == 100 && sysCtl.SoftwareValue == 100);
        Check("override.flagMode", store.Mode == FanFlag.ModeOverride);

        var saved = safety.HandlePreset("balanced");
        Check("override.saved", saved.Ok && saved.Message == FanSafety.MsgSavedCpu, saved.Message);
        Check("override.stillAt100", cpuCtl.SoftwareValue == 100);
        Check("override.presetRecorded", fans.CurrentPreset == FanController.PresetBalanced);
        var snap = safety.Snapshot();
        Check("snapshot.override", snap.ManualActive && snap.OverrideActive && snap.Reason == "cpuTemp" && !snap.Failsafe && snap.TriggerC == 85 && snap.ReleaseC == 75);

        safety.Evaluate(74, none);
        safety.Evaluate(74, none);
        Check("override.holds", safety.OverrideActive);
        safety.Evaluate(74, none);
        Check("override.released", !safety.OverrideActive);
        Check("release.appliesTarget", cpuCtl.SoftwareValue == 50 && sysCtl.SoftwareValue == 50);

        // Sensor missing for 3 evaluations.
        safety.Evaluate(null, none);
        safety.Evaluate(null, none);
        Check("missing.notYet", !safety.OverrideActive);
        safety.Evaluate(null, none);
        Check("missing.on", safety.OverrideActive && safety.Reason == FanSafety.ReasonSensorMissing && cpuCtl.SoftwareValue == 100);
        var savedSensor = safety.HandleFanSet(cpuFan.Identifier.ToString(), 35);
        Check("missing.savedMessage", savedSensor.Ok && savedSensor.Message == FanSafety.MsgSavedSensor, savedSensor.Message);
        safety.Evaluate(70, none);
        safety.Evaluate(70, none);
        safety.Evaluate(70, none);
        Check("missing.released", !safety.OverrideActive);
        Check("custom.applied", cpuCtl.SoftwareValue == 35 && sysCtl.SoftwareValue == 50, $"{cpuCtl.SoftwareValue}/{sysCtl.SoftwareValue}");
        Check("custom.preset", fans.CurrentPreset == FanController.PresetCustom);

        var minClamp = safety.HandleFanSet(cpuFan.Identifier.ToString(), 5);
        Check("fanSet.minSafe", minClamp.Ok && cpuCtl.SoftwareValue == FanController.MinSafeDutyPct, minClamp.Message);

        // Auto always applies, even during an override.
        safety.Evaluate(90, none);
        Check("auto.preOverride", safety.OverrideActive);
        var auto = safety.HandlePreset("auto");
        Check("auto.ok", auto.Ok, auto.Message);
        Check("auto.default", cpuCtl.ControlMode == ControlMode.Default && sysCtl.ControlMode == ControlMode.Default);
        Check("auto.flagDeleted", !store.Exists);
        Check("auto.endsManual", !safety.ManualActive && !safety.OverrideActive && fans.CurrentPreset == FanController.PresetAuto);

        // Graceful shutdown after manual control restores and deletes the flag.
        safety.HandlePreset("turbo");
        Check("turbo.flag", store.Exists && cpuCtl.SoftwareValue == 100);
        safety.OnShutdown();
        Check("shutdown.restored", cpuCtl.ControlMode == ControlMode.Default && !store.Exists);

        // ── Refusals ──
        var flagFail = new MemoryFlagStore { FailWrite = true };
        var fans2 = new FanController();
        var s2 = new FanSafety(fans2, elevated: true, FanFlag.FlagNone, flagFail);
        var board2 = new FakeHardware(HardwareType.SuperIO, "chip", "lpc", "x", "0");
        var (_, ctl2) = board2.AddFan(0, "CPU Fan");
        fans2.Refresh(new[] { board2 });
        var refused = s2.HandlePreset("silent");
        Check("flagFail.refused", !refused.Ok && refused.Message == FanSafety.MsgFlagFailed, refused.Message);
        Check("flagFail.noWrite", ctl2.Writes == 0);

        var unsafeStore = new MemoryFlagStore { UnsafeFolder = true };
        var s3 = new FanSafety(fans2, elevated: true, FanFlag.FlagNone, unsafeStore);
        var unsafeR = s3.HandleFanSet(ctl2.Sensor.Identifier.ToString(), 50);
        Check("unsafeFolder.refused", !unsafeR.Ok && unsafeR.Message == FanSafety.MsgUnsafeFolder, unsafeR.Message);
        Check("unsafeFolder.noWrite", ctl2.Writes == 0);

        var s4 = new FanSafety(new FanController(), elevated: false, FanFlag.FlagNone, new MemoryFlagStore());
        var notAdmin = s4.HandlePreset("auto");
        Check("notAdmin.refused", !notAdmin.Ok && notAdmin.Message == FanSafety.MsgNeedsAdmin);
        var notAdminSnap = s4.Snapshot();
        Check("notAdmin.snapshot", !notAdminSnap.ManualActive && !notAdminSnap.OverrideActive && notAdminSnap.Reason is null && !notAdminSnap.Failsafe);

        // ── Failsafe latch ──
        var fsStore = new MemoryFlagStore { Exists = true, Mode = FanFlag.ModePreset };
        var fans5 = new FanController();
        var board5 = new FakeHardware(HardwareType.SuperIO, "chip", "lpc", "y", "0");
        var (_, ctl5) = board5.AddFan(0, "CPU Fan");
        var gpu5 = new FakeHardware(HardwareType.GpuNvidia, "gpu", "gpu-nvidia", "0");
        var (_, gctl5) = gpu5.AddFan(0, "GPU Fan");
        fans5.Refresh(new IHardware[] { board5, gpu5 });
        var s5 = new FanSafety(fans5, elevated: true, FanFlag.FlagInterrupted, fsStore);
        s5.EnterFailsafeIfNeeded();
        Check("failsafe.100", ctl5.SoftwareValue == 100 && fsStore.Mode == FanFlag.ModeFailsafe);
        Check("failsafe.gpuUntouched", gctl5.Writes == 0);
        var fsSnap = s5.Snapshot();
        Check("failsafe.snapshot", fsSnap.Failsafe && fsSnap.OverrideActive && fsSnap.ManualActive && fsSnap.Reason == "failsafe");
        var locked = s5.HandlePreset("auto");
        Check("failsafe.autoLocked", !locked.Ok && locked.Message == FanSafety.MsgLocked);
        var lockedSet = s5.HandleFanSet(ctl5.Sensor.Identifier.ToString(), 50);
        Check("failsafe.fanSetLocked", !lockedSet.Ok && lockedSet.Message == FanSafety.MsgLocked);
        s5.Evaluate(40, none);
        Check("failsafe.evalKeeps100", ctl5.SoftwareValue == 100);
        s5.OnShutdown();
        Check("failsafe.noRestore", ctl5.ControlMode == ControlMode.Software && fsStore.Exists);

        // Non-elevated agent with an interrupted flag: reports it, cannot force fans.
        var s6 = new FanSafety(new FanController(), elevated: false, FanFlag.FlagInterrupted, new MemoryFlagStore());
        s6.EnterFailsafeIfNeeded();
        Check("failsafe.notElevated", !s6.Failsafe);
    }
}
