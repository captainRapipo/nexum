import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption, LineSeriesOption } from "echarts";
import { Card, CHART_GRID_WITH_END_LABELS, CHART_HEX, EChart, nexumLine, Segmented, type SeriesKey } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { sensorsUp } from "../../lib/status";
import { NOT_AVAILABLE_TEXT, type TelemetryPacket } from "../../types";
import { finite } from "./sensorHelpers";

type LoadKey = "cpu" | "gpu" | "ram" | "vram";

const SERIES: { key: LoadKey; name: string; describe: string }[] = [
  { key: "cpu", name: "CPU", describe: "CPU load" },
  { key: "gpu", name: "GPU", describe: "GPU load" },
  { key: "ram", name: "RAM", describe: "Memory in use" },
  { key: "vram", name: "VRAM", describe: "Video memory in use" },
];

type RangeSec = 60 | 120 | 600;

const RANGE_OPTIONS: { value: RangeSec; label: string; title: string }[] = [
  { value: 60, label: "1 min", title: "Show the last minute" },
  { value: 120, label: "2 min", title: "Show the last 2 minutes" },
  { value: 600, label: "10 min", title: "Show the last 10 minutes (fills while the Dashboard is open)" },
];

/** Tick spacing per range: five labels from "−range" to "Now". */
const TICK_SEC: Record<RangeSec, number> = { 60: 15, 120: 30, 600: 120 };

interface Sample {
  ts: number;
  cpu: number | null;
  gpu: number | null;
  ram: number | null;
  vram: number | null;
}

function pct(n: number | null | undefined): number | null {
  return finite(n) ? Math.round(Math.max(0, Math.min(100, n)) * 10) / 10 : null;
}

function toSample(p: TelemetryPacket): Sample {
  const u = p.gpu?.vramUsedGb;
  const t = p.gpu?.vramTotalGb;
  return {
    ts: p.ts,
    cpu: pct(p.cpu?.loadTotal),
    gpu: pct(p.gpu?.load),
    ram: pct(p.ram?.loadPct),
    vram: finite(u) && finite(t) && t > 0 ? pct((u / t) * 100) : null,
  };
}

/* The telemetry provider keeps the last 120 packets. The 10-minute range needs more, so samples
   are kept here for as long as the app runs; they are added whenever the Dashboard is on screen
   (a longer absence shows as a break in the lines, never as invented data). */
const KEEP_MS = 10 * 60_000 + 10_000;
let kept: Sample[] = [];
const NO_SAMPLES: readonly Sample[] = [];

function ingest(history: readonly TelemetryPacket[]): readonly Sample[] {
  if (history.length === 0) return kept;
  const newest = history[history.length - 1].ts;
  const last = kept.length > 0 ? kept[kept.length - 1].ts : -Infinity;
  // The clock went backwards (or the stream restarted): start again from what is known now.
  if (newest < last - 5000) kept = [];
  const from = kept.length > 0 ? kept[kept.length - 1].ts : -Infinity;
  let next: Sample[] | null = null;
  for (const p of history) {
    if (p.ts > from) (next ??= kept.slice()).push(toSample(p));
  }
  if (next) {
    const cutoff = next[next.length - 1].ts - KEEP_MS;
    let i = 0;
    while (i < next.length && next[i].ts < cutoff) i++;
    kept = i > 0 ? next.slice(i) : next;
  }
  return kept;
}

/** False while the window is minimised or hidden: chart updates pause. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

type Point = [number, number | null];

interface ChartData {
  /** Per series: [seconds before now (≤ 0), value]. A null value breaks the line at a gap. */
  points: Record<LoadKey, Point[]>;
  last: Record<LoadKey, number | null>;
  empty: boolean;
}

