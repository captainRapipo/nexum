using System.Text.Json.Serialization;

namespace NexumAgent;

// Wire DTOs for CONTRACT.md §1 (protocol 2). Property names are pinned with [JsonPropertyName] so the
// output matches src-frontend/types.ts exactly regardless of naming-policy edge cases
// (e.g. "readMBps"). Nullable members are always written (null is never omitted).

internal sealed class HelloMessage
{
    [JsonPropertyName("type")] public string Type => "hello";
    [JsonPropertyName("version")] public string Version { get; init; } = Program.AgentVersion;
    [JsonPropertyName("protocol")] public int Protocol => Program.ProtocolVersion;
    [JsonPropertyName("isAdmin")] public bool IsAdmin { get; init; }
    [JsonPropertyName("pid")] public int Pid { get; init; }
    [JsonPropertyName("sensorDriver")] public SensorDriverStatus SensorDriver { get; init; } = new();
    /// <summary>"none" | "interrupted" | "previousBoot" (CONTRACT §1.5.3).</summary>
    [JsonPropertyName("fanFlag")] public string FanFlag { get; init; } = "none";
}

internal sealed class SensorDriverStatus
{
    /// <summary>"pawnio" | "none".</summary>
    [JsonPropertyName("kind")] public string Kind { get; init; } = "none";
    [JsonPropertyName("version")] public string? Version { get; init; }
    [JsonPropertyName("minVersion")] public string MinVersion { get; init; } = "2.1.0";
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    /// <summary>"missing" | "outdated" | "notElevated" | null.</summary>
    [JsonPropertyName("reason")] public string? Reason { get; init; }
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
    [JsonPropertyName("fanSafety")] public FanSafetyTelemetry FanSafety { get; set; } = new();

    /// <summary>Not serialized: hardware id of each GPU in <see cref="Gpus"/> (same order), for the fan override.</summary>
    [JsonIgnore] public List<string> GpuHwIds { get; set; } = new();
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
    [JsonPropertyName("hwId")] public string HwId { get; set; } = "";
    [JsonPropertyName("rpm")] public double Rpm { get; set; }
    [JsonPropertyName("rpmMin")] public double? RpmMin { get; set; }
    [JsonPropertyName("rpmMax")] public double? RpmMax { get; set; }
    [JsonPropertyName("controllable")] public bool Controllable { get; set; }
    [JsonPropertyName("controlPct")] public double? ControlPct { get; set; }
}

internal sealed class DriveHealthDto
{
    /// <summary>"good" | "attention" | "replace" | "failing" | "unknown".</summary>
    [JsonPropertyName("state")] public string State { get; set; } = "unknown";
    [JsonPropertyName("label")] public string Label { get; set; } = "";
    [JsonPropertyName("reason")] public string Reason { get; set; } = "";
    /// <summary>"nvme" | "smart" | "none".</summary>
    [JsonPropertyName("source")] public string Source { get; set; } = "none";
}

internal sealed class DiskTelemetry
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("diskNumber")] public int? DiskNumber { get; set; }
    [JsonPropertyName("serial")] public string? Serial { get; set; }
    [JsonPropertyName("tempC")] public double? TempC { get; set; }
    [JsonPropertyName("tempMinC")] public double? TempMinC { get; set; }
    [JsonPropertyName("tempMaxC")] public double? TempMaxC { get; set; }
    [JsonPropertyName("readMBps")] public double? ReadMBps { get; set; }
    [JsonPropertyName("writeMBps")] public double? WriteMBps { get; set; }
    [JsonPropertyName("healthPct")] public double? HealthPct { get; set; }
    [JsonPropertyName("tbw")] public double? Tbw { get; set; }
    [JsonPropertyName("powerOnHours")] public long? PowerOnHours { get; set; }
    [JsonPropertyName("usedPct")] public double? UsedPct { get; set; }
    [JsonPropertyName("health")] public DriveHealthDto Health { get; set; } = new();
    [JsonPropertyName("criticalWarning")] public long? CriticalWarning { get; set; }
    [JsonPropertyName("availableSparePct")] public double? AvailableSparePct { get; set; }
    [JsonPropertyName("availableSpareThresholdPct")] public double? AvailableSpareThresholdPct { get; set; }
    [JsonPropertyName("percentageUsed")] public double? PercentageUsed { get; set; }
    [JsonPropertyName("mediaErrors")] public long? MediaErrors { get; set; }
    [JsonPropertyName("unsafeShutdowns")] public long? UnsafeShutdowns { get; set; }
    [JsonPropertyName("powerCycles")] public long? PowerCycles { get; set; }
    [JsonPropertyName("errorLogEntries")] public long? ErrorLogEntries { get; set; }
    [JsonPropertyName("warningTempC")] public double? WarningTempC { get; set; }
    [JsonPropertyName("criticalTempC")] public double? CriticalTempC { get; set; }
    [JsonPropertyName("warningTempMinutes")] public long? WarningTempMinutes { get; set; }
    [JsonPropertyName("criticalTempMinutes")] public long? CriticalTempMinutes { get; set; }
    [JsonPropertyName("reallocatedSectors")] public long? ReallocatedSectors { get; set; }
    [JsonPropertyName("pendingSectors")] public long? PendingSectors { get; set; }
    [JsonPropertyName("uncorrectableSectors")] public long? UncorrectableSectors { get; set; }
    [JsonPropertyName("dataReadTb")] public double? DataReadTb { get; set; }
}

