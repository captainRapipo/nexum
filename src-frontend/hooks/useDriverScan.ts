import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import type { DriverInfo } from "../types";

export interface DriverCounts {
  total: number;
  ok: number;
  outdated: number;
  unsigned: number;
}

export interface DriverScanContextValue {
  drivers: DriverInfo[];
  loading: boolean;
  error: string | null;
  lastScan: Date | null;
  /** Re-run the full driver audit. Concurrent calls share one request. */
  rescan: () => Promise<void>;
  counts: DriverCounts;
}

const DriverScanContext = createContext<DriverScanContextValue | null>(null);

export function DriverScanProvider({ children }: { children: ReactNode }) {
  const [drivers, setDrivers] = useState<DriverInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const rescan = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    setLoading(true);
    setError(null);
    const run = api
      .getDrivers()
      .then((list) => {
        setDrivers(Array.isArray(list) ? list : []);
        setLastScan(new Date());
      })
      .catch((err) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const counts = useMemo<DriverCounts>(() => {
    let ok = 0;
    let outdated = 0;
    let unsigned = 0;
    for (const d of drivers) {
      if (d.status === "unsigned") unsigned++;
      else if (d.status === "outdated") outdated++;
      else ok++;
    }
    return { total: drivers.length, ok, outdated, unsigned };
  }, [drivers]);

  const value = useMemo<DriverScanContextValue>(
    () => ({ drivers, loading, error, lastScan, rescan, counts }),
    [drivers, loading, error, lastScan, rescan, counts],
  );

  return createElement(DriverScanContext.Provider, { value }, children);
}

export function useDriverScan(): DriverScanContextValue {
  const ctx = useContext(DriverScanContext);
  if (!ctx) throw new Error("useDriverScan() must be used inside <DriverScanProvider>");
  return ctx;
}
