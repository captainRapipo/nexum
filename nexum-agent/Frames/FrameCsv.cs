using System.Globalization;
using System.Text;

namespace NexumAgent.Frames;

/// <summary>One valid frame (CONTRACT §1.6.3). NaN = null / NA. A ring slot; no references.</summary>
internal struct FrameRow
{
    public int Pid;
    /// <summary>CPU start in ms on the QPC clock (same clock as <see cref="FrameClock.NowMs"/>).</summary>
    public double CpuStartMs;
    public double FrameTimeMs;
    public float CpuBusyMs;
    public float GpuBusyMs;
    /// <summary>Displayed time; NaN = not displayed ("NA") or column missing.</summary>
    public float DisplayedMs;
    public float DisplayLatencyMs;
    public ulong SwapChain;
    public long Seq;
    /// <summary>short.MinValue = null.</summary>
    public short SyncInterval;
    /// <summary>-1 = null, 0 = false, 1 = true.</summary>
    public sbyte AllowsTearing;
    /// <summary>Indexes into <see cref="FrameCsv.Strings"/>.</summary>
    public byte PresentModeIdx;
    public byte RuntimeIdx;
}

internal static class FrameClock
{
    private static readonly double MsPerTick = 1000.0 / System.Diagnostics.Stopwatch.Frequency;

    /// <summary>QPC in ms, the clock of PresentMon's --qpc_time_ms column.</summary>
    public static double NowMs() => System.Diagnostics.Stopwatch.GetTimestamp() * MsPerTick;
}

/// <summary>
/// Column resolution by header name (never by position) and allocation-free row parsing.
/// The real PresentMon 2.6.0 header (captured 2026-11-27 with the exact §1.6.2 arguments) is
/// Frames/HEADER-2.6.0.txt; names it uses that differ from the README are tried first.
/// </summary>
internal sealed class FrameCsv
{
    // Alias lists, tried in order (first present wins). The 2.6.0 names come first.
    public static readonly string[] ProcessNames = { "Application" };
    public static readonly string[] PidNames = { "ProcessID" };
    public static readonly string[] SwapChainNames = { "SwapChainAddress" };
    public static readonly string[] RuntimeNames = { "PresentRuntime" };
    public static readonly string[] SyncIntervalNames = { "SyncInterval" };
    public static readonly string[] AllowsTearingNames = { "AllowsTearing" };
    public static readonly string[] PresentModeNames = { "PresentMode" };
    /// <summary>2.6.0 writes CPUStartQPCTimeInMs for --qpc_time_ms.</summary>
    public static readonly string[] CpuStartNames = { "CPUStartQPCTimeInMs", "CPUStartQPCTime" };
    public static readonly string[] FrameTimeNames = { "MsBetweenAppStart", "FrameTime", "MsBetweenPresents" };
    public static readonly string[] CpuBusyNames = { "MsCPUBusy", "CPUBusy" };
    public static readonly string[] GpuBusyNames = { "MsGPUBusy", "GPUBusy" };
    /// <summary>2.6.0 default metrics: MsBetweenDisplayChange (NA when the frame was not displayed).</summary>
    public static readonly string[] DisplayedNames = { "MsBetweenDisplayChange", "DisplayedTime", "MsDisplayedTime" };
    /// <summary>2.6.0 default metrics: MsUntilDisplayed (Present() call to display; NA when not displayed).</summary>
    public static readonly string[] DisplayLatencyNames = { "MsUntilDisplayed", "DisplayLatency", "MsDisplayLatency" };

    public const int MaxColumns = 256;

    public int ColProcess = -1, ColPid = -1, ColSwapChain = -1, ColRuntime = -1, ColSyncInterval = -1, ColAllowsTearing = -1,
        ColPresentMode = -1, ColCpuStart = -1, ColFrameTime = -1, ColCpuBusy = -1, ColGpuBusy = -1, ColDisplayed = -1,
        ColDisplayLatency = -1;
    public int ColumnCount;

    /// <summary>Distinct present-mode / runtime strings (index 0 = "Unknown", 1 = "Other").</summary>
    public readonly List<string> Strings = new() { "Unknown", "Other" };
    public const byte UnknownIdx = 0;
    public const byte OtherIdx = 1;

    private readonly int[] _starts = new int[MaxColumns];
    private readonly int[] _lengths = new int[MaxColumns];

    public bool HasDisplay => ColDisplayed >= 0;
    public bool HasDisplayLatency => ColDisplayLatency >= 0;
    public bool HasCpuBusy => ColCpuBusy >= 0;
    public bool HasGpuBusy => ColGpuBusy >= 0;

