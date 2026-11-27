using System.Text;

namespace NexumAgent.Frames;

/// <summary>
/// `--selftest` checks for frame capture (CONTRACT §7 item 10): header resolution against the real
/// PresentMon 2.6.0 header, header variants, garbage rows, stream decoding, the §1.6.5 statistics
/// vectors, frametime batching, excludes and the trust-check path rules. No process is started.
/// With <c>--presentmon &lt;path&gt;</c> it also runs the full trust check on that file and requires it valid.
/// </summary>
internal static class FrameSelfTest
{
    /// <summary>Real 2.6.0 row shape (captured 2026-11-27, process renamed), CRLF.</summary>
    private const string RealRow =
        "Game.exe,34752,0x26FB8F9BA78,D3D9,-1,0,0,Other,274.7854,NA,103.07050000000001,NA,0.24490000000000,0.00000000000000,NA,431908238.1055,103.1058,102.8609,0.2449,0.0000,0.0000,0.0000,0.0000,NA,NA,NA";

    public static void Run(Action<string, bool, string> check, string? presentMonPath)
    {
        void Check(string name, bool ok, string detail = "") => check("frames." + name, ok, detail);
        void Eq<T>(string name, T actual, T expected) =>
            Check(name, EqualityComparer<T>.Default.Equals(actual, expected), $"expected <{expected}> got <{actual}>");
        void Near(string name, double? actual, double expected, double tol = 1e-9) =>
            Check(name, actual is double a && Math.Abs(a - expected) <= tol, $"expected <{expected}> got <{actual}>");

        // ---------------------------------------------------------------- header 2.6.0 (embedded file)
        string header = LoadHeader();
        Check("header.loaded", header.StartsWith("Application,", StringComparison.Ordinal), header);
        var csv = new FrameCsv();
        Eq("header.resolves", csv.ResolveHeader(header), (string?)null);
        Eq("header.cpuStart", ColumnName(header, csv.ColCpuStart), "CPUStartQPCTimeInMs");
        Eq("header.frametime", ColumnName(header, csv.ColFrameTime), "MsBetweenAppStart");
        Eq("header.cpuBusy", ColumnName(header, csv.ColCpuBusy), "MsCPUBusy");
        Eq("header.gpuBusy", ColumnName(header, csv.ColGpuBusy), "MsGPUBusy");
        Eq("header.displayed", ColumnName(header, csv.ColDisplayed), "MsBetweenDisplayChange");
        Eq("header.latency", ColumnName(header, csv.ColDisplayLatency), "MsUntilDisplayed");
        Check("header.swapChain", csv.ColSwapChain >= 0);
        Check("header.mode", csv.ColPresentMode >= 0 && csv.ColRuntime >= 0 && csv.ColAllowsTearing >= 0 && csv.ColSyncInterval >= 0);
        Eq("header.bomTolerated", new FrameCsv().ResolveHeader("\uFEFF" + header), (string?)null);

        // Real row
        Check("row.real", csv.TryParseRow(RealRow + "\r", 1.0, out var r, out var proc));
        Eq("row.real.process", proc.ToString(), "Game.exe");
        Eq("row.real.pid", r.Pid, 34752);
        Near("row.real.frametime", r.FrameTimeMs, 103.1058);
        Near("row.real.cpuStart", r.CpuStartMs, 431908238.1055, 1e-6);
        Near("row.real.cpuBusy", r.CpuBusyMs, 102.8609, 1e-4);
        Check("row.real.displayedNA", float.IsNaN(r.DisplayedMs));
        Check("row.real.latencyNA", float.IsNaN(r.DisplayLatencyMs));
        Eq("row.real.swap", r.SwapChain, 0x26FB8F9BA78UL);
        Eq("row.real.sync", (int)r.SyncInterval, -1);
        Eq("row.real.tearing", (int)r.AllowsTearing, 0);
        Eq("row.real.mode", csv.StringAt(r.PresentModeIdx), "Other");
        Eq("row.real.runtime", csv.StringAt(r.RuntimeIdx), "D3D9");

        // Garbage and invalid rows are ignored entirely.
        string[] bad =
        {
            "", "garbage", "Game.exe,1,2", RealRow + ",extra",
            RealRow.Replace(",34752,", ",0,"), RealRow.Replace(",34752,", ",-5,"), RealRow.Replace(",34752,", ",abc,"),
            RealRow.Replace(",103.1058,", ",NA,"), RealRow.Replace(",103.1058,", ",0,"), RealRow.Replace(",103.1058,", ",-1,"),
            RealRow.Replace(",103.1058,", ",5000.01,"), RealRow.Replace(",103.1058,", ",NaN,"), RealRow.Replace(",103.1058,", ",Infinity,"),
            RealRow.Replace("Game.exe,", ","),
        };
        for (int i = 0; i < bad.Length; i++) Check($"row.bad{i}", !csv.TryParseRow(bad[i], 1.0, out _, out _), bad[i]);
        Check("row.ft5000ok", csv.TryParseRow(RealRow.Replace(",103.1058,", ",5000,"), 1.0, out _, out _));
        Check("row.cpuStartNA.usesReceipt", csv.TryParseRow(RealRow.Replace(",431908238.1055,", ",NA,"), 77.5, out var rr, out _) && rr.CpuStartMs == 77.5);
        Check("row.cpuBusyNA", csv.TryParseRow(RealRow.Replace(",102.8609,", ",NA,"), 1.0, out var rb, out _) && float.IsNaN(rb.CpuBusyMs));

        // ---------------------------------------------------------------- header variants
        var v2 = new FrameCsv();
        Eq("v2.resolves", v2.ResolveHeader(
            "Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,CPUStartQPCTime,FrameTime,CPUBusy,CPUWait,GPULatency,GPUTime,GPUBusy,GPUWait,DisplayLatency,DisplayedTime"),
            (string?)null);
        Check("v2.columns", v2.ColFrameTime == 9 && v2.ColCpuStart == 8 && v2.ColCpuBusy == 10 && v2.ColGpuBusy == 14 &&
                            v2.ColDisplayLatency == 16 && v2.ColDisplayed == 17);
        Check("v2.row", v2.TryParseRow("a.exe,7,0x1,DXGI,1,0,1,Hardware: Independent Flip,1000.5,6.94,3.1,0.2,0.1,5.0,5.5,0.1,12.5,6.95", 0,
                  out var v2r, out _) && v2r.FrameTimeMs == 6.94 && v2r.AllowsTearing == 1 && v2.StringAt(v2r.PresentModeIdx) == "Hardware: Independent Flip");

        var v1 = new FrameCsv();
        Eq("v1.resolves", v1.ResolveHeader(
            "Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,WasBatched,DwmNotified,Dropped,TimeInSeconds,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsUntilRenderComplete,MsUntilDisplayed"),
            (string?)null);
        Check("v1.fallbacks", v1.ColFrameTime == 12 && v1.ColRuntime < 0 && v1.ColCpuStart < 0 && !v1.HasCpuBusy && !v1.HasGpuBusy);
        Check("v1.row", v1.TryParseRow("old.exe,9,0x2,D3D11,1,0,0,Composed: Flip,0,0,0,1.2,16.7,16.6,0.1,1.0,20.1", 55, out var v1r, out _) &&
                        v1.StringAt(v1r.RuntimeIdx) == "Other" && v1r.CpuStartMs == 55);

        var lower = new FrameCsv();
        Eq("header.caseInsensitive", lower.ResolveHeader("application,processid,msbetweenappstart"), (string?)null);
        Check("header.minimal.row", lower.TryParseRow("x.exe,3,8.5", 0, out var lr, out _) &&
                                    lower.StringAt(lr.PresentModeIdx) == "Unknown" && lr.SwapChain == 0 && lr.SyncInterval == short.MinValue && lr.AllowsTearing == -1);
        Eq("header.missingPid", new FrameCsv().ResolveHeader("Application,MsBetweenAppStart"), "ProcessID");
        Eq("header.missingApp", new FrameCsv().ResolveHeader("ProcessID,MsBetweenAppStart"), "Application");
        Eq("header.missingFrametime", new FrameCsv().ResolveHeader("Application,ProcessID,MsCPUBusy"), "MsBetweenAppStart");
        Eq("header.garbage", new FrameCsv().ResolveHeader("warning: something odd"), "Application");
        Eq("header.empty", new FrameCsv().ResolveHeader(""), "Application");

        // ---------------------------------------------------------------- stream decoding
        string text = header + "\r\n" + RealRow + "\r\n" + RealRow.Replace("34752", "11") + "\r\n";
        var utf16Bom = new byte[] { 0xFF, 0xFE }.Concat(Encoding.Unicode.GetBytes(text)).ToArray();
        CheckDecode(Check, "decode.utf16bom", utf16Bom, 3, header, chunk: 4096);
        CheckDecode(Check, "decode.utf16bom.bytewise", utf16Bom, 3, header, chunk: 1);
        CheckDecode(Check, "decode.utf16bom.odd", utf16Bom, 3, header, chunk: 3);
        CheckDecode(Check, "decode.utf16.noBom", Encoding.Unicode.GetBytes(text), 3, header, chunk: 7);
        CheckDecode(Check, "decode.utf8bom", new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes(text)).ToArray(), 3, header, chunk: 2);
        CheckDecode(Check, "decode.utf8", Encoding.UTF8.GetBytes(text.Replace("\r\n", "\n").TrimEnd('\n')), 3, header, chunk: 5);
        CheckDecode(Check, "decode.empty", Array.Empty<byte>(), 0, null, chunk: 16);

