// Colour maps for the light theme (CONTRACT §4.7, §4.9). Owner: foundation.
// Class names are kept as full literals so Tailwind's scanner picks them up.
// This file and echartsTheme.ts are the only TS files that may contain hex colours.

import { SERIES_HEX } from "./echartsTheme";

export { SERIES_HEX, type SeriesKey } from "./echartsTheme";

/** The 1.1 accent names. Only the ignored `accent` prop of GlassCard still takes one (CONTRACT §4.7). */
export type Tone = "teal" | "gold" | "purple" | "rose" | "cyan" | "silver";

/* ------------------------------------------------------------------ */
/* Semantic status (CONTRACT §4.9). Status is icon + word + tint: these */
/* colours are the third cue, never the only one.                       */
/* ------------------------------------------------------------------ */

export type StatusTone = "ok" | "warn" | "crit" | "info" | "unknown";

/**
 * [NEW 1.2] Tones the header StatusPill accepts: the five status tones plus "checking" (neutral
 * card surface, dashed ring) for the time before the first health evaluation. "checking" is not a
 * StatusTone on purpose, so every existing Record<StatusTone, …> keeps compiling.
 */
export type StatusPillTone = StatusTone | "checking";

/** Hex of the status ICON colours (`--color-*-icon`). For ECharts / SVG glyphs and dots. */
export const STATUS_HEX: Record<StatusTone, string> = {
  ok: "#28a04d",
  warn: "#c47a00",
  crit: "#d9381e",
  info: "#1f74db",
  unknown: "#7a8291",
};

/** [NEW 1.2] Hex of the status TEXT colours (`--color-ok` …): AA on white and on the matching tint. */
export const STATUS_TEXT_HEX: Record<StatusTone, string> = {
  ok: "#1b7a3a",
  warn: "#925200",
  crit: "#b3260f",
  info: "#0a5fc2",
  unknown: "#535a66",
};

export interface StatusClasses {
  /** Text colour (AA on white and on `soft`). */
  text: string;
  /** Solid fill in the icon colour (dots, thin bars). Not a text background. */
  bg: string;
  /** Tint background for chips, pills and banners. */
  soft: string;
  /** Border matching the tint. */
  border: string;
  /** [NEW 1.2] Icon colour. */
  icon: string;
}

/** Full literal Tailwind classes per status tone (kept literal for the scanner). */
export const STATUS_CLASS: Record<StatusTone, StatusClasses> = {
  ok: { text: "text-ok", bg: "bg-ok-icon", soft: "bg-ok-bg", border: "border-ok-border", icon: "text-ok-icon" },
  warn: { text: "text-warn", bg: "bg-warn-icon", soft: "bg-warn-bg", border: "border-warn-border", icon: "text-warn-icon" },
  crit: { text: "text-crit", bg: "bg-crit-icon", soft: "bg-crit-bg", border: "border-crit-border", icon: "text-crit-icon" },
  info: { text: "text-info", bg: "bg-info-icon", soft: "bg-info-bg", border: "border-info-border", icon: "text-info-icon" },
  unknown: { text: "text-unknown", bg: "bg-unknown-icon", soft: "bg-unknown-bg", border: "border-unknown-border", icon: "text-unknown-icon" },
};

/** [NEW 1.2] Classes of the neutral "Checking" pill (SPEC §4): card surface, subtle border, tertiary glyph. */
export const CHECKING_CLASS: StatusClasses = {
  text: "text-ink-2",
  bg: "bg-series-neutral",
  soft: "bg-card",
  border: "border-subtle",
 
  icon: "text-ink-3",
};

/** [NEW 1.2] Tailwind classes per data series (dots in KPI cells, legends drawn in HTML). */
export const SERIES_CLASS: Record<keyof typeof SERIES_HEX, { text: string; bg: string }> = {
  cpu: { text: "text-series-cpu", bg: "bg-series-cpu" },
  gpu: { text: "text-series-gpu", bg: "bg-series-gpu" },
  ram: { text: "text-series-ram", bg: "bg-series-ram" },
  vram: { text: "text-series-vram", bg: "bg-series-vram" },
  disk: { text: "text-series-cpu", bg: "bg-series-cpu" },
  net: { text: "text-series-gpu", bg: "bg-series-gpu" },
  single: { text: "text-series-single", bg: "bg-series-single" },
  neutral: { text: "text-series-neutral", bg: "bg-series-neutral" },
};
