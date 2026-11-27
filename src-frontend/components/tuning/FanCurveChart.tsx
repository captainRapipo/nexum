import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import type { FanCurvePoint, TuningRange } from "../../types";
import { EChart } from "../ui";
import { cn } from "../../lib/format";

export interface FanCurveChartProps {
  points: readonly FanCurvePoint[];
  tempRange: TuningRange | null;
  pctRange: TuningRange | null;
  className?: string;
}

const LINE = "#22D3EE";

/** Read-only 5-point GPU fan curve (temperature → fan %). No drag handles, no editing. */
export default function FanCurveChart({ points, tempRange, pctRange, className }: FanCurveChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const data = points.map((p) => [p.tempC, p.pct]);
    return {
      animation: false,
      grid: { left: 40, right: 14, top: 12, bottom: 30 },
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { value?: [number, number]; dataIndex?: number };
          if (!p.value) return "";
          return `Point ${(p.dataIndex ?? 0) + 1}<br/><b>${p.value[0]} °C → ${p.value[1]}%</b>`;
        },
      },
      xAxis: {
        type: "value",
        min: tempRange?.min ?? "dataMin",
        max: tempRange?.max ?? "dataMax",
        name: "GPU temperature (°C)",
        nameLocation: "middle",
        nameGap: 20,
        axisLabel: { formatter: "{value}°" },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: pctRange?.min ?? 0,
        max: pctRange?.max ?? 100,
        axisLabel: { formatter: "{value}%" },
      },
      series: [
        {
          type: "line",
          name: "Fan speed",
          data,
          smooth: false,
          showSymbol: true,
          symbol: "circle",
          symbolSize: 8,
          lineStyle: { width: 2, color: LINE },
          itemStyle: { color: LINE, borderColor: "#0D1B1E", borderWidth: 2 },
          areaStyle: { color: "rgba(34,211,238,0.07)" },
        },
      ],
    };
  }, [points, tempRange, pctRange]);

  return (
    <div className={cn("h-[190px] w-full", className)}>
      <EChart option={option} notMerge />
      <span className="sr-only">
        Fan curve: {points.map((p) => `${p.tempC} °C at ${p.pct}%`).join(", ")}.
      </span>
    </div>
  );
}
