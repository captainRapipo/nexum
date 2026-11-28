import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import { clampFrameWindow } from "../lib/frames";
import {
  EVENTS,
  type AgentStatus,
  type FrameSession,
  type FrameStats,
  type FrameTarget,
  type PresentingProcess,
} from "../types";
import { useSettings } from "./useSettings";

/** Stats older than this (agent clock, same machine) are not "fresh" (CONTRACT §4.4). */
export const FRAME_STATS_FRESH_MS = 3000;

export interface FramesValue {
  /** = settings.fpsCaptureEnabled */
  enabled: boolean;
  session: FrameSession | null;
  target: FrameTarget | null;
  stats: FrameStats | null;
  /** stats != null && stats.pid === target?.pid && now − stats.ts ≤ 3000. */
  statsFresh: boolean;
  /** Rolling: the last fpsWindowSec frame-stats batches for the current target, oldest first. */
  frametimes: readonly number[];
  setEnabled: (on: boolean) => Promise<void>;
  setTarget: (pid: number | null) => Promise<void>;
  setWindow: (sec: number) => Promise<void>;
  setExcludes: (names: string[]) => Promise<void>;
  listPresenting: () => Promise<PresentingProcess[]>;
}

interface FramesContextValue extends FramesValue {
  /** Ref-counted interest: frame-stats are only followed while ≥ 1 mounted useFrames() caller exists. */
  retain: () => () => void;
}

const FramesContext = createContext<FramesContextValue | null>(null);

interface FrameData {
  session: FrameSession | null;
  target: FrameTarget | null;
  stats: FrameStats | null;
  frametimes: readonly number[];
}

const EMPTY: FrameData = { session: null, target: null, stats: null, frametimes: [] };
const NO_FRAMETIMES: readonly number[] = [];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/**
 * Frame capture state for the whole app (CONTRACT §4.4). Mounted in App.tsx above every view.
 * `frame-session` / `frame-target` are always followed (rare events); `frame-stats` (1 Hz, with up to
 * 1000 frame times each) only while capture is on, the window is visible and a consumer (Gaming view,
 * Dashboard KPI) is mounted.
 */
