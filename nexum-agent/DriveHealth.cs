using System.Globalization;
using System.Management;
using System.Text.RegularExpressions;
using DiskInfoToolkit.Interop.Enums;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.Hardware.Storage;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// The single drive-health classifier (CONTRACT §1.1.3, MF-1). Rust and the UI never re-derive the
/// state; they display <see cref="DriveHealthDto"/> verbatim.
/// </summary>
internal static class DriveHealth
{
    public const string StateGood = "good";
    public const string StateAttention = "attention";
    public const string StateReplace = "replace";
    public const string StateFailing = "failing";
    public const string StateUnknown = "unknown";

    /// <summary>Windows MSFT_PhysicalDisk.HealthStatus values.</summary>
    public const int WinHealthy = 0, WinWarning = 1, WinUnhealthy = 2;

    internal sealed record Input
    {
        public bool IsAdmin { get; init; }
        /// <summary>"nvme" | "smart" | "none".</summary>
        public string Source { get; init; } = "none";
        /// <summary>= healthPct.</summary>
        public double? Life { get; init; }
        public double? PercentageUsed { get; init; }
        public long? PowerOnHours { get; init; }
        public long? CriticalWarning { get; init; }
        public double? AvailableSparePct { get; init; }
        public double? AvailableSpareThresholdPct { get; init; }
        public long? ReallocatedSectors { get; init; }
        public long? PendingSectors { get; init; }
        public long? UncorrectableSectors { get; init; }
        /// <summary>Windows HealthStatus of the joined MSFT_PhysicalDisk, null if unmatched.</summary>
        public int? WindowsHealth { get; init; }
    }

    public static DriveHealthDto Classify(Input d)
    {
        // Row 1: failing.
        var failing = new List<string>();
        long cw = d.CriticalWarning ?? 0;
        if (d.CriticalWarning.HasValue && (cw & 0x1D) != 0)
        {
            if ((cw & 0x01) != 0) failing.Add("NVMe critical warning: available spare below threshold");
            if ((cw & 0x04) != 0) failing.Add("NVMe critical warning: reliability degraded");
            if ((cw & 0x08) != 0) failing.Add("NVMe critical warning: drive is read-only");
            if ((cw & 0x10) != 0) failing.Add("NVMe critical warning: volatile memory backup failed");
        }
        if (d.AvailableSparePct.HasValue && d.AvailableSpareThresholdPct.HasValue &&
            d.AvailableSpareThresholdPct.Value > 0 && d.AvailableSparePct.Value < d.AvailableSpareThresholdPct.Value)
        {
            failing.Add($"available spare {Num(d.AvailableSparePct.Value)}% is below the {Num(d.AvailableSpareThresholdPct.Value)}% threshold");
        }
        if (d.WindowsHealth == WinUnhealthy) failing.Add("Windows reports this drive as Unhealthy");
        if (failing.Count > 0) return Make(StateFailing, "Failing", failing, d.Source);

        // Row 2: replace soon.
        if (d.Life.HasValue && d.Life.Value <= 10)
        {
            return Make(StateReplace, "Replace soon", WearFragments(d), d.Source);
        }

        // Rows 3–6: attention (label from the first matching row; reason lists every attention trigger).
        string? label = null;
        var attention = new List<string>();
        if (d.Life.HasValue && d.Life.Value > 10 && d.Life.Value <= 50)
        {
            label ??= "Worn";
            attention.AddRange(WearFragments(d));
        }
        if ((d.ReallocatedSectors ?? 0) > 0 || (d.PendingSectors ?? 0) > 0 || (d.UncorrectableSectors ?? 0) > 0)
        {
            label ??= "Check sectors";
            attention.Add(SectorFragment(d));
        }
        if (d.CriticalWarning.HasValue && (cw & 0x02) != 0)
        {
            label ??= "Overheating";
            attention.Add("drive reported a temperature warning");
        }
        if (d.WindowsHealth == WinWarning)
        {
            label ??= "Windows warning";
            attention.Add("Windows reports a warning for this drive");
        }
        if (label is not null) return Make(StateAttention, label, attention, d.Source);

        // Row 7: good.
        bool sectorsClean = d.ReallocatedSectors == 0 && d.PendingSectors == 0 && d.UncorrectableSectors == 0;
        if ((d.Life.HasValue && d.Life.Value > 50) || (!d.Life.HasValue && d.Source == "smart" && sectorsClean))
        {
            var good = WearFragments(d);
            if (good.Count == 0) good.Add(SectorFragment(d));
            return Make(StateGood, "Good", good, d.Source);
        }

        // Row 8: unknown. Never green.
        if (!d.IsAdmin)
            return Make(StateUnknown, "Health unknown — run as administrator", new() { "S.M.A.R.T. needs administrator rights" }, d.Source);
        if (d.Source == "none")
            return Make(StateUnknown, "Health unknown — no S.M.A.R.T. data", new() { "The drive or its USB bridge does not report S.M.A.R.T. data" }, d.Source);
        return Make(StateUnknown, "Health unknown — no wear data", new() { "No wear or sector data reported" }, d.Source);
    }