internal sealed class NetworkTelemetry
{
    [JsonPropertyName("downMBps")] public double DownMBps { get; set; }
    [JsonPropertyName("upMBps")] public double UpMBps { get; set; }
}

internal sealed class FanSafetyTelemetry
{
    [JsonPropertyName("manualActive")] public bool ManualActive { get; set; }
    [JsonPropertyName("overrideActive")] public bool OverrideActive { get; set; }
    /// <summary>"failsafe" | "sensorMissing" | "cpuTemp" | "gpuTemp" | null.</summary>
    [JsonPropertyName("reason")] public string? Reason { get; set; }
    [JsonPropertyName("failsafe")] public bool Failsafe { get; set; }
    [JsonPropertyName("triggerC")] public double TriggerC { get; set; } = FanSafety.CpuTriggerC;
    [JsonPropertyName("releaseC")] public double ReleaseC { get; set; } = FanSafety.CpuReleaseC;
}

// ── Sensors view (CONTRACT §1.3) ──

internal sealed class SensorTreeMessage
{
    [JsonPropertyName("type")] public string Type => "sensorTree";
    [JsonPropertyName("rev")] public int Rev { get; init; }
    [JsonPropertyName("sessionStartTs")] public long SessionStartTs { get; init; }
    [JsonPropertyName("hardware")] public List<HardwareNodeDto> Hardware { get; init; } = new();
}

internal sealed class HardwareNodeDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("parentId")] public string? ParentId { get; init; }
    [JsonPropertyName("kind")] public string Kind { get; init; } = "other";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("sensors")] public List<SensorMetaDto> Sensors { get; init; } = new();
}

internal sealed class SensorMetaDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("idx")] public int Idx { get; init; }
    [JsonPropertyName("hwId")] public string HwId { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("kind")] public string Kind { get; init; } = "";
    [JsonPropertyName("unit")] public string Unit { get; init; } = "";
    [JsonPropertyName("decimals")] public int Decimals { get; init; }
    [JsonPropertyName("static")] public bool Static { get; init; }
    [JsonPropertyName("defaultHidden")] public bool DefaultHidden { get; init; }
}

internal sealed class SensorValuesMessage
{
    [JsonPropertyName("type")] public string Type => "sensorValues";
    [JsonPropertyName("ts")] public long Ts { get; init; }
    [JsonPropertyName("rev")] public int Rev { get; init; }
    [JsonPropertyName("value")] public double?[] Value { get; init; } = Array.Empty<double?>();
    [JsonPropertyName("min")] public double?[] Min { get; init; } = Array.Empty<double?>();
    [JsonPropertyName("max")] public double?[] Max { get; init; } = Array.Empty<double?>();
    [JsonPropertyName("avg")] public double?[] Avg { get; init; } = Array.Empty<double?>();
}

// ── System spec (CONTRACT §1.4) ──

internal sealed class AgentSpecMessage
{
    [JsonPropertyName("type")] public string Type => "spec";
    [JsonPropertyName("capturedTs")] public long CapturedTs { get; set; }
    [JsonPropertyName("cpu")] public CpuSpecDto? Cpu { get; set; }
    [JsonPropertyName("board")] public BoardSpecDto? Board { get; set; }
    [JsonPropertyName("memory")] public MemorySpecDto? Memory { get; set; }
    [JsonPropertyName("gpus")] public List<GpuSpecDto> Gpus { get; set; } = new();
    [JsonPropertyName("errors")] public List<string> Errors { get; set; } = new();
}

