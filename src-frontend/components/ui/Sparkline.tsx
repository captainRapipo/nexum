import { useId, useMemo } from "react";
import { cn } from "../../lib/format";

export interface SparklineProps {
  /** null = no reading; when every point is null (or there are none) nothing is rendered (MF-2). */
  data: readonly (number | null | undefined)[];
  /** Any CSS colour, including `var(--color-teal)`. */
  color: string;
  height?: number;
  className?: string;
  /** Draw the gradient area under the line. Default true. */
  fill?: boolean;
  /** Fixed scale bounds; auto-fit when omitted. */
  min?: number;
  max?: number;
  strokeWidth?: number;
}

const VB_W = 100;

export function Sparkline({
  data,
  color,
  height = 32,
  className,
  fill = true,
  min,
  max,
  strokeWidth = 1.6,
}: SparklineProps) {
  const gradId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const paths = useMemo(() => {
    const pts = data.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (pts.length < 2) return null;
    let lo = min ?? Math.min(...pts);
    let hi = max ?? Math.max(...pts);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = 1.5;
    const usable = height - pad * 2;
    const step = VB_W / (pts.length - 1);
    const coords = pts.map((v, i) => {
      const t = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo);
      return [i * step, pad + (1 - t) * usable] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    const area = `${line} L${VB_W} ${height} L0 ${height} Z`;
    return { line, area };
  }, [data, height, min, max]);

  const hasData = data.some((v) => typeof v === "number" && Number.isFinite(v));
  if (!hasData) return null;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full overflow-visible", className)}
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.32 }} />
          <stop offset="100%" style={{ stopColor: color, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {paths ? (
        <>
          {fill && <path d={paths.area} fill={`url(#${gradId})`} stroke="none" />}
          <path
            d={paths.line}
            fill="none"
            style={{ stroke: color, filter: `drop-shadow(0 0 3px ${color})` }}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : (
        <line
          x1={0}
          x2={VB_W}
          y1={height / 2}
          y2={height / 2}
          style={{ stroke: color }}
          strokeOpacity={0.25}
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export default Sparkline;
