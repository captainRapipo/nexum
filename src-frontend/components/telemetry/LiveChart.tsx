import { useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Activity } from "lucide-react";
import { EChart, SERIES_HEX } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import type { TelemetryPacket } from "../../types";
import { finite } from "./sensorHelpers";

const WINDOW = 120;

type SeriesKey = "cpu" | "gpu" | "vram" | "ram";

const SERIES: { key: SeriesKey; name: string; color: string; describe: string }[] = [
  { key: "cpu", name: "CPU", color: SERIES_HEX.cpu, describe: "CPU load" },
  { key: "gpu", name: "GPU", color: SERIES_HEX.gpu, describe: "GPU load" },
  { key: "vram", name: "VRAM", color: SERIES_HEX.vram, describe: "VRAM used, % of total" },
  { key: "ram", name: "RAM", color: SERIES_HEX.ram, describe: "RAM used, % of total" },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(n: number | null | undefined): number | null {
  return finite(n) ? round1(Math.max(0, Math.min(100, n))) : null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "Last 2 min" / "Last 45 s" from the packet timestamps (the poll interval is not always 1 s). */
function spanText(win: readonly TelemetryPacket[]): string {
  if (win.length < 2) return "Live";
  const secs = Math.max(1, Math.round((win[win.length - 1].ts - win[0].ts) / 1000));
  return secs >= 90 ? `Last ${Math.round(secs / 60)} min` : `Last ${secs} s`;
}

interface ChartData {
  labels: string[];
  values: Record<SeriesKey, (number | null)[]>;
}

function buildData(history: TelemetryPacket[]): ChartData {
  const win = history.slice(-WINDOW);
  return {
    labels: win.map((p) => hhmmss(p.ts)),
    values: {
      cpu: win.map((p) => pct(p.cpu?.loadTotal)),
      gpu: win.map((p) => pct(p.gpu?.load)),
      vram: win.map((p) => {
        const u = p.gpu?.vramUsedGb;
        const t = p.gpu?.vramTotalGb;
        return finite(u) && finite(t) && t > 0 ? pct((u / t) * 100) : null;
      }),
      ram: win.map((p) => pct(p.ram?.loadPct)),
    },
  };
}

/** False while the window is minimized / hidden: chart updates pause (CONTRACT §2 "Minimized to tray"). */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

interface TooltipParam {
  seriesName?: string;
  dataIndex?: number;
  value?: unknown;
  axisValueLabel?: string;
}

/**
 * Live telemetry (MF-9): unstacked lines on a labelled 0–100 % axis. A series with no data in the
 * window is omitted entirely (no line, no legend entry) instead of being drawn as zero.
 */
export default function LiveChart() {
  const { history } = useTelemetry();
  const visible = useDocumentVisible();
  const frozen = useRef<TelemetryPacket[]>(history);
  if (visible) frozen.current = history;
  const source = frozen.current;

  const data = useMemo(() => buildData(source), [source]);

  const present = useMemo(
    () => SERIES.filter((s) => data.values[s.key].some((v) => v !== null)),
    [data],
  );
  const missing = SERIES.filter((s) => !present.includes(s));

  const option = useMemo<EChartsOption>(() => {
    const { labels } = data;

    const formatter = (raw: unknown): string => {
      const params = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
      if (params.length === 0) return "";
      const idx = params[0].dataIndex ?? 0;
      const head = escapeHtml(params[0].axisValueLabel ?? labels[idx] ?? "");
      const rows = params
        .map((p) => {
          const def = SERIES.find((s) => s.name === p.seriesName);
          const color = def?.color ?? "#CBD5E1";
          const v = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null;
          const valueText = v === null ? "—" : `${v.toFixed(1)}<span style="color:#64748B"> %</span>`;
          return (
            `<div style="display:flex;align-items:center;gap:10px;padding:2px 0;">` +
            `<span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>` +
            `<span style="color:#94A3B8;font-size:11px;min-width:150px">${escapeHtml(def?.describe ?? p.seriesName ?? "")}</span>` +
            `<span style="margin-left:auto;font-family:'JetBrains Mono',ui-monospace,monospace;color:#F8FAFC;font-size:12px">${valueText}</span>` +
            `</div>`
          );
        })
        .join("");
      return (
        `<div style="min-width:220px">` +
        `<div style="margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08);font-family:'JetBrains Mono',ui-monospace,monospace;color:#CBD5E1;font-size:11px">${head}</div>` +
        `${rows}</div>`
      );
    };

    const series = present.map((s) => ({
      name: s.name,
      type: "line" as const,
      data: data.values[s.key],
      smooth: 0.25,
      showSymbol: false,
      symbol: "circle",
      symbolSize: 5,
      connectNulls: false,
      sampling: "lttb" as const,
      lineStyle: { width: 1.6, color: s.color },
      itemStyle: { color: s.color },
      emphasis: { focus: "series" as const },
    }));

    return {
      backgroundColor: "transparent",
      animation: false,
      animationDurationUpdate: 0,
      textStyle: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
      color: present.map((s) => s.color),
      grid: { left: 46, right: 16, top: 36, bottom: 28 },
      legend: {
        top: 0,
        right: 4,
        itemWidth: 14,
        itemHeight: 3,
        itemGap: 14,
        icon: "rect",
        data: present.map((s) => s.name),
        textStyle: { color: "#94A3B8", fontSize: 10.5, fontWeight: 500 },
        inactiveColor: "#334155",
      },
      tooltip: {
        trigger: "axis",
        confine: true,
        backgroundColor: "rgba(7,11,14,0.94)",
        borderColor: "rgba(255,255,255,0.12)",
        borderWidth: 1,
        padding: [10, 12],
        textStyle: { color: "#F8FAFC", fontSize: 12 },
        extraCssText: "border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.55);backdrop-filter:blur(10px);",
        axisPointer: { type: "line", lineStyle: { color: "rgba(203,213,225,0.45)", width: 1, type: "dashed" } },
        formatter,
      },
      xAxis: {
        type: "category",
        data: labels,
        boundaryGap: false,
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
        max: 100,
        interval: 25,
        name: "%",
        nameLocation: "end",
        nameGap: 10,
        nameTextStyle: { color: "#64748B", fontSize: 10, align: "right" },
        axisLabel: {
          color: "#64748B",
          fontSize: 10,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          formatter: "{value}%",
        },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.05)", type: "dashed" } },
        axisLine: { show: false },
      },
      series,
    } as EChartsOption;
  }, [data, present]);

  const empty = data.labels.length === 0;
  const seriesKey = present.map((s) => s.key).join(",");

  return (
    <GlassCard
      title="Live telemetry"
      icon={<Activity size={14} />}
      accent="teal"
      className="flex h-full min-h-0 flex-col"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted max-[1439px]:hidden">
          {spanText(source.slice(-WINDOW))}
        </span>
      }
    >
      <div className="relative min-h-[240px] flex-1">
        {/* Remount when the visible series set changes so removed series and legend entries disappear cleanly. */}
        <EChart key={seriesKey} option={option} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] uppercase tracking-[0.22em] text-muted">
            Waiting for telemetry…
          </div>
        )}
      </div>
      {!empty && missing.length > 0 && (
        <div className="mt-1.5 text-[10.5px] text-muted">
          Not shown (no data): {missing.map((s) => s.describe).join(", ")}
        </div>
      )}
    </GlassCard>
  );
}