    private static List<string> WearFragments(Input d)
    {
        var list = new List<string>();
        if (d.Life.HasValue) list.Add($"{Num(d.Life.Value)}% life left");
        if (d.PercentageUsed.HasValue) list.Add($"{Num(d.PercentageUsed.Value)}% of rated endurance used");
        if (d.PowerOnHours.HasValue) list.Add($"{Num(d.PowerOnHours.Value)} power-on hours");
        return list;
    }

    private static string SectorFragment(Input d) =>
        $"{Num(d.ReallocatedSectors ?? 0)} reallocated / {Num(d.PendingSectors ?? 0)} pending / {Num(d.UncorrectableSectors ?? 0)} uncorrectable sectors";

    private static DriveHealthDto Make(string state, string label, List<string> reasons, string source) => new()
    {
        State = state,
        Label = label,
        Reason = string.Join(" · ", reasons),
        Source = source,
    };

    /// <summary>en-US style number: thousands separators, up to 2 decimals.</summary>
    internal static string Num(double v) => v.ToString("#,##0.##", CultureInfo.InvariantCulture);

    /// <summary>Join key normalisation (CONTRACT §1.1.3 join rule 1).</summary>
    public static string? NormSerial(string? s)
    {
        if (s is null) return null;
        var n = Regex.Replace(s, @"[\s._-]", "").ToUpperInvariant();
        return n.Length == 0 ? null : n;
    }

    // ---------------------------------------------------------------------------------------------
    // SMART extraction from LHM StorageDevice / DiskInfoToolkit

    /// <summary>Raw SMART facts for one drive, read from DiskInfoToolkit's parsed NVMe health log / ATA attributes.</summary>
    internal sealed class SmartFacts
    {
        public string Source = "none";
        public int? DiskNumber;
        public string? Serial;
        public double? Life;
        public double? PercentageUsed;
        public long? CriticalWarning;
        public double? AvailableSpare;
        public double? AvailableSpareThreshold;
        public long? MediaErrors;
        public long? UnsafeShutdowns;
        public long? PowerCycles;
        public long? ErrorLogEntries;
        public long? PowerOnHours;
        public double? WarningTempC;
        public double? CriticalTempC;
        public long? WarningTempMinutes;
        public long? CriticalTempMinutes;
        public long? Reallocated;
        public long? Pending;
        public long? Uncorrectable;
        public double? HostReadsGb;
        public double? HostWritesGb;
    }

