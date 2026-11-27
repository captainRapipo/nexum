// GPU tuning panel copy and helpers (CONTRACT §1.7, §2.14, §4.8, §4.10.1).
// Read-only: never "overclock", "unlock", "boost" or "tune" as a call to action.

import type { TuningRange, TuningState, TuningUnsupportedReason, UnavailableReason } from "../../types";

export const PANEL_HEADER =
  "Read-only. Nexum shows the GPU's tuning ranges and current values but does not change them in this version.";
export const NO_CHANGE_NOTE = "Nexum does not change GPU settings in this version.";
export const PROBE_BUTTON = "Run read-only probe";
export const PROBE_EXPLAIN =
  "Reads every Overdrive value the AMD driver reports and saves the raw tables to a JSON file you can share for troubleshooting. Nothing is changed.";

export const MODE_TEXT: Record<TuningState["mode"], string> = {
  factory: "Factory settings",
  custom: "Custom (set in AMD Software)",
  autoUndervolt: "Auto Undervolt",
  unknown: "Unknown",
};

export const MODE_RULE =
  "Factory settings when every value the driver reports equals its default. Custom when at least one differs (changed in AMD Software). Auto Undervolt when that AMD feature is on.";

/** Which `<Unavailable>` cause fits an unsupported state. */
export function unavailableFor(reason: TuningUnsupportedReason | null): UnavailableReason {
  return reason === "notElevated" ? "notElevated" : "unsupported";
}

/** `−30 … +10 %` */
export function fmtRange(r: TuningRange | null, unit: string, signed = false): string {
  if (!r) return "—";
  return `${fmtValue(r.min, unit, signed, false)} … ${fmtValue(r.max, unit, signed)}`;
}

/** `+10 %`, `3100 MHz`, `-50 mV` */
export function fmtValue(v: number | null, unit: string, signed = false, withUnit = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const n = Number.isInteger(v) ? String(Math.abs(v)) : Math.abs(v).toFixed(1);
  const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
  return `${sign}${n}${withUnit && unit ? ` ${unit}` : ""}`;
}

/** Hover for any value: its range, step and default. */
export function rangeTitle(label: string, r: TuningRange | null, unit: string, signed = false): string {
  if (!r) return `${label}: the driver reports no range.`;
  const def = r.default == null ? "no default reported" : `default ${fmtValue(r.default, unit, signed)}`;
  return `${label}: range ${fmtRange(r, unit, signed)}, step ${r.step}, ${def}. Read-only.`;
}

/** `C:\x\y\file.json` → `C:\x\y` */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : path;
}
