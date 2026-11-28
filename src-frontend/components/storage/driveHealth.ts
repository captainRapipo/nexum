import type { DiskTelemetry, DriveHealth } from "../../types";
import type { StatusTone } from "../ui";

/** Health used when a PhysicalDisk has no telemetry match (CONTRACT §1.1.3 join rule step 3). */
export const UNMATCHED_HEALTH: DriveHealth = {
  state: "unknown",
  label: "Health unknown — no S.M.A.R.T. data",
  reason: "The drive or its USB bridge does not report S.M.A.R.T. data",
  source: "none",
};

export function healthOf(tele: DiskTelemetry | null | undefined): DriveHealth {
  return tele?.health ?? UNMATCHED_HEALTH;
}

/** True for states that count toward "N of M drives need attention". */
export function needsAttention(h: DriveHealth): boolean {
  return h.state === "attention" || h.state === "replace" || h.state === "failing";
}

/** Chip word: the classifier's label, or the single word "Unknown" for the long unknown labels. */
export function healthWord(h: DriveHealth): string {
  return h.state === "unknown" ? "Unknown" : h.label || "Unknown";
}

/** Remaining life 0–100 (rounded), or null when the drive reports no wear figure. */
export function lifePct(tele: DiskTelemetry | null | undefined): number | null {
  const h = tele?.healthPct;
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  return Math.round(Math.max(0, Math.min(100, h)));
}

/** `Life 44%`, or null when the drive reports no wear figure. */
export function lifeText(tele: DiskTelemetry | null | undefined): string | null {
  const l = lifePct(tele);
  return l == null ? null : `Life ${l}%`;
}

/**
 * Tone of a life meter: amber only when the classifier says the drive needs attention (worn,
 * replace soon, failing); graphite otherwise. The tone comes from the classifier, never from the
 * percentage itself (CONTRACT §1.1.3).
 */
export function lifeMeterTone(tone: StatusTone): "warn" | undefined {
  return tone === "warn" || tone === "crit" ? "warn" : undefined;
}
