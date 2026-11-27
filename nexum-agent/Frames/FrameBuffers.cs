namespace NexumAgent.Frames;

/// <summary>Per-process ring of valid frames (CONTRACT §1.6.4). Grows by doubling up to a cap, then overwrites the oldest.</summary>
internal sealed class PidTrack
{
    private const int InitialCapacity = 256;
    /// <summary>~4 min at 1000 fps; beyond it the oldest frame is overwritten (time pruning normally keeps it far smaller).</summary>
    internal const int MaxCapacity = 1 << 18;

    public int Pid { get; }
    public string Name { get; private set; }
    public double LastReceiptMs;
    public ulong Primary;
    public bool HasPrimary;

    private FrameRow[] _buf = new FrameRow[InitialCapacity];
    private int _head;
    public int Count { get; private set; }

    public PidTrack(int pid, string name)
    {
        Pid = pid;
        Name = name;
    }

    public void Reset(string name)
    {
        Name = name;
        _head = 0;
        Count = 0;
        HasPrimary = false;
    }

    public ref FrameRow this[int i] => ref _buf[(_head + i) & (_buf.Length - 1)];

    public void Append(in FrameRow row)
    {
        if (Count == _buf.Length)
        {
            if (_buf.Length < MaxCapacity)
            {
                var bigger = new FrameRow[_buf.Length * 2];
                for (int i = 0; i < Count; i++) bigger[i] = this[i];
                _buf = bigger;
                _head = 0;
            }
            else
            {
                _head = (_head + 1) & (_buf.Length - 1);
                Count--;
            }
        }
        _buf[(_head + Count) & (_buf.Length - 1)] = row;
        Count++;
        if (!HasPrimary)
        {
            Primary = row.SwapChain;
            HasPrimary = true;
        }
    }

    /// <summary>Drops frames older than <paramref name="cutoffMs"/> from the oldest end.</summary>
    public void PruneBefore(double cutoffMs)
    {
        while (Count > 0 && _buf[_head].CpuStartMs < cutoffMs)
        {
            _head = (_head + 1) & (_buf.Length - 1);
            Count--;
        }
    }

    /// <summary>Newest frame of the primary swap chain, or null.</summary>
    public FrameRow? NewestPrimary()
    {
        for (int i = Count - 1; i >= 0; i--)
        {
            ref var f = ref this[i];
            if (!HasPrimary || f.SwapChain == Primary) return f;
        }
        return null;
    }
}

/// <summary>
/// Frame data of the running capture: header columns, filtering, per-pid buffers, the primary swap chain
/// rule, window extraction and the frametime batch (CONTRACT §1.6.3–§1.6.5). Not thread-safe: the owner
/// (FrameMonitor) serializes access. Clock values are passed in (QPC ms) so the self-test can drive it.
/// </summary>
internal sealed class FrameBuffers
{
    public const double PresentingMs = 2000;
    public const double TargetKeepMs = 5000;
    public const double EvictMs = 10000;
    public const int FrametimeBatchMax = 1000;
    /// <summary>
    /// Upper bound on buffered processes. Each ring may grow to <see cref="PidTrack.MaxCapacity"/> rows (16 MiB), so
    /// many presenting processes (hostile or not) could otherwise grow the elevated agent without limit. A new
    /// process beyond the cap is ignored until silent ones are evicted (10 s).
    /// </summary>
    public const int MaxTracks = 64;

    public FrameCsv Csv { get; } = new();
    public bool HeaderParsed { get; private set; }
    public Dictionary<int, PidTrack> Tracks { get; } = new();
    private readonly List<string> _userExcludes = new();
    private long _seq;
    private long _lastEmitSeq;
    private FrameRow[] _window = new FrameRow[1024];
    private double[] _scratch = new double[1024];
    private readonly Dictionary<ulong, int> _swapCounts = new();
    private readonly List<int> _evict = new();

    public IReadOnlyList<string> UserExcludes => _userExcludes;

