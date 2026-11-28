import type { FrameStats, FrameTarget } from "../../types";
import { fmtFrametime, presentModeBadge } from "../../lib/frames";
import { cn } from "../../lib/format";
import { StatusIcon } from "../ui";

export interface PresentInfoProps {
  target: FrameTarget | null;
  stats: FrameStats | null;
  className?: string;
}

const DISPLAY_LATENCY_TIP =
  "Average time from the game handing a frame to Windows (its Present call) to that frame reaching the screen.";

/**
 * Present mode as the value of a metric cell: the `presentModeBadge` label, with the status icon
 * when the mode costs something (a composed window adds latency). Stats win over the target line.
 */
export function PresentModeValue({ target, stats }: PresentInfoProps) {
  const mode = stats?.presentMode ?? target?.presentMode ?? null;
  if (mode == null) {
    return (
      <span className="text-ink-3" title="PresentMon did not report a present mode." aria-label="Not available: no present mode reported">
        —
      </span>
    );
  }
  const badge = presentModeBadge(mode);
  return (
    <span className="flex min-w-0 items-center gap-1 text-[13px]" title={`${badge.title}\n\nPresent mode: ${mode}`}>
      {badge.tone === "warn" && <StatusIcon tone="warn" size={13} />}
      <span className="truncate">{badge.label}</span>
    </span>
  );
}

/**
 * How the game presents (CONTRACT §4.10.1): display latency, V-Sync, tearing and the runtime, as one
 * quiet meta line (the header of the frame-time card). Renders nothing while nothing is known.
 */
export default function PresentInfo({ target, stats, className }: PresentInfoProps) {
  const runtime = stats?.runtime ?? target?.runtime ?? null;
  const sync = stats?.syncInterval ?? null;
  const tearing = stats?.allowsTearing ?? null;
  const latency = stats?.displayLatencyMs ?? null;

  const parts: { key: string; text: string; title: string }[] = [];
  if (latency != null) parts.push({ key: "latency", text: `Display latency ${fmtFrametime(latency)}`, title: DISPLAY_LATENCY_TIP });
  if (sync != null) {
    parts.push({
      key: "sync",
      text: `V-Sync ${sync > 0 ? "on" : "off"}`,
      title: `Sync interval ${sync}. V-Sync is on when the game presents with a sync interval above 0.`,
    });
  }
  if (tearing === true) {
    parts.push({ key: "tearing", text: "tearing allowed", title: "The game's swap chain allows tearing (variable refresh or V-Sync off)." });
  }
  if (runtime) parts.push({ key: "runtime", text: runtime, title: `Runtime reported by PresentMon: ${runtime}.` });
  if (parts.length === 0) return null;

  return (
    <span className={cn("tnum min-w-0 truncate text-callout text-ink-2", className)}>
      {parts.map((p, i) => (
        <span key={p.key} title={p.title}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          {p.text}
        </span>
      ))}
    </span>
  );
}
