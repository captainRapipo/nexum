import type { FrameStats } from "../../types";
import { boundByLabel, fmtFrametime } from "../../lib/frames";
import { Tag } from "../ui";
import { BOUND_BY_RULE, HAGS_NOTE } from "./gamingText";

/** Why the tag shows "—" (CONTRACT §1.6.5: boundBy is null without both busy times or below 30 frames). */
const BOUND_NULL_REASON = "Not enough data: needs CPU and GPU busy times and at least 30 frames in the window.";

export interface BusyBarsProps {
  stats: FrameStats | null;
}

/**
 * Which side limits the frame rate, as a neutral tag (it is a fact about the frame, not a health
 * state). The hover shows the rule that produced it and the HAGS note (CONTRACT §4.8, §4.10.1).
 */
export function BoundByTag({ stats, className }: BusyBarsProps & { className?: string }) {
  const bound = stats?.boundBy ?? null;
  return (
    <Tag className={className} title={`${bound == null ? `${BOUND_NULL_REASON}\n\n` : ""}${BOUND_BY_RULE}\n\n${HAGS_NOTE}`}>
      {boundByLabel(bound)}
    </Tag>
  );
}

/** `of 7.14 ms per frame`: what the two bars are measured against. */
export function busyScaleText(stats: FrameStats | null): string | null {
  const t = stats?.frametimeAvgMs ?? null;
  return t == null ? null : `of ${fmtFrametime(t)} per frame`;
}

interface BarProps {
  label: string;
  ms: number | null;
  /** Average frame time (ms): the full width of the track. */
  frameMs: number | null;
  missingTitle: string;
}

function Bar({ label, ms, frameMs, missingTitle }: BarProps) {
  const pct = ms == null || frameMs == null || frameMs <= 0 ? 0 : Math.min(100, (ms / frameMs) * 100);
  return (
    <div className="mt-2.5 min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-callout">
        <span className="text-ink-2">{label}</span>
        {ms == null ? (
          <span className="text-ink-3" title={missingTitle} aria-label={`Not available: ${missingTitle}`}>
            —
          </span>
        ) : (
          <span className="tnum font-semibold text-ink">{fmtFrametime(ms)}</span>
        )}
      </div>
      <div
        className="mb-0.5 mt-1.5 h-2 w-full overflow-hidden rounded-xs bg-meter-track"
        role="meter"
        aria-label={`${label}, share of the average frame time`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ms == null ? undefined : Math.round(pct)}
        aria-valuetext={ms == null ? undefined : fmtFrametime(ms)}
      >
        <div className="h-full rounded-xs bg-series-single" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * CPU busy vs GPU busy as shares of the average frame time (CONTRACT §1.6.5, §4.10.1). The busier
 * side limits the frame rate; the bound-by tag sits in the hero (`BoundByTag`).
 */
export default function BusyBars({ stats }: BusyBarsProps) {
  const t = stats?.frametimeAvgMs ?? null;
  const missing = stats ? "PresentMon did not report this value for this app." : "Waiting for frames.";
  return (
    <div className="flex flex-col" title={`The busier side limits the frame rate. ${HAGS_NOTE}`}>
      <Bar label="CPU busy" ms={stats?.cpuBusyMs ?? null} frameMs={t} missingTitle={missing} />
      <Bar label="GPU busy" ms={stats?.gpuBusyMs ?? null} frameMs={t} missingTitle={missing} />
    </div>
  );
}
