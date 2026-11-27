import { clamp, cn } from "../../lib/format";
import { TONE_CLASS, toneForLevel, type Tone } from "./tones";

export interface SegmentedBarProps {
  /** 0–100 */
  value: number;
  segments?: number;
  /** Fixed tone, or "auto" (teal → gold ≥75 → rose ≥90 by value). Default "auto". */
  tone?: Tone | "auto";
  /** Colour each lit segment by its own position (classic LED meter). */
  zoned?: boolean;
  /** Bar height in px. Default 10. */
  height?: number;
  className?: string;
  label?: string;
}

/** Segmented LED progress bar. */
export function SegmentedBar({
  value,
  segments = 24,
  tone = "auto",
  zoned = false,
  height = 10,
  className,
  label,
}: SegmentedBarProps) {
  const v = clamp(value, 0, 100);
  const count = Math.max(1, Math.round(segments));
  const lit = Math.round((v / 100) * count);
  const baseTone: Tone = tone === "auto" ? toneForLevel(v) : tone;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
      className={cn("flex w-full gap-[3px]", className)}
      style={{ height }}
    >
      {Array.from({ length: count }, (_, i) => {
        const on = i < lit;
        const segTone: Tone = zoned ? toneForLevel(((i + 1) / count) * 100) : baseTone;
        return (
          <span
            key={i}
            className={cn(
              "min-w-0 flex-1 rounded-[2px] transition-[background-color,box-shadow,opacity] duration-300",
              on ? TONE_CLASS[segTone].led : "bg-white/[0.06]",
              on && i === lit - 1 && "brightness-125",
            )}
          />
        );
      })}
    </div>
  );
}

export default SegmentedBar;
