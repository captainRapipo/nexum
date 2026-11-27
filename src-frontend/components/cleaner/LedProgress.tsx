import { cn } from "../../lib/format";

const KEYFRAMES = `
@keyframes nx-led-sweep { 0% { opacity: .18 } 40% { opacity: 1 } 100% { opacity: .18 } }
@keyframes nx-led-glow { 0%,100% { filter: brightness(1) } 50% { filter: brightness(1.35) } }
@media (prefers-reduced-motion: reduce) { .nx-led-anim { animation: none !important; } }
`;

export type LedTone = "gold" | "teal" | "rose" | "cyan" | "purple";

const TONE_BG: Record<LedTone, string> = {
  gold: "bg-gold shadow-[0_0_8px_rgba(212,163,89,0.75)]",
  teal: "bg-teal shadow-[0_0_8px_rgba(45,212,191,0.7)]",
  rose: "bg-rose shadow-[0_0_8px_rgba(225,29,72,0.7)]",
  cyan: "bg-cyan shadow-[0_0_8px_rgba(34,211,238,0.7)]",
  purple: "bg-purple shadow-[0_0_8px_rgba(147,51,234,0.7)]",
};

export interface LedProgressProps {
  /** 0-100. Omit / null for an indeterminate sweeping animation. */
  value?: number | null;
  segments?: number;
  tone?: LedTone;
  className?: string;
  /** Height of each LED in px. */
  height?: number;
}

/**
 * Animated LED-segment progress bar (BIOS style). Determinate mode lights segments up to `value`
 * with the leading segment pulsing; indeterminate mode runs a travelling sweep.
 */
export default function LedProgress({ value, segments = 40, tone = "gold", className, height = 10 }: LedProgressProps) {
  const indeterminate = value === undefined || value === null || !Number.isFinite(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value as number));
  const lit = Math.round((pct / 100) * segments);

  return (
    <div
      className={cn("flex w-full gap-[3px]", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      <style>{KEYFRAMES}</style>
      {Array.from({ length: segments }).map((_, i) => {
        if (indeterminate) {
          return (
            <span
              key={i}
              className={cn("nx-led-anim flex-1 rounded-[2px]", TONE_BG[tone])}
              style={{
                height,
                animation: `nx-led-sweep 1.4s ease-in-out ${(i / segments) * 1.4}s infinite`,
                opacity: 0.18,
              }}
            />
          );
        }
        const on = i < lit;
        const head = on && i === lit - 1 && pct < 100;
        return (
          <span
            key={i}
            className={cn(
              "flex-1 rounded-[2px] transition-colors duration-300",
              on ? TONE_BG[tone] : "bg-white/[0.06]",
              head && "nx-led-anim",
            )}
            style={{
              height,
              animation: head ? "nx-led-glow 0.9s ease-in-out infinite" : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