    /// <summary>A new child starts: its first line must be a header again.</summary>
    public void ExpectHeader()
    {
        HeaderParsed = false;
        Csv.ColumnCount = 0;
    }

    /// <summary>Returns null when the header is usable, else the missing fatal column name.</summary>
    public string? AcceptHeader(ReadOnlySpan<char> header)
    {
        var missing = Csv.ResolveHeader(header);
        HeaderParsed = missing is null;
        if (missing is not null) Csv.ColumnCount = 0;
        return missing;
    }

    /// <summary>Buffers one data row. Returns true when it was a valid, non-excluded frame.</summary>
    public bool Ingest(ReadOnlySpan<char> line, double nowMs)
    {
        if (!HeaderParsed) return false;
        if (!Csv.TryParseRow(line, nowMs, out var row, out var process)) return false;
        if (IsExcluded(process)) return false;

        if (!Tracks.TryGetValue(row.Pid, out var track))
        {
            if (Tracks.Count >= MaxTracks) return false;
            track = new PidTrack(row.Pid, process.ToString());
            Tracks[row.Pid] = track;
        }
        else if (!process.Equals(track.Name, StringComparison.Ordinal))
        {
            track.Reset(process.ToString()); // pid reused by another program
        }
        row.Seq = ++_seq;
        track.Append(row);
        track.LastReceiptMs = nowMs;
        return true;
    }