        // ---------------------------------------------------------------- statistics vectors (§1.6.5)
        Eq("pct.p99of100", FrameStatsCalc.Percentile(Seq(1, 100), 99), 99.0);
        Eq("pct.p999of1000", FrameStatsCalc.Percentile(Seq(1, 1000), 99.9), 999.0);
        Eq("pct.p99of150", FrameStatsCalc.Percentile(Seq(1, 150), 99), 149.0);
        Eq("pct.p99of1", FrameStatsCalc.Percentile(new[] { 5.0 }, 99), 5.0);
        Eq("pct.p999of1001", FrameStatsCalc.Percentile(Seq(1, 1001), 99.9), 1000.0);
        Eq("pct.p50of10", FrameStatsCalc.Percentile(Seq(1, 10), 50), 5.0);

        var cols = new FrameStatsCalc.Columns(true, true, true, true);
        double[] scratch = new double[4];
        var two = Stats(new[] { F(10), F(30) }, cols, ref scratch);
        Near("stats.timeWeighted", two.FpsAvg, 50.0); // not the mean of per-frame fps (66.7)
        Near("stats.ftAvg", two.FrametimeAvgMs, 20.0);
        Check("stats.n2.lowsNull", two.FpsLow1 is null && two.FpsLow01 is null && two.FrametimeP99Ms is null);
        var one = Stats(new[] { F(10) }, cols, ref scratch);
        Check("stats.n1", one.FpsAvg is null && one.FrametimeAvgMs is null && one.FrametimeMaxMs == 10 && one.Frames == 1);
        var none = Stats(Array.Empty<FrameRow>(), cols, ref scratch);
        Check("stats.n0", none.Frames == 0 && none.FrametimeMaxMs is null && none.DroppedPct is null && none.BoundBy is null);

