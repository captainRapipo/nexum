import type { ReactNode } from "react";
import { Info } from "lucide-react";
import type { FrameStats } from "../../types";
import { fmtFps, fmtFrametime } from "../../lib/frames";
import { cn } from "../../lib/format";
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
  /** Fresh stats of the current target, or null while waiting. */
  stats: FrameStats | null;
  /** Shown while `stats` is null, e.g. `Waiting for frames from Game.exe…`. */
  waitingText: string;
}

function InfoTip({ text }: { text: string }) {
  return (
    <span
      role="img"
      tabIndex={0}
      aria-label={text}
      title={text}
      className="inline-flex cursor-help items-center text-slate-500 outline-none hover:text-slate-300 focus-visible:text-teal"
    >
      <Info size={12} aria-hidden="true" />
    </span>
  );
}

/** A value, or an em dash whose hover explains why it is missing. */
function Val({ text, nullTitle, className }: { text: string | null; nullTitle: string; className?: string }) {
  if (text == null) {
    return (
      <span className={cn("text-slate-500", className)} title={nullTitle} aria-label={`Not available: ${nullTitle}`}>
        —
      </span>
    );
  }
  return <span className={className}>{text}</span>;
}

function Cell({ label, children, tip }: { label: string; children: ReactNode; tip?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-black/20 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="label-caps truncate">{label}</span>
        {tip && <InfoTip text={tip} />}
      </div>
      <div className="num mt-1 truncate text-[17px] font-semibold leading-tight text-ink">{children}</div>
    </div>
  );
}

/** Hero readout: rendered FPS with P1 / P0.1 lows and the frame-time summary (CONTRACT §4.10.1). */
export default function FpsHero({ stats, waitingText }: FpsHeroProps) {
  const s = stats;
  const fps = s?.fpsAvg ?? null;
  const p1 = s?.fpsLow1 ?? null;
  const p01 = s?.fpsLow01 ?? null;
  const ftAvg = s?.frametimeAvgMs ?? null;
  const ftMax = s?.frametimeMaxMs ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="label-caps [--label-color:#94a3b8]">{HERO_LABEL}</span>
            <InfoTip text={HERO_TOOLTIP} />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={cn(
                "num text-[56px] font-semibold leading-none tracking-tight",
                fps == null ? "text-slate-500" : "text-ink text-glow-teal",
              )}
              title={s == null ? waitingText : fps == null ? NEEDS_2 : undefined}
            >
              {fmtFps(fps)}
            </span>
            <span className="text-[13px] font-medium text-muted">fps</span>
          </div>
          <div className="mt-1.5 text-[11.5px] text-muted">{s ? windowSummary(s) : waitingText}</div>
        </div>

        <div className="flex items-end gap-6">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="label-caps">P1</span>
              <InfoTip text={LOWS_TOOLTIP} />
            </div>
            <div className="num mt-1 text-[28px] font-semibold leading-none text-slate-100">
              <Val text={p1 == null ? null : fmtFps(p1)} nullTitle={s ? NEEDS_100 : waitingText} />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="label-caps">P0.1</span>
              <InfoTip text={LOWS_TOOLTIP} />
            </div>
            <div className="num mt-1 text-[28px] font-semibold leading-none text-slate-100">
              <Val text={p01 == null ? null : fmtFps(p01)} nullTitle={s ? NEEDS_1000 : waitingText} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2">
        <Cell label="Avg frame time">
          <Val text={ftAvg == null ? null : fmtFrametime(ftAvg)} nullTitle={s ? NEEDS_2 : waitingText} />
        </Cell>
        <Cell label="Max">
          <Val text={ftMax == null ? null : fmtFrametime(ftMax)} nullTitle={s ? NO_FRAMES : waitingText} />
        </Cell>
        {s?.fpsDisplayedAvg != null && (
          <Cell label="Displayed FPS" tip="Frames that reached the screen, per second.">
            {fmtFps(s.fpsDisplayedAvg)}
          </Cell>
        )}
        <Cell label="Dropped" tip="Share of rendered frames in the window that never reached the screen.">
          <Val
            text={s?.droppedPct == null ? null : `${s.droppedPct.toFixed(1)}%`}
            nullTitle={s ? NO_DISPLAY_DATA : waitingText}
          />
        </Cell>
        {s?.displayLatencyMs != null && (
          <Cell label="Display latency" tip="Average time from the game handing a frame to Windows (its Present call) to that frame reaching the screen.">
            {fmtFrametime(s.displayLatencyMs)}
          </Cell>
        )}
      </div>
    </div>
  );
}
