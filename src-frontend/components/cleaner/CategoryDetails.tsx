import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Folder, Layers, Loader2, RefreshCw } from "lucide-react";
import { TRASH_DETAILS_LIMIT, type TrashCategoryId, type TrashDetailItem } from "../../types";
import { api, errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button, InkLink, Tag } from "../ui";
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
      <div className="flex items-center gap-2 py-2 text-callout text-ink-2" role="status">
        <Loader2 size={13} className="animate-spin text-ink-3" aria-hidden="true" />
        Listing files…
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="flex items-center justify-between gap-3 py-1.5 text-callout text-ink-2" role="alert">
        <span className="min-w-0">Could not list the files: {state.message}</span>
        <Button size="sm" icon={RefreshCw} onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  const items = state.items;
  if (items.length === 0) {
    return (
      <p className="py-2 text-callout text-ink-2">
        {isRecycle && recycleMinAgeDays != null
          ? `Nothing in the Recycle Bin is older than ${recycleMinAgeDays} ${recycleMinAgeDays === 1 ? "day" : "days"}.`
          : "Nothing in this category would be deleted right now."}
      </p>
    );
  }

  const unit = pickUnit(...items.map((i) => i.bytes));
  const cols = "grid grid-cols-[minmax(0,1fr)_76px_104px_96px] items-center gap-x-3 px-2.5";
  return (
    <div className="overflow-hidden rounded-lg bg-content shadow-[inset_0_0_0_0.5px_var(--color-subtle)]">
      <div className={cn(cols, "h-7 border-b border-hairline text-[11px] font-semibold text-ink-2")}>
        <span>{isRecycle ? "Original location" : "Path"}</span>
        <span className="text-right">Size</span>
        <span title={isRecycle ? "When the item was deleted" : "Last modified"}>{isRecycle ? "Deleted" : "Modified"}</span>
        <span className="sr-only">Actions</span>
      </div>
      <ul className="zebra max-h-[264px] overflow-y-auto" aria-label={`Largest items, up to ${TRASH_DETAILS_LIMIT}`}>
        {items.map((it, i) => {
          const Icon = it.kind === "group" ? Layers : it.kind === "folder" ? Folder : FileText;
          const folder = it.kind === "group" ? it.path : dirnameOf(it.path);
          return (
            <li key={`${it.path}-${i}`} className={cn(cols, "tnum h-6 text-callout")}>
              <span className="flex min-w-0 items-center gap-1.5" title={it.path}>
                <Icon size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
                <span className="truncate font-mono text-[11.5px] text-ink">{middleTruncate(it.path)}</span>
                {it.kind === "group" && <Tag title="Cleared by Windows' own Delivery Optimization command, not file by file">Windows</Tag>}
              </span>
              <span className="text-right font-medium text-ink">{fmtSize(it.bytes, unit)}</span>
              <span className="truncate text-ink-2">{fmtAge(it.modifiedTs, state.at)}</span>
              <span className="flex justify-end">
                {!isRecycle && isLocalDrivePath(folder) && (
                  <InkLink onClick={() => openFolder(it)} title={`Open ${folder}`} aria-label={`Open the folder of ${it.path}`} chevron={false}>
                    Open folder
                  </InkLink>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-hairline px-2.5 py-1.5 text-callout text-ink-3">
        {items.length >= TRASH_DETAILS_LIMIT
          ? `The ${TRASH_DETAILS_LIMIT} largest items. `
          : `${items.length} ${items.length === 1 ? "item" : "items"}. `}
        Only what a cleanup would delete now: files in use, too new or protected are not listed.
      </p>
    </div>
  );
}
