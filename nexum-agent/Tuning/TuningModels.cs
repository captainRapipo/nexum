using System.Text.Json.Serialization;

namespace NexumAgent.Tuning;

// Wire DTOs for CONTRACT §1.7.3 / §1.7.4 (types.ts TuningState, TuningRange, TuningCaps, TuningRanges,
// TuningCurrent). Serialized by Program.Emit (camelCase, nulls written); names are pinned so the output
// matches types.ts exactly. Read-only data: nothing in this file (or in Tuning/**) changes GPU settings.

/// <summary><c>{"type":"tuningState", …}</c> (CONTRACT §1.7.3).</summary>
public sealed class TuningStateMessage
{
    public const string MsgSupported = "Read-only. Nexum does not change GPU settings in this version.";
    public const string MsgNotElevated = "GPU tuning data needs administrator rights.";
    public const string MsgNoAmdGpu = "No AMD Radeon GPU was found.";
    public const string MsgAdlMissing = "The AMD driver's ADL library was not found.";
    public const string MsgOdUnsupported = "This GPU does not report Overdrive 8 tuning data.";

    /// <summary>Exact text for reason <c>adlError</c>: "The AMD driver returned an error (&lt;code&gt;)."</summary>
    public static string MsgAdlError(string code) => $"The AMD driver returned an error ({code}).";

    [JsonPropertyName("type")] public string Type => "tuningState";
    [JsonPropertyName("ts")] public long Ts { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    [JsonPropertyName("gpuIndex")] public int GpuIndex { get; set; }
    [JsonPropertyName("adapterName")] public string? AdapterName { get; set; }
    [JsonPropertyName("backend")] public string Backend => "adl-od8";
    [JsonPropertyName("supported")] public bool Supported { get; set; }
    /// <summary>"notElevated" | "noAmdGpu" | "adlMissing" | "odUnsupported" | "adlError" | null.</summary>
    [JsonPropertyName("reason")] public string? Reason { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("odVersion")] public int? OdVersion { get; set; }
    [JsonPropertyName("caps")] public TuningCapsDto Caps { get; set; } = new();
    [JsonPropertyName("ranges")] public TuningRangesDto Ranges { get; set; } = new();
    [JsonPropertyName("current")] public TuningCurrentDto Current { get; set; } = new();
    [JsonPropertyName("isFactory")] public bool? IsFactory { get; set; }
    /// <summary>"factory" | "custom" | "autoUndervolt" | "unknown".</summary>
    [JsonPropertyName("mode")] public string Mode { get; set; } = "unknown";
    [JsonPropertyName("powerMode")] public string? PowerMode { get; set; }
    [JsonPropertyName("vpuRecoveryCount")] public int? VpuRecoveryCount { get; set; }

    /// <summary>supported:false state: caps all false, ranges/current all null, isFactory null, mode "unknown".</summary>
    public static TuningStateMessage Unsupported(string reason, string message, string? adapterName = null, int? odVersion = null, int gpuIndex = 0) => new()
    {
        Supported = false,
        Reason = reason,
        Message = message,
        AdapterName = adapterName,
        OdVersion = odVersion,
        GpuIndex = gpuIndex,
        IsFactory = null,
        Mode = "unknown",
    };
}

public sealed class TuningCapsDto
{
    [JsonPropertyName("powerLimit")] public bool PowerLimit { get; set; }
    [JsonPropertyName("autoUndervolt")] public bool AutoUndervolt { get; set; }
    [JsonPropertyName("fanCurve")] public bool FanCurve { get; set; }
    [JsonPropertyName("zeroRpm")] public bool ZeroRpm { get; set; }
    [JsonPropertyName("voltageOffset")] public bool VoltageOffset { get; set; }
    [JsonPropertyName("gfxClockMax")] public bool GfxClockMax { get; set; }
    [JsonPropertyName("memClockMax")] public bool MemClockMax { get; set; }
}

public sealed class TuningRangeDto
{
    [JsonPropertyName("min")] public double Min { get; set; }
    [JsonPropertyName("max")] public double Max { get; set; }
    [JsonPropertyName("step")] public double Step { get; set; } = 1;
    [JsonPropertyName("default")] public double? Default { get; set; }
}

public sealed class TuningRangesDto
{
    [JsonPropertyName("powerPct")] public TuningRangeDto? PowerPct { get; set; }
    [JsonPropertyName("voltageOffsetMv")] public TuningRangeDto? VoltageOffsetMv { get; set; }
    [JsonPropertyName("gfxClockMaxMhz")] public TuningRangeDto? GfxClockMaxMhz { get; set; }
    [JsonPropertyName("memClockMaxMhz")] public TuningRangeDto? MemClockMaxMhz { get; set; }
    [JsonPropertyName("fanCurveTempC")] public TuningRangeDto? FanCurveTempC { get; set; }
    [JsonPropertyName("fanCurvePct")] public TuningRangeDto? FanCurvePct { get; set; }
}

public sealed class FanCurvePointDto
{
    [JsonPropertyName("tempC")] public double TempC { get; set; }
    [JsonPropertyName("pct")] public double Pct { get; set; }
}

public sealed class TuningCurrentDto
{
    [JsonPropertyName("powerPct")] public double? PowerPct { get; set; }
    [JsonPropertyName("autoUndervolt")] public bool? AutoUndervolt { get; set; }
    [JsonPropertyName("zeroRpm")] public bool? ZeroRpm { get; set; }
    [JsonPropertyName("voltageOffsetMv")] public double? VoltageOffsetMv { get; set; }
    [JsonPropertyName("gfxClockMaxMhz")] public double? GfxClockMaxMhz { get; set; }
    [JsonPropertyName("memClockMaxMhz")] public double? MemClockMaxMhz { get; set; }
    [JsonPropertyName("fanCurve")] public List<FanCurvePointDto>? FanCurve { get; set; }
}

/// <summary><c>{"type":"tuningProbe", …}</c> (CONTRACT §1.7.4). Always <c>write:false</c> in this version.</summary>
public sealed class TuningProbeMessage
{
    public const string MsgOk = "Read-only probe finished.";
    public const string MsgNothingRead = "The read-only probe could not read any tuning data.";

