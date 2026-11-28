import { useMemo, type ReactNode } from "react";
import { Gamepad2, Info } from "lucide-react";
import type { FrameStats, FrameTarget } from "../../types";
import { fmtFps } from "../../lib/frames";
import { cn } from "../../lib/format";
import { BoundByTag } from "./BusyBars";
import { PresentModeValue } from "./PresentInfo";
import {
  HERO_LABEL,
  HERO_TOOLTIP,
  LOWS_TOOLTIP,
  NEEDS_2,
  NEEDS_100,
  NEEDS_1000,
  NO_DISPLAY_DATA,
  NO_FRAMES,
  windowSummary,
} from "./gamingText";

export interface FpsHeroProps {
  /** The app being measured (header line of the card). */
  target: FrameTarget | null;
  /** Fresh stats of the current target, or null while waiting. */
  stats: FrameStats | null;
  /** Shown while `stats` is null, e.g. `Waiting for frames from Game.exe…`. */
  waitingText: string;
  /** Rolling frame times of the window (ms, oldest first): the source of the fps trend line. */
  frametimes: readonly number[];
  /** Statistics window in seconds (label of the trend line). */
  windowSec: number;
}

function InfoTip({ text, size = 12 }: { text: string; size?: number }) {
  return (
    <span role="img" tabIndex={0} aria-label={text} title={text} className="inline-flex shrink-0 items-center rounded-xs text-ink-3">
      <Info size={size} aria-hidden="true" />
    </span>
  );
}

/** Number + small unit, or an em dash whose hover explains why the value is missing. */
function Val({ value, unit, nullTitle, unitClassName }: { value: string | null; unit: string; nullTitle: string; unitClassName: string }) {
  if (value == null) {
    return (
      <span className="text-ink-3" title={nullTitle} aria-label={`Not available: ${nullTitle}`}>
        —
      </span>
    );
  }
  return (
    <>
      {value}
      <small className={unitClassName}>{unit}</small>
    </>
  );
}

function Low({ label, value, nullTitle }: { label: string; value: number | null; nullTitle: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[12.5px] font-medium leading-[17px] text-ink-2">
        {label}
        <InfoTip text={LOWS_TOOLTIP} />
      </div>
      <div className="tnum mt-0.5 whitespace-nowrap text-[34px] font-semibold leading-[38px] tracking-[-0.025em] text-ink tight:text-[28px] tight:leading-8">
        <Val
          value={value == null ? null : fmtFps(value)}
          unit="fps"
          nullTitle={nullTitle}
          unitClassName="ml-[3px] text-[14px] font-medium leading-none tracking-normal text-ink-2"
        />
      </div>
    </div>
  );
}

function Cell({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-l border-divider px-4 first:border-l-0 first:pl-0 tight:px-2.5 tight:first:pl-0">
      <span className="block truncate text-caption text-ink-2" title={tip}>
        {label}
      </span>
      <div className="tnum mt-[3px] truncate whitespace-nowrap text-[17px] font-semibold leading-[22px] text-ink tight:text-[15px]">{children}</div>
    </div>
  );
}

const CELL_UNIT = "ml-0.5 text-[12px] font-medium leading-none text-ink-3";
const TREND_POINTS = 72;
/** Frames per point at least: fewer would draw measuring noise, not the frame rate. */
const TREND_MIN_FRAMES = 16;

/**
 * Frames per second over the window, one point per slice of time, derived from the frame times
 * (frames in the slice ÷ the time those frames took). Null until there is enough to draw.
 */
function fpsTrend(frametimes: readonly number[]): number[] | null {
  const n = frametimes.length;
  if (n < TREND_MIN_FRAMES * 4) return null;
  let total = 0;
  for (let i = 0; i < n; i++) total += frametimes[i];
  if (!(total > 0)) return null;
  const buckets = Math.min(TREND_POINTS, Math.floor(n / TREND_MIN_FRAMES));
  const span = total / buckets;
  const counts = new Array<number>(buckets).fill(0);
  const sums = new Array<number>(buckets).fill(0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const b = Math.min(buckets - 1, Math.floor(t / span));
    counts[b]++;
    sums[b] += frametimes[i];
    t += frametimes[i];
  }
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) if (sums[b] > 0) out.push((counts[b] * 1000) / sums[b]);
  return out.length >= 2 ? out : null;
}

