namespace NexumAgent.Spec;

/// <summary>
/// Holds the system-wide PCI-bus mutex around Nexum's SMN reads (CONTRACT §1.4.1, mandatory).
/// <para>
/// An SMN read is two PCI config accesses on the host bridge (write the index at 0x60, read the data at 0x64).
/// Two tools doing that at the same time can swap each other's index, so every tool that reads SMN must hold
/// the same named mutex: LibreHardwareMonitor 0.9.6 creates <c>Global\Access_PCI</c> in <c>Computer.Open()</c>
/// (<c>LibreHardwareMonitor.Hardware.Mutexes._pciBusMutex</c>) and takes it around its own <c>ReadSmn</c>
/// calls in <c>Amd17Cpu.Processor.UpdateSensors</c> (<c>Mutexes.WaitPciBus(10)</c> / <c>ReleasePciBus()</c>).
/// The PawnIO <c>AMDFamily17</c> module's <c>ioctl_read_smn</c> documents the same requirement
/// ("acquire the \BaseNamedObjects\Access_PCI mutant before calling this"). <c>Mutexes</c> is internal to LHM,
/// so the mutex is opened by name here.
/// </para>
/// Unlike <see cref="IsaBusGuard"/>, a lease that holds nothing means "do not read": callers never touch SMN
/// without the mutex. Must be released on the acquiring thread (use with <c>using</c> around synchronous code).
/// </summary>
internal static class PciBusGuard
{
    /// <summary>Exactly the name LHM 0.9.6 <c>Mutexes.Open()</c> uses (verified in the 0.9.6 binary and source).</summary>
    internal const string MutexName = @"Global\Access_PCI";

    /// <summary>CONTRACT §1.4.1: wait at most 500 ms per batch of reads.</summary>
    public const int DefaultTimeoutMs = 500;

    private static readonly object Gate = new();
    private static Mutex? _mutex;

    public readonly struct Lease : IDisposable
    {
        private readonly Mutex? _held;
        internal Lease(Mutex? held) { _held = held; }

        /// <summary>True only when this thread owns the mutex. False = do not read.</summary>
        public bool Acquired => _held is not null;

        public void Dispose()
        {
            try { _held?.ReleaseMutex(); }
            catch (Exception ex) { Program.Log($"PCI bus mutex release failed: {ex.Message}"); }
        }
    }

    /// <summary>
    /// Waits up to <paramref name="timeoutMs"/> for the PCI-bus mutex. Returns a lease that holds nothing when the
    /// mutex does not exist (LHM not opened / not elevated) or another tool keeps it longer than the timeout.
    /// An abandoned mutex counts as acquired (the previous owner died; we own it now).
    /// </summary>
    public static Lease Acquire(int timeoutMs = DefaultTimeoutMs)
    {
        var m = Open();
        if (m is null) return new Lease(null);
        try
        {
            return m.WaitOne(timeoutMs) ? new Lease(m) : new Lease(null);
        }
        catch (AbandonedMutexException)
        {
            return new Lease(m);
        }
        catch (Exception ex)
        {
            Program.LogThrottled("pci-wait", $"PCI bus mutex wait failed: {ex.Message}");
            return new Lease(null);
        }
    }

    /// <summary>
    /// CONTRACT §1.4.1 retry rule: try for 500 ms; if that fails, wait 1 s and try once more.
    /// Returns a lease that holds nothing when both attempts fail.
    /// </summary>
    public static Lease AcquireWithRetry()
    {
        var first = Acquire();
        if (first.Acquired) return first;
        Thread.Sleep(1000);
        return Acquire();
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
                Program.LogThrottled("pci-open", $"PCI bus mutex unavailable: {ex.Message}");
            }
            return _mutex;
        }
    }
}
