import { CheckCircle2, ExternalLink, FolderOpen, Info, SkipForward, Trash2 } from "lucide-react";
import type { PurgeResult } from "../../types";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { toast } from "../feedback/Toast";
import { cn } from "../../lib/format";
import { fmtDuration } from "./purgeEngine";
import { dirnameOf, fmtIn, listUnit, pickUnit } from "./cleanerCopy";

export interface CleanupSummaryProps {
  result: PurgeResult;
  onDone: () => void;
  doneLabel?: string;
  /** Optional secondary action (e.g. "Scan again"). */
  secondary?: { label: string; onClick: () => void };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** After a cleanup: "Freed 6.4 GB in 2.3 s", per-category breakdown with skip notes, and the audit log. */
export default function CleanupSummary({ result, onDone, doneLabel = "Done", secondary }: CleanupSummaryProps) {
  const rows = [...(result.perCategory ?? [])].sort((a, b) => b.freedBytes - a.freedBytes);
  const unit = listUnit(rows.map((r) => ({ bytes: r.freedBytes })));
  const totalUnit = pickUnit(result.freedBytes);
  const max = Math.max(1, ...rows.map((r) => r.freedBytes));
  const nothing = result.freedBytes <= 0 && result.filesDeleted === 0;
  const hasDumps = rows.some((r) => r.id === "dumps" || r.id === "memory-dump");

  const viewLog = () => {
    if (!result.logPath) return;
    api.openExternal(dirnameOf(result.logPath)).catch((e: unknown) => toast(`Could not open the log folder: ${errMsg(e)}`, "crit"));
  };
  const openReliability = () => {
    api.openReliabilityMonitor().catch((e: unknown) => toast(`Could not open Reliability Monitor: ${errMsg(e)}`, "crit"));
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center text-center">
        <CheckCircle2 size={40} className="text-ok" aria-hidden="true" />
        <h3 className="mt-3 text-[24px] font-semibold tracking-tight text-ink">
          {nothing ? (
            "Nothing to remove"
          ) : (
            <>
              Freed <span className="font-mono">{fmtIn(result.freedBytes, totalUnit)}</span> in{" "}
              <span className="font-mono">{fmtDuration(result.durationMs)}</span>
            </>
          )}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted">
          {nothing ? "The selected categories had no files that could be removed." : "Cleanup finished. Every file is listed in the log."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">
            <Trash2 size={12} className="text-silver" />
            Files deleted
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold text-ink">{result.filesDeleted.toLocaleString("en-US")}</div>
        </div>
        <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-muted">
            <SkipForward size={12} className="text-silver" />
            Skipped
          </div>
          <div className="mt-1 font-mono text-[22px] font-semibold text-silver">{result.filesSkipped.toLocaleString("en-US")}</div>
        </div>
      </div>

      {rows.length > 0 && (
        <div>
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-silver">By category</div>
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li key={r.id} className="relative overflow-hidden rounded-lg border border-line px-3 py-2">
                <span aria-hidden className="absolute inset-y-0 left-0 bg-teal/[0.07]" style={{ width: `${(r.freedBytes / max) * 100}%` }} />
                <div className="relative flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="truncate text-silver">{r.label}</span>
                  <span className="flex shrink-0 items-baseline gap-3 font-mono">
                    <span className="text-[10.5px] text-muted">
                      {r.deleted.toLocaleString("en-US")} deleted{r.skipped > 0 ? ` · ${r.skipped.toLocaleString("en-US")} skipped` : ""}
                    </span>
                    <span className={cn("w-20 text-right", r.freedBytes > 0 ? "text-ink" : "text-muted")}>{fmtIn(r.freedBytes, unit)}</span>
                  </span>
                </div>
                {r.note && (
                  <div className="relative mt-1 flex items-start gap-1.5 text-[11px] text-cyan">
                    <Info size={11} className="mt-[2px] shrink-0" aria-hidden="true" />
                    <span>{r.note}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          {result.logPath && (
            <button
              type="button"
              onClick={viewLog}
              title={result.logPath}
              className="inline-flex items-center gap-1.5 text-silver underline decoration-white/20 underline-offset-2 transition hover:text-ink"
            >
              <FolderOpen size={13} aria-hidden="true" />
              View log
            </button>
          )}
          {hasDumps && (
            <button
              type="button"
              onClick={openReliability}
              className="inline-flex items-center gap-1.5 text-silver underline decoration-white/20 underline-offset-2 transition hover:text-ink"
            >
              <ExternalLink size={13} aria-hidden="true" />
              Open Reliability Monitor
            </button>
          )}
        </div>
        <div className="flex gap-2">
          {secondary && (
            <Button variant="ghost" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
          <Button variant="teal" onClick={onDone}>
            {doneLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
