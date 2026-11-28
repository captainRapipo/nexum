import type { ReactNode } from "react";
import { cn } from "../../lib/format";
import GlassCard from "../layout/GlassCard";
import { KeyValueRow, Unavailable } from "../ui";
import type { IconLike } from "../ui";
import { renderIcon } from "../ui";
import type { SpecRow, SpecValue } from "./specModel";

/** Renders one spec value: text, <Unavailable>, or an em dash with a short reason. */
export function SpecValueView({ value }: { value: SpecValue }) {
  if (value.kind === "unavailable") return <Unavailable reason={value.reason} />;
  if (value.kind === "muted") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-normal text-ink-3" title={value.hint}>
        <span aria-hidden="true">—</span>
        <span className="text-callout">{value.text}</span>
      </span>
    );
  }
  return <>{value.text}</>;
}

/** Key-value rows (28 px, hairlines). Identifiers are set in the monospace face, everything else in Inter. */
export function SpecRows({ rows, className }: { rows: readonly SpecRow[]; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      {rows.map((r) => (
        <KeyValueRow
          key={r.label}
          label={r.label}
          // Plain strings keep the row's full-text tooltip for truncated values.
          value={r.value.kind === "text" ? r.value.text : <SpecValueView value={r.value} />}
          valueClassName={cn(r.value.kind === "text" && r.value.ident && "font-mono text-[12px] font-normal", r.value.kind !== "text" && "font-normal")}
        />
      ))}
    </div>
  );
}

export interface SpecCardProps {
  title: ReactNode;
  rows?: readonly SpecRow[];
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/** A titled spec-sheet card of key-value rows. */
export function SpecCard({ title, rows, actions, className, bodyClassName, children }: SpecCardProps) {
  return (
    <GlassCard title={title} actions={actions} className={className} bodyClassName={bodyClassName}>
      {rows && <SpecRows rows={rows} />}
      {children}
    </GlassCard>
  );
}

export interface HeroStat {
  label: string;
  /** null = not reported: the slot shows an em dash in tertiary text. */
  value: string | null;
  unit?: string;
  title?: string;
}

/**
 * The hero card of a tab (mock system-cpu): an icon tile, the name, one line of context and up to
 * five large figures divided by hairlines.
 */
export function SpecHero({ icon, title, sub, stats = [], children }: { icon: IconLike; title: string; sub?: string | null; stats?: readonly HeroStat[]; children?: ReactNode }) {
  return (
    <GlassCard padded={false}>
      <div className="flex min-w-0 items-center gap-[18px] px-[22px] py-[18px]">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]">
          {renderIcon(icon, 28)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[20px] font-semibold leading-[26px] tracking-[-0.015em] text-ink" title={title}>
            {title}
          </h2>
          {sub && (
            <p className="mt-0.5 truncate text-body text-ink-2" title={sub}>
              {sub}
            </p>
          )}
          {children}
        </div>
        {stats.length > 0 && (
          <dl className="flex shrink-0">
            {stats.map((s) => (
              <div key={s.label} className="min-w-[104px] border-l border-divider px-[22px] last:pr-0 tight:min-w-0 tight:px-3.5" title={s.title}>
                <dt className="whitespace-nowrap text-caption font-medium text-ink-2">{s.label}</dt>
                <dd className={cn("tnum mt-1 whitespace-nowrap text-large-num font-semibold tight:text-[22px]", s.value == null ? "text-ink-3" : "text-ink")}>
                  {s.value ?? "—"}
                  {s.value != null && s.unit && <small className="ml-[3px] text-[13px] font-medium tracking-normal text-ink-2">{s.unit}</small>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </GlassCard>
  );
}

export default SpecCard;
