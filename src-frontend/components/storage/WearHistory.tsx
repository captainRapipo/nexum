import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Loader2, RefreshCw } from "lucide-react";
import type { DriveForecast, DriveHistoryPoint } from "../../types";
import { DottedLeaderRow, EChart, SERIES_HEX, Sparkline } from "../ui";
import { useDriveHistory } from "../../hooks/useDriveHistory";
import { fmtForecast } from "../../lib/alerts";
import { fmtCount } from "../../lib/format";

/** Forecast minimums (CONTRACT §2.11): ≥ 7 daily points spanning ≥ 14 days. */
const MIN_POINTS = 7;
const MIN_DAYS = 14;

const HEALTH = SERIES_HEX.disk;
const WRITTEN = "#94A3B8";

/** Day-level parse of "YYYY-MM-DD" as local midnight (the ledger stores local dates). */
function dayTs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

function fmtMonths(m: number): string {
  if (m <= 0) return "At or below 10% now";
  if (m < 24) return `About ${m.toFixed(m < 10 ? 1 : 0)} months`;
  return `About ${(m / 12).toFixed(1)} years`;
}

const NOT_REPORTED = <span className="text-muted">Not reported</span>;

function forecastRows(f: DriveForecast) {
  return (
    <div className="space-y-0.5">
      <DottedLeaderRow
        label="Written per month"
        value={f.tbPerMonth != null ? `${f.tbPerMonth.toFixed(2)} TB` : NOT_REPORTED}
        valueClassName="font-mono"
      />
      <DottedLeaderRow
        label="Until 10% life left"
        value={f.monthsTo10Pct != null ? fmtMonths(f.monthsTo10Pct) : <span className="text-muted">—</span>}
        valueClassName="font-mono"
      />
      <DottedLeaderRow
        label="Based on"
        value={`${fmtCount(f.points)} daily reading${f.points === 1 ? "" : "s"} over ${fmtCount(f.basisDays)} day${f.basisDays === 1 ? "" : "s"}`}
        valueClassName="font-mono"
      />
    </div>
  );
}

function WearChart({ points }: { points: readonly DriveHistoryPoint[] }) {
  const option = useMemo<EChartsOption>(() => {
    const health = points.map((p) => [dayTs(p.date), p.healthPct] as [number, number | null]);
    const written = points.map((p) => [dayTs(p.date), p.dataWrittenTb] as [number, number | null]);
    const hasWritten = written.some(([, v]) => v != null);
    const axisLabel = { color: "#64748B", fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" };
    return {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 34, right: hasWritten ? 40 : 8, top: 10, bottom: 20 },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: "rgba(255,255,255,0.12)" } },
        axisLabel: { ...axisLabel, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: "",
          min: (v: { min: number }) => Math.max(0, Math.floor((v.min - 2) / 5) * 5),
          // Zoom to the data (at least a 20-point span) so a slow decline stays visible.
          max: (v: { min: number; max: number }) =>
            Math.min(100, Math.max(Math.ceil((v.max + 2) / 5) * 5, Math.max(0, Math.floor((v.min - 2) / 5) * 5) + 20)),
          axisLabel: { ...axisLabel, formatter: "{value}%" },
          splitLine: { lineStyle: { color: "rgba(255,255,255,0.05)" } },
        },
        {
          type: "value",
          show: hasWritten,
          scale: true,
          axisLabel: { ...axisLabel, formatter: (v: number) => `${v} TB` },
          splitLine: { show: false },
        },
      ],
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(8,14,17,0.95)",
        borderColor: "rgba(255,255,255,0.08)",
        textStyle: { color: "#F8FAFC", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { value?: [number, number | null] } | undefined;
          const day = first?.value ? new Date(first.value[0]).toLocaleDateString() : "";
          const lines = arr.map((p) => {
            const it = p as { seriesName?: string; color?: string; value?: [number, number | null] };
            const v = it.value?.[1];
            const text = v == null ? "—" : it.seriesName === "Life left" ? `${v}%` : `${v.toFixed(1)} TB`;
            return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${it.color};margin-right:6px"></span>${it.seriesName}: <b>${text}</b>`;
          });
          return [`<span style="color:#64748B">${day}</span>`, ...lines].join("<br/>");
        },
      },
      series: [
        {
          name: "Life left",
          type: "line",
          data: health,
          yAxisIndex: 0,
          showSymbol: points.length < 20,
          symbolSize: 4,
          connectNulls: false,
          lineStyle: { width: 1.8, color: HEALTH },
          itemStyle: { color: HEALTH },
        },
        ...(hasWritten
          ? [
              {
                name: "Data written",
                type: "line" as const,
                data: written,
                yAxisIndex: 1,
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 1.2, color: WRITTEN, type: "dashed" as const },
                itemStyle: { color: WRITTEN },
              },
            ]
          : []),
      ],
    } as EChartsOption;
  }, [points]);

  return <EChart option={option} style={{ width: "100%", height: 150 }} />;
}

