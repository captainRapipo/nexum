using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.Hardware.Storage;
using NexumAgent.Frames;
using NexumAgent.Tuning;

namespace NexumAgent;

/// <summary>
/// Nexum hardware sidecar. Protocol 3 (CONTRACT §1): NDJSON on stdout (one object per line,
/// UTF-8 without BOM, flushed per line), NDJSON commands on stdin, all logs on stderr.
/// Command line: <c>nexum-agent [--presentmon "&lt;absolute path&gt;"] [--selftest] [--dump]</c>.
/// </summary>
internal static class Program
{
    public const string AgentVersion = "1.1.0";
    public const int ProtocolVersion = 3;

    /// <summary>Hard budget for stopping frame capture during shutdown, after the fan restore (CONTRACT §1.6.6).</summary>
    private const int FrameStopBudgetMs = 2000;

    private const int DefaultIntervalMs = 1000;
    private const int MinIntervalMs = 250;
    private const int MaxIntervalMs = 10000;

    /// <summary>Shutdown waits this long for an in-flight tick before restoring fans without the lock.</summary>
    private const int ShutdownLockWaitMs = 2000;

    private static readonly Version MinPawnIoVersion = new(2, 1, 0);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
        // Still escapes quotes, backslashes and control characters (always single-line, valid JSON);
        // only keeps apostrophes and non-ASCII text (°C, µS/cm, —) readable.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly object StdoutLock = new();
    private static StreamWriter? _stdout;
    private static readonly BlockingCollection<string> OutQueue = new(new ConcurrentQueue<string>());
    private static Thread? _writer;

    /// <summary>Backlog above which periodic packets are dropped instead of queued (parent not reading).</summary>
    private const int MaxQueuedLines = 64;

    private static readonly ManualResetEventSlim ExitSignal = new(false);
    private static readonly ManualResetEventSlim InitDone = new(false);
    private static readonly CancellationTokenSource Cts = new();
    private static readonly AutoResetEvent IntervalChanged = new(false);
    private static readonly ConcurrentDictionary<string, long> ThrottleMap = new();

    private static volatile int _intervalMs = DefaultIntervalMs;
    private static volatile bool _streamOn;
    private static int _shutdownStarted;
    private static TelemetryService? _telemetry;
    private static FanController? _fans;
    private static FanSafety? _safety;
    private static readonly SensorTree Tree = new();
    private static FrameMonitor? _frames;

    /// <summary>One background tuning call per command kind; a duplicate request is answered by the running one (CONTRACT §1.7.2).</summary>
    private sealed class InFlight { public int Busy; }
    private static readonly InFlight TuningGetInFlight = new();
    private static readonly InFlight TuningProbeInFlight = new();

    /// <summary>Set after the first telemetry tick built the sensor tree (values are then populated).</summary>
    private static readonly ManualResetEventSlim FirstTreeBuilt = new(false);

    public static bool IsAdmin { get; private set; }

    /// <summary>hello.sensorDriver, computed once at start.</summary>
    public static SensorDriverStatus SensorDriver { get; private set; } = new();

    /// <summary>Admin + PawnIO ≥ 2.1.0: CPU temperature/power/clock/voltage and Super I/O are readable.</summary>
    public static bool SensorDriverOk => SensorDriver.Ok;

