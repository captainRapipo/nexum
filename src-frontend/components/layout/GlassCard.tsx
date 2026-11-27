import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "../ui/icon";
import type { Tone } from "../ui/tones";

export type GlassAccent = Tone;

export interface GlassCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  /** Shown next to the title: element or lucide component. */
  icon?: IconLike;
  /** Right side of the header (buttons, pills…). */
  actions?: ReactNode;
  /** Vertical glowing accent line on the left edge. */
  accent?: GlassAccent;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

const ACCENT_BAR: Record<GlassAccent, string> = {
  teal: "bg-teal shadow-[0_0_10px_1px_rgba(45,212,191,0.6)]",
  gold: "bg-gold shadow-[0_0_10px_1px_rgba(212,163,89,0.6)]",
  purple: "bg-purple-500 shadow-[0_0_10px_1px_rgba(168,85,247,0.65)]",
  rose: "bg-rose shadow-[0_0_10px_1px_rgba(225,29,72,0.65)]",
  cyan: "bg-cyan shadow-[0_0_10px_1px_rgba(34,211,238,0.6)]",
  silver: "bg-silver shadow-[0_0_10px_1px_rgba(203,213,225,0.45)]",
};

const ACCENT_ICON: Record<GlassAccent, string> = {
  teal: "text-teal",
  gold: "text-gold",
  purple: "text-purple-400",
  rose: "text-rose-400",
  cyan: "text-cyan",
  silver: "text-silver",
};

/** Translucent HUD card. Header renders only when title / icon / actions are given. */
export function GlassCard({
  title,
  icon,
  actions,
  accent,
  className,
  bodyClassName,
  children,
  ...rest
}: GlassCardProps) {
  const hasHeader = title != null || icon != null || actions != null;
  return (
    <section className={cn("glass relative flex min-w-0 flex-col overflow-hidden", className)} {...rest}>
      {/* top sheen */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
      />
      {accent && (
        <span aria-hidden="true" className={cn("pointer-events-none absolute bottom-3 left-0 top-3 w-[2px] rounded-full", ACCENT_BAR[accent])} />
      )}
      {hasHeader && (
        <header className="flex min-h-10 shrink-0 items-center gap-2 px-4 pb-1.5 pt-3">
          {icon != null && (
            <span className={cn("flex shrink-0 items-center", accent ? ACCENT_ICON[accent] : "text-slate-400")}>
              {renderIcon(icon, 14)}
            </span>
          )}
          {title != null && <h3 className="label-caps min-w-0 truncate [--label-color:#94a3b8]">{title}</h3>}
          {actions != null && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn("min-h-0 flex-1 px-4 pb-4", !hasHeader && "pt-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export default GlassCard;
