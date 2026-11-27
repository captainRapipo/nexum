import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import { EVENTS, type TuningProbeSummary, type TuningState } from "../types";

/** Poll period while the GPU tuning tab is visible (ROADMAP §5.2 item 8, CONTRACT §2.14). */
export const TUNING_POLL_MS = 5000;

export interface TuningStateValue {
  state: TuningState | null;
  loading: boolean;
  error: string | null;
  /** `get_tuning_state { refresh: true }` now (F5 on the GPU tuning tab). */
  refresh: () => Promise<void>;
  /** Read-only probe; always `write: false`. Rejects with the backend message. */
  runProbe: () => Promise<TuningProbeSummary>;
}

/**
 * Read-only GPU tuning data (CONTRACT §4.4). While `active`, asks for a fresh state immediately and
 * every 5 s (the next request starts only after the previous one settled). While inactive, or while the
 * window is hidden, it never calls the backend, so no ADL call ever runs while the tab is not on screen.
 */
export function useTuningState(active: boolean): TuningStateValue {
  const [state, setState] = useState<TuningState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const inflight = useRef<Promise<void> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchState = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    setLoading(true);
    const run = api
      .getTuningState(true)
      .then((s) => {
        if (!alive.current) return;
        if (s && typeof s === "object") setState(s);
        setError(null);
      })
      .catch((err) => {
        if (alive.current) setError(errorMessage(err));
      })
      .finally(() => {
        inflight.current = null;
        if (alive.current) setLoading(false);
      });
    inflight.current = run;
    return run;
  }, []);

  // The window is hidden (minimized or in the tray): the tab is not visible, so no ADL reads either.
  const [docVisible, setDocVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Poll only while active and visible (CONTRACT §2.14: never while the tab is hidden).
  useEffect(() => {
    if (!active || !docVisible) return;
    let stopped = false;
    let timer: number | null = null;
    const loop = async () => {
      await fetchState();
      if (stopped) return;
      timer = window.setTimeout(() => void loop(), TUNING_POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [active, docVisible, fetchState]);

  // A probe or another caller refreshed the state.
  useEffect(
    () =>
      subscribe<TuningState>(EVENTS.tuningState, (s) => {
        if (s && typeof s === "object" && alive.current) setState(s);
      }),
    [],
  );

  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    await fetchState();
  }, [fetchState]);

  const runProbe = useCallback(() => api.runTuningProbe(false), []);

  return { state, loading, error, refresh, runProbe };
}

export default useTuningState;
