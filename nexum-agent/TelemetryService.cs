using System.Management;
using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// LibreHardwareMonitor wrapper: owns the <see cref="Computer"/>, updates every sensor and maps
/// them to the CONTRACT §1.1 <see cref="TelemetryPacket"/>. All access to LHM objects (including
/// fan control in <see cref="FanController"/>) must happen while holding <see cref="SyncRoot"/>.
/// </summary>
internal sealed class TelemetryService : IDisposable
{
    private static readonly Regex CoreLoadRegex =
        new(@"^CPU Core #(\d+)(\s+Thread #\d+)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex CoreClockRegex =
        new(@"^(?:CPU )?Core #\d+$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly Computer _computer;
    private readonly UpdateVisitor _visitor = new();
    private readonly StaticInfo _static;
    private readonly DiskReliabilityCache _reliability = new();
    private double? _maxObservedClockMhz;
    private bool _opened;
    private bool _closed;

    public object SyncRoot { get; } = new();

    public TelemetryService()
    {
        _computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsMotherboardEnabled = true,
            IsControllerEnabled = true,
            IsStorageEnabled = true,
            IsNetworkEnabled = true,
        };
        _static = StaticInfo.Load();
    }

    /// <summary>Opens the LHM Computer (loads the ring-0 driver when elevated). Call once, under <see cref="SyncRoot"/>.</summary>
    public void Open()
    {
        if (_opened || _closed) return;
        _computer.Open();
        _opened = true;
        _reliability.Start();

        try
        {
            foreach (var hw in Flatten(_computer.Hardware))
            {
                Program.Log($"Hardware: {hw.HardwareType} '{SafeName(hw)}' {SafeId(hw)} ({SensorsOf(hw).Length} sensors)");
            }
        }
        catch (Exception ex)
        {
            Program.Log($"Hardware enumeration log failed: {ex.Message}");
        }
    }

    /// <summary>All hardware including nested SubHardware (e.g. Super I/O chips under the motherboard).</summary>
    public List<IHardware> AllHardware()
    {
        try { return Flatten(_computer.Hardware).ToList(); }
        catch { return new List<IHardware>(); }
    }

    /// <summary>Updates all sensors and builds one packet. Never throws; section failures are reported via <paramref name="warnings"/>.</summary>
    public TelemetryPacket Collect(FanController fans, List<string> warnings)
    {
        var packet = new TelemetryPacket { Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        if (!_opened || _closed)
        {
            packet.Cpu = BaseCpu();
            packet.Ram = MapRam(Array.Empty<IHardware>());
            packet.FanPreset = fans.CurrentPreset;
            return packet;
        }

        try { _computer.Accept(_visitor); }
        catch (Exception ex) { warnings.Add($"Sensor update failed: {ex.Message}"); }

        var all = AllHardware();

        Section("cpu", warnings, () => packet.Cpu = MapCpu(all.FirstOrDefault(h => h.HardwareType == HardwareType.Cpu)));
        Section("gpu", warnings, () =>
        {
            var gpus = all.Where(GpuMonitor.IsGpu)
                          .Select(h => (h.HardwareType, GpuMonitor.Map(h)))
                          .ToList();
            packet.Gpus = gpus.Select(g => g.Item2).ToList();
            int primary = GpuMonitor.SelectPrimaryIndex(gpus);
            packet.Gpu = primary >= 0 ? gpus[primary].Item2 : null;
        });
        Section("ram", warnings, () => packet.Ram = MapRam(all));
        Section("fans", warnings, () =>
        {
            fans.Refresh(all);
            packet.Fans = fans.BuildTelemetry();
        });
        Section("disks", warnings, () => packet.Disks = all.Where(h => h.HardwareType == HardwareType.Storage).Select(MapDisk).ToList());
        Section("network", warnings, () => packet.Network = MapNetwork(all));

        packet.FanPreset = fans.CurrentPreset;
        return packet;
    }

    private static void Section(string name, List<string> warnings, Action action)
    {
        try { action(); }
        catch (Exception ex)
        {
            warnings.Add($"Telemetry section '{name}' failed: {ex.Message}");
            Program.Log($"Section {name} failed: {ex}");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // CPU

    private CpuTelemetry BaseCpu() => new()
    {
        Name = _static.CpuName ?? "Unknown CPU",
        Cores = _static.Cores,
        Threads = _static.Threads,
    };

    private CpuTelemetry MapCpu(IHardware? cpu)
    {
        var t = BaseCpu();
        if (cpu is null) return t;

        var name = SafeName(cpu);
        if (!string.IsNullOrWhiteSpace(name)) t.Name = name;

        // Total load.
        t.LoadTotal = Math.Clamp(RoundOr(FindValue(cpu, SensorType.Load, "CPU Total")), 0, 100);

        // Per-core load: "CPU Core #n" or, with SMT, "CPU Core #n Thread #m" averaged per core.
        var perCore = new SortedDictionary<int, List<float>>();
        bool hasThreadSuffix = false;
        foreach (var s in OfType(cpu, SensorType.Load))
        {
            var m = CoreLoadRegex.Match((s.Name ?? "").Trim());
            if (!m.Success || !int.TryParse(m.Groups[1].Value, out int core)) continue;
            if (m.Groups[2].Success) hasThreadSuffix = true;
            var v = Finite(s.Value);
            if (!v.HasValue) continue;
            if (!perCore.TryGetValue(core, out var list)) perCore[core] = list = new List<float>();
            list.Add(v.Value);
        }
        // Without SMT topology (e.g. not elevated) LHM names logical processors "CPU Core #1..#N" with
        // N = threads. Windows numbers SMT siblings adjacently, so fold them back into physical cores.
        var loads = perCore.Values.Select(l => (double)l.Average()).ToList();
        int threads = _static.Threads, cores = _static.Cores;
        if (!hasThreadSuffix && cores > 0 && threads > cores && threads % cores == 0 && loads.Count == threads)
        {
            int perGroup = threads / cores;
            loads = Enumerable.Range(0, cores)
                              .Select(c => loads.Skip(c * perGroup).Take(perGroup).Average())
                              .ToList();
        }
        t.LoadPerCore = loads.Select(v => Math.Clamp(RoundOr(v), 0, 100)).ToList();

        // Clocks: average of the per-core clocks; max = highest core clock observed this session.
        var coreClocks = OfType(cpu, SensorType.Clock)
            .Where(s => CoreClockRegex.IsMatch((s.Name ?? "").Trim()))
            .Select(s => Finite(s.Value))
            .Where(v => v.HasValue && v.Value > 0)
            .Select(v => (double)v!.Value)
            .ToList();
        if (coreClocks.Count == 0)
        {
            coreClocks = OfType(cpu, SensorType.Clock)
                .Where(s => !(s.Name ?? "").Contains("Bus", StringComparison.OrdinalIgnoreCase))
                .Select(s => Finite(s.Value))
                .Where(v => v.HasValue && v.Value > 0)
                .Select(v => (double)v!.Value)
                .ToList();
        }
        if (coreClocks.Count > 0)
        {
            t.ClockMhz = Round(coreClocks.Average());
            double max = coreClocks.Max();
            if (!_maxObservedClockMhz.HasValue || max > _maxObservedClockMhz.Value) _maxObservedClockMhz = max;
        }
        t.MaxClockMhz = Round(_maxObservedClockMhz);

        // Package temperature.
        var temp = FindPositive(cpu, SensorType.Temperature,
                       "Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core (Tdie)", "Tctl/Tdie", "Package");
        if (!temp.HasValue)
        {
            var temps = OfType(cpu, SensorType.Temperature)
                .Where(s => !IsTjMaxDistance(s.Name))
                .ToList();
            var coreTemps = temps.Where(s => (s.Name ?? "").Contains("Core", StringComparison.OrdinalIgnoreCase))
                                 .Select(s => Positive(s.Value)).Where(v => v.HasValue).Select(v => v!.Value).ToList();
            if (coreTemps.Count > 0) temp = coreTemps.Max();
            else
            {
                var any = temps.Select(s => Positive(s.Value)).Where(v => v.HasValue).Select(v => v!.Value).ToList();
                if (any.Count > 0) temp = any.Max();
            }
        }
        t.PackageTempC = Round(temp);

        // Core voltage (3 decimals: 1 decimal is meaningless for volts). SVI2/MSR voltages need the
        // ring-0 driver; unelevated they return a fixed placeholder, so report null instead.
        t.Voltage = !Program.IsAdmin ? null : Round(FindPositive(cpu, SensorType.Voltage,
                              "Core (SVI2 TFN)", "Core (SVI3 TFN)", "CPU Core", "Core", "Core (SVI2)", "Core (SVI3)")
                          ?? FirstPositive(cpu, SensorType.Voltage), 3);

        // Package power.
        t.PowerW = Round(FindPositive(cpu, SensorType.Power, "Package", "CPU Package")
                         ?? FirstPositive(cpu, SensorType.Power));

        return t;
    }

    private static bool IsTjMaxDistance(string? name) =>
        name is not null && (name.Contains("Distance", StringComparison.OrdinalIgnoreCase) ||
                             name.Contains("TjMax", StringComparison.OrdinalIgnoreCase));

    // ---------------------------------------------------------------------------------------------
    // RAM

    private RamTelemetry MapRam(IReadOnlyList<IHardware> all)
    {
        float? usedGb = null, availGb = null, load = null;
        foreach (var mem in all.Where(h => h.HardwareType == HardwareType.Memory))
        {
            if (SafeName(mem).Contains("Virtual", StringComparison.OrdinalIgnoreCase)) continue;
            usedGb ??= FindValue(mem, SensorType.Data, "Memory Used", "Physical Memory Used", "Used Memory");
            availGb ??= FindValue(mem, SensorType.Data, "Memory Available", "Physical Memory Available", "Available Memory");
            load ??= FindValue(mem, SensorType.Load, "Memory", "Physical Memory", "Memory Load");
        }

        const double GiB = 1024d * 1024d * 1024d;
        var status = MemoryFlush.QueryMemoryStatus();

        double? used = usedGb;
        double? avail = availGb;
        double? total = used.HasValue && avail.HasValue ? used + avail : null;

        if (status.HasValue)
        {
            double sysTotal = status.Value.Total / GiB;
            double sysAvail = status.Value.Available / GiB;
            total ??= sysTotal;
            avail ??= sysAvail;
            used ??= Math.Max(0, sysTotal - sysAvail);
        }

        double? loadPct = load;
        if (!loadPct.HasValue && total.HasValue && total.Value > 0 && used.HasValue)
        {
            loadPct = used.Value / total.Value * 100d;
        }

        return new RamTelemetry
        {
            UsedGb = Math.Max(0, RoundOr(used)),
            AvailableGb = Math.Max(0, RoundOr(avail)),
            TotalGb = Math.Max(0, RoundOr(total)),
            LoadPct = Math.Clamp(RoundOr(loadPct), 0, 100),
            SpeedMts = _static.RamSpeedMts,
            FormFactor = _static.RamFormFactor,
            SlotsUsed = _static.RamSlotsUsed,
            SlotsTotal = _static.RamSlotsTotal,
        };
    }

    // ---------------------------------------------------------------------------------------------
    // Disks

    private DiskTelemetry MapDisk(IHardware hw)
    {
        var id = SafeId(hw);
        var name = SafeName(hw);
        var d = new DiskTelemetry { Id = id, Name = string.IsNullOrWhiteSpace(name) ? "Disk" : name };

        d.TempC = Round(FindPositive(hw, SensorType.Temperature, "Temperature", "Composite Temperature", "Drive Temperature")
                        ?? FirstPositive(hw, SensorType.Temperature));

        var read = FindValue(hw, SensorType.Throughput, "Read Rate");
        var write = FindValue(hw, SensorType.Throughput, "Write Rate");
        d.ReadMBps = read.HasValue ? Round(Math.Max(0, read.Value / BytesPerMiB), 2) : null;
        d.WriteMBps = write.HasValue ? Round(Math.Max(0, write.Value / BytesPerMiB), 2) : null;

        // LHM >= 0.9.5 (DiskInfoToolkit) exposes "Life" (100 = new, 0 = worn out); older builds used
        // "Remaining Life" (NVMe/SSD) or "Percentage Used" (NVMe wear, inverted).
        var remaining = FindValue(hw, SensorType.Level, "Life", "Remaining Life", "Life Remaining")
                        ?? FindValue(hw, SensorType.Load, "Life");
        if (remaining.HasValue)
        {
            d.HealthPct = Clamp(Round(remaining.Value), 0, 100);
        }
        else
        {
            var used = FindValue(hw, SensorType.Level, "Percentage Used");
            if (used.HasValue) d.HealthPct = Clamp(Round(100d - used.Value), 0, 100);
        }

        var writtenGb = FindValue(hw, SensorType.Data, "Data Written", "Total Bytes Written", "Host Writes", "Total Host Writes");
        d.Tbw = writtenGb.HasValue ? Round(Math.Max(0, writtenGb.Value / 1024d), 2) : null;

        var poh = FindValueContaining(hw, null, "Power On Hours", "Power-On Hours", "Power On Time");
        long? powerOnHours = poh.HasValue && poh.Value >= 0 ? (long)Math.Round(poh.Value) : null;

        var rel = _reliability.Lookup(id, name);
        if (rel is not null)
        {
            powerOnHours ??= rel.PowerOnHours;
            d.TempC ??= rel.TempC;
        }
        d.PowerOnHours = powerOnHours;

        d.UsedPct = Clamp(Round(FindValue(hw, SensorType.Load, "Used Space")), 0, 100);
        return d;
    }

    // ---------------------------------------------------------------------------------------------
    // Network

    private static NetworkTelemetry? MapNetwork(IReadOnlyList<IHardware> all)
    {
        double down = 0, up = 0;
        bool any = false;
        foreach (var nic in all.Where(h => h.HardwareType == HardwareType.Network))
        {
            var d = FindValue(nic, SensorType.Throughput, "Download Speed");
            var u = FindValue(nic, SensorType.Throughput, "Upload Speed");
            if (d.HasValue) { down += Math.Max(0, d.Value); any = true; }
            if (u.HasValue) { up += Math.Max(0, u.Value); any = true; }
        }
        if (!any) return null;
        return new NetworkTelemetry
        {
            DownMBps = RoundOr(down / BytesPerMiB, 0, 2),
            UpMBps = RoundOr(up / BytesPerMiB, 0, 2),
        };
    }

    // ---------------------------------------------------------------------------------------------

    /// <summary>Closes the LHM Computer (unloads the driver). Caller restores fans first.</summary>
    public void Close()
    {
        if (_closed) return;
        _closed = true;
        _reliability.Dispose();
        if (_opened)
        {
            try { _computer.Close(); }
            catch (Exception ex) { Program.Log($"Computer.Close failed: {ex.Message}"); }
        }
    }

    public void Dispose() => Close();

    /// <summary>Updates every hardware node and recurses into SubHardware (Super I/O lives under Motherboard).</summary>
    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) => computer.Traverse(this);

        public void VisitHardware(IHardware hardware)
        {
            try { hardware.Update(); }
            catch (Exception ex) { Program.LogThrottled($"update:{SafeId(hardware)}", $"Update failed for {SafeName(hardware)}: {ex.Message}"); }

            IHardware[]? subs = null;
            try { subs = hardware.SubHardware; } catch { /* ignore */ }
            if (subs is null) return;
            foreach (var sub in subs)
            {
                if (sub is null) continue;
                try { sub.Accept(this); }
                catch (Exception ex) { Program.LogThrottled($"update:{SafeId(sub)}", $"Update failed for {SafeName(sub)}: {ex.Message}"); }
            }
        }

        public void VisitSensor(ISensor sensor) { }

        public void VisitParameter(IParameter parameter) { }
    }
}

/// <summary>Static facts read once at startup from WMI (CPU topology, DIMM layout).</summary>
internal sealed class StaticInfo
{
    public string? CpuName { get; private init; }
    public int Cores { get; private init; }
    public int Threads { get; private init; }
    public int? RamSpeedMts { get; private init; }
    public string? RamFormFactor { get; private init; }
    public int? RamSlotsUsed { get; private init; }
    public int? RamSlotsTotal { get; private init; }

    public static StaticInfo Load()
    {
        string? cpuName = null;
        int cores = 0, threads = 0;
        int? speed = null, slotsUsed = null, slotsTotal = null;
        string? formFactor = null;

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name, NumberOfCores, NumberOfLogicalProcessors FROM Win32_Processor");
            using var results = searcher.Get();
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    cpuName ??= mo["Name"]?.ToString()?.Trim();
                    cores += (int)(ToLong(mo["NumberOfCores"]) ?? 0);
                    threads += (int)(ToLong(mo["NumberOfLogicalProcessors"]) ?? 0);
                }
            }
        }
        catch (Exception ex)
        {
            Program.Log($"WMI Win32_Processor failed: {ex.Message}");
        }

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Capacity, Speed, ConfiguredClockSpeed, FormFactor FROM Win32_PhysicalMemory");
            using var results = searcher.Get();
            int count = 0;
            var speeds = new List<int>();
            var factors = new List<int>();
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    var cap = ToLong(mo["Capacity"]) ?? 0;
                    if (cap <= 0) continue;
                    count++;
                    var configured = ToLong(mo["ConfiguredClockSpeed"]) ?? 0;
                    var rated = ToLong(mo["Speed"]) ?? 0;
                    var s = configured > 0 ? configured : rated;
                    if (s > 0 && s < 100_000) speeds.Add((int)s);
                    var ff = ToLong(mo["FormFactor"]);
                    if (ff.HasValue) factors.Add((int)ff.Value);
                }
            }
            if (count > 0) slotsUsed = count;
            if (speeds.Count > 0) speed = speeds.Min(); // modules run at the slowest common speed
            formFactor = factors.Select(MapFormFactor).FirstOrDefault(f => f is not null);
        }
        catch (Exception ex)
        {
            Program.Log($"WMI Win32_PhysicalMemory failed: {ex.Message}");
        }

        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT MemoryDevices, Use FROM Win32_PhysicalMemoryArray");
            using var results = searcher.Get();
            int systemSlots = 0, anySlots = 0;
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    var devices = (int)(ToLong(mo["MemoryDevices"]) ?? 0);
                    if (devices <= 0) continue;
                    anySlots += devices;
                    if (ToLong(mo["Use"]) == 3) systemSlots += devices; // 3 = System memory
                }
            }
            int total = systemSlots > 0 ? systemSlots : anySlots;
            if (total > 0) slotsTotal = total;
        }
        catch (Exception ex)
        {
            Program.Log($"WMI Win32_PhysicalMemoryArray failed: {ex.Message}");
        }

        if (slotsTotal.HasValue && slotsUsed.HasValue && slotsTotal.Value < slotsUsed.Value)
        {
            slotsTotal = slotsUsed; // some firmware under-reports the array size
        }

        if (threads <= 0) threads = Environment.ProcessorCount;
        if (cores <= 0) cores = threads;

        return new StaticInfo
        {
            CpuName = string.IsNullOrWhiteSpace(cpuName) ? null : cpuName,
            Cores = cores,
            Threads = threads,
            RamSpeedMts = speed,
            RamFormFactor = formFactor,
            RamSlotsUsed = slotsUsed,
            RamSlotsTotal = slotsTotal,
        };
    }

    private static string? MapFormFactor(int ff) => ff switch
    {
        8 => "DIMM",
        12 => "SODIMM",
        9 => "RIMM",
        13 => "SRIMM",
        11 => "Row of chips",
        _ => null,
    };

    internal static long? ToLong(object? o)
    {
        if (o is null) return null;
        try { return Convert.ToInt64(o, System.Globalization.CultureInfo.InvariantCulture); }
        catch { return null; }
    }
}

