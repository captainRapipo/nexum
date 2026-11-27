using LibreHardwareMonitor.Hardware;

namespace NexumAgent;

/// <summary>
/// `nexum-agent --selftest`: pure-logic checks (no hardware access, no fan writes, no files) for the
/// drive classifier, the override hysteresis, the sensor unit table and other helpers. Exit code 0 = pass.
/// Kept inside the agent because the project takes no third-party test dependencies this round.
/// </summary>
internal static class SelfTest
{
    private static int _failures;
    private static int _checks;

    /// <param name="presentMonPath">From <c>--presentmon</c>: when given, the full trust check must pass on that file.</param>
    public static int Run(string? presentMonPath = null)
    {
        _failures = 0;
        _checks = 0;

        DriveClassifier();
        OverrideHysteresis();
        SensorUnits();
        SensorDriverStatusRules();
        Helpers();
        SelfTestFans.Run((name, ok, detail) => Check(name, ok, detail));
        Frames.FrameSelfTest.Run((name, ok, detail) => Check(name, ok, detail), presentMonPath);
        Spec.SpecSelfTest.Run((name, ok, detail) => Check(name, ok, detail));
        NativeGuardSelfTest.Run((name, ok, detail) => Check(name, ok, detail));

        Program.Log($"selftest: {_checks - _failures}/{_checks} checks passed");
        return _failures == 0 ? 0 : 1;
    }

    private static void Check(string name, bool ok, string detail = "")
    {
        _checks++;
        if (ok) return;
        _failures++;
        Program.Log($"FAIL {name} {detail}");
    }

    private static void Eq<T>(string name, T actual, T expected) =>
        Check(name, EqualityComparer<T>.Default.Equals(actual, expected), $"expected <{expected}> got <{actual}>");

