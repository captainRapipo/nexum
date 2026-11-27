using System.Globalization;
using System.Management;
using System.Runtime.Intrinsics.X86;
using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.Hardware.Cpu;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// The agent part of the System view (CONTRACT §1.4): cpu, board, memory, gpus. Each section is
/// computed independently; a failing section becomes null ([] for gpus) plus an entry in errors.
/// LHM objects are read briefly under the hardware lock; all WMI work runs outside it.
/// </summary>
internal static class SystemSpec
{
    /// <summary>LHM facts captured under the hardware lock.</summary>
    internal sealed class LhmFacts
    {
        public string? CpuName;
        public uint[,]? CpuIdLeaves;
        public uint[,]? CpuIdExtLeaves;
        public string? SuperIo;
        public List<(string Vendor, string Name, double? VramGb)> Gpus = new();
    }

    /// <summary>Call while holding <see cref="TelemetryService.SyncRoot"/>. Cheap: no Update(), no WMI.</summary>
    public static LhmFacts CaptureLhm(TelemetryService svc)
    {
        var f = new LhmFacts();
        if (!svc.IsOpen) return f;
        foreach (var hw in svc.AllHardware())
        {
            try
            {
                switch (hw.HardwareType)
                {
                    case HardwareType.Cpu when f.CpuName is null:
                        f.CpuName = SafeName(hw);
                        if (hw is GenericCpu gc && gc.CpuId is { Length: > 0 } ids && ids[0] is { Length: > 0 } first && first[0] is not null)
                        {
                            f.CpuIdLeaves = first[0].Data;
                            f.CpuIdExtLeaves = first[0].ExtData;
                        }
                        break;
                    case HardwareType.SuperIO when f.SuperIo is null:
                        var n = SafeName(hw);
                        if (n.Length > 0) f.SuperIo = n;
                        break;
                    case HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel:
                        var mb = FindValue(hw, SensorType.SmallData, "GPU Memory Total");
                        f.Gpus.Add((GpuMonitor.VendorOf(hw.HardwareType), SafeName(hw),
                                    mb.HasValue && mb.Value > 0 ? Math.Round(mb.Value / 1024d, 1, MidpointRounding.AwayFromZero) : null));
                        break;
                }
            }
            catch (Exception ex)
            {
                Program.Log($"Spec: reading {SafeId(hw)} failed: {ex.Message}");
            }
        }
        return f;
    }

    /// <summary>Builds the spec reply. Runs on a background thread (WMI only).</summary>
    public static AgentSpecMessage Build(LhmFacts lhm, StaticInfo info)
    {
        var msg = new AgentSpecMessage { CapturedTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        try { msg.Cpu = BuildCpu(lhm, info); }
        catch (Exception ex) { msg.Errors.Add($"CPU query failed: {ex.Message}"); }
        try { msg.Board = BuildBoard(lhm); }
        catch (Exception ex) { msg.Errors.Add($"Board query failed: {ex.Message}"); }
        try { msg.Memory = BuildMemory(); }
        catch (Exception ex) { msg.Errors.Add($"Memory query failed: {ex.Message}"); }
        try { msg.Gpus = BuildGpus(lhm); }
        catch (Exception ex) { msg.Gpus = new(); msg.Errors.Add($"GPU query failed: {ex.Message}"); }
        return msg;
    }

    // ---------------------------------------------------------------------------------------------
    // CPU

    private static CpuSpecDto BuildCpu(LhmFacts lhm, StaticInfo info)
    {
        var (leaves, ext) = (lhm.CpuIdLeaves, lhm.CpuIdExtLeaves);
        if (leaves is null || leaves.GetLength(0) < 2) (leaves, ext) = ReadCpuIdDirect();

        string vendorString = VendorString(leaves);
        string vendor = vendorString switch
        {
            "AuthenticAMD" => "AMD",
            "GenuineIntel" => "Intel",
            _ => "Other",
        };

        uint eax1 = Leaf(leaves, 1, 0);
        int baseFamily = (int)((eax1 >> 8) & 0xF);
        int extFamily = (int)((eax1 >> 20) & 0xFF);
        int baseModel = (int)((eax1 >> 4) & 0xF);
        int extModel = (int)((eax1 >> 16) & 0xF);
        int stepping = (int)(eax1 & 0xF);
        int family = baseFamily == 0xF ? baseFamily + extFamily : baseFamily;
        int model = baseFamily == 0xF || (vendor == "Intel" && baseFamily == 6) ? (extModel << 4) + baseModel : baseModel;

        string? socket = null;
        int? baseClock = null;
        string? wmiName = null;
        using (var searcher = new ManagementObjectSearcher("SELECT Name, SocketDesignation, MaxClockSpeed FROM Win32_Processor"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    wmiName ??= Trimmed(mo["Name"]);
                    socket ??= Trimmed(mo["SocketDesignation"]);
                    var mhz = StaticInfo.ToLong(mo["MaxClockSpeed"]);
                    if (baseClock is null && mhz is > 0) baseClock = (int)mhz.Value;
                }
            }
        }

        var name = !string.IsNullOrWhiteSpace(lhm.CpuName) ? lhm.CpuName!.Trim() : wmiName ?? info.CpuName ?? "Unknown CPU";

        return new CpuSpecDto
        {
            Name = name,
            Vendor = vendor,
            Codename = Codename(vendor, family, model),
            Socket = string.IsNullOrEmpty(socket) ? null : socket,
            Family = family,
            Model = model,
            Stepping = stepping,
            Cores = info.Cores,
            Threads = info.Threads,
            BaseClockMhz = baseClock,
            Caches = BuildCaches(),
            Instructions = Instructions(leaves, ext, vendor),
        };
    }

