import { clamp, cn } from "../../lib/format";
import type { Tone } from "./tones";

// CONTRACT §4.7 / docs/design/SPEC.md (meters): the 1.1 LED bar is now a plain meter.

export interface SegmentedBarProps {
  /** 0–100 */
  value: number;
  /**
   * "warn" = amber fill (a worn drive, a nearly full volume). Every other value is graphite:
   * the legacy accent tones and "auto" no longer colour the bar.
   */
  tone?: Tone | "auto" | "warn";
  /** Bar height in px. Default 6. */
  height?: number;
  className?: string;
  /** Accessible name. */
  label?: string;
  /** Ignored since 1.2 (the bar is continuous). Kept so call sites compile. */
  segments?: number;
  /** Ignored since 1.2. Kept so call sites compile. */
  zoned?: boolean;
}

/** A plain meter: neutral track, graphite fill. (1.1 name; also exported as `Meter`.) */
export function SegmentedBar({ value, tone = "auto", height = 6, className, label }: SegmentedBarProps) {
  const v = clamp(Number.isFinite(value) ? value : 0, 0, 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
      className={cn("w-full overflow-hidden rounded-[3px] bg-meter-track", className)}
      style={{ height }}
    >
      <div className={cn("h-full rounded-[3px]", tone === "warn" ? "bg-meter-warn" : "bg-meter-fill")} style={{ width: `${v}%` }} />
    </div>
  );
}

export const Meter = SegmentedBar;

export default SegmentedBar;
