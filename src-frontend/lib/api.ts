// Typed bridge to the Rust core (CONTRACT §2). When running outside Tauri
// (plain `vite dev` in a browser) every call is served by ./mock.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentStatus,
  DriverBackupResult,
  DriverInfo,
  FanFailsafeState,
  FanPreset,
  PhysicalDisk,
  PurgeResult,
  SensorTree,
  Settings,
  SystemInfo,
  SystemSpec,
  TrashCategoryId,
  TrashScan,
  Volume,
} from "../types";

export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type MockModule = typeof import("./mock");
type MockBackend = MockModule["mockBackend"];

let mockModule: Promise<MockModule> | null = null;
function loadMock(): Promise<MockModule> {
  if (!mockModule) mockModule = import("./mock");
  return mockModule;
}

/** Normalise anything thrown by invoke / mock into a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function call<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  viaMock: (m: MockBackend) => Promise<T>,
): Promise<T> {
  try {
    if (isTauri) return await invoke<T>(cmd, args);
    const m = await loadMock();
    return await viaMock(m.mockBackend);
  } catch (err) {
    // Rust commands reject with a plain string; always surface an Error.
    throw err instanceof Error ? err : new Error(errorMessage(err));
  }
}

export const api = {
  getSystemInfo: () => call<SystemInfo>("get_system_info", undefined, (m) => m.getSystemInfo()),

  getDrivers: () => call<DriverInfo[]>("get_drivers", undefined, (m) => m.getDrivers()),

  getVolumes: () => call<Volume[]>("get_volumes", undefined, (m) => m.getVolumes()),

  getPhysicalDisks: () => call<PhysicalDisk[]>("get_physical_disks", undefined, (m) => m.getPhysicalDisks()),

  scanTrash: (includeBrowser: boolean) =>
    call<TrashScan>("scan_trash", { includeBrowser }, (m) => m.scanTrash(includeBrowser)),

  /** [BREAKING 1.0.0-gate] no flushStandby argument. */
  purgeTrash: (categories: readonly TrashCategoryId[]) =>
    call<PurgeResult>("purge_trash", { categories: [...categories] }, (m) => m.purgeTrash([...categories])),

  exportDrivers: (format: "json" | "csv") =>
    call<string>("export_drivers", { format }, (m) => m.exportDrivers(format)),

  backupDrivers: () => call<DriverBackupResult>("backup_drivers", undefined, (m) => m.backupDrivers()),

  setPollInterval: (ms: number) => {
    const v = Math.round(ms);
    return call<void>("set_poll_interval", { ms: v }, (m) => m.setPollInterval(v));
  },

  setFanPreset: (preset: FanPreset) =>
    call<void>("set_fan_preset", { preset }, (m) => m.setFanPreset(preset)),

  setFanControl: (id: string, pct: number) => {
    const v = Math.round(Math.min(100, Math.max(0, pct)));
    return call<void>("set_fan_control", { id, pct: v }, (m) => m.setFanControl(id, v));
  },

  getSettings: () => call<Settings>("get_settings", undefined, (m) => m.getSettings()),

  saveSettings: (settings: Settings) =>
    call<Settings>("save_settings", { settings }, (m) => m.saveSettings(settings)),

  getAgentStatus: () => call<AgentStatus>("get_agent_status", undefined, (m) => m.getAgentStatus()),

  restartAgent: () => call<void>("restart_agent", undefined, (m) => m.restartAgent()),

  openExternal: (target: string) =>
    call<void>("open_external", { target }, (m) => m.openExternal(target)),

  /** [NEW] Cached LHM sensor tree, or null when the agent is down / did not answer within 5 s. */
  getSensorTree: () => call<SensorTree | null>("get_sensor_tree", undefined, (m) => m.getSensorTree()),

  /** [NEW] Prefer `useSensorStream(active)` (ref-counted) over calling this directly. */
  setSensorStream: (on: boolean) => call<void>("set_sensor_stream", { on }, (m) => m.setSensorStream(on)),

  /** [NEW] Reset session min/max/avg; `null` = every sensor. */
  resetSensorStats: (ids: string[] | null) =>
    call<void>("reset_sensor_stats", { ids: ids == null ? null : [...ids] }, (m) => m.resetSensorStats(ids)),

  /** [NEW] Cached system spec; `refresh: true` re-queries the agent (F5 in the System view). */
  getSystemSpec: (refresh = false) =>
    call<SystemSpec>("get_system_spec", { refresh }, (m) => m.getSystemSpec(refresh)),

  /** [NEW] */
  getFanFailsafeState: () => call<FanFailsafeState>("get_fan_failsafe_state", undefined, (m) => m.getFanFailsafeState()),

  /** [NEW] Clears only kind "previousBoot"; rejects otherwise. */
  dismissFanFailsafe: () => call<FanFailsafeState>("dismiss_fan_failsafe", undefined, (m) => m.dismissFanFailsafe()),

  /** [NEW] Relaunch elevated (UAC) and exit this instance. Rejects if already admin or UAC is cancelled. */
  restartAsAdmin: () => call<void>("restart_as_admin", undefined, (m) => m.restartAsAdmin()),

  /** [NEW] Opens Windows Reliability Monitor (perfmon /rel). */
  openReliabilityMonitor: () =>
    call<void>("open_reliability_monitor", undefined, (m) => m.openReliabilityMonitor()),

  /** App version (Tauri app metadata when native, package.json version otherwise). */
  getAppVersion: async (): Promise<string> => {
    if (!isTauri) return __NEXUM_VERSION__;
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch {
      return __NEXUM_VERSION__;
    }
  },
};

export type Api = typeof api;

/**
 * Subscribe to a backend event. Resolves to an unsubscribe function.
 * Tauri: `listen()` from @tauri-apps/api/event. Browser: in-memory mock emitter.
 */
export async function onEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (isTauri) {
    const unlisten = await listen<T>(name, (event) => cb(event.payload));
    return () => {
      try {
        unlisten();
      } catch {
        // Window already torn down; nothing to clean up.
      }
    };
  }
  const m = await loadMock();
  return m.mockListen(name, (payload) => cb(payload as T));
}

/**
 * Synchronous-cleanup wrapper around `onEvent`, safe to return straight from
 * `useEffect` (handles unmount before the async listen resolves).
 */
export function subscribe<T>(name: string, cb: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  onEvent<T>(name, cb)
    .then((u) => {
      if (disposed) u();
      else unlisten = u;
    })
    .catch((err) => {
      console.warn(`[nexum] failed to subscribe to "${name}":`, errorMessage(err));
    });
  return () => {
    disposed = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

/** Official PawnIO site (MF-2/MF-3). The only outbound action is handing this URL to the browser. */
export const PAWNIO_URL = "https://pawnio.eu/";
