import { ProgressBar } from "../ui";

export type LedTone = "gold" | "teal" | "rose" | "cyan" | "purple";

export interface LedProgressProps {
  /** 0-100. Omit / null while the amount is unknown (a quiet sweep). */
  value?: number | null;
  /** Accessible name. */
  label?: string;
  className?: string;
  /** Ignored since 1.2 (the bar is continuous and graphite). Kept so call sites compile. */
  segments?: number;
  /** Ignored since 1.2. */
  tone?: LedTone;
  /** Ignored since 1.2 (the bar is 4 px). */
  height?: number;
}

/**
 * Cleanup / measuring progress. The LED look is retired (CONTRACT §4.10.3): this is the shared
 * 4 px graphite `ProgressBar` under its 1.1 name.
 */
export default function LedProgress({ value, label, className }: LedProgressProps) {
  const unknown = value === undefined || value === null || !Number.isFinite(value);
  return <ProgressBar value={unknown ? null : (value as number)} indeterminate={unknown} label={label} className={className} />;
}
