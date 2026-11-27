import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { DriveHistory } from "../types";

export interface DriveHistoryValue {
  history: DriveHistory | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Wear ledger + forecast of one drive (CONTRACT §2.11, §4.4). Fetches whenever `serial` changes;
 * a null/empty serial → `history: null` and no call.
 */
export function useDriveHistory(serial: string | null): DriveHistoryValue {
  const key = serial && serial.trim() ? serial : null;
  const [history, setHistory] = useState<DriveHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (s: string | null) => {
    const my = ++seq.current;
    if (!s) {
      setHistory(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const h = await api.getDriveHistory(s);
      if (!alive.current || my !== seq.current) return;
      setHistory(h);
      setError(null);
    } catch (err) {
      if (!alive.current || my !== seq.current) return;
      setHistory(null);
      setError(errorMessage(err));
    } finally {
      if (alive.current && my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A different drive: never show the previous drive's history while the new one loads.
    setHistory(null);
    void load(key);
  }, [key, load]);

  const reload = useCallback(() => load(key), [key, load]);

  return { history, loading, error, reload };
}

export default useDriveHistory;
