// Pure helpers for the browser-preview backend (lib/mock.ts): frame statistics (CONTRACT §1.6.5),
// the drive-wear forecast (§2.11) and the sustained alert evaluation (§2.10.3). They mirror what the
// agent and Rust compute so the preview shows the same numbers the real app would. Preview only.

import type { DriveForecast, DriveHistoryPoint, FrameBoundBy } from "../types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Frame statistics (CONTRACT §1.6.5)                                  */
/* ------------------------------------------------------------------ */

export interface SimFrame {
  /** CPU start time, ms on the simulation clock. */
  t: number;
  /** Frame time, ms. */
  ft: number;
  cpuBusy: number | null;
  gpuBusy: number | null;
  /** Displayed time, ms; null = not displayed ("NA"). */
  displayed: number | null;
  latency: number | null;
}

export interface SimFrameStats {
  frames: number;
  fpsAvg: number | null;
  fpsDisplayedAvg: number | null;
  fpsLow1: number | null;
  fpsLow01: number | null;
  frametimeAvgMs: number | null;
  frametimeP99Ms: number | null;
  frametimeP999Ms: number | null;
  frametimeMaxMs: number | null;
  cpuBusyMs: number | null;
  gpuBusyMs: number | null;
  boundBy: FrameBoundBy | null;
  displayLatencyMs: number | null;
  droppedPct: number | null;
}

/** Nearest-rank percentile of an ascending array: sorted[ceil(q/100 × n) − 1]. */
export function nearestRank(sorted: readonly number[], q: number): number {
  const i = Math.max(0, Math.ceil((q / 100) * sorted.length) - 1);
  return sorted[Math.min(sorted.length - 1, i)];
}

function mean(values: readonly (number | null)[]): number | null {
  let s = 0;
  let k = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    s += v;
    k++;
  }
  return k > 0 ? s / k : null;
}

/** boundBy rule (§1.6.5) on unrounded inputs. */
export function boundBy(c: number | null, g: number | null, t: number | null, n: number): FrameBoundBy | null {
  if (c == null || g == null || t == null || n < 30) return null;
  if (Math.max(c, g) < 0.75 * t) return "capped";
  if (g >= 1.1 * c) return "gpu";
  if (c >= 1.1 * g) return "cpu";
  return "balanced";
}

export function computeFrameStats(frames: readonly SimFrame[]): SimFrameStats {
  const n = frames.length;
  const ft = frames.map((f) => f.ft);
  const sum = ft.reduce((s, v) => s + v, 0);
  const sorted = [...ft].sort((a, b) => a - b);
  const p99 = n >= 100 ? nearestRank(sorted, 99) : null;
  const p999 = n >= 1000 ? nearestRank(sorted, 99.9) : null;
  const avg = n >= 2 ? sum / n : null;
  const c = mean(frames.map((f) => f.cpuBusy));
  const g = mean(frames.map((f) => f.gpuBusy));
  const shown = frames.filter((f) => f.displayed != null);
  const d = shown.length;
  const dSum = shown.reduce((s, f) => s + (f.displayed ?? 0), 0);
  const lat = mean(shown.map((f) => f.latency));
  return {
    frames: n,
    fpsAvg: n >= 2 && sum > 0 ? r1((1000 * n) / sum) : null,
    fpsDisplayedAvg: d >= 2 && dSum > 0 ? r1((1000 * d) / dSum) : null,
    fpsLow1: p99 != null && p99 > 0 ? r1(1000 / p99) : null,
    fpsLow01: p999 != null && p999 > 0 ? r1(1000 / p999) : null,
    frametimeAvgMs: avg != null ? r2(avg) : null,
    frametimeP99Ms: p99 != null ? r2(p99) : null,
    frametimeP999Ms: p999 != null ? r2(p999) : null,
    frametimeMaxMs: n >= 1 ? r2(sorted[n - 1]) : null,
    cpuBusyMs: c != null ? r2(c) : null,
    gpuBusyMs: g != null ? r2(g) : null,
    boundBy: boundBy(c, g, avg, n),
    displayLatencyMs: d >= 1 && lat != null ? r2(lat) : null,
    droppedPct: n >= 1 ? r1((100 * (n - d)) / n) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Drive wear forecast (CONTRACT §2.11)                                */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / DAY_MS);
}

