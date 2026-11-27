import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { deriveHealth } from "../lib/status";
import type { SystemHealth } from "../types";
import { useFanFailsafe } from "./useFanFailsafe";
import { useNow } from "./useNow";
import { useSettings } from "./useSettings";
import { useSystemInfo } from "./useSystemInfo";
import { useTelemetry } from "./useTelemetryStream";

const HealthContext = createContext<SystemHealth | null>(null);

function useDerivedHealth(): SystemHealth {
  const { latest, history, agent } = useTelemetry();
  const { volumes, disks } = useSystemInfo();
  const { state: failsafe } = useFanFailsafe();
  const { settings } = useSettings();
  const now = useNow(1000);
  return useMemo(
    () =>
      deriveHealth({
        agent,
        latest,
        history,
        volumes,
        physical: disks,
        failsafe,
        pollIntervalMs: settings.pollIntervalMs,
        now,
      }),
    [agent, latest, history, volumes, disks, failsafe, settings.pollIntervalMs, now],
  );
}

/**
 * Computes SystemHealth once per second for the whole app, so the header pill, the Dashboard
 * Health alerts card and its banners always agree (single source, CONTRACT §5).
 */
export function HealthProvider({ children }: { children: ReactNode }) {
  const health = useDerivedHealth();
  return createElement(HealthContext.Provider, { value: health }, children);
}

/** Overall status + active conditions (CONTRACT §5). Must be used under <HealthProvider>. */
export function useHealth(): SystemHealth {
  const ctx = useContext(HealthContext);
  if (!ctx) throw new Error("useHealth() must be used inside <HealthProvider>");
  return ctx;
}

export default useHealth;
