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

/* ------------------------------------------------------------------ */
/* Page and dialog copy (CONTRACT §4.6.1, §4.8, §4.10.3)                */
/* ------------------------------------------------------------------ */

/** PageHeader description (CONTRACT §4.6.1 table). */
export const PAGE_DESCRIPTION =
  "Measured first with a dry run. Protected system paths, cookies, logins and personal files are never touched.";

/** Body of the confirmation dialog. */
export const CONFIRM_BODY =
  "These files were measured in a dry run a moment ago. Only the categories below are removed; files in use are skipped.";

/** Reassurance line of the confirmation dialog (green shield). */
export const CONFIRM_REASSURANCE =
  "Every deleted path is written to an audit log. Cookies, logins and personal files are never touched.";

/** Under the page button: what happens when it is pressed. */
export const READY_NOTE_CONFIRM = "You confirm first. Files in use are skipped and every deleted path is written to an audit log.";
export const READY_NOTE_DIRECT =
  "Starts right away: confirmation is off in Settings. Files in use are skipped and every deleted path is written to an audit log.";

/** Mirrors the non-negotiable rules enforced by the Rust cleaner (CONTRACT §3). */
export const PROTECTED_PATHS: readonly string[] = [
  "%WINDIR%\\System32 (incl. \\config registry hives), SysWOW64, WinSxS, Prefetch",
  "%ProgramFiles% and %ProgramFiles(x86)%",
  "%ProgramData%\\Nexum and Nexum's own program folder",
  "Documents, Desktop, Pictures, Videos, Music, Downloads, OneDrive",
  "NTUSER.DAT*, UsrClass.dat*, *.regtrans-ms, *.blf",
  "Drive roots and every category root folder itself",
  "Symlinks, junctions and mount points (never followed)",
  "Browser cookies, logins, history, Local Storage and IndexedDB",
];

export const CLEANUP_RULES: readonly string[] = [
  "Crash dumps: the 5 newest and anything less than 30 days old are kept.",
  "Windows Update downloads are skipped while an update is waiting to install or restart.",
  "Delivery Optimization is cleared only through Windows' own cmdlet.",
  "Browser and Discord caches are skipped while that app is open.",
  "Recycle Bin: with an age set, only items deleted longer ago than that are removed, and only from your own bin.",
  "Every cleanup writes a log of each file it deleted or skipped.",
];

/** `2.22 GB` → ["2.22", "GB"], so a large numeral can carry a small unit. */
export function splitAmount(text: string): [string, string] {
  const i = text.lastIndexOf(" ");
  return i < 0 ? [text, ""] : [text.slice(0, i), text.slice(i + 1)];
}

/** `5,414 files` / `1 file`. */
export function fmtFiles(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return `${v.toLocaleString("en-US")} ${v === 1 ? "file" : "files"}`;
}
