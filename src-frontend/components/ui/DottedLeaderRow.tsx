import type { ReactNode } from "react";
import { cn } from "../../lib/format";

export interface DottedLeaderRowProps {
  label: ReactNode;
  value: ReactNode;
  valueClassName?: string;
  className?: string;
  /** Optional element after the label (e.g. an icon). */
  hint?: ReactNode;
}

/** BIOS-style `Label ........ Value` row. */
export function DottedLeaderRow({ label, value, valueClassName, className, hint }: DottedLeaderRowProps) {
  const title = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return (
    <div className={cn("flex min-w-0 items-center gap-2 py-[5px] text-[12.5px]", className)}>
      <span className="flex shrink-0 items-center gap-1.5 text-slate-400">
        {label}
        {hint}
      </span>
      <span aria-hidden="true" className="leader min-w-4 flex-1 translate-y-[3px] self-center" />
      <span title={title} className={cn("num min-w-0 max-w-[65%] truncate text-right text-ink", valueClassName)}>
        {value}
      </span>
    </div>
  );
}

export default DottedLeaderRow;
