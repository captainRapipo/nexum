import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EChartsOption } from "echarts";
import type { EChartsType } from "echarts/core";
import { FRAMETIME_BANDS_MS } from "../../types";
import { CHART_FONT, EChart, FRAMETIME_MARKLINE, SERIES_HEX } from "../ui";
import { cn } from "../../lib/format";

/** Points kept for drawing (newest). The hook's rolling buffer can reach 120 s × 1000 frames. */
export const FRAMETIME_CHART_MAX_POINTS = 12_000;
/** The y axis never shows less than this (ms), so a steady 7 ms line does not fill the plot. */
const Y_FLOOR_MS = 20;

/** Single-series chart: ink graphite, never a status or brand colour (CONTRACT §4.9 rule 4). */
const LINE = SERIES_HEX.single;

export interface FrametimeChartProps {
  /** Rolling frametimes (ms), oldest first — `useFrames().frametimes`. */
  frametimes: readonly number[];
  className?: string;
}

/** Axis top: 20 ms at least, then the next round step above the slowest frame (so every tick is a round number). */
function yMax(v: { max: number }): number {
  const m = (Number.isFinite(v.max) ? v.max : 0) * 1.05;
  if (m <= Y_FLOOR_MS) return Y_FLOOR_MS;
  const step = m <= 100 ? 10 : m <= 500 ? 50 : 100;
  return Math.ceil(m / step) * step;
}

/**
 * Builds the [frames ago, ms] pairs of the newest ≤ FRAMETIME_CHART_MAX_POINTS frames:
 * x runs from −(n − 1) at the oldest frame to 0 ("Now") at the newest.
 */
function toPairs(ft: readonly number[]): [number, number][] {
  const start = Math.max(0, ft.length - FRAMETIME_CHART_MAX_POINTS);
  const n = ft.length - start;
  const out = new Array<[number, number]>(n);
  for (let i = 0; i < n; i++) out[i] = [i - (n - 1), ft[start + i]];
  return out;
}

/** `Now` at the right edge, `−600` (true minus sign, grouped) further back. */
function xLabel(v: number): string {
  const n = Math.round(v);
  return n >= 0 ? "Now" : `−${Math.abs(n).toLocaleString("en-US")}`;
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
      grid: { left: 44, right: 92, top: 8, bottom: 24 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as { value?: [number, number] } | undefined;
          const v = p?.value;
          if (!v) return "";
          const ms = v[1];
          const fps = ms > 0 ? 1000 / ms : 0;
          const ago = Math.abs(Math.round(v[0]));
          const when = ago === 0 ? "Newest frame" : `${ago.toLocaleString("en-US")} ${ago === 1 ? "frame" : "frames"} ago`;
          return `${when}<br/><b>${ms.toFixed(2)} ms</b> · ${fps >= 100 ? fps.toFixed(0) : fps.toFixed(1)} fps`;
        },
      },
      xAxis: {
        type: "value",
        min: "dataMin",
        max: 0,
        axisLine: { show: true },
        // Three labels, set with the data in flush(): the oldest frame, the middle and "Now".
        axisLabel: { formatter: xLabel, customValues: [0], showMinLabel: true, showMaxLabel: true, alignMinLabel: "left", alignMaxLabel: "right" },
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
          lineStyle: { width: 1.25, color: LINE },
          itemStyle: { color: LINE },
          areaStyle: { color: LINE, opacity: 0.05 },
          emphasis: { disabled: true },
          // Refresh-rate guides: dashed, labelled at the right edge ("60 Hz · 16.7").
          markLine: {
            ...FRAMETIME_MARKLINE,
            animation: false,
            label: {
              ...FRAMETIME_MARKLINE.label,
              fontFamily: CHART_FONT,
              fontWeight: 500,
              distance: 8,
              formatter: (p: unknown) => {
                const d = p as { value?: number; name?: string };
                return `${d.name ?? ""} · ${typeof d.value === "number" ? d.value.toFixed(1) : ""}`;
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
    const pairs = toPairs(latest.current);
    const oldest = pairs.length > 0 ? pairs[0][0] : 0;
    const ticks = oldest <= -4 ? [oldest, Math.round(oldest / 2), 0] : [0];
    c.setOption({ xAxis: { axisLabel: { customValues: ticks } }, series: [{ data: pairs }] }, { lazyUpdate: true, silent: true });
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
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-callout text-ink-3">
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
