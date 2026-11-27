import { useSyncExternalStore } from "react";
import type { PurgeProgress, PurgeResult, TrashCategory, TrashCategoryId } from "../../types";
import { api, onEvent } from "../../lib/api";
import { fmtBytes } from "../../lib/format";
import { toast } from "../feedback/Toast";

/**
 * Module-level purge runner shared by the 1-Click modal and the Cleaner page.
 * Living outside React means a purge keeps reporting progress (and lands in the session history)
 * even if the modal is closed or the view is switched mid-run, and two surfaces can never start
 * overlapping purges.
 */

export interface PurgeHistoryEntry {
  id: number;
  at: number;
  source: string;
  categories: string[];
  flushStandby: boolean;
  result: PurgeResult;
}

export interface PurgeEngineState {
  running: boolean;
  runId: number;
  startedAt: number | null;
  /** Labels/ids of what the current/last run purges, for the progress checklist. */
  plan: { id: TrashCategoryId; label: string }[];
  flushStandby: boolean;
  progress: PurgeProgress | null;
  /** Monotonic running total of freed bytes reported by `purge-progress`. */
  freedSoFar: number;
  /** Category ids that have reported progress (completed or in flight). */
  touched: TrashCategoryId[];
  /**
   * Category ids that finished. The backend emits two events per category with the same step
   * (start, then end with the updated running total), so the second sighting marks completion.
   */
  completed: TrashCategoryId[];
  lastResult: PurgeResult | null;
  lastRunId: number | null;
  error: string | null;
  history: PurgeHistoryEntry[];
}

let state: PurgeEngineState = {
  running: false,
  runId: 0,
  startedAt: null,
  plan: [],
  flushStandby: false,
  progress: null,
  freedSoFar: 0,
  touched: [],
  completed: [],
  lastResult: null,
  lastRunId: null,
  error: null,
  history: [],
};

const listeners = new Set<() => void>();
let viewers = 0;
let historySeq = 1;

function set(patch: Partial<PurgeEngineState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribePurge(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getPurgeState(): PurgeEngineState {
  return state;
}

export function usePurgeEngine(): PurgeEngineState {
  return useSyncExternalStore(subscribePurge, getPurgeState, getPurgeState);
}

/**
 * Register a surface that visibly shows purge progress/summary. When a purge finishes and no
 * viewer is attached (e.g. the modal was closed mid-run), a toast reports the result instead.
 */
export function attachPurgeViewer(): () => void {
  viewers++;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    viewers = Math.max(0, viewers - 1);
  };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Accept either a bare payload or a Tauri `Event<T>` wrapper. */
export function unwrapEvent<T>(raw: unknown): T {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("payload" in o && "event" in o) return o.payload as T;
  }
  return raw as T;
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.max(0.1, ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Start a purge of `categories` (the 'standby' pseudo-category is always stripped; RAM standby
 * flushing is requested via `flushStandby`). Resolves with the result, or rejects on failure.
 * Rejects immediately if another purge is already running.
 */
export async function startPurge(
  categories: TrashCategory[],
  flushStandby: boolean,
  source: string,
): Promise<PurgeResult> {
  if (state.running) throw new Error("A purge is already running");

  const plan = categories.filter((c) => c.id !== "standby").map((c) => ({ id: c.id, label: c.label }));
  const ids = plan.map((c) => c.id);
  if (ids.length === 0 && !flushStandby) throw new Error("Nothing selected to purge");

  const runId = state.runId + 1;
  set({
    running: true,
    runId,
    startedAt: Date.now(),
    plan,
    flushStandby,
    progress: null,
    freedSoFar: 0,
    touched: [],
    completed: [],
    error: null,
  });

  let unlisten: (() => void) | null = null;
  try {
    // Subscribe BEFORE invoking so the first progress event is never missed.
    try {
      unlisten = await onEvent<PurgeProgress>("purge-progress", (raw: unknown) => {
        if (state.runId !== runId || !state.running) return;
        const p = unwrapEvent<PurgeProgress>(raw);
        if (!p || typeof p !== "object") return;
        const freed = Number.isFinite(p.freedBytes) ? Math.max(state.freedSoFar, p.freedBytes) : state.freedSoFar;
        const id = p.categoryId;
        let touched = state.touched;
        let completed = state.completed;
        if (id) {
          if (!touched.includes(id)) touched = [...touched, id];
          else if (!completed.includes(id)) completed = [...completed, id];
          // Starting a later step implies every earlier touched category is done.
          completed = [...completed, ...touched.filter((t) => t !== id && !completed.includes(t))];
        }
        set({ progress: p, freedSoFar: freed, touched, completed });
      });
    } catch {
      unlisten = null; // progress overlay will fall back to the indeterminate animation
    }

    const result = await api.purgeTrash(ids, flushStandby);
    const entry: PurgeHistoryEntry = {
      id: historySeq++,
      at: Date.now(),
      source,
      categories: plan.map((c) => c.label),
      flushStandby,
      result,
    };
    set({
      running: false,
      completed: state.touched,
      lastResult: result,
      lastRunId: runId,
      freedSoFar: Math.max(state.freedSoFar, result.freedBytes),
      history: [entry, ...state.history].slice(0, 50),
    });
    if (viewers === 0) {
      toast(`Purge complete — freed ${fmtBytes(result.freedBytes)} in ${fmtDuration(result.durationMs)}`, "ok", {
        detail: `${result.filesDeleted.toLocaleString()} files deleted · ${result.filesSkipped.toLocaleString()} skipped`,
      });
    }
    return result;
  } catch (e) {
    const message = errMsg(e);
    set({ running: false, error: message, lastRunId: runId, lastResult: null });
    if (viewers === 0) toast(`Purge failed: ${message}`, "crit");
    throw e instanceof Error ? e : new Error(message);
  } finally {
    if (unlisten) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
    }
  }
}
