import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { TRASH_DETAILS_LIMIT, type TrashCategoryId, type TrashDetailItem } from "../types";

export interface TrashDetailsValue {
  items: TrashDetailItem[] | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Top-50 drill-down of one cleanup category (CONTRACT §3.3). Fetches while `categoryId` is non-null
 * (the "Show files" disclosure is open) and again when it or `recycleMinAgeDays` changes.
 * `recycleMinAgeDays` undefined → the backend uses the saved setting.
 */
export function useTrashDetails(categoryId: TrashCategoryId | null, recycleMinAgeDays?: number | null): TrashDetailsValue {
  const [items, setItems] = useState<TrashDetailItem[] | null>(null);
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

  const load = useCallback(async (id: TrashCategoryId | null, age: number | null | undefined) => {
    const my = ++seq.current;
    if (!id) {
      setItems(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await api.scanTrashDetails(id, TRASH_DETAILS_LIMIT, age);
      if (!alive.current || my !== seq.current) return;
      setItems(Array.isArray(list) ? list : []);
      setError(null);
    } catch (err) {
      if (!alive.current || my !== seq.current) return;
      setItems(null);
      setError(errorMessage(err));
    } finally {
      if (alive.current && my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(categoryId, recycleMinAgeDays);
  }, [categoryId, recycleMinAgeDays, load]);

  const reload = useCallback(() => load(categoryId, recycleMinAgeDays), [categoryId, recycleMinAgeDays, load]);

  return { items, loading, error, reload };
}

export default useTrashDetails;
