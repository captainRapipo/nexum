using System.Collections.Concurrent;
using System.ComponentModel;

namespace NexumAgent.Frames;

/// <summary>
/// Frame capture (CONTRACT §1.6, ROADMAP §4.1): runs Intel's signed PresentMon console exe as a child
/// of the elevated agent, parses its CSV and publishes frameSession / frameTarget / frameStats /
/// presentingList. No injection, no hooks, no handles on other processes (§0 anti-cheat stance).
///
/// Threads: "frames-control" serializes start/stop/restart (they wait on child processes and must not
/// block the stdin reader); "frames-reader"/"frames-stderr" drain the child's pipes; "frames-tick"
/// runs the 500 ms target rule and the 1 Hz statistics. All shared state is guarded by <see cref="_lock"/>.
/// </summary>
internal sealed class FrameMonitor
{
    public const string MsgStopped = "Frame capture is off.";
    public const string MsgStarting = "Starting PresentMon…";
    public const string MsgRunning = "Capturing frames with Intel PresentMon 2.6.0.";
    public const string MsgNotElevated = "Frame capture needs administrator rights.";
    public const string MsgExeMissing = "PresentMon is not installed with this copy of Nexum.";
    public const string MsgSignatureInvalid = "PresentMon failed its signature check, so it was not started.";

    private static readonly int[] RestartDelaysMs = { 2000, 10000, 30000 };
    private const long AttemptResetMs = 10 * 60 * 1000;
    private const int TickMs = 500;
    private const int StderrLogIntervalMs = 30_000;
    private const int StderrFreeLines = 8;

    private readonly string? _exePath;
    private readonly bool _isAdmin;
    private readonly Action<object> _emit;
    private readonly Action<string, bool, string> _ack;
    private readonly Action<string> _log;
    private readonly int _ownPid = Environment.ProcessId;

    private readonly object _lock = new();
    private readonly FrameBuffers _data = new();

    // Session state (guarded by _lock).
    private string _state = "stopped";
    private string? _code;
    private string _message = MsgStopped;
    private FrameSignature _signature = FrameSignature.NotChecked;
    private int? _childPid;
    private long _sinceTs = UnixMs();
    private bool _enabled;
    private int _generation;
    private int _attempts;
    private bool _shuttingDown;
    private PresentMonProcess? _child;
    private int _windowSec = 30;
    private int? _manualPid;
    private int? _autoPid;
    private int? _targetPid;
    private string _targetReason = "none";
    private System.Threading.Timer? _restartTimer;

    private readonly BlockingCollection<Action> _ops = new(new ConcurrentQueue<Action>());
    private Thread? _control;
    private Thread? _tick;
    private long _lastStderrLog = -StderrLogIntervalMs;

    public FrameMonitor(string? exePath, bool isAdmin, Action<object> emit, Action<string, bool, string> ack, Action<string> log)
    {
        _exePath = exePath;
        _isAdmin = isAdmin;
        _emit = emit;
        _ack = ack;
        _log = log;
    }

    private static long UnixMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // =============================================================================================
    // Commands (called on the stdin thread)

    /// <summary>The frameSession written right after hello (stopped, signature not checked).</summary>
    public void EmitInitialSession()
    {
        lock (_lock) EmitSessionLocked();
    }

    /// <summary>
    /// Agent start (elevated only): removes a <c>NexumFrames</c> ETW session left by a hard-killed agent, so it does
    /// not hold kernel buffers until reboot when frame capture stays off. Queued before any frames command.
    /// </summary>
    public void CleanupAtStart()
    {
        if (!_isAdmin) return;
        Post(() =>
        {
            lock (_lock)
            {
                if (_shuttingDown || _enabled || _child is not null) return;
            }
            EtwSession.StopIfPresent(_log, "agent start");
        });
    }

    /// <summary>Fallback after a stop or a final failure: ends the fixed-name session if the terminate call could not.</summary>
    private void StopLeftoverSession(string reason)
    {
        if (_isAdmin) EtwSession.StopIfPresent(_log, reason);
    }

    /// <summary>{cmd:"frames", enabled}. The ack is written when the start/stop has finished.</summary>
    public void SetEnabled(bool enabled)
    {
        Post(enabled ? StartOp : StopOp);
    }

