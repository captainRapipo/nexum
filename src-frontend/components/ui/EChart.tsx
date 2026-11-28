import { useEffect, useRef, useState, type CSSProperties } from "react";
// Tree-shaken ECharts: only the chart types / components Nexum renders (keeps the bundle ~half size).
import * as echarts from "echarts/core";
import { BarChart, GaugeChart, LineChart, PieChart } from "echarts/charts";
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { LabelLayout } from "echarts/features";
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
  MarkLineComponent,
  // nexumLine() end labels use labelLayout.moveOverlap to keep two close line ends apart.
  LabelLayout,
  CanvasRenderer,
]);
import { cn } from "../../lib/format";
import { NEXUM_CHART_THEME, NEXUM_LIGHT_THEME } from "./echartsTheme";

// The light theme lives in ./echartsTheme (CONTRACT §4.7, §4.9; docs/design/SPEC.md §25); the name stays "nexum".
export { NEXUM_CHART_THEME };

let themeRegistered = false;
function ensureTheme(): void {
  if (themeRegistered) return;
  themeRegistered = true;
  echarts.registerTheme(NEXUM_CHART_THEME, NEXUM_LIGHT_THEME);
}

/**
 * Canvas text is measured once and the widths are cached for the whole session. A chart that paints
 * before the bundled Inter has loaded would cache the widths of the fallback font and keep drawing
 * labels with wrong spacing ("68%RAM"). So the first chart waits for the three Inter weights; this
 * takes a few milliseconds (the files are local) and is capped, so a chart always appears.
 * Returns null when nothing has to be waited for.
 */
const CHART_FONTS = ['400 12px "Inter"', '500 12px "Inter"', '600 12px "Inter"'];
const FONT_WAIT_MS = 1500;
let fontsSettled = false;
let fontsPromise: Promise<void> | null = null;
function whenChartFontsReady(): Promise<void> | null {
  if (fontsSettled || typeof document === "undefined" || !document.fonts) return null;
  const fonts = document.fonts;
  try {
    if (CHART_FONTS.every((f) => fonts.check(f))) {
      fontsSettled = true;
      return null;
    }
  } catch {
    fontsSettled = true;
    return null;
  }
  fontsPromise ??= Promise.race([
    Promise.all(CHART_FONTS.map((f) => fonts.load(f))).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WAIT_MS)),
  ])
    .catch(() => undefined)
    .then(() => {
      fontsSettled = true;
    });
  return fontsPromise;
}

export interface EChartProps {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
  /** Replace instead of merge on update. Default false (CONTRACT: setOption(notMerge=false)). */
  notMerge?: boolean;
  /** Theme name; defaults to the registered "nexum" light theme. */
  theme?: string;
  /** Receive the instance after init (e.g. to dispatchAction). */
  onInit?: (chart: EChartsType) => void;
  /** Event handlers, e.g. `{ click: (p) => ... }`. */
  onEvents?: Record<string, (params: unknown) => void>;
}

/**
 * Thin ECharts wrapper: init on mount (after the chart fonts are ready), setOption on change,
 * ResizeObserver, dispose on unmount. Updates use lazyUpdate, so several option changes within one
 * frame cost one render, and nothing is rendered while the window is hidden.
 */
export function EChart({ option, className, style, notMerge = false, theme, onInit, onEvents }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const lastOption = useRef<EChartsOption | null>(null);
  /** Options that arrived before the instance existed (only while waiting for fonts), oldest first. */
  const queued = useRef<EChartsOption[]>([]);
  const notMergeRef = useRef(notMerge);
  notMergeRef.current = notMerge;
  const optionRef = useRef(option);
  optionRef.current = option;
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;
  // Bumped when a deferred init finishes, so the event bindings attach to the new instance.
  const [instanceTick, setInstanceTick] = useState(0);

  // Init / dispose
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;

    const start = (deferred: boolean) => {
      if (cancelled) return;
      ensureTheme();
      const instance = echarts.init(node, theme ?? NEXUM_CHART_THEME, { renderer: "canvas" });
      chart.current = instance;
      const backlog = queued.current.length > 0 ? queued.current : [optionRef.current];
      queued.current = [];
      backlog.forEach((o, i) => instance.setOption(o, { notMerge: i === 0 ? true : notMergeRef.current }));
      lastOption.current = backlog[backlog.length - 1];
      onInitRef.current?.(instance);

      let frame = 0;
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (!instance.isDisposed()) instance.resize();
        });
      });
      ro.observe(node);

      teardown = () => {
        cancelAnimationFrame(frame);
        ro.disconnect();
        instance.dispose();
        chart.current = null;
        lastOption.current = null;
      };
      if (deferred) setInstanceTick((n) => n + 1);
    };

    const wait = whenChartFontsReady();
    if (wait) {
      queued.current = [optionRef.current];
      void wait.then(() => start(true));
    } else {
      start(false);
    }

    return () => {
      cancelled = true;
      queued.current = [];
      teardown?.();
    };
  }, [theme]);

  // Option updates
  useEffect(() => {
    const instance = chart.current;
    if (!instance) {
      // Still waiting for fonts: keep the order so merge-style updates are not lost (bounded).
      const q = queued.current;
      if (q.length > 0 && q[q.length - 1] !== option) {
        if (notMerge) queued.current = [option];
        else if (q.length < 32) q.push(option);
        else q[q.length - 1] = option;
      }
      return;
    }
    if (instance.isDisposed() || lastOption.current === option) return;
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
  }, [onEvents, theme, instanceTick]);

  return <div ref={el} className={cn("h-full min-h-[60px] w-full", className)} style={style} />;
}

export default EChart;
