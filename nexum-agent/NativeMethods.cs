using System.Runtime.InteropServices;

namespace NexumAgent;

/// <summary>Small Win32 helpers (read-only queries only).</summary>
internal static class NativeMethods
{
    /// <summary>Total/available physical memory in bytes, or null on failure.</summary>
    public static (ulong Total, ulong Available, uint LoadPct)? QueryMemoryStatus()
    {
        var ms = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        if (!GlobalMemoryStatusEx(ref ms)) return null;
        return (ms.ullTotalPhys, ms.ullAvailPhys, ms.dwMemoryLoad);
    }

    /// <summary>One CACHE_RELATIONSHIP record from GetLogicalProcessorInformationEx(RelationCache).</summary>
    internal readonly record struct CacheInfo(int Level, int Associativity, int LineSize, long SizeBytes, int Type);

    private const int RelationCache = 2;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;

    /// <summary>
    /// Enumerates every cache record (one per cache instance) via GetLogicalProcessorInformationEx.
    /// Layout of SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX: DWORD Relationship, DWORD Size, then
    /// CACHE_RELATIONSHIP { BYTE Level; BYTE Associativity; WORD LineSize; DWORD CacheSize; PROCESSOR_CACHE_TYPE Type; ... }.
    /// </summary>
    public static List<CacheInfo> QueryCaches()
    {
        var result = new List<CacheInfo>();
        uint length = 0;
        if (GetLogicalProcessorInformationEx(RelationCache, IntPtr.Zero, ref length))
        {
            return result; // nothing to report
        }
        int err = Marshal.GetLastWin32Error();
        if (err != ERROR_INSUFFICIENT_BUFFER || length == 0)
        {
            throw new System.ComponentModel.Win32Exception(err);
        }

        IntPtr buffer = Marshal.AllocHGlobal((int)length);
        try
        {
            if (!GetLogicalProcessorInformationEx(RelationCache, buffer, ref length))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            int offset = 0;
            while (offset + 24 <= length)
            {
                IntPtr p = buffer + offset;
                int relationship = Marshal.ReadInt32(p, 0);
                int size = Marshal.ReadInt32(p, 4);
                if (size <= 0) break;
                if (relationship == RelationCache && size >= 24)
                {
                    int level = Marshal.ReadByte(p, 8);
                    int assoc = Marshal.ReadByte(p, 9);
                    int line = (ushort)Marshal.ReadInt16(p, 10);
                    long cacheSize = (uint)Marshal.ReadInt32(p, 12);
                    int type = Marshal.ReadInt32(p, 16);
                    result.Add(new CacheInfo(level, assoc, line, cacheSize, type));
                }
                offset += size;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return result;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLogicalProcessorInformationEx(int relationshipType, IntPtr buffer, ref uint returnedLength);
}
