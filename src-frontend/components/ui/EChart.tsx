import { useEffect, useRef, type CSSProperties } from "react";
// Tree-shaken ECharts: only the chart types / components Nexum renders (keeps the bundle ~half size).
import * as echarts from "echarts/core";
import { BarChart, GaugeChart, LineChart, PieChart } from "echarts/charts";
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { EChartsType } from "echarts/core";

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);
import { cn } from "../../lib/format";

/** Registered once: dark HUD defaults so every chart matches the theme even with minimal options. */
export const NEXUM_CHART_THEME = "nexum";

const MONO = '"JetBrains Mono", Consolas, monospace';
const SANS = '"Inter", "Segoe UI", system-ui, sans-serif';

const axisCommon = {
  axisLine: { show: true, lineStyle: { color: "rgba(255,255,255,0.10)" } },
  axisTick: { show: false, lineStyle: { color: "rgba(255,255,255,0.10)" } },
  axisLabel: { color: "#64748B", fontFamily: MONO, fontSize: 10 },
  splitLine: { show: true, lineStyle: { color: "rgba(255,255,255,0.05)", type: "dashed" } },
  splitArea: { show: false },
  nameTextStyle: { color: "#64748B", fontFamily: SANS, fontSize: 10 },
};

let themeRegistered = false;
function ensureTheme(): void {
  if (themeRegistered) return;
  themeRegistered = true;
  echarts.registerTheme(NEXUM_CHART_THEME, {
    color: ["#2DD4BF", "#D4A359", "#A855F7", "#CBD5E1", "#22D3EE", "#E11D48"],
    backgroundColor: "transparent",
    textStyle: { fontFamily: SANS, color: "#94A3B8" },
    title: { textStyle: { color: "#F8FAFC", fontFamily: SANS }, subtextStyle: { color: "#64748B" } },
    legend: { textStyle: { color: "#94A3B8", fontFamily: SANS, fontSize: 11 }, icon: "roundRect", itemWidth: 10, itemHeight: 4 },
    tooltip: {
      backgroundColor: "rgba(7,13,16,0.94)",
      borderColor: "rgba(45,212,191,0.28)",
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: "#E2E8F0", fontFamily: MONO, fontSize: 11 },
      extraCssText:
        "border-radius:10px;backdrop-filter:blur(10px);box-shadow:0 12px 32px -8px rgba(0,0,0,.8),0 0 18px -8px rgba(45,212,191,.5);",
      axisPointer: {
        lineStyle: { color: "rgba(45,212,191,0.45)", width: 1, type: "dashed" },
        crossStyle: { color: "rgba(45,212,191,0.45)" },
        shadowStyle: { color: "rgba(45,212,191,0.06)" },
      },
    },
    categoryAxis: { ...axisCommon, splitLine: { ...axisCommon.splitLine, show: false } },
    valueAxis: { ...axisCommon, axisLine: { ...axisCommon.axisLine, show: false } },
    timeAxis: { ...axisCommon, splitLine: { ...axisCommon.splitLine, show: false } },
    logAxis: axisCommon,
    line: { symbol: "none", smooth: true, lineStyle: { width: 1.6 } },
    bar: { itemStyle: { borderRadius: [2, 2, 0, 0] } },
    gauge: {
      axisLine: { lineStyle: { color: [[1, "rgba(255,255,255,0.08)"]] } },
      title: { color: "#94A3B8" },
      detail: { color: "#F8FAFC", fontFamily: MONO },
    },
    dataZoom: {
      backgroundColor: "transparent",
      borderColor: "rgba(255,255,255,0.08)",
      textStyle: { color: "#64748B" },
    },
  });
}

export interface EChartProps {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
  /** Replace instead of merge on update. Default false (CONTRACT: setOption(notMerge=false)). */
  notMerge?: boolean;
  /** Theme name; defaults to the registered "nexum" HUD theme. */
  theme?: string;
  /** Receive the instance after init (e.g. to dispatchAction). */
  onInit?: (chart: EChartsType) => void;
  /** Event handlers, e.g. `{ click: (p) => ... }`. */
  onEvents?: Record<string, (params: unknown) => void>;
}

/** Thin ECharts wrapper: init on mount, setOption on change, ResizeObserver, dispose on unmount. */
export function EChart({ option, className, style, notMerge = false, theme, onInit, onEvents }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const lastOption = useRef<EChartsOption | null>(null);
  const optionRef = useRef(option);
  optionRef.current = option;
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;

  // Init / dispose
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    ensureTheme();
    const instance = echarts.init(node, theme ?? NEXUM_CHART_THEME, { renderer: "canvas" });
    chart.current = instance;
    instance.setOption(optionRef.current, { notMerge: true });
    lastOption.current = optionRef.current;
    onInitRef.current?.(instance);

    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!instance.isDisposed()) instance.resize();
      });
    });
    ro.observe(node);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      instance.dispose();
      chart.current = null;
      lastOption.current = null;
    };
  }, [theme]);

  // Option updates
  useEffect(() => {
    const instance = chart.current;
    if (!instance || instance.isDisposed() || lastOption.current === option) return;
    instance.setOption(option, { notMerge, lazyUpdate: true });
    lastOption.current = option;
  }, [option, notMerge]);

  // Event bindings
  useEffect(() => {
    const instance = chart.current;
    if (!instance || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [name, handler] of entries) instance.on(name, handler);
    return () => {
      if (instance.isDisposed()) return;
      for (const [name, handler] of entries) instance.off(name, handler);
    };
  }, [onEvents, theme]);

  return <div ref={el} className={cn("h-full min-h-[60px] w-full", className)} style={style} />;
}

export default EChart;