    /// <summary>{cmd:"frameTarget", pid}: null = automatic. Emits frameTarget (if it changed) before the ack.</summary>
    public void SetTarget(int? pid)
    {
        lock (_lock)
        {
            if (pid is null)
            {
                _manualPid = null;
                RunTargetRuleLocked(ForegroundTracker.ForegroundPid(), FrameClock.NowMs());
                _ack("frameTarget", true, "Automatic target");
                return;
            }
            double now = FrameClock.NowMs();
            if (IsCapturingLocked() && pid.Value != _ownPid && _data.PresentedWithin(pid.Value, now, FrameBuffers.PresentingMs))
            {
                _manualPid = pid.Value;
                string name = _data.Tracks[pid.Value].Name;
                RunTargetRuleLocked(ForegroundTracker.ForegroundPid(), now);
                _ack("frameTarget", true, $"Target: {name}");
                return;
            }
            _ack("frameTarget", false, "That app is not presenting frames.");
        }
    }

    /// <summary>{cmd:"frameWindow", sec}: integer seconds clamped 5..120.</summary>
    public void SetWindow(int sec)
    {
        int clamped = Math.Clamp(sec, 5, 120);
        lock (_lock) _windowSec = clamped;
        _ack("frameWindow", true, $"Window: {clamped} s");
    }

    /// <summary>{cmd:"frameExclude", names}: replaces the user excludes (filtered in the agent, never CLI arguments).</summary>
    public void SetExcludes(IEnumerable<string?> names)
    {
        var sanitized = FrameExcludes.Sanitize(names);
        lock (_lock)
        {
            _data.SetExcludes(sanitized);
            if (IsCapturingLocked()) RunTargetRuleLocked(ForegroundTracker.ForegroundPid(), FrameClock.NowMs());
        }
        _ack("frameExclude", true, $"Excluding {sanitized.Count} apps");
    }

    /// <summary>{cmd:"presentingList"} → one presentingList line.</summary>
    public void EmitPresentingList()
    {
        int? fg = ForegroundTracker.ForegroundPid();
        lock (_lock)
        {
            var msg = new PresentingListMessage { Ts = UnixMs() };
            if (_state == "running")
            {
                var rows = _data.Presenting(FrameClock.NowMs());
                var titles = ForegroundTracker.WindowTitles(rows.Select(r => r.Pid));
                foreach (var r in rows)
                {
                    msg.Items.Add(new PresentingProcess
                    {
                        Pid = r.Pid,
                        Process = r.Name,
                        WindowTitle = titles.TryGetValue(r.Pid, out var t) ? t : null,
                        Fps = r.Fps,
                        Runtime = r.Runtime,
                        PresentMode = r.PresentMode,
                        IsForeground = fg == r.Pid,
                        IsTarget = _targetPid == r.Pid,
                    });
                }
            }
            _emit(msg);
        }
    }

    // =============================================================================================
    // Start / stop (frames-control thread)

    private void Post(Action op)
    {
        lock (_lock)
        {
            if (_shuttingDown) return;
            if (_control is null)
            {
                _control = new Thread(ControlLoop) { IsBackground = true, Name = "frames-control", Priority = ThreadPriority.BelowNormal };
                _control.Start();
            }
        }
        try { _ops.Add(op); }
        catch (InvalidOperationException) { /* shutting down */ }
    }

    private void ControlLoop()
    {
        foreach (var op in _ops.GetConsumingEnumerable())
        {
            try { op(); }
            catch (Exception ex) { _log($"Frame capture operation failed: {ex}"); }
        }
    }

    private void StartOp()
    {
        int gen;
        lock (_lock)
        {
            if (_shuttingDown) return;
            if (_enabled && _state is "starting" or "running")
            {
                _ack("frames", true, "Frame capture is already on");
                return;
            }
            CancelRestartLocked();
            _enabled = true;
            _attempts = 0;
            gen = ++_generation;
            if (!_isAdmin)
            {
                _enabled = false;
                SetStateLocked("error", "notElevated", MsgNotElevated, null);
                _ack("frames", false, MsgNotElevated);
                return;
            }
        }
        var (ok, message) = SpawnCapture(gen, restart: false);
        _ack("frames", ok, ok ? "Frame capture started" : message);
    }

