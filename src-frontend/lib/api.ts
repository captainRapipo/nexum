// Typed bridge to the Rust core (CONTRACT §2). When running outside Tauri
// (plain `vite dev` in a browser) every call is served by ./mock.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentStatus,
  DriveHistory,
  DriverBackupResult,
  DriverInfo,
  FanFailsafeState,
  FanPreset,
  FrameState,
  HealthAlertsSnapshot,
  PhysicalDisk,
  PresentingProcess,
  PurgeResult,
  ReportFormat,
  SensorLogStatus,
  SensorTree,
  Settings,
  SystemInfo,
  SystemSpec,
  TrashCategoryId,
  TrashDetailItem,
  TrashScan,
  TuningProbeSummary,
  TuningState,
  Volume,
} from "../types";
import { TRASH_DETAILS_LIMIT } from "../types";

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

/* ------------------------------------------------------------------ */
/* Settings saved by commands other than save_settings                 */
/* ------------------------------------------------------------------ */

type SettingsListener = (s: Settings) => void;
const settingsListeners = new Set<SettingsListener>();

/**
 * Subscribe to the Settings returned by any command that persists them (save_settings, set_frame_*,
 * dismiss_alert, …). SettingsProvider uses it so its state never lags behind the backend, whoever
 * called the command. Returns an unsubscribe function.
 */
export function onSettingsSaved(cb: SettingsListener): () => void {
  settingsListeners.add(cb);
  return () => {
    settingsListeners.delete(cb);
  };
}

function publishSettings(s: Settings): Settings {
  if (s && typeof s === "object") {
    for (const l of [...settingsListeners]) {
      try {
        l(s);
      } catch (err) {
        console.warn("[nexum] settings listener threw:", errorMessage(err));
      }
    }
  }
  return s;
}

/** Adds `recycleMinAgeDays` only when the caller gave one (absent → the backend uses the saved setting). */
function withRecycleAge(args: Record<string, unknown>, recycleMinAgeDays: number | null | undefined): Record<string, unknown> {
  return recycleMinAgeDays === undefined ? args : { ...args, recycleMinAgeDays };
}

/** Exact Rust error for a write probe (CONTRACT §2.14). Also enforced here, so `write:true` is never sent. */
export const WRITE_PROBE_UNAVAILABLE = "The write probe is not available in this version.";

