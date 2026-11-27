using NexumAgent.Tuning;

namespace NexumAgent.Spec;

/// <summary>
/// A2's pure-function checks for <c>--selftest</c> (no hardware, no driver, no files): UMC timing decode from
/// captured register values, SPD ns→cycles, DIMM join, ADL report link parsing, PCIe codes, codenames and the
/// read-only OD8 state mapping. Wired from SelfTest.Run by A1:
/// <c>Spec.SpecSelfTest.Run((name, ok, detail) => Check(name, ok, detail));</c>
/// </summary>
internal static class SpecSelfTest
{
    public static void Run(Action<string, bool, string> check)
    {
        void Check(string name, bool ok, string detail = "") => check(name, ok, detail);
        void Eq<T>(string name, T actual, T expected) =>
            check(name, EqualityComparer<T>.Default.Equals(actual, expected), $"expected <{expected}> got <{actual}>");

        // ── UMC decode (ZenStates-Core bit fields). Register values for DDR4-3600 18-22-22-42 1T, GDM off. ──
        static uint F(uint v, int lo) => v << lo;
        var regs = new MemoryTimings.UmcRegisters(
            RefreshMode: 0,                                               // FGR 0 → normal 1x refresh
            Ratio: 54,                                                    // 54 / 3 × 100 = 1800 MHz, Cmd2T 0, GDM 0
            T1: F(18, 0) | F(42, 8) | F(22, 16) | F(22, 24),              // CL, RAS, RCDRD, RCDWR
            T2: F(64, 0) | F(22, 16),                                     // RC, RP
            T3: F(4, 0) | F(6, 8) | F(12, 24),                            // RRDS, RRDL, RTP
            T4: F(24, 0),                                                 // FAW
            T5: F(18, 0) | F(4, 8) | F(12, 16),                           // CWL, WTRS, WTRL
            T6: F(26, 0),                                                 // WR
            Rfc0: F(630, 0) | F(468, 11) | F(288, 22),                    // RFC, RFC2, RFC4
            Rfc1: F(630, 0) | F(468, 11) | F(288, 22));
        var (t, memclk) = MemoryTimings.Decode(regs);
        Eq("umc.cl", t.Cl, 18);
        Eq("umc.rcdRd", t.RcdRd, 22);
        Eq("umc.rcdWr", t.RcdWr, 22);
        Eq("umc.rp", t.Rp, 22);
        Eq("umc.ras", t.Ras, 42);
        Eq("umc.rc", t.Rc, 64);
        Eq("umc.rrds", t.Rrds, 4);
        Eq("umc.rrdl", t.Rrdl, 6);
        Eq("umc.rtp", t.Rtp, 12);
        Eq("umc.faw", t.Faw, 24);
        Eq("umc.cwl", t.Cwl, 18);
        Eq("umc.wtrs", t.Wtrs, 4);
        Eq("umc.wtrl", t.Wtrl, 12);
        Eq("umc.wr", t.Wr, 26);
        Eq("umc.rfc", t.Rfc, 630);
        Eq("umc.cmd", t.CommandRate, "1T");
        Eq("umc.gdm", t.GearDown, false);
        Eq("umc.memclk", memclk, 1800d);
        Check("umc.plausible", MemoryTimings.IsPlausible(t));

        var (t2, memclk2) = MemoryTimings.Decode(regs with { Ratio = 48u | (1u << 10) | (1u << 11), RefreshMode = 2u << 16 });
        Eq("umc.cmd2t", t2.CommandRate, "2T");
        Eq("umc.gdmOn", t2.GearDown, true);
        Eq("umc.rfc4x", t2.Rfc, 288);
        Eq("umc.memclk3200", memclk2, 1600d);
        var (t3, _) = MemoryTimings.Decode(regs with { Rfc0 = 0x21060138, Rfc1 = F(560, 0) });
        Eq("umc.rfcPair", t3.Rfc, 560);

        Check("umc.populated", MemoryTimings.IsPopulated(regs.T1));
        Check("umc.empty0", !MemoryTimings.IsPopulated(0));
        Check("umc.emptyFF", !MemoryTimings.IsPopulated(0xFFFFFFFF));
        Check("umc.implausibleCl", !MemoryTimings.IsPlausible(new MemoryTimingsDto { Cl = 63, Ras = 63 }));
        Check("umc.implausibleRas", !MemoryTimings.IsPlausible(new MemoryTimingsDto { Cl = 18, Ras = 10 }));
        Eq("umc.bits", MemoryTimings.Bits(0xF0, 7, 4), 0xFu);

        Eq("note.platform", MemoryTimings.Precondition("Intel", 6, "DDR4", true, true), MemoryTimings.NoteUnsupportedPlatform);
        Eq("note.ddr5", MemoryTimings.Precondition("AMD", 0x19, "DDR5", true, true), MemoryTimings.NoteUnsupportedPlatform);
        Eq("note.zen5", MemoryTimings.Precondition("AMD", 0x1A, "DDR4", true, true), MemoryTimings.NoteUnsupportedPlatform);
        Eq("note.admin", MemoryTimings.Precondition("AMD", 0x19, "DDR4", false, false), MemoryTimings.NoteNotElevated);
        Eq("note.pawnio", MemoryTimings.Precondition("AMD", 0x19, "DDR4", true, false), MemoryTimings.NoteNoPawnIo);
        Eq("note.go", MemoryTimings.Precondition("AMD", 0x17, "DDR4", true, true), null);
        Eq("note.admin.text", MemoryTimings.NoteNotElevated, "Live timings need administrator rights.");

        // ── SPD ns → cycles: ceil(ns / (2000 / MT/s) − 0.025) ──
        Eq("spd.cl3200", SpdReader.Cycles(13.75, 3200), 22);
        Eq("spd.cl2666", SpdReader.Cycles(13.75, 2666), 19);
        Eq("spd.ras3200", SpdReader.Cycles(32, 3200), 52);
        Eq("spd.rfc3200", SpdReader.Cycles(350, 3200), 560);
        Eq("spd.guardBand", SpdReader.Cycles(13.7625, 3200), 22); // 22.02 → 22 thanks to the 2.5% guard band
        Eq("spd.noSpeed", SpdReader.Cycles(13.75, null), null);
        Eq("spd.noNs", SpdReader.Cycles(null, 3200), null);
        Eq("spd.key", SpdReader.KeyOf("tRRD_S (Activate to Activate Delay Time)"), "tRRD_S");
        Eq("spd.key2", SpdReader.KeyOf("tAA (CAS Latency Time)"), "tAA");

        var facts = new SpdReader.DimmFacts { Name = "Corsair - CMK16GX4M1Z3600C18 (#0)" };
        foreach (var k in SpdReader.TimingKeys) facts.TimingsNs[k] = null;
        facts.TimingsNs["tAA"] = 13.75;
        facts.TimingsNs["tRFC1"] = 350;
        var spd = SpdReader.Build(facts, 3200, "partNumber");
        Eq("spd.build.cl", spd.Cycles.Cl, 22);
        Eq("spd.build.rfc", spd.Cycles.Rfc, 560);
        Eq("spd.build.rcdNull", spd.Cycles.Rcd, null);
        Eq("spd.build.keys", spd.TimingsNs.Count, 15);
        var fromSpd = MemoryTimings.FromSpd(spd.Cycles);
        Check("spd.fallback", fromSpd.Cl == 22 && fromSpd.CommandRate is null && fromSpd.GearDown is null && fromSpd.Rtp is null);
        var spdJson = Program.Serialize(spd);
        Check("spd.json", spdJson.Contains("\"tAA\":13.75") && spdJson.Contains("\"tRRD_S\":null") && spdJson.Contains("\"source\":\"jedec\""), spdJson);

        // ── DIMM join ──
        var j1 = SpdReader.Join(new[] { "Kingston - KF432C16BB/8 (#0)", "Corsair - CMK16GX4M1Z3600C18 (#1)" },
                                new[] { "CMK16GX4M1Z3600C18", "KF432C16BB/8" });
        Check("join.part", j1.Ok && j1.MatchedBy == "partNumber" && j1.NodeForRow[0] == 1 && j1.NodeForRow[1] == 0,
              $"{j1.MatchedBy} {string.Join(",", j1.NodeForRow)}");
        var j2 = SpdReader.Join(new[] { "G.Skill - F4-3600C16-16GVKC (#0)", "G.Skill - F4-3600C16-16GVKC (#2)" },
                                new[] { "F4-3600C16-16GVKC", "F4-3600C16-16GVKC" });
        Check("join.orderSameKit", j2.Ok && j2.MatchedBy == "order" && j2.NodeForRow[0] == 0 && j2.NodeForRow[1] == 1);
        var j3 = SpdReader.Join(new[] { "DIMM #0" }, new[] { "A", "B" });
        Check("join.mismatch", !j3.Ok);
        var j4 = SpdReader.Join(Array.Empty<string>(), new[] { "A" });
        Check("join.noNodes", j4.Ok && j4.NodeForRow[0] == -1);

        // ── PCIe ──
        const string report =
            "AMD GPU\r\n\r\nOverdrive5 CurrentActivity\r\n\r\n Status: ADL_OK\r\n EngineClock: 5\r\n CurrentBusSpeed: 0\r\n" +
            " CurrentBusLanes: 16\r\n MaximumBusLanes: 16\r\n\r\nOverdrive6 CurrentPower\r\n\r\n Power[0].Status: ADL_OK\r\n\r\n" +
            "OverdriveN Performance Status\r\n\r\n Status: ADL_OK\r\n CurrentBusSpeed: 16000\r\n CurrentBusLanes: 16\r\n" +
            " MaximumBusLanes: 16\r\n VDDC: 0\r\n\r\n";
        var link = PcieLinks.ParseAdlReport(report);
        Check("adl.link", link is { Gen: 4, Width: 16, MaxWidth: 16, MaxGen: null, Source: "adl" }, Program.Serialize(link ?? new PcieLinkDto()));
        var od5Only = PcieLinks.ParseAdlReport(report.Replace("OverdriveN Performance Status\r\n\r\n Status: ADL_OK", "OverdriveN Performance Status\r\n\r\n Status: ADL_ERR"));
        Check("adl.od5", od5Only is { Gen: null, Width: 16, Source: "adl" });
        Check("adl.none", PcieLinks.ParseAdlReport("AMD GPU\n\nOverdrive Caps\n\n Status: ADL_OK\n") is null);
        // Captured from LHM 0.9.6 on an RX 9070 XT (RDNA4) in a PCIe 4.0 x16 slot: Overdrive sections fail, PMLog answers.
        const string rdna4 =
            "AMD GPU\r\n\r\nOverdrive5 CurrentActivity\r\n\r\n Status: ADL_ERR\r\n CurrentBusSpeed: 0\r\n CurrentBusLanes: 0\r\n" +
            " MaximumBusLanes: 0\r\n\r\nOverdriveN Performance Status\r\n\r\n Status: ADL_ERR_NOT_SUPPORTED\r\n CurrentBusSpeed: 0\r\n" +
            " CurrentBusLanes: 0\r\n MaximumBusLanes: 0\r\n\r\nPerformance Metrics\r\n\r\n" +
            " Sensor[ADL_PMLOG_THROTTLER_STATUS].Supported: False\r\n Sensor[ADL_PMLOG_BUS_SPEED].Value: 3\r\n" +
            " Sensor[ADL_PMLOG_BUS_SPEED].Supported: True\r\n Sensor[ADL_PMLOG_BUS_LANES].Value: 16\r\n" +
            " Sensor[ADL_PMLOG_BUS_LANES].Supported: True\r\n\r\nD3D\r\n";
        var rdna4Link = PcieLinks.ParseAdlReport(rdna4);
        Check("adl.pmlog", rdna4Link is { Gen: 4, Width: 16, MaxGen: null, MaxWidth: null, Source: "adl", Note: null },
              Program.Serialize(rdna4Link ?? new PcieLinkDto()));
        Eq("adl.gen.code", PcieLinks.GenFromAdlSpeed(3), 3);
        Eq("adl.gen.mts", PcieLinks.GenFromAdlSpeed(8000), 3);
        Eq("adl.gen.bad", PcieLinks.GenFromAdlSpeed(1234), null);
        Eq("devpkey.gen", PcieLinks.GenFromCode(4u), 4);
        Eq("devpkey.bad", PcieLinks.GenFromCode(0u), null);
        Eq("bus.nvme", PcieLinks.BusFromMsft(17), "nvme");
        Eq("bus.sata", PcieLinks.BusFromMsft(11), "sata");
        Eq("bus.usb", PcieLinks.BusFromMsft(7), "usb");
        Eq("bus.win32.nvme", PcieLinks.BusFromWin32("SCSI", @"SCSI\DISK&VEN_NVME&PROD_X\1"), "nvme");

        // ── Codenames ──
        Eq("codename.phoenix75", SystemSpec.Codename("AMD", 0x19, 0x75), "Phoenix");
        Eq("codename.matisse", SystemSpec.Codename("AMD", 0x17, 0x71), "Matisse");
        Eq("codename.granite", SystemSpec.Codename("AMD", 0x1A, 0x44), "Granite Ridge");

        // ── OD8 read-only state mapping ──
        var init = new AdlNative.ADLOD8SingleInitSetting[AdlNative.OD8_COUNT];
        void Set(int i, int feature, int min, int max, int def) => init[i] = new AdlNative.ADLOD8SingleInitSetting
        {
            featureID = feature, minValue = min, maxValue = max, defaultValue = def,
        };
        Set(AdlNative.OD8_POWER_PERCENTAGE, AdlNative.ADL_OD8_POWER_LIMIT, -30, 10, 0);
        Set(AdlNative.OD8_FAN_ZERORPM_CONTROL, AdlNative.ADL_OD8_FAN_ZERO_RPM_CONTROL, 0, 1, 1);
        Set(AdlNative.OD8_AUTO_UV_ENGINE_CONTROL, AdlNative.ADL_OD8_AUTO_UV_ENGINE, 0, 1, 0);
        Set(AdlNative.OD8_GFXCLK_FMAX, AdlNative.ADL_OD8_GFXCLK_LIMITS, 500, 3500, 3100);
        for (int p = 0; p < 5; p++)
        {
            Set(AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p, AdlNative.ADL_OD8_FAN_CURVE, 25, 100, 40 + 10 * p);
            Set(AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p + 1, AdlNative.ADL_OD8_FAN_CURVE, 0, 100, 20 + 15 * p);
        }
        int capsBits = AdlNative.ADL_OD8_POWER_LIMIT | AdlNative.ADL_OD8_FAN_ZERO_RPM_CONTROL | AdlNative.ADL_OD8_AUTO_UV_ENGINE
                       | AdlNative.ADL_OD8_GFXCLK_LIMITS | AdlNative.ADL_OD8_FAN_CURVE;
        var current = new int[AdlNative.OD8_COUNT];
        current[AdlNative.OD8_POWER_PERCENTAGE] = 0;
        current[AdlNative.OD8_FAN_ZERORPM_CONTROL] = 1;
        current[AdlNative.OD8_AUTO_UV_ENGINE_CONTROL] = 0;
        current[AdlNative.OD8_GFXCLK_FMAX] = 3100;
        current[AdlNative.OD8_UCLK_FMAX] = 2518; // not capped → ignored
        for (int p = 0; p < 5; p++)
        {
            current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p] = 40 + 10 * p;
            current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p + 1] = 20 + 15 * p;
        }
        var st = TuningService.BuildState(capsBits, init, current);
        Check("od8.supported", st.Supported && st.Reason is null && st.Message == TuningStateMessage.MsgSupported);
        Check("od8.caps", st.Caps.PowerLimit && st.Caps.ZeroRpm && st.Caps.AutoUndervolt && st.Caps.FanCurve && st.Caps.GfxClockMax
                          && !st.Caps.MemClockMax && !st.Caps.VoltageOffset);
        Check("od8.power", st.Ranges.PowerPct is { Min: -30, Max: 10, Step: 1, Default: 0 } && st.Current.PowerPct == 0);
        Check("od8.uncappedNull", st.Ranges.MemClockMaxMhz is null && st.Current.MemClockMaxMhz is null && st.Current.VoltageOffsetMv is null);
        Check("od8.fanRange", st.Ranges.FanCurveTempC is { Min: 25, Max: 100, Default: null } && st.Ranges.FanCurvePct is { Min: 0, Max: 100 });
        Check("od8.fanCurve", st.Current.FanCurve is { Count: 5 } fc && fc[0].TempC == 40 && fc[4].Pct == 80);
        Check("od8.factory", st.IsFactory == true && st.Mode == "factory", $"{st.IsFactory} {st.Mode}");
        Eq("od8.powerModeUncapped", st.PowerMode, null);

        current[AdlNative.OD8_POWER_PERCENTAGE] = -10;
        var custom = TuningService.BuildState(capsBits, init, current);
        Check("od8.custom", custom.IsFactory == false && custom.Mode == "custom");
        current[AdlNative.OD8_POWER_PERCENTAGE] = 0;
        current[AdlNative.OD8_AUTO_UV_ENGINE_CONTROL] = 1;
        var uv = TuningService.BuildState(capsBits, init, current);
        Check("od8.autoUv", uv.Mode == "autoUndervolt" && uv.Current.AutoUndervolt == true);

        // Captured read-only from an RX 9070 XT (Navi 48, Adrenalin 32.0.32029, factory settings): caps 0x1C033F0D and
        // the non-zero Init (min, max, default) / Current entries. Every other index is zero in both tables.
        var navi48 = new AdlNative.ADLOD8SingleInitSetting[AdlNative.OD8_COUNT];
        var navi48Cur = new int[76];
        void Cap(int i, int min, int max, int def, int cur)
        {
            navi48[i] = new AdlNative.ADLOD8SingleInitSetting { featureID = 0, minValue = min, maxValue = max, defaultValue = def };
            navi48Cur[i] = cur;
        }
        Cap(0, -500, 1000, 0, 0); Cap(8, 2518, 3000, 2518, 2518); Cap(9, -30, 10, 0, 0); Cap(14, 0, 1, 0, 0);
        Cap(15, 0, 1, 1, 1); Cap(16, 0, 1, 0, 0); Cap(17, 0, 1, 0, 0); Cap(18, 0, 1, 0, 0);
        int[] fanT = { 30, 50, 56, 63, 70 }, fanS = { 20, 36, 52, 68, 100 };
        for (int p = 0; p < 5; p++)
        {
            Cap(19 + 2 * p, 25, 100, fanT[p], fanT[p]);
            Cap(20 + 2 * p, 20, 100, fanS[p], fanS[p]);
        }
        Cap(36, 0, 3, 3, 3); Cap(37, -200, 0, 0, 0); Cap(74, 1, 3, 1, 1); Cap(75, 0, 1, 0, 0);
        var n48 = TuningService.BuildState(0x1C033F0D, navi48, navi48Cur);
        Check("navi48.caps", n48.Caps is { PowerLimit: true, AutoUndervolt: true, FanCurve: true, ZeroRpm: true, VoltageOffset: true, GfxClockMax: true, MemClockMax: true });
        Check("navi48.power", n48.Ranges.PowerPct is { Min: -30, Max: 10, Default: 0 } && n48.Current.PowerPct == 0);
        Check("navi48.voltage", n48.Ranges.VoltageOffsetMv is { Min: -200, Max: 0 } && n48.Current.VoltageOffsetMv == 0);
        Check("navi48.mem", n48.Ranges.MemClockMaxMhz is { Min: 2518, Max: 3000, Default: 2518 } && n48.Current.MemClockMaxMhz == 2518);
        Check("navi48.fan", n48.Ranges.FanCurvePct is { Min: 20, Max: 100 } && n48.Current.FanCurve is { Count: 5 } nf && nf[4].TempC == 70 && nf[4].Pct == 100);
        Check("navi48.factory", n48.IsFactory == true && n48.Mode == "factory" && n48.Current.ZeroRpm == true && n48.Current.AutoUndervolt == false);
        Eq("navi48.powerMode", n48.PowerMode, "3");
        Check("navi48.gfxOffsetCheck", TuningService.Checks(0x1C033F0D, navi48, navi48Cur).Any(c => c.StartsWith("OD8_GFXCLK_FMAX has a negative minimum")));

        var none = TuningStateMessage.Unsupported("noAmdGpu", TuningStateMessage.MsgNoAmdGpu);
        var noneJson = Program.Serialize(none);
        Check("od8.unsupportedJson",
              noneJson.Contains("\"type\":\"tuningState\"") && noneJson.Contains("\"supported\":false")
              && noneJson.Contains("\"powerPct\":null") && noneJson.Contains("\"isFactory\":null")
              && noneJson.Contains("\"mode\":\"unknown\"") && noneJson.Contains("\"backend\":\"adl-od8\""), noneJson);
        var stJson = Program.Serialize(st);
        Check("od8.rangeJson", stJson.Contains("\"default\":0") && stJson.Contains("\"fanCurve\":[{\"tempC\":40,\"pct\":20}"), stJson);
        var checks = TuningService.Checks(capsBits, init, current);
        Check("od8.checks", checks.Any(c => c.StartsWith("Every offered range")) && checks.Any(c => c.StartsWith("No zero-RPM stop temperature")));
        var probe = new TuningProbeMessage();
        Check("od8.probeWriteFalse", Program.Serialize(probe).Contains("\"write\":false"));
    }
}