    /// <summary>Trust check + spawn. On failure sets the error state (and stops retrying for trust failures).</summary>
    private (bool Ok, string Message) SpawnCapture(int gen, bool restart)
    {
        using var trust = PresentMonTrust.Check(_exePath);
        string? trustFailed = null;
        lock (_lock)
        {
            if (_shuttingDown || gen != _generation || !_enabled) return (false, "Frame capture was turned off");
            if (trust.Signature.Status != "notChecked") _signature = trust.Signature;
            if (!trust.Ok)
            {
                _log($"PresentMon trust check failed: {trust.Detail}");
                _enabled = false;
                string msg = trust.Code == "exeMissing" ? MsgExeMissing : MsgSignatureInvalid;
                SetStateLocked("error", trust.Code ?? "signatureInvalid", msg, null);
                ClearTargetLocked();
                trustFailed = msg;
            }
        }
        if (trustFailed is not null)
        {
            // The terminate call cannot run with an untrusted exe either; a session left by a crashed child goes here.
            StopLeftoverSession("trust check failed");
            return (false, trustFailed);
        }

        PresentMonProcess child;
        try
        {
            child = PresentMonProcess.Start(trust, PresentMonProcess.CaptureArgs, captureOutput: true);
        }
        catch (Exception ex)
        {
            string reason = (ex is Win32Exception w ? w.Message : ex.Message).Trim().TrimEnd('.');
            string msg = $"PresentMon could not be started: {reason}.";
            _log($"PresentMon spawn failed: {ex}");
            lock (_lock)
            {
                if (restart && _enabled && gen == _generation && _attempts < RestartDelaysMs.Length)
                {
                    ScheduleRestartLocked(gen); // counts as a failed attempt
                    return (false, msg);
                }
                _enabled = false;
                SetStateLocked("error", "spawnFailed", msg, null);
                ClearTargetLocked();
            }
            StopLeftoverSession("PresentMon could not be started");
            return (false, msg);
        }

        lock (_lock)
        {
            if (_shuttingDown || gen != _generation || !_enabled)
            {
                // Turned off while spawning: the stop path already ran; end this child too.
                PresentMonProcess.TerminateAll();
                child.Dispose();
                return (false, "Frame capture was turned off");
            }
            _child = child;
            _data.ExpectHeader();
            SetStateLocked("starting", null, MsgStarting, child.Pid);
            _log($"PresentMon started (pid {child.Pid}, attempt {_attempts})");
            EnsureTickThreadLocked();
        }

        new Thread(() => ReadStdout(child, gen)) { IsBackground = true, Name = "frames-reader", Priority = ThreadPriority.BelowNormal }.Start();
        new Thread(() => ReadStderr(child)) { IsBackground = true, Name = "frames-stderr", Priority = ThreadPriority.Lowest }.Start();
        return (true, "Frame capture started");
    }

    private void StopOp()
    {
        PresentMonProcess? child;
        lock (_lock)
        {
            if (_shuttingDown) return;
            CancelRestartLocked();
            _enabled = false;
            _generation++;
            child = _child;
            _child = null;
        }

        StopSequence(child, terminateWaitMs: 5000, childWaitMs: 3000);

        lock (_lock)
        {
            if (_shuttingDown) return;
            _data.Clear();
            _manualPid = null;
            _autoPid = null;
            SetStateLocked("stopped", null, MsgStopped, null);
            ClearTargetLocked();
        }
        _ack("frames", true, "Frame capture stopped");
    }

    /// <summary>
    /// Ends the fixed-name ETW session with the terminate call (even when the capture child already died,
    /// so no orphan survives), then kills the job if the capture child is still alive.
    /// </summary>
    private void StopSequence(PresentMonProcess? child, int terminateWaitMs, int childWaitMs)
    {
        RunTerminateCall(terminateWaitMs);
        if (child is not null)
        {
            if (!SafeWait(child, childWaitMs))
            {
                _log("PresentMon did not exit after its session was stopped; ending it");
                PresentMonProcess.TerminateAll();
                SafeWait(child, 1000);
            }
        }
        StopLeftoverSession("after stop");
    }

