import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { sensorsUp } from "../lib/status";
import type { SystemSpec } from "../types";
import { useTelemetry } from "./useTelemetryStream";

export interface SystemSpecValue {
  spec: SystemSpec | null;
  loading: boolean;
  error: string | null;
  /** Re-query the agent (`get_system_spec { refresh: true }`), e.g. F5 in the System view. */
  refresh: () => Promise<void>;
}

interface SystemSpecContextValue extends SystemSpecValue {
  /** Load once (cached by Rust) when the first consumer mounts. */
  ensureLoaded: () => void;
}

const SystemSpecContext = createContext<SystemSpecContextValue | null>(null);

/**
 * Lazily fetches `get_system_spec` the first time a consumer mounts (WMI-heavy on the agent side;
 * Rust caches it). Re-fetches the cached value after an agent restart when the last answer had no
 * agent data.
 */
export function SystemSpecProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<SystemSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const requested = useRef(false);
  const { agent } = useTelemetry();

  const load = useCallback((refresh: boolean): Promise<void> => {
    if (inflight.current) return inflight.current;
    requested.current = true;
    setLoading(true);
    const run = api
      .getSystemSpec(refresh)
      .then((s) => {
        setSpec(s);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = run;
    return run;
  }, []);

  const ensureLoaded = useCallback(() => {
    if (!requested.current) void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  // Sensor reading came (back) up and our cached answer has none of its sections: ask again.
  const running = sensorsUp(agent);
  const prevRunning = useRef(running);
  useEffect(() => {
    const was = prevRunning.current;
    prevRunning.current = running;
    if (!was && running && requested.current && spec && spec.cpu == null && spec.board == null) void load(false);
  }, [running, spec, load]);

  const value = useMemo<SystemSpecContextValue>(
    () => ({ spec, loading, error, refresh, ensureLoaded }),
    [spec, loading, error, refresh, ensureLoaded],
  );
  return createElement(SystemSpecContext.Provider, { value }, children);
}

export function useSystemSpec(): SystemSpecValue {
  const ctx = useContext(SystemSpecContext);
  if (!ctx) throw new Error("useSystemSpec() must be used inside <SystemSpecProvider>");
  const { ensureLoaded } = ctx;
  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);
  return ctx;
}

export default useSystemSpec;

/** `refresh()` without triggering the initial load (App uses it for F5 on the System view). */
export function useSystemSpecRefresh(): () => Promise<void> {
  const ctx = useContext(SystemSpecContext);
  if (!ctx) throw new Error("useSystemSpecRefresh() must be used inside <SystemSpecProvider>");
  return ctx.refresh;
}