export const api = {
  getSystemInfo: () => call<SystemInfo>("get_system_info", undefined, (m) => m.getSystemInfo()),

  getDrivers: () => call<DriverInfo[]>("get_drivers", undefined, (m) => m.getDrivers()),

  getVolumes: () => call<Volume[]>("get_volumes", undefined, (m) => m.getVolumes()),

  getPhysicalDisks: () => call<PhysicalDisk[]>("get_physical_disks", undefined, (m) => m.getPhysicalDisks()),

  /**
   * [CHANGED 1.1] `recycleMinAgeDays`: omitted → the backend uses Settings.recycleMinAgeDays;
   * `null` → every Recycle Bin item; a number → only items deleted more than that many days ago (CONTRACT §3.2).
   */
  scanTrash: (includeBrowser: boolean, recycleMinAgeDays?: number | null) =>
    call<TrashScan>("scan_trash", withRecycleAge({ includeBrowser }, recycleMinAgeDays), (m) =>
      m.scanTrash(includeBrowser, recycleMinAgeDays),
    ),

  /** [BREAKING 1.0.0-gate] no flushStandby argument. [CHANGED 1.1] optional `recycleMinAgeDays` (pass the value the scan used). */
  purgeTrash: (categories: readonly TrashCategoryId[], recycleMinAgeDays?: number | null) =>
    call<PurgeResult>("purge_trash", withRecycleAge({ categories: [...categories] }, recycleMinAgeDays), (m) =>
      m.purgeTrash([...categories], recycleMinAgeDays),
    ),

  /** [NEW 1.1] The largest items a purge of that category would delete now (CONTRACT §3.3). `limit` 1..50. */
  scanTrashDetails: (categoryId: TrashCategoryId, limit: number = TRASH_DETAILS_LIMIT, recycleMinAgeDays?: number | null) => {
    const n = Math.round(Math.min(TRASH_DETAILS_LIMIT, Math.max(1, Number.isFinite(limit) ? limit : TRASH_DETAILS_LIMIT)));
    return call<TrashDetailItem[]>("scan_trash_details", withRecycleAge({ categoryId, limit: n }, recycleMinAgeDays), (m) =>
      m.scanTrashDetails(categoryId, n, recycleMinAgeDays),
    );
  },

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
    call<Settings>("save_settings", { settings }, (m) => m.saveSettings(settings)).then(publishSettings),

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

  /* ── [NEW 1.1] Frame capture (CONTRACT §2.13). Prefer useFrames(). ── */

  /** Cached session / target / stats (stats come with `frametimes: []`). */
  getFrameState: () => call<FrameState>("get_frame_state", undefined, (m) => m.getFrameState()),

  /** Saves `fpsCaptureEnabled` and starts/stops capture. Never waits for the session (follow `frame-session`). */
  setFrameCapture: (enabled: boolean) =>
    call<Settings>("set_frame_capture", { enabled }, (m) => m.setFrameCapture(enabled)).then(publishSettings),

  /** `null` = automatic (foreground app). Rejects with the agent's message, e.g. "That app is not presenting frames.". */
  setFrameTarget: (pid: number | null) => {
    const v = pid == null ? null : Math.round(pid);
    return call<void>("set_frame_target", { pid: v }, (m) => m.setFrameTarget(v));
  },

  /** Stats window in seconds (integer, clamped 5..120 by the backend). */
  setFrameWindow: (sec: number) => {
    const v = Math.round(sec);
    return call<Settings>("set_frame_window", { sec: v }, (m) => m.setFrameWindow(v)).then(publishSettings);
  },

  /** Replaces the user exclude list (sanitized by the backend, CONTRACT §2.13). */
  setFrameExcludes: (names: string[]) =>
    call<Settings>("set_frame_excludes", { names: [...names] }, (m) => m.setFrameExcludes([...names])).then(publishSettings),

  /** Apps presenting frames right now (`[]` while capture is off). */
  listPresentingProcesses: () =>
    call<PresentingProcess[]>("list_presenting_processes", undefined, (m) => m.listPresentingProcesses()),

  /* ── [NEW 1.1] CSV sensor log (CONTRACT §2.9). Prefer useSensorLog(). ── */

  /** `intervalMs` absent → Settings.sensorLogIntervalMs (a valid value given here is also saved); `ids` null/absent → default set. */
  startSensorLog: (opts?: { intervalMs?: number; ids?: string[] | null }) => {
    const args: Record<string, unknown> = {};
    const intervalMs = opts?.intervalMs != null ? Math.round(opts.intervalMs) : undefined;
    if (intervalMs !== undefined) args.intervalMs = intervalMs;
    if (opts?.ids !== undefined) args.ids = opts.ids == null ? null : [...opts.ids];
    const mockOpts = { intervalMs, ids: opts?.ids == null ? opts?.ids : [...opts.ids] };
    return call<SensorLogStatus>("start_sensor_log", args, (m) => m.startSensorLog(mockOpts)).then((status) => {
      // The backend saved the interval: pull the settings so every consumer agrees.
      if (intervalMs !== undefined) api.getSettings().then(publishSettings).catch(() => undefined);
      return status;
    });
  },

  stopSensorLog: () => call<SensorLogStatus>("stop_sensor_log", undefined, (m) => m.stopSensorLog()),

  getSensorLogStatus: () => call<SensorLogStatus>("get_sensor_log_status", undefined, (m) => m.getSensorLogStatus()),

  /* ── [NEW 1.1] Alerts, notifications, tray (CONTRACT §2.10) ── */

  getHealthAlerts: () => call<HealthAlertsSnapshot>("get_health_alerts", undefined, (m) => m.getHealthAlerts()),

  /** Appends `dismissKey` to Settings.dismissedAlerts (hides banners and notifications, never the pill or the card). */
  dismissAlert: (dismissKey: string) =>
    call<Settings>("dismiss_alert", { dismissKey }, (m) => m.dismissAlert(dismissKey)).then(publishSettings),

  /** Resolved pinned sensor ids for the tray tooltip (first 4 used). Mounted once via useTraySensorSync(). */
  setTraySensors: (ids: string[]) => call<void>("set_tray_sensors", { ids: [...ids] }, (m) => m.setTraySensors([...ids])),

  /* ── [NEW 1.1] Drive wear ledger (CONTRACT §2.11) ── */

  getDriveHistory: (serial: string) =>
    call<DriveHistory>("get_drive_history", { serial }, (m) => m.getDriveHistory(serial)),

  /* ── [NEW 1.1] System report (CONTRACT §2.12) ── */

  /** Writes `Documents\Nexum\Reports\nexum-report-<stamp>.<format>` and resolves to its absolute path. */
  saveReport: (format: ReportFormat) => call<string>("save_report", { format }, (m) => m.saveReport(format)),

  /* ── [NEW 1.1] GPU tuning, read-only (CONTRACT §2.14). Prefer useTuningState(). ── */

  /** Cached state, or a fresh `tuningGet` with `refresh: true`. Only while the GPU tuning tab is visible. */
  getTuningState: (refresh = false) =>
    call<TuningState | null>("get_tuning_state", { refresh }, (m) => m.getTuningState(refresh)),

  /** Read-only probe. The UI only ever passes `false`; `true` is rejected here (and by Rust) and never sent. */
  runTuningProbe: (write: boolean): Promise<TuningProbeSummary> => {
    if (write !== false) return Promise.reject(new Error(WRITE_PROBE_UNAVAILABLE));
    return call<TuningProbeSummary>("run_tuning_probe", { write: false }, (m) => m.runTuningProbe(false));
  },

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