    public static int Main(string[] args)
    {
        // Capture the real stdout for the protocol, then point Console.Out at stderr so no
        // library can ever corrupt the NDJSON stream with stray Console.WriteLine output.
        var rawStdout = Console.OpenStandardOutput();
        _stdout = new StreamWriter(rawStdout, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), bufferSize: 64 * 1024)
        {
            AutoFlush = false, // flushed explicitly once per complete line in Emit
            NewLine = "\n",
        };
        Console.SetOut(Console.Error);
        RedirectNativeStdoutToStderr();
        _writer = new Thread(WriteLoop) { IsBackground = true, Name = "stdout-writer" };
        _writer.Start();

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            Log($"Unhandled exception: {e.ExceptionObject}");
            Shutdown("unhandled exception");
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Shutdown("process exit");
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true; // let Main run the orderly shutdown
            Log("Ctrl+C received");
            ExitSignal.Set();
        };

        IsAdmin = DetectAdmin();

        // CONTRACT §1.1: the only source of the PresentMon path. No PATH lookup, no fallback location.
        string? presentMonPath = ArgValue(args, "--presentmon");

        if (args.Any(a => string.Equals(a, "--selftest", StringComparison.OrdinalIgnoreCase)))
        {
            return SelfTest.Run(presentMonPath);
        }

        SensorDriver = ComputeSensorDriver(IsAdmin);

        if (args.Any(a => string.Equals(a, "--dump", StringComparison.OrdinalIgnoreCase)))
        {
            // Diagnostics: list every hardware node and sensor (stderr) and exit. Read-only; not part of the protocol.
            return DumpSensors();
        }

        Log($"nexum-agent {AgentVersion} (protocol {ProtocolVersion}) starting (pid {Environment.ProcessId}, admin={IsAdmin}, presentmon={(presentMonPath is null ? "not provided" : "provided")})");
        Log($"Sensor driver: kind={SensorDriver.Kind} version={SensorDriver.Version ?? "n/a"} ok={SensorDriver.Ok} reason={SensorDriver.Reason ?? "none"}");
        if (!IsAdmin)
        {
            Log("Not elevated: motherboard sensors, CPU temps/power, drive S.M.A.R.T. and fan control are unavailable.");
        }

        // Write-ahead fan flag (CONTRACT §1.5.3): decided before any hardware access.
        string fanFlag = FanFlag.CheckAtStart(IsAdmin);
        _fans = new FanController();
        _safety = new FanSafety(_fans, IsAdmin, fanFlag);
        _frames = new FrameMonitor(presentMonPath, IsAdmin, Emit, Ack, Log);
        _frames.CleanupAtStart(); // a NexumFrames ETW session orphaned by a hard-killed agent (elevated only, no spawn)

        // Read stdin right away so 'shutdown' / EOF are honoured during the (slow) hardware open.
        // Every other command waits until 'hello' has been written (causal order).
        var reader = new Thread(ReadCommands) { IsBackground = true, Name = "stdin-reader" };
        reader.Start();

        string? initError = null;
        try
        {
            _telemetry = new TelemetryService();
            lock (_telemetry.SyncRoot)
            {
                var sw = Stopwatch.StartNew();
                _telemetry.Open();
                Log($"Hardware opened in {sw.ElapsedMilliseconds} ms");
                _fans.Refresh(_telemetry.AllHardware());
                _safety.EnterFailsafeIfNeeded();
            }
        }
        catch (Exception ex)
        {
            Log($"Hardware initialisation failed: {ex}");
            initError = $"Hardware initialisation failed: {ex.Message}";
        }

        // CONTRACT: 'hello' is the first line, after Open() and before the first telemetry.
        Emit(new HelloMessage
        {
            IsAdmin = IsAdmin,
            Pid = Environment.ProcessId,
            SensorDriver = SensorDriver,
            FanFlag = fanFlag,
        });
        if (initError is not null) EmitError(initError);
        _frames.EmitInitialSession(); // CONTRACT §1.6.6: one frameSession (stopped) right after hello
        InitDone.Set();

        if (!ExitSignal.IsSet)
        {
            var loop = new Thread(TelemetryLoop) { IsBackground = true, Name = "telemetry", Priority = ThreadPriority.BelowNormal };
            loop.Start();
        }

        ExitSignal.Wait();
        Shutdown("exit requested");
        FlushOutput(1000);
        Log("nexum-agent exited cleanly");
        return 0;
    }

    /// <summary>hello.sensorDriver (CONTRACT §1.1, MF-2/MF-3).</summary>
    internal static SensorDriverStatus ComputeSensorDriver(bool admin)
    {
        bool installed = false;
        Version? version = null;
        try { installed = LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled; }
        catch (Exception ex) { Log($"PawnIO install check failed: {ex.Message}"); }
        if (installed)
        {
            try
            {
                var v = LibreHardwareMonitor.PawnIo.PawnIo.Version;
                if (v is not null && (v.Major > 0 || v.Minor > 0 || v.Build > 0))
                {
                    version = new Version(v.Major, Math.Max(v.Minor, 0), Math.Max(v.Build, 0));
                }
            }
            catch (Exception ex) { Log($"PawnIO version unreadable: {ex.Message}"); }
        }
        return BuildSensorDriver(admin, installed, version);
    }

    internal static SensorDriverStatus BuildSensorDriver(bool admin, bool installed, Version? version)
    {
        bool versionOk = version is not null && version >= MinPawnIoVersion;
        string? reason =
            !installed ? "missing" :
            version is not null && !versionOk ? "outdated" :
            !admin ? "notElevated" :
            null;
        return new SensorDriverStatus
        {
            Kind = installed ? "pawnio" : "none",
            Version = version is null ? null : $"{version.Major}.{version.Minor}.{Math.Max(version.Build, 0)}",
            MinVersion = "2.1.0",
            Ok = admin && installed && versionOk,
            Reason = reason,
        };
    }

    // ---------------------------------------------------------------------------------------------
    // Telemetry loop

    private static void TelemetryLoop()
    {
        var token = Cts.Token;
        var warnings = new List<string>();
        var waitHandles = new[] { token.WaitHandle, IntervalChanged };
        var clock = Stopwatch.StartNew();
        long nextDueMs = -1; // drift-free schedule: each tick is due one interval after the previous due time

        while (!token.IsCancellationRequested)
        {
            long tickStartMs = clock.ElapsedMilliseconds;
            // First tick, or fell more than a full interval behind (slow tick / system sleep): resync
            // to now instead of bursting to catch up.
            if (nextDueMs < 0 || tickStartMs - nextDueMs > _intervalMs) nextDueMs = tickStartMs;
            try
            {
                Tick(warnings);
            }
            catch (Exception ex)
            {
                // Never let a tick kill the loop.
                Log($"Tick failed: {ex}");
                EmitErrorThrottled("tick", $"Telemetry tick failed: {ex.Message}");
                // A tick that cannot read the sensors must not leave fixed-duty fans unwatched: it counts
                // as a missing reading (3 in a row → override to 100%, CONTRACT §1.5.2).
                EvaluateAsMissing();
            }

            // Wait until the next deadline; an interval change re-evaluates it from this tick's start.
            nextDueMs += _intervalMs;
            while (!token.IsCancellationRequested)
            {
                long now = clock.ElapsedMilliseconds;
                if (nextDueMs - now > _intervalMs) nextDueMs = now + _intervalMs; // interval was shortened
                long remaining = nextDueMs - now;
                if (remaining <= 0) break;

                // MF-13: while fans are under manual control the override is evaluated at least every
                // second, even when the poll interval is longer (e.g. 5 s while minimised to the tray).
                var safety = _safety;
                bool manual = safety is not null && safety.ManualActive && !safety.Failsafe;
                int wait = manual ? (int)Math.Min(remaining, 250) : (int)remaining;

                int signalled = WaitHandle.WaitAny(waitHandles, wait);
                if (signalled == 1) { nextDueMs = tickStartMs + _intervalMs; continue; } // interval changed: re-evaluate
                if (signalled == 0) break;
                if (manual && nextDueMs - clock.ElapsedMilliseconds > 0) ExtraSafetyEvaluation();
            }
        }
    }

    private static void Tick(List<string> warnings)
    {
        var svc = _telemetry;
        var fans = _fans;
        var safety = _safety;
        if (svc is null || fans is null || safety is null) return;

        warnings.Clear();
        lock (svc.SyncRoot)
        {
            if (Cts.IsCancellationRequested) return;
            var packet = svc.Collect(fans, warnings);

            bool newTree = false;
            if (svc.IsOpen)
            {
                try
                {
                    newTree = Tree.Sync(svc.AllHardware());
                    FirstTreeBuilt.Set();
                    Tree.Accumulate();
                }
                catch (Exception ex)
                {
                    warnings.Add($"Sensor tree update failed: {ex.Message}");
                    Log($"Sensor tree update failed: {ex}");
                }
            }

            try
            {
                safety.Evaluate(packet.Cpu.PackageTempC, GpuTemps(packet));
            }
            catch (Exception ex)
            {
                Log($"Fan safety evaluation failed: {ex}");
            }
            packet.FanSafety = safety.Snapshot();
            packet.FanPreset = fans.CurrentPreset;

            // Causal order on one writer: tree (new rev) → telemetry → values of that rev.
            // Emitting under the hardware lock keeps a concurrent command's tree from interleaving.
            if (newTree && Tree.CurrentWithSession() is { } tree) Emit(tree);
            Emit(packet);
            if (_streamOn && Tree.Current is not null) Emit(Tree.BuildValues(packet.Ts));
        }

        foreach (var w in warnings)
        {
            EmitErrorThrottled(w, w);
        }
    }

    private static Dictionary<string, (double? Hotspot, double? Edge)> GpuTemps(TelemetryPacket packet)
    {
        var map = new Dictionary<string, (double?, double?)>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < packet.Gpus.Count && i < packet.GpuHwIds.Count; i++)
        {
            map[packet.GpuHwIds[i]] = (packet.Gpus[i].HotspotTempC, packet.Gpus[i].TempC);
        }
        return map;
    }

    /// <summary>CPU/GPU-only update + override evaluation between long ticks (CONTRACT §1.5.2).</summary>
    private static void ExtraSafetyEvaluation()
    {
        var svc = _telemetry;
        var safety = _safety;
        if (svc is null || safety is null) return;
        try
        {
            lock (svc.SyncRoot)
            {
                if (Cts.IsCancellationRequested || !safety.ExtraEvaluationDue) return;
                safety.Fans.Refresh(svc.AllHardware());
                var (cpu, gpus) = svc.SafetyUpdate(safety.ManualGpuIds);
                safety.Evaluate(cpu, gpus);
            }
        }
        catch (Exception ex)
        {
            LogThrottled("extra-eval", $"Extra fan safety evaluation failed: {ex.Message}");
            EvaluateAsMissing();
        }
    }

    /// <summary>An evaluation whose sensor read failed: every temperature counts as missing.</summary>
    private static void EvaluateAsMissing()
    {
        var svc = _telemetry;
        var safety = _safety;
        if (svc is null || safety is null) return;
        bool locked = false;
        try
        {
            Monitor.TryEnter(svc.SyncRoot, 1000, ref locked);
            if (!locked || Cts.IsCancellationRequested) return;
            safety.Evaluate(null, new Dictionary<string, (double? Hotspot, double? Edge)>(StringComparer.OrdinalIgnoreCase));
        }
        catch (Exception ex)
        {
            LogThrottled("missing-eval", $"Fan safety evaluation (sensors unreadable) failed: {ex.Message}");
        }
        finally
        {
            if (locked) Monitor.Exit(svc.SyncRoot);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Commands

    private static void ReadCommands()
    {
        try
        {
            using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
            while (true)
            {
                string? line;
                try
                {
                    line = stdin.ReadLine();
                }
                catch (Exception ex)
                {
                    Log($"stdin read failed: {ex.Message}");
                    break;
                }

                if (line is null)
                {
                    Log("stdin closed (EOF)");
                    break;
                }

                line = line.Trim();
                if (line.Length == 0) continue;

                bool stop;
                try
                {
                    stop = HandleCommand(line);
                }
                catch (Exception ex)
                {
                    Log($"Command failed: {ex}");
                    EmitError($"Command failed: {ex.Message}");
                    stop = false;
                }
                if (stop) break;
            }
        }
        catch (Exception ex)
        {
            Log($"Command reader crashed: {ex}");
        }
        finally
        {
            ExitSignal.Set();
        }
    }

    /// <summary>Handles one command line. Returns true when the agent should exit.</summary>
    private static bool HandleCommand(string line)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            WaitForHello();
            EmitError($"Invalid command JSON: {ex.Message}");
            return false;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("cmd", out var cmdEl) || cmdEl.ValueKind != JsonValueKind.String)
            {
                WaitForHello();
                EmitError("Command is missing a string 'cmd' field");
                return false;
            }

            var cmd = cmdEl.GetString() ?? "";
            if (cmd == "shutdown")
            {
                Log("shutdown command received");
                return true;
            }
            if (Volatile.Read(ref _shutdownStarted) == 1) return true;

            // Nothing but 'shutdown' may be answered before 'hello'.
            WaitForHello();
            if (ExitSignal.IsSet) return true;

            switch (cmd)
            {
                case "interval":
                {
                    if (!TryGetNumber(root, "ms", out var ms))
                    {
                        Ack(cmd, false, "Missing numeric 'ms'");
                        break;
                    }
                    int clamped = (int)Math.Clamp(Math.Round(ms), MinIntervalMs, MaxIntervalMs);
                    _intervalMs = clamped;
                    IntervalChanged.Set();
                    Ack(cmd, true, $"Polling every {clamped} ms");
                    break;
                }

                case "fanPreset":
                {
                    var preset = root.TryGetProperty("preset", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                    var (ok, msg) = WithFans(s => s.HandlePreset(preset));
                    Ack(cmd, ok, msg);
                    break;
                }

                case "fanSet":
                {
                    var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : null;
                    if (!TryGetNumber(root, "pct", out var pct))
                    {
                        Ack(cmd, false, "Missing numeric 'pct'");
                        break;
                    }
                    var (ok, msg) = WithFans(s => s.HandleFanSet(id, pct));
                    Ack(cmd, ok, msg);
                    break;
                }

                case "sensorTree":
                {
                    var svc = _telemetry;
                    if (svc is null || !svc.IsOpen)
                    {
                        EmitError("Sensor tree is not available: the hardware monitor is not open");
                        break;
                    }
                    FirstTreeBuilt.Wait(TimeSpan.FromSeconds(5)); // tree is built after the first Update()
                    lock (svc.SyncRoot)
                    {
                        if (Tree.Current is null) Tree.Sync(svc.AllHardware()); // first tick did not complete in time
                        if (Tree.CurrentWithSession() is { } tree) Emit(tree);
                    }
                    break;
                }

                case "sensorStream":
                {
                    bool on = root.TryGetProperty("on", out var onEl) && onEl.ValueKind == JsonValueKind.True;
                    if (_streamOn != on) Log($"Sensor value stream {(on ? "on" : "off")}");
                    _streamOn = on;
                    break;
                }

                case "sensorReset":
                {
                    List<string>? ids = null;
                    if (root.TryGetProperty("ids", out var idsEl) && idsEl.ValueKind == JsonValueKind.Array)
                    {
                        ids = idsEl.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String)
                                   .Select(e => e.GetString() ?? "").ToList();
                    }
                    var svc = _telemetry;
                    if (svc is null || !svc.IsOpen)
                    {
                        Ack(cmd, false, "Hardware monitor is not available");
                        break;
                    }
                    FirstTreeBuilt.Wait(TimeSpan.FromSeconds(5));
                    lock (svc.SyncRoot)
                    {
                        if (Tree.Current is null) Tree.Sync(svc.AllHardware()); // first tick did not complete in time
                        int n = Tree.Reset(ids);
                        if (ids is null && Tree.CurrentWithSession() is { } tree) Emit(tree);
                        Ack(cmd, true, $"Reset {n} sensor{(n == 1 ? "" : "s")}");
                    }
                    break;
                }

                case "spec":
                    StartSpec();
                    break;

                // ---- Frame capture (CONTRACT §1.6) ----
                case "frames":
                {
                    if (!root.TryGetProperty("enabled", out var en) || en.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    _frames!.SetEnabled(en.ValueKind == JsonValueKind.True);
                    break;
                }

                case "frameTarget":
                {
                    if (!root.TryGetProperty("pid", out var pidEl))
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    if (pidEl.ValueKind == JsonValueKind.Null)
                    {
                        _frames!.SetTarget(null);
                        break;
                    }
                    if (pidEl.ValueKind != JsonValueKind.Number || !pidEl.TryGetInt32(out int targetPid) || targetPid <= 0)
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    _frames!.SetTarget(targetPid);
                    break;
                }

                case "frameWindow":
                {
                    if (!root.TryGetProperty("sec", out var secEl) || secEl.ValueKind != JsonValueKind.Number ||
                        !secEl.TryGetDouble(out double sec) || !double.IsFinite(sec))
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    _frames!.SetWindow((int)Math.Clamp(Math.Round(sec), 5, 120));
                    break;
                }

                case "frameExclude":
                {
                    if (!root.TryGetProperty("names", out var namesEl) || namesEl.ValueKind != JsonValueKind.Array)
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    // Sanitized by the agent's own rule; the names only feed the row filter, never a command line.
                    var names = namesEl.EnumerateArray()
                        .Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() : null)
                        .ToList();
                    _frames!.SetExcludes(names);
                    break;
                }

                case "presentingList":
                    _frames!.EmitPresentingList();
                    break;

                // ---- GPU tuning, read-only (CONTRACT §1.7.2) ----
                case "tuningGet":
                    StartTuning(cmd, TuningGetInFlight, () => TuningService.GetState(IsAdmin));
                    break;

                case "tuningProbe":
                {
                    if (!root.TryGetProperty("write", out var wEl) || wEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        Ack(cmd, false, InvalidCommand);
                        break;
                    }
                    if (wEl.ValueKind == JsonValueKind.True)
                    {
                        // The write probe is not part of v1.1 (ROADMAP Q5): rejected without calling the tuning code.
                        Ack(cmd, false, "The write probe is not available in this version.");
                        break;
                    }
                    StartTuning(cmd, TuningProbeInFlight, () => TuningService.ProbeReadOnly(IsAdmin));
                    break;
                }

                default:
                    Ack(cmd, false, "Unknown command");
                    break;
            }
        }
        return false;
    }

    private const string InvalidCommand = "Invalid command";

    /// <summary>
    /// Runs a read-only tuning call on a background thread ("tuning", BelowNormal) and emits its reply.
    /// While one of the same kind runs, a second request starts nothing: the running reply answers both.
    /// </summary>
    private static void StartTuning(string cmd, InFlight inFlight, Func<object> work)
    {
        if (Interlocked.CompareExchange(ref inFlight.Busy, 1, 0) != 0) return;
        var thread = new Thread(() =>
        {
            try
            {
                object reply = work();
                if (Volatile.Read(ref _shutdownStarted) == 0) Emit(reply);
            }
            catch (Exception ex)
            {
                // TuningService never throws by contract; last resort so Rust is not left waiting.
                Log($"{cmd} failed: {ex}");
                if (Volatile.Read(ref _shutdownStarted) == 0) Ack(cmd, false, "GPU tuning data could not be read.");
            }
            finally
            {
                Volatile.Write(ref inFlight.Busy, 0);
            }
        })
        { IsBackground = true, Name = "tuning", Priority = ThreadPriority.BelowNormal };
        try
        {
            thread.Start();
        }
        catch
        {
            Volatile.Write(ref inFlight.Busy, 0);
            throw;
        }
    }

    /// <summary>Value after <paramref name="flag"/> (case-insensitive flag match), or null.</summary>
    internal static string? ArgValue(string[] args, string flag)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (!string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) continue;
            var v = args[i + 1];
            return string.IsNullOrWhiteSpace(v) || v.StartsWith("--", StringComparison.Ordinal) ? null : v;
        }
        return null;
    }

    private static void WaitForHello()
    {
        while (!InitDone.Wait(500))
        {
            if (ExitSignal.IsSet) return;
        }
    }

    /// <summary>Runs a fan operation under the hardware lock with a fresh fan map.</summary>
    private static (bool Ok, string Message) WithFans(Func<FanSafety, (bool, string)> action)
    {
        var svc = _telemetry;
        var safety = _safety;
        if (safety is null) return (false, "Hardware monitor is not available");
        if (!IsAdmin) return (false, FanSafety.MsgNeedsAdmin);
        if (svc is null || !svc.IsOpen) return (false, "Hardware monitor is not available");

        lock (svc.SyncRoot)
        {
            if (Volatile.Read(ref _shutdownStarted) == 1) return (false, "Nexum is shutting down");
            safety.Fans.Refresh(svc.AllHardware());
            return action(safety);
        }
    }

    /// <summary>{cmd:"spec"}: LHM facts under the lock (brief), WMI on a background thread.</summary>
    private static void StartSpec()
    {
        var svc = _telemetry;
        var thread = new Thread(() =>
        {
            try
            {
                SystemSpec.LhmFacts facts;
                if (svc is null) facts = new SystemSpec.LhmFacts();
                else lock (svc.SyncRoot) facts = SystemSpec.CaptureLhm(svc);
                var info = svc?.Static ?? StaticInfo.Load();
                var spec = SystemSpec.Build(facts, info);
                if (Volatile.Read(ref _shutdownStarted) == 0) Emit(spec);
            }
            catch (Exception ex)
            {
                Log($"Spec failed: {ex}");
                Emit(new AgentSpecMessage
                {
                    CapturedTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Errors = { $"System spec failed: {ex.Message}" },
                });
            }
        })
        { IsBackground = true, Name = "spec", Priority = ThreadPriority.BelowNormal };
        thread.Start();
    }

    private static bool TryGetNumber(JsonElement root, string name, out double value)
    {
        value = 0;
        if (!root.TryGetProperty(name, out var el)) return false;
        switch (el.ValueKind)
        {
            case JsonValueKind.Number:
                if (!el.TryGetDouble(out value)) return false;
                break;
            case JsonValueKind.String:
                if (!double.TryParse(el.GetString(), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out value)) return false;
                break;
            default:
                return false;
        }
        return !double.IsNaN(value) && !double.IsInfinity(value);
    }

    // ---------------------------------------------------------------------------------------------
    // Shutdown

    /// <summary>
    /// Idempotent: stops the loop, restores fan control defaults (except in failsafe mode, CONTRACT
    /// §1.5.4), deletes the fan flag when every restore succeeded, then stops frame capture within its
    /// 2 s budget (CONTRACT §1.6.6: fans first), then closes the Computer.
    /// </summary>
    private static void Shutdown(string reason)
    {
        if (Interlocked.Exchange(ref _shutdownStarted, 1) == 1) return;
        Log($"Shutting down ({reason})");

        try { Cts.Cancel(); } catch { /* ignore */ }

        var svc = _telemetry;
        var safety = _safety;
        if (svc is null)
        {
            StopFrames();
            ExitSignal.Set();
            return;
        }

        // Wait for an in-flight tick/command; if one is wedged, restore anyway (fans matter more).
        // Keep this well under the parent's shutdown grace (src-tauri agent.rs SHUTDOWN_GRACE, 6 s):
        // a parent that kills us mid-wait leaves the fans at their manual duty.
        bool locked = false;
        try
        {
            Monitor.TryEnter(svc.SyncRoot, TimeSpan.FromMilliseconds(ShutdownLockWaitMs), ref locked);
            if (!locked) Log("Hardware lock busy; restoring fan control without it");

            if (safety is not null)
            {
                try { safety.OnShutdown(); }
                catch (Exception ex) { Log($"Fan restore failed: {ex.Message}"); }
            }

            // Fans first (above), then frame capture with its own hard budget, then the Computer.
            StopFrames();

            // In failsafe the Computer must stay open: LHM's Close() would write back the stale manual
            // values this process captured (CONTRACT §1.5.4).
            bool failsafe = safety?.Failsafe ?? false;
            try { svc.Close(restoreFans: !failsafe); }
            catch (Exception ex) { Log($"Close failed: {ex.Message}"); }
        }
        finally
        {
            if (locked) Monitor.Exit(svc.SyncRoot);
            ExitSignal.Set();
        }
    }

    private static void StopFrames()
    {
        try { _frames?.Shutdown(FrameStopBudgetMs); }
        catch (Exception ex) { Log($"Frame capture stop failed: {ex.Message}"); }
    }

    // ---------------------------------------------------------------------------------------------
    // Output

    internal static void Ack(string cmd, bool ok, string message) =>
        Emit(new AckMessage { Cmd = cmd, Ok = ok, Message = message });

    private static void EmitError(string message) => Emit(new ErrorMessage { Message = message });

    /// <summary>Emits an error at most once per 30 s per key (avoids a per-tick flood).</summary>
    private static void EmitErrorThrottled(string key, string message)
    {
        if (ShouldThrottle("err:" + key, 30_000)) return;
        EmitError(message);
    }

    internal static void Emit(object message)
    {
        string json;
        try
        {
            json = JsonSerializer.Serialize(message, message.GetType(), JsonOptions);
        }
        catch (Exception ex)
        {
            Log($"Serialization failed for {message.GetType().Name}: {ex}");
            json = JsonSerializer.Serialize(new ErrorMessage { Message = $"Serialization failed: {ex.Message}" }, JsonOptions);
        }

        if (_stdout is null || OutQueue.IsAddingCompleted) return;

        // MF-13: callers emit while holding the hardware lock, so a parent that stops reading stdout
        // (hung, not dead) must never block them: that would also stop the fan thermal override.
        // Lines go through a FIFO (order preserved) drained by one writer thread; while the pipe is
        // stuck, periodic telemetry/sensorValues beyond the backlog limit are dropped.
        if (message is TelemetryPacket or SensorValuesMessage && OutQueue.Count >= MaxQueuedLines)
        {
            LogThrottled("stdout-backlog", $"stdout backlog of {OutQueue.Count} lines (parent not reading); dropping periodic packets");
            return;
        }
        try { OutQueue.Add(json); }
        catch (InvalidOperationException) { /* completed during shutdown */ }
    }

    /// <summary>The only stdout writer: one complete line per flush so the reader never sees a partial object.</summary>
    private static void WriteLoop()
    {
        bool broken = false;
        foreach (var json in OutQueue.GetConsumingEnumerable())
        {
            var w = _stdout;
            if (w is null || broken) continue;
            lock (StdoutLock)
            {
                try
                {
                    w.Write(json);
                    w.Write('\n');
                    w.Flush();
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // Parent is gone: nothing left to talk to.
                    Log($"stdout closed: {ex.Message}");
                    broken = true;
                    ExitSignal.Set();
                }
            }
        }
    }

    /// <summary>Lets the writer drain queued lines (e.g. the last acks) before the process exits.</summary>
    private static void FlushOutput(int timeoutMs)
    {
        try { OutQueue.CompleteAdding(); } catch { /* ignore */ }
        try { _writer?.Join(timeoutMs); } catch { /* ignore */ }
    }

    internal static string Serialize(object message) => JsonSerializer.Serialize(message, message.GetType(), JsonOptions);

    // ---------------------------------------------------------------------------------------------
    // Logging (stderr only)

    public static void Log(string message)
    {
        try
        {
            Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] {message}");
        }
        catch
        {
            // stderr unavailable; nothing else to do.
        }
    }

    /// <summary>Logs at most once per minute per key.</summary>
    public static void LogThrottled(string key, string message)
    {
        if (ShouldThrottle("log:" + key, 60_000)) return;
        Log(message);
    }

    private static bool ShouldThrottle(string key, long windowMs)
    {
        long now = Environment.TickCount64;
        bool throttled = false;
        ThrottleMap.AddOrUpdate(key, now, (_, last) =>
        {
            if (now - last < windowMs)
            {
                throttled = true;
                return last;
            }
            return now;
        });
        return throttled;
    }

    /// <summary>Read-only diagnostics: every hardware node, sensor and drive SMART attribute to stderr. Never writes fans.</summary>
    private static int DumpSensors()
    {
        Log($"nexum-agent {AgentVersion} sensor dump (admin={IsAdmin}, sensorDriver ok={SensorDriver.Ok} reason={SensorDriver.Reason ?? "none"})");
        var svc = new TelemetryService();
        try
        {
            svc.Open();
            var fans = new FanController();
            var warnings = new List<string>();
            svc.Collect(fans, warnings);
            Thread.Sleep(1000);
            var packet = svc.Collect(fans, warnings);

            foreach (var hw in svc.AllHardware())
            {
                Log($"== {hw.HardwareType} '{SensorUtil.SafeName(hw)}' {SensorUtil.SafeId(hw)}");
                foreach (var s in SensorUtil.SensorsOf(hw).OrderBy(s => s.SensorType).ThenBy(s => s.Index))
                {
                    string ctrl = s.Control is null ? "" : $" [control mode={s.Control.ControlMode} min={s.Control.MinSoftwareValue} max={s.Control.MaxSoftwareValue}]";
                    Log($"   {s.SensorType,-12} #{s.Index,-3} {s.Name,-36} = {(s.Value.HasValue ? s.Value.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) : "null")}  {SensorUtil.SafeId(s)}{ctrl}");
                }
                if (hw is StorageDevice sd)
                {
                    try
                    {
                        var st = sd.Storage;
                        Log($"   storage: nvme={st.IsNVMe} drive#={st.DriveNumber} bus={st.BusType} smartAttributes={st.Smart?.SmartAttributes?.Count ?? 0}");
                        foreach (var a in st.Smart?.SmartAttributes ?? new())
                        {
                            if (a?.Info is null) continue;
                            Log($"     SMART {a.Info.ID,3} {a.Info.Type,-40} raw={a.Attribute.RawValueULong} cur={a.Attribute.CurrentValue} thr={a.Attribute.Threshold}");
                        }
                    }
                    catch (Exception ex) { Log($"   storage details failed: {ex.Message}"); }
                }
            }

            foreach (var w in warnings) Log($"warning: {w}");
            foreach (var d in packet.Disks) d.Serial = d.Serial is null ? null : "••••"; // never print serials
            Log("Packet: " + Serialize(packet));
            return 0;
        }
        catch (Exception ex)
        {
            Log($"Dump failed: {ex}");
            return 1;
        }
        finally
        {
            svc.Close();
        }
    }

    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);

    /// <summary>
    /// Defence in depth for stdout purity: the protocol writer already holds the original stdout handle,
    /// so re-point the process-wide STD_OUTPUT_HANDLE at stderr. Native code that later resolves stdout
    /// via GetStdHandle (driver helper DLLs etc.) then writes to stderr instead of the NDJSON stream.
    /// </summary>
    private static void RedirectNativeStdoutToStderr()
    {
        try
        {
            var err = GetStdHandle(STD_ERROR_HANDLE);
            if (err != IntPtr.Zero && err != new IntPtr(-1)) SetStdHandle(STD_OUTPUT_HANDLE, err);
        }
        catch
        {
            // Not fatal: managed Console.Out is already redirected.
        }
    }

    private static bool DetectAdmin()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch (Exception ex)
        {
            Log($"Admin check failed: {ex.Message}");
            return false;
        }
    }
}
