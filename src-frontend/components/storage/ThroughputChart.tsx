import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { CHART_FONT, CHART_HEX, EChart, SERIES_HEX, nexumLine, type SeriesKey } from "../ui";
import { cn } from "../../lib/format";

export interface ThroughputChartProps {
  /** Unix ms timestamps aligned with read/write, oldest first. */
  ts: readonly number[];
  read: readonly (number | null)[];
  write: readonly (number | null)[];
  /** Width of the time window in seconds (the x axis runs from −rangeSec to Now). */
  rangeSec?: number;
  className?: string;
}

export function fmtRate(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(2)} GB/s`;
  if (v >= 100) return `${v.toFixed(0)} MB/s`;
  if (v >= 10) return `${v.toFixed(1)} MB/s`;
  return `${v.toFixed(2)} MB/s`;
}

/** Number part of a rate for a line-end label, in MB/s ("1.95", "12.4", "310"). */
function rateNumber(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** Next "nice" axis maximum (1, 2, 4, 5, 8 × 10ⁿ) at or above `v`; never below 1 MB/s so idle noise stays flat. */
function niceMax(v: number): number {
  const x = Math.max(1, v);
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 4, 5, 8, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function endLabel(name: string, key: SeriesKey, inGb: boolean) {
  return {
    show: true,
    distance: 10,
    padding: [3, 0],
    lineHeight: 16,
    fontFamily: CHART_FONT,
    fontSize: 11.5,
    fontWeight: 500 as const,
    color: CHART_HEX.text,
    formatter: (p: { value?: unknown }) => {
      const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
      // On the MB/s axis the label is the bare number; on a GB/s axis it carries its own unit,
      // because the live value is usually far below the axis maximum.
      return v == null ? "" : `{s|} {v|${inGb ? fmtRate(Number(v)) : rateNumber(Number(v))}} ${name}`;
    },
    rich: {
      s: { width: 10, height: 2.5, borderRadius: 2, backgroundColor: SERIES_HEX[key] },
      v: { color: CHART_HEX.ink, fontWeight: 600 as const, fontFamily: CHART_FONT, fontSize: 11.5 },
    },
  };
}

/**
 * Live read / write throughput of one drive (SPEC §25): two labelled lines, no legend, the tooltip
 * only on hover. Read is navy, Write is teal; neither is a status colour.
 */
export default function ThroughputChart({ ts, read, write, rangeSec = 120, className }: ThroughputChartProps) {
  const option = useMemo<EChartsOption>(() => {
    const last = ts.length > 0 ? ts[ts.length - 1] : 0;
    const rel = (i: number) => Math.round((ts[i] - last) / 100) / 10;
    const pairs = (data: readonly (number | null)[]) => {
      const out: Array<[number, number | null]> = [];
      for (let i = 0; i < ts.length; i++) {
        const x = rel(i);
        if (x >= -rangeSec) out.push([x, data[i] ?? null]);
      }
      return out;
    };
    const r = pairs(read);
    const w = pairs(write);
    let peak = 0;
    for (const [, v] of r) if (v != null && v > peak) peak = v;
    for (const [, v] of w) if (v != null && v > peak) peak = v;
    const yMax = niceMax(peak * 1.1);

    const line = (name: string, key: SeriesKey, data: Array<[number, number | null]>) =>
      nexumLine(name, key, [], "", {
        data,
        areaStyle: undefined,
        endLabel: endLabel(name, key, yMax >= 1000),
      });

    return {
      animation: false,
      grid: { left: 58, right: yMax >= 1000 ? 124 : 84, top: 8, bottom: 24, containLabel: false },
      xAxis: {
        type: "value",
        min: -rangeSec,
        max: 0,
        interval: rangeSec / 2,
        axisLabel: {
          formatter: (v: number) => (v === 0 ? "Now" : `−${Math.abs(v) >= 120 ? `${Math.abs(v) / 60} min` : `${Math.abs(v)} s`}`),
          showMinLabel: true,
          showMaxLabel: true,
          alignMinLabel: "left",
          alignMaxLabel: "right",
        },
        axisLine: { show: true, lineStyle: { color: CHART_HEX.axis, width: 1 } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: yMax,
        interval: yMax / 2,
        axisLabel: {
          formatter: (v: number) => {
            const n = yMax >= 1000 ? v / 1000 : v;
            return `${Number.isInteger(n) ? n : n.toFixed(1)} ${yMax >= 1000 ? "GB/s" : "MB/s"}`;
          },
        },
      },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as Array<{ seriesName?: string; color?: string; value?: [number, number | null] }>;
          const x = arr[0]?.value?.[0];
          const head = x == null ? "" : x === 0 ? "Now" : `${Math.abs(Math.round(x))} s ago`;
          const lines = arr.map((p) => {
            const v = p.value?.[1];
            return `<span style="display:inline-block;width:10px;height:2.5px;border-radius:2px;background:${p.color};margin:0 6px 3px 0"></span>${p.seriesName} <b>${v == null ? "—" : fmtRate(v)}</b>`;
          });
          return [`<span style="color:${CHART_HEX.label}">${head}</span>`, ...lines].join("<br/>");
        },
      },
      series: [line("Write", "net", w), line("Read", "disk", r)],
    } as EChartsOption;
  }, [ts, read, write, rangeSec]);

  return <EChart option={option} notMerge className={cn("h-full w-full", className)} />;
}
