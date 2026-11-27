namespace NexumAgent;

/// <summary>
/// Holds the system-wide ISA-bus mutex (the one LibreHardwareMonitor, HWiNFO and other monitors share)
/// around Nexum's fan writes and restores.
/// <para>
/// Why: LHM 0.9.6 <c>IT87XX.SetControl</c> / <c>Nct677X.SetControl</c> wait only 10 ms for that mutex
/// and then <b>return silently without writing</b>. With another monitoring tool polling the Super I/O,
/// a fan write or a BIOS restore can therefore be dropped while Nexum believes it succeeded (and
/// deletes the write-ahead flag, or thinks the override reached 100%). Windows mutexes are recursive
/// per thread, so while this thread owns the mutex through our handle, LHM's own 10 ms wait on the
/// same named mutex succeeds at once.
/// </para>
/// Must be released on the acquiring thread (use with <c>using</c> around synchronous code only).
/// </summary>
internal static class IsaBusGuard
{
    /// <summary>Same name as LHM's <c>Mutexes.Open()</c>.</summary>
    private const string MutexName = @"Global\Access_ISABUS.HTP.Method";

    /// <summary>How long a fan write waits for another tool to finish its Super I/O access.</summary>
    public const int DefaultTimeoutMs = 1500;

    private static readonly object Gate = new();
    private static Mutex? _mutex;

    public readonly struct Lease : IDisposable
    {
        private readonly Mutex? _held;
        internal Lease(Mutex? held) { _held = held; }
        public bool Acquired => _held is not null;

        public void Dispose()
        {
            try { _held?.ReleaseMutex(); }
            catch (Exception ex) { Program.Log($"ISA bus mutex release failed: {ex.Message}"); }
        }
    }

    /// <summary>
    /// Waits up to <paramref name="timeoutMs"/> for the ISA-bus mutex. When the mutex does not exist
    /// (LHM not opened, self-test) or cannot be taken in time, returns a lease that holds nothing and the
    /// write proceeds as before (LHM's own 10 ms attempt).
    /// </summary>
    public static Lease Acquire(int timeoutMs = DefaultTimeoutMs)
    {
        var m = Open();
        if (m is null) return new Lease(null);
        try
        {
            if (m.WaitOne(timeoutMs)) return new Lease(m);
            Program.LogThrottled("isa-busy", $"ISA bus busy for {timeoutMs} ms (another hardware tool?); writing fans without it");
            return new Lease(null);
        }
        catch (AbandonedMutexException)
        {
            // The previous owner died while holding it; we own it now.
            return new Lease(m);
        }
        catch (Exception ex)
        {
            Program.LogThrottled("isa-wait", $"ISA bus mutex wait failed: {ex.Message}");
            return new Lease(null);
        }
    }

    private static Mutex? Open()
    {
        lock (Gate)
        {
            if (_mutex is not null) return _mutex;
            try
            {
                if (Mutex.TryOpenExisting(MutexName, out var m)) _mutex = m;
            }
            catch (Exception ex)
            {
                Program.LogThrottled("isa-open", $"ISA bus mutex unavailable: {ex.Message}");
            }
            return _mutex;
        }
    }
}
