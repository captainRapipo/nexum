// Typed bridge to the Rust core (CONTRACT §2). When running outside Tauri
// (plain `vite dev` in a browser) every call is served by ./mock.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentStatus,
  DriverBackupResult,
  DriverInfo,
  FanPreset,
  PhysicalDisk,
  PurgeResult,
  Settings,
  SystemInfo,
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

  purgeTrash: (categories: readonly string[], flushStandby: boolean) =>
    call<PurgeResult>("purge_trash", { categories: [...categories], flushStandby }, (m) =>
      m.purgeTrash([...categories], flushStandby),
    ),

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

  flushStandby: () => call<void>("flush_standby", undefined, (m) => m.flushStandby()),

  getSettings: () => call<Settings>("get_settings", undefined, (m) => m.getSettings()),

  saveSettings: (settings: Settings) =>
    call<Settings>("save_settings", { settings }, (m) => m.saveSettings(settings)),

  getAgentStatus: () => call<AgentStatus>("get_agent_status", undefined, (m) => m.getAgentStatus()),

  restartAgent: () => call<void>("restart_agent", undefined, (m) => m.restartAgent()),

  openExternal: (target: string) =>
    call<void>("open_external", { target }, (m) => m.openExternal(target)),

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