    private static (uint[,] Leaves, uint[,] Ext) ReadCpuIdDirect()
    {
        if (!X86Base.IsSupported) throw new PlatformNotSupportedException("CPUID is not available");
        var (max, _, _, _) = X86Base.CpuId(0, 0);
        int n = (int)Math.Min((uint)max, 0x20);
        var leaves = new uint[n + 1, 4];
        for (int i = 0; i <= n; i++)
        {
            var (a, b, c, d) = X86Base.CpuId(i, 0);
            leaves[i, 0] = (uint)a; leaves[i, 1] = (uint)b; leaves[i, 2] = (uint)c; leaves[i, 3] = (uint)d;
        }
        var (maxExt, _, _, _) = X86Base.CpuId(unchecked((int)0x80000000), 0);
        int m = (int)Math.Min(Math.Max((uint)maxExt, 0x80000000u) - 0x80000000u, 0x20u);
        var ext = new uint[m + 1, 4];
        for (int i = 0; i <= m; i++)
        {
            var (a, b, c, d) = X86Base.CpuId(unchecked((int)(0x80000000u + (uint)i)), 0);
            ext[i, 0] = (uint)a; ext[i, 1] = (uint)b; ext[i, 2] = (uint)c; ext[i, 3] = (uint)d;
        }
        return (leaves, ext);
    }

    private static uint Leaf(uint[,]? data, int leaf, int reg) =>
        data is not null && leaf < data.GetLength(0) && reg < data.GetLength(1) ? data[leaf, reg] : 0u;

    private static string VendorString(uint[,]? leaves)
    {
        if (leaves is null || leaves.GetLength(0) < 1) return "";
        var bytes = new List<byte>(12);
        foreach (var reg in new[] { 1, 3, 2 }) bytes.AddRange(BitConverter.GetBytes(leaves[0, reg])); // EBX, EDX, ECX
        return System.Text.Encoding.ASCII.GetString(bytes.ToArray());
    }

