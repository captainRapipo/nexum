import { Info } from "lucide-react";
import type { PurgeResult } from "../../types";
import { api } from "../../lib/api";
import { Button, InkLink, StatusIcon } from "../ui";
import { toast } from "../feedback/Toast";
import { cn } from "../../lib/format";
import { fmtDuration } from "./purgeEngine";
import { dirnameOf, fmtIn, listUnit, pickUnit } from "./cleanerCopy";

export interface CleanupSummaryProps {
  result: PurgeResult;
  onDone: () => void;
  doneLabel?: string;
  /** Optional secondary action (e.g. "Measure again"). */
  secondary?: { label: string; onClick: () => void };
  /**
   * "page" (default): headline, numbers, links and the buttons (all secondary: a page has no primary).
   * "dialog": numbers and links only; the dialog shows `summaryHeadline()` as its title and owns the buttons.
   */
  variant?: "page" | "dialog";
  className?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `Freed 6.4 GB in 2.3s` / `Nothing to remove`. */
export function summaryHeadline(result: PurgeResult): string {
  if (result.freedBytes <= 0 && result.filesDeleted === 0) return "Nothing to remove";
  return `Freed ${fmtIn(result.freedBytes, pickUnit(result.freedBytes))} in ${fmtDuration(result.durationMs)}`;
}

/** One sentence under the headline. */
export function summaryDetail(result: PurgeResult): string {
  return result.freedBytes <= 0 && result.filesDeleted === 0
    ? "The selected categories had no files that could be removed."
    : "Cleanup finished. Every file is listed in the log.";
}

/** After a cleanup: "Freed 6.4 GB in 2.3 s", per-category breakdown with skip notes, and the audit log. */
export default function CleanupSummary({ result, onDone, doneLabel = "Done", secondary, variant = "page", className }: CleanupSummaryProps) {
  const rows = [...(result.perCategory ?? [])].sort((a, b) => b.freedBytes - a.freedBytes);
  const unit = listUnit(rows.map((r) => ({ bytes: r.freedBytes })));
  const hasDumps = rows.some((r) => r.id === "dumps" || r.id === "memory-dump");
  const page = variant === "page";

  const viewLog = () => {
    if (!result.logPath) return;
    api.openExternal(dirnameOf(result.logPath)).catch((e: unknown) => toast(`Could not open the log folder: ${errMsg(e)}`, "crit"));
  };
  const openReliability = () => {
    api.openReliabilityMonitor().catch((e: unknown) => toast(`Could not open Reliability Monitor: ${errMsg(e)}`, "crit"));
  };

  return (
    <div className={cn("flex flex-col gap-3.5", page && "px-(--card-pad-x) pb-(--card-pad-y) pt-1", className)}>
      {page && (
        <div className="flex items-start gap-2.5">
          <StatusIcon tone="ok" size={20} className="mt-1" />
          <div className="min-w-0">
            <h3 className="tnum text-[22px] font-semibold leading-7 tracking-[-0.015em] text-ink">{summaryHeadline(result)}</h3>
            <p className="text-body text-ink-2">{summaryDetail(result)}</p>
          </div>
        </div>
      )}

      <div className="rounded-lg bg-inset px-3 py-1">
        <div className="tnum flex h-8 items-center justify-between gap-3 border-b border-divider text-body">
          <span className="text-ink-2">Files deleted</span>
          <span className="font-semibold text-ink">{result.filesDeleted.toLocaleString("en-US")}</span>
        </div>
        <div className="tnum flex h-8 items-center justify-between gap-3 text-body">
          <span className="text-ink-2" title="Files in use, too new or protected are skipped, never forced.">
            Skipped
          </span>
          <span className="font-medium text-ink">{result.filesSkipped.toLocaleString("en-US")}</span>
        </div>
      </div>

      {rows.length > 0 && (
        <div>
          <div className="mb-1 text-[12px] font-semibold leading-4 text-ink-2">By category</div>
          <ul>
            {rows.map((r) => (
              <li key={r.id} className="border-b border-divider py-1.5 last:border-b-0">
                <div className="tnum flex items-baseline justify-between gap-3 text-body">
                  <span className="min-w-0 truncate text-ink">{r.label}</span>
                  <span className="flex shrink-0 items-baseline gap-3">
                    <span className="text-callout text-ink-3">
                      {r.deleted.toLocaleString("en-US")} deleted{r.skipped > 0 ? ` · ${r.skipped.toLocaleString("en-US")} skipped` : ""}
                    </span>
                    <span className={cn("w-[68px] text-right", r.freedBytes > 0 ? "font-semibold text-ink" : "text-ink-3")}>
                      {fmtIn(r.freedBytes, unit)}
                    </span>
                  </span>
                </div>
                {r.note && (
                  <div className="mt-0.5 flex items-start gap-1.5 text-callout text-ink-2">
                    <Info size={13} className="mt-0.5 shrink-0 text-info-icon" aria-hidden="true" />
                    <span>{r.note}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {result.logPath && (
            <InkLink onClick={viewLog} title={result.logPath}>
              View log
            </InkLink>
          )}
          {hasDumps && <InkLink onClick={openReliability}>Open Reliability Monitor</InkLink>}
        </div>
        {page && (
          <div className="flex gap-2">
            {secondary && <Button onClick={secondary.onClick}>{secondary.label}</Button>}
            <Button onClick={onDone}>{doneLabel}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
