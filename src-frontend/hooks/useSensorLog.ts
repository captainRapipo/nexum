import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, errorMessage, subscribe as subscribeEvent } from "../lib/api";
import { DEFAULT_SETTINGS, EVENTS, type SensorLogStatus } from "../types";

/** Status before the backend answers (CONTRACT §2.9 initial status). `folder` is filled by the backend. */
export const SENSOR_LOG_IDLE: SensorLogStatus = {
  active: false,
  path: null,
  folder: "",
  rows: 0,
  totalRows: 0,
  startedTs: null,
  intervalMs: DEFAULT_SETTINGS.sensorLogIntervalMs,
  sensorCount: 0,
  error: null,
};

/* Module-level store: one query + one `sensor-log` listener shared by every consumer. */

let status: SensorLogStatus = SENSOR_LOG_IDLE;
const listeners = new Set<() => void>();
let started = false;
let gotEvent = false;

function publish(next: unknown): void {
  if (!next || typeof next !== "object") return;
  status = { ...SENSOR_LOG_IDLE, ...(next as Partial<SensorLogStatus>) };
  listeners.forEach((l) => l());
}

function start(): void {
  if (started) return;
  started = true;
  subscribeEvent<SensorLogStatus>(EVENTS.sensorLog, (s) => {
    gotEvent = true;
    publish(s);
  });
  api
    .getSensorLogStatus()
    .then((s) => {
      if (!gotEvent) publish(s);
    })
    .catch((err) => console.warn("[nexum] get_sensor_log_status failed:", errorMessage(err)));
}

function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => status;

export interface SensorLogValue {
  status: SensorLogStatus;
  /** Rejects with the backend message ("A sensor log is already running", "No sensors to log", …). */
  start: (opts?: { intervalMs?: number; ids?: string[] | null }) => Promise<void>;
  stop: () => Promise<void>;
  /** Opens `<Documents>\Nexum\Logs` in Explorer. */
  openFolder: () => Promise<void>;
}

/** CSV sensor log (CONTRACT §2.9, §4.4). */
export function useSensorLog(): SensorLogValue {
  useEffect(start, []);
  const s = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);

  const startLog = useCallback(async (opts?: { intervalMs?: number; ids?: string[] | null }) => {
    publish(await api.startSensorLog(opts));
  }, []);

  const stop = useCallback(async () => {
    publish(await api.stopSensorLog());
  }, []);

  const openFolder = useCallback(async () => {
    const folder = status.folder || (status.path ? status.path.replace(/[\\/][^\\/]*$/, "") : "");
    if (!folder) throw new Error("The log folder is not known yet.");
    await api.openExternal(folder);
  }, []);

  return { status: s, start: startLog, stop, openFolder };
}

export default useSensorLog;
