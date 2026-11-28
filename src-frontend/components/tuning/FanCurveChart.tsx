import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import type { FanCurvePoint, TuningRange } from "../../types";
import { CHART_HEX, EChart, SERIES_HEX } from "../ui";
import { cn } from "../../lib/format";

export interface FanCurveChartProps {
  points: readonly FanCurvePoint[];
  tempRange: TuningRange | null;
  pctRange: TuningRange | null;
  className?: string;
}

/**
 * Read-only 5-point GPU fan curve (temperature → fan %): one ink line with hollow point marks
 * (SPEC §25 single series). No drag handles, no editing.
 */
export default function FanCurveChart({ points, tempRange, pctRange, className }: FanCurveChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const data = points.map((p) => [p.tempC, p.pct]);
    const color = SERIES_HEX.single;
    const temps = points.map((p) => p.tempC);
    const xMin = Math.floor(Math.min(tempRange?.min ?? Infinity, ...temps) / 5) * 5;
    const xMax = Math.ceil(Math.max(tempRange?.max ?? -Infinity, ...temps) / 5) * 5;
    return {
      animation: false,
      grid: { left: 38, right: 12, top: 10, bottom: 24, containLabel: false },
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { value?: [number, number]; dataIndex?: number };
          if (!p.value) return "";
          return `<span style="color:${CHART_HEX.label}">Point ${(p.dataIndex ?? 0) + 1}</span><br/><b>${p.value[0]} °C → ${p.value[1]}%</b>`;
        },
      },
      xAxis: {
        type: "value",
        min: Number.isFinite(xMin) ? xMin : "dataMin",
        max: Number.isFinite(xMax) ? xMax : "dataMax",
        axisLabel: { formatter: "{value} °C", showMinLabel: true, showMaxLabel: true, alignMinLabel: "left", alignMaxLabel: "right" },
        axisLine: { show: true, lineStyle: { color: CHART_HEX.axis, width: 1 } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: Math.min(0, pctRange?.min ?? 0),
        max: Math.max(100, pctRange?.max ?? 100),
        interval: 25,
        axisLabel: { formatter: "{value}%" },
      },
      series: [
        {
          type: "line",
          name: "Fan speed",
          data,
          smooth: false,
          showSymbol: true,
          symbol: "emptyCircle",
          symbolSize: 9,
          lineStyle: { width: 1.75, color },
          itemStyle: { color, borderWidth: 2 },
          areaStyle: { color, opacity: 0.06 },
          emphasis: { disabled: true },
        },
      ],
    } as EChartsOption;
  }, [points, tempRange, pctRange]);

  return (
    <div className={cn("relative min-h-[200px] w-full flex-1", className)}>
      <div className="absolute inset-0">
        <EChart option={option} notMerge />
      </div>
      <span className="sr-only">Fan curve: {points.map((p) => `${p.tempC} °C at ${p.pct}%`).join(", ")}.</span>
    </div>
  );
}
