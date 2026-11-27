using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NexumAgent;

/// <summary>
/// Nexum hardware sidecar. Protocol (CONTRACT §1): NDJSON on stdout (one object per line,
/// UTF-8 without BOM, flushed per line), NDJSON commands on stdin, all logs on stderr.
/// </summary>
internal static class Program
{
    public const string AgentVersion = "1.0.0";

    private const int DefaultIntervalMs = 1000;
    private const int MinIntervalMs = 250;
    private const int MaxIntervalMs = 10000;

    /// <summary>Above this CPU package / GPU core temperature a fixed low preset is released to BIOS control.</summary>
    private const double ThermalFailsafeC = 90.0;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
        // Still escapes quotes, backslashes and control characters (always single-line, valid JSON);
        // only keeps apostrophes and non-ASCII text readable.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly object StdoutLock = new();
    private static StreamWriter? _stdout;

    private static readonly ManualResetEventSlim ExitSignal = new(false);
    private static readonly ManualResetEventSlim InitDone = new(false);
    private static readonly CancellationTokenSource Cts = new();
    private static readonly AutoResetEvent IntervalChanged = new(false);
    private static readonly ConcurrentDictionary<string, long> ThrottleMap = new();

    private static volatile int _intervalMs = DefaultIntervalMs;
    private static int _shutdownStarted;
    private static TelemetryService? _telemetry;
    private static FanController? _fans;

    public static bool IsAdmin { get; private set; }

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

        if (args.Any(a => string.Equals(a, "--dump", StringComparison.OrdinalIgnoreCase)))
        {
            // Diagnostics: list every hardware node and sensor (stderr) and exit. Not part of the protocol.
            return DumpSensors();
        }

        Log($"nexum-agent {AgentVersion} starting (pid {Environment.ProcessId}, admin={IsAdmin})");
        if (!IsAdmin)
        {
            Log("Not elevated: motherboard sensors, CPU temps/power and fan control will be unavailable.");
        }

        // CONTRACT: 'hello' is the first line on stdout.
        Emit(new HelloMessage { IsAdmin = IsAdmin, Pid = Environment.ProcessId });

        _fans = new FanController();

        // Start reading commands right away so 'shutdown' / EOF are honoured even while the
        // (potentially slow) hardware open is in progress. Fan commands simply wait for the lock.
        var reader = new Thread(ReadCommands) { IsBackground = true, Name = "stdin-reader" };
        reader.Start();

        try
        {
            _telemetry = new TelemetryService();
            lock (_telemetry.SyncRoot)
            {
                var sw = Stopwatch.StartNew();
                _telemetry.Open();
                Log($"Hardware opened in {sw.ElapsedMilliseconds} ms");
            }
            CheckKernelDriver();
        }
        catch (Exception ex)
        {
            Log($"Hardware initialisation failed: {ex}");
            EmitError($"Hardware initialisation failed: {ex.Message}");
        }
        finally
        {
            InitDone.Set();
        }

        if (!ExitSignal.IsSet)
        {
            var loop = new Thread(TelemetryLoop) { IsBackground = true, Name = "telemetry", Priority = ThreadPriority.BelowNormal };
            loop.Start();
        }