    public static SmartFacts ReadSmart(IHardware hw)
    {
        var f = new SmartFacts();
        if (hw is not StorageDevice sd) return f;
        DiskInfoToolkit.Storage? st = null;
        try { st = sd.Storage; } catch { /* ignore */ }
        if (st is null) return f;

        try { f.DiskNumber = st.DriveNumber >= 0 ? st.DriveNumber : null; } catch { /* ignore */ }
        try
        {
            var serial = st.SerialNumber?.Trim();
            f.Serial = string.IsNullOrEmpty(serial) ? null : serial;
        }
        catch { /* ignore */ }

        DiskInfoToolkit.SmartInfo? smart = null;
        try { smart = st.Smart; } catch { /* ignore */ }
        if (smart is null) return f;

        var attrs = new Dictionary<SmartAttributeType, ulong>();
        try
        {
            if (smart.SmartAttributes is not null)
            {
                foreach (var a in smart.SmartAttributes)
                {
                    if (a?.Info is null) continue;
                    var raw = a.Attribute.RawValue is null ? 0UL : a.Attribute.RawValueULong;
                    attrs.TryAdd(a.Info.Type, raw);
                }
            }
        }
        catch (Exception ex)
        {
            Program.LogThrottled($"smart:{SafeId(hw)}", $"SMART attributes unreadable for {SafeName(hw)}: {ex.Message}");
        }

        bool isNvme = false;
        try { isNvme = st.IsNVMe; } catch { /* ignore */ }

        if (attrs.Count > 0) f.Source = isNvme ? "nvme" : "smart";

        long? Get(SmartAttributeType t) => attrs.TryGetValue(t, out var v) ? (long)Math.Min(v, long.MaxValue) : null;
        // ATA raw counts: vendors sometimes pack extra data into the upper raw bytes; the count is the low 32 bits.
        long? GetAtaCount(SmartAttributeType t) => attrs.TryGetValue(t, out var v) ? (long)(v & 0xFFFFFFFFUL) : null;

        if (isNvme && f.Source == "nvme")
        {
            f.CriticalWarning = Get(SmartAttributeType.CriticalWarning) is long cw ? cw & 0xFF : null;
            f.AvailableSpare = Get(SmartAttributeType.AvailableSpare);
            f.AvailableSpareThreshold = Get(SmartAttributeType.AvailableSpareThreshold);
            f.PercentageUsed = Get(SmartAttributeType.PercentageUsed);
            f.MediaErrors = Get(SmartAttributeType.MediaAndDataIntegrityErrors);
            f.UnsafeShutdowns = Get(SmartAttributeType.UnsafeShutdownCount);
            f.PowerCycles = Get(SmartAttributeType.PowerCycleCount);
            f.ErrorLogEntries = Get(SmartAttributeType.NumberOfErrorInformationLogEntries);
            f.WarningTempMinutes = Get(SmartAttributeType.WarningCompositeTemperatureTime);
            f.CriticalTempMinutes = Get(SmartAttributeType.CriticalCompositeTemperatureTime);
            f.PowerOnHours = Get(SmartAttributeType.PowerOnHours);
            if (f.PercentageUsed.HasValue) f.Life = Math.Clamp(100d - f.PercentageUsed.Value, 0, 100);
        }
        else if (f.Source == "smart")
        {
            f.Reallocated = GetAtaCount(SmartAttributeType.ReallocatedSectorsCount);
            f.Pending = GetAtaCount(SmartAttributeType.PendingSectorCount);
            f.Uncorrectable = GetAtaCount(SmartAttributeType.UncorrectableSectorCount);
            f.PowerCycles = GetAtaCount(SmartAttributeType.PowerCycleCount);
            f.UnsafeShutdowns = GetAtaCount(SmartAttributeType.UnsafeShutdownCount);
        }

        try
        {
            if (f.Life is null && smart.Life.HasValue)
            {
                double life = Convert.ToDouble(smart.Life.Value, CultureInfo.InvariantCulture);
                if (double.IsFinite(life)) f.Life = Math.Clamp(life, 0, 100);
            }
        }
        catch { /* ignore */ }

        try
        {
            if (f.PowerOnHours is null && f.Source != "none")
            {
                ulong h = Math.Max(smart.MeasuredPowerOnHours, smart.DetectedPowerOnHours);
                if (h > 0) f.PowerOnHours = (long)Math.Min(h, long.MaxValue);
            }
        }
        catch { /* ignore */ }

        try { f.WarningTempC = PositiveOrNull(smart.TemperatureWarning); } catch { /* ignore */ }
        try { f.CriticalTempC = PositiveOrNull(smart.TemperatureCritical); } catch { /* ignore */ }
        try { f.HostReadsGb = NonNegativeOrNull(smart.HostReads); } catch { /* ignore */ }
        try { f.HostWritesGb = NonNegativeOrNull(smart.HostWrites); } catch { /* ignore */ }
        return f;
    }

