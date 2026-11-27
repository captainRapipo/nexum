import type { ReactNode } from "react";
import { cn } from "../../lib/format";
import { STATUS_CLASS, type StatusTone } from "../ui";

export type StatAccent = "teal" | "gold" | "purple" | "rose" | "cyan" | "silver";

const ACCENT: Record<StatAccent, { line: string; text: string }> = {
  teal: { line: "bg-teal shadow-[0_0_10px_rgba(45,212,191,0.6)]", text: "text-teal" },
  gold: { line: "bg-gold shadow-[0_0_10px_rgba(212,163,89,0.6)]", text: "text-gold" },
  purple: { line: "bg-purple shadow-[0_0_10px_rgba(147,51,234,0.6)]", text: "text-purple" },
  rose: { line: "bg-rose shadow-[0_0_10px_rgba(225,29,72,0.6)]", text: "text-rose" },
  cyan: { line: "bg-cyan shadow-[0_0_10px_rgba(34,211,238,0.6)]", text: "text-cyan" },
  silver: { line: "bg-silver shadow-[0_0_10px_rgba(203,213,225,0.45)]", text: "text-silver" },
};

export interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  accent?: StatAccent;
  icon?: ReactNode;
  className?: string;
  /** Colour the big number with the accent (decoration only). */
  tintValue?: boolean;
  /** State colour for the big number (status tokens). Use with `title` so the rule is visible on hover. */
  valueTone?: StatusTone;
  /** Hover text, e.g. the rule behind a status number. */
  title?: string;
}

/** Compact KPI tile with a vertical glowing accent line (matches the dashboard telemetry strip). */
export default function StatTile({
  label,
  value,
  unit,
  sub,
  accent = "teal",
  icon,
  className,
  tintValue,
  valueTone,
  title,
}: StatTileProps) {
  const a = ACCENT[accent];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-line bg-card px-4 py-3 backdrop-blur-xl",
        className,
      )}
      title={title}
    >
      <span className={cn("absolute left-0 top-3 bottom-3 w-[3px] rounded-r", a.line)} />
      <div className="flex items-center justify-between gap-2 pl-1.5">
        <span className="truncate text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted">{label}</span>
        {icon && <span className={cn("shrink-0 opacity-80", a.text)}>{icon}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 pl-1.5">
        <span
          className={cn(
            "font-mono text-[26px] font-semibold leading-none max-[1439px]:text-[22px]",
            valueTone ? STATUS_CLASS[valueTone].text : tintValue ? a.text : "text-ink",
          )}
        >
          {value}
        </span>
        {unit && <span className="font-mono text-[12px] text-muted">{unit}</span>}
      </div>
      {sub !== undefined && sub !== null && sub !== "" && (
        <div className="mt-1.5 truncate pl-1.5 text-[11.5px] text-muted">{sub}</div>
      )}
    </div>
  );
}
