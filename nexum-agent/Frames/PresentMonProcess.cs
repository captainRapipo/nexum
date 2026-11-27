using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace NexumAgent.Frames;

/// <summary>
/// One PresentMon child of this agent (CONTRACT §1.6.2). Started suspended with an explicit application
/// name, only the listed std handles inherited, placed in the agent's kill-on-close Job Object before
/// its first instruction runs, then resumed at below-normal priority.
/// </summary>
internal sealed class PresentMonProcess : IDisposable
{
    /// <summary>Exact capture arguments (fixed excludes only; user excludes are filtered in the agent).</summary>
    public static readonly string[] CaptureArgs =
    {
        "--output_stdout", "--no_console_stats", "--session_name", PresentMonTrust.SessionName, "--stop_existing_session",
        "--qpc_time_ms", "--no_track_input", "--exclude", "dwm.exe", "--exclude", "msedgewebview2.exe",
        "--exclude", "Nexum.exe", "--exclude", "nexum-agent.exe",
    };

    /// <summary>Stops the fixed-name ETW session (also an orphan from a killed agent) and exits.</summary>
    public static readonly string[] TerminateArgs =
    {
        "--terminate_existing_session", "--session_name", PresentMonTrust.SessionName,
    };

    private static readonly object JobLock = new();
    private static IntPtr _job; // lives for the agent process: closing it (agent exit, even a hard kill) kills every child

    public int Pid { get; }
    public SafeProcessHandle Process { get; }
    /// <summary>Child stdout (CSV) / stderr, or null when the output went to NUL.</summary>
    public FileStream? Stdout { get; }
    public FileStream? Stderr { get; }
    public long StartedTick { get; } = Environment.TickCount64;

    private PresentMonProcess(int pid, SafeProcessHandle process, FileStream? stdout, FileStream? stderr)
    {
        Pid = pid;
        Process = process;
        Stdout = stdout;
        Stderr = stderr;
    }

    /// <summary>
    /// Starts the verified exe. <paramref name="trusted"/> must be an Ok trust result; its handle stays open
    /// until this returns. Throws <see cref="Win32Exception"/> on failure (nothing is left running).
    /// </summary>
    public static PresentMonProcess Start(PresentMonTrust.Result trusted, string[] args, bool captureOutput)
    {
        if (!trusted.Ok || trusted.Handle is null || trusted.Handle.IsInvalid) throw new InvalidOperationException("untrusted executable");
        string exe = trusted.Path;
        string dir = System.IO.Path.GetDirectoryName(exe) ?? throw new InvalidOperationException("no directory");
        IntPtr job = EnsureJob();

        var created = new List<IntPtr>(); // every handle this method owns; closed in finally unless handed over
        IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, nul = IntPtr.Zero;
        IntPtr attrList = IntPtr.Zero, handleArray = IntPtr.Zero, cmdLine = IntPtr.Zero;
        var pi = default(FrameNative.PROCESS_INFORMATION);
        bool processCreated = false, success = false;
        try
        {
            var sa = new FrameNative.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<FrameNative.SECURITY_ATTRIBUTES>(), bInheritHandle = true };
            nul = FrameNative.CreateFileRaw("NUL", FrameNative.GENERIC_READ | 0x40000000 /* GENERIC_WRITE */,
                FrameNative.FILE_SHARE_READ | FrameNative.FILE_SHARE_WRITE, ref sa, FrameNative.OPEN_EXISTING, 0, IntPtr.Zero);
            if (nul == FrameNative.INVALID_HANDLE_VALUE) { nul = IntPtr.Zero; throw new Win32Exception(Marshal.GetLastWin32Error()); }
            created.Add(nul);

            IntPtr childOut = nul, childErr = nul;
            if (captureOutput)
            {
                var noInherit = new FrameNative.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<FrameNative.SECURITY_ATTRIBUTES>(), bInheritHandle = false };
                if (!FrameNative.CreatePipe(out outRead, out outWrite, ref noInherit, 64 * 1024)) throw new Win32Exception(Marshal.GetLastWin32Error());
                created.Add(outRead); created.Add(outWrite);
                if (!FrameNative.CreatePipe(out errRead, out errWrite, ref noInherit, 4096)) throw new Win32Exception(Marshal.GetLastWin32Error());
                created.Add(errRead); created.Add(errWrite);
                // Only the child's ends become inheritable; the handle list below limits inheritance to them.
                if (!FrameNative.SetHandleInformation(outWrite, FrameNative.HANDLE_FLAG_INHERIT, FrameNative.HANDLE_FLAG_INHERIT) ||
                    !FrameNative.SetHandleInformation(errWrite, FrameNative.HANDLE_FLAG_INHERIT, FrameNative.HANDLE_FLAG_INHERIT))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                childOut = outWrite;
                childErr = errWrite;
            }

            var inherit = new List<IntPtr> { nul };
            if (!inherit.Contains(childOut)) inherit.Add(childOut);
            if (!inherit.Contains(childErr)) inherit.Add(childErr);

