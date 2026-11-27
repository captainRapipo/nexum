import type { ReactNode } from "react";
import { cn } from "../../lib/format";
import GlassCard from "../layout/GlassCard";
import { DottedLeaderRow } from "../ui/DottedLeaderRow";
import { Unavailable } from "../ui/Unavailable";
import type { IconLike } from "../ui/icon";
import type { SpecRow, SpecValue } from "./specModel";

/** Renders one spec value: text, <Unavailable>, or a muted em dash with a short reason. */
export function SpecValueView({ value }: { value: SpecValue }) {
  if (value.kind === "unavailable") return <Unavailable reason={value.reason} />;
  if (value.kind === "muted") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-sans text-slate-500" title={value.hint}>
        <span aria-hidden="true">—</span>
        <span className="text-[11px] tracking-normal">{value.text}</span>
      </span>
    );
  }
  return <>{value.text}</>;
}

export function SpecRows({ rows }: { rows: readonly SpecRow[] }) {
  return (
    <div className="flex flex-col">
      {rows.map((r) => (
        <DottedLeaderRow
          key={r.label}
          label={r.label}
          // Plain strings keep DottedLeaderRow's full-text tooltip for truncated values.
          value={r.value.kind === "text" ? r.value.text : <SpecValueView value={r.value} />}
          valueClassName={cn(
            r.value.kind === "text" && !r.value.mono && "font-sans tracking-normal",
            r.value.kind !== "text" && "font-sans",
          )}
        />
      ))}
    </div>
  );
}

export interface SpecCardProps {
  title: ReactNode;
  icon?: IconLike;
  rows?: readonly SpecRow[];
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** A titled spec-sheet card of dotted-leader rows. */
export function SpecCard({ title, icon, rows, actions, className, children }: SpecCardProps) {
  return (
    <GlassCard title={title} icon={icon} actions={actions} className={className}>
      {rows && <SpecRows rows={rows} />}
      {children}
    </GlassCard>
  );
}

export default SpecCard;
