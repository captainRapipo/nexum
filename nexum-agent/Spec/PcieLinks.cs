using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;

namespace NexumAgent.Spec;

/// <summary>
/// PCIe link facts for the System view (CONTRACT §1.4.1): GPU links (LHM ADL report, else the device's
/// DEVPKEY_PciDevice_* properties) and per-disk links. Read-only Configuration Manager / WMI queries.
/// </summary>
internal static class PcieLinks
{
    public const string RadeonSwitchNote =
        "Radeon cards sit behind an on-board PCIe switch; Windows may report the switch link, not the GPU link.";

    // ---------------------------------------------------------------------------------------------
    // LHM ADL report (AmdGpu.GetReport, LHM 0.9.6):
    //  - sections "OverdriveN Performance Status" and "Overdrive5 CurrentActivity", each with " Status: ADL_OK",
    //    " CurrentBusSpeed: n", " CurrentBusLanes: n", " MaximumBusLanes: n" (older GPUs; the OverdriveN one wins);
    //  - section "Performance Metrics" (ADL PMLog, RDNA3/RDNA4), lines " Sensor[ADL_PMLOG_BUS_SPEED].Value: n" and
    //    " Sensor[ADL_PMLOG_BUS_LANES].Value: n". On the reference rig (RX 9070 XT in a PCIe 4.0 x16 slot, where both
    //    OverdriveN/Overdrive5 sections return errors) PMLog reported BUS_SPEED 3 and BUS_LANES 16, while the GPU
    //    endpoint's DEVPKEY reported Gen 5 x16 (the on-board switch link). The PMLog speed is therefore read as a
    //    zero-based generation index (0 = Gen 1 … 3 = Gen 4), matching the real Gen 4 slot link.

    private static readonly string[] ReportSections = { "OverdriveN Performance Status", "Overdrive5 CurrentActivity" };

    /// <summary>Parses the GPU link from an LHM AMD GPU report; null when no section has a usable link.</summary>
    internal static PcieLinkDto? ParseAdlReport(string? report)
    {
        if (string.IsNullOrEmpty(report)) return null;
        var lines = report.Replace("\r", "").Split('\n');
        var od = ParseOverdriveSections(lines);
        var pm = ParsePmLog(lines);
        if (od is null) return pm;
        od.Gen ??= pm?.Gen;
        return od;
    }

    private static PcieLinkDto? ParsePmLog(string[] lines)
    {
        int? speed = null, lanes = null;
        foreach (var raw in lines)
        {
            var l = raw.Trim();
            if (TryField(l, "Sensor[ADL_PMLOG_BUS_SPEED].Value", out var a)) speed = ParseInt(a);
            else if (TryField(l, "Sensor[ADL_PMLOG_BUS_LANES].Value", out var b)) lanes = ParseInt(b);
        }
        int? gen = speed is >= 0 and <= 5 ? speed + 1 : null;
        int? width = lanes is >= 1 and <= 32 ? lanes : null;
        if (gen is null && width is null) return null;
        return new PcieLinkDto { Gen = gen, Width = width, MaxGen = null, MaxWidth = null, Source = "adl" };
    }

    private static PcieLinkDto? ParseOverdriveSections(string[] lines)
    {
        foreach (var section in ReportSections)
        {
            int start = Array.FindIndex(lines, l => l.Trim() == section);
            if (start < 0) continue;
            string? status = null;
            int? speed = null, lanes = null, maxLanes = null;
            for (int i = start + 1; i < lines.Length; i++)
            {
                var l = lines[i].Trim();
                if (l.Length > 0 && !lines[i].StartsWith(' ')) break; // next section header
                if (TryField(l, "Status", out var st)) status = st;
                else if (TryField(l, "CurrentBusSpeed", out var a)) speed = ParseInt(a);
                else if (TryField(l, "CurrentBusLanes", out var b)) lanes = ParseInt(b);
                else if (TryField(l, "MaximumBusLanes", out var c)) maxLanes = ParseInt(c);
            }
            if (status != "ADL_OK") continue;
            int? gen = GenFromAdlSpeed(speed);
            int? width = lanes is >= 1 and <= 32 ? lanes : null;
            int? maxWidth = maxLanes is >= 1 and <= 32 ? maxLanes : null;
            if (gen is null && width is null) continue;
            return new PcieLinkDto { Gen = gen, Width = width, MaxGen = null, MaxWidth = maxWidth, Source = "adl" };
        }
        return null;
    }

    private static bool TryField(string line, string name, out string value)
    {
        value = "";
        if (!line.StartsWith(name + ":", StringComparison.Ordinal)) return false;
        value = line[(name.Length + 1)..].Trim();
        return true;
    }

    private static int? ParseInt(string s) =>
        int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : null;

