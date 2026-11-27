import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, errorMessage, subscribe as subscribeEvent } from "../lib/api";
import { EMPTY_ALERTS_SNAPSHOT, EVENTS, type HealthAlertsSnapshot } from "../types";

/* Module-level store: one query + one event listener shared by every consumer (pill, card, banners). */

let snapshot: HealthAlertsSnapshot = EMPTY_ALERTS_SNAPSHOT;
const listeners = new Set<() => void>();
let started = false;
let gotEvent = false;

function normalize(raw: unknown): HealthAlertsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<HealthAlertsSnapshot>;
  return {
    ready: !!s.ready,
    evaluatedTs: typeof s.evaluatedTs === "number" ? s.evaluatedTs : null,
    alerts: Array.isArray(s.alerts) ? s.alerts : [],
    rules: Array.isArray(s.rules) ? s.rules : [],
    cpuLimit: s.cpuLimit && typeof s.cpuLimit === "object" ? s.cpuLimit : EMPTY_ALERTS_SNAPSHOT.cpuLimit,
  };
}

function publish(next: HealthAlertsSnapshot | null): void {
  if (!next) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

function start(): void {
  if (started) return;
  started = true;
  subscribeEvent<unknown>(EVENTS.healthAlerts, (raw) => {
    gotEvent = true;
    publish(normalize(raw));
  });
  api
    .getHealthAlerts()
    .then((s) => {
      // A pushed event is fresher than the initial query.
      if (!gotEvent) publish(normalize(s));
    })
    .catch((err) => console.warn("[nexum] get_health_alerts failed:", errorMessage(err)));
}

function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => snapshot;

export interface HealthAlertsValue {
  /** Rust alert engine state (CONTRACT §2.10); EMPTY_ALERTS_SNAPSHOT until the first answer. */
  snapshot: HealthAlertsSnapshot;
  /**
   * `dismiss_alert`: hides that key's Dashboard banner and its desktop notifications. Never removes the
   * alert from the snapshot, the pill or the card. The saved Settings reach useSettings() automatically.
   */
  dismiss: (dismissKey: string) => Promise<void>;
}

export function useHealthAlerts(): HealthAlertsValue {
  useEffect(start, []);
  const s = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
  const dismiss = useCallback(async (dismissKey: string) => {
    await api.dismissAlert(dismissKey);
  }, []);
  return { snapshot: s, dismiss };
}

export default useHealthAlerts;