    /// <summary>
    /// Resolves the header. Returns null on success, else the name of the first missing fatal column
    /// (the first alias of its list, for the error message).
    /// </summary>
    public string? ResolveHeader(ReadOnlySpan<char> header)
    {
        header = header.TrimStart('﻿').Trim();
        var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        int count = Split(header);
        ColumnCount = count;
        for (int i = 0; i < count; i++)
        {
            var name = header.Slice(_starts[i], _lengths[i]).Trim().ToString();
            if (name.Length > 0) map.TryAdd(name, i);
        }

        ColProcess = Find(map, ProcessNames);
        ColPid = Find(map, PidNames);
        ColSwapChain = Find(map, SwapChainNames);
        ColRuntime = Find(map, RuntimeNames);
        ColSyncInterval = Find(map, SyncIntervalNames);
        ColAllowsTearing = Find(map, AllowsTearingNames);
        ColPresentMode = Find(map, PresentModeNames);
        ColCpuStart = Find(map, CpuStartNames);
        ColFrameTime = Find(map, FrameTimeNames);
        ColCpuBusy = Find(map, CpuBusyNames);
        ColGpuBusy = Find(map, GpuBusyNames);
        ColDisplayed = Find(map, DisplayedNames);
        ColDisplayLatency = Find(map, DisplayLatencyNames);

        if (count < 2 || count >= MaxColumns) return ProcessNames[0];
        if (ColProcess < 0) return ProcessNames[0];
        if (ColPid < 0) return PidNames[0];
        if (ColFrameTime < 0) return FrameTimeNames[0];
        return null;
    }

    private static int Find(Dictionary<string, int> map, string[] names)
    {
        foreach (var n in names)
        {
            if (map.TryGetValue(n, out int idx)) return idx;
        }
        return -1;
    }

    /// <summary>Splits on commas into the reusable start/length arrays. Returns the field count (MaxColumns = too many).</summary>
    private int Split(ReadOnlySpan<char> line)
    {
        int count = 0, start = 0;
        for (int i = 0; i <= line.Length; i++)
        {
            if (i == line.Length || line[i] == ',')
            {
                if (count >= MaxColumns) return MaxColumns;
                _starts[count] = start;
                _lengths[count] = i - start;
                count++;
                start = i + 1;
            }
        }
        return count;
    }

    private ReadOnlySpan<char> Field(ReadOnlySpan<char> line, int col) =>
        col < 0 ? ReadOnlySpan<char>.Empty : line.Slice(_starts[col], _lengths[col]).Trim();

    /// <summary>
    /// Parses one data row. Returns false for anything that is not a valid frame (wrong field count,
    /// pid ≤ 0, frametime not finite in (0, 5000] ms). <paramref name="process"/> is the Application
    /// field as a span into <paramref name="line"/> (no allocation).
    /// </summary>
    public bool TryParseRow(ReadOnlySpan<char> line, double receiptMs, out FrameRow row, out ReadOnlySpan<char> process)
    {
        row = default;
        process = default;
        if (ColumnCount == 0) return false;
        line = line.TrimEnd('\r');
        if (line.IsEmpty) return false;
        if (Split(line) != ColumnCount) return false;

        if (!int.TryParse(Field(line, ColPid), NumberStyles.Integer, CultureInfo.InvariantCulture, out int pid) || pid <= 0) return false;
        double ft = Num(Field(line, ColFrameTime));
        if (!double.IsFinite(ft) || ft <= 0 || ft > 5000) return false;
        process = Field(line, ColProcess);
        if (process.IsEmpty) return false;

        double cpuStart = ColCpuStart >= 0 ? Num(Field(line, ColCpuStart)) : double.NaN;
        row.Pid = pid;
        row.CpuStartMs = double.IsFinite(cpuStart) ? cpuStart : receiptMs;
        row.FrameTimeMs = ft;
        row.CpuBusyMs = (float)Num(Field(line, ColCpuBusy));
        row.GpuBusyMs = (float)Num(Field(line, ColGpuBusy));
        row.DisplayedMs = (float)Num(Field(line, ColDisplayed));
        row.DisplayLatencyMs = (float)Num(Field(line, ColDisplayLatency));
        row.SwapChain = ParseSwapChain(Field(line, ColSwapChain));
        row.SyncInterval = int.TryParse(Field(line, ColSyncInterval), NumberStyles.Integer, CultureInfo.InvariantCulture, out int si)
                           && si >= short.MinValue + 1 && si <= short.MaxValue ? (short)si : short.MinValue;
        var tear = Field(line, ColAllowsTearing);
        row.AllowsTearing = tear.SequenceEqual("1") ? (sbyte)1 : tear.SequenceEqual("0") ? (sbyte)0 : (sbyte)-1;
        row.PresentModeIdx = ColPresentMode >= 0 ? Intern(Field(line, ColPresentMode), UnknownIdx) : UnknownIdx;
        row.RuntimeIdx = ColRuntime >= 0 ? Intern(Field(line, ColRuntime), OtherIdx) : OtherIdx;
        return true;
    }

    private static double Num(ReadOnlySpan<char> s)
    {
        if (s.IsEmpty) return double.NaN;
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) && double.IsFinite(v) ? v : double.NaN;
    }

    private static ulong ParseSwapChain(ReadOnlySpan<char> s)
    {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s[2..];
        return ulong.TryParse(s, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out ulong v) ? v : 0;
    }

    /// <summary>Small intern table for present modes / runtimes (allocates only for a new distinct value).</summary>
    private byte Intern(ReadOnlySpan<char> value, byte fallback)
    {
        if (value.IsEmpty || value.SequenceEqual("NA")) return fallback;
        for (int i = 0; i < Strings.Count; i++)
        {
            if (value.SequenceEqual(Strings[i])) return (byte)i;
        }
        if (Strings.Count >= 255 || value.Length > 64) return fallback;
        Strings.Add(value.ToString());
        return (byte)(Strings.Count - 1);
    }

    public string StringAt(byte idx) => idx < Strings.Count ? Strings[idx] : "Unknown";
}