    private static void DriveClassifier()
    {
        // The reference worn NVMe drive (ROADMAP MF-1).
        var worn = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = true, Source = "nvme", Life = 44, PercentageUsed = 56, PowerOnHours = 20188,
            CriticalWarning = 0, AvailableSparePct = 100, AvailableSpareThresholdPct = 10,
        });
        Eq("worn.state", worn.State, "attention");
        Eq("worn.label", worn.Label, "Worn");
        Eq("worn.reason", worn.Reason, "44% life left · 56% of rated endurance used · 20,188 power-on hours");

        var good = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = true, Source = "nvme", Life = 99, PercentageUsed = 1, PowerOnHours = 2210, CriticalWarning = 0,
        });
        Eq("good.state", good.State, "good");
        Eq("good.reason", good.Reason, "99% life left · 1% of rated endurance used · 2,210 power-on hours");

        var replace = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "nvme", Life = 8, PercentageUsed = 92 });
        Eq("replace.state", replace.State, "replace");
        Eq("replace.label", replace.Label, "Replace soon");

        var failing = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = true, Source = "nvme", Life = 90, CriticalWarning = 0x05, AvailableSparePct = 5, AvailableSpareThresholdPct = 10,
        });
        Eq("failing.state", failing.State, "failing");
        Eq("failing.label", failing.Label, "Failing");
        Eq("failing.reason", failing.Reason,
            "NVMe critical warning: available spare below threshold · NVMe critical warning: reliability degraded · available spare 5% is below the 10% threshold");

        var winUnhealthy = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "smart", WindowsHealth = 2 });
        Eq("winUnhealthy.state", winUnhealthy.State, "failing");

        var sectors = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = true, Source = "smart", ReallocatedSectors = 8, PendingSectors = 0, UncorrectableSectors = 1,
        });
        Eq("sectors.label", sectors.Label, "Check sectors");
        Eq("sectors.reason", sectors.Reason, "8 reallocated / 0 pending / 1 uncorrectable sectors");

        var hot = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "nvme", Life = 80, CriticalWarning = 0x02 });
        Eq("hot.label", hot.Label, "Overheating");

        var winWarn = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "nvme", Life = 80, WindowsHealth = 1 });
        Eq("winWarn.label", winWarn.Label, "Windows warning");

        var hddGood = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = true, Source = "smart", ReallocatedSectors = 0, PendingSectors = 0, UncorrectableSectors = 0, PowerOnHours = 1000,
        });
        Eq("hddGood.state", hddGood.State, "good");

        var noAdmin = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = false, Source = "none" });
        Eq("noAdmin.label", noAdmin.Label, "Health unknown — run as administrator");
        var noSmart = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "none" });
        Eq("noSmart.label", noSmart.Label, "Health unknown — no S.M.A.R.T. data");
        var noWear = DriveHealth.Classify(new DriveHealth.Input { IsAdmin = true, Source = "smart", ReallocatedSectors = 0 });
        Eq("noWear.label", noWear.Label, "Health unknown — no wear data");
        Check("unknown.neverGreen", noWear.State == "unknown");

        Eq("normSerial", DriveHealth.NormSerial(" s6z2_nf0w-12.34 "), "S6Z2NF0W1234");
        Eq("normSerial.empty", DriveHealth.NormSerial(" -_. "), null);
    }

    private static void OverrideHysteresis()
    {
        var s = new FanSafety.TempState();
        FanSafety.Step(s, 84.9, 85, 75);
        Check("cpu.below", !s.Active);
        FanSafety.Step(s, 85.0, 85, 75);
        Check("cpu.trigger", s.Hot);
        FanSafety.Step(s, 74, 85, 75);
        FanSafety.Step(s, 74, 85, 75);
        Check("cpu.holds2", s.Hot);
        FanSafety.Step(s, 76, 85, 75); // breaks the streak
        FanSafety.Step(s, 74, 85, 75);
        FanSafety.Step(s, 74, 85, 75);
        Check("cpu.streakReset", s.Hot);
        FanSafety.Step(s, 75, 85, 75);
        Check("cpu.release", !s.Active);

        var m = new FanSafety.TempState();
        FanSafety.Step(m, null, 85, 75);
        FanSafety.Step(m, null, 85, 75);
        Check("missing.2", !m.Missing);
        FanSafety.Step(m, null, 85, 75);
        Check("missing.3", m.Missing);
        FanSafety.Step(m, 80, 85, 75);
        Check("missing.backButWarm", m.Missing);
        FanSafety.Step(m, 70, 85, 75);
        FanSafety.Step(m, 70, 85, 75);
        FanSafety.Step(m, 70, 85, 75);
        Check("missing.release", !m.Active);
    }

    private static void SensorUnits()
    {
        var thr = SensorTree.Describe(SensorType.Throughput, "Read Rate")!.Value;
        Eq("throughput.unit", thr.Unit, "MB/s");
        Check("throughput.scale", Math.Abs(thr.Scale * 1048576 - 1) < 1e-12);
        Eq("data.count", SensorTree.Describe(SensorType.Data, "Power On Count")!.Value.Unit, "");
        Eq("data.gb", SensorTree.Describe(SensorType.Data, "Data Written")!.Value.Unit, "GB");
        Eq("timespan.hours", SensorTree.Describe(SensorType.TimeSpan, "Power On Hours")!.Value.Unit, "h");
        Check("static.total", SensorTree.Describe(SensorType.Data, "Total Space")!.Value.Static);
        Check("static.warning", SensorTree.Describe(SensorType.Temperature, "Warning Temperature")!.Value.Static);
        Check("static.timing", SensorTree.Describe(SensorType.Timing, "tCL")!.Value.Static);
        Check("notStatic.temp", !SensorTree.Describe(SensorType.Temperature, "VRM MOS")!.Value.Static);
        Eq("kind.superio", SensorTree.HardwareKind(HardwareType.SuperIO), "superio");
        Eq("kind.gpuAmd", SensorTree.HardwareKind(HardwareType.GpuAmd), "gpuAmd");
    }

    private static void SensorDriverStatusRules()
    {
        var missing = Program.BuildSensorDriver(admin: true, installed: false, version: null);
        Eq("driver.missing", missing.Reason, "missing");
        Check("driver.missing.notOk", !missing.Ok);
        Eq("driver.missing.kind", missing.Kind, "none");

        var outdated = Program.BuildSensorDriver(admin: false, installed: true, version: new Version(2, 0, 4));
        Eq("driver.outdated", outdated.Reason, "outdated");

        var notElevated = Program.BuildSensorDriver(admin: false, installed: true, version: new Version(2, 2, 0));
        Eq("driver.notElevated", notElevated.Reason, "notElevated");

        var ok = Program.BuildSensorDriver(admin: true, installed: true, version: new Version(2, 1, 0));
        Check("driver.ok", ok.Ok && ok.Reason is null && ok.Version == "2.1.0" && ok.Kind == "pawnio");

        var unknownVersion = Program.BuildSensorDriver(admin: true, installed: true, version: null);
        Check("driver.unknownVersion", !unknownVersion.Ok && unknownVersion.Reason is null);
    }

    private static void Helpers()
    {
        Check("boot.sameById", FanFlag.IsSameBoot(7, 0, 7, 999_999_999));
        Check("boot.otherById", !FanFlag.IsSameBoot(7, 1000, 8, 1000));
        Check("boot.sameByTs", FanFlag.IsSameBoot(null, 1_000_000, 5, 1_100_000));
        Check("boot.otherByTs", !FanFlag.IsSameBoot(null, 1_000_000, null, 1_200_001));
        Check("boot.corrupt", FanFlag.IsSameBoot(null, null, null, 5));

        Eq("channel.bank", SystemSpec.ParseChannel("P0 CHANNEL A", "DIMM 1"), 'A');
        Eq("channel.locator", SystemSpec.ParseChannel("BANK 0", "DIMM_B2"), 'B');
        Eq("channel.none", SystemSpec.ParseChannel("BANK 0", "DIMM 1"), null);
        Eq("cimDate", SystemSpec.CimDate("20240115000000.000000+000"), "2024-01-15");
        Eq("cimDate.bad", SystemSpec.CimDate("garbage"), null);
        Eq("codename.vermeer", SystemSpec.Codename("AMD", 0x19, 0x21), "Vermeer");
        Eq("codename.unknown", SystemSpec.Codename("Intel", 6, 0x01), null);
        Eq("num", DriveHealth.Num(20188), "20,188");
    }
}
