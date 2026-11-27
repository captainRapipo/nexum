import { Gauge } from "lucide-react";
import type { FrameStats } from "../../types";
import { boundByLabel, fmtFrametime } from "../../lib/frames";
import { SERIES_HEX, StatusPill } from "../ui";
import { BOUND_BY_RULE, HAGS_NOTE } from "./gamingText";

/** Why the badge shows "—" (CONTRACT §1.6.5: boundBy is null without both busy times or below 30 frames). */
const BOUND_NULL_REASON = "Not enough data: needs CPU and GPU busy times and at least 30 frames in the window.";

export interface BusyBarsProps {
  stats: FrameStats | null;
}

interface BarProps {
  label: string;
  ms: number | null;
  scale: number;
  color: string;
  missingTitle: string;
  /** Average frame time as % of the track, drawn as a tick. */
  framePct: number | null;
}

function Bar({ label, ms, scale, color, missingTitle, framePct }: BarProps) {
  const pct = ms == null || scale <= 0 ? 0 : Math.min(100, (ms / scale) * 100);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="flex items-center gap-1.5 text-slate-300">
          <span aria-hidden="true" className="inline-block size-2 rounded-[2px]" style={{ background: color }} />
          {label}
        </span>
        {ms == null ? (
          <span className="num text-slate-500" title={missingTitle}>
            —
          </span>
        ) : (
          <span className="num text-ink">{fmtFrametime(ms)}</span>
        )}
      </div>
      <div
        className="relative mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/[0.05]"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(scale * 100) / 100}
        aria-valuenow={ms ?? undefined}
      >
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, background: color }} />
        {framePct != null && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 w-[2px] bg-slate-200/80"
            style={{ left: `calc(${Math.min(100, framePct)}% - 2px)` }}
          />
        )}
      </div>
    </div>
  );
}

/** CPU busy vs GPU busy against the average frame time, plus the boundBy badge (CONTRACT §1.6.5, §4.10.1). */
export default function BusyBars({ stats }: BusyBarsProps) {
  const t = stats?.frametimeAvgMs ?? null;
  const c = stats?.cpuBusyMs ?? null;
  const g = stats?.gpuBusyMs ?? null;
  const scale = Math.max(t ?? 0, c ?? 0, g ?? 0);
  const framePct = t != null && scale > 0 ? (t / scale) * 100 : null;
  const bound = stats?.boundBy ?? null;
  const missing = stats ? "PresentMon did not report this value for this app." : "Waiting for frames.";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-muted">
          Average frame time <span className="num text-slate-200">{t == null ? "—" : fmtFrametime(t)}</span>
        </span>
        <StatusPill
          tone={bound == null ? "unknown" : "info"}
          icon={Gauge}
          title={`${bound == null ? `${BOUND_NULL_REASON}\n\n` : ""}${BOUND_BY_RULE}\n\n${HAGS_NOTE}`}
        >
          {boundByLabel(bound)}
        </StatusPill>
      </div>
      <div className="flex flex-col gap-3">
        <Bar label="CPU busy" ms={c} scale={scale} color={SERIES_HEX.cpu} missingTitle={missing} framePct={framePct} />
        <Bar label="GPU busy" ms={g} scale={scale} color={SERIES_HEX.gpu} missingTitle={missing} framePct={framePct} />
      </div>
      <p className="text-[11px] leading-snug text-slate-500">
        The white tick marks the average frame time. The busier side limits the frame rate. {HAGS_NOTE}
      </p>
    </div>
  );
}
