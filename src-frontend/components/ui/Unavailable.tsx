import { Lock } from "lucide-react";
import { NOT_AVAILABLE_TEXT, type UnavailableReason } from "../../types";
import { cn } from "../../lib/format";

// CONTRACT §4.7, §4.8.1 / docs/design/SPEC.md §22.

/** Exact cause texts (CONTRACT §4.7). */
export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  notElevated: "Needs administrator",
  pawnIoMissing: "Needs PawnIO driver",
  pawnIoOutdated: "PawnIO update needed",
  unsupported: "Not reported by this hardware",
  agentOffline: NOT_AVAILABLE_TEXT,
};

export interface UnavailableProps {
  reason: UnavailableReason;
  /** Only the em dash and the lock; the cause becomes the tooltip / accessible name. */
  compact?: boolean;
  className?: string;
}

/**
 * "Unavailable is not zero" (MF-2): use in place of any null value.
 * Em dash + 12 px lock + one-line cause, all in tertiary text. In a large value slot (KPI, hero)
 * draw the "—" yourself at display size and put the full <Unavailable> in the meta line.
 */
export function Unavailable({ reason, compact = false, className }: UnavailableProps) {
  const text = UNAVAILABLE_TEXT[reason] ?? UNAVAILABLE_TEXT.unsupported;
  // Nothing is locked here: the value is just missing at the moment, so both variants show only the dash.
  if (reason === "agentOffline") {
    return (
      <span role="img" aria-label={text} title={text} className={cn("inline-flex items-center whitespace-nowrap text-ink-3", className)}>
        <span aria-hidden="true">—</span>
      </span>
    );
  }
  if (compact) {
    return (
      <span
        role="img"
        aria-label={`Unavailable: ${text}`}
        title={text}
        className={cn("inline-flex items-center gap-[5px] whitespace-nowrap text-ink-3", className)}
      >
        <span aria-hidden="true">—</span>
        <Lock size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      </span>
    );
  }
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap text-ink-3", className)} title={text}>
      <span aria-hidden="true">—</span>
      <Lock size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <span className="truncate text-callout font-normal">{text}</span>
    </span>
  );
}

export default Unavailable;
