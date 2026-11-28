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

/* ------------------------------------------------------------------ */
/* 1.2 display helpers shared by the Dashboard cards and the Sensors   */
/* table (CONTRACT §4.8: the unit is shown once, never in Min/Max/Avg) */
/* ------------------------------------------------------------------ */

const partFormats = new Map<number, Intl.NumberFormat>();
function partFormat(decimals: number): Intl.NumberFormat {
  let f = partFormats.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    partFormats.set(decimals, f);
  }
  return f;
}

/** Unit text as shown next to a value ("rpm" reads calmer than "RPM"; everything else as reported). */
export function unitText(unit: string, tempUnit: "C" | "F" = "C"): string {
  if (unit === "°C" && tempUnit === "F") return "°F";
  if (unit === "RPM") return "rpm";
  return unit;
}

/**
 * A sensor value split into its number and its unit, so a table can show the number in bold and
 * the unit once. Same rounding as `fmtSensorValue`; null → `{ num: "—", unit: "" }`.
 */
export function sensorValueParts(
  v: number | null | undefined,
  meta: { unit: string; decimals: number },
  tempUnit: "C" | "F" = "C",
): { num: string; unit: string } {
  if (!finite(v)) return { num: "—", unit: "" };
  const value = meta.unit === "°C" && tempUnit === "F" ? (v * 9) / 5 + 32 : v;
  const d = Math.max(0, Math.min(6, Math.round(meta.decimals ?? 0)));
  return { num: partFormat(d).format(value), unit: unitText(meta.unit, tempUnit) };
}

/** `59.7 °C` (number, space, unit) in the chosen unit; `—` for null. */
export function tempText(c: number | null | undefined, tempUnit: "C" | "F" = "C", digits = 0): string {
  if (!finite(c)) return "—";
  const value = tempUnit === "F" ? (c * 9) / 5 + 32 : c;
  return `${value.toFixed(digits)} °${tempUnit}`;
}

/** Uptime for a title line, to the minute: `3 d 04:12`, `4 h 12 min`, `12 min`. */
export function uptimeText(secs: number | null | undefined): string {
  if (!finite(secs) || secs < 0) return "—";
  const total = Math.floor(secs / 60);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d} d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/** `1,446` (thousands separators, no unit). */
export function countText(n: number | null | undefined): string {
  return finite(n) ? partFormat(0).format(Math.round(n)) : "—";
}