        var h99 = Stats(Seq(1, 99).Select(v => F(v)).ToArray(), cols, ref scratch);
        Check("stats.n99.p1Null", h99.FpsLow1 is null);
        var h100 = Stats(Seq(1, 100).Select(v => F(v)).ToArray(), cols, ref scratch);
        Near("stats.n100.p99", h100.FrametimeP99Ms, 99);
        Near("stats.n100.p1", h100.FpsLow1, 10.1); // 1000 / 99 = 10.10 → 1 decimal
        Check("stats.n100.p01Null", h100.FpsLow01 is null && h100.FrametimeP999Ms is null);
        var t999 = Stats(Enumerable.Repeat(F(5), 999).ToArray(), cols, ref scratch);
        Check("stats.n999.p01Null", t999.FpsLow01 is null && t999.FpsLow1 == 200);
        var t1000 = Stats(Enumerable.Repeat(F(5), 999).Append(F(50)).ToArray(), cols, ref scratch);
        Near("stats.n1000.p999", t1000.FrametimeP999Ms, 5); // rank ceil(999) = 999 → the 999th value
        Near("stats.n1000.p01", t1000.FpsLow01, 200);
        Near("stats.n1000.max", t1000.FrametimeMaxMs, 50);
        var t1001 = Stats(Enumerable.Repeat(F(5), 999).Append(F(50)).Append(F(60)).ToArray(), cols, ref scratch);
        Near("stats.n1001.p999", t1001.FrametimeP999Ms, 50); // rank ceil(999.999) = 1000
        Near("stats.n1001.p01", t1001.FpsLow01, 20);