    [JsonPropertyName("type")] public string Type => "tuningProbe";
    [JsonPropertyName("ts")] public long Ts { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    [JsonPropertyName("write")] public bool Write => false;
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("report")] public TuningProbeReport Report { get; set; } = new();
}

/// <summary>Raw tables for the owner's ROADMAP §5.3 question list. No serials, no hostnames, no device instance ids.</summary>
public sealed class TuningProbeReport
{
    [JsonPropertyName("agentVersion")] public string AgentVersion { get; set; } = Program.AgentVersion;
    [JsonPropertyName("adapters")] public List<ProbeAdapter> Adapters { get; set; } = new();
    [JsonPropertyName("odVersion")] public int? OdVersion { get; set; }
    [JsonPropertyName("capsBits")] public int? CapsBits { get; set; }
    [JsonPropertyName("initTable")] public List<ProbeInitEntry> InitTable { get; set; } = new();
    [JsonPropertyName("currentTable")] public List<ProbeCurrentEntry> CurrentTable { get; set; } = new();
    [JsonPropertyName("vpuRecoveryCount")] public int? VpuRecoveryCount { get; set; }
    [JsonPropertyName("state")] public TuningStateMessage State { get; set; } = new();
    [JsonPropertyName("errors")] public List<string> Errors { get; set; } = new();
    /// <summary>
    /// Plain-language plausibility checks of the tables (ranges ordered, defaults and current values inside their
    /// ranges, fan curve ordered, zero-RPM stop temperature exposed). Informational; additive to §1.7.4.
    /// </summary>
    [JsonPropertyName("checks")] public List<string> Checks { get; set; } = new();
}

public sealed class ProbeAdapter
{
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("busNumber")] public int BusNumber { get; set; }
    [JsonPropertyName("active")] public bool? Active { get; set; }
    [JsonPropertyName("vendorId")] public int VendorId { get; set; }
}

public sealed class ProbeInitEntry
{
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("featureName")] public string? FeatureName { get; set; }
    [JsonPropertyName("min")] public int Min { get; set; }
    [JsonPropertyName("max")] public int Max { get; set; }
    [JsonPropertyName("defaultValue")] public int DefaultValue { get; set; }
}

public sealed class ProbeCurrentEntry
{
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("featureName")] public string? FeatureName { get; set; }
    [JsonPropertyName("value")] public int Value { get; set; }
}
