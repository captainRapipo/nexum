import { clamp, cn } from "../../lib/format";
import { TONE_HEX, type Tone } from "./tones";

export interface DotMatrixProps {
  /** One column per value, each 0–100. */
  values: number[];
  rows?: number;
  tone?: Tone;
  className?: string;
  /** Fixed pixel height; by default the matrix scales to its width. */
  height?: number;
}

const CELL = 10;
const R = 3.1;

/** Dot-matrix mini visualiser: each column lights bottom-up in proportion to its value. */
export function DotMatrix({ values, rows = 6, tone = "teal", className, height }: DotMatrixProps) {
  const cols = Math.max(1, values.length);
  const rowCount = Math.max(1, Math.round(rows));
  const color = TONE_HEX[tone];
  const w = cols * CELL;
  const h = rowCount * CELL;

  const lit: Array<{ x: number; y: number; o: number }> = [];
  const dim: Array<{ x: number; y: number }> = [];

  for (let c = 0; c < cols; c++) {
    const v = clamp(values[c] ?? 0, 0, 100);
    const level = v > 0 ? Math.max(1, Math.round((v / 100) * rowCount)) : 0;
    for (let r = 0; r < rowCount; r++) {
      const fromBottom = rowCount - 1 - r;
      const x = c * CELL + CELL / 2;
      const y = r * CELL + CELL / 2;
      if (fromBottom < level) {
        // Brighter toward the top of each column.
        const o = fromBottom === level - 1 ? 1 : 0.45 + 0.4 * (fromBottom / Math.max(1, rowCount - 1));
        lit.push({ x, y, o });
      } else {
        dim.push({ x, y });
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn("block w-full", height == null && "h-auto", className)}
      style={height != null ? { height } : undefined}
      role="img"
      aria-label="Activity matrix"
    >
      <g fill="rgba(255,255,255,0.07)">
        {dim.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={R} />
        ))}
      </g>
      <g style={{ fill: color, filter: `drop-shadow(0 0 2.5px ${color})` }}>
        {lit.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={R} opacity={d.o} />
        ))}
      </g>
    </svg>
  );
}

export default DotMatrix;