        Eq("bound.gpu", FrameStatsCalc.BoundBy(5, 10, 10, 30), "gpu");
        Eq("bound.cpu", FrameStatsCalc.BoundBy(10, 5, 10, 30), "cpu");
        Eq("bound.balanced", FrameStatsCalc.BoundBy(9, 9.5, 10, 30), "balanced");
        Eq("bound.capped", FrameStatsCalc.BoundBy(3, 4, 16.7, 30), "capped");
        Eq("bound.cappedEdge", FrameStatsCalc.BoundBy(7.5, 2, 10, 30), "cpu"); // max == 0.75 t is not capped
        Eq("bound.gpuJustAbove", FrameStatsCalc.BoundBy(10, 11.01, 12, 30), "gpu");
        Eq("bound.gpuJustBelow", FrameStatsCalc.BoundBy(10, 10.99, 12, 30), "balanced");
        Eq("bound.n29", FrameStatsCalc.BoundBy(5, 10, 10, 29), (string?)null);
        Eq("bound.cpuNull", FrameStatsCalc.BoundBy(null, 10, 10, 30), (string?)null);
        Eq("bound.gpuNull", FrameStatsCalc.BoundBy(5, null, 10, 30), (string?)null);

        var mixed = new List<FrameRow>();
        for (int i = 0; i < 40; i++) mixed.Add(F(10, cpu: 4, gpu: 9, displayed: i % 4 == 0 ? float.NaN : 10, latency: 20));
        var ms = Stats(mixed.ToArray(), cols, ref scratch);
        Eq("stats.bound", ms.BoundBy, "gpu");
        Near("stats.dropped", ms.DroppedPct, 25);
        Near("stats.displayedFps", ms.FpsDisplayedAvg, 100);
        Near("stats.latency", ms.DisplayLatencyMs, 20);
        Near("stats.cpuBusy", ms.CpuBusyMs, 4);
        var noDisplay = Stats(mixed.ToArray(), new FrameStatsCalc.Columns(true, true, false, false), ref scratch);
        Check("stats.noDisplayColumn", noDisplay.DroppedPct is null && noDisplay.FpsDisplayedAvg is null && noDisplay.DisplayLatencyMs is null);
        var noBusy = Stats(mixed.ToArray(), new FrameStatsCalc.Columns(false, true, true, true), ref scratch);
        Check("stats.noCpuBusyColumn", noBusy.CpuBusyMs is null && noBusy.BoundBy is null);
        var allDropped = Stats(Enumerable.Repeat(F(10, displayed: float.NaN), 10).ToArray(), cols, ref scratch);
        Check("stats.allDropped", allDropped.DroppedPct == 100 && allDropped.FpsDisplayedAvg is null && allDropped.DisplayLatencyMs is null);
        var rounding = Stats(new[] { F(16.666), F(16.667), F(16.668) }, cols, ref scratch);
        Near("stats.round.fps", rounding.FpsAvg, 60.0);
        Near("stats.round.ft", rounding.FrametimeAvgMs, 16.67);