    /// <summary>
    /// ADL reports the bus speed either as a generation code (1..6) or as the transfer rate in MT/s
    /// (2500/5000/8000/16000/32000/64000), depending on the API generation. Anything else is unknown.
    /// </summary>
    internal static int? GenFromAdlSpeed(int? speed) => speed switch
    {
        >= 1 and <= 6 => speed,
        2500 => 1,
        5000 => 2,
        8000 => 3,
        16000 => 4,
        32000 => 5,
        64000 => 6,
        _ => null,
    };

    // ---------------------------------------------------------------------------------------------
    // DEVPKEY_PciDevice_* (devpkey.h): {3ab22e31-8264-4b4e-9af5-a8d2d8e33e62}, pid 9 CurrentLinkSpeed,
    // 10 CurrentLinkWidth, 11 MaxLinkSpeed, 12 MaxLinkWidth (DEVPROP_TYPE_UINT32). Speed codes 1..6 = Gen 1..6.

    private static readonly Guid PciDeviceKeys = new("3ab22e31-8264-4b4e-9af5-a8d2d8e33e62");

    /// <summary>Link of the device node with this PNP instance id; null when nothing is readable.</summary>
    internal static PcieLinkDto? FromDevpkey(string pnpDeviceId)
    {
        if (string.IsNullOrWhiteSpace(pnpDeviceId)) return null;
        if (!Cfg.Locate(pnpDeviceId, out uint dev)) return null;
        return LinkOfNode(dev);
    }

    private static PcieLinkDto? LinkOfNode(uint dev)
    {
        int? gen = GenFromCode(Cfg.GetUInt32(dev, PciDeviceKeys, 9));
        int? width = WidthOf(Cfg.GetUInt32(dev, PciDeviceKeys, 10));
        int? maxGen = GenFromCode(Cfg.GetUInt32(dev, PciDeviceKeys, 11));
        int? maxWidth = WidthOf(Cfg.GetUInt32(dev, PciDeviceKeys, 12));
        if (gen is null && width is null && maxGen is null && maxWidth is null) return null;
        return new PcieLinkDto { Gen = gen, Width = width, MaxGen = maxGen, MaxWidth = maxWidth, Source = "devpkey" };
    }

    internal static int? GenFromCode(uint? code) => code is >= 1 and <= 6 ? (int)code.Value : null;
    private static int? WidthOf(uint? w) => w is >= 1 and <= 32 ? (int)w.Value : null;

    /// <summary>
    /// GPU link: AMD prefers the ADL link from LHM's report; otherwise (and for other vendors) the device's
    /// devpkey link. An AMD devpkey link carries the on-board-switch caveat.
    /// </summary>
    public static PcieLinkDto? ForGpu(string vendor, string pnpDeviceId, PcieLinkDto? adlLink)
    {
        if (vendor == "amd" && adlLink is not null) return adlLink;
        var link = FromDevpkey(pnpDeviceId);
        if (link is not null && vendor == "amd") link.Note = RadeonSwitchNote;
        return link;
    }

    // ---------------------------------------------------------------------------------------------
    // Disks

    /// <summary>One entry per Win32_DiskDrive with an index (CONTRACT §1.4.1). No serials; PNP ids stay local.</summary>
    public static List<DiskLinkDto> BuildDiskLinks()
    {
        var busByDisk = MsftBusTypes();
        var list = new List<DiskLinkDto>();
        using var searcher = new ManagementObjectSearcher("SELECT Index, Model, InterfaceType, PNPDeviceID FROM Win32_DiskDrive");
        using var results = searcher.Get();
        foreach (ManagementObject mo in results)
        {
            using (mo)
            {
                var index = StaticInfo.ToLong(mo["Index"]);
                if (index is null or < 0) continue;
                var model = (mo["Model"]?.ToString() ?? "").Trim();
                var iface = (mo["InterfaceType"]?.ToString() ?? "").Trim();
                var pnp = (mo["PNPDeviceID"]?.ToString() ?? "").Trim();

                string bus = busByDisk.TryGetValue((int)index.Value, out var b) ? BusFromMsft(b) : BusFromWin32(iface, pnp);
                var d = new DiskLinkDto { DiskNumber = (int)index.Value, Model = model, Bus = bus };
                if (bus == "nvme")
                {
                    try
                    {
                        var link = ParentPciLink(pnp);
                        if (link is not null)
                        {
                            d.Gen = link.Gen;
                            d.Width = link.Width;
                            d.MaxGen = link.MaxGen;
                            d.MaxWidth = link.MaxWidth;
                        }
                    }
                    catch (Exception ex)
                    {
                        Program.Log($"Disk link {index}: {ex.Message}");
                    }
                }
                // SATA: the negotiated generation is not exposed by LHM 0.9.6 or MSFT_PhysicalDisk → sataGen null.
                list.Add(d);
            }
        }
        list.Sort((a, b) => a.DiskNumber.CompareTo(b.DiskNumber));
        return list;
    }

