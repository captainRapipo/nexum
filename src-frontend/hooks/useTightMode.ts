// Tight mode (CONTRACT §4.6.1): the viewport is at most 1399 px wide OR at most 899 px tall.
// Same rule as the `tight:` Tailwind variant. Use the CSS variant for styling; use this hook only
// where the DOM itself differs (S.M.A.R.T. sheet vs docked inspector, page actions, column sets).
// Created by the 1.2 foundation step so every view can build against it; owner: S (API frozen).
import { useSyncExternalStore } from "react";
import { TIGHT_MEDIA_QUERY } from "../types";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(TIGHT_MEDIA_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const mql = query();
  if (!mql) return () => undefined;
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const getSnapshot = (): boolean => query()?.matches ?? false;
const getServerSnapshot = (): boolean => false;

/** True while the window is in tight mode. Re-renders the caller only when the answer changes. */
export function useTightMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export default useTightMode;
