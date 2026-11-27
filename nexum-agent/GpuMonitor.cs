using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>Maps LibreHardwareMonitor GPU hardware (NVIDIA / AMD / Intel) to <see cref="GpuTelemetry"/>.</summary>
internal static class GpuMonitor
{
    public static bool IsGpu(IHardware hw) => IsGpuType(hw.HardwareType);

    public static bool IsGpuType(HardwareType t) =>
        t is HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel;

    public static string VendorOf(HardwareType t) => t switch
    {
        HardwareType.GpuNvidia => "nvidia",
        HardwareType.GpuAmd => "amd",
        HardwareType.GpuIntel => "intel",
        _ => "unknown",
    };

    /// <summary>Builds telemetry for one GPU. Every field is null when the sensor is missing.</summary>
    public static GpuTelemetry Map(IHardware hw)
    {
        var t = new GpuTelemetry
        {
            Name = string.IsNullOrWhiteSpace(SafeName(hw)) ? "Unknown GPU" : SafeName(hw),
            Vendor = VendorOf(hw.HardwareType),
        };

        // Load: dedicated GPUs expose "GPU Core"; Intel/iGPUs often only expose D3D engine loads.
        var load = FindValue(hw, SensorType.Load, "GPU Core", "D3D 3D", "GPU 3D")
                   ?? FindValueContaining(hw, SensorType.Load, "3D");
        t.Load = Clamp(Round(load), 0, 100);

        // VRAM (SmallData values are MB).
        var usedMb = FindValue(hw, SensorType.SmallData, "GPU Memory Used", "D3D Dedicated Memory Used");
        var totalMb = FindValue(hw, SensorType.SmallData, "GPU Memory Total", "D3D Dedicated Memory Total");
        if (!totalMb.HasValue)
        {
            var freeMb = FindValue(hw, SensorType.SmallData, "GPU Memory Free", "D3D Dedicated Memory Free");
            if (usedMb.HasValue && freeMb.HasValue) totalMb = usedMb.Value + freeMb.Value;
        }
        t.VramUsedGb = usedMb.HasValue ? Round(usedMb.Value / 1024d) : null;
        t.VramTotalGb = totalMb.HasValue && totalMb.Value > 0 ? Round(totalMb.Value / 1024d) : null;

        // Clocks (MHz).
        t.CoreClockMhz = Round(FindPositive(hw, SensorType.Clock, "GPU Core", "GPU Shader"));
        t.MemClockMhz = Round(FindPositive(hw, SensorType.Clock, "GPU Memory"));

        // Temperatures.
        t.TempC = Round(FindPositive(hw, SensorType.Temperature, "GPU Core", "GPU Temperature")
                        ?? FirstPositive(hw, SensorType.Temperature));
        t.HotspotTempC = Round(FindPositive(hw, SensorType.Temperature, "GPU Hot Spot", "GPU Hotspot"));

        // Power (W).
        t.PowerW = Round(FindValue(hw, SensorType.Power,
                             "GPU Package", "GPU Power", "GPU Board Power", "GPU Total", "GPU PPT")
                         ?? FirstValue(hw, SensorType.Power));

        // Fan RPM + duty.
        t.FanRpm = Round(FindValue(hw, SensorType.Fan, "GPU Fan", "GPU Fan 1", "GPU Fan #1")
                         ?? FirstValue(hw, SensorType.Fan));
        t.FanPct = Clamp(Round(FindValue(hw, SensorType.Control, "GPU Fan", "GPU Fan 1", "GPU Fan #1")
                               ?? FirstValue(hw, SensorType.Control)), 0, 100);

        return t;
    }

    /// <summary>
    /// Primary GPU = first discrete GPU (NVIDIA, then discrete AMD) else the first GPU.
    /// AMD integrated Radeon graphics are reported as GpuAmd, so they are ranked below
    /// AMD cards that look discrete ("RX"/"PRO" in the name, or ≥ 2 GB dedicated VRAM).
    /// </summary>
    public static int SelectPrimaryIndex(IReadOnlyList<(HardwareType Type, GpuTelemetry Telemetry)> gpus)
    {
        if (gpus.Count == 0) return -1;

        int best = -1, bestScore = int.MinValue;
        for (int i = 0; i < gpus.Count; i++)
        {
            int score = Score(gpus[i].Type, gpus[i].Telemetry);
            if (score > bestScore)
            {
                bestScore = score;
                best = i;
            }
        }
        return best;
    }

    private static int Score(HardwareType type, GpuTelemetry t)
    {
        var name = t.Name ?? "";
        switch (type)
        {
            case HardwareType.GpuNvidia:
                return 300;
            case HardwareType.GpuAmd:
                bool looksDiscrete =
                    name.Contains(" RX ", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("Radeon Pro", StringComparison.OrdinalIgnoreCase) ||
                    name.Contains("Radeon VII", StringComparison.OrdinalIgnoreCase) ||
                    (t.VramTotalGb ?? 0) >= 2.0;
                return looksDiscrete ? 250 : 150;
            case HardwareType.GpuIntel:
                // Intel Arc A/B-series cards are discrete; "Intel Arc Graphics" (no model) is an iGPU.
                bool arcDiscrete = System.Text.RegularExpressions.Regex.IsMatch(
                    name, @"Arc\S*\s+[AB]\d{3}", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                return arcDiscrete ? 200 : 100;
            default:
                return 0;
        }
    }
}