    /// <summary>MSFT_PhysicalDisk.DeviceId (disk number) → BusType. Empty when the Storage WMI namespace is unavailable.</summary>
    private static Dictionary<int, int> MsftBusTypes()
    {
        var map = new Dictionary<int, int>();
        try
        {
            var scope = new ManagementScope(@"\\.\root\Microsoft\Windows\Storage");
            using var searcher = new ManagementObjectSearcher(scope, new ObjectQuery("SELECT DeviceId, BusType FROM MSFT_PhysicalDisk"));
            using var results = searcher.Get();
            foreach (ManagementObject mo in results)
            {
                using (mo)
                {
                    if (int.TryParse(mo["DeviceId"]?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var id)
                        && StaticInfo.ToLong(mo["BusType"]) is long bt)
                    {
                        map[id] = (int)bt;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Program.Log($"MSFT_PhysicalDisk query failed: {ex.Message}");
        }
        return map;
    }

    /// <summary>STORAGE_BUS_TYPE: 17 NVMe, 11 SATA, 7 USB.</summary>
    internal static string BusFromMsft(int busType) => busType switch
    {
        17 => "nvme",
        11 => "sata",
        7 => "usb",
        _ => "other",
    };

    internal static string BusFromWin32(string interfaceType, string pnp)
    {
        if (pnp.Contains("NVME", StringComparison.OrdinalIgnoreCase)) return "nvme";
        if (interfaceType.Equals("USB", StringComparison.OrdinalIgnoreCase) || pnp.StartsWith(@"USBSTOR\", StringComparison.OrdinalIgnoreCase)) return "usb";
        if (interfaceType.Equals("IDE", StringComparison.OrdinalIgnoreCase)) return "sata";
        return "other";
    }

    /// <summary>Walks CM_Get_Parent from the disk devnode to the first PCI\ node and reads its link.</summary>
    private static PcieLinkDto? ParentPciLink(string diskPnp)
    {
        if (!Cfg.Locate(diskPnp, out uint dev)) return null;
        for (int depth = 0; depth < 8; depth++)
        {
            if (!Cfg.Parent(dev, out uint parent)) return null;
            var id = Cfg.InstanceId(parent);
            if (id is null) return null;
            if (id.StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase)) return LinkOfNode(parent);
            dev = parent;
        }
        return null;
    }

    /// <summary>cfgmgr32 read-only queries.</summary>
    private static class Cfg
    {
        private const int CR_SUCCESS = 0;
        private const uint CM_LOCATE_DEVNODE_NORMAL = 0;
        private const uint DEVPROP_TYPE_UINT32 = 7;

        [StructLayout(LayoutKind.Sequential)]
        private struct DEVPROPKEY
        {
            public Guid fmtid;
            public uint pid;
        }

        public static bool Locate(string instanceId, out uint devInst) =>
            CM_Locate_DevNodeW(out devInst, instanceId, CM_LOCATE_DEVNODE_NORMAL) == CR_SUCCESS;

        public static bool Parent(uint devInst, out uint parent) => CM_Get_Parent(out parent, devInst, 0) == CR_SUCCESS;

        public static string? InstanceId(uint devInst)
        {
            var buf = new char[512];
            return CM_Get_Device_IDW(devInst, buf, (uint)buf.Length, 0) == CR_SUCCESS
                ? new string(buf, 0, Array.IndexOf(buf, '\0') is var n and >= 0 ? n : buf.Length)
                : null;
        }

        public static uint? GetUInt32(uint devInst, Guid fmtid, uint pid)
        {
            var key = new DEVPROPKEY { fmtid = fmtid, pid = pid };
            uint size = 4;
            var data = new byte[4];
            int cr = CM_Get_DevNode_PropertyW(devInst, ref key, out uint type, data, ref size, 0);
            if (cr != CR_SUCCESS || type != DEVPROP_TYPE_UINT32 || size != 4) return null;
            return BitConverter.ToUInt32(data, 0);
        }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CM_Locate_DevNodeW(out uint pdnDevInst, string pDeviceID, uint ulFlags);

        [DllImport("cfgmgr32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CM_Get_Parent(out uint pdnDevInst, uint dnDevInst, uint ulFlags);

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CM_Get_Device_IDW(uint dnDevInst, [Out] char[] buffer, uint bufferLen, uint ulFlags);

        [DllImport("cfgmgr32.dll", ExactSpelling = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static extern int CM_Get_DevNode_PropertyW(uint dnDevInst, ref DEVPROPKEY propertyKey, out uint propertyType,
            [Out] byte[] propertyBuffer, ref uint propertyBufferSize, uint ulFlags);
    }
}
