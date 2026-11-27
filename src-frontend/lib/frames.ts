// Frame-capture display helpers (CONTRACT §4.5 lib/frames.ts, §1.6.5). Pure functions only.

import {
  FIXED_FRAME_EXCLUDES,
  FPS_EXCLUDE_PATTERN,
  FPS_EXCLUDES_MAX,
  FPS_WINDOW_MAX_SEC,
  FPS_WINDOW_MIN_SEC,
  type FrameBoundBy,
  type FrameSession,
  type FrameStats,
  type FrameTarget,
} from "../types";
import type { StatusTone } from "../components/ui/tones";
import { DASH } from "./format";

export interface FpsKpiInput {
  enabled: boolean;
  session: FrameSession | null;
  target: FrameTarget | null;
  stats: FrameStats | null;
  statsFresh: boolean;
}

export interface FpsKpi {
  visible: boolean;
  fps: number | null;
  low1: number | null;
  process: string | null;
}

/**
 * The 6th Dashboard KPI rule (CONTRACT §4.5): shown only while capture is on, the session runs,
 * a target exists and its stats are fresh.
 */
export function fpsKpi(f: FpsKpiInput): FpsKpi {
  const visible =
    f.enabled &&
    f.session?.state === "running" &&
    f.target != null &&
    f.target.reason !== "none" &&
    f.target.pid != null &&
    f.statsFresh;
  if (!visible || !f.stats) return { visible: false, fps: null, low1: null, process: null };
  return {
    visible: true,
    fps: f.stats.fpsAvg,
    low1: f.stats.fpsLow1,
    process: f.stats.process || f.target?.process || null,
  };
}

const BOUND_LABEL: Record<FrameBoundBy, string> = {
  gpu: "GPU-bound",
  cpu: "CPU-bound",
  balanced: "Balanced",
  capped: "Frame-rate capped",
};

export function boundByLabel(b: FrameBoundBy | null | undefined): string {
  return b ? (BOUND_LABEL[b] ?? DASH) : DASH;
}

/** Hover text for the bound-by badge: the §1.6.5 rule plus the HAGS note. */
export const BOUND_BY_RULE =
  "GPU-bound when GPU busy time is at least 1.1 × CPU busy time; CPU-bound when CPU busy time is at least 1.1 × GPU busy time; " +
  "frame-rate capped when both are below 75% of the average frame time (frame limiter or V-Sync); otherwise balanced. " +
  "Needs at least 30 frames.";
export const HAGS_NOTE = "GPU timing is less accurate with Hardware-Accelerated GPU Scheduling on (about 0.5 ms high).";

/** Tooltip for P1 / P0.1 (exact text, CONTRACT §1.6.5). */
export const PERCENTILE_LOW_DEFINITION =
  "P1 = 1000 ÷ 99th-percentile frame time in the window. P0.1 uses the 99.9th percentile.";
/** `title` for a null P1 / P0.1 (CONTRACT §4.10.1). */
export const P1_NEEDS_FRAMES = "Needs at least 100 frames in the window.";
export const P01_NEEDS_FRAMES = "Needs at least 1000 frames in the window.";

/** 0 decimals at ≥ 100 fps, else 1 decimal; `—` for null. */
export function fmtFps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return DASH;
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1);
}

/** `6.94 ms`; `—` for null. */
export function fmtFrametime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  return `${ms.toFixed(2)} ms`;
}

export interface PresentModeBadge {
  label: string;
  tone: StatusTone;
  title: string;
}

/** PresentMon PresentMode → badge (CONTRACT §4.5). */
export function presentModeBadge(mode: string | null | undefined): PresentModeBadge {
  const m = (mode ?? "").trim();
  if (m === "Hardware: Independent Flip" || m === "Hardware Composed: Independent Flip") {
    return {
      label: "Independent Flip",
      tone: "ok",
      title: `${m}. The game's frames go to the display without an extra composition step.`,
    };
  }
  if (m === "Hardware: Legacy Flip" || m === "Hardware: Legacy Copy to front buffer") {
    return {
      label: "Exclusive fullscreen",
      tone: "info",
      title: `${m}. The game owns the display (exclusive fullscreen).`,
    };
  }
  if (m.startsWith("Composed:")) {
    return { label: "Composed", tone: "warn", title: "Windows composes this window, which adds latency." };
  }
  return {
    label: m || "Unknown",
    tone: "unknown",
    title: m ? `Present mode reported by PresentMon: ${m}.` : "PresentMon did not report a present mode.",
  };
}

/** Clamp a stats window to the contract bounds (integer seconds, 5..120). */
export function clampFrameWindow(sec: number): number {
  if (!Number.isFinite(sec)) return 30;
  return Math.round(Math.min(FPS_WINDOW_MAX_SEC, Math.max(FPS_WINDOW_MIN_SEC, sec)));
}

/** Inline error for an invalid exclude entry (CONTRACT §4.10.1). */
export const EXCLUDE_NAME_HINT = "Use the program's file name, for example obs64.exe.";

const FIXED_LOWER = new Set(FIXED_FRAME_EXCLUDES.map((n) => n.toLowerCase()));

/** True when `name` (trimmed) is a valid user exclude entry (same pattern as Rust, CONTRACT §2.13). */
export function isValidExcludeName(name: string): boolean {
  return FPS_EXCLUDE_PATTERN.test(name.trim());
}

/** True for the names the agent always excludes (never stored in Settings). */
export function isFixedExclude(name: string): boolean {
  return FIXED_LOWER.has(name.trim().toLowerCase());
}

/**
 * Same sanitization as Rust's set_frame_excludes (CONTRACT §2.13): trim, keep valid `*.exe`
 * names, drop the fixed excludes, dedupe case-insensitively keeping the first spelling, max 50.
 */
export function sanitizeExcludes(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const n = raw.trim();
    if (!FPS_EXCLUDE_PATTERN.test(n) || isFixedExclude(n)) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= FPS_EXCLUDES_MAX) break;
  }
  return out;
}

/** `Following the foreground app` / `Pinned by you` / `No game detected` (Gaming view target line). */
export function targetReasonText(t: FrameTarget | null | undefined): string {
  if (!t || t.reason === "none" || t.pid == null) return "No game detected";
  return t.reason === "manual" ? "Pinned by you" : "Following the foreground app";
}
