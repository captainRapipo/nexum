namespace NexumAgent.Frames;

/// <summary>CONTRACT §1.6.5 statistics. Pure functions over the window's frames (no I/O, no clock).</summary>
internal static class FrameStatsCalc
{
    /// <summary>Nearest-rank percentile of an ascending-sorted array: sorted[ceil(q/100 × n) − 1].</summary>
    public static double Percentile(ReadOnlySpan<double> sortedAsc, double q)
    {
        int n = sortedAsc.Length;
        if (n == 0) return double.NaN;
        // Decimal arithmetic avoids binary rounding at exact ranks (99.9/100 × 1000 must be exactly 999).
        decimal rankExact = (decimal)q / 100m * n;
        int rank = (int)Math.Ceiling(rankExact);
        rank = Math.Clamp(rank, 1, n);
        return sortedAsc[rank - 1];
    }

    /// <summary>boundBy rule (c = cpuBusy, g = gpuBusy, t = frametime average, n = frames).</summary>
    public static string? BoundBy(double? c, double? g, double? t, int n)
    {
        if (c is null || g is null || t is null || n < 30) return null;
        double cv = c.Value, gv = g.Value, tv = t.Value;
        if (Math.Max(cv, gv) < 0.75 * tv) return "capped";
        if (gv >= 1.1 * cv) return "gpu";
        if (cv >= 1.1 * gv) return "cpu";
        return "balanced";
    }

    public static double Round1(double v) => Math.Round(v, 1, MidpointRounding.AwayFromZero);
    public static double Round2(double v) => Math.Round(v, 2, MidpointRounding.AwayFromZero);

    /// <summary>Which optional columns exist in the current PresentMon output.</summary>
    internal readonly record struct Columns(bool CpuBusy, bool GpuBusy, bool Display, bool DisplayLatency);

    /// <summary>
    /// Fills the window statistics of <paramref name="msg"/> from <paramref name="frames"/> (the target's
    /// primary-swap-chain frames inside the window, any order). <paramref name="scratch"/> is a reusable
    /// sort buffer (grown when needed). Does not touch pid/process/ts/frametimes.
    /// </summary>
    public static void Fill(FrameStatsMessage msg, ReadOnlySpan<FrameRow> frames, Columns cols, ref double[] scratch)
    {
        int n = frames.Length;
        msg.Frames = n;

        double sum = 0, max = double.NaN;
        double cpuSum = 0, gpuSum = 0, dispSum = 0, latSum = 0;
        int cpuN = 0, gpuN = 0, dispN = 0, latN = 0, notDisplayed = 0;
        if (scratch.Length < n) scratch = new double[Math.Max(n, scratch.Length * 2)];
        for (int i = 0; i < n; i++)
        {
            ref readonly var f = ref frames[i];
            double ft = f.FrameTimeMs;
            scratch[i] = ft;
            sum += ft;
            if (double.IsNaN(max) || ft > max) max = ft;
            if (!float.IsNaN(f.CpuBusyMs)) { cpuSum += f.CpuBusyMs; cpuN++; }
            if (!float.IsNaN(f.GpuBusyMs)) { gpuSum += f.GpuBusyMs; gpuN++; }
            if (float.IsNaN(f.DisplayedMs))
            {
                notDisplayed++;
            }
            else
            {
                dispSum += f.DisplayedMs;
                dispN++;
                if (!float.IsNaN(f.DisplayLatencyMs)) { latSum += f.DisplayLatencyMs; latN++; }
            }
        }

        double? avgFt = n >= 2 ? sum / n : null;
        msg.FpsAvg = n >= 2 && sum > 0 ? Round1(1000.0 * n / sum) : null;
        msg.FrametimeAvgMs = avgFt is null ? null : Round2(avgFt.Value);
        msg.FrametimeMaxMs = n >= 1 ? Round2(max) : null;

        msg.FrametimeP99Ms = null;
        msg.FrametimeP999Ms = null;
        msg.FpsLow1 = null;
        msg.FpsLow01 = null;
        if (n >= 100)
        {
            var sorted = scratch.AsSpan(0, n);
            sorted.Sort();
            double p99 = Percentile(sorted, 99);
            msg.FrametimeP99Ms = Round2(p99);
            msg.FpsLow1 = p99 > 0 ? Round1(1000.0 / p99) : null;
            if (n >= 1000)
            {
                double p999 = Percentile(sorted, 99.9);
                msg.FrametimeP999Ms = Round2(p999);
                msg.FpsLow01 = p999 > 0 ? Round1(1000.0 / p999) : null;
            }
        }

        double? cpu = cols.CpuBusy && cpuN > 0 ? cpuSum / cpuN : null;
        double? gpu = cols.GpuBusy && gpuN > 0 ? gpuSum / gpuN : null;
        msg.CpuBusyMs = cpu is null ? null : Round2(cpu.Value);
        msg.GpuBusyMs = gpu is null ? null : Round2(gpu.Value);
        msg.BoundBy = BoundBy(cpu, gpu, avgFt, n);

        if (cols.Display)
        {
            msg.FpsDisplayedAvg = dispN >= 2 && dispSum > 0 ? Round1(1000.0 * dispN / dispSum) : null;
            msg.DroppedPct = n >= 1 ? Round1(100.0 * notDisplayed / n) : null;
            msg.DisplayLatencyMs = cols.DisplayLatency && dispN >= 1 && latN > 0 ? Round2(latSum / latN) : null;
        }
        else
        {
            msg.FpsDisplayedAvg = null;
            msg.DroppedPct = null;
            msg.DisplayLatencyMs = null;
        }
    }
}
