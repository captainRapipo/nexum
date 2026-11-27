import type { TrashCategory, TrashScan } from "../../types";

/**
 * Copy and number helpers for the cache cleanup UI (CONTRACT §3.1 quick path, §4.8 copy rules).
 * One unit per list: GB, or MB when every number in the list is below 1 GB.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type ByteUnit = "GB" | "MB";

export function pickUnit(...bytes: number[]): ByteUnit {
  return Math.max(0, ...bytes.filter((b) => Number.isFinite(b))) >= GB ? "GB" : "MB";
}

/** `3.52 GB` / `12.4 GB` / `840 MB` / `3.2 MB` in the given unit. */
export function fmtIn(bytes: number, unit: ByteUnit): string {
  const b = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (unit === "GB") {
    const v = b / GB;
    return `${v.toFixed(v < 10 ? 2 : 1)} GB`;
  }
  const v = b / MB;
  return `${v.toFixed(v < 10 ? 1 : 0)} MB`;
}

/** Bytes of categories that cannot run in this session (shown as "… more as administrator"). */
export function unavailableBytes(scan: TrashScan | null): number {
  return (scan?.categories ?? []).filter((c) => c.available === false).reduce((a, c) => a + (c.bytes || 0), 0);
}

export interface Headline {
  unit: ByteUnit;
  /** `3.52 GB`: the number the clean button repeats exactly. */
  now: string;
  /** `1.35 GB`, or null when nothing more is available as administrator. */
  more: string | null;
  /** `3.52 GB now · 1.35 GB more as administrator` (second part only when > 0). */
  text: string;
}

/** Headline for the selected, available bytes (CONTRACT §3.1 quick path). */
export function headline(selectedBytes: number, scan: TrashScan | null): Headline {
  const moreBytes = unavailableBytes(scan);
  const unit = pickUnit(selectedBytes, moreBytes);
  const now = fmtIn(selectedBytes, unit);
  const more = moreBytes > 0 ? fmtIn(moreBytes, unit) : null;
  return { unit, now, more, text: more ? `${now} now · ${more} more as administrator` : now };
}

/** Unit for a category list: the largest category decides. */
export function listUnit(categories: readonly { bytes: number }[]): ByteUnit {
  return pickUnit(...categories.map((c) => c.bytes || 0));
}

export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i <= 0) return p;
  if (i === 2 && p[1] === ":") return p.slice(0, 3);
  return p.slice(0, i);
}

export type { TrashCategory };
