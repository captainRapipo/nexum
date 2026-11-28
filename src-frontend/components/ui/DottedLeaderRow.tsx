import type { ReactNode } from "react";
import { cn } from "../../lib/format";

// CONTRACT §4.7: the 1.1 dotted leader is now a plain key-value row (also exported as KeyValueRow).

export interface DottedLeaderRowProps {
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
  className?: string;
  /** Optional element after the label (e.g. an icon). */
  hint?: ReactNode;
}

/**
 * 28 px key-value row: label in secondary text on the left, value right-aligned in ink with tabular
 * figures, a hairline under every row except the last of its container.
 */
export function DottedLeaderRow({ label, value, valueClassName, className, hint }: DottedLeaderRowProps) {
  const title = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return (
    <div className={cn("flex min-h-7 min-w-0 items-center justify-between gap-3 border-b border-divider text-body last:border-b-0", className)}>
      <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-ink-2">
        {label}
        {hint}
      </span>
      <span title={title} className={cn("tnum min-w-0 truncate text-right font-medium text-ink", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

export default DottedLeaderRow;