    /// <summary>CPUID feature bits in the CONTRACT §1.4 order.</summary>
    internal static List<string> Instructions(uint[,]? leaves, uint[,]? ext, string vendor)
    {
        uint ecx1 = Leaf(leaves, 1, 2), edx1 = Leaf(leaves, 1, 3);
        uint ebx7 = leaves is not null && leaves.GetLength(0) > 7 ? Leaf(leaves, 7, 1) : 0u;
        uint ecxE1 = Leaf(ext, 1, 2), edxE1 = Leaf(ext, 1, 3);
        static bool Bit(uint r, int b) => ((r >> b) & 1) != 0;

        var list = new List<string>();
        void Add(string name, bool present) { if (present) list.Add(name); }
        Add("MMX", Bit(edx1, 23));
        Add("SSE", Bit(edx1, 25));
        Add("SSE2", Bit(edx1, 26));
        Add("SSE3", Bit(ecx1, 0));
        Add("SSSE3", Bit(ecx1, 9));
        Add("SSE4.1", Bit(ecx1, 19));
        Add("SSE4.2", Bit(ecx1, 20));
        Add("SSE4A", vendor == "AMD" && Bit(ecxE1, 6));
        Add("AES", Bit(ecx1, 25));
        Add("AVX", Bit(ecx1, 28));
        Add("AVX2", Bit(ebx7, 5));
        Add("AVX-512F", Bit(ebx7, 16));
        Add("FMA3", Bit(ecx1, 12));
        Add("SHA", Bit(ebx7, 29));
        Add("x86-64", Bit(edxE1, 29));
        Add("AMD-V", vendor == "AMD" && Bit(ecxE1, 2));
        Add("VT-x", Bit(ecx1, 5));
        return list;
    }

    /// <summary>
    /// Codename by (vendor, display family, display model). Only entries documented in the Linux kernel's
    /// x86 family/model tables (arch/x86/include/asm/intel-family.h, AMD family/model notes) are listed;
    /// ambiguous models (several products on one model number) are deliberately left out.
    /// </summary>
    internal static string? Codename(string vendor, int family, int model)
    {
        if (vendor == "AMD")
        {
            return (family, model) switch
            {
                (0x17, 0x01) => "Summit Ridge",
                (0x17, 0x08) => "Pinnacle Ridge",
                (0x17, 0x11) => "Raven Ridge",
                (0x17, 0x18) => "Picasso",
                (0x17, 0x60) => "Renoir",
                (0x17, 0x68) => "Lucienne",
                (0x17, 0x71) => "Matisse",
                (0x19, 0x21) => "Vermeer",
                (0x19, 0x44) => "Rembrandt",
                (0x19, 0x50) => "Cezanne",
                (0x19, 0x61) => "Raphael",
                (0x19, 0x74) => "Phoenix",
                (0x1A, 0x44) => "Granite Ridge",
                _ => null,
            };
        }
        if (vendor == "Intel" && family == 6)
        {
            return model switch
            {
                0x2A => "Sandy Bridge",
                0x3A => "Ivy Bridge",
                0x3C => "Haswell",
                0x3D => "Broadwell",
                0x5E => "Skylake",
                0xA5 => "Comet Lake",
                0xA7 => "Rocket Lake",
                0x8C => "Tiger Lake",
                0x97 => "Alder Lake",
                0x9A => "Alder Lake",
                0xB7 => "Raptor Lake",
                0xBA => "Raptor Lake",
                0xBF => "Raptor Lake",
                0xAA => "Meteor Lake",
                0xBD => "Lunar Lake",
                0xC6 => "Arrow Lake",
                _ => null,
            };
        }
        return null;
    }

    internal static List<CpuCacheSpecDto> BuildCaches()
    {
        var groups = new Dictionary<(int Level, string Type, long SizeKb, int? Ways), int>();
        foreach (var c in NativeMethods.QueryCaches())
        {
            string? type = c.Type switch
            {
                0 => "unified",
                1 => "instruction",
                2 => "data",
                _ => null, // 3 = CacheTrace, skipped
            };
            if (type is null || c.Level is < 1 or > 3) continue;
            int? ways = c.Associativity == 0xFF ? null : c.Associativity;
            var key = (c.Level, type, c.SizeBytes / 1024, ways);
            groups[key] = groups.TryGetValue(key, out var n) ? n + 1 : 1;
        }

        static int Order(int level, string type) => level switch
        {
            1 => type == "data" ? 0 : type == "instruction" ? 1 : 2,
            2 => 3,
            _ => 4,
        };

        return groups
            .OrderBy(kv => Order(kv.Key.Level, kv.Key.Type))
            .ThenByDescending(kv => kv.Key.SizeKb)
            .Select(kv => new CpuCacheSpecDto
            {
                Level = kv.Key.Level,
                Type = kv.Key.Type,
                SizeKb = kv.Key.SizeKb,
                Ways = kv.Key.Ways,
                Instances = kv.Value,
            })
            .ToList();
    }