/// <summary>
/// Turns a child's byte stream into lines without a per-line string. PresentMon 2.6.0 writes UTF-16LE
/// with a BOM and CRLF to a redirected stdout/stderr (observed); UTF-8 (with/without BOM) is accepted too.
/// </summary>
internal sealed class LineDecoder
{
    private const int MaxLineChars = 16 * 1024;
    private readonly Stream _stream;
    private readonly byte[] _bytes = new byte[16 * 1024];
    private char[] _chars = new char[32 * 1024];
    private int _charCount;
    private Decoder? _decoder;
    private bool _discarding;

    public LineDecoder(Stream stream) => _stream = stream;

    /// <summary>Encoding chosen from the first bytes; null before the first read.</summary>
    public Encoding? Encoding { get; private set; }

    /// <summary>
    /// Reads the stream to EOF, invoking <paramref name="onChunk"/> once per read with every complete line
    /// of that read (call <paramref name="onLine"/> through the provided callback inside it), so the caller
    /// can take a lock once per chunk.
    /// </summary>
    public void Run(Action<LineBatch> onChunk)
    {
        var batch = new LineBatch(this);
        int pendingBytes = 0;
        while (true)
        {
            int read;
            try { read = _stream.Read(_bytes, pendingBytes, _bytes.Length - pendingBytes); }
            catch (IOException) { read = 0; } // broken pipe = child exited
            catch (ObjectDisposedException) { read = 0; }

            if (_decoder is null)
            {
                int have = pendingBytes + read;
                if (read > 0 && have < 3)
                {
                    pendingBytes = have; // need a few bytes to sniff the encoding
                    continue;
                }
                if (have == 0) return;
                int skip = Sniff(_bytes, have);
                Decode(_bytes, skip, have - skip, flush: read == 0);
                pendingBytes = 0;
            }
            else if (read > 0)
            {
                Decode(_bytes, 0, read, flush: false);
            }
            else
            {
                Decode(_bytes, 0, 0, flush: true);
            }

            batch.Reset(read == 0);
            onChunk(batch);
            if (read == 0) return;
        }
    }

    private int Sniff(byte[] b, int n)
    {
        int skip = 0;
        if (n >= 2 && b[0] == 0xFF && b[1] == 0xFE) { Encoding = new UnicodeEncoding(false, false); skip = 2; }
        else if (n >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) { Encoding = new UTF8Encoding(false); skip = 3; }
        else if (n >= 2 && b[1] == 0 && b[0] != 0) { Encoding = new UnicodeEncoding(false, false); }
        else { Encoding = new UTF8Encoding(false); }
        _decoder = Encoding.GetDecoder();
        return skip;
    }

    private void Decode(byte[] bytes, int offset, int count, bool flush)
    {
        int needed = _decoder!.GetCharCount(bytes, offset, count, flush);
        if (_charCount + needed > _chars.Length)
        {
            Array.Resize(ref _chars, Math.Max(_chars.Length * 2, _charCount + needed));
        }
        _charCount += _decoder.GetChars(bytes, offset, count, _chars, _charCount, flush);
    }

    /// <summary>Complete lines decoded by the last read.</summary>
    internal sealed class LineBatch
    {
        private readonly LineDecoder _owner;
        private bool _final;

        public LineBatch(LineDecoder owner) => _owner = owner;

        internal void Reset(bool final) => _final = final;

        /// <summary>Calls <paramref name="onLine"/> for every complete line (CR/LF stripped).</summary>
        public void ForEach(LineHandler onLine)
        {
            var o = _owner;
            int start = 0;
            for (int i = 0; i < o._charCount; i++)
            {
                if (o._chars[i] != '\n') continue;
                Emit(o, onLine, start, i - start);
                start = i + 1;
            }
            int rest = o._charCount - start;
            if (_final && rest > 0)
            {
                Emit(o, onLine, start, rest);
                rest = 0;
                start = o._charCount;
            }
            else if (rest > MaxLineChars)
            {
                o._discarding = true; // runaway line: drop it up to the next newline
                rest = 0;
                start = o._charCount;
            }
            if (rest > 0 && start > 0) Array.Copy(o._chars, start, o._chars, 0, rest);
            o._charCount = rest;
        }

        private static void Emit(LineDecoder o, LineHandler onLine, int start, int length)
        {
            if (o._discarding)
            {
                o._discarding = false;
                return;
            }
            var span = new ReadOnlySpan<char>(o._chars, start, length).TrimEnd('\r');
            onLine(span);
        }
    }
}

internal delegate void LineHandler(ReadOnlySpan<char> line);
