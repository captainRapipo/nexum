// Formatting helpers shared by every view. All functions are null-safe and
// return an em dash for missing / non-finite values.

export type TempUnit = "C" | "F";

export const DASH = "—";

type Maybe<T> = T | null | undefined;

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormats.set(key, f);
  }
  return f;
}

/** Clamp `n` into [a, b]. Non-finite input returns `a`. */
export function clamp(n: number, a: number, b: number): number {
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, n));
}

/** Join truthy class names. */
export function cn(...classes: Array<string | false | null | undefined | 0>): string {
  let out = "";
  for (const c of classes) {
    if (c) out = out ? `${out} ${c}` : c;
  }
  return out;
}

/** Thousands-separated number with fixed decimals. */
export function fmtNum(n: Maybe<number>, digits = 0): string {
  if (!isNum(n)) return DASH;
  return nf(digits, digits).format(n);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Binary byte formatting (1 KB = 1024 B), matching Windows Explorer. */
export function fmtBytes(n: Maybe<number>, digits = 1): string {
  if (!isNum(n)) return DASH;
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  if (v < 1024) return `${sign}${Math.round(v)} B`;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v.toFixed(digits)} ${BYTE_UNITS[i]}`;
}

/** Value already in GB. */
export function fmtGb(n: Maybe<number>, digits = 1): string {
  if (!isNum(n)) return DASH;
  return `${n.toFixed(digits)} GB`;
}

export function fmtPct(n: Maybe<number>, digits = 0): string {
  if (!isNum(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

/** Convert a Celsius reading to the requested unit (number, unformatted). */
export function toTempUnit(c: number, unit: TempUnit = "C"): number {
  return unit === "F" ? (c * 9) / 5 + 32 : c;
}

/** `52°C` / `126°F` */
export function fmtTemp(c: Maybe<number>, unit: TempUnit = "C", digits = 0): string {
  if (!isNum(c)) return DASH;
  return `${toTempUnit(c, unit).toFixed(digits)}°${unit}`;
}

export function fmtRpm(n: Maybe<number>): string {
  if (!isNum(n)) return DASH;
  return `${nf(0, 0).format(Math.round(n))} RPM`;
}

/** `3d 04:12:09` (or `04:12:09` under a day). */
export function fmtUptime(secs: Maybe<number>): string {
  if (!isNum(secs) || secs < 0) return DASH;
  const s = Math.floor(secs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

/** `4,500 MHz` */
export function fmtMhz(n: Maybe<number>): string {
  if (!isNum(n)) return DASH;
  return `${nf(0, 0).format(Math.round(n))} MHz`;
}

/** MHz value rendered as GHz: `4.50 GHz` */
export function fmtGhz(mhz: Maybe<number>, digits = 2): string {
  if (!isNum(mhz)) return DASH;
  return `${(mhz / 1000).toFixed(digits)} GHz`;
}

/** Throughput in MB/s, auto-scaling to KB/s and GB/s. */
export function fmtMBps(n: Maybe<number>): string {
  if (!isNum(n)) return DASH;
  if (n >= 1000) return `${(n / 1000).toFixed(2)} GB/s`;
  if (n >= 100) return `${n.toFixed(0)} MB/s`;
  if (n >= 1) return `${n.toFixed(1)} MB/s`;
  return `${(n * 1000).toFixed(0)} KB/s`;
}

export function fmtWatts(n: Maybe<number>, digits = 0): string {
  if (!isNum(n)) return DASH;
  return `${n.toFixed(digits)} W`;
}

export function fmtVolts(n: Maybe<number>, digits = 3): string {
  if (!isNum(n)) return DASH;
  return `${n.toFixed(digits)} V`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDate(v: Maybe<string | number | Date>): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    // Plain calendar date: interpret as local midnight, not UTC.
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `Nov 25, 2026` */
export function fmtDate(v: Maybe<string | number | Date>): string {
  const d = toDate(v);
  if (!d) return DASH;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** `14:02:11` */
export function fmtClock(v: Maybe<string | number | Date>, withSeconds = true): string {
  const d = toDate(v);
  if (!d) return DASH;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** `Today 14:02` / `Yesterday 09:13` / `Nov 25, 14:02` */
export function fmtDateTime(v: Maybe<string | number | Date>): string {
  const d = toDate(v);
  if (!d) return DASH;
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const time = fmtClock(d, false);
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : ` ${d.getFullYear()}`}, ${time}`;
}

/** `just now`, `12s ago`, `4m ago`, `3h ago`, `2d ago` */
export function fmtRelative(v: Maybe<string | number | Date>, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return DASH;
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "AMD Ryzen 9 7950X 16-Core Processor" → "Ryzen 9 7950X"; "Intel(R) Core(TM) i9-14900K" → "Core i9-14900K". */
export function shortCpuName(name: Maybe<string>): string {
  if (!name) return DASH;
  let s = name
    .replace(/\((?:R|TM|C)\)/gi, "")
    .replace(/[®™©]/g, "")
    .replace(/^\s*\d+(?:st|nd|rd|th)\s+Gen\s+/i, "")
    .replace(/^\s*(?:AMD|Intel|Qualcomm)\s+/i, "")
    .replace(/\s+\d+-Core\s+Processor.*$/i, "")
    .replace(/\s+with\s+Radeon.*$/i, "")
    .replace(/\s+@.*$/, "")
    .replace(/\s+(?:CPU|Processor)\b.*$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || name.trim();
}

/** "NVIDIA GeForce RTX 4080" → "RTX 4080"; "AMD Radeon RX 7900 XTX" → "RX 7900 XTX". */
export function shortGpuName(name: Maybe<string>): string {
  if (!name) return DASH;
  let s = name
    .replace(/\((?:R|TM|C)\)/gi, "")
    .replace(/[®™©]/g, "")
    .replace(/^\s*NVIDIA\s+(?:GeForce\s+)?/i, "")
    .replace(/^\s*AMD\s+Radeon\s+(?=(?:RX|PRO|Pro|VII)\b)/i, "")
    .replace(/^\s*(?:AMD|Intel)\s+/i, "");
  if (/^Arc\s/i.test(s)) s = s.replace(/\s+Graphics$/i, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s || name.trim();
}

const VIRTUAL_GPU = /microsoft basic|remote display|virtual|parsec|indirect display|idd|meta virtual|spacedesk/i;
const DISCRETE_GPU = /nvidia|geforce|quadro|rtx|gtx|radeon\s+(?:rx|pro|vii)|\barc\b|tesla/i;

/** Choose the most relevant GPU name: discrete first, never a virtual display adapter. */
export function pickPrimaryGpu(names: Maybe<readonly string[]>): string | null {
  if (!names || names.length === 0) return null;
  const real = names.filter((n) => n && !VIRTUAL_GPU.test(n));
  const pool = real.length > 0 ? real : names;
  return pool.find((n) => DISCRETE_GPU.test(n)) ?? pool[0] ?? null;
}
