import { clamp, cn } from "../../lib/format";
import type { Tone } from "./tones";

// CONTRACT §4.7: the 1.1 dot matrix is now a row of thin graphite bars, one per value.

export interface DotMatrixProps {
  /** One bar per value, each 0–100. */
  values: number[];
  /** Ignored since 1.2 (only sets the aspect ratio of the drawing: rows × 10 high). Kept so call sites compile. */
  rows?: number;
  /** Ignored since 1.2 (bars are graphite). Kept so call sites compile. */
  tone?: Tone;
  className?: string;
  /** Fixed pixel height; by default the drawing scales to its width. */
  height?: number;
}

const CELL = 10;
const BAR = 6;

/** Thin graphite bars on a neutral track, each filled bottom-up in proportion to its value. No dots, no glow. */
export function DotMatrix({ values, rows = 6, className, height }: DotMatrixProps) {
  const cols = Math.max(1, values.length);
  const rowCount = Math.max(1, Math.round(rows));
  const w = cols * CELL;
  const h = rowCount * CELL;
  const x0 = (CELL - BAR) / 2;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio={height != null ? "none" : "xMidYMid meet"}
      className={cn("block w-full", height == null && "h-auto", className)}
      style={height != null ? { height } : undefined}
      role="img"
      aria-label="Activity bars"
    >
      <g style={{ fill: "var(--color-meter-track)" }}>
        {Array.from({ length: cols }, (_, c) => (
          <rect key={c} x={c * CELL + x0} y={0} width={BAR} height={h} rx={1.5} />
        ))}
      </g>
      <g style={{ fill: "var(--color-meter-fill)" }}>
        {Array.from({ length: cols }, (_, c) => {
          const v = clamp(values[c] ?? 0, 0, 100);
          if (v <= 0) return null;
          const bh = Math.max(1.5, (v / 100) * h);
          return <rect key={c} x={c * CELL + x0} y={h - bh} width={BAR} height={bh} rx={1.5} />;
        })}
      </g>
    </svg>
  );
}

export default DotMatrix;
