// Small pure helpers of the Cooling view (owner V2). Views import nothing from each other's
// folders (CONTRACT §4.1), so the three rules Cooling shares with the Dashboard are stated here too.

import type { FanTelemetry, FeatureNeed, GpuTelemetry, HardwareKind } from "../../types";

/** True when a fan belongs to a GPU (hardware ids "/gpu-nvidia/0", "/gpu-amd/0", "/gpu-intel/0"). */
export function isGpuFan(fan: Pick<FanTelemetry, "hwId">): boolean {
  return /^\/gpu/i.test(fan.hwId ?? "");
}

/** "Zero-RPM idle" tag rule (CONTRACT §4.8). */
export function isZeroRpmIdle(gpu: GpuTelemetry | null | undefined): boolean {
  return !!gpu && gpu.fanRpm === 0 && (gpu.fanPct ?? 0) === 0;
}

/**
 * What a sensor of this hardware kind needs to be readable (CONTRACT §4.5 FEATURE_NEEDS):
 * CPU / motherboard / Super I/O / memory sensors need PawnIO, drive sensors need admin, the rest nothing.
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

export function isPump(name: string): boolean {
  return /pump|aio/i.test(name);
}

/** `1,446` (no unit), or an em dash. */
export function rpmNumber(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}
