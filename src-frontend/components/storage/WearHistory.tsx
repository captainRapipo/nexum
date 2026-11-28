import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Loader2, RefreshCw } from "lucide-react";
import type { DriveForecast, DriveHistory, DriveHistoryPoint } from "../../types";
import { Button, CHART_HEX, EChart, SERIES_HEX } from "../ui";
import { cn, fmtCount } from "../../lib/format";

/** Forecast minimums (CONTRACT §2.11): at least 7 daily points spanning at least 14 days. */
const MIN_POINTS = 7;
const MIN_DAYS = 14;
const DAYS_PER_MONTH = 30.4375;
const DAY_MS = 86_400_000;

/** Day-level parse of "YYYY-MM-DD" as local midnight (the ledger stores local dates). */
function dayTs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "12 months", "3 weeks", "5 days": how much history the ledger covers. */
export function spanText(points: readonly DriveHistoryPoint[]): string | null {
  if (points.length < 2) return null;
  const days = Math.round((dayTs(points[points.length - 1].date) - dayTs(points[0].date)) / DAY_MS);
  if (days >= 45) {
    const m = Math.round(days / DAYS_PER_MONTH);
    return `${m} month${m === 1 ? "" : "s"}`;
  }
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Change of life left per month between the first and the last reading, or null when the span is too short. */
function monthlyRate(points: readonly DriveHistoryPoint[]): number | null {
  const pts = points.filter((p) => p.healthPct != null);
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const days = (dayTs(b.date) - dayTs(a.date)) / DAY_MS;
  if (days < MIN_DAYS) return null;
  return (((b.healthPct as number) - (a.healthPct as number)) / days) * DAYS_PER_MONTH;
}

function rateText(rate: number): string {
  const abs = Math.abs(rate);
  if (abs < 0.05) return "No measurable change";
  const n = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1);
  return `${rate < 0 ? "−" : "+"}${n} points a month`;
}

/** "5 of 7 daily readings, 9 of 14 days" while the forecast is still collecting data; null otherwise. */
export function forecastProgress(f: DriveForecast): string | null {
  if (f.status !== "notEnoughData") return null;
  return (
    `${fmtCount(Math.min(f.points, MIN_POINTS))} of ${MIN_POINTS} daily readings` +
    (f.basisDays < MIN_DAYS ? `, ${fmtCount(f.basisDays)} of ${MIN_DAYS} days` : "")
  );
}

function WearChart({ points }: { points: readonly DriveHistoryPoint[] }) {
  const option = useMemo<EChartsOption>(() => {
    const health = points.map((p) => [dayTs(p.date), p.healthPct] as [number, number | null]);
    const written = new Map(points.map((p) => [dayTs(p.date), p.dataWrittenTb]));
    const first = health[0]?.[0] ?? 0;
    const last = health[health.length - 1]?.[0] ?? 0;
    const color = SERIES_HEX.single;
    return {
      animation: false,
      grid: { left: 36, right: 6, top: 6, bottom: 20, containLabel: false },
      xAxis: {
        type: "value",
        min: first,
        max: last,
        // Only the two ends are labelled.
        interval: Math.max(1, last - first),
        axisLabel: {
          formatter: (v: number) => monthLabel(v),
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
        max: 100,
        interval: 50,
        axisLabel: { formatter: "{value}%" },
      },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as { value?: [number, number | null] } | undefined;
          if (!p?.value) return "";
          const [t, v] = p.value;
          const w = written.get(t);
          const day = new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          return (
            `<span style="color:${CHART_HEX.label}">${day}</span><br/>` +
            `Life left <b>${v == null ? "—" : `${v}%`}</b>` +
            (w != null ? `<br/>Data written <b>${w.toFixed(1)} TB</b>` : "")
          );
        },
      },
      series: [
        {
          name: "Life left",
          type: "line",
          data: health,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { width: 1.5, color },
          itemStyle: { color },
          areaStyle: { color, opacity: 0.06 },
          emphasis: { disabled: true },
        },
      ],
    } as EChartsOption;
  }, [points]);

  return <EChart option={option} notMerge style={{ width: "100%", height: 74 }} className="min-h-0" />;
}

export interface WearHistoryProps {
  history: DriveHistory | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void> | void;
  /** Docked inspector: the caption sits under the chart instead of beside it. */
  compact?: boolean;
}

/**
 * "Wear history" section of the S.M.A.R.T. details (CONTRACT §2.11, §4.10.3): the daily life-left
 * readings from the local ledger as one ink line, and how fast the figure moves. The forecast
 * sentence is shown in the life hero above; the hover lists the data written by each day.
 */
export default function WearHistory({ history, loading, error, reload, compact = false }: WearHistoryProps) {
  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg bg-inset px-3 py-2 text-callout text-ink-2">
        <span className="min-w-0">Could not read the wear history: {error}</span>
        <Button size="sm" icon={RefreshCw} onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!history) {
    return loading ? (
      <div className="flex items-center gap-2 text-callout text-ink-2">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        Reading the wear history…
      </div>
    ) : null;
  }

  const f = history.forecast;
  const chartable = history.points.filter((p) => p.healthPct != null);
  const rate = monthlyRate(chartable);
  const progress = forecastProgress(f);
  const basis =
    f.status !== "notEnoughData"
      ? `Based on ${fmtCount(f.points)} daily reading${f.points === 1 ? "" : "s"} over ${fmtCount(f.basisDays)} day${f.basisDays === 1 ? "" : "s"}.`
      : null;
  const note = [
    progress ? `${progress} so far.` : null,
    basis,
    "One reading per drive per day, kept only on this PC. The forecast is a straight-line estimate and changes with how you use the drive.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      {chartable.length >= 2 ? (
        <div className={cn(compact ? "flex flex-col gap-1.5" : "grid grid-cols-[minmax(0,1fr)_170px] items-center gap-[18px]")}>
          <WearChart points={chartable} />
          <div className="text-callout text-ink-2" title={note}>
            <b className="tnum block text-headline text-ink">{rate == null ? "Collecting readings" : rateText(rate)}</b>
            {!compact && <span>Life left as the drive reports it, one reading a day.</span>}
          </div>
        </div>
      ) : (
        <p className="text-callout text-ink-2">
          {history.points.length === 0 ? "No readings recorded yet." : "The chart appears after two daily readings with a life figure."}
        </p>
      )}
      {(progress || chartable.length < 2) && <p className="mt-2 text-callout text-ink-3">{note}</p>}
    </div>
  );
}