internal sealed class CpuCacheSpecDto
{
    [JsonPropertyName("level")] public int Level { get; set; }
    /// <summary>"data" | "instruction" | "unified".</summary>
    [JsonPropertyName("type")] public string Type { get; set; } = "unified";
    [JsonPropertyName("sizeKb")] public long SizeKb { get; set; }
    [JsonPropertyName("ways")] public int? Ways { get; set; }
    [JsonPropertyName("instances")] public int Instances { get; set; }
}

internal sealed class CpuSpecDto
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    /// <summary>"AMD" | "Intel" | "Other".</summary>
    [JsonPropertyName("vendor")] public string Vendor { get; set; } = "Other";
    [JsonPropertyName("codename")] public string? Codename { get; set; }
    [JsonPropertyName("socket")] public string? Socket { get; set; }
    [JsonPropertyName("family")] public int Family { get; set; }
    [JsonPropertyName("model")] public int Model { get; set; }
    [JsonPropertyName("stepping")] public int Stepping { get; set; }
    [JsonPropertyName("cores")] public int Cores { get; set; }
    [JsonPropertyName("threads")] public int Threads { get; set; }
    [JsonPropertyName("baseClockMhz")] public int? BaseClockMhz { get; set; }
    [JsonPropertyName("caches")] public List<CpuCacheSpecDto> Caches { get; set; } = new();
    [JsonPropertyName("instructions")] public List<string> Instructions { get; set; } = new();
}

internal sealed class BoardSpecDto
{
    [JsonPropertyName("manufacturer")] public string Manufacturer { get; set; } = "";
    [JsonPropertyName("product")] public string Product { get; set; } = "";
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("biosVendor")] public string BiosVendor { get; set; } = "";
    [JsonPropertyName("biosVersion")] public string BiosVersion { get; set; } = "";
    [JsonPropertyName("biosDate")] public string BiosDate { get; set; } = "";
    [JsonPropertyName("superIo")] public string? SuperIo { get; set; }
}

internal sealed class DimmSpecDto
{
    [JsonPropertyName("slot")] public string Slot { get; set; } = "";
    [JsonPropertyName("manufacturer")] public string Manufacturer { get; set; } = "";
    [JsonPropertyName("partNumber")] public string PartNumber { get; set; } = "";
    [JsonPropertyName("sizeGb")] public double SizeGb { get; set; }
    [JsonPropertyName("speedMts")] public int? SpeedMts { get; set; }
    [JsonPropertyName("configuredSpeedMts")] public int? ConfiguredSpeedMts { get; set; }
    [JsonPropertyName("ranks")] public int? Ranks { get; set; }
    [JsonPropertyName("voltage")] public double? Voltage { get; set; }
    [JsonPropertyName("formFactor")] public string FormFactor { get; set; } = "Other";
}

internal sealed class MemorySpecDto
{
    /// <summary>"DDR3" | "DDR4" | "DDR5" | "LPDDR4" | "LPDDR5" | "Unknown".</summary>
    [JsonPropertyName("type")] public string Type { get; set; } = "Unknown";
    [JsonPropertyName("totalGb")] public double TotalGb { get; set; }
    [JsonPropertyName("channels")] public int? Channels { get; set; }
    [JsonPropertyName("slotsUsed")] public int SlotsUsed { get; set; }
    [JsonPropertyName("slotsTotal")] public int? SlotsTotal { get; set; }
    [JsonPropertyName("dimms")] public List<DimmSpecDto> Dimms { get; set; } = new();
    // v1.0 constants (CONTRACT §1.4).
    [JsonPropertyName("timings")] public object? Timings => null;
    [JsonPropertyName("timingsSource")] public string TimingsSource => "unavailable";
    [JsonPropertyName("xmp")] public object? Xmp => null;
}

internal sealed class GpuSpecDto
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    /// <summary>"nvidia" | "amd" | "intel" | "unknown".</summary>
    [JsonPropertyName("vendor")] public string Vendor { get; set; } = "unknown";
    [JsonPropertyName("vramGb")] public double? VramGb { get; set; }
    [JsonPropertyName("driverVersion")] public string? DriverVersion { get; set; }
    [JsonPropertyName("driverDate")] public string? DriverDate { get; set; }
}