    /// <summary>Spawns "--terminate_existing_session --session_name NexumFrames" after the trust check; waits ≤ waitMs.</summary>
    private PresentMonProcess? RunTerminateCall(int waitMs)
    {
        if (!_isAdmin) return null; // not elevated: nothing was ever spawned, nothing may be
        PresentMonProcess? term = null;
        try
        {
            using var trust = PresentMonTrust.Check(_exePath);
            if (!trust.Ok)
            {
                _log($"PresentMon terminate call skipped: trust check failed ({trust.Detail})");
                return null;
            }
            term = PresentMonProcess.Start(trust, PresentMonProcess.TerminateArgs, captureOutput: false);
        }
        catch (Exception ex)
        {
            _log($"PresentMon terminate call failed: {ex.Message}");
            return null;
        }
        if (waitMs > 0)
        {
            if (!SafeWait(term, waitMs)) _log("PresentMon terminate call did not finish in time");
            term.Dispose();
            return null;
        }
        return term;
    }

    private static bool SafeWait(PresentMonProcess p, int ms)
    {
        try { return p.WaitForExit(ms); }
        catch (ObjectDisposedException) { return true; }
    }

    /// <summary>
    /// Agent shutdown/EOF (after the fan restore): hard budget, never waits beyond it (CONTRACT §1.6.6).
    /// Anything still running at the deadline is ended through the job object.
    /// </summary>
    public void Shutdown(int budgetMs)
    {
        PresentMonProcess? child;
        bool needed;
        lock (_lock)
        {
            if (_shuttingDown) return;
            _shuttingDown = true;
            CancelRestartLocked();
            needed = _enabled || _child is not null || _state is "starting" or "running";
            _enabled = false;
            _generation++;
            child = _child;
            _child = null;
        }
        try { _ops.CompleteAdding(); } catch { /* ignore */ }
        if (!needed) return;

        long deadline = Environment.TickCount64 + budgetMs;
        PresentMonProcess? term = RunTerminateCall(0);
        try
        {
            if (term is not null) SafeWait(term, (int)Math.Max(0, deadline - Environment.TickCount64));
            if (child is not null) SafeWait(child, (int)Math.Max(0, deadline - Environment.TickCount64));
        }
        finally
        {
            bool alive = (term is not null && !SafeWait(term, 0)) || (child is not null && !SafeWait(child, 0));
            if (alive) PresentMonProcess.TerminateAll();
            term?.Dispose();
        }
        // The terminate call may have been cut short by the budget (or skipped): stopping the fixed-name session
        // directly takes milliseconds and needs no process.
        StopLeftoverSession("shutdown");
    }

    // =============================================================================================
    // Child output

    private void ReadStdout(PresentMonProcess child, int gen)
    {
        string? unsupported = null;
        var stream = child.Stdout!;
        try
        {
            var decoder = new LineDecoder(stream);
            decoder.Run(batch =>
            {
                lock (_lock)
                {
                    if (!ReferenceEquals(child, _child))
                    {
                        batch.ForEach(static _ => { }); // stale child: drop its output
                        return;
                    }
                    double now = FrameClock.NowMs();
                    batch.ForEach(line =>
                    {
                        if (unsupported is not null) return;
                        if (!_data.HeaderParsed)
                        {
                            if (line.Trim().IsEmpty) return;
                            var missing = _data.AcceptHeader(line);
                            if (missing is not null)
                            {
                                unsupported = missing;
                                _log($"PresentMon header without {missing}: {line.ToString()}");
                                return;
                            }
                            SetStateLocked("running", null, MsgRunning, child.Pid);
                            return;
                        }
                        _data.Ingest(line, now);
                    });
                }
                if (unsupported is not null)
                {
                    string name = unsupported;
                    unsupported = "";
                    if (name.Length > 0) Post(() => UnsupportedOp(child, gen, name));
                }
            });
        }
        catch (Exception ex)
        {
            _log($"PresentMon output reader failed: {ex.Message}");
        }
        finally
        {
            try { stream.Dispose(); } catch { /* ignore */ }
        }

        SafeWait(child, 3000);
        uint? code = null;
        try { code = child.ExitCode; } catch { /* ignore */ }
        Post(() => ChildExitedOp(child, gen, code));
    }

