namespace NexumAgent.Frames;

/// <summary>
/// Removes an orphaned <c>NexumFrames</c> ETW session without starting a process (CONTRACT §1.6.6).
/// <para>
/// The PresentMon terminate call is the normal way to end the session. It cannot run when the agent was hard-killed
/// (the next agent starts with frame capture off), or when the exe fails its trust check at stop time. Either way
/// the real-time session would otherwise keep its kernel buffers until reboot. This stops the session by its fixed
/// name with <c>ControlTraceW(EVENT_TRACE_CONTROL_STOP)</c>; it never stops a session with any other name and never
/// starts one. Needs administrator rights; callers only use it when elevated.
/// </para>
/// </summary>
internal static class EtwSession
{
    private const int NameChars = 1024;

    /// <summary>A zeroed EVENT_TRACE_PROPERTIES buffer with room for the logger and log file names (pure; self-tested).</summary>
    internal static byte[] BuildProperties()
    {
        int size = FrameNative.EventTracePropertiesSize + 2 * NameChars * sizeof(char);
        var buf = new byte[size];
        BitConverter.TryWriteBytes(buf.AsSpan(0, 4), (uint)size); // Wnode.BufferSize
        BitConverter.TryWriteBytes(buf.AsSpan(FrameNative.EtpLoggerNameOffsetAt, 4), (uint)FrameNative.EventTracePropertiesSize);
        BitConverter.TryWriteBytes(buf.AsSpan(FrameNative.EtpLogFileNameOffsetAt, 4),
            (uint)(FrameNative.EventTracePropertiesSize + NameChars * sizeof(char)));
        return buf;
    }

    /// <summary>
    /// Stops the fixed-name session if it exists. Returns true when a session was stopped, false when there was
    /// none or it could not be stopped (logged). Never throws.
    /// </summary>
    public static bool StopIfPresent(Action<string> log, string reason)
    {
        try
        {
            uint rc = FrameNative.ControlTrace(0, PresentMonTrust.SessionName, BuildProperties(), FrameNative.EVENT_TRACE_CONTROL_STOP);
            if (rc == 0)
            {
                log($"Stopped a leftover ETW session {PresentMonTrust.SessionName} ({reason})");
                return true;
            }
            if (rc != FrameNative.ERROR_WMI_INSTANCE_NOT_FOUND)
            {
                log($"Could not stop ETW session {PresentMonTrust.SessionName} ({reason}): win32 {rc}");
            }
            return false;
        }
        catch (Exception ex)
        {
            log($"Could not stop ETW session {PresentMonTrust.SessionName} ({reason}): {ex.Message}");
            return false;
        }
    }
}
