using System.Management;
using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// LibreHardwareMonitor wrapper: owns the <see cref="Computer"/>, updates every sensor and maps
/// them to the CONTRACT §1.1 <see cref="TelemetryPacket"/>. All access to LHM objects (including
/// fan control in <see cref="FanController"/> and the sensor tree) must happen while holding <see cref="SyncRoot"/>.
/// </summary>
internal sealed class TelemetryService : IDisposable
{
    private static readonly Regex CoreLoadRegex =
        new(@"^CPU Core #(\d+)(\s+Thread #\d+)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex RawCoreClockRegex =
        new(@"^(?:CPU )?Core #\d+$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex EffectiveCoreClockRegex =
        new(@"^(?:CPU )?Core #\d+ \(Effective\)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>CPU temperature source order (CONTRACT §1.1.2). Also the fan-override input.</summary>
    internal static readonly string[] CpuTempNames =
        { "Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core (Tdie)", "Tctl/Tdie", "Package" };

    private readonly Computer _computer;
    private readonly UpdateVisitor _visitor = new();
    private readonly StaticInfo _static;
    private readonly WindowsDiskCache _windowsDisks = new();
    private bool _opened;
    private bool _closed;

    public object SyncRoot { get; } = new();

    public StaticInfo Static => _static;

    public TelemetryService()
    {
        _computer = new Computer(new AgentSettings())
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

        // MF-7: LHM keeps one day of per-sensor history by default. Disable it for every sensor of every
        // hardware as it appears (DIMMs from MemoryGroup arrive ~10 s after Open). Min/Max keep working.
        _computer.HardwareAdded += OnHardwareAdded;
    }

    /// <summary>Opens the LHM Computer (loads the ring-0 driver when elevated). Call once, under <see cref="SyncRoot"/>.</summary>
    public void Open()
    {
        if (_opened || _closed) return;
        _computer.Open();
        _opened = true;
        foreach (var hw in AllHardware()) DisableHistory(hw);
        _windowsDisks.Start();

        try
        {
            foreach (var hw in AllHardware())
            {
                Program.Log($"Hardware: {hw.HardwareType} '{SafeName(hw)}' {SafeId(hw)} ({SensorsOf(hw).Length} sensors)");
            }
        }
        catch (Exception ex)
        {
            Program.Log($"Hardware enumeration log failed: {ex.Message}");
        }
    }

    public bool IsOpen => _opened && !_closed;

    private static void OnHardwareAdded(IHardware hardware)
    {
        try
        {
            foreach (var hw in Flatten(new[] { hardware })) DisableHistory(hw);
        }
        catch (Exception ex)
        {
            Program.Log($"HardwareAdded handler failed: {ex.Message}");
        }
    }

    /// <summary>Sets ValuesTimeWindow = 0 on every sensor of <paramref name="hw"/> (not recursive) and on sensors added later.</summary>
    internal static void DisableHistory(IHardware hw)
    {
        foreach (var s in SensorsOf(hw)) DisableHistory(s);
        try
        {
            hw.SensorAdded -= DisableHistory;
            hw.SensorAdded += DisableHistory;
        }
        catch { /* some hardware types do not raise the event */ }
    }

    internal static void DisableHistory(ISensor? s)
    {
        if (s is null) return;
        try
        {
            if (s.ValuesTimeWindow != TimeSpan.Zero) s.ValuesTimeWindow = TimeSpan.Zero;
        }
        catch { /* ignore */ }
    }

    /// <summary>All hardware including nested SubHardware (e.g. Super I/O chips under the motherboard), depth-first.</summary>
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
            var gpus = all.Where(GpuMonitor.IsGpu).ToList();
            var mapped = gpus.Select(h => (h.HardwareType, GpuMonitor.Map(h))).ToList();
            packet.Gpus = mapped.Select(g => g.Item2).ToList();
            packet.GpuHwIds = gpus.Select(SafeId).ToList();
            int primary = GpuMonitor.SelectPrimaryIndex(mapped);
            packet.Gpu = primary >= 0 ? mapped[primary].Item2 : null;
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

    /// <summary>
    /// Extra update of only the CPU and the given GPUs, for the fan-override evaluation when the poll
    /// interval is longer than 1 s (CONTRACT §1.5.2). Returns T_cpu and T_gpu per GPU hardware id.
    /// </summary>
    public (double? CpuTemp, Dictionary<string, (double? Hotspot, double? Edge)> Gpus) SafetyUpdate(IReadOnlyCollection<string> gpuIds)
    {
        var gpus = new Dictionary<string, (double?, double?)>(StringComparer.OrdinalIgnoreCase);
        if (!_opened || _closed) return (null, gpus);
        double? cpuTemp = null;
        foreach (var hw in AllHardware())
        {
            if (hw.HardwareType == HardwareType.Cpu && cpuTemp is null)
            {
                try { hw.Update(); } catch (Exception ex) { Program.LogThrottled("safety-cpu", $"CPU update failed: {ex.Message}"); }
                cpuTemp = ReadCpuTemp(hw);
            }
            else if (GpuMonitor.IsGpu(hw) && gpuIds.Contains(SafeId(hw)))
            {
                try { hw.Update(); } catch (Exception ex) { Program.LogThrottled("safety-gpu", $"GPU update failed: {ex.Message}"); }
                var t = GpuMonitor.Map(hw);
                gpus[SafeId(hw)] = (t.HotspotTempC, t.TempC);
            }
        }
        return (cpuTemp, gpus);
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
    // CPU (CONTRACT §1.1.2, MF-9)

    private CpuTelemetry BaseCpu() => new()
    {
        Name = _static.CpuName ?? "Unknown CPU",
        Cores = _static.Cores,
        Threads = _static.Threads,
    };

    /// <summary>First present (positive) temperature of <see cref="CpuTempNames"/> on the CPU hardware, 1 decimal.</summary>
    internal static double? ReadCpuTemp(IHardware cpu) => Round(FindPositive(cpu, SensorType.Temperature, CpuTempNames));

    private CpuTelemetry MapCpu(IHardware? cpu)
    {
        var t = BaseCpu();
        if (cpu is null) return t;

        var name = SafeName(cpu);
        if (!string.IsNullOrWhiteSpace(name)) t.Name = name;

        // Total load.
        t.LoadTotal = Math.Clamp(RoundOr(FindValue(cpu, SensorType.Load, "CPU Total")), 0, 100);

        // Per PHYSICAL core: "CPU Core #n" or, with SMT, "CPU Core #n Thread #m" averaged per core.
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

        // Clock: "Cores (Average Effective)", else mean of "Core #n (Effective)", else mean of raw "Core #n".
        // A 0 reading means the value is not readable (no ring-0 access) and is treated as unavailable.
        var rawClocks = PositiveValues(cpu, SensorType.Clock, RawCoreClockRegex);
        double? clock = FindPositive(cpu, SensorType.Clock, "Cores (Average Effective)");
        if (!clock.HasValue)
        {
            var eff = PositiveValues(cpu, SensorType.Clock, EffectiveCoreClockRegex);
            if (eff.Count > 0) clock = eff.Average();
            else if (rawClocks.Count > 0) clock = rawClocks.Average();
        }
        t.ClockMhz = Round(clock);
        t.MaxClockMhz = rawClocks.Count > 0 ? Round(rawClocks.Max()) : null;

        t.PackageTempC = ReadCpuTemp(cpu);

        // Core voltage (3 decimals). Without the sensor driver LHM returns a fixed placeholder, so report null.
        t.Voltage = !Program.SensorDriverOk ? null : Round(FindPositive(cpu, SensorType.Voltage,
                              "Core (SVI2 TFN)", "Core (SVI3 TFN)", "CPU Core", "Core", "Core (SVI2)", "Core (SVI3)")
                          ?? FirstPositive(cpu, SensorType.Voltage), 3);

        // Package power.
        t.PowerW = Round(FindPositive(cpu, SensorType.Power, "Package", "CPU Package")
                         ?? FirstPositive(cpu, SensorType.Power));

        return t;
    }

    private static List<double> PositiveValues(IHardware hw, SensorType type, Regex nameRegex) =>
        OfType(hw, type)
            .Where(s => nameRegex.IsMatch((s.Name ?? "").Trim()))
            .Select(s => Finite(s.Value))
            .Where(v => v.HasValue && v.Value > 0)
            .Select(v => (double)v!.Value)
            .ToList();

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
        var status = NativeMethods.QueryMemoryStatus();

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
    // Disks (CONTRACT §1.1.3, MF-1)

    private DiskTelemetry MapDisk(IHardware hw)
    {
        var id = SafeId(hw);
        var name = SafeName(hw);
        var d = new DiskTelemetry { Id = id, Name = string.IsNullOrWhiteSpace(name) ? "Disk" : name };

        var smart = DriveHealth.ReadSmart(hw);
        d.DiskNumber = smart.DiskNumber;
        d.Serial = smart.Serial;

        var tempSensor = FindPositiveSensor(hw, SensorType.Temperature, "Composite Temperature", "Temperature", "Drive Temperature");
        if (tempSensor is not null)
        {
            d.TempC = Round(Positive(tempSensor.Value));
            d.TempMinC = Round(Positive(tempSensor.Min));
            d.TempMaxC = Round(Positive(tempSensor.Max));
        }

        var read = FindValue(hw, SensorType.Throughput, "Read Rate");
        var write = FindValue(hw, SensorType.Throughput, "Write Rate");
        d.ReadMBps = read.HasValue ? Round(Math.Max(0, read.Value / BytesPerMiB), 2) : null;
        d.WriteMBps = write.HasValue ? Round(Math.Max(0, write.Value / BytesPerMiB), 2) : null;

        d.HealthPct = Clamp(Round(smart.Life), 0, 100);
        d.PercentageUsed = smart.PercentageUsed;
        d.CriticalWarning = smart.CriticalWarning;
        d.AvailableSparePct = smart.AvailableSpare;
        d.AvailableSpareThresholdPct = smart.AvailableSpareThreshold;
        d.MediaErrors = smart.MediaErrors;
        d.UnsafeShutdowns = smart.UnsafeShutdowns;
        d.PowerCycles = smart.PowerCycles;
        d.ErrorLogEntries = smart.ErrorLogEntries;
        d.WarningTempC = smart.WarningTempC;
        d.CriticalTempC = smart.CriticalTempC;
        d.WarningTempMinutes = smart.WarningTempMinutes;
        d.CriticalTempMinutes = smart.CriticalTempMinutes;
        d.ReallocatedSectors = smart.Reallocated;
        d.PendingSectors = smart.Pending;
        d.UncorrectableSectors = smart.Uncorrectable;
        d.Tbw = smart.HostWritesGb.HasValue ? Round(smart.HostWritesGb.Value / 1024d, 2) : null;
        d.DataReadTb = smart.HostReadsGb.HasValue ? Round(smart.HostReadsGb.Value / 1024d, 2) : null;

        long? powerOnHours = smart.PowerOnHours;
        var win = _windowsDisks.Lookup(smart.Serial, smart.DiskNumber);
        if (win is not null)
        {
            powerOnHours ??= win.PowerOnHours;
            d.TempC ??= win.TempC;
        }
        d.PowerOnHours = powerOnHours;

        d.UsedPct = Clamp(Round(FindValue(hw, SensorType.Load, "Used Space")), 0, 100);

        d.Health = DriveHealth.Classify(new DriveHealth.Input
        {
            IsAdmin = Program.IsAdmin,
            Source = smart.Source,
            Life = d.HealthPct,
            PercentageUsed = d.PercentageUsed,
            PowerOnHours = d.PowerOnHours,
            CriticalWarning = d.CriticalWarning,
            AvailableSparePct = d.AvailableSparePct,
            AvailableSpareThresholdPct = d.AvailableSpareThresholdPct,
            ReallocatedSectors = d.ReallocatedSectors,
            PendingSectors = d.PendingSectors,
            UncorrectableSectors = d.UncorrectableSectors,
            WindowsHealth = win?.HealthStatus,
        });
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

    /// <summary>
    /// Closes the LHM Computer (unloads the driver). Caller restores fans first.
    /// <para>
    /// LHM's <c>SuperIOHardware.Close()</c> writes every fan control back to the register values this
    /// <b>process</b> captured before its first write. With <paramref name="restoreFans"/> false
    /// (failsafe, CONTRACT §1.5.4) those "defaults" are the stale manual duty left by a killed agent, so
    /// the Computer is not closed at all: the fans stay latched at 100% and the OS releases the driver
    /// handles at process exit.
    /// </para>
    /// </summary>
    public void Close(bool restoreFans = true)
    {
        if (_closed) return;
        _closed = true;
        _windowsDisks.Dispose();
        if (!_opened) return;
        if (!restoreFans)
        {
            Program.Log("Failsafe: leaving the hardware open so LHM does not restore stale fan values");
            return;
        }
        try
        {
            // Second chance for any restore LHM dropped (see IsaBusGuard).
            using var isa = IsaBusGuard.Acquire();
            _computer.Close();
        }
        catch (Exception ex) { Program.Log($"Computer.Close failed: {ex.Message}"); }
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
