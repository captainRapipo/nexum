using System.ComponentModel;
using System.Runtime.InteropServices;

namespace NexumAgent;

/// <summary>
/// Purges the RAM standby list (what RAMMap "Empty Standby List" does):
/// enable SeProfileSingleProcessPrivilege, then
/// NtSetSystemInformation(SystemMemoryListInformation, MemoryPurgeStandbyList).
/// </summary>
internal static class MemoryFlush
{
    private const int SystemMemoryListInformation = 0x50;
    private const int MemoryPurgeStandbyList = 4;

    private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    private const int ERROR_NOT_ALL_ASSIGNED = 1300;
    private const string SE_PROF_SINGLE_PROCESS_NAME = "SeProfileSingleProcessPrivilege";

    private const int STATUS_PRIVILEGE_NOT_HELD = unchecked((int)0xC0000061);
    private const int STATUS_ACCESS_DENIED = unchecked((int)0xC0000022);

    private static readonly object Gate = new();

    public static (bool Ok, string Message) FlushStandby()
    {
        lock (Gate)
        {
            try
            {
                return FlushCore();
            }
            catch (Exception ex)
            {
                Program.Log($"flushStandby failed: {ex}");
                return (false, $"Standby flush failed: {ex.Message}");
            }
        }
    }

    private static (bool Ok, string Message) FlushCore()
    {
        if (!Program.IsAdmin)
        {
            return (false, "Administrator rights are required to flush the standby list");
        }

        if (!TryEnablePrivilege(SE_PROF_SINGLE_PROCESS_NAME, out var privError))
        {
            return (false, $"Could not enable {SE_PROF_SINGLE_PROCESS_NAME}: {privError}");
        }

        var listBefore = TryQueryMemoryLists();
        var availBefore = AvailablePhysicalBytes();

        int command = MemoryPurgeStandbyList;
        int status = NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
        if (status != 0)
        {
            string reason = status switch
            {
                STATUS_PRIVILEGE_NOT_HELD => "privilege not held",
                STATUS_ACCESS_DENIED => "access denied",
                _ => "kernel refused the request",
            };
            return (false, $"Standby flush failed: NTSTATUS 0x{status:X8} ({reason})");
        }

        var listAfter = TryQueryMemoryLists();
        var availAfter = AvailablePhysicalBytes();

        // "Available" in Windows already counts standby pages, so its delta is ~0 after a purge.
        // The meaningful figure is how much standby (cached) memory became truly free:
        // the drop in standby pages (preferred) or the rise in free+zero pages.
        long freedBytes;
        if (listBefore.HasValue && listAfter.HasValue)
        {
            long standbyDrop = listBefore.Value.StandbyBytes - listAfter.Value.StandbyBytes;
            long freeRise = listAfter.Value.FreeBytes - listBefore.Value.FreeBytes;
            freedBytes = Math.Max(0, Math.Max(standbyDrop, freeRise));
        }
        else
        {
            freedBytes = Math.Max(0, availAfter - availBefore);
        }

        long mb = freedBytes / (1024L * 1024L);
        Program.Log($"Standby list purged: {mb} MB (avail {availBefore / 1048576} -> {availAfter / 1048576} MB)");
        return (true, $"Freed {mb} MB");
    }

    // ---------------------------------------------------------------------------------------------
    // Privilege handling

    private static bool TryEnablePrivilege(string privilege, out string error)
    {
        error = "";
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token))
            {
                error = new Win32Exception(Marshal.GetLastPInvokeError()).Message;
                return false;
            }

            if (!LookupPrivilegeValue(null, privilege, out var luid))
            {
                error = new Win32Exception(Marshal.GetLastPInvokeError()).Message;
                return false;
            }

            var tp = new TOKEN_PRIVILEGES
            {
                PrivilegeCount = 1,
                Privileges = new LUID_AND_ATTRIBUTES { Luid = luid, Attributes = SE_PRIVILEGE_ENABLED },
            };

            if (!AdjustTokenPrivileges(token, false, ref tp, (uint)Marshal.SizeOf<TOKEN_PRIVILEGES>(), IntPtr.Zero, IntPtr.Zero))
            {
                error = new Win32Exception(Marshal.GetLastPInvokeError()).Message;
                return false;
            }

            // AdjustTokenPrivileges succeeds even when the token lacks the privilege.
            int last = Marshal.GetLastPInvokeError();
            if (last == ERROR_NOT_ALL_ASSIGNED)
            {
                error = "the process token does not hold this privilege (not elevated?)";
                return false;
            }
            return true;
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Measurement

    private readonly record struct MemoryLists(long StandbyBytes, long FreeBytes);

    /// <summary>
    /// SYSTEM_MEMORY_LIST_INFORMATION (all ULONG_PTR):
    /// ZeroPageCount, FreePageCount, ModifiedPageCount, ModifiedNoWritePageCount, BadPageCount,
    /// PageCountByPriority[8], RepurposedPagesByPriority[8], ModifiedPageCountPageFile.
    /// </summary>
    private static MemoryLists? TryQueryMemoryLists()
    {
        int ptr = IntPtr.Size;
        int fields = 5 + 8 + 8 + 1;
        int size = fields * ptr;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.Copy(new byte[size], 0, buf, size);
            int status = NtQuerySystemInformation(SystemMemoryListInformation, buf, size, out _);
            if (status != 0) return null;

            long Read(int index) => ptr == 8
                ? Marshal.ReadInt64(buf, index * 8)
                : (long)(uint)Marshal.ReadInt32(buf, index * 4);

            long zero = Read(0);
            long free = Read(1);
            long standbyPages = 0;
            for (int i = 0; i < 8; i++) standbyPages += Read(5 + i);

            long page = Environment.SystemPageSize;
            return new MemoryLists(standbyPages * page, (zero + free) * page);
        }
        catch (Exception ex)
        {
            Program.Log($"NtQuerySystemInformation(SystemMemoryListInformation) failed: {ex.Message}");
            return null;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

    public static long AvailablePhysicalBytes()
    {
        var ms = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        return GlobalMemoryStatusEx(ref ms) ? (long)ms.ullAvailPhys : 0;
    }

    /// <summary>Total/available physical memory in bytes, or null on failure.</summary>
    public static (ulong Total, ulong Available, uint LoadPct)? QueryMemoryStatus()
    {
        var ms = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (!GlobalMemoryStatusEx(ref ms)) return null;
        return (ms.ullTotalPhys, ms.ullAvailPhys, ms.dwMemoryLoad);
    }

    // ---------------------------------------------------------------------------------------------
    // Interop

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES
    {
        public uint PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges; // ANYSIZE_ARRAY = 1
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "LookupPrivilegeValueW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string? lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TOKEN_PRIVILEGES newState,
        uint bufferLength,
        IntPtr previousState,
        IntPtr returnLength);

    [DllImport("ntdll.dll")]
    private static extern int NtSetSystemInformation(int systemInformationClass, ref int systemInformation, int systemInformationLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int systemInformationClass, IntPtr systemInformation, int systemInformationLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}
