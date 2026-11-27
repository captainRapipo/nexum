import { useEffect, useRef } from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import { EVENTS, type AgentStatus } from "../types";
import { useSensorLabels } from "./useSensorLabels";

/**
 * Keeps Rust's tray-tooltip sensors in step with the resolved pinned sensors (CONTRACT §2.10.5, §4.4).
 * Mount once (App.tsx) in a component that renders nothing, because useSensorLabels() re-renders with
 * every sensor-values packet. Sends `set_tray_sensors` on mount and whenever the list changes.
 */
export function useTraySensorSync(): void {
  const { pinned } = useSensorLabels();
  const key = pinned.join("\n");
  const lastSent = useRef<string | null>(null);
  const latest = useRef(pinned);
  latest.current = pinned;

  useEffect(() => {
    if (lastSent.current === key) return;
    lastSent.current = key;
    api.setTraySensors(latest.current).catch((err) => {
      lastSent.current = null; // retry on the next change
      console.warn("[nexum] set_tray_sensors failed:", errorMessage(err));
    });
  }, [key]);

  // Rust keeps the list in memory for the app's lifetime (agent restarts do not clear it). A send that
  // failed (core not ready yet) is retried when the agent next reports in.
  useEffect(
    () =>
      subscribe<AgentStatus>(EVENTS.agentStatus, (s) => {
        if (s && typeof s === "object" && s.running && lastSent.current === null) {
          lastSent.current = latest.current.join("\n");
          api.setTraySensors(latest.current).catch(() => {
            lastSent.current = null;
          });
        }
      }),
    [],
  );
}

/** Renders nothing; isolates the per-tick re-renders of useSensorLabels() from the app shell. */
export function TraySensorSync(): null {
  useTraySensorSync();
  return null;
}

export default useTraySensorSync;
