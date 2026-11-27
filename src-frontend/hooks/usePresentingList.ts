import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { PresentingProcess } from "../types";

export interface PresentingListValue {
  items: PresentingProcess[];
  loading: boolean;
  error: string | null;
  /** Re-query `list_presenting_processes` (e.g. F5 on the Gaming view, opening the target picker). */
  refresh: () => Promise<void>;
}

/**
 * Apps presenting frames right now (CONTRACT §1.6.6 presentingList). Fetches when `active` turns true
 * (picker opened) and on `refresh()`; never polls. `[]` while capture is off.
 */
export function usePresentingList(active: boolean): PresentingListValue {
  const [items, setItems] = useState<PresentingProcess[]>([]);
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

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const list = await api.listPresentingProcesses();
      if (!alive.current || my !== seq.current) return;
      setItems(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      if (!alive.current || my !== seq.current) return;
      setError(errorMessage(err));
    } finally {
      if (alive.current && my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  return { items, loading, error, refresh };
}

export default usePresentingList;
