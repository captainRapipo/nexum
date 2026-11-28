import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "../../lib/format";

export interface TrendArrowProps {
  delta: number | null | undefined;
  /** When true, rising is bad (temperatures). Default false. */
  invert?: boolean;
  /** Suffix after the value, e.g. "°" or "%". */
  unit?: string;
  precision?: number;
  /** Show the numeric delta next to the arrow. Default true. */
  showValue?: boolean;
  /** |delta| below this is treated as flat. Default 0.05. */
  threshold?: number;
  className?: string;
}

export function TrendArrow({
  delta,
  invert = false,
  unit = "",
  precision = 1,
  showValue = true,
  threshold = 0.05,
  className,
}: TrendArrowProps) {
  const d = typeof delta === "number" && Number.isFinite(delta) ? delta : 0;
  const flat = Math.abs(d) < threshold;
  const up = d > 0;
  const good = flat ? null : up !== invert;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  // Direction is information, not a verdict: the arrow and the sign carry it, the colour stays neutral (no red / green).
  const color = good == null ? "text-ink-3" : "text-ink-2";
  const label = flat ? "steady" : `${up ? "up" : "down"} ${Math.abs(d).toFixed(precision)}${unit}`;

  return (
    <span className={cn("tnum inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] font-medium", color, className)} aria-label={label} title={label}>
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      {showValue && !flat && (
        <span>
          {up ? "+" : "−"}
          {Math.abs(d).toFixed(precision)}
          {unit}
        </span>
      )}
    </span>
  );
}

export default TrendArrow;
