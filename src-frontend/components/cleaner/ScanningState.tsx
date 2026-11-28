import { useEffect, useState } from "react";
import LedProgress from "./LedProgress";

const STAGES = [
  "Temporary files",
  "Windows Update cache",
  "Error reports and old logs",
  "Old crash dumps",
  "Shader caches",
  "Recycle Bin",
  "Browser and Discord caches",
];

export interface ScanningStateProps {
  title?: string;
  /** Left-aligned and without the title, for a dialog that already names the state. */
  compact?: boolean;
}

/** Dry-run measurement in progress: what is being looked at and a quiet progress bar. */
export default function ScanningState({ title = "Measuring reclaimable caches…", compact = false }: ScanningStateProps) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setStage((s) => (s + 1) % STAGES.length), 650);
    return () => window.clearInterval(t);
  }, []);

  if (compact) {
    return (
      <div className="flex flex-col gap-2 py-1" role="status">
        <div className="text-callout text-ink-2">Looking at {STAGES[stage]}…</div>
        <LedProgress label={title} />
        <div className="text-callout text-ink-3">Measuring only. Nothing is deleted until you choose Clean.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center" role="status">
      <div className="text-title-2 text-ink">{title}</div>
      <div className="h-[17px] text-callout text-ink-2">Looking at {STAGES[stage]}…</div>
      <div className="w-full max-w-[320px]">
        <LedProgress label={title} />
      </div>
      <div className="text-callout text-ink-3">Measuring only. Nothing is deleted until you choose Clean.</div>
    </div>
  );
}