/// <summary>
/// Background cache of Windows Storage reliability counters (MSFT_StorageReliabilityCounter):
/// fills powerOnHours / temperature when LibreHardwareMonitor does not expose them.
/// Refreshed off the telemetry thread every 10 minutes.
/// </summary>
internal sealed class DiskReliabilityCache : IDisposable
{
    internal sealed record Entry(string DeviceId, string Name, long? PowerOnHours, double? TempC);

    private static readonly Regex TrailingIndex = new(@"/(\d+)$", RegexOptions.Compiled);
    private static readonly TimeSpan RefreshEvery = TimeSpan.FromMinutes(10);

    private readonly CancellationTokenSource _cts = new();
    private volatile IReadOnlyList<Entry> _entries = Array.Empty<Entry>();
    private int _started;

    public void Start()
    {
        if (Interlocked.Exchange(ref _started, 1) == 1) return;
        var thread = new Thread(Loop) { IsBackground = true, Name = "disk-reliability", Priority = ThreadPriority.BelowNormal };
        thread.Start();
    }

    private void Loop()
    {
        var token = _cts.Token;
        if (token.WaitHandle.WaitOne(TimeSpan.FromSeconds(3))) return;
        while (!token.IsCancellationRequested)
        {
            try { _entries = Query(); }
            catch (Exception ex) { Program.Log($"Storage reliability query failed: {ex.Message}"); }
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
                var deviceId = disk["DeviceId"]?.ToString() ?? "";
                var name = disk["FriendlyName"]?.ToString()?.Trim() ?? "";
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
                list.Add(new Entry(deviceId, name, poh, temp));
            }
        }
        return list;
    }

    /// <summary>Matches an LHM storage device (identifier "/nvme/0", model name) to a Windows physical disk.</summary>
    public Entry? Lookup(string lhmId, string lhmName)
    {
        var entries = _entries;
        if (entries.Count == 0) return null;

        string? index = null;
        var m = TrailingIndex.Match(lhmId ?? "");
        if (m.Success) index = m.Groups[1].Value;

        var norm = Normalize(lhmName);
        bool NameMatches(Entry e)
        {
            var n = Normalize(e.Name);
            return n.Length > 0 && norm.Length > 0 && (n == norm || n.Contains(norm) || norm.Contains(n));
        }

        if (index is not null)
        {
            var byIndex = entries.FirstOrDefault(e => e.DeviceId == index && NameMatches(e));
            if (byIndex is not null) return byIndex;
        }

        var byName = entries.Where(NameMatches).ToList();
        return byName.Count == 1 ? byName[0] : null;
    }

    private static string Normalize(string? s) =>
        new string((s ?? "").Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { /* ignore */ }
    }
}