    // ---------------------------------------------------------------------------------------------
    // Board

    private static BoardSpecDto BuildBoard(LhmFacts lhm)
    {
        var b = new BoardSpecDto { SuperIo = lhm.SuperIo };
        using (var searcher = new ManagementObjectSearcher("SELECT Manufacturer, Product, Version FROM Win32_BaseBoard"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    b.Manufacturer = Trimmed(mo["Manufacturer"]) ?? "";
                    b.Product = Trimmed(mo["Product"]) ?? "";
                    b.Version = Trimmed(mo["Version"]) ?? "";
                    break;
                }
            }
        }
        using (var searcher = new ManagementObjectSearcher("SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    b.BiosVendor = Trimmed(mo["Manufacturer"]) ?? "";
                    b.BiosVersion = Trimmed(mo["SMBIOSBIOSVersion"]) ?? "";
                    b.BiosDate = CimDate(mo["ReleaseDate"]) ?? "";
                    break;
                }
            }
        }
        return b;
    }

    // ---------------------------------------------------------------------------------------------
    // Memory

    private static readonly Regex BankChannel = new(@"CHANNEL\s*([A-H])", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex LocatorChannel = new(@"(?:DIMM|CHANNEL)[_\s-]*([A-H])\d?", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static MemorySpecDto BuildMemory()
    {
        var m = new MemorySpecDto();
        long totalBytes = 0;
        int? firstType = null;
        var channels = new HashSet<char>();
        bool channelsKnown = true;

        using (var searcher = new ManagementObjectSearcher(
                   "SELECT BankLabel, DeviceLocator, Manufacturer, PartNumber, Capacity, Speed, ConfiguredClockSpeed, Attributes, ConfiguredVoltage, FormFactor, SMBIOSMemoryType FROM Win32_PhysicalMemory"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    long cap = StaticInfo.ToLong(mo["Capacity"]) ?? 0;
                    if (cap <= 0) continue;
                    totalBytes += cap;
                    firstType ??= (int?)StaticInfo.ToLong(SafeGet(mo, "SMBIOSMemoryType"));

                    var bank = Trimmed(mo["BankLabel"]) ?? "";
                    var locator = Trimmed(mo["DeviceLocator"]) ?? "";
                    var ch = ParseChannel(bank, locator);
                    if (ch.HasValue) channels.Add(ch.Value);
                    else channelsKnown = false;

                    long? speed = StaticInfo.ToLong(mo["Speed"]);
                    long? configured = StaticInfo.ToLong(mo["ConfiguredClockSpeed"]);
                    long? ranks = StaticInfo.ToLong(SafeGet(mo, "Attributes"));
                    long? mv = StaticInfo.ToLong(SafeGet(mo, "ConfiguredVoltage"));
                    long? ff = StaticInfo.ToLong(mo["FormFactor"]);

                    m.Dimms.Add(new DimmSpecDto
                    {
                        Slot = locator,
                        Manufacturer = Trimmed(mo["Manufacturer"]) ?? "",
                        PartNumber = Trimmed(mo["PartNumber"]) ?? "",
                        SizeGb = Math.Round(cap / 1073741824d, 1, MidpointRounding.AwayFromZero),
                        SpeedMts = speed is > 0 and < 100_000 ? (int)speed.Value : null,
                        ConfiguredSpeedMts = configured is > 0 and < 100_000 ? (int)configured.Value : null,
                        Ranks = ranks is > 0 and < 64 ? (int)ranks.Value : null,
                        Voltage = mv is > 0 ? Math.Round(mv.Value / 1000d, 3) : null,
                        FormFactor = ff switch { 8 => "DIMM", 12 => "SODIMM", _ => "Other" },
                    });
                }
            }
        }

        m.TotalGb = Math.Round(totalBytes / 1073741824d, 1, MidpointRounding.AwayFromZero);
        m.SlotsUsed = m.Dimms.Count;
        m.Channels = m.Dimms.Count > 0 && channelsKnown ? channels.Count : null;
        m.Type = firstType switch
        {
            24 => "DDR3",
            26 => "DDR4",
            34 => "DDR5",
            30 => "LPDDR4",
            35 => "LPDDR5",
            _ => "Unknown",
        };

        long slots = 0;
        using (var searcher = new ManagementObjectSearcher("SELECT MemoryDevices, Use FROM Win32_PhysicalMemoryArray"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    if (StaticInfo.ToLong(mo["Use"]) == 3) slots += StaticInfo.ToLong(mo["MemoryDevices"]) ?? 0;
                }
            }
        }
        m.SlotsTotal = slots > 0 ? (int)slots : null;
        return m;
    }

    internal static char? ParseChannel(string bankLabel, string deviceLocator)
    {
        var b = BankChannel.Match(bankLabel);
        if (b.Success) return char.ToUpperInvariant(b.Groups[1].Value[0]);
        var l = LocatorChannel.Match(deviceLocator);
        if (l.Success) return char.ToUpperInvariant(l.Groups[1].Value[0]);
        return null;
    }

    // ---------------------------------------------------------------------------------------------
    // GPUs

    private static List<GpuSpecDto> BuildGpus(LhmFacts lhm)
    {
        var list = new List<GpuSpecDto>();
        var unused = new List<(string Vendor, string Name, double? VramGb)>(lhm.Gpus);
        using var searcher = new ManagementObjectSearcher("SELECT Name, PNPDeviceID, DriverVersion, DriverDate FROM Win32_VideoController");
        using var results = searcher.Get();
        foreach (ManagementObject mo in results)
        {
            using (mo)
            {
                var pnp = Trimmed(mo["PNPDeviceID"]) ?? "";
                if (!pnp.StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase)) continue;
                var name = Trimmed(mo["Name"]) ?? "";
                string vendor =
                    pnp.Contains("VEN_10DE", StringComparison.OrdinalIgnoreCase) ? "nvidia" :
                    pnp.Contains("VEN_1002", StringComparison.OrdinalIgnoreCase) ? "amd" :
                    pnp.Contains("VEN_8086", StringComparison.OrdinalIgnoreCase) ? "intel" : "unknown";

                // Match the LHM GPU: same vendor and same normalised name, else the only one of that vendor.
                int idx = unused.FindIndex(g => g.Vendor == vendor && Norm(g.Name) == Norm(name));
                if (idx < 0)
                {
                    var sameVendor = unused.Select((g, i) => (g, i)).Where(x => x.g.Vendor == vendor).ToList();
                    if (sameVendor.Count == 1) idx = sameVendor[0].i;
                }
                double? vram = null;
                if (idx >= 0)
                {
                    vram = unused[idx].VramGb;
                    unused.RemoveAt(idx);
                }

                var driverVersion = Trimmed(mo["DriverVersion"]);
                list.Add(new GpuSpecDto
                {
                    Name = name,
                    Vendor = vendor,
                    VramGb = vram,
                    DriverVersion = string.IsNullOrEmpty(driverVersion) ? null : driverVersion,
                    DriverDate = CimDate(mo["DriverDate"]),
                });
            }
        }
        return list;
    }

    // ---------------------------------------------------------------------------------------------

    private static object? SafeGet(ManagementBaseObject mo, string property)
    {
        try { return mo[property]; }
        catch (ManagementException) { return null; } // property missing on older Windows builds
    }

    private static string? Trimmed(object? o)
    {
        var s = o?.ToString()?.Trim();
        return string.IsNullOrEmpty(s) ? null : s;
    }

    private static string Norm(string s) =>
        new string(s.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    /// <summary>CIM datetime "yyyyMMddHHmmss.ffffff+zzz" → "YYYY-MM-DD"; null when unparseable.</summary>
    internal static string? CimDate(object? o)
    {
        var s = o?.ToString()?.Trim();
        if (string.IsNullOrEmpty(s) || s.Length < 8) return null;
        if (DateTime.TryParseExact(s[..8], "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
        {
            return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        return null;
    }
}
