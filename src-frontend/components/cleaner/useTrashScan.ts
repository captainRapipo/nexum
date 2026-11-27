import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrashCategory, TrashCategoryId, TrashScan } from "../../types";
import { api } from "../../lib/api";

export type ScanPhase = "idle" | "scanning" | "ready" | "error";

export interface TrashScanState {
  phase: ScanPhase;
  scan: TrashScan | null;
  /**
   * [1.1] Recycle Bin age filter the current `scan` was measured with (CONTRACT §3.2). A cleanup of this
   * scan must pass exactly this value to purge_trash. `undefined` = the backend default (Settings).
   */
  scannedRecycleAge: number | null | undefined;
  /** Increments on every successful scan (lets open drill-downs refresh). */
  scanStamp: number;
  error: string | null;
  /** Start a new dry-run scan. Resolves with the scan (or null if superseded / failed). */
  rescan: (includeBrowser: boolean, recycleMinAgeDays?: number | null) => Promise<TrashScan | null>;
  reset: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/** Dry-run scanner with stale-response protection (only the latest request may update state). */
export function useTrashScan(): TrashScanState {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [scan, setScan] = useState<TrashScan | null>(null);
  const [scannedRecycleAge, setScannedRecycleAge] = useState<number | null | undefined>(undefined);
  const [scanStamp, setScanStamp] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      seq.current++;
    };
  }, []);

  const rescan = useCallback(async (includeBrowser: boolean, recycleMinAgeDays?: number | null) => {
    const my = ++seq.current;
    setPhase("scanning");
    setError(null);
    try {
      const res = await api.scanTrash(includeBrowser, recycleMinAgeDays);
      if (!mounted.current || my !== seq.current) return null;
      setScan(res);
      setScannedRecycleAge(recycleMinAgeDays);
      setScanStamp((n) => n + 1);
      setPhase("ready");
      return res;
    } catch (e) {
      if (!mounted.current || my !== seq.current) return null;
      setError(errMsg(e));
      setPhase("error");
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    seq.current++;
    setPhase("idle");
    setScan(null);
    setScannedRecycleAge(undefined);
    setError(null);
  }, []);

  return { phase, scan, scannedRecycleAge, scanStamp, error, rescan, reset };
}

/** Every category of the scan, in backend order. */
export function fileCategories(scan: TrashScan | null): TrashCategory[] {
  return scan?.categories ?? [];
}

/** Categories that can run in this session (admin-only ones are unavailable without elevation). */
export function availableCategories(scan: TrashScan | null): TrashCategory[] {
  return fileCategories(scan).filter((c) => c.available !== false);
}

/**
 * Selection model: defaults to each category's `enabled` flag, with per-id user overrides that
 * survive re-scans. `forced` pins specific ids (e.g. 'browser' bound to a setting). Unavailable
 * categories are never selected.
 */
export function useCategorySelection(scan: TrashScan | null, forced?: Partial<Record<TrashCategoryId, boolean>>) {
  const [overrides, setOverrides] = useState<Partial<Record<TrashCategoryId, boolean>>>({});

  const selected = useMemo(() => {
    const s = new Set<TrashCategoryId>();
    for (const c of availableCategories(scan)) {
      const f = forced?.[c.id];
      const o = overrides[c.id];
      const on = f !== undefined ? f : o !== undefined ? o : c.enabled;
      if (on) s.add(c.id);
    }
    return s;
  }, [scan, overrides, forced]);

  const toggle = useCallback((id: TrashCategoryId, on: boolean) => {
    setOverrides((prev) => ({ ...prev, [id]: on }));
  }, []);

  const setAll = useCallback(
    (on: boolean) => {
      const next: Partial<Record<TrashCategoryId, boolean>> = {};
      for (const c of availableCategories(scan)) next[c.id] = on;
      setOverrides(next);
    },
    [scan],
  );

  const resetOverrides = useCallback(() => setOverrides({}), []);

  const selectedCategories = useMemo(
    () => availableCategories(scan).filter((c) => selected.has(c.id)),
    [scan, selected],
  );
  const selectedBytes = useMemo(
    () => selectedCategories.reduce((a, c) => a + (c.bytes || 0), 0),
    [selectedCategories],
  );
  const selectedFiles = useMemo(
    () => selectedCategories.reduce((a, c) => a + (c.files || 0), 0),
    [selectedCategories],
  );

  return { selected, toggle, setAll, resetOverrides, selectedCategories, selectedBytes, selectedFiles };
}