    private void ReadStderr(PresentMonProcess child)
    {
        var stream = child.Stderr!;
        int lines = 0;
        try
        {
            new LineDecoder(stream).Run(batch => batch.ForEach(line =>
            {
                if (line.Trim().IsEmpty) return;
                // The first lines of each child (startup warnings and errors) are always logged; then 1 line / 30 s.
                if (++lines > StderrFreeLines)
                {
                    long now = Environment.TickCount64;
                    if (now - Interlocked.Read(ref _lastStderrLog) < StderrLogIntervalMs) return;
                    Interlocked.Exchange(ref _lastStderrLog, now);
                }
                _log("PresentMon: " + line.ToString());
            }));
        }
        catch (Exception ex)
        {
            _log($"PresentMon stderr reader failed: {ex.Message}");
        }
        finally
        {
            try { stream.Dispose(); } catch { /* ignore */ }
        }
    }

    private void UnsupportedOp(PresentMonProcess child, int gen, string missing)
    {
        lock (_lock)
        {
            if (!ReferenceEquals(child, _child) || gen != _generation) return;
            CancelRestartLocked();
            _enabled = false;
            _generation++;
            _child = null;
        }
        StopSequence(child, terminateWaitMs: 5000, childWaitMs: 3000);
        lock (_lock)
        {
            if (_shuttingDown) return;
            _data.Clear();
            SetStateLocked("error", "unsupportedOutput", $"PresentMon output is missing the {missing} column.", null);
            ClearTargetLocked();
        }
    }

    private void ChildExitedOp(PresentMonProcess child, int gen, uint? exitCode)
    {
        bool gaveUp = false;
        try
        {
            lock (_lock)
            {
                if (!ReferenceEquals(child, _child)) return; // stopped on purpose (or replaced)
                _child = null;
                _childPid = null;
                if (_shuttingDown || !_enabled || gen != _generation) return;

                long ranMs = Environment.TickCount64 - child.StartedTick;
                if (ranMs >= AttemptResetMs) _attempts = 0;
                string code = exitCode is null ? "unknown" : unchecked((int)exitCode.Value).ToString(System.Globalization.CultureInfo.InvariantCulture);
                _log($"PresentMon exited unexpectedly (exit code {code}) after {ranMs / 1000} s");
                if (_attempts >= RestartDelaysMs.Length)
                {
                    _enabled = false;
                    _generation++;
                    SetStateLocked("error", "exited", $"PresentMon stopped unexpectedly (exit code {code}).", null);
                    ClearTargetLocked();
                    gaveUp = true;
                    return;
                }
                ScheduleRestartLocked(gen);
            }
        }
        finally
        {
            child.Dispose();
            if (gaveUp) StopLeftoverSession("PresentMon stopped unexpectedly");
        }
    }

    private void ScheduleRestartLocked(int gen)
    {
        int delay = RestartDelaysMs[Math.Min(_attempts, RestartDelaysMs.Length - 1)];
        _attempts++;
        CancelRestartLocked();
        _log($"Restarting PresentMon in {delay / 1000} s (attempt {_attempts} of {RestartDelaysMs.Length})");
        _restartTimer = new System.Threading.Timer(_ => Post(() => RestartOp(gen)), null, delay, Timeout.Infinite);
    }

    private void CancelRestartLocked()
    {
        _restartTimer?.Dispose();
        _restartTimer = null;
    }

    private void RestartOp(int gen)
    {
        lock (_lock)
        {
            if (_shuttingDown || !_enabled || gen != _generation || _child is not null) return;
        }
        SpawnCapture(gen, restart: true);
    }

    // =============================================================================================
    // Target rule (500 ms) and statistics (1 Hz) — frames-tick thread

    private void EnsureTickThreadLocked()
    {
        if (_tick is not null) return;
        _tick = new Thread(TickLoop) { IsBackground = true, Name = "frames-tick", Priority = ThreadPriority.BelowNormal };
        _tick.Start();
    }

