import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Folder, FolderOpen, Layers, Loader2, RefreshCw } from "lucide-react";
import { TRASH_DETAILS_LIMIT, type TrashCategoryId, type TrashDetailItem } from "../../types";
import { api, errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { toast } from "../feedback/Toast";
import { dirnameOf, fmtIn, pickUnit, type ByteUnit } from "./cleanerCopy";

const MB = 1024 * 1024;

/** One unit per list (CONTRACT §4.8); very small files read "< 0.1 MB" instead of "0.0 MB". */
function fmtSize(bytes: number, unit: ByteUnit): string {
  if (unit === "MB" && bytes > 0 && bytes < 0.05 * MB) return "< 0.1 MB";
  return fmtIn(bytes, unit);
}

const DAY = 86_400_000;

/** `just now`, `5 minutes ago`, `3 hours ago`, `3 days ago`, `2 months ago`, `4 years ago`. */
export function fmtAge(ts: number | null, now: number): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const ms = Math.max(0, now - ts);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return plural(Math.floor(ms / 60_000), "minute");
  if (ms < DAY) return plural(Math.floor(ms / 3_600_000), "hour");
  const days = Math.floor(ms / DAY);
  if (days < 60) return plural(days, "day");
  const months = Math.floor(days / 30.4375);
  if (months < 24) return plural(months, "month");
  return plural(Math.floor(days / 365.25), "year");
}

/**
 * Open folder is offered only for plain local drive paths (`C:\…`), the only kind `open_external`
 * accepts: never UNC shares (an elevated probe of one leaks credentials), never `\\?\` device paths.
 */
export function isLocalDrivePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) && !/[\u0000-\u001f"]/.test(p);
}

/** Keeps the drive and the file name: `C:\Users\User\AppData\…\Cache_Data\f_00a1b2`. */
export function middleTruncate(path: string, max = 72): string {
  if (path.length <= max) return path;
  const keepEnd = Math.ceil(max * 0.6);
  const keepStart = max - keepEnd - 1;
  return `${path.slice(0, keepStart)}…${path.slice(path.length - keepEnd)}`;
}

export interface CategoryDetailsProps {
  categoryId: TrashCategoryId;
  /** Recycle Bin age filter passed to scan_trash_details (CONTRACT §3.2–3.3). */
  recycleMinAgeDays: number | null;
  /** Changes whenever the category estimate was re-measured, so the list follows it. */
  scanStamp: number;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; items: TrashDetailItem[]; at: number }
  | { phase: "error"; message: string };

/**
 * "Show files" drill-down of one cache category (CONTRACT §3.3, §4.10.2): the largest items a cleanup of
 * this category would delete right now (same rules as the cleanup itself), with Open folder.
 */
export default function CategoryDetails({ categoryId, recycleMinAgeDays, scanStamp }: CategoryDetailsProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const seq = useRef(0);
  const isRecycle = categoryId === "recycle";

  const load = useCallback(async () => {
    const my = ++seq.current;
    setState({ phase: "loading" });
    try {
      const items = await api.scanTrashDetails(categoryId, TRASH_DETAILS_LIMIT, recycleMinAgeDays);
      if (my === seq.current) setState({ phase: "ready", items, at: Date.now() });
    } catch (e) {
      if (my === seq.current) setState({ phase: "error", message: errorMessage(e) });
    }
  }, [categoryId, recycleMinAgeDays]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load, scanStamp]);

  const openFolder = (item: TrashDetailItem) => {
    const target = item.kind === "group" ? item.path : dirnameOf(item.path);
    api.openExternal(target).catch((e: unknown) => toast(`Could not open the folder: ${errorMessage(e)}`, "warn"));
  };

  if (state.phase === "loading") {
    return (
      <div className="flex items-center gap-2 py-3 text-[11.5px] text-muted">
        <Loader2 size={12} className="animate-spin text-teal" aria-hidden="true" />
        Listing files…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-3 py-2 text-[11.5px] text-slate-400">
        <span className="min-w-0">Could not list the files: {state.message}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-silver hover:text-ink"
        >
          <RefreshCw size={11} aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  const items = state.items;
  if (items.length === 0) {
    return (
      <p className="py-2.5 text-[11.5px] text-muted">
        {isRecycle && recycleMinAgeDays != null
          ? `Nothing in the Recycle Bin is older than ${recycleMinAgeDays} ${recycleMinAgeDays === 1 ? "day" : "days"}.`
          : "Nothing in this category would be deleted right now."}
      </p>
    );
  }

  const unit = pickUnit(...items.map((i) => i.bytes));
  return (
    <div className="pt-1">
      <div className="grid grid-cols-[minmax(0,1fr)_76px_104px_88px] items-center gap-x-3 border-b border-line pb-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted">
        <span>{isRecycle ? "Original location" : "Path"}</span>
        <span className="text-right">Size</span>
        <span title={isRecycle ? "When the item was deleted" : "Last modified"}>{isRecycle ? "Deleted" : "Modified"}</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul className="nx-scroll max-h-[280px] overflow-y-auto pr-1" aria-label={`Largest items, up to ${TRASH_DETAILS_LIMIT}`}>
        {items.map((it, i) => {
          const Icon = it.kind === "group" ? Layers : it.kind === "folder" ? Folder : FileText;
          return (
            <li
              key={`${it.path}-${i}`}
              className="grid grid-cols-[minmax(0,1fr)_76px_104px_88px] items-center gap-x-3 border-b border-white/[0.04] py-1 text-[11.5px] last:border-b-0"
            >
              <span className="flex min-w-0 items-center gap-1.5" title={it.path}>
                <Icon size={11} className="shrink-0 text-slate-500" aria-hidden="true" />
                <span className="truncate font-mono text-[11px] text-slate-300">{middleTruncate(it.path)}</span>
                {it.kind === "group" && (
                  <span
                    className="shrink-0 rounded border border-line px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-400"
                    title="Cleared by Windows' own Delivery Optimization command, not file by file"
                  >
                    Windows
                  </span>
                )}
              </span>
              <span className="text-right font-mono text-[11px] text-ink">{fmtSize(it.bytes, unit)}</span>
              <span className="truncate text-[11px] text-slate-400">{fmtAge(it.modifiedTs, state.at)}</span>
              <span className="flex justify-end">
                {!isRecycle && isLocalDrivePath(it.kind === "group" ? it.path : dirnameOf(it.path)) && (
                  <button
                    type="button"
                    onClick={() => openFolder(it)}
                    title={`Open ${it.kind === "group" ? it.path : dirnameOf(it.path)}`}
                    aria-label={`Open the folder of ${it.path}`}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-silver transition",
                      "hover:bg-white/[0.06] hover:text-ink",
                    )}
                  >
                    <FolderOpen size={11} aria-hidden="true" />
                    Open folder
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="pt-1.5 text-[10.5px] text-muted">
        {items.length >= TRASH_DETAILS_LIMIT
          ? `The ${TRASH_DETAILS_LIMIT} largest items. `
          : `${items.length} ${items.length === 1 ? "item" : "items"}. `}
        Only what a cleanup would delete now: files in use, too new or protected are not listed.
      </p>
    </div>
  );
}