    private static double? PositiveOrNull<T>(T? v) where T : struct
    {
        if (!v.HasValue) return null;
        double d = Convert.ToDouble(v.Value, CultureInfo.InvariantCulture);
        return double.IsFinite(d) && d > 0 ? d : null;
    }

    private static double? NonNegativeOrNull<T>(T? v) where T : struct
    {
        if (!v.HasValue) return null;
        double d = Convert.ToDouble(v.Value, CultureInfo.InvariantCulture);
        return double.IsFinite(d) && d >= 0 ? d : null;
    }
}

/// <summary>
/// Background cache of Windows storage facts (MSFT_PhysicalDisk + MSFT_StorageReliabilityCounter):
/// HealthStatus for the classifier and power-on hours / temperature fallbacks. Refreshed off the
/// telemetry thread every 10 minutes. Joined to LHM drives by the CONTRACT §1.1.3 join rule.
/// </summary>
internal sealed class WindowsDiskCache : IDisposable
{
    internal sealed record Entry(string DeviceId, string? NormSerial, int? HealthStatus, long? PowerOnHours, double? TempC);

    private static readonly TimeSpan RefreshEvery = TimeSpan.FromMinutes(10);

    private readonly CancellationTokenSource _cts = new();
    private volatile IReadOnlyList<Entry> _entries = Array.Empty<Entry>();
    private int _started;

    public void Start()
    {
        if (Interlocked.Exchange(ref _started, 1) == 1) return;
        var thread = new Thread(Loop) { IsBackground = true, Name = "windows-disks", Priority = ThreadPriority.BelowNormal };
        thread.Start();
    }

    private void Loop()
    {
        var token = _cts.Token;
        if (token.WaitHandle.WaitOne(TimeSpan.FromSeconds(2))) return;
        while (!token.IsCancellationRequested)
        {
            try { _entries = Query(); }
            catch (Exception ex) { Program.Log($"Windows storage query failed: {ex.Message}"); }
            if (token.WaitHandle.WaitOne(RefreshEvery)) return;
        }
    }

    private static IReadOnlyList<Entry> Query()
    {
        var list = new List<Entry>();
        var scope = new ManagementScope(@"\\.\root\Microsoft\Windows\Storage");
        scope.Connect();
        using var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT * FROM MSFT_PhysicalDisk"));
        using var disks = searcher.Get();
        foreach (ManagementObject disk in disks)
        {
            using (disk)
            {
                var deviceId = disk["DeviceId"]?.ToString()?.Trim() ?? "";
                var serial = DriveHealth.NormSerial(disk["SerialNumber"]?.ToString());
                int? health = (int?)StaticInfo.ToLong(disk["HealthStatus"]);
                long? poh = null;
                double? temp = null;
                try
                {
                    using var related = disk.GetRelated("MSFT_StorageReliabilityCounter");
                    foreach (ManagementObject rc in related)
                    {
                        using (rc)
                        {
                            var p = StaticInfo.ToLong(rc["PowerOnHours"]);
                            if (p.HasValue && p.Value > 0) poh ??= p;
                            var t = StaticInfo.ToLong(rc["Temperature"]);
                            if (t.HasValue && t.Value > 0 && t.Value < 150) temp ??= t.Value;
                        }
                    }
                }
                catch (Exception ex)
                {
                    Program.LogThrottled($"reliability:{deviceId}", $"Reliability counter unavailable for disk {deviceId}: {ex.Message}");
                }
                list.Add(new Entry(deviceId, serial, health, poh, temp));
            }
        }
        return list;
    }

    /// <summary>Join rule: normalized serial first, then disk number; else unmatched.</summary>
    public Entry? Lookup(string? serial, int? diskNumber)
    {
        var entries = _entries;
        if (entries.Count == 0) return null;
        var norm = DriveHealth.NormSerial(serial);
        if (norm is not null)
        {
            var bySerial = entries.FirstOrDefault(e => e.NormSerial == norm);
            if (bySerial is not null) return bySerial;
        }
        if (diskNumber.HasValue)
        {
            var key = diskNumber.Value.ToString(CultureInfo.InvariantCulture);
            return entries.FirstOrDefault(e => e.DeviceId == key);
        }
        return null;
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { /* ignore */ }
    }
}