function buildData(samples: readonly Sample[], rangeSec: number): ChartData {
  const points: Record<LoadKey, Point[]> = { cpu: [], gpu: [], ram: [], vram: [] };
  const last: Record<LoadKey, number | null> = { cpu: null, gpu: null, ram: null, vram: null };
  if (samples.length === 0) return { points, last, empty: true };
  const now = samples[samples.length - 1].ts;
  const from = now - rangeSec * 1000;
  let start = samples.length - 1;
  while (start > 0 && samples[start - 1].ts >= from) start--;
  const win = samples.slice(start);
  // A pause longer than a few intervals (Dashboard closed, PC asleep) is a gap, not a straight line.
  let step = Infinity;
  for (let i = 1; i < win.length; i++) step = Math.min(step, win[i].ts - win[i - 1].ts);
  const gapMs = Math.max(5000, (Number.isFinite(step) ? step : 1000) * 3.5);
  for (let i = 0; i < win.length; i++) {
    const s = win[i];
    const x = Math.round((s.ts - now) / 100) / 10;
    const gap = i > 0 && s.ts - win[i - 1].ts > gapMs;
    for (const { key } of SERIES) {
      if (gap) points[key].push([x - 0.05, null]);
      points[key].push([x, s[key]]);
    }
  }
  const tail = win[win.length - 1];
  for (const { key } of SERIES) last[key] = tail[key];
  return { points, last, empty: false };
}

/** Vertical nudges that keep the line-end labels from overlapping (labels are ~15 px tall). */
function endLabelOffsets(last: Record<LoadKey, number | null>, keys: readonly LoadKey[], plotH: number): Record<LoadKey, number> {
  const out: Record<LoadKey, number> = { cpu: 0, gpu: 0, ram: 0, vram: 0 };
  if (plotH <= 0) return out;
  const GAP = 16;
  const items = keys
    .filter((k) => last[k] != null)
    .map((k) => ({ k, y: (1 - (last[k] as number) / 100) * plotH, to: 0 }))
    .sort((a, b) => a.y - b.y || keys.indexOf(a.k) - keys.indexOf(b.k));
  let floor = -Infinity;
  for (const it of items) {
    it.to = Math.max(it.y, floor);
    floor = it.to + GAP;
  }
  let ceil = plotH - 1;
  for (let i = items.length - 1; i >= 0; i--) {
    items[i].to = Math.min(items[i].to, ceil);
    ceil = items[i].to - GAP;
  }
  for (const it of items) out[it.k] = Math.round(it.to - it.y);
  return out;
}

