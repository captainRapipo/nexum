import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { DEFAULT_SETTINGS, type Settings } from "../types";

export interface SettingsContextValue {
  settings: Settings;
  /** Merge `partial` into the current settings and persist via `save_settings`. Resolves to the saved settings. */
  update: (partial: Partial<Settings>) => Promise<Settings>;
  /** True once the persisted settings have been loaded from the backend. */
  loaded: boolean;
  error: string | null;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const merged = { ...DEFAULT_SETTINGS, ...s };
        current.current = merged;
        setSettings(merged);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (partial: Partial<Settings>): Promise<Settings> => {
    const previous = current.current;
    const next: Settings = { ...previous, ...partial };
    // Optimistic: the UI reflects the change immediately.
    current.current = next;
    setSettings(next);
    try {
      const saved = { ...DEFAULT_SETTINGS, ...(await api.saveSettings(next)) };
      current.current = saved;
      setSettings(saved);
      setError(null);
      return saved;
    } catch (err) {
      current.current = previous;
      setSettings(previous);
      const message = errorMessage(err);
      setError(message);
      throw new Error(message);
    }
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, update, loaded, error }),
    [settings, update, loaded, error],
  );

  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings() must be used inside <SettingsProvider>");
  return ctx;
}