/** Ordinary-least-squares slope of y over x; null with fewer than `min` points or no x spread. */
function olsSlope(pts: readonly { x: number; y: number }[], min: number): number | null {
  if (pts.length < min) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** Forecast from daily points sorted by date; `today` = local YYYY-MM-DD. */
export function computeForecast(points: readonly DriveHistoryPoint[], today: string): DriveForecast {
  const t = dayNumber(today);
  const basis = points.filter((p) => t - dayNumber(p.date) <= 365);
  const count = basis.length;
  const first = count > 0 ? dayNumber(basis[0].date) : t;
  const basisDays = count > 0 ? dayNumber(basis[count - 1].date) - first : 0;
  if (count < 7 || basisDays < 14) {
    return { tbPerMonth: null, monthsTo10Pct: null, basisDays, points: count, status: "notEnoughData" };
  }
  const xy = (pick: (p: DriveHistoryPoint) => number | null) =>
    basis.flatMap((p) => {
      const y = pick(p);
      return y == null || !Number.isFinite(y) ? [] : [{ x: dayNumber(p.date) - first, y }];
    });
  const wSlope = olsSlope(xy((p) => p.dataWrittenTb), 7);
  const tbPerMonth = wSlope == null ? null : Math.max(0, r2(wSlope * 30.4375));

  const lifePts = xy((p) => p.healthPct);
  const m = olsSlope(lifePts, 7);
  if (m == null) return { tbPerMonth, monthsTo10Pct: null, basisDays, points: count, status: "noLifeData" };
  const h = lifePts[lifePts.length - 1].y;
  if (h <= 10) return { tbPerMonth, monthsTo10Pct: 0, basisDays, points: count, status: "ok" };
  if (m >= -0.001) return { tbPerMonth, monthsTo10Pct: null, basisDays, points: count, status: "noWear" };
  const months = r1((h - 10) / -m / 30.4375);
  if (months > 600) return { tbPerMonth, monthsTo10Pct: null, basisDays, points: count, status: "beyondHorizon" };
  return { tbPerMonth, monthsTo10Pct: months, basisDays, points: count, status: "ok" };
}

/* ------------------------------------------------------------------ */
/* Sustained alert evaluation (CONTRACT §2.10.3)                       */
/* ------------------------------------------------------------------ */

export type SustainLevel = "warn" | "crit" | null;

export interface SustainState {
  level: SustainLevel;
  sinceTs: number;
  samples: { ts: number; v: number | null }[];
}

export const newSustainState = (): SustainState => ({ level: null, sinceTs: 0, samples: [] });

/**
 * Adds one sample and returns the state's level. A level is met when the last `sustainSec` hold ≥ 3
 * samples, the oldest is ≥ 0.8 × sustainSec old, none is null and their minimum ≥ the threshold.
 * Clearing / de-escalation needs the last 3 samples below threshold − 3 °C (hysteresis).
 */
export function evaluateSustained(
  st: SustainState,
  ts: number,
  v: number | null,
  warnAt: number,
  critAt: number,
  sustainSec: number,
  hysteresis = 3,
): SustainLevel {
  const span = sustainSec * 1000;
  st.samples.push({ ts, v });
  while (st.samples.length > 0 && st.samples[0].ts < ts - span) st.samples.shift();
  const win = st.samples;
  const covered = win.length >= 3 && win[0].ts <= ts - 0.8 * span && win.every((s) => s.v != null);
  const minV = covered ? Math.min(...win.map((s) => s.v as number)) : null;
  const met = (thr: number) => minV != null && minV >= thr;
  const last3 = win.slice(-3);
  const below = (thr: number) => last3.length === 3 && last3.every((s) => s.v != null && s.v < thr - hysteresis);

  const prev = st.level;
  let next: SustainLevel = prev;
  if (prev == null) next = met(critAt) ? "crit" : met(warnAt) ? "warn" : null;
  else if (prev === "warn") next = met(critAt) ? "crit" : below(warnAt) ? null : "warn";
  else if (prev === "crit") next = below(critAt) ? (below(warnAt) ? null : "warn") : "crit";
  if (next !== prev) {
    st.level = next;
    st.sinceTs = ts;
  }
  return st.level;
}
