using System.Text.Json.Serialization;

namespace NexumAgent.Frames;

// Wire DTOs for CONTRACT §1.6 (frame capture). Names are pinned with [JsonPropertyName] so the output
// matches src-frontend/types.ts (FrameSession, FrameTarget, FrameStats, PresentingList) exactly.
// Nullable members are always written (Program's serializer never omits nulls).

internal sealed class FrameSignature
{
    /// <summary>"valid" | "invalid" | "untrusted" | "notChecked".</summary>
    [JsonPropertyName("status")] public string Status { get; init; } = "notChecked";
    /// <summary>Leaf signer subject CN, e.g. "Intel Corporation".</summary>
    [JsonPropertyName("signer")] public string? Signer { get; init; }
    [JsonPropertyName("sha256Match")] public bool? Sha256Match { get; init; }

    public static readonly FrameSignature NotChecked = new();
}

internal sealed class FrameSessionMessage
{
    [JsonPropertyName("type")] public string Type => "frameSession";
    /// <summary>"stopped" | "starting" | "running" | "error".</summary>
    [JsonPropertyName("state")] public string State { get; init; } = "stopped";
    /// <summary>FrameSessionCode, only with state "error".</summary>
    [JsonPropertyName("code")] public string? Code { get; init; }
    [JsonPropertyName("message")] public string Message { get; init; } = "";
    [JsonPropertyName("backend")] public string Backend => "presentmon-console";
    [JsonPropertyName("backendVersion")] public string BackendVersion => PresentMonTrust.BackendVersion;
    [JsonPropertyName("sessionName")] public string SessionName => PresentMonTrust.SessionName;
    [JsonPropertyName("signature")] public FrameSignature Signature { get; init; } = FrameSignature.NotChecked;
    [JsonPropertyName("childPid")] public int? ChildPid { get; init; }
    [JsonPropertyName("sinceTs")] public long SinceTs { get; init; }
}

internal sealed class FrameTargetMessage
{
    [JsonPropertyName("type")] public string Type => "frameTarget";
    [JsonPropertyName("pid")] public int? Pid { get; init; }
    [JsonPropertyName("process")] public string? Process { get; init; }
    [JsonPropertyName("windowTitle")] public string? WindowTitle { get; init; }
    /// <summary>"foreground" | "manual" | "none".</summary>
    [JsonPropertyName("reason")] public string Reason { get; init; } = "none";
    [JsonPropertyName("runtime")] public string? Runtime { get; init; }
    [JsonPropertyName("presentMode")] public string? PresentMode { get; init; }
    [JsonPropertyName("fullscreenExclusive")] public bool? FullscreenExclusive { get; init; }
}

internal sealed class FrameStatsMessage
{
    [JsonPropertyName("type")] public string Type => "frameStats";
    [JsonPropertyName("ts")] public long Ts { get; set; }
    [JsonPropertyName("pid")] public int Pid { get; set; }
    [JsonPropertyName("process")] public string Process { get; set; } = "";
    [JsonPropertyName("windowSec")] public int WindowSec { get; set; }
    [JsonPropertyName("frames")] public int Frames { get; set; }
    [JsonPropertyName("fpsAvg")] public double? FpsAvg { get; set; }
    [JsonPropertyName("fpsDisplayedAvg")] public double? FpsDisplayedAvg { get; set; }
    [JsonPropertyName("fpsLow1")] public double? FpsLow1 { get; set; }
    [JsonPropertyName("fpsLow01")] public double? FpsLow01 { get; set; }
    [JsonPropertyName("frametimeAvgMs")] public double? FrametimeAvgMs { get; set; }
    [JsonPropertyName("frametimeP99Ms")] public double? FrametimeP99Ms { get; set; }
    [JsonPropertyName("frametimeP999Ms")] public double? FrametimeP999Ms { get; set; }
    [JsonPropertyName("frametimeMaxMs")] public double? FrametimeMaxMs { get; set; }
    [JsonPropertyName("cpuBusyMs")] public double? CpuBusyMs { get; set; }
    [JsonPropertyName("gpuBusyMs")] public double? GpuBusyMs { get; set; }
    /// <summary>"gpu" | "cpu" | "balanced" | "capped" | null.</summary>
    [JsonPropertyName("boundBy")] public string? BoundBy { get; set; }
    [JsonPropertyName("displayLatencyMs")] public double? DisplayLatencyMs { get; set; }
    [JsonPropertyName("droppedPct")] public double? DroppedPct { get; set; }
    [JsonPropertyName("presentMode")] public string? PresentMode { get; set; }
    [JsonPropertyName("runtime")] public string? Runtime { get; set; }
    [JsonPropertyName("allowsTearing")] public bool? AllowsTearing { get; set; }
    [JsonPropertyName("syncInterval")] public int? SyncInterval { get; set; }
    [JsonPropertyName("frametimes")] public List<double> Frametimes { get; set; } = new();
    [JsonPropertyName("frametimesOmitted")] public int FrametimesOmitted { get; set; }
}

internal sealed class PresentingProcess
{
    [JsonPropertyName("pid")] public int Pid { get; init; }
    [JsonPropertyName("process")] public string Process { get; init; } = "";
    [JsonPropertyName("windowTitle")] public string? WindowTitle { get; init; }
    [JsonPropertyName("fps")] public double Fps { get; init; }
    [JsonPropertyName("runtime")] public string Runtime { get; init; } = "Other";
    [JsonPropertyName("presentMode")] public string PresentMode { get; init; } = "Unknown";
    [JsonPropertyName("isForeground")] public bool IsForeground { get; init; }
    [JsonPropertyName("isTarget")] public bool IsTarget { get; init; }
}

internal sealed class PresentingListMessage
{
    [JsonPropertyName("type")] public string Type => "presentingList";
    [JsonPropertyName("ts")] public long Ts { get; init; }
    [JsonPropertyName("items")] public List<PresentingProcess> Items { get; init; } = new();
}
