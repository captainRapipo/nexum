import { useCallback, useEffect, useMemo, useRef } from "react";
import { use as useEcharts } from "echarts/core";
import { MarkLineComponent } from "echarts/components";
import type { EChartsOption } from "echarts";
import type { EChartsType } from "echarts/core";
import { FRAMETIME_BANDS_MS } from "../../types";
import { EChart } from "../ui";
import { cn } from "../../lib/format";

// The shared EChart primitive registers no markLine; registration is global and idempotent.
useEcharts([MarkLineComponent]);

/** Points kept for drawing (newest). The hook's rolling buffer can reach 120 s × 1000 frames. */
export const FRAMETIME_CHART_MAX_POINTS = 12_000;
/** The y axis never shows less than this (ms), so a steady 7 ms line does not fill the plot. */
const Y_FLOOR_MS = 20;

const LINE = "#2DD4BF";
const REF = "rgba(203,213,225,0.42)";
const MONO = '"JetBrains Mono", Consolas, monospace';

export interface FrametimeChartProps {
  /** Rolling frametimes (ms), oldest first — `useFrames().frametimes`. */
  frametimes: readonly number[];
  className?: string;
}

function yMax(v: { max: number }): number {
  const m = Number.isFinite(v.max) ? v.max : 0;
  return Math.max(Y_FLOOR_MS, Math.ceil((m * 1.08) / 5) * 5);
}

/** Builds the [index, ms] pairs of the newest ≤ FRAMETIME_CHART_MAX_POINTS frames. */
function toPairs(ft: readonly number[]): [number, number][] {
  const start = Math.max(0, ft.length - FRAMETIME_CHART_MAX_POINTS);
  const n = ft.length - start;
  const out = new Array<[number, number]>(n);
  for (let i = 0; i < n; i++) out[i] = [i, ft[start + i]];
  return out;
}

/**
 * Frametime line (x = frame index, y = ms) with reference lines at 60 / 120 / 144 Hz (ROADMAP §6.3).
 * Updates are pushed straight to the chart instance, at most once per animation frame,
 * and skipped while the window is hidden (the newest data is drawn on return).
 */
export default function FrametimeChart({ frametimes, className }: FrametimeChartProps) {
  const chart = useRef<EChartsType | null>(null);
  const latest = useRef(frametimes);
  latest.current = frametimes;
  const dirty = useRef(true);
  const raf = useRef(0);

  // Static option: series data is filled by flush(), never through the option prop.
  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { left: 44, right: 64, top: 14, bottom: 26 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as { value?: [number, number] } | undefined;
          const v = p?.value;
          if (!v) return "";
          const ms = v[1];
          const fps = ms > 0 ? 1000 / ms : 0;
          return `Frame ${v[0] + 1}<br/><b>${ms.toFixed(2)} ms</b> · ${fps >= 100 ? fps.toFixed(0) : fps.toFixed(1)} fps`;
        },
      },
      xAxis: {
        type: "value",
        min: 0,
        max: "dataMax",
        name: "Frames, oldest → newest",
        nameLocation: "middle",
        nameGap: 8,
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: yMax,
        axisLabel: { formatter: "{value} ms" },
      },
      series: [
        {
          type: "line",
          name: "Frame time",
          data: [],
          showSymbol: false,
          smooth: false,
          sampling: "lttb",
          lineStyle: { width: 1.4, color: LINE },
          itemStyle: { color: LINE },
          areaStyle: { color: "rgba(45,212,191,0.07)" },
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            lineStyle: { color: REF, type: "dashed", width: 1 },
            label: {
              position: "end",
              color: "#94A3B8",
              fontFamily: MONO,
              fontSize: 10,
              formatter: (p: unknown) => {
                const d = p as { value?: number; name?: string };
                return `${d.name ?? ""} ${typeof d.value === "number" ? d.value.toFixed(1) : ""}`;
              },
            },
            // 8.3 and 6.9 ms sit close together: nudge their labels apart so they never overlap.
            data: FRAMETIME_BANDS_MS.map((b, i) => ({
              name: b.label,
              yAxis: b.ms,
              label: { offset: [0, i === 0 ? 0 : i === 1 ? -6 : 6] },
            })),
          },
        },
      ],
    }),
    [],
  );

  const flush = useCallback(() => {
    raf.current = 0;
    const c = chart.current;
    if (!c || c.isDisposed() || !dirty.current) return;
    if (typeof document !== "undefined" && document.hidden) return; // drawn again on visibilitychange
    dirty.current = false;
    c.setOption({ series: [{ data: toPairs(latest.current) }] }, { lazyUpdate: true, silent: true });
  }, []);

  const schedule = useCallback(() => {
    dirty.current = true;
    if (raf.current) return;
    raf.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    schedule();
  }, [frametimes, schedule]);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && dirty.current) schedule();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [schedule]);

  const onInit = useCallback(
    (c: EChartsType) => {
      chart.current = c;
      schedule();
    },
    [schedule],
  );

  const shown = Math.min(frametimes.length, FRAMETIME_CHART_MAX_POINTS);
  return (
    <div className={cn("relative w-full", className ?? "h-[260px]")}>
      <EChart option={option} onInit={onInit} className="absolute inset-0" />
      {shown === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-muted">
          Waiting for frames…
        </div>
      )}
      <span className="sr-only">
        Frame time chart of the last {shown} frames, with reference lines at 16.7 ms (60 Hz), 8.3 ms (120 Hz) and 6.9 ms
        (144 Hz).
      </span>
    </div>
  );
}
