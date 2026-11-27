import { CheckCircle2, MemoryStick, SkipForward, Trash2 } from "lucide-react";
import type { PurgeResult } from "../../types";
import { Button } from "../ui";
import { cn, fmtBytes } from "../../lib/format";
import { fmtDuration } from "./purgeEngine";

export interface CleanupSummaryProps {
  result: PurgeResult;
  onDone: () => void;
  doneLabel?: string;
  /** Optional secondary action (e.g. "Scan again"). */
  secondary?: { label: string; onClick: () => void };
}

/** Post-purge summary: "Freed 6.4 GB in 2.3s", per-category breakdown, file counts, standby result. */
export default function CleanupSummary({ result, onDone, doneLabel = "Done", secondary }: CleanupSummaryProps) {
  const rows = (result.perCategory ?? []).filter((r) => r.id !== "standby").sort((a, b) => b.freedBytes - a.freedBytes);
  const max = Math.max(1, ...rows.map((r) => r.freedBytes));
  const nothing = result.freedBytes <= 0 && result.filesDeleted === 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center text-center">
        <div className="relative">
          <span className="absolute inset-0 rounded-full bg-teal/20 blur-xl" />
          <CheckCircle2 size={44} className="relative text-teal drop-shadow-[0_0_12px_rgba(45,212,191,0.6)]" />
        </div>
        <h3 className="mt-3 text-[26px] font-semibold tracking-tight text-ink">
          {nothing ? (
            "Already clean"
          ) : (
            <>
              Freed <span className="font-mono text-gold">{fmtBytes(result.freedBytes)}</span> in{" "}
              <span className="font-mono">{fmtDuration(result.durationMs)}</span>
            </>
          )}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted">
          {nothing ? "There was nothing to remove in the selected categories." : "Deep purge completed safely."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-teal/25 bg-teal/[0.05] px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">
            <Trash2 size={12} className="text-teal" />
            Files deleted
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold text-teal">{result.filesDeleted.toLocaleString()}</div>
        </div>
        <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">
            <SkipForward size={12} className="text-gold" />
            Skipped (locked / in use)
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold text-silver">{result.filesSkipped.toLocaleString()}</div>
        </div>
      </div>

      {rows.length > 0 && (
        <div>
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-gold/80">Breakdown</div>
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li key={r.id} className="relative overflow-hidden rounded-lg border border-line px-3 py-2">
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-gold/[0.08]"
                  style={{ width: `${(r.freedBytes / max) * 100}%` }}
                />
                <div className="relative flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="truncate text-silver">{r.label}</span>
                  <span className="flex shrink-0 items-baseline gap-3 font-mono">
                    <span className="text-[10.5px] text-muted">
                      {r.deleted.toLocaleString()} del{r.skipped > 0 ? ` · ${r.skipped.toLocaleString()} skip` : ""}
                    </span>
                    <span className={cn("w-20 text-right", r.freedBytes > 0 ? "text-gold" : "text-muted")}>
                      {fmtBytes(r.freedBytes)}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.standbyFlushed != null && (
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px]",
            result.standbyFlushed ? "border-purple/40 bg-purple/[0.08] text-[#d8b4fe]" : "border-rose/35 bg-rose/[0.06] text-rose",
          )}
        >
          <MemoryStick size={15} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">RAM standby list:</span>{" "}
            {result.standbyMessage || (result.standbyFlushed ? "Flushed" : "Flush failed")}
          </span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        {secondary && (
          <Button variant="ghost" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
        <Button variant="gold" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
