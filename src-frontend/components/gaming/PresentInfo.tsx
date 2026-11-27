import { MonitorPlay } from "lucide-react";
import type { FrameStats, FrameTarget } from "../../types";
import { presentModeBadge } from "../../lib/frames";
import { DottedLeaderRow, StatusPill } from "../ui";

/** Neutral fact chip (not a status claim). */
function Chip({ children, title }: { children: string; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-line bg-white/[0.03] px-2.5 text-[11px] font-medium text-slate-300"
    >
      {children}
    </span>
  );
}

export interface PresentInfoProps {
  target: FrameTarget | null;
  stats: FrameStats | null;
}

/** Present mode badge with runtime, V-Sync and tearing (CONTRACT §4.10.1). Stats win over the target line. */
export default function PresentInfo({ target, stats }: PresentInfoProps) {
  const mode = stats?.presentMode ?? target?.presentMode ?? null;
  const runtime = stats?.runtime ?? target?.runtime ?? null;
  const badge = presentModeBadge(mode);
  const sync = stats?.syncInterval ?? null;
  const tearing = stats?.allowsTearing ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={badge.tone} icon={MonitorPlay} title={badge.title}>
          {badge.label}
        </StatusPill>
        {sync != null && (
          <Chip title={`Sync interval ${sync}. V-Sync is on when the game presents with a sync interval above 0.`}>
            {`V-Sync: ${sync > 0 ? "on" : "off"}`}
          </Chip>
        )}
        {tearing === true && (
          <Chip title="The game's swap chain allows tearing (variable refresh or V-Sync off).">Tearing allowed</Chip>
        )}
      </div>
      <div className="flex flex-col">
        <DottedLeaderRow label="Present mode" value={mode ?? "—"} />
        <DottedLeaderRow label="Runtime" value={runtime ?? "—"} />
      </div>
    </div>
  );
}
