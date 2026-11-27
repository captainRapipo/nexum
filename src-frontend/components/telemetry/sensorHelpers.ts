import type { FanTelemetry, FeatureNeed, GpuTelemetry, HardwareKind } from "../../types";

/**
 * What a sensor of this hardware kind needs to be readable (CONTRACT §4.5 FEATURE_NEEDS):
 * CPU / motherboard / Super I/O / SPD sensors need PawnIO, drive sensors need admin, the rest need nothing.
 */
export function needForHardware(kind: HardwareKind | null | undefined): FeatureNeed {
  switch (kind) {
    case "cpu":
    case "motherboard":
    case "superio":
    case "memory":
    case "embeddedController":
      return "pawnio";
    case "storage":
      return "admin";
    default:
      return "none";
  }
}

/** True when a fan belongs to a GPU (LHM hardware ids "/gpu-nvidia/0", "/gpu-amd/0", "/gpu-intel/0"). */
export function isGpuFan(fan: Pick<FanTelemetry, "hwId">): boolean {
  return /^\/gpu/i.test(fan.hwId ?? "");
}

/**
 * The CPU fan for the KPI (CONTRACT §4.8): the fan named exactly "CPU Fan", else the first non-GPU fan
 * whose name contains "CPU" but not "Opt". Never another fan, never an average; null = unavailable.
 */
export function pickCpuFan(fans: readonly FanTelemetry[] | null | undefined): FanTelemetry | null {
  const list = fans ?? [];
  const exact = list.find((f) => /^CPU Fan$/i.test((f.name ?? "").trim()));
  if (exact) return exact;
  return list.find((f) => !isGpuFan(f) && /cpu/i.test(f.name ?? "") && !/opt/i.test(f.name ?? "")) ?? null;
}

/** "Zero-RPM idle" badge rule (CONTRACT §4.8). */
export function isZeroRpmIdle(gpu: GpuTelemetry | null | undefined): boolean {
  return !!gpu && gpu.fanRpm === 0 && (gpu.fanPct ?? 0) === 0;
}

export function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
