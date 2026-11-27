import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getPurgeState, subscribePurge } from "../components/cleaner/purgeEngine";
import { useSettings } from "./useSettings";

/** Re-scan cadence for the dashboard's reclaimable-trash estimate. */
const REFRESH_MS = 10 * 60 * 1000;
/** A cached estimate younger than this is reused when the dashboard re-mounts (no new disk walk). */
const FRESH_MS = 5 * 60 * 1000;

export interface TrashEstimate {
  /** Bytes the 1-Click purge would reclaim (its default selection); null until the first scan completes. */
  totalBytes: number | null;
  /** True while a scan is in flight. */
  loading: boolean;
}

/* ------------------------------------------------------------------------------------------------
 * Module-level store. `scan_trash` walks every cache root on disk (seconds of IO on a busy PC), so
 * the estimate is shared by every consumer and survives view switches: navigating back to the
 * dashboard reuses a fresh value instead of re-walking the disk each time.
 * ---------------------------------------------------------------------------------------------- */

interface Snapshot extends TrashEstimate {
  /** Epoch ms of the last successful scan (0 = never). */
  at: number;
  /** includeBrowser flag the cached value was measured with. */
  includeBrowser: boolean | null;
}

let snap: Snapshot = { totalBytes: null, loading: false, at: 0, includeBrowser: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
/** A request that arrived while a scan was running; replayed once it finishes. */
let queued: boolean | null = null;

function publish(patch: Partial<Snapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => snap;

function runScan(includeBrowser: boolean): void {
  if (inFlight) {
    queued = includeBrowser;
    return;
  }
  publish({ loading: true });
  inFlight = (async () => {
    try {
      const scan = await api.scanTrash(includeBrowser);
      if (scan && Array.isArray(scan.categories)) {
        // The backend measures every category (browser caches included) but only pre-selects what the
        // 1-Click purge cleans by default; report that selection, not the grand total.
        const selected = scan.categories.reduce(
          (s, c) => (c.enabled && Number.isFinite(c.bytes) && c.bytes > 0 ? s + c.bytes : s),
          0,
        );
        publish({ totalBytes: selected, at: Date.now(), includeBrowser });
      } else if (scan && Number.isFinite(scan.totalBytes)) {
        publish({ totalBytes: Math.max(0, scan.totalBytes), at: Date.now(), includeBrowser });
      }
    } catch {
      // Keep the previous estimate; the Cleaner view surfaces real scan errors.
    }
  })().finally(() => {
    inFlight = null;
    const next = queued;
    queued = null;
    if (next !== null) runScan(next);
    else publish({ loading: false });
  });
}

/** Scan unless a fresh value for the same browser setting is already cached (or being fetched). */
function ensureFresh(includeBrowser: boolean): void {
  if (inFlight) {
    if (queued === null && snap.includeBrowser !== includeBrowser) queued = includeBrowser;
    return;
  }
  const fresh = snap.at > 0 && snap.includeBrowser === includeBrowser && Date.now() - snap.at < FRESH_MS;
  if (!fresh) runScan(includeBrowser);
}

// Any completed purge (1-Click modal, Cleaner page, F9, tray) invalidates the estimate. Watching the
// shared purge engine — rather than `purge-progress` — also catches purges that finished while no
// dashboard was mounted, and never re-scans while files are still being deleted.
let lastPurgeRun = getPurgeState().lastRunId;
subscribePurge(() => {
  const st = getPurgeState();
  if (st.running || st.lastRunId === lastPurgeRun) return;
  lastPurgeRun = st.lastRunId;
  snap = { ...snap, at: 0 };
  if (listeners.size > 0 && snap.includeBrowser !== null) runScan(snap.includeBrowser);
});

/**
 * Lightweight dry-run trash estimate for dashboard widgets.
 * Calls `api.scanTrash(settings.includeBrowserCaches)` when no fresh value is cached, whenever the
 * browser-cache setting changes, every 10 minutes while mounted, and after every purge.
 * Errors are swallowed (the previous value is kept) — this is a passive estimate, not a workflow.
 */
export function useTrashEstimate(): TrashEstimate {
  const { settings } = useSettings();
  const includeBrowser = settings?.includeBrowserCaches ?? false;
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensureFresh(includeBrowser);
    const id = window.setInterval(() => {
      if (!document.hidden) runScan(includeBrowser);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [includeBrowser]);

  return { totalBytes: s.totalBytes, loading: s.loading };
}

export default useTrashEstimate;
