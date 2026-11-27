import type { ReactNode } from "react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";

export type StatusTone = "ok" | "warn" | "crit" | "info";

const TONES: Record<StatusTone, { wrap: string; led: string }> = {
  ok: { wrap: "border-teal/35 bg-teal/[0.08] text-teal shadow-[0_0_14px_-4px_rgba(45,212,191,0.45)]", led: "led-teal" },
  warn: { wrap: "border-gold/40 bg-gold/[0.08] text-gold shadow-[0_0_14px_-4px_rgba(212,163,89,0.45)]", led: "led-gold" },
  crit: { wrap: "border-rose/50 bg-rose/[0.1] text-rose-400 shadow-[0_0_16px_-3px_rgba(225,29,72,0.6)]", led: "led-rose" },
  info: { wrap: "border-cyan/35 bg-cyan/[0.07] text-cyan shadow-[0_0_14px_-4px_rgba(34,211,238,0.4)]", led: "led-cyan" },
};

export interface StatusPillProps {
  tone: StatusTone;
  children: ReactNode;
  /** Pulse the LED (use for live / attention states). */
  pulse?: boolean;
  /** Optional icon replacing the LED dot. */
  icon?: IconLike;
  title?: string;
  className?: string;
}

export function StatusPill({ tone, children, pulse = false, icon, title, className }: StatusPillProps) {
  const t = TONES[tone];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5",
        "text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em]",
        t.wrap,
        className,
      )}
    >
      {icon ? (
        renderIcon(icon, 12)
      ) : (
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", t.led, pulse && "animate-led-pulse")} />
      )}
      {children}
    </span>
  );
}

export default StatusPill;