            IntPtr size = IntPtr.Zero;
            FrameNative.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attrList = Marshal.AllocHGlobal(size);
            if (!FrameNative.InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
            {
                Marshal.FreeHGlobal(attrList);
                attrList = IntPtr.Zero;
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            handleArray = Marshal.AllocHGlobal(IntPtr.Size * inherit.Count);
            for (int i = 0; i < inherit.Count; i++) Marshal.WriteIntPtr(handleArray, i * IntPtr.Size, inherit[i]);
            if (!FrameNative.UpdateProcThreadAttribute(attrList, 0, FrameNative.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleArray,
                    (IntPtr)(IntPtr.Size * inherit.Count), IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            var si = new FrameNative.STARTUPINFOEXW();
            si.StartupInfo.cb = Marshal.SizeOf<FrameNative.STARTUPINFOEXW>();
            si.StartupInfo.dwFlags = FrameNative.STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = nul;
            si.StartupInfo.hStdOutput = childOut;
            si.StartupInfo.hStdError = childErr;
            si.lpAttributeList = attrList;

            cmdLine = Marshal.StringToHGlobalUni(BuildCommandLine(exe, args)); // writable buffer, as CreateProcessW requires
            uint flags = FrameNative.CREATE_SUSPENDED | FrameNative.CREATE_NO_WINDOW | FrameNative.BELOW_NORMAL_PRIORITY_CLASS |
                         FrameNative.EXTENDED_STARTUPINFO_PRESENT | FrameNative.CREATE_UNICODE_ENVIRONMENT;
            if (!FrameNative.CreateProcess(exe, cmdLine, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, dir, ref si, out pi))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            processCreated = true;

            // Into the job before the first instruction runs; never run PresentMon outside it.
            if (!FrameNative.AssignProcessToJobObject(job, pi.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (FrameNative.ResumeThread(pi.hThread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());

            FileStream? stdout = null, stderr = null;
            if (captureOutput)
            {
                stdout = new FileStream(new SafeFileHandle(outRead, ownsHandle: true), FileAccess.Read, 1, isAsync: false);
                created.Remove(outRead);
                stderr = new FileStream(new SafeFileHandle(errRead, ownsHandle: true), FileAccess.Read, 1, isAsync: false);
                created.Remove(errRead);
            }
            var proc = new SafeProcessHandle(pi.hProcess, ownsHandle: true);
            success = true;
            return new PresentMonProcess(pi.dwProcessId, proc, stdout, stderr);
        }
        finally
        {
            if (processCreated)
            {
                if (!success)
                {
                    // Our own suspended child that could not be put in the job: it never ran.
                    FrameNative.TerminateProcess(pi.hProcess, 1);
                    FrameNative.CloseHandle(pi.hProcess);
                }
                FrameNative.CloseHandle(pi.hThread);
            }
            // Closes the parent's copies of the child-side ends (the child holds its own), plus anything left on failure.
            foreach (var h in created) FrameNative.CloseHandle(h);
            if (attrList != IntPtr.Zero)
            {
                FrameNative.DeleteProcThreadAttributeList(attrList);
                Marshal.FreeHGlobal(attrList);
            }
            if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
            if (cmdLine != IntPtr.Zero) Marshal.FreeHGlobal(cmdLine);
        }
    }

    internal static string BuildCommandLine(string exe, string[] args)
    {
        // Arguments are fixed constants without spaces or quotes; the exe path is validated quote-free.
        var sb = new System.Text.StringBuilder();
        sb.Append('"').Append(exe).Append('"');
        foreach (var a in args)
        {
            if (a.Length == 0 || a.IndexOfAny(new[] { ' ', '"', '\t' }) >= 0) throw new ArgumentException("unsafe argument");
            sb.Append(' ').Append(a);
        }
        return sb.ToString();
    }

    private static IntPtr EnsureJob()
    {
        lock (JobLock)
        {
            if (_job != IntPtr.Zero) return _job;
            IntPtr job = FrameNative.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var info = new FrameNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags =
                FrameNative.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | FrameNative.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            if (!FrameNative.SetInformationJobObject(job, FrameNative.JobObjectExtendedLimitInformation, ref info,
                    Marshal.SizeOf<FrameNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
            {
                int err = Marshal.GetLastWin32Error();
                FrameNative.CloseHandle(job);
                throw new Win32Exception(err);
            }
            _job = job; // intentionally never closed: the OS closes it when the agent exits
            return job;
        }
    }

    /// <summary>Kills every PresentMon process of this agent (capture and terminate calls).</summary>
    public static void TerminateAll()
    {
        lock (JobLock)
        {
            if (_job != IntPtr.Zero) FrameNative.TerminateJobObject(_job, 1);
        }
    }

    /// <summary>True when the process exited within <paramref name="ms"/>.</summary>
    public bool WaitForExit(int ms)
    {
        if (Process.IsClosed || Process.IsInvalid) return true;
        return FrameNative.WaitForSingleObject(Process, (uint)Math.Max(0, ms)) == FrameNative.WAIT_OBJECT_0;
    }

    public bool HasExited => WaitForExit(0);

    public uint? ExitCode
    {
        get
        {
            if (Process.IsClosed || Process.IsInvalid) return null;
            if (!FrameNative.GetExitCodeProcess(Process, out uint code)) return null;
            return code == FrameNative.STILL_ACTIVE && !HasExited ? null : code;
        }
    }

    public void Dispose()
    {
        try { Stdout?.Dispose(); } catch { /* ignore */ }
        try { Stderr?.Dispose(); } catch { /* ignore */ }
        Process.Dispose();
    }
}