        // ---------------------------------------------------------------- buffers, target data, batching
        var data = new FrameBuffers();
        Eq("buf.header", data.AcceptHeader(header), (string?)null);
        double now = 1_000_000;
        // 1500 frames of Game.exe on swap chain A, 300 on swap chain B, over the last 3 s; 10 of excluded tools.
        for (int i = 0; i < 1500; i++) data.Ingest(Row("Game.exe", 100, 0xA, now - 3000 + i * 2, 2.0), now);
        for (int i = 0; i < 300; i++) data.Ingest(Row("Game.exe", 100, 0xB, now - 1000 + i * 3, 3.0), now);
        for (int i = 0; i < 10; i++) data.Ingest(Row("dwm.exe", 200, 1, now - 500, 16.7), now);
        for (int i = 0; i < 10; i++) data.Ingest(Row("NEXUM.EXE", 201, 1, now - 500, 16.7), now);
        Check("buf.fixedExcludes", !data.Tracks.ContainsKey(200) && !data.Tracks.ContainsKey(201));
        data.Maintain(now, 30);
        Eq("buf.primary", data.Tracks[100].Primary, 0xAUL); // 1000 frames of A vs 300 of B in the last 2 s
        var s1 = data.BuildStats(100, now, 30, 1)!;
        Eq("buf.windowFrames", s1.Frames, 1500);
        Eq("buf.batchCap", s1.Frametimes.Count, 1000);
        Eq("buf.batchOmitted", s1.FrametimesOmitted, 500);
        Near("buf.fps", s1.FpsAvg, 500);
        Eq("buf.process", s1.Process, "Game.exe");
        for (int i = 0; i < 5; i++) data.Ingest(Row("Game.exe", 100, 0xA, now + i * 2, 7.25), now + 10);
        var s2 = data.BuildStats(100, now + 10, 30, 2)!;
        Check("buf.batchSincePrevious", s2.Frametimes.Count == 5 && s2.Frametimes.All(v => v == 7.25) && s2.FrametimesOmitted == 0);
        var s3 = data.BuildStats(100, now + 10, 30, 3)!;
        Check("buf.batchEmpty", s3.Frametimes.Count == 0 && s3.FrametimesOmitted == 0);
        var s4 = data.BuildStats(100, now + 10, 1, 4)!;
        Check("buf.windowSec", s4.Frames < 1505 && s4.Frames > 0 && s4.WindowSec == 1, s4.Frames.ToString());
        Check("buf.presenting", data.PresentedWithin(100, now + 1000, FrameBuffers.PresentingMs) && !data.PresentedWithin(100, now + 2500, FrameBuffers.PresentingMs));
        var list = data.Presenting(now + 10);
        // Last 2 s of primary frames before the newest one: 996 × 2 ms + 5 × 7.25 ms → 1000 × 1001 / 2028.25 = 493.5
        Check("buf.list", list.Count == 1 && list[0].Pid == 100 && Math.Abs(list[0].Fps - 493.5) < 0.05 && list[0].Runtime == "DXGI" &&
                          list[0].PresentMode == "Hardware: Independent Flip", list.Count > 0 ? list[0].Fps.ToString() : "empty");

        data.SetExcludes(FrameExcludes.Sanitize(new[] { "game.EXE" }));
        Check("buf.userExcludeDrops", !data.Tracks.ContainsKey(100));
        Check("buf.userExcludeFilters", !data.Ingest(Row("Game.exe", 100, 0xA, now, 2), now));
        data.SetExcludes(new List<string>());
        Check("buf.reinclude", data.Ingest(Row("Game.exe", 100, 0xA, now, 2), now));
        data.Ingest(Row("Other.exe", 100, 0xA, now, 2), now);
        Check("buf.pidReuse", data.Tracks[100].Name == "Other.exe" && data.Tracks[100].Count == 1);
        data.Maintain(now + 10_001, 30);
        Check("buf.evict", data.Tracks.Count == 0);
        var fresh = new FrameBuffers();
        Check("buf.noHeaderNoRows", !fresh.Ingest(RealRow, now) && fresh.Tracks.Count == 0);
        Eq("buf.badHeader", fresh.AcceptHeader("Application,MsBetweenAppStart"), "ProcessID");
        Check("buf.badHeaderNoRows", !fresh.HeaderParsed && !fresh.Ingest(RealRow, now));

        // ---------------------------------------------------------------- excludes (same rule as Rust §2.13)
        var ex = FrameExcludes.Sanitize(new[]
        {
            " obs64.exe ", "OBS64.EXE", "dwm.exe", "Nexum.exe", "bad;name.exe", "a\"b.exe", "x.bat", ".exe", "--exclude.exe",
            new string('a', 60) + ".exe", new string('a', 61) + ".exe", "My Game (x64).exe", null, "",
        });
        Check("ex.sanitize", ex.SequenceEqual(new[] { "obs64.exe", "--exclude.exe", new string('a', 60) + ".exe", "My Game (x64).exe" }),
            string.Join("|", ex));
        Eq("ex.max", FrameExcludes.Sanitize(Enumerable.Range(0, 80).Select(i => $"app{i}.exe")).Count, 50);