    public bool IsExcluded(ReadOnlySpan<char> process)
    {
        foreach (var f in FrameExcludes.Fixed)
        {
            if (process.Equals(f, StringComparison.OrdinalIgnoreCase)) return true;
        }
        foreach (var u in _userExcludes)
        {
            if (process.Equals(u, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    /// <summary>Replaces the user excludes (already sanitized) and drops their buffers.</summary>
    public void SetExcludes(List<string> sanitized)
    {
        _userExcludes.Clear();
        _userExcludes.AddRange(sanitized);
        _evict.Clear();
        foreach (var t in Tracks.Values)
        {
            if (IsExcluded(t.Name)) _evict.Add(t.Pid);
        }
        foreach (var pid in _evict) Tracks.Remove(pid);
    }

    public void Clear()
    {
        Tracks.Clear();
        _lastEmitSeq = _seq;
    }

    public bool PresentedWithin(int pid, double nowMs, double withinMs) =>
        Tracks.TryGetValue(pid, out var t) && t.Count > 0 && nowMs - t.LastReceiptMs <= withinMs;

    /// <summary>1 Hz housekeeping: evict silent pids, re-pick each primary swap chain, prune to the window.</summary>
    public void Maintain(double nowMs, int windowSec)
    {
        _evict.Clear();
        double keepMs = Math.Max(windowSec, 5) * 1000.0 + 1000.0;
        foreach (var t in Tracks.Values)
        {
            if (nowMs - t.LastReceiptMs > EvictMs)
            {
                _evict.Add(t.Pid);
                continue;
            }
            t.PruneBefore(nowMs - keepMs);
            RepickPrimary(t, nowMs);
        }
        foreach (var pid in _evict) Tracks.Remove(pid);
    }

    /// <summary>Primary = the swap chain with the most frames in the last 2 s (kept when it had none).</summary>
    private void RepickPrimary(PidTrack t, double nowMs)
    {
        _swapCounts.Clear();
        for (int i = t.Count - 1; i >= 0; i--)
        {
            ref var f = ref t[i];
            if (f.CpuStartMs < nowMs - PresentingMs) break;
            _swapCounts[f.SwapChain] = _swapCounts.TryGetValue(f.SwapChain, out int c) ? c + 1 : 1;
        }
        if (_swapCounts.Count == 0) return;
        ulong best = t.Primary;
        int bestCount = -1;
        foreach (var kv in _swapCounts)
        {
            // Ties keep the current primary (stable target).
            if (kv.Value > bestCount || (kv.Value == bestCount && kv.Key == t.Primary))
            {
                best = kv.Key;
                bestCount = kv.Value;
            }
        }
        t.Primary = best;
        t.HasPrimary = true;
    }

    /// <summary>
    /// frameStats for <paramref name="pid"/> over the last <paramref name="windowSec"/> s of the QPC clock,
    /// plus the frametimes received since the previous call (≤ 1000, newest kept). Null when the pid has no buffer.
    /// </summary>
    public FrameStatsMessage? BuildStats(int pid, double nowMs, int windowSec, long unixMs)
    {
        if (!Tracks.TryGetValue(pid, out var t)) return null;
        double from = nowMs - windowSec * 1000.0;

        int n = 0;
        int batchTotal = 0;
        for (int i = 0; i < t.Count; i++)
        {
            ref var f = ref t[i];
            if (t.HasPrimary && f.SwapChain != t.Primary) continue;
            if (f.Seq > _lastEmitSeq) batchTotal++;
            if (f.CpuStartMs < from) continue;
            if (n == _window.Length) Array.Resize(ref _window, _window.Length * 2);
            _window[n++] = f;
        }

        var msg = new FrameStatsMessage
        {
            Ts = unixMs,
            Pid = pid,
            Process = t.Name,
            WindowSec = windowSec,
        };
        var cols = new FrameStatsCalc.Columns(Csv.HasCpuBusy, Csv.HasGpuBusy, Csv.HasDisplay, Csv.HasDisplayLatency);
        FrameStatsCalc.Fill(msg, _window.AsSpan(0, n), cols, ref _scratch);

        var newest = t.NewestPrimary();
        if (newest is { } nf)
        {
            msg.PresentMode = Csv.StringAt(nf.PresentModeIdx);
            msg.Runtime = Csv.StringAt(nf.RuntimeIdx);
            msg.AllowsTearing = nf.AllowsTearing < 0 ? null : nf.AllowsTearing == 1;
            msg.SyncInterval = nf.SyncInterval == short.MinValue ? null : nf.SyncInterval;
        }

        int skip = Math.Max(0, batchTotal - FrametimeBatchMax);
        msg.FrametimesOmitted = skip;
        var list = new List<double>(Math.Min(batchTotal, FrametimeBatchMax));
        int seen = 0;
        for (int i = 0; i < t.Count; i++)
        {
            ref var f = ref t[i];
            if (t.HasPrimary && f.SwapChain != t.Primary) continue;
            if (f.Seq <= _lastEmitSeq) continue;
            if (seen++ < skip) continue;
            list.Add(FrameStatsCalc.Round2(f.FrameTimeMs));
        }
        msg.Frametimes = list;
        _lastEmitSeq = _seq;
        return msg;
    }

    /// <summary>Presenting processes (a valid frame received in the last 2 s) with their fps over their last 2 s of frames.</summary>
    public List<(int Pid, string Name, double Fps, string Runtime, string PresentMode)> Presenting(double nowMs)
    {
        var result = new List<(int, string, double, string, string)>();
        foreach (var t in Tracks.Values)
        {
            if (t.Count == 0 || nowMs - t.LastReceiptMs > PresentingMs) continue;
            var newest = t.NewestPrimary();
            if (newest is not { } nf) continue;
            // Anchored at the newest frame so PresentMon's output delay does not shrink the count.
            double from = nf.CpuStartMs - PresentingMs;
            int n = 0;
            double sum = 0;
            for (int i = t.Count - 1; i >= 0; i--)
            {
                ref var f = ref t[i];
                if (f.CpuStartMs < from) break;
                if (t.HasPrimary && f.SwapChain != t.Primary) continue;
                n++;
                sum += f.FrameTimeMs;
            }
            double fps = n > 0 && sum > 0 ? FrameStatsCalc.Round1(1000.0 * n / sum) : 0;
            result.Add((t.Pid, t.Name, fps, Csv.StringAt(nf.RuntimeIdx), Csv.StringAt(nf.PresentModeIdx)));
        }
        result.Sort((a, b) => b.Item3.CompareTo(a.Item3));
        return result;
    }
}