        ExitSignal.Wait();
        Shutdown("exit requested");
        Log("nexum-agent exited cleanly");
        return 0;
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
            }

            // Wait until the next deadline; an interval change re-evaluates it from this tick's start.
            nextDueMs += _intervalMs;
            while (!token.IsCancellationRequested)
            {
                long now = clock.ElapsedMilliseconds;
                if (nextDueMs - now > _intervalMs) nextDueMs = now + _intervalMs; // interval was shortened
                long remaining = nextDueMs - now;
                if (remaining <= 0) break;
                int signalled = WaitHandle.WaitAny(waitHandles, (int)remaining);
                if (signalled == WaitHandle.WaitTimeout) break;
                if (signalled == 1) nextDueMs = tickStartMs + _intervalMs; // interval changed: re-evaluate
            }
        }
    }

    private static void Tick(List<string> warnings)
    {
        var svc = _telemetry;
        var fans = _fans;
        if (svc is null || fans is null) return;

        warnings.Clear();
        TelemetryPacket packet;
        string? failsafeMessage = null;

        lock (svc.SyncRoot)
        {
            if (Cts.IsCancellationRequested) return;
            packet = svc.Collect(fans, warnings);
            failsafeMessage = CheckThermalFailsafe(packet, fans);
        }

        Emit(packet);

        foreach (var w in warnings)
        {
            EmitErrorThrottled(w, w);
        }
        if (failsafeMessage is not null)
        {
            EmitError(failsafeMessage);
        }
    }

    /// <summary>
    /// Safety net: if a fixed reduced-duty mode (silent / balanced / custom) is active and the CPU
    /// package or a GPU core reaches <see cref="ThermalFailsafeC"/>, give control back to the BIOS curve.
    /// Must be called under the telemetry lock. Returns a message when it fired.
    /// </summary>
    private static string? CheckThermalFailsafe(TelemetryPacket packet, FanController fans)
    {
        var preset = fans.CurrentPreset;
        if (preset is not (FanController.PresetSilent or FanController.PresetBalanced or FanController.PresetCustom))
        {
            return null;
        }

        double cpu = packet.Cpu.PackageTempC ?? double.MinValue;
        double gpu = packet.Gpus.Count == 0 ? double.MinValue : packet.Gpus.Max(g => g.TempC ?? double.MinValue);
        double hottest = Math.Max(cpu, gpu);
        if (hottest < ThermalFailsafeC) return null;

        var (_, msg) = fans.ApplyPreset(FanController.PresetAuto);
        packet.FanPreset = fans.CurrentPreset;
        var source = cpu >= gpu ? "CPU" : "GPU";
        Log($"Thermal failsafe: {source} at {hottest:0.0} C - {msg}");
        return $"Thermal failsafe: {source} reached {hottest:0.0} °C, fan control released to BIOS ({msg})";
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
            EmitError($"Invalid command JSON: {ex.Message}");
            return false;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("cmd", out var cmdEl) || cmdEl.ValueKind != JsonValueKind.String)
            {
                EmitError("Command is missing a string 'cmd' field");
                return false;
            }

            var cmd = cmdEl.GetString() ?? "";
            if (Volatile.Read(ref _shutdownStarted) == 1)
            {
                return true;
            }

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
                    var (ok, msg) = WithHardware(f => f.ApplyPreset(preset));
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
                    var (ok, msg) = WithHardware(f => f.SetFan(id, pct));
                    Ack(cmd, ok, msg);
                    break;
                }

                case "flushStandby":
                {
                    var (ok, msg) = MemoryFlush.FlushStandby();
                    Ack(cmd, ok, msg);
                    break;
                }

                case "shutdown":
                    Log("shutdown command received");
                    return true;

                default:
                    Ack(cmd, false, $"Unknown command '{cmd}'");
                    break;
            }
        }
        return false;
    }

    /// <summary>Runs a fan operation under the hardware lock with a fresh fan map.</summary>
    private static (bool Ok, string Message) WithHardware(Func<FanController, (bool, string)> action)
    {
        // Commands can arrive while the hardware is still being opened; wait for it.
        if (!InitDone.Wait(TimeSpan.FromSeconds(60))) return (false, "Hardware monitor is still initialising");
        var svc = _telemetry;
        var fans = _fans;
        if (svc is null || fans is null) return (false, "Hardware monitor is not available");

        lock (svc.SyncRoot)
        {
            if (Volatile.Read(ref _shutdownStarted) == 1) return (false, "Agent is shutting down");
            fans.Refresh(svc.AllHardware());
            return action(fans);
        }
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

    /// <summary>Idempotent: stops the loop, restores fan control defaults, closes the Computer.</summary>
    private static void Shutdown(string reason)
    {
        if (Interlocked.Exchange(ref _shutdownStarted, 1) == 1) return;
        Log($"Shutting down ({reason})");

        try { Cts.Cancel(); } catch { /* ignore */ }

        var svc = _telemetry;
        var fans = _fans;
        if (svc is null)
        {
            ExitSignal.Set();
            return;
        }

        // Wait for an in-flight tick/command; if one is wedged, restore anyway (fans matter more).
        bool locked = false;
        try
        {
            Monitor.TryEnter(svc.SyncRoot, TimeSpan.FromSeconds(5), ref locked);
            if (!locked) Log("Hardware lock busy; restoring fan control without it");

            if (fans is not null)
            {
                try
                {
                    // Make sure controls set before a re-enumeration are still known.
                    int n = fans.RestoreAll();
                    Log($"Restored default fan control on {n} control(s)");
                }
                catch (Exception ex)
                {
                    Log($"Fan restore failed: {ex.Message}");
                }
            }

            try { svc.Close(); }
            catch (Exception ex) { Log($"Close failed: {ex.Message}"); }
        }
        finally
        {
            if (locked) Monitor.Exit(svc.SyncRoot);
            ExitSignal.Set();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Output

    private static void Ack(string cmd, bool ok, string message) =>
        Emit(new AckMessage { Cmd = cmd, Ok = ok, Message = message });

    private static void EmitError(string message) => Emit(new ErrorMessage { Message = message });

    /// <summary>Emits an error at most once per 30 s per key (avoids a per-tick flood).</summary>
    private static void EmitErrorThrottled(string key, string message)
    {
        if (ShouldThrottle("err:" + key, 30_000)) return;
        EmitError(message);
    }

    private static void Emit(object message)
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

        var w = _stdout;
        if (w is null) return;
        lock (StdoutLock)
        {
            try
            {
                // One complete line per flush so the reader never observes a partial object.
                w.Write(json);
                w.Write('\n');
                w.Flush();
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // Parent is gone: nothing left to talk to.
                Log($"stdout closed: {ex.Message}");
                ExitSignal.Set();
            }
        }
    }

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

    private static int DumpSensors()
    {
        Log($"nexum-agent {AgentVersion} sensor dump (admin={IsAdmin})");
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
            }

            foreach (var w in warnings) Log($"warning: {w}");
            Log("Packet: " + JsonSerializer.Serialize(packet, JsonOptions));
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

    /// <summary>
    /// Since LibreHardwareMonitorLib 0.9.5 ring-0 access (Super I/O fans, CPU MSR temps/power, SMBus)
    /// goes through the separately installed, signed PawnIO driver instead of the bundled WinRing0
    /// (which Microsoft's vulnerable-driver blocklist rejects). Tell the host when it is missing.
    /// </summary>
    private static void CheckKernelDriver()
    {
        try
        {
            if (LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled)
            {
                Log($"PawnIO driver installed (version {LibreHardwareMonitor.PawnIo.PawnIo.Version})");
                return;
            }
            Log("PawnIO driver not installed: motherboard fans, CPU package temp/power and fan control are unavailable.");
            if (IsAdmin)
            {
                EmitError("PawnIO driver is not installed: motherboard fan and CPU temperature/power sensors and fan control are unavailable. Install PawnIO (https://pawnio.eu) and restart Nexum.");
            }
        }
        catch (Exception ex)
        {
            Log($"PawnIO check failed: {ex.Message}");
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