/**
 * "Wear history" section of the S.M.A.R.T. drawer (CONTRACT §2.11, §4.10.2): daily life-left and
 * data-written readings from the local ledger, and the forecast Rust computes from them.
 */
export default function WearHistory({ serial }: { serial: string }) {
  const { history, loading, error, reload } = useDriveHistory(serial);

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[11.5px] text-slate-400">
        <span className="min-w-0">Could not read the wear history: {error}</span>
        <button
          type="button"
          onClick={() => void reload()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-silver hover:text-ink"
        >
          <RefreshCw size={11} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }
  if (!history) {
    return loading ? (
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Reading the wear history…
      </div>
    ) : null;
  }

  const f = history.forecast;
  const chartable = history.points.filter((p) => p.healthPct != null || p.dataWrittenTb != null);
  const progress =
    f.status === "notEnoughData"
      ? `${fmtCount(Math.min(f.points, MIN_POINTS))} of ${MIN_POINTS} daily readings` +
        (f.basisDays < MIN_DAYS ? `, ${fmtCount(f.basisDays)} of ${MIN_DAYS} days` : "")
      : null;

  return (
    <div>
      {chartable.length >= 2 ? (
        <div className="-mx-1 mb-2">
          <WearChart points={chartable} />
          <div className="mt-0.5 flex items-center gap-3 px-1 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="h-[2px] w-3 rounded" style={{ background: HEALTH }} />
              Life left
            </span>
            {chartable.some((p) => p.dataWrittenTb != null) && (
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true" className="h-0 w-3 border-t border-dashed" style={{ borderColor: WRITTEN }} />
                Data written
              </span>
            )}
          </div>
        </div>
      ) : null}
      <p className="mb-2 text-[12px] leading-relaxed text-silver">{fmtForecast(f)}</p>
      {progress && <p className="mb-2 font-mono text-[11px] text-muted">{progress}</p>}
      {f.status !== "notEnoughData" && forecastRows(f)}
      <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
        Nexum records one reading per drive per day while it runs, kept only on this PC. The forecast is a straight-line
        estimate from the last year and changes with how you use the drive.
      </p>
    </div>
  );
}

/**
 * One-line wear summary for a drive card (CONTRACT §2.11): life-left sparkline of the daily ledger and
 * the forecast sentence. Renders nothing until there is history to show.
 */
export function DiskWearLine({ serial, onDetails }: { serial: string | null; onDetails?: () => void }) {
  const { history } = useDriveHistory(serial && serial.trim() ? serial : null);
  if (!history) return null;
  const f = history.forecast;
  const life = history.points.slice(-120).map((p) => p.healthPct);
  const text = fmtForecast(f);
  const progress =
    f.status === "notEnoughData" ? ` ${fmtCount(Math.min(f.points, MIN_POINTS))} of ${MIN_POINTS} daily readings so far.` : "";
  return (
    <button
      type="button"
      onClick={onDetails}
      disabled={!onDetails}
      title={`${text}${progress} Open the S.M.A.R.T. details for the wear history.`}
      className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-md text-left text-[11px] text-slate-400 transition hover:text-slate-200 disabled:cursor-default"
    >
      <span className="shrink-0 text-[9.5px] uppercase tracking-[0.16em] text-muted">Wear</span>
      {life.filter((v) => v != null).length >= 2 && (
        <span className="w-[72px] shrink-0">
          <Sparkline data={life} color={HEALTH} height={16} fill={false} strokeWidth={1.4} />
        </span>
      )}
      <span className="min-w-0 truncate">
        {text}
        {progress}
      </span>
    </button>
  );
}
