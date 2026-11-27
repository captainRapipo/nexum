using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace NexumAgent.Frames;

/// <summary>
/// Window-manager and process-list queries for target selection (CONTRACT §1.6.4). Anti-cheat stance:
/// no process handles, no messages, nothing injected; only GetForegroundWindow / GetWindowThreadProcessId,
/// EnumWindows + GetWindowTextW and a Toolhelp32 name/id snapshot.
/// </summary>
internal static class ForegroundTracker
{
    private const int MaxTitleChars = 120;

    /// <summary>PID owning the foreground window, or null.</summary>
    public static int? ForegroundPid()
    {
        try
        {
            IntPtr hwnd = FrameNative.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            if (FrameNative.GetWindowThreadProcessId(hwnd, out uint pid) == 0 || pid == 0) return null;
            return (int)pid;
        }
        catch
        {
            return null;
        }
    }

    private static readonly object EnumLock = new();
    private static HashSet<int>? _wanted;
    private static Dictionary<int, string>? _found;
    private static readonly char[] TitleBuffer = new char[MaxTitleChars + 2];
    // Kept in a static field so the callback cannot be collected while EnumWindows runs.
    private static readonly FrameNative.EnumWindowsProc Callback = OnWindow;

    /// <summary>
    /// Title of the first visible, unowned top-level window with a non-empty caption for each wanted pid
    /// (≤ 120 chars). Pids without one are absent from the result.
    /// </summary>
    public static Dictionary<int, string> WindowTitles(IEnumerable<int> pids)
    {
        var result = new Dictionary<int, string>();
        var wanted = new HashSet<int>(pids);
        if (wanted.Count == 0) return result;
        lock (EnumLock)
        {
            _wanted = wanted;
            _found = result;
            try { FrameNative.EnumWindows(Callback, IntPtr.Zero); }
            catch { /* best effort */ }
            finally
            {
                _wanted = null;
                _found = null;
            }
        }
        return result;
    }

    public static string? WindowTitle(int pid) => WindowTitles(new[] { pid }).TryGetValue(pid, out var t) ? t : null;

    private static bool OnWindow(IntPtr hwnd, IntPtr lParam)
    {
        var wanted = _wanted;
        var found = _found;
        if (wanted is null || found is null) return false;
        if (FrameNative.GetWindowThreadProcessId(hwnd, out uint pid) == 0) return true;
        int p = (int)pid;
        if (!wanted.Contains(p) || found.ContainsKey(p)) return true;
        if (!FrameNative.IsWindowVisible(hwnd) || FrameNative.GetWindow(hwnd, FrameNative.GW_OWNER) != IntPtr.Zero) return true;
        int len = FrameNative.GetWindowText(hwnd, TitleBuffer, TitleBuffer.Length);
        if (len <= 0) return true;
        var title = new string(TitleBuffer, 0, Math.Min(len, MaxTitleChars)).Trim();
        if (title.Length > 0) found[p] = title;
        return found.Count < wanted.Count;
    }

    /// <summary>True when a Toolhelp32 snapshot lists the pid; true on snapshot failure (do not clear on an error).</summary>
    public static bool ProcessExists(int pid)
    {
        IntPtr snap = FrameNative.CreateToolhelp32Snapshot(FrameNative.TH32CS_SNAPPROCESS, 0);
        if (snap == FrameNative.INVALID_HANDLE_VALUE || snap == IntPtr.Zero) return true;
        try
        {
            var entry = new FrameNative.PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<FrameNative.PROCESSENTRY32W>() };
            if (!FrameNative.Process32First(snap, ref entry)) return true;
            do
            {
                if (entry.th32ProcessID == (uint)pid) return true;
            }
            while (FrameNative.Process32Next(snap, ref entry));
            return false;
        }
        finally
        {
            FrameNative.CloseHandle(snap);
        }
    }
}

/// <summary>User exclude list rules, identical to Rust's set_frame_excludes (CONTRACT §2.13).</summary>
internal static class FrameExcludes
{
    public static readonly string[] Fixed = { "dwm.exe", "msedgewebview2.exe", "Nexum.exe", "nexum-agent.exe" };
    public const int Max = 50;

    private static readonly Regex Pattern = new(@"^[A-Za-z0-9 _.()\-]{1,60}\.exe$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    /// <summary>Trim; keep pattern matches; drop fixed excludes; dedupe case-insensitively keeping the first; max 50.</summary>
    public static List<string> Sanitize(IEnumerable<string?> names)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in names)
        {
            if (raw is null) continue;
            var n = raw.Trim();
            if (!IsValid(n)) continue;
            if (Fixed.Any(f => string.Equals(f, n, StringComparison.OrdinalIgnoreCase))) continue;
            if (!seen.Add(n)) continue;
            result.Add(n);
            if (result.Count >= Max) break;
        }
        return result;
    }

    public static bool IsValid(string n)
    {
        try { return Pattern.IsMatch(n); }
        catch (RegexMatchTimeoutException) { return false; }
    }
}
