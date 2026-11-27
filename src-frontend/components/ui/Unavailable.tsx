import { Lock } from "lucide-react";
import type { UnavailableReason } from "../../types";
import { cn } from "../../lib/format";

/** Exact cause texts (CONTRACT §4.7). */
export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  notElevated: "Needs administrator",
  pawnIoMissing: "Needs PawnIO driver",
  pawnIoOutdated: "PawnIO update needed",
  unsupported: "Not reported by this hardware",
  agentOffline: "Hardware agent offline",
};

export interface UnavailableProps {
  reason: UnavailableReason;
  /** Only the em dash and the lock; the cause becomes the tooltip / accessible name. */
  compact?: boolean;
  className?: string;
}

/**
 * "Unavailable is not zero" (MF-2): use in place of any null value.
 * Em dash + lock icon + one-line cause.
 */
export function Unavailable({ reason, compact = false, className }: UnavailableProps) {
  const text = UNAVAILABLE_TEXT[reason] ?? UNAVAILABLE_TEXT.unsupported;
  if (compact) {
    return (
      <span
        role="img"
        aria-label={`Unavailable: ${text}`}
        title={text}
        className={cn("inline-flex items-center gap-1 whitespace-nowrap text-slate-500", className)}
      >
        <span aria-hidden="true">—</span>
        <Lock size={11} strokeWidth={2} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-slate-500", className)} title={text}>
      <span aria-hidden="true">—</span>
      <Lock size={11} strokeWidth={2} aria-hidden="true" className="shrink-0" />
      <span className="truncate text-[11px] font-normal normal-case tracking-normal">{text}</span>
    </span>
  );
}

export default Unavailable;
