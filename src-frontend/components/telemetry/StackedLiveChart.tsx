import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Activity } from "lucide-react";
import { EChart, TONE_HEX } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { cn } from "../../lib/format";
import type { TelemetryPacket } from "../../types";

const WINDOW = 120;
/** Disk activity is normalised against the rolling window max, but never below this floor (MB/s) so idle noise doesn't read as 100%. */
const DISK_FLOOR_MBPS = 25;

const SERIES = [
  { key: "cpu", name: "CPU", color: TONE_HEX.teal },
  { key: "gpu", name: "GPU", color: TONE_HEX.gold },
  { key: "ram", name: "RAM", color: TONE_HEX.purple },
  { key: "disk", name: "Disk", color: TONE_HEX.cyan },
] as const;

type Mode = "area" | "bar";

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function diskMBps(p: TelemetryPacket): number {
  let sum = 0;
  for (const d of p.disks ?? []) {
    if (finite(d.readMBps)) sum += Math.max(0, d.readMBps);
    if (finite(d.writeMBps)) sum += Math.max(0, d.writeMBps);
  }
  return sum;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface ChartData {
  labels: string[];
  cpu: (number | null)[];
  gpu: (number | null)[];
  ram: (number | null)[];
  disk: (number | null)[];
  ramGb: (number | null)[];
  diskRaw: number[];
  diskScale: number;
}

function buildData(history: TelemetryPacket[]): ChartData {
  const win = history.slice(-WINDOW);
  const diskRaw = win.map(diskMBps);
  const diskScale = Math.max(DISK_FLOOR_MBPS, ...diskRaw);
  return {
    labels: win.map((p) => hhmmss(p.ts)),
    cpu: win.map((p) => (finite(p.cpu?.loadTotal) ? round1(p.cpu.loadTotal) : null)),
    gpu: win.map((p) => {
      const g = p.gpu?.load;
      return finite(g) ? round1(g) : null;
    }),
    ram: win.map((p) => (finite(p.ram?.loadPct) ? round1(p.ram.loadPct) : null)),
    ramGb: win.map((p) => (finite(p.ram?.usedGb) ? p.ram.usedGb : null)),
    disk: diskRaw.map((v) => round1(Math.min(100, (v / diskScale) * 100))),
    diskRaw,
    diskScale,
  };
}

interface TooltipParam {
  seriesName?: string;
  dataIndex?: number;
  value?: unknown;
  color?: unknown;
  axisValueLabel?: string;
}

export default function StackedLiveChart() {
  const { history } = useTelemetry();
  const [mode, setMode] = useState<Mode>("area");

  const data = useMemo(() => buildData(history), [history]);

  const option = useMemo<EChartsOption>(() => {
    const { labels, ramGb, diskRaw, diskScale } = data;

    const formatter = (raw: unknown): string => {
      const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
      if (params.length === 0) return "";
      const idx = params[0].dataIndex ?? 0;
      const head = escapeHtml(params[0].axisValueLabel ?? labels[idx] ?? "");
      let total = 0;
      const rows = params
        .map((p) => {
          const def = SERIES.find((s) => s.name === p.seriesName);
          const color = def?.color ?? "#CBD5E1";
          const v = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null;
          if (v !== null) total += v;
          let detail = "";
          if (def?.key === "ram" && finite(ramGb[idx])) detail = `${ramGb[idx]!.toFixed(1)} GB`;
          if (def?.key === "disk" && finite(diskRaw[idx])) detail = `${diskRaw[idx].toFixed(1)} MB/s`;
          const valueText = v === null ? "—" : `${v.toFixed(1)}<span style="color:#64748B"> %</span>`;
          return (
            `<div style="display:flex;align-items:center;gap:10px;padding:2px 0;">` +
            `<span style="width:8px;height:8px;border-radius:2px;background:${color};box-shadow:0 0 6px ${color};flex:none"></span>` +
            `<span style="color:#94A3B8;letter-spacing:.14em;font-size:10px;text-transform:uppercase;min-width:38px">${escapeHtml(p.seriesName ?? "")}</span>` +
            `<span style="margin-left:auto;font-family:'JetBrains Mono',ui-monospace,monospace;color:#F8FAFC;font-size:12px">${valueText}</span>` +
            (detail
              ? `<span style="font-family:'JetBrains Mono',ui-monospace,monospace;color:#64748B;font-size:10.5px;min-width:64px;text-align:right">${detail}</span>`
              : `<span style="min-width:64px"></span>`) +
            `</div>`
          );
        })
        .join("");
      return (
        `<div style="min-width:210px">` +
        `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08)">` +
        `<span style="font-family:'JetBrains Mono',ui-monospace,monospace;color:#2DD4BF;font-size:11px">${head}</span>` +
        `<span style="color:#64748B;font-size:10px;letter-spacing:.14em;text-transform:uppercase">Σ ${total.toFixed(0)}</span>` +
        `</div>${rows}` +
        `<div style="margin-top:6px;color:#475569;font-size:9.5px;letter-spacing:.08em">DISK % RELATIVE TO ${diskScale.toFixed(0)} MB/s PEAK</div>` +
        `</div>`
      );
    };

    const series = SERIES.map((s) => {
      const values = data[s.key];
      if (mode === "bar") {
        return {
          name: s.name,
          type: "bar" as const,
          stack: "load",
          data: values,
          barCategoryGap: "18%",
          itemStyle: { color: s.color, opacity: 0.85 },
          emphasis: { focus: "series" as const },
          large: true,
        };
      }
      return {
        name: s.name,
        type: "line" as const,
        stack: "load",
        data: values,
        smooth: 0.35,
        showSymbol: false,
        symbol: "circle",
        symbolSize: 5,
        connectNulls: false,
        sampling: "lttb" as const,
        lineStyle: { width: 1.5, color: s.color, shadowColor: s.color, shadowBlur: 6 },
        itemStyle: { color: s.color },
        areaStyle: {
          color: {
            type: "linear" as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${s.color}66` },
              { offset: 1, color: `${s.color}0A` },
            ],
          },
        },
        emphasis: { focus: "series" as const },
      };
    });

    return {
      backgroundColor: "transparent",
      animation: false,
      animationDurationUpdate: 0,
      textStyle: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
      color: SERIES.map((s) => s.color),
      grid: { left: 30, right: 22, top: 36, bottom: 28 },
      legend: {
        top: 0,
        right: 4,
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 14,
        icon: "roundRect",
        textStyle: { color: "#94A3B8", fontSize: 10.5, fontWeight: 500 },
        inactiveColor: "#334155",
      },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: "rgba(7,11,14,0.94)",
        borderColor: "rgba(45,212,191,0.35)",
        borderWidth: 1,
        padding: [10, 12],
        textStyle: { color: "#F8FAFC", fontSize: 12 },
        extraCssText:
          "border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.55),0 0 18px rgba(45,212,191,0.12);backdrop-filter:blur(10px);",
        axisPointer: {
          type: mode === "bar" ? "shadow" : "line",
          lineStyle: { color: "rgba(45,212,191,0.55)", width: 1, type: "dashed" },
          shadowStyle: { color: "rgba(45,212,191,0.06)" },
        },
        formatter,
      },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: mode === "bar",
        axisLine: { lineStyle: { color: "rgba(255,255,255,0.10)" } },
        axisTick: { show: false },
        axisLabel: {
          color: "#64748B",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          hideOverlap: true,
          margin: 10,
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: (extent: { min: number; max: number }) => Math.max(100, Math.ceil(extent.max / 50) * 50),
        splitNumber: 4,
        axisLabel: {
          color: "#64748B",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          // Layers are stacked, so the axis is a cumulative scale; exact per-layer values live in the tooltip.
          show: false,
        },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.05)", type: "dashed" } },
        axisLine: { show: false },
      },
      series,
    } as EChartsOption;
  }, [data, mode]);

  const empty = data.labels.length === 0;

  return (
    <GlassCard
      title="Live Telemetry"
      icon={<Activity size={14} />}
      accent="teal"
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-muted xl:inline">
            {Math.min(data.labels.length, WINDOW)}/{WINDOW} samples
          </span>
          <div className="flex overflow-hidden rounded-md border border-line" role="group" aria-label="Chart style">
            {(["area", "bar"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cn(
                  "px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] transition-colors",
                  mode === m ? "bg-teal/15 text-teal" : "text-muted hover:bg-white/[0.04] hover:text-ink",
                )}
              >
                {m === "area" ? "Area" : "Bars"}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="relative min-h-[260px] flex-1">
        {/* Remount on mode switch so line↔bar series are rebuilt cleanly instead of merged. */}
        <EChart key={mode} option={option} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] uppercase tracking-[0.22em] text-muted">
            Waiting for telemetry stream…
          </div>
        )}
      </div>
    </GlassCard>
  );
}