        // ---------------------------------------------------------------- spawn arguments and trust path rules
        Eq("cmdline.capture", PresentMonProcess.BuildCommandLine(@"C:\Program Files\Nexum\presentmon\PresentMon-2.6.0-x64.exe", PresentMonProcess.CaptureArgs),
            "\"C:\\Program Files\\Nexum\\presentmon\\PresentMon-2.6.0-x64.exe\" --output_stdout --no_console_stats --session_name NexumFrames " +
            "--stop_existing_session --qpc_time_ms --no_track_input --exclude dwm.exe --exclude msedgewebview2.exe --exclude Nexum.exe --exclude nexum-agent.exe");
        Eq("cmdline.terminate", PresentMonProcess.BuildCommandLine(@"C:\p.exe", PresentMonProcess.TerminateArgs),
            "\"C:\\p.exe\" --terminate_existing_session --session_name NexumFrames");
        Check("cmdline.rejectsSpaces", Throws(() => PresentMonProcess.BuildCommandLine(@"C:\p.exe", new[] { "--exclude", "a b.exe" })));
        Check("path.ok", PresentMonTrust.IsAcceptablePath(@"C:\Program Files\Nexum\presentmon\PresentMon-2.6.0-x64.exe"));
        Check("path.unc", !PresentMonTrust.IsAcceptablePath(@"\\server\share\PresentMon.exe"));
        Check("path.device", !PresentMonTrust.IsAcceptablePath(@"\\?\C:\PresentMon.exe"));
        Check("path.relative", !PresentMonTrust.IsAcceptablePath(@"presentmon\PresentMon.exe"));
        Check("path.driveRelative", !PresentMonTrust.IsAcceptablePath(@"C:PresentMon.exe"));
        Check("path.quote", !PresentMonTrust.IsAcceptablePath("C:\\a\"b.exe"));
        Check("path.notExe", !PresentMonTrust.IsAcceptablePath(@"C:\a\PresentMon.dll"));
        Check("path.null", !PresentMonTrust.IsAcceptablePath(null));
        using (var missing = PresentMonTrust.Check(null)) Check("trust.noFlag", !missing.Ok && missing.Code == "exeMissing" && missing.Handle is null);
        using (var missing = PresentMonTrust.Check(@"C:\nexum-selftest-does-not-exist\PresentMon-2.6.0-x64.exe"))
        {
            Check("trust.missingFile", !missing.Ok && missing.Code == "exeMissing" && missing.Signature.Status == "notChecked");
        }
        string? self = Environment.ProcessPath;
        if (self is not null && PresentMonTrust.IsAcceptablePath(self))
        {
            using var wrong = PresentMonTrust.Check(self); // a real exe that is not the pinned PresentMon
            Check("trust.hashMismatch", !wrong.Ok && wrong.Code == "signatureInvalid" && wrong.Signature.Status == "invalid" &&
                                        wrong.Signature.Sha256Match == false && wrong.Handle is null, wrong.Detail);
        }
        if (presentMonPath is not null)
        {
            using var real = PresentMonTrust.Check(presentMonPath);
            Check("trust.pinnedValid", real.Ok && real.Signature.Status == "valid" && real.Signature.Signer == "Intel Corporation" &&
                                       real.Signature.Sha256Match == true && real.Handle is { IsInvalid: false }, real.Detail);
        }

        // ---------------------------------------------------------------- wire shapes
        string session = Program.Serialize(new FrameSessionMessage { SinceTs = 5 });
        Check("json.session", session == "{\"type\":\"frameSession\",\"state\":\"stopped\",\"code\":null,\"message\":\"\",\"backend\":\"presentmon-console\"," +
                                         "\"backendVersion\":\"2.6.0\",\"sessionName\":\"NexumFrames\",\"signature\":{\"status\":\"notChecked\",\"signer\":null," +
                                         "\"sha256Match\":null},\"childPid\":null,\"sinceTs\":5}", session);
        string target = Program.Serialize(new FrameTargetMessage { Reason = "none" });
        Check("json.targetNone", target == "{\"type\":\"frameTarget\",\"pid\":null,\"process\":null,\"windowTitle\":null,\"reason\":\"none\"," +
                                           "\"runtime\":null,\"presentMode\":null,\"fullscreenExclusive\":null}", target);
        string stats = Program.Serialize(new FrameStatsMessage());
        Check("json.statsNulls", stats.Contains("\"fpsLow01\":null") && stats.Contains("\"frametimeP999Ms\":null") &&
                                 stats.Contains("\"frametimes\":[]") && stats.Contains("\"frametimesOmitted\":0") && stats.Contains("\"boundBy\":null"), stats);
        string plist = Program.Serialize(new PresentingListMessage { Ts = 1 });
        Eq("json.presentingEmpty", plist, "{\"type\":\"presentingList\",\"ts\":1,\"items\":[]}");

