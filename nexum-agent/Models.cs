using System.Text.Json.Serialization;

namespace NexumAgent;

// Wire DTOs for CONTRACT.md §1. Property names are pinned with [JsonPropertyName] so the
// output matches src-frontend/types.ts exactly regardless of naming-policy edge cases
// (e.g. "readMBps"). Nullable members are always written (null is never omitted).

internal sealed class HelloMessage
{
    [JsonPropertyName("type")] public string Type => "hello";
    [JsonPropertyName("version")] public string Version { get; init; } = Program.AgentVersion;
    [JsonPropertyName("isAdmin")] public bool IsAdmin { get; init; }
    [JsonPropertyName("pid")] public int Pid { get; init; }
}

internal sealed class AckMessage
{
    [JsonPropertyName("type")] public string Type => "ack";
    [JsonPropertyName("cmd")] public string Cmd { get; init; } = "";
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    [JsonPropertyName("message")] public string Message { get; init; } = "";
}

internal sealed class ErrorMessage
{
    [JsonPropertyName("type")] public string Type => "error";
    [JsonPropertyName("message")] public string Message { get; init; } = "";
}

internal sealed class TelemetryPacket
{
    [JsonPropertyName("type")] public string Type => "telemetry";
    [JsonPropertyName("ts")] public long Ts { get; set; }
    [JsonPropertyName("cpu")] public CpuTelemetry Cpu { get; set; } = new();
    [JsonPropertyName("gpu")] public GpuTelemetry? Gpu { get; set; }
    [JsonPropertyName("gpus")] public List<GpuTelemetry> Gpus { get; set; } = new();
    [JsonPropertyName("ram")] public RamTelemetry Ram { get; set; } = new();
    [JsonPropertyName("fans")] public List<FanTelemetry> Fans { get; set; } = new();
    [JsonPropertyName("disks")] public List<DiskTelemetry> Disks { get; set; } = new();
    [JsonPropertyName("network")] public NetworkTelemetry? Network { get; set; }
    [JsonPropertyName("fanPreset")] public string FanPreset { get; set; } = "auto";
}

internal sealed class CpuTelemetry
{
    [JsonPropertyName("name")] public string Name { get; set; } = "Unknown CPU";
    [JsonPropertyName("loadTotal")] public double LoadTotal { get; set; }
    [JsonPropertyName("loadPerCore")] public List<double> LoadPerCore { get; set; } = new();
    [JsonPropertyName("clockMhz")] public double? ClockMhz { get; set; }
    [JsonPropertyName("maxClockMhz")] public double? MaxClockMhz { get; set; }
    [JsonPropertyName("packageTempC")] public double? PackageTempC { get; set; }
    [JsonPropertyName("voltage")] public double? Voltage { get; set; }
    [JsonPropertyName("powerW")] public double? PowerW { get; set; }
    [JsonPropertyName("cores")] public int Cores { get; set; }
    [JsonPropertyName("threads")] public int Threads { get; set; }
}

internal sealed class GpuTelemetry
{
    [JsonPropertyName("name")] public string Name { get; set; } = "Unknown GPU";
    [JsonPropertyName("vendor")] public string Vendor { get; set; } = "unknown";
    [JsonPropertyName("load")] public double? Load { get; set; }
    [JsonPropertyName("vramUsedGb")] public double? VramUsedGb { get; set; }
    [JsonPropertyName("vramTotalGb")] public double? VramTotalGb { get; set; }
    [JsonPropertyName("coreClockMhz")] public double? CoreClockMhz { get; set; }
    [JsonPropertyName("memClockMhz")] public double? MemClockMhz { get; set; }
    [JsonPropertyName("tempC")] public double? TempC { get; set; }
    [JsonPropertyName("hotspotTempC")] public double? HotspotTempC { get; set; }
    [JsonPropertyName("powerW")] public double? PowerW { get; set; }
    [JsonPropertyName("fanRpm")] public double? FanRpm { get; set; }
    [JsonPropertyName("fanPct")] public double? FanPct { get; set; }
}

internal sealed class RamTelemetry
{
    [JsonPropertyName("usedGb")] public double UsedGb { get; set; }
    [JsonPropertyName("availableGb")] public double AvailableGb { get; set; }
    [JsonPropertyName("totalGb")] public double TotalGb { get; set; }
    [JsonPropertyName("loadPct")] public double LoadPct { get; set; }
    [JsonPropertyName("speedMts")] public int? SpeedMts { get; set; }
    [JsonPropertyName("formFactor")] public string? FormFactor { get; set; }
    [JsonPropertyName("slotsUsed")] public int? SlotsUsed { get; set; }
    [JsonPropertyName("slotsTotal")] public int? SlotsTotal { get; set; }
}

internal sealed class FanTelemetry
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("hardware")] public string Hardware { get; set; } = "";
    [JsonPropertyName("rpm")] public double Rpm { get; set; }
    [JsonPropertyName("controllable")] public bool Controllable { get; set; }
    [JsonPropertyName("controlPct")] public double? ControlPct { get; set; }
}

internal sealed class DiskTelemetry
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("tempC")] public double? TempC { get; set; }
    [JsonPropertyName("readMBps")] public double? ReadMBps { get; set; }
    [JsonPropertyName("writeMBps")] public double? WriteMBps { get; set; }
    [JsonPropertyName("healthPct")] public double? HealthPct { get; set; }
    [JsonPropertyName("tbw")] public double? Tbw { get; set; }
    [JsonPropertyName("powerOnHours")] public long? PowerOnHours { get; set; }
    [JsonPropertyName("usedPct")] public double? UsedPct { get; set; }
}

internal sealed class NetworkTelemetry
{
    [JsonPropertyName("downMBps")] public double DownMBps { get; set; }
    [JsonPropertyName("upMBps")] public double UpMBps { get; set; }
}
