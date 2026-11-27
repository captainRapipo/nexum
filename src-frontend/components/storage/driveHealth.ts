import type { DiskTelemetry, DriveHealth } from "../../types";

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

/** `Life 44%`, or null when the drive reports no wear figure. */
export function lifeText(tele: DiskTelemetry | null | undefined): string | null {
  const h = tele?.healthPct;
  if (typeof h !== "number" || !Number.isFinite(h)) return null;
  return `Life ${Math.round(Math.max(0, Math.min(100, h)))}%`;
}

/** "1 of 3 drives needs attention" / "2 of 3 drives need attention". */
export function attentionText(n: number, total: number): string {
  return `${n} of ${total} ${total === 1 ? "drive" : "drives"} ${n === 1 ? "needs" : "need"} attention`;
}
