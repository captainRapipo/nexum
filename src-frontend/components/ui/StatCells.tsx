import type { SensorMeta } from "../../types";
import { cn, fmtSensorValue } from "../../lib/format";

export interface StatCellsProps {
  value: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  meta: Pick<SensorMeta, "unit" | "decimals" | "kind">;
  tempUnit: "C" | "F";
  className?: string;
  /** Extra classes for each cell (e.g. a fixed width in a table). */
  cellClassName?: string;
}

/** Value / Min / Max / Avg as four right-aligned tabular-number cells; null → "—". */
export function StatCells({ value, min, max, avg, meta, tempUnit, className, cellClassName }: StatCellsProps) {
  const cells: Array<[string, number | null, string]> = [
    ["Value", value, "text-ink"],
    ["Min", min, "text-slate-400"],
    ["Max", max, "text-slate-300"],
    ["Avg", avg, "text-slate-400"],
  ];
  return (
    <div className={cn("contents", className)}>
      {cells.map(([label, v, tone]) => (
        <span
          key={label}
          aria-label={`${label}: ${fmtSensorValue(v, meta, tempUnit)}`}
          className={cn("num whitespace-nowrap text-right tabular-nums", tone, cellClassName)}
        >
          {fmtSensorValue(v, meta, tempUnit)}
        </span>
      ))}
    </div>
  );
}

export default StatCells;