    private void TickLoop()
    {
        int n = 0;
        while (true)
        {
            Thread.Sleep(TickMs);
            try
            {
                lock (_lock)
                {
                    if (_shuttingDown) return;
                    if (!IsCapturingLocked()) continue;
                }
                int? fg = ForegroundTracker.ForegroundPid();
                bool second = (++n & 1) == 0;
                lock (_lock)
                {
                    if (_shuttingDown) return;
                    if (!IsCapturingLocked()) continue;
                    double now = FrameClock.NowMs();
                    if (second) _data.Maintain(now, _windowSec);
                    RunTargetRuleLocked(fg, now);
                    if (second && _state == "running" && _targetPid is int pid)
                    {
                        var stats = _data.BuildStats(pid, now, _windowSec, UnixMs());
                        if (stats is not null) _emit(stats);
                    }
                }
            }
            catch (Exception ex)
            {
                _log($"Frame tick failed: {ex.Message}");
            }
        }
    }

    private bool IsCapturingLocked() => _enabled && _child is not null && _state is "starting" or "running";

    /// <summary>CONTRACT §1.6.4 target rule; emits frameTarget when pid or reason changes.</summary>
    private void RunTargetRuleLocked(int? foreground, double now)
    {
        int? pid = null;
        string reason = "none";

        if (_manualPid is int m)
        {
            if (_data.PresentedWithin(m, now, FrameBuffers.TargetKeepMs))
            {
                pid = m;
                reason = "manual";
            }
            else if (!ForegroundTracker.ProcessExists(m))
            {
                _manualPid = null; // gone for good: back to automatic
            }
        }

        if (pid is null)
        {
            if (foreground is int f && f != _ownPid && _data.PresentedWithin(f, now, FrameBuffers.PresentingMs))
            {
                pid = f;
                reason = "foreground";
                _autoPid = f;
            }
            else if (_autoPid is int a && _data.PresentedWithin(a, now, FrameBuffers.TargetKeepMs))
            {
                pid = a; // alt-tab to Nexum or a browser keeps the game
                reason = "foreground";
            }
            else
            {
                _autoPid = null;
            }
        }

        if (pid == _targetPid && reason == _targetReason) return;
        _targetPid = pid;
        _targetReason = reason;
        _emit(BuildTargetLocked(pid, reason));
    }

    private FrameTargetMessage BuildTargetLocked(int? pid, string reason)
    {
        if (pid is not int p || !_data.Tracks.TryGetValue(p, out var t))
        {
            return new FrameTargetMessage { Reason = "none" };
        }
        var newest = t.NewestPrimary();
        string? mode = newest is { } nf && _data.Csv.ColPresentMode >= 0 ? _data.Csv.StringAt(nf.PresentModeIdx) : null;
        string? runtime = newest is { } nr ? _data.Csv.StringAt(nr.RuntimeIdx) : null;
        return new FrameTargetMessage
        {
            Pid = p,
            Process = t.Name,
            WindowTitle = ForegroundTracker.WindowTitle(p),
            Reason = reason,
            Runtime = runtime,
            PresentMode = mode ?? (newest is null ? null : "Unknown"),
            FullscreenExclusive = mode is null ? null : mode.StartsWith("Hardware: Legacy", StringComparison.Ordinal),
        };
    }

    private void ClearTargetLocked()
    {
        _manualPid = null;
        _autoPid = null;
        if (_targetPid is null && _targetReason == "none") return;
        _targetPid = null;
        _targetReason = "none";
        if (!_shuttingDown) _emit(new FrameTargetMessage { Reason = "none" });
    }

    // =============================================================================================
    // Session state

    private void SetStateLocked(string state, string? code, string message, int? childPid)
    {
        if (_state == state && _code == code && _message == message && _childPid == childPid) return;
        _state = state;
        _code = code;
        _message = message;
        _childPid = childPid;
        _sinceTs = UnixMs();
        EmitSessionLocked();
    }

    private void EmitSessionLocked()
    {
        if (_shuttingDown) return;
        _emit(new FrameSessionMessage
        {
            State = _state,
            Code = _code,
            Message = _message,
            Signature = _signature,
            ChildPid = _childPid,
            SinceTs = _sinceTs,
        });
    }
}