export function FramesProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const enabled = settings.fpsCaptureEnabled;
  const windowSec = settings.fpsWindowSec;

  const [data, setData] = useState<FrameData>(EMPTY);
  const [interest, setInterest] = useState(0);
  const [, setFreshTick] = useState(0);

  /** Frame-time batches of the current target (one per frame-stats), oldest first. */
  const batches = useRef<{ pid: number | null; list: number[][] }>({ pid: null, list: [] });
  const windowRef = useRef(windowSec);
  windowRef.current = windowSec;
  const freshTimer = useRef<number | null>(null);

  const clearBatches = (pid: number | null) => {
    batches.current = { pid, list: [] };
  };

  const applySession = useCallback((s: FrameSession) => {
    setData((d) => {
      // A stopped or failed session has no target and no live stats.
      if (s.state === "stopped" || s.state === "error") {
        clearBatches(null);
        return { session: s, target: null, stats: null, frametimes: NO_FRAMETIMES };
      }
      return { ...d, session: s };
    });
  }, []);

  const applyTarget = useCallback((t: FrameTarget) => {
    setData((d) => {
      if (t.pid !== batches.current.pid) {
        clearBatches(t.pid);
        return { ...d, target: t, frametimes: NO_FRAMETIMES, stats: d.stats && d.stats.pid === t.pid ? d.stats : null };
      }
      return { ...d, target: t };
    });
  }, []);

  const applyStats = useCallback((s: FrameStats) => {
    const b = batches.current;
    if (b.pid !== s.pid) clearBatches(s.pid);
    const keep = Math.max(1, Math.round(s.windowSec || windowRef.current || 30));
    const list = batches.current.list;
    list.push(Array.isArray(s.frametimes) ? s.frametimes : []);
    while (list.length > keep) list.shift();
    const frametimes = list.length === 1 ? list[0] : ([] as number[]).concat(...list);
    setData((d) => ({ ...d, stats: s, frametimes }));
    // Re-render once the stats go stale, so statsFresh turns false without new events.
    if (freshTimer.current != null) window.clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => {
      freshTimer.current = null;
      setFreshTick((n) => n + 1);
    }, FRAME_STATS_FRESH_MS + 100);
  }, []);

  const reset = useCallback(() => {
    clearBatches(null);
    setData(EMPTY);
  }, []);

  /** Cached state from Rust (stats come without frame times). */
  const loadState = useCallback(() => {
    api
      .getFrameState()
      .then((st) => {
        if (!isObj(st)) return;
        setData((d) => {
          const session = isObj(st.session) ? (st.session as FrameSession) : null;
          const target = isObj(st.target) ? (st.target as FrameTarget) : null;
          // Keep a newer pushed stats packet; the cached one is only a fallback.
          const cached = isObj(st.stats) ? (st.stats as FrameStats) : null;
          const stats = d.stats && cached && d.stats.ts >= cached.ts ? d.stats : (cached ?? d.stats);
          // Pushed events are newer than the cache: keep them when present.
          const nextTarget = d.target ?? target;
          const samePid = (nextTarget?.pid ?? null) === batches.current.pid;
          if (!samePid) clearBatches(nextTarget?.pid ?? null);
          return {
            session: d.session && (!session || d.session.sinceTs >= session.sinceTs) ? d.session : session,
            target: nextTarget,
            stats: stats && nextTarget && stats.pid === nextTarget.pid ? stats : null,
            frametimes: samePid ? d.frametimes : NO_FRAMETIMES,
          };
        });
      })
      .catch((err) => console.warn("[nexum] get_frame_state failed:", errorMessage(err)));
  }, []);

  // Session and target: always followed (they change rarely). Initial state on mount.
  useEffect(() => {
    const offSession = subscribe<FrameSession>(EVENTS.frameSession, (s) => {
      if (isObj(s) && typeof s.state === "string") applySession(s);
    });
    const offTarget = subscribe<FrameTarget>(EVENTS.frameTarget, (t) => {
      if (isObj(t) && typeof t.reason === "string") applyTarget(t);
    });
    const offStatus = subscribe<AgentStatus>(EVENTS.agentStatus, (s) => {
      // [CHANGED 1.2] Any phase other than "running" means the capture process is gone or being replaced
      // (after restart_agent Rust reports phase "starting" with running:true, CONTRACT §2.3.1).
      if (isObj(s) && (s.running === false || (typeof s.phase === "string" && s.phase !== "running"))) reset();
    });
    loadState();
    return () => {
      offSession();
      offTarget();
      offStatus();
    };
  }, [applySession, applyTarget, reset, loadState]);

  // The window is hidden (minimized or in the tray): nobody can see frame stats, so do not follow them.
  // The agent's capture keeps running either way (CONTRACT §2: never paused while hidden).
  const [docVisible, setDocVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Stats: only while capture is on, the window is visible and a consumer (Gaming view, Dashboard KPI) is
  // mounted. Leaving those views drops the 1 Hz stream and the rolling frame-time buffer (up to
  // 120 s × 1000 values), so a later return never shows minutes-old frames joined to new ones.
  const following = enabled && interest > 0 && docVisible;
  useEffect(() => {
    if (!following) return;
    loadState(); // catch up on session/target/stats missed while nobody listened
    const off = subscribe<FrameStats>(EVENTS.frameStats, (s) => {
      if (isObj(s) && typeof s.pid === "number") applyStats(s);
    });
    return () => {
      off();
      clearBatches(batches.current.pid);
      setData((d) => (d.frametimes.length ? { ...d, frametimes: NO_FRAMETIMES } : d));
    };
  }, [following, applyStats, loadState]);

  // Capture turned off in Settings: drop live data at once (the agent's events follow).
  useEffect(() => {
    if (!enabled) {
      clearBatches(null);
      setData((d) => (d.stats || d.frametimes.length ? { ...d, stats: null, frametimes: NO_FRAMETIMES } : d));
    }
  }, [enabled]);

  useEffect(
    () => () => {
      if (freshTimer.current != null) window.clearTimeout(freshTimer.current);
    },
    [],
  );

  const retain = useCallback(() => {
    setInterest((n) => n + 1);
    return () => setInterest((n) => Math.max(0, n - 1));
  }, []);

  const setEnabled = useCallback(async (on: boolean) => {
    await api.setFrameCapture(on);
  }, []);
  const setTarget = useCallback(async (pid: number | null) => {
    await api.setFrameTarget(pid);
  }, []);
  const setWindow = useCallback(async (sec: number) => {
    await api.setFrameWindow(clampFrameWindow(sec));
  }, []);
  const setExcludes = useCallback(async (names: string[]) => {
    await api.setFrameExcludes(names);
  }, []);
  const listPresenting = useCallback(() => api.listPresentingProcesses(), []);

  const { session, target, stats, frametimes } = data;
  const statsFresh =
    stats != null && target != null && stats.pid === target.pid && Date.now() - stats.ts <= FRAME_STATS_FRESH_MS;

  const value = useMemo<FramesContextValue>(
    () => ({
      enabled,
      session,
      target,
      stats,
      statsFresh,
      frametimes,
      setEnabled,
      setTarget,
      setWindow,
      setExcludes,
      listPresenting,
      retain,
    }),
    [enabled, session, target, stats, statsFresh, frametimes, setEnabled, setTarget, setWindow, setExcludes, listPresenting, retain],
  );

  return createElement(FramesContext.Provider, { value }, children);
}

/** Frame capture state and actions (CONTRACT §4.4). Must be used under <FramesProvider>. */
export function useFrames(): FramesValue {
  const ctx = useContext(FramesContext);
  if (!ctx) throw new Error("useFrames() must be used inside <FramesProvider>");
  const { retain } = ctx;
  useEffect(() => retain(), [retain]);
  return ctx;
}

export default useFrames;