        Eq("arg.value", Program.ArgValue(new[] { "--presentmon", @"C:\x.exe" }, "--presentmon"), @"C:\x.exe");
        Eq("arg.missingValue", Program.ArgValue(new[] { "--presentmon" }, "--presentmon"), (string?)null);
        Eq("arg.flagAsValue", Program.ArgValue(new[] { "--presentmon", "--selftest" }, "--presentmon"), (string?)null);
        Eq("arg.absent", Program.ArgValue(new[] { "--selftest" }, "--presentmon"), (string?)null);
    }

    private static string LoadHeader()
    {
        using var s = typeof(FrameSelfTest).Assembly.GetManifestResourceStream("NexumAgent.Frames.HEADER-2.6.0.txt");
        if (s is null) return "";
        using var r = new StreamReader(s, Encoding.UTF8);
        return (r.ReadLine() ?? "").Trim();
    }

    private static string ColumnName(string header, int col) => col < 0 ? "" : header.Split(',')[col];

    private static double[] Seq(int from, int to) => Enumerable.Range(from, to - from + 1).Select(i => (double)i).ToArray();

    private static FrameRow F(double ft, float cpu = float.NaN, float gpu = float.NaN, float displayed = float.NaN, float latency = float.NaN) => new()
    {
        Pid = 1, FrameTimeMs = ft, CpuBusyMs = cpu, GpuBusyMs = gpu, DisplayedMs = displayed, DisplayLatencyMs = latency,
        SyncInterval = short.MinValue, AllowsTearing = -1,
    };

    private static FrameStatsMessage Stats(FrameRow[] frames, FrameStatsCalc.Columns cols, ref double[] scratch)
    {
        var m = new FrameStatsMessage();
        FrameStatsCalc.Fill(m, frames, cols, ref scratch);
        return m;
    }

    /// <summary>A 2.6.0-shaped row with the given process, pid, swap chain, CPU start and frametime.</summary>
    private static string Row(string process, int pid, ulong swap, double cpuStartMs, double ft) =>
        string.Create(System.Globalization.CultureInfo.InvariantCulture,
            $"{process},{pid},0x{swap:X},DXGI,0,0,1,Hardware: Independent Flip,1.0,NA,{ft},{ft},0.1,0.5,3.0,{cpuStartMs},{ft},1.0,0.1,0.5,{ft * 0.8},{ft * 0.8},0.1,NA,NA,NA");

    private static bool Throws(Action a)
    {
        try { a(); return false; }
        catch { return true; }
    }

    private static void CheckDecode(Action<string, bool, string> check, string name, byte[] bytes, int expectedLines, string? firstLine, int chunk)
    {
        var lines = new List<string>();
        new LineDecoder(new TrickleStream(bytes, chunk)).Run(batch => batch.ForEach(l => lines.Add(l.ToString())));
        bool ok = lines.Count == expectedLines && (firstLine is null || lines[0] == firstLine) && lines.All(l => !l.EndsWith('\r'));
        check("frames." + name, ok, $"{lines.Count} lines, first <{(lines.Count > 0 ? lines[0] : "")}>");
    }

    /// <summary>Returns at most <c>chunk</c> bytes per Read (like a pipe delivering partial writes).</summary>
    private sealed class TrickleStream : Stream
    {
        private readonly byte[] _data;
        private readonly int _chunk;
        private int _pos;

        public TrickleStream(byte[] data, int chunk)
        {
            _data = data;
            _chunk = Math.Max(1, chunk);
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = Math.Min(Math.Min(count, _chunk), _data.Length - _pos);
            Array.Copy(_data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _data.Length;
        public override long Position { get => _pos; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
