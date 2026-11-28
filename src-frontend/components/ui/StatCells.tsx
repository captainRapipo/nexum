import type { SensorMeta } from "../../types";
import { cn, fmtSensorValue, toTempUnit } from "../../lib/format";

// CONTRACT §4.7, §4.8 (units once) / docs/design/SPEC.md §8.

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

/**
 * Value / Min / Max / Avg as four right-aligned tabular-number cells; null → "—".
 * The unit is shown ONCE, in tertiary text after the value; Min, Max and Avg are numbers only.
 */
export function StatCells({ value, min, max, avg, meta, tempUnit, className, cellClassName }: StatCellsProps) {
  const toF = meta.unit === "°C" && tempUnit === "F";
  const unit: string = toF ? "°F" : meta.unit;
  const bare = { decimals: meta.decimals, kind: meta.kind, unit: "" } as StatCellsProps["meta"];
  const num = (v: number | null) => fmtSensorValue(v == null || !toF ? v : toTempUnit(v, "F"), bare, "C");
  const full = (v: number | null) => fmtSensorValue(v, meta, tempUnit);
  const rest: Array<[string, number | null]> = [
    ["Min", min],
    ["Max", max],
    ["Avg", avg],
  ];
  return (
    <div className={cn("contents", className)}>
      <span aria-label={`Value: ${full(value)}`} className={cn("tnum whitespace-nowrap text-right", value == null ? "text-ink-3" : "font-semibold text-ink", cellClassName)}>
        {num(value)}
        {value != null && unit !== "" && <span className="ml-[3px] font-normal text-ink-3">{unit}</span>}
      </span>
      {rest.map(([label, v]) => (
        <span key={label} aria-label={`${label}: ${full(v)}`} className={cn("tnum whitespace-nowrap text-right", v == null ? "text-ink-3" : "text-ink-2", cellClassName)}>
          {num(v)}
        </span>
      ))}
    </div>
  );
}

export default StatCells;
