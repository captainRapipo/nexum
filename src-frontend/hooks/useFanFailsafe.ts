import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, errorMessage, subscribe as subscribeEvent } from "../lib/api";
import type { FanFailsafeState } from "../types";

/** Inactive state (also the value before the first query resolves). */
export const FAILSAFE_INACTIVE: FanFailsafeState = {
  active: false,
  kind: null,
  severity: null,
  fansAt100: false,
  message: "",
  sinceTs: null,
  dismissible: false,
};

/* Module-level store: one query + one event listener shared by every consumer (banner, health). */

let state: FanFailsafeState = FAILSAFE_INACTIVE;
const listeners = new Set<() => void>();
let started = false;
let gotEvent = false;

function publish(next: FanFailsafeState | null | undefined) {
  if (!next || typeof next !== "object") return;
  state = { ...FAILSAFE_INACTIVE, ...next };
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  subscribeEvent<FanFailsafeState>("fan-failsafe", (s) => {
    gotEvent = true;
    publish(s);
  });
  api
    .getFanFailsafeState()
    .then((s) => {
      // A pushed event is fresher than the initial query.
      if (!gotEvent) publish(s);
    })
    .catch((err) => console.warn("[nexum] get_fan_failsafe_state failed:", errorMessage(err)));
}

function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => state;

export interface FanFailsafeValue {
  state: FanFailsafeState;
  /** Clears a `previousBoot` notice (the backend rejects other kinds). */
  dismiss: () => Promise<void>;
}

export function useFanFailsafe(): FanFailsafeValue {
  useEffect(start, []);
  const s = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
  const dismiss = useCallback(async () => {
    const next = await api.dismissFanFailsafe();
    publish(next);
  }, []);
  return { state: s, dismiss };
}

export default useFanFailsafe;
