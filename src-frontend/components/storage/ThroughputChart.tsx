import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "../ui";

const TEAL = "#2DD4BF";
const CYAN = "#22D3EE";

export interface ThroughputChartProps {
  /** Unix ms timestamps aligned with read/write. */
  ts: number[];
  read: (number | null)[];
  write: (number | null)[];
  height?: number;
}

function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} GB/s`;
  if (v >= 100) return `${v.toFixed(0)} MB/s`;
  if (v >= 10) return `${v.toFixed(1)} MB/s`;
  return `${v.toFixed(2)} MB/s`;
}

/** Mini read/write MB/s line chart for one disk (last ~120 telemetry samples). */
export default function ThroughputChart({ ts, read, write, height = 70 }: ThroughputChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const series = (name: string, color: string, data: (number | null)[]) => ({
      name,
      type: "line" as const,
      data: data.map((v, i) => [ts[i], v]),
      showSymbol: false,
      smooth: 0.35,
      connectNulls: false,
      lineStyle: { width: 1.6, color },
      itemStyle: { color },
      areaStyle: {
        color: {
          type: "linear" as const,
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: `${color}55` },
            { offset: 1, color: `${color}00` },
          ],
        },
      },
      animation: false,
    });

    return {
      backgroundColor: "transparent",
      grid: { left: 2, right: 2, top: 6, bottom: 2 },
      xAxis: { type: "time", show: false },
      yAxis: {
        type: "value",
        show: false,
        min: 0,
        // Keep a small floor so an idle drive doesn't render noise as a full-height spike.
        max: (v: { max: number }) => Math.max(1, v.max * 1.15),
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(8,14,17,0.95)",
        borderColor: "rgba(255,255,255,0.08)",
        textStyle: { color: "#F8FAFC", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
        axisPointer: { type: "line", lineStyle: { color: "rgba(255,255,255,0.15)" } },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { value?: [number, number | null] } | undefined;
          const time = first?.value ? new Date(first.value[0]).toLocaleTimeString() : "";
          const lines = arr.map((p) => {
            const item = p as { seriesName?: string; color?: string; value?: [number, number | null] };
            const v = item.value?.[1];
            return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${item.color};margin-right:6px"></span>${item.seriesName}: <b>${v == null ? "—" : fmtRate(v)}</b>`;
          });
          return [`<span style="color:#64748B">${time}</span>`, ...lines].join("<br/>");
        },
      },
      series: [series("Read", TEAL, read), series("Write", CYAN, write)],
    } as EChartsOption;
  }, [ts, read, write]);

  return <EChart option={option} style={{ width: "100%", height }} />;
}

export { fmtRate };
