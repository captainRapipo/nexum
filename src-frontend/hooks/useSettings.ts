import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, onSettingsSaved } from "../lib/api";
import { DEFAULT_ALERT_SETTINGS, DEFAULT_SETTINGS, type Settings } from "../types";

export interface SettingsContextValue {
  settings: Settings;
  /** Merge `partial` into the current settings and persist via `save_settings`. Resolves to the saved settings. */
  update: (partial: Partial<Settings>) => Promise<Settings>;
  /** True once the persisted settings have been loaded from the backend. */
  loaded: boolean;
  error: string | null;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/**
 * Fill members an older core (or a partial object) may lack. [NEW 1.1] `alerts` is merged member by
 * member so a 1.0 settings file never leaves it undefined.
 */
export function normalizeSettings(s: Partial<Settings> | null | undefined): Settings {
  const raw = s && typeof s === "object" ? s : {};
  const alerts = raw.alerts && typeof raw.alerts === "object" ? raw.alerts : {};
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    alerts: { ...DEFAULT_ALERT_SETTINGS, ...alerts },
    fpsExcludes: Array.isArray(raw.fpsExcludes) ? raw.fpsExcludes : DEFAULT_SETTINGS.fpsExcludes,
    recycleMinAgeDays: raw.recycleMinAgeDays === undefined ? DEFAULT_SETTINGS.recycleMinAgeDays : raw.recycleMinAgeDays,
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Settings>(DEFAULT_SETTINGS);
  /** Saves in flight from update(): their optimistic state must not be overwritten by an older echo. */
  const pending = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const merged = normalizeSettings(s);
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

  // [NEW 1.1] Settings persisted by other commands (set_frame_capture, set_frame_window,
  // set_frame_excludes, dismiss_alert, start_sensor_log) are pushed here by lib/api.
  useEffect(
    () =>
      onSettingsSaved((s) => {
        if (pending.current > 0) return; // update() applies its own result
        const merged = normalizeSettings(s);
        current.current = merged;
        setSettings(merged);
      }),
    [],
  );

  const update = useCallback(async (partial: Partial<Settings>): Promise<Settings> => {
    const previous = current.current;
    const next: Settings = { ...previous, ...partial };
    // Optimistic: the UI reflects the change immediately.
    current.current = next;
    setSettings(next);
    pending.current++;
    try {
      const saved = normalizeSettings(await api.saveSettings(next));
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
    } finally {
      pending.current--;
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