/** Quiet area line of the frame rate over the window (neutral grey: a trend, not a series). */
function FpsTrend({ frametimes }: { frametimes: readonly number[] }) {
  const paths = useMemo(() => {
    const pts = fpsTrend(frametimes);
    if (!pts) return null;
    // The scale spans at least a third of the average, so a steady frame rate draws a calm line
    // instead of its last few percent of jitter blown up to the full height.
    const mean = pts.reduce((a, v) => a + v, 0) / pts.length;
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const span = Math.max(max - min, mean / 3, 1) * 1.2;
    const mid = (min + max) / 2;
    const lo = mid - span / 2;
    const hi = mid + span / 2;
    const step = 1000 / (pts.length - 1);
    const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(100 - ((v - lo) / (hi - lo)) * 100).toFixed(1)}`).join("");
    return { line, area: `${line}L1000 100L0 100Z` };
  }, [frametimes]);

  return (
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" className="block h-14 w-full tight:h-11">
      {paths && (
        <>
          <path d={paths.area} fill="var(--color-series-neutral)" opacity={0.07} />
          <path
            d={paths.line}
            fill="none"
            stroke="var(--color-series-neutral)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
    </svg>
  );
}

/**
 * Hero of the Gaming page (CONTRACT §4.10.1, §4.10.3): the measured app, rendered FPS with the
 * P1 / P0.1 lows, the frame-rate trend over the window and the metric strip.
 */
export default function FpsHero({ target, stats, waitingText, frametimes, windowSec }: FpsHeroProps) {
  const s = stats;
  const fps = s?.fpsAvg ?? null;
  const ftAvg = s?.frametimeAvgMs ?? null;
  const ftMax = s?.frametimeMaxMs ?? null;
  const showDisplayed = s?.fpsDisplayedAvg != null;

  const process = target?.process ?? (target?.pid != null ? `PID ${target.pid}` : "No app");
  const meta = [target?.windowTitle, s?.runtime ?? target?.runtime, target?.pid != null ? `PID ${target.pid}` : null].filter(Boolean).join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]"
          >
            <Gamepad2 size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-title-2 text-ink">{process}</div>
            {meta && (
              <div className="tnum truncate text-callout text-ink-2" title={meta}>
                {meta}
              </div>
            )}
          </div>
        </div>
        <BoundByTag stats={s} />
      </div>

      <div className="mt-3.5 flex items-end gap-11 tight:mt-2 tight:gap-8">
        <div className="min-w-0">
          <div className="flex items-baseline whitespace-nowrap" title={s ? windowSummary(s) : waitingText}>
            <span className={cn("tnum text-hero tight:text-hero-tight", fps == null ? "text-ink-3" : "text-ink")}>{fmtFps(fps)}</span>
            <span className="ml-1.5 text-[22px] font-medium leading-none text-ink-2">fps</span>
          </div>
          <div className="mt-1.5 flex items-center gap-[5px] text-[12.5px] font-medium leading-[17px] text-ink-2">
            {s == null ? (
              <span className="truncate">{waitingText}</span>
            ) : fps == null ? (
              <span className="truncate">{NEEDS_2}</span>
            ) : (
              <>
                {HERO_LABEL}
                <InfoTip text={HERO_TOOLTIP} size={13} />
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-8 pb-[26px] tight:pb-[18px]">
          <Low label="P1" value={s?.fpsLow1 ?? null} nullTitle={s ? NEEDS_100 : waitingText} />
          <Low label="P0.1" value={s?.fpsLow01 ?? null} nullTitle={s ? NEEDS_1000 : waitingText} />
        </div>
      </div>

      <div className="mb-3.5 mt-1.5 flex min-h-[34px] flex-1 flex-col justify-end">
        <span className="tnum mb-1 text-caption text-ink-3 tight:hidden">fps · last {windowSec} s</span>
        <FpsTrend frametimes={frametimes} />
      </div>

      <div
        className="mt-auto grid border-t border-divider pt-3.5"
        style={{ gridTemplateColumns: `repeat(${showDisplayed ? 5 : 4}, minmax(0, 1fr))` }}
      >
        <Cell label="Avg frame time">
          <Val value={ftAvg == null ? null : ftAvg.toFixed(2)} unit="ms" nullTitle={s ? NEEDS_2 : waitingText} unitClassName={CELL_UNIT} />
        </Cell>
        <Cell label="Max frame time">
          <Val value={ftMax == null ? null : ftMax.toFixed(2)} unit="ms" nullTitle={s ? NO_FRAMES : waitingText} unitClassName={CELL_UNIT} />
        </Cell>
        {showDisplayed && (
          <Cell label="Displayed FPS" tip="Frames that reached the screen, per second.">
            <Val value={fmtFps(s?.fpsDisplayedAvg)} unit="fps" nullTitle={NO_DISPLAY_DATA} unitClassName={CELL_UNIT} />
          </Cell>
        )}
        <Cell label="Dropped" tip="Share of rendered frames in the window that never reached the screen.">
          <Val
            value={s?.droppedPct == null ? null : s.droppedPct.toFixed(1)}
            unit="%"
            nullTitle={s ? NO_DISPLAY_DATA : waitingText}
            unitClassName={CELL_UNIT}
          />
        </Cell>
        <Cell label="Present mode">
          <PresentModeValue target={target} stats={s} />
        </Cell>
      </div>
    </div>
  );
}