function axisTime(v: number): string {
  const s = Math.abs(Math.round(v));
  if (s === 0) return "Now";
  return s >= 120 && s % 60 === 0 ? `−${s / 60} min` : `−${s} s`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface TooltipParam {
  seriesName?: string;
  value?: unknown;
  color?: unknown;
}

function tooltipHtml(raw: unknown): string {
  const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
  if (params.length === 0) return "";
  const first = Array.isArray(params[0].value) ? Number(params[0].value[0]) : 0;
  const ago = Math.abs(Math.round(first));
  const head = ago === 0 ? "Now" : ago >= 60 ? `${Math.floor(ago / 60)} min ${ago % 60} s ago` : `${ago} s ago`;
  const rows = params
    .map((p) => {
      const def = SERIES.find((s) => s.name === p.seriesName);
      const y = Array.isArray(p.value) ? p.value[1] : null;
      const v = typeof y === "number" && Number.isFinite(y) ? `${y.toFixed(1)}%` : "—";
      const swatch = typeof p.color === "string" ? p.color : "currentColor";
      return (
        `<div style="display:flex;align-items:center;gap:8px;padding:2px 0">` +
        `<span style="width:10px;height:2.5px;border-radius:2px;background:${swatch};flex:none"></span>` +
        `<span style="color:var(--color-ink-2);min-width:132px">${escapeHtml(def?.describe ?? p.seriesName ?? "")}</span>` +
        `<span style="margin-left:auto;font-weight:600;color:var(--color-ink)">${v}</span>` +
        `</div>`
      );
    })
    .join("");
  return `<div style="min-width:200px"><div style="margin-bottom:4px;color:var(--color-ink-3);font-size:11px;font-weight:500">${head}</div>${rows}</div>`;
}

/**
 * "Load" (CONTRACT §4.10.3, SPEC §25): share of capacity in use for CPU, GPU, memory and video
 * memory as unstacked lines on a 0–100 % axis. Every line end carries its live value, so there is
 * no legend and no pinned tooltip (the tooltip appears on hover only). A series with no data in the
 * window is left out entirely instead of being drawn as zero.
 */
export default function LiveChart() {
  const { history, agent } = useTelemetry();
  const visible = useDocumentVisible();
  const frozen = useRef<TelemetryPacket[]>(history);
  if (visible) frozen.current = history;
  const source = frozen.current;

  const [range, setRange] = useState<RangeSec>(120);
  const samples = useMemo(() => ingest(source), [source]);
  // Sensor reading is not up (being restarted, or Rust gave up): the kept samples are not "now" any more.
  // The chart says so instead of showing frozen lines whose end labels claim live values; when readings
  // return, the lines come back with a gap.
  const down = !sensorsUp(agent);
  const data = useMemo(() => buildData(down ? NO_SAMPLES : samples, range), [down, samples, range]);

  const present = useMemo(() => SERIES.filter((s) => data.points[s.key].some((p) => p[1] !== null)), [data]);
  const missing = SERIES.filter((s) => !present.includes(s));

  // Plot height, for placing the line-end labels.
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setBoxH(el.clientHeight);
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const plotH = boxH - CHART_GRID_WITH_END_LABELS.top - CHART_GRID_WITH_END_LABELS.bottom;

  const option = useMemo<EChartsOption>(() => {
    const keys = present.map((s) => s.key);
    const offsets = endLabelOffsets(data.last, keys, plotH);
    const series = present.map((s) => {
      const pts = data.points[s.key];
      const base = nexumLine(s.name, s.key as SeriesKey, [], "%");
      const color = typeof base.color === "string" ? base.color : undefined;
      // A dot marks where each line ends (the "now" edge); every other point has no symbol.
      const items = pts.map((p, i) =>
        i === pts.length - 1 && p[1] !== null
          ? { value: p, symbol: "circle", symbolSize: 7, itemStyle: { color, borderColor: "white", borderWidth: 1.5 } }
          : p,
      );
      return {
        ...base,
        data: items,
        showSymbol: true,
        symbol: "none",
        endLabel: { ...base.endLabel, offset: [0, offsets[s.key]] },
      } as LineSeriesOption;
    });

    return {
      animation: false,
      grid: { ...CHART_GRID_WITH_END_LABELS },
      tooltip: { trigger: "axis", formatter: tooltipHtml },
      xAxis: {
        type: "value",
        min: -range,
        max: 0,
        interval: TICK_SEC[range],
        axisLine: { show: true, lineStyle: { color: CHART_HEX.axis, width: 1 } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { formatter: (v: number) => axisTime(v), margin: 9, alignMinLabel: "left", alignMaxLabel: "right" },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        interval: 25,
        axisLabel: { formatter: "{value}%", margin: 8 },
      },
      series,
    } as EChartsOption;
  }, [data, present, plotH, range]);

  const seriesKey = present.map((s) => s.key).join(",");

  return (
    <Card
      title="Load"
      subtitle="Share of capacity in use · lines labelled with live values"
      actions={<Segmented value={range} options={RANGE_OPTIONS} onChange={setRange} size="sm" ariaLabel="Time range" />}
      className="h-full min-h-0"
      bodyClassName="flex min-h-0 flex-col"
    >
      <div ref={boxRef} className="relative min-h-0 flex-1">
        {/* Remount when the visible series set changes so a removed series disappears cleanly. */}
        <EChart key={seriesKey} option={option} className="absolute inset-0 min-h-0" style={{ width: "100%", height: "100%" }} />
        {data.empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-callout text-ink-3">
            {agent?.phase === "failed" ? NOT_AVAILABLE_TEXT : "Waiting for sensor data…"}
          </div>
        )}
      </div>
      {!data.empty && missing.length > 0 && (
        <div className="mt-1 shrink-0 truncate text-callout text-ink-3">Not shown (no data): {missing.map((s) => s.describe).join(", ")}</div>
      )}
    </Card>
  );
}
