import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Lock, OctagonAlert, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";
import type { StatusTone } from "./tones";

export type { StatusTone } from "./tones";

// Colours come from the semantic status tokens only (CONTRACT §4.9); info uses cyan.
const TONES: Record<StatusTone, string> = {
  ok: "border-ok/35 bg-ok/[0.08] text-ok shadow-[0_0_14px_-4px_rgba(45,212,191,0.45)]",
  warn: "border-warn/45 bg-warn/[0.09] text-warn shadow-[0_0_14px_-4px_rgba(245,158,11,0.45)]",
  crit: "border-crit/55 bg-crit/[0.1] text-rose-400 shadow-[0_0_16px_-3px_rgba(225,29,72,0.6)]",
  info: "border-cyan/35 bg-cyan/[0.07] text-cyan shadow-[0_0_14px_-4px_rgba(34,211,238,0.4)]",
  unknown: "border-unknown/50 bg-unknown/[0.12] text-slate-300",
};

/** Default icon per tone: state is never conveyed by colour alone. */
export const STATUS_ICON: Record<StatusTone, LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  crit: OctagonAlert,
  info: Info,
  unknown: Lock,
};

export interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
  /** Pulse the icon (live / attention states). */
  pulse?: boolean;
  /** Replaces the default per-tone icon. */
  icon?: IconLike;
  /** Hover text: every status claim shows the rule that produced it (CONTRACT §4.8). */
  title?: string;
  className?: string;
}

export function StatusPill({ tone, children, pulse = false, icon, title, className }: StatusPillProps) {
  const t = TONES[tone] ?? TONES.unknown;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5",
        "text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em]",
        t,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("flex shrink-0 items-center", pulse && "animate-led-pulse")}>
        {renderIcon(icon ?? STATUS_ICON[tone] ?? Lock, 12)}
      </span>
      {children}
    </span>
  );
}

export default StatusPill;
