import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import type { PhysicalDisk, SystemInfo, Volume } from "../types";

export interface SystemInfoContextValue {
  info: SystemInfo | null;
  volumes: Volume[];
  disks: PhysicalDisk[];
  loading: boolean;
  error: string | null;
  /** Epoch ms when `info` was fetched (baseline for live uptime: info.uptimeSecs + elapsed). */
  infoFetchedAt: number | null;
  /** Re-query system info, volumes and physical disks. Concurrent calls share one request. */
  refresh: () => Promise<void>;
}

const SystemInfoContext = createContext<SystemInfoContextValue | null>(null);

/** Volumes are cheap to query; keep free-space figures fresh in the background. */
const VOLUME_REFRESH_MS = 60_000;

export function SystemInfoProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [disks, setDisks] = useState<PhysicalDisk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [infoFetchedAt, setInfoFetchedAt] = useState<number | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    setLoading(true);
    const run = (async () => {
      const [infoRes, volRes, diskRes] = await Promise.allSettled([
        api.getSystemInfo(),
        api.getVolumes(),
        api.getPhysicalDisks(),
      ]);
      const errors: string[] = [];
      if (infoRes.status === "fulfilled") {
        setInfo(infoRes.value);
        setInfoFetchedAt(Date.now());
      } else errors.push(`System info: ${errorMessage(infoRes.reason)}`);
      if (volRes.status === "fulfilled") setVolumes(volRes.value);
      else errors.push(`Volumes: ${errorMessage(volRes.reason)}`);
      if (diskRes.status === "fulfilled") setDisks(diskRes.value);
      else errors.push(`Disks: ${errorMessage(diskRes.reason)}`);
      setError(errors.length > 0 ? errors.join(" · ") : null);
    })().finally(() => {
      inflight.current = null;
      setLoading(false);
    });
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.hidden) return;
      api
        .getVolumes()
        .then(setVolumes)
        .catch(() => {
          // Transient; the next full refresh reports errors.
        });
    }, VOLUME_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<SystemInfoContextValue>(
    () => ({ info, volumes, disks, loading, error, infoFetchedAt, refresh }),
    [info, volumes, disks, loading, error, infoFetchedAt, refresh],
  );

  return createElement(SystemInfoContext.Provider, { value }, children);
}

export function useSystemInfo(): SystemInfoContextValue {
  const ctx = useContext(SystemInfoContext);
  if (!ctx) throw new Error("useSystemInfo() must be used inside <SystemInfoProvider>");
  return ctx;
}
