// Browser-preview backend (CONTRACT §4.3). Serves every Tauri command and event when !isTauri,
// so `vite dev` shows a live UI. Only loaded when !isTauri. Generic hostnames and fake serials only.
//
// Profiles (URL query):
//   (default)        WORKSTATION-01 — Ryzen 9 7950X / ASUS X670E (Nuvoton NCT6799D) / RTX 4080 / 3 healthy drives
//   ?rig=owner       WORKSTATION-02 — Ryzen 7 5700X3D / Gigabyte B550 GAMING X (ITE IT8688E, LHM board labels,
//                    3 live fans + 2 headers at 0 RPM) / 32 GB DDR4-3600 / Radeon RX 9070 XT /
//                    44 % NVMe system drive (→ attention "Worn") + Crucial P2 + Seagate HDD
//   &labels=generic  Super I/O sensors keep generic names (TMPINn / VINn / FANINn), as on an unrecognised board
//   ?admin=0         not elevated: CPU temp/power/clock null, no motherboard sensors or fans, SMART unknown,
//                    admin-only cleanup categories unavailable, limitedReasons ["notElevated"]
//   ?pawnio=missing  elevated, PawnIO not installed (pawnIoMissing); ?pawnio=outdated → 2.0.1 (pawnIoOutdated)
//   ?failsafe=interrupted|agentLost|previousBoot   fan fail-safe banner states (§1.5, §2.4)
//   ?mock=limited,hot,noagent,failing,usb
//     limited  = admin=0 · hot = CPU + GPU near their limits · noagent = same as ?sensors=failed (startFailed)
//     failing  = second NVMe reports a critical warning · usb = adds a USB stick without S.M.A.R.T.
//   [NEW 1.1]
//   ?fps=on          frame capture starts enabled (with ?rig=owner a game "Game.exe" is running)
//   ?fps=error       frame capture fails its PresentMon signature check (session error)
//   ?alerts=hot      Rust alert engine also reports a cpu-temp crit and a gpu-temp:0 warn
//   ?gpu=nvidia      owner rig without an AMD GPU for the tuning panel (supported:false, noAmdGpu)
//   [NEW 1.2]
//   ?sensors=failed  sensor reading could not be brought back (phase "failed", failReason "crashed"): the one
//                    "Nexum can't read sensors right now." banner, "—" everywhere. Alias: ?sensors=down
//   ?sensors=blocked the same with failReason "blocked" (Windows security)
//   ?sensors=starting  stays in phase "starting": no banner, pill "Checking", "—" everywhere
//                    "Try again" goes starting → back to failed after 1.5 s while one of these is set.
//   ?update=ask      Settings.updateCheck starts at "ask": the first-run update question is shown
//   ?update=available  an update (1.3.0, sample notes) is on offer; Install walks downloading → ready → installing
//   ?update=downloading | error | disabled   the dialog / Settings states of CONTRACT §2.15.7
//   (default: updateCheck "manual", build channel "preview", state idle, so screenshots show no question)

import type {
  AgentAck,
  AgentStatus,
  AlertSettings,
  CpuLimitInfo,
  DiskLink,
  DiskTelemetry,
  DriveHealth,
  DriveHistory,
  DriveHistoryPoint,
  DriverBackupResult,
  DriverCategory,
  DriverInfo,
  FanFailsafeKind,
  FanFailsafeState,
  FanOverrideReason,
  FanPreset,
  FanSafety,
  FanTelemetry,
  FrameSession,
  FrameSessionCode,
  FrameSignature,
  FrameState,
  FrameStats,
  FrameTarget,
  GpuSpec,
  GpuTelemetry,
  HardwareKind,
  HardwareNode,
  HealthAlert,
  HealthAlertsSnapshot,
  LimitedReason,
  MemorySpec,
  PhysicalDisk,
  PresentingProcess,
  PurgeCategoryResult,
  PurgeProgress,
  PurgeResult,
  ReportFormat,
  SelfUsage,
  SensorDriverStatus,
  SensorFailReason,
  SensorKind,
  SensorLogStatus,
  SensorMeta,
  SensorServicePhase,
  SensorTree,
  SensorUnit,
  SensorValues,
  Settings,
  SpdInfo,
  SystemInfo,
  SystemSpec,
  TelemetryPacket,
  TrashCategory,
  TrashCategoryId,
  TrashDetailItem,
  TrashScan,
  TuningProbeSummary,
  TuningState,
  UpdateChannel,
  UpdateErrorCode,
  UpdateState,
  Volume,
} from "../types";
import {
  AGENT_PROTOCOL,
  CPU_DEFAULT_LIMIT_C,
  CPU_TJMAX_TABLE,
  DEFAULT_ALERT_SETTINGS,
  DEFAULT_SETTINGS,
  EVENTS,
  FIXED_FRAME_EXCLUDES,
  FPS_EXCLUDE_PATTERN,
  FPS_EXCLUDES_MAX,
  GPU_EDGE_CRIT_C,
  GPU_EDGE_WARN_C,
  GPU_HOTSPOT_CRIT_DEFAULT_C,
  GPU_MEM_JUNCTION_CRIT_DEFAULT_C,
  INITIAL_UPDATE_STATE,
  RECYCLE_AGE_OPTIONS,
  SENSOR_LOG_INTERVALS_MS,
  TRASH_DETAILS_LIMIT,
  UPDATE_ERROR_TEXT,
  UPDATE_NOTES_MAX_CHARS,
} from "../types";
import { driveDisplayName, joinDisks, normSerial } from "./disks";
import { fmtBytes } from "./format";
import { driveDetailSentence } from "./status";
import { computeForecast, computeFrameStats, evaluateSustained, newSustainState, type SimFrame, type SustainState } from "./mockSim";

/* ------------------------------------------------------------------ */
/* Scenario flags                                                      */
/* ------------------------------------------------------------------ */

function readScenario(): Set<string> {
  try {
    const raw = new URLSearchParams(window.location.search).get("mock") ?? "";
    return new Set(
      raw
        .split(/[,+\s]+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    );
  } catch {
    return new Set();
  }
}

function readParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

const SCENARIO = readScenario();
/** ?rig=owner → the reference rig (generic hostname WORKSTATION-02). */
const OWNER = (readParam("rig") ?? "").toLowerCase() === "owner";
/** ?admin=0 (or ?mock=limited) → agent and core not elevated. */
const ADMIN0 = readParam("admin") === "0" || SCENARIO.has("limited");
const PAWNIO_PARAM = (readParam("pawnio") ?? "").toLowerCase();
const PAWNIO_STATE: "ok" | "missing" | "outdated" =
  PAWNIO_PARAM === "missing" ? "missing" : PAWNIO_PARAM === "outdated" ? "outdated" : "ok";
/** No ring-0 access: CPU MSR/SMU sensors, Super I/O and SPD are unavailable. */
const NO_RING0 = ADMIN0 || PAWNIO_STATE !== "ok";
const HOT = SCENARIO.has("hot");
/**
 * [NEW 1.2] ?sensors=failed|down|blocked|starting (and the older ?mock=noagent): the sensor service never
 * comes up in this session. `phase` is what Rust reports once its automatic restarts are over (§2.3.1).
 */
const SENSORS_PARAM = (readParam("sensors") ?? "").toLowerCase();
const SENSORS_DOWN: { phase: "failed" | "starting"; reason: SensorFailReason | null } | null =
  SENSORS_PARAM === "failed" || SENSORS_PARAM === "down"
    ? { phase: "failed", reason: "crashed" }
    : SENSORS_PARAM === "blocked"
      ? { phase: "failed", reason: "blocked" }
      : SENSORS_PARAM === "starting"
        ? { phase: "starting", reason: null }
        : SCENARIO.has("noagent")
          ? { phase: "failed", reason: "startFailed" }
          : null;
const NO_AGENT = SENSORS_DOWN != null;
/** [NEW 1.2] ?update=ask|available|downloading|error|disabled (CONTRACT §2.15.7). */
const UPDATE_PARAM = (readParam("update") ?? "").toLowerCase();
const DRIVE_FAIL = SCENARIO.has("failing");
const WITH_USB = SCENARIO.has("usb");
const GENERIC_LABELS = (readParam("labels") ?? "").toLowerCase() === "generic";
/** [NEW 1.1] ?fps=on → capture starts enabled; ?fps=error → signature check fails. */
const FPS_PARAM = (readParam("fps") ?? "").toLowerCase();
/** [NEW 1.1] ?alerts=hot → forced cpu-temp crit + gpu-temp:0 warn in the Rust alert snapshot. */
const ALERTS_HOT = (readParam("alerts") ?? "").toLowerCase() === "hot";
/** [NEW 1.1] ?gpu=nvidia → no AMD GPU for the tuning panel. */
const GPU_PARAM = (readParam("gpu") ?? "").toLowerCase();
const FAILSAFE_PARAM: FanFailsafeKind | null = (() => {
  const v = (readParam("failsafe") ?? "").toLowerCase();
  if (v === "interrupted") return "interrupted";
  if (v === "agentlost") return "agentLost";
  if (v === "previousboot") return "previousBoot";
  return null;
})();

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clampN = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const nn = <T>(v: T | null | undefined): v is T => v != null;

/** Standard normal sample (Box–Muller). */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** First-order lag toward `target` with time constant `tau` seconds. */
const lag = (current: number, target: number, dt: number, tau: number) =>
  current + (target - current) * (1 - Math.exp(-dt / tau));

/** Linear map of t from [t0,t1] onto [v0,v1], clamped. */
const curve = (t: number, t0: number, t1: number, v0: number, v1: number) =>
  clampN(v0 + ((t - t0) / (t1 - t0)) * (v1 - v0), Math.min(v0, v1), Math.max(v0, v1));

/** Deterministic PRNG so the driver inventory is stable between calls. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const fmtN = (n: number) => Math.round(n).toLocaleString("en-US");

/* ------------------------------------------------------------------ */
/* In-memory event bus                                                 */
/* ------------------------------------------------------------------ */

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(name: string, payload: unknown): void {
  const set = handlers.get(name);
  if (!set || set.size === 0) return;
  for (const h of [...set]) {
    try {
      h(payload);
    } catch (err) {
      console.error(`[nexum mock] listener for "${name}" threw`, err);
    }
  }
}

/** Subscribe to a mock event; returns an unsubscribe function. */
export function mockListen(name: string, handler: Handler): () => void {
  boot();
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(handler);
  return () => {
    handlers.get(name)?.delete(handler);
  };
}

/* ------------------------------------------------------------------ */
/* Settings (persisted in localStorage for the preview; mirrors the    */
/* Rust sanitisation of CONTRACT §2.2)                                 */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = "nexum.mock.settings";

function dedupe(list: unknown, max: number, keepLast = false): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  return keepLast ? out.slice(-max) : out.slice(0, max);
}

function sanitizeSettings(input: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const poll =
    typeof input.pollIntervalMs === "number" && Number.isFinite(input.pollIntervalMs)
      ? Math.round(clampN(input.pollIntervalMs, 250, 10_000))
      : d.pollIntervalMs;

  const labels: Record<string, string> = {};
  if (input.sensorLabels && typeof input.sensorLabels === "object") {
    for (const [k, v] of Object.entries(input.sensorLabels)) {
      if (Object.keys(labels).length >= 2000) break;
      if (typeof v !== "string") continue;
      const t = v.trim().slice(0, 64);
      if (t) labels[k] = t;
    }
  }
  const labelMeta: Settings["sensorLabelMeta"] = {};
  if (input.sensorLabelMeta && typeof input.sensorLabelMeta === "object") {
    for (const [k, v] of Object.entries(input.sensorLabelMeta)) {
      if (!labels[k] || !v || typeof v !== "object") continue;
      labelMeta[k] = { defaultName: String(v.defaultName ?? ""), hardwareName: String(v.hardwareName ?? "") };
    }
  }
  const choice = input.sensorDriverChoice;
  const fpsWindow =
    typeof input.fpsWindowSec === "number" && Number.isFinite(input.fpsWindowSec)
      ? Math.round(clampN(input.fpsWindowSec, 5, 120))
      : d.fpsWindowSec;
  const logMs = SENSOR_LOG_INTERVALS_MS.includes(input.sensorLogIntervalMs as number)
    ? (input.sensorLogIntervalMs as number)
    : d.sensorLogIntervalMs;
  const recycle =
    input.recycleMinAgeDays === null
      ? null
      : RECYCLE_AGE_OPTIONS.includes(input.recycleMinAgeDays as number)
        ? (input.recycleMinAgeDays as number)
        : d.recycleMinAgeDays;
  return {
    launchOnStartup: bool(input.launchOnStartup, d.launchOnStartup),
    minimizeToTray: bool(input.minimizeToTray, d.minimizeToTray),
    pollIntervalMs: poll,
    includeBrowserCaches: bool(input.includeBrowserCaches, d.includeBrowserCaches),
    confirmBeforePurge: bool(input.confirmBeforePurge, d.confirmBeforePurge),
    tempUnit: input.tempUnit === "F" ? "F" : "C",
    startMinimized: bool(input.startMinimized, d.startMinimized),
    sensorLabels: labels,
    sensorLabelMeta: labelMeta,
    hiddenSensors: dedupe(input.hiddenSensors, 2000),
    pinnedSensors: input.pinnedSensors == null ? null : dedupe(input.pinnedSensors, 12),
    hideUnusedSensors: bool(input.hideUnusedSensors, d.hideUnusedSensors),
    dismissedAlerts: dedupe(input.dismissedAlerts, 200, true),
    sensorDriverChoice: choice === "pawnio" || choice === "none" || choice === "undecided" ? choice : "undecided",
    fpsCaptureEnabled: bool(input.fpsCaptureEnabled, d.fpsCaptureEnabled),
    fpsWindowSec: fpsWindow,
    fpsExcludes: sanitizeExcludeList(input.fpsExcludes),
    sensorLogIntervalMs: logMs,
    alerts: sanitizeAlertSettings(input.alerts),
    recycleMinAgeDays: recycle,
    // [NEW 1.2] CONTRACT §2.2: unknown updateCheck → "ask", unknown channel → "default". (save_settings keeps
    // the stored lastUpdateCheckTs; mockBackend.saveSettings does the same after this.)
    updateCheck: input.updateCheck === "auto" || input.updateCheck === "manual" ? input.updateCheck : "ask",
    lastUpdateCheckTs:
      typeof input.lastUpdateCheckTs === "number" && Number.isFinite(input.lastUpdateCheckTs) ? input.lastUpdateCheckTs : null,
    updateChannel: input.updateChannel === "stable" || input.updateChannel === "preview" ? input.updateChannel : "default",
  };
}

/** Rust's set_frame_excludes sanitization (CONTRACT §2.13). */
function sanitizeExcludeList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const fixed = new Set(FIXED_FRAME_EXCLUDES.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const n = raw.trim();
    if (!FPS_EXCLUDE_PATTERN.test(n) || fixed.has(n.toLowerCase()) || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length >= FPS_EXCLUDES_MAX) break;
  }
  return out;
}

/** AlertSettings: each member on its own; missing/malformed → its default (CONTRACT §2.2). */
function sanitizeAlertSettings(raw: unknown): AlertSettings {
  const d = DEFAULT_ALERT_SETTINGS;
  const a = raw && typeof raw === "object" ? (raw as Partial<AlertSettings>) : {};
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const opt = (v: unknown, lo: number, hi: number) => (num(v) ? Math.round(clampN(v, lo, hi)) : null);
  return {
    desktopNotifications: typeof a.desktopNotifications === "boolean" ? a.desktopNotifications : d.desktopNotifications,
    cpuTempC: opt(a.cpuTempC, 60, 105),
    gpuHotspotC: opt(a.gpuHotspotC, 70, 115),
    gpuMemJunctionC: opt(a.gpuMemJunctionC, 70, 115),
    freeSpacePct: num(a.freeSpacePct) ? Math.round(clampN(a.freeSpacePct, 1, 50)) : d.freeSpacePct,
    sustainSec: num(a.sustainSec) ? Math.round(clampN(a.sustainSec, 10, 600)) : d.sustainSec,
  };
}

/**
 * [NEW 1.2] The preview never starts at updateCheck "ask" unless ?update=ask asks for it, so screenshots
 * never show the first-run update question (CONTRACT §2.15.7). The real default is "ask".
 */
function previewUpdateCheck(s: Settings): Settings {
  if (UPDATE_PARAM === "ask") return { ...s, updateCheck: "ask" };
  return s.updateCheck === "ask" ? { ...s, updateCheck: "manual" } : s;
}

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    // Old preview files may still carry flushStandbyOnPurge; sanitisation drops it.
    if (raw) return previewUpdateCheck(sanitizeSettings(JSON.parse(raw) as Partial<Settings>));
  } catch {
    // Storage unavailable or corrupt; fall back to defaults.
  }
  return previewUpdateCheck({ ...DEFAULT_SETTINGS });
}

function persistSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Non-fatal in preview mode.
  }
}

let settings: Settings = loadSettings();
// ?fps=on|error: the preview starts with capture enabled (not persisted until the user saves).
if (FPS_PARAM === "on" || FPS_PARAM === "error") settings = { ...settings, fpsCaptureEnabled: true };

/* ------------------------------------------------------------------ */
/* Hardware model                                                      */
/* ------------------------------------------------------------------ */

/** Simulation coefficients per rig. */
interface RigModel {
  hostname: string;
  cpuTelemetryName: string;
  cpuWmiName: string;
  cpuHwId: string;
  ccds: number;
  svi: "SVI2" | "SVI3";
  boardName: string;
  superIoName: string;
  superIoId: string;
  dgpuName: string;
  dgpuVendor: GpuTelemetry["vendor"];
  dgpuHwId: string;
  dgpuKind: HardwareKind;
  igpuName: string | null;
  cores: number;
  threads: number;
  ramTotalGb: number;
  ramSpeedMts: number;
  ramStartGb: number;
  ramBase: number;
  ramCpu: number;
  ramGpu: number;
  cpuIdleClockLo: number;
  cpuIdleClockSpan: number;
  cpuLoadClockBase: number;
  cpuLoadClockSlope: number;
  cpuClockMin: number;
  cpuClockMax: number;
  cpuVoltBase: number;
  cpuPowerBase: number;
  cpuPowerSlope: number;
  cpuTempBase: number;
  cpuTempSlope: number;
  gpuIdleClockLo: number;
  gpuIdleClockHi: number;
  gpuBoostBase: number;
  gpuBoostSlope: number;
  gpuMemIdle: number;
  gpuMemLoad: number;
  gpuVramTotal: number;
  gpuVramBase: number;
  gpuVramSlope: number;
  gpuTempBase: number;
  gpuTempSlope: number;
  gpuHotspotBase: number;
  gpuHotspotSlope: number;
  gpuPowerBase: number;
  gpuPowerSlope: number;
}

const DEFAULT_RIG: RigModel = {
  hostname: "WORKSTATION-01",
  cpuTelemetryName: "AMD Ryzen 9 7950X",
  cpuWmiName: "AMD Ryzen 9 7950X 16-Core Processor",
  cpuHwId: "/amdcpu/0",
  ccds: 2,
  svi: "SVI3",
  boardName: "ASUS ROG CROSSHAIR X670E HERO",
  superIoName: "Nuvoton NCT6799D",
  superIoId: "/lpc/nct6799d/0",
  dgpuName: "NVIDIA GeForce RTX 4080",
  dgpuVendor: "nvidia",
  dgpuHwId: "/gpu-nvidia/0",
  dgpuKind: "gpuNvidia",
  igpuName: "AMD Radeon(TM) Graphics",
  cores: 16,
  threads: 32,
  ramTotalGb: 63.6,
  ramSpeedMts: 6000,
  ramStartGb: 12.4,
  ramBase: 9.8,
  ramCpu: 15,
  ramGpu: 7.5,
  cpuIdleClockLo: 3800,
  cpuIdleClockSpan: 1700,
  cpuLoadClockBase: 5450,
  cpuLoadClockSlope: 3.6,
  cpuClockMin: 545,
  cpuClockMax: 5750,
  cpuVoltBase: 0.9,
  cpuPowerBase: 34,
  cpuPowerSlope: 1.65,
  cpuTempBase: 40,
  cpuTempSlope: 0.44,
  gpuIdleClockLo: 210,
  gpuIdleClockHi: 345,
  gpuBoostBase: 2520,
  gpuBoostSlope: 2.4,
  gpuMemIdle: 405,
  gpuMemLoad: 11201,
  gpuVramTotal: 16,
  gpuVramBase: 1.3,
  gpuVramSlope: 10.4,
  gpuTempBase: 33,
  gpuTempSlope: 0.37,
  gpuHotspotBase: 7.5,
  gpuHotspotSlope: 0.07,
  gpuPowerBase: 13,
  gpuPowerSlope: 2.95,
};

// Reference rig: Ryzen 7 5700X3D (8C/16T, 3.0 base / 4.1 boost, ~45 W pkg, ~58 °C),
// 2x16 GB DDR4-3600, Radeon RX 9070 XT 16 GB (zero-RPM idle).
const OWNER_RIG: RigModel = {
  hostname: "WORKSTATION-02",
  cpuTelemetryName: "AMD Ryzen 7 5700X3D",
  cpuWmiName: "AMD Ryzen 7 5700X3D 8-Core Processor",
  cpuHwId: "/amdcpu/0",
  ccds: 1,
  svi: "SVI2",
  boardName: "Gigabyte B550 GAMING X",
  superIoName: "ITE IT8688E",
  superIoId: "/lpc/it8688e/0",
  dgpuName: "AMD Radeon RX 9070 XT",
  dgpuVendor: "amd",
  dgpuHwId: "/gpu-amd/0",
  dgpuKind: "gpuAmd",
  igpuName: null, // Vermeer has no iGPU
  cores: 8,
  threads: 16,
  ramTotalGb: 31.9,
  ramSpeedMts: 3600,
  ramStartGb: 18.4,
  ramBase: 16.2,
  ramCpu: 6,
  ramGpu: 5,
  cpuIdleClockLo: 3550,
  cpuIdleClockSpan: 550,
  cpuLoadClockBase: 4070,
  cpuLoadClockSlope: 0.6,
  cpuClockMin: 550,
  cpuClockMax: 4100,
  cpuVoltBase: 0.83,
  cpuPowerBase: 30,
  cpuPowerSlope: 0.85,
  cpuTempBase: 50,
  cpuTempSlope: 0.32,
  gpuIdleClockLo: 30,
  gpuIdleClockHi: 420,
  gpuBoostBase: 2500,
  gpuBoostSlope: 4.5,
  gpuMemIdle: 96,
  gpuMemLoad: 2518,
  gpuVramTotal: 16,
  gpuVramBase: 1.1,
  gpuVramSlope: 11,
  gpuTempBase: 34,
  gpuTempSlope: 0.3,
  gpuHotspotBase: 9,
  gpuHotspotSlope: 0.14,
  gpuPowerBase: 11,
  gpuPowerSlope: 2.93,
};

const RIG: RigModel = OWNER ? OWNER_RIG : DEFAULT_RIG;

const CPU_TELEMETRY_NAME = RIG.cpuTelemetryName;
const CPU_WMI_NAME = RIG.cpuWmiName;
const DGPU_NAME = RIG.dgpuName;
const IGPU_NAME = DEFAULT_RIG.igpuName as string;
const CORES = RIG.cores;
const THREADS = RIG.threads;
const RAM_TOTAL_GB = RIG.ramTotalGb;
const IGPU_HW_ID = "/gpu-amd/1";

interface Profile {
  name: "idle" | "browsing" | "compiling" | "gaming" | "rendering" | "streaming";
  cpu: number;
  gpu: number;
  weight: number;
}

const PROFILES: Profile[] = [
  { name: "idle", cpu: 0.04, gpu: 0.02, weight: 2.5 },
  { name: "browsing", cpu: 0.11, gpu: 0.07, weight: 3 },
  { name: "compiling", cpu: 0.74, gpu: 0.04, weight: 1.4 },
  { name: "gaming", cpu: 0.34, gpu: 0.93, weight: 2.6 },
  { name: "rendering", cpu: 0.95, gpu: 0.3, weight: 1 },
  { name: "streaming", cpu: 0.27, gpu: 0.58, weight: 1.2 },
];

function pickProfile(current: Profile): Profile {
  const pool = PROFILES.filter((p) => p !== current);
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let x = Math.random() * total;
  for (const p of pool) {
    x -= p.weight;
    if (x <= 0) return p;
  }
  return pool[pool.length - 1];
}

/* ── Fans ──────────────────────────────────────────────────────────── */

interface FanSpec {
  /** Super I/O channel = index within the "fan" / "control" sensor types. */
  ch: number;
  name: string;
  genericName: string;
  maxRpm: number;
  minRpm: number;
  controllable: boolean;
  /** false = nothing plugged into the header (reads 0 RPM). */
  connected: boolean;
  kind: "cpu" | "pump" | "case";
}

// Reference rig: Gigabyte B550 GAMING X → ITE IT8688E with LHM's board labels. Three headers are
// populated (CPU Fan, System Fan #2, System Fan #3); System Fan #1 and CPU Optional Fan read 0 RPM.
// Calibrated so Auto (BIOS) at ~55 °C lands near CPU 1305, 1136 and 748 RPM.
const OWNER_FANS: FanSpec[] = [
  { ch: 0, name: "CPU Fan", genericName: "FANIN0", maxRpm: 2200, minRpm: 500, controllable: true, connected: true, kind: "cpu" },
  { ch: 1, name: "System Fan #1", genericName: "FANIN1", maxRpm: 0, minRpm: 0, controllable: true, connected: false, kind: "case" },
  { ch: 2, name: "System Fan #2", genericName: "FANIN2", maxRpm: 1900, minRpm: 450, controllable: true, connected: true, kind: "case" },
  { ch: 3, name: "System Fan #3", genericName: "FANIN3", maxRpm: 1250, minRpm: 300, controllable: true, connected: true, kind: "case" },
  { ch: 4, name: "CPU Optional Fan", genericName: "FANIN4", maxRpm: 0, minRpm: 0, controllable: true, connected: false, kind: "cpu" },
];

const DEFAULT_FANS: FanSpec[] = [
  { ch: 0, name: "CPU Fan", genericName: "FANIN0", maxRpm: 2100, minRpm: 380, controllable: true, connected: true, kind: "cpu" },
  { ch: 1, name: "AIO Pump", genericName: "FANIN1", maxRpm: 3050, minRpm: 1150, controllable: true, connected: true, kind: "pump" },
  { ch: 2, name: "Chassis Fan #1", genericName: "FANIN2", maxRpm: 1850, minRpm: 320, controllable: true, connected: true, kind: "case" },
  { ch: 3, name: "Chassis Fan #2", genericName: "FANIN3", maxRpm: 1850, minRpm: 320, controllable: true, connected: true, kind: "case" },
  { ch: 4, name: "Chassis Fan #3", genericName: "FANIN4", maxRpm: 1550, minRpm: 300, controllable: true, connected: true, kind: "case" },
  // DC-mode header: readable, not controllable (exercises the UI's read-only path).
  { ch: 5, name: "Chassis Fan #4", genericName: "FANIN5", maxRpm: 1550, minRpm: 300, controllable: false, connected: true, kind: "case" },
];
const FANS: FanSpec[] = OWNER ? OWNER_FANS : DEFAULT_FANS;
const fanName = (f: FanSpec) => (GENERIC_LABELS ? f.genericName : f.name);
const fanSensorId = (f: FanSpec) => `${RIG.superIoId}/fan/${f.ch}`;

/** GPU fans (listed in telemetry.fans with the GPU's hwId; read-only in the preview). */
const GPU_FAN_NAMES: string[] = OWNER ? ["GPU Fan"] : ["GPU Fan 1", "GPU Fan 2"];

const PRESET_DUTY: Record<"silent" | "balanced" | "turbo", number> = {
  silent: 30,
  balanced: 50,
  turbo: 100,
};

const PRESET_LABEL: Record<FanPreset, string> = {
  auto: "Auto (BIOS)",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

/* ── Disks ─────────────────────────────────────────────────────────── */

interface DiskSpec {
  id: string;
  name: string;
  diskNumber: number;
  /** Serial as the drive reports it (telemetry). null = not reported (exercises the disk-number join). */
  serial: string | null;
  nvme: boolean;
  baseTemp: number;
  /** Remaining life %, null for HDDs. */
  life: number | null;
  tbw: number | null;
  readTb: number | null;
  poh: number;
  usedPct: number;
  maxRead: number;
  maxWrite: number;
  role: "system" | "games" | "archive";
  criticalWarning: number | null;
  spare: number | null;
  spareThreshold: number | null;
  mediaErrors: number | null;
  unsafeShutdowns: number | null;
  powerCycles: number | null;
  errorLogEntries: number | null;
  warnTemp: number | null;
  critTemp: number | null;
  realloc: number | null;
  pending: number | null;
  uncorrectable: number | null;
}

const nvmeDisk = (d: Omit<DiskSpec, "nvme" | "realloc" | "pending" | "uncorrectable">): DiskSpec => ({
  ...d,
  nvme: true,
  realloc: null,
  pending: null,
  uncorrectable: null,
});

const hddDisk = (
  d: Omit<
    DiskSpec,
    "nvme" | "life" | "tbw" | "readTb" | "criticalWarning" | "spare" | "spareThreshold" | "mediaErrors" | "unsafeShutdowns" | "errorLogEntries" | "warnTemp" | "critTemp"
  >,
): DiskSpec => ({
  ...d,
  nvme: false,
  life: null,
  tbw: null,
  readTb: null,
  criticalWarning: null,
  spare: null,
  spareThreshold: null,
  mediaErrors: null,
  unsafeShutdowns: null,
  errorLogEntries: null,
  warnTemp: null,
  critTemp: null,
});

const DEFAULT_DISKS: DiskSpec[] = [
  nvmeDisk({ id: "/nvme/0", name: "Samsung SSD 990 PRO 2TB", diskNumber: 0, serial: "S73WNJ0W612345A", baseTemp: 37, life: 98, tbw: 18.42, readTb: 31.6, poh: 4210, usedPct: 61, maxRead: 2600, maxWrite: 1500, role: "system", criticalWarning: 0, spare: 100, spareThreshold: 10, mediaErrors: 0, unsafeShutdowns: 41, powerCycles: 702, errorLogEntries: 0, warnTemp: 82, critTemp: 85 }),
  nvmeDisk(
    DRIVE_FAIL
      ? { id: "/nvme/1", name: "WD_BLACK SN850X 1000GB", diskNumber: 1, serial: "23125L801234", baseTemp: 35, life: 8, tbw: 562.1, readTb: 640.2, poh: 2655, usedPct: 78, maxRead: 3600, maxWrite: 900, role: "games", criticalWarning: 0x04, spare: 6, spareThreshold: 10, mediaErrors: 14, unsafeShutdowns: 22, powerCycles: 488, errorLogEntries: 61, warnTemp: 80, critTemp: 84 }
      : { id: "/nvme/1", name: "WD_BLACK SN850X 1000GB", diskNumber: 1, serial: "23125L801234", baseTemp: 35, life: 100, tbw: 6.18, readTb: 12.9, poh: 2655, usedPct: 78, maxRead: 3600, maxWrite: 900, role: "games", criticalWarning: 0, spare: 100, spareThreshold: 10, mediaErrors: 0, unsafeShutdowns: 22, powerCycles: 488, errorLogEntries: 0, warnTemp: 80, critTemp: 84 },
  ),
  hddDisk({ id: "/hdd/0", name: "ST4000DM004-2CV104", diskNumber: 2, serial: "ZFN0A1B2", baseTemp: 33, poh: 11826, usedPct: 47, maxRead: 185, maxWrite: 160, role: "archive", powerCycles: 1240, realloc: 0, pending: 0, uncorrectable: 0 }),
];

// Reference rig. TBW values are estimates. The Crucial reports its serial with separators the
// Windows side does not (normSerial join); the HDD reports none (disk-number fallback join).
const OWNER_DISKS: DiskSpec[] = [
  nvmeDisk({ id: "/nvme/0", name: "addlink M.2 PCIE G3x4 NVMe", diskNumber: 0, serial: "20190A1B2C3D", baseTemp: 44, life: 44, tbw: 84.7, readTb: 61.2, poh: 20188, usedPct: 49, maxRead: 1700, maxWrite: 1000, role: "system", criticalWarning: 0, spare: 100, spareThreshold: 10, mediaErrors: 0, unsafeShutdowns: 187, powerCycles: 2411, errorLogEntries: 0, warnTemp: 75, critTemp: 80 }),
  nvmeDisk({ id: "/nvme/1", name: "CT1000P2SSD8", diskNumber: 1, serial: "2104_E1A2_B3C4.", baseTemp: 37, life: 95, tbw: 17.9, readTb: 24.4, poh: 15958, usedPct: 5.8, maxRead: 2300, maxWrite: 1800, role: "games", criticalWarning: 0, spare: 100, spareThreshold: 5, mediaErrors: 0, unsafeShutdowns: 96, powerCycles: 1404, errorLogEntries: 0, warnTemp: 70, critTemp: 85 }),
  hddDisk({ id: "/hdd/0", name: "ST1000DM010-2EP102", diskNumber: 2, serial: null, baseTemp: 33, poh: 13705, usedPct: 21.6, maxRead: 210, maxWrite: 190, role: "archive", powerCycles: 1862, realloc: 0, pending: 0, uncorrectable: 0 }),
];

const DISKS: DiskSpec[] = OWNER ? OWNER_DISKS : DEFAULT_DISKS;

/* ── Drive-health classifier (mirror of the sidecar's DriveHealth.Classify, CONTRACT §1.1.3) ── */

function classifyDisk(d: DiskSpec, poh: number | null): DriveHealth {
  if (ADMIN0) {
    return { state: "unknown", label: "Health unknown — run as administrator", reason: "S.M.A.R.T. needs administrator rights", source: "none" };
  }
  const source: DriveHealth["source"] = d.nvme ? "nvme" : "smart";
  const life = d.life;
  const cw = d.criticalWarning ?? 0;
  const lifeFrag = life != null ? `${fmtN(life)}% life left` : null;
  const usedFrag = d.nvme && life != null ? `${fmtN(100 - life)}% of rated endurance used` : null;
  const pohFrag = poh != null ? `${fmtN(poh)} power-on hours` : null;

  const failing: string[] = [];
  if (cw & 0x01) failing.push("NVMe critical warning: available spare below threshold");
  if (cw & 0x04) failing.push("NVMe critical warning: reliability degraded");
  if (cw & 0x08) failing.push("NVMe critical warning: drive is read-only");
  if (cw & 0x10) failing.push("NVMe critical warning: volatile memory backup failed");
  if (d.spare != null && d.spareThreshold != null && d.spareThreshold > 0 && d.spare < d.spareThreshold)
    failing.push(`available spare ${d.spare}% is below the ${d.spareThreshold}% threshold`);
  if (failing.length) return { state: "failing", label: "Failing", reason: failing.join(" · "), source };

  if (life != null && life <= 10)
    return { state: "replace", label: "Replace soon", reason: [lifeFrag, usedFrag, pohFrag].filter(nn).join(" · "), source };
  if (life != null && life <= 50)
    return { state: "attention", label: "Worn", reason: [lifeFrag, usedFrag, pohFrag].filter(nn).join(" · "), source };
  const sectors = [d.realloc, d.pending, d.uncorrectable];
  if (sectors.some((n) => (n ?? 0) > 0))
    return {
      state: "attention",
      label: "Check sectors",
      reason: `${fmtN(d.realloc ?? 0)} reallocated / ${fmtN(d.pending ?? 0)} pending / ${fmtN(d.uncorrectable ?? 0)} uncorrectable sectors`,
      source,
    };
  if (cw & 0x02) return { state: "attention", label: "Overheating", reason: "drive reported a temperature warning", source };
  if ((life != null && life > 50) || (life == null && !d.nvme && sectors.every((n) => n === 0)))
    return { state: "good", label: "Good", reason: [lifeFrag, usedFrag, pohFrag].filter(nn).join(" · "), source };
  return { state: "unknown", label: "Health unknown — no wear data", reason: "No wear or sector data reported", source };
}

/* ------------------------------------------------------------------ */
/* Simulation state                                                    */
/* ------------------------------------------------------------------ */

interface DiskState {
  temp: number;
  read: number;
  write: number;
  burstLeft: number;
  burstRead: number;
  burstWrite: number;
  tbw: number;
  readTb: number;
}

/** Per-tick raw values the sensor tree reads from (beyond the telemetry packet). */
interface Frame {
  pkt: TelemetryPacket;
  coreClock: number[];
  coreEff: number[];
  threadLoad: number[];
  ccdTemp: number[];
  socVolt: number;
  socPower: number;
  corePowerSvi: number;
  fanRpm: number[];
  fanDuty: number[];
  moboTemps: Record<string, number>;
  volts: Record<string, number>;
  gpuFanRpm: number[];
  gpuFanPct: number;
  gpuMemJunction: number;
  netUpGb: number;
  netDownGb: number;
}

const sim = {
  intervalMs: settings.pollIntervalMs,
  profile: PROFILES[1],
  profileLeft: 16,
  cpuWork: 0.1,
  gpuWork: 0.06,
  coreBias: Array.from({ length: CORES }, () => rand(0.6, 1.4)),
  cpuTemp: HOT ? 88 : 44,
  clock: OWNER ? 4040 : 4300,
  gpuTemp: HOT ? 86 : 36,
  gpuFanOn: HOT,
  vram: 1.6,
  ram: RIG.ramStartGb,
  fanRpm: FANS.map((f) => (f.connected ? f.minRpm + (f.maxRpm - f.minRpm) * 0.35 : 0)),
  fanDuty: FANS.map(() => 35),
  customDuty: FANS.map(() => 50),
  preset: "auto" as FanPreset,
  disk: DISKS.map<DiskState>((d) => ({
    temp: d.baseTemp + 3,
    read: 0,
    write: 0,
    burstLeft: 0,
    burstRead: 0,
    burstWrite: 0,
    tbw: d.tbw ?? 0,
    readTb: d.readTb ?? 0,
  })),
  net: { burstLeft: 0, burstDown: 0, upGb: 3.2, downGb: 41.7 },
  startedAt: Date.now(),
};

/* ── Fan safety (MF-13, CONTRACT §1.5) ─────────────────────────────── */

const fan = {
  /** Agent latched fans at 100% after a same-boot flag (only while elevated). */
  failsafe: false,
  manualActive: false,
  override: false,
  reason: null as FanOverrideReason | null,
  coolCount: 0,
  missingCount: 0,
};

const FAILSAFE_LOCKED = "Fan control is locked at 100% after an interruption. Restart the PC to return fans to BIOS control.";
const OVERRIDE_SAVED_CPU = "Saved. Fans stay at 100% until the CPU cools to 75 °C.";
const OVERRIDE_SAVED_SENSOR = "Saved. Fans stay at 100% until the temperature sensor reads again.";
const NEEDS_ADMIN_FANS = "Fan control needs administrator rights";

function fanSafety(): FanSafety {
  if (ADMIN0) return { manualActive: false, overrideActive: false, reason: null, failsafe: false, triggerC: 85, releaseC: 75 };
  const reason: FanOverrideReason | null = fan.failsafe ? "failsafe" : fan.override ? fan.reason : null;
  return {
    manualActive: fan.failsafe || fan.manualActive,
    overrideActive: fan.failsafe || fan.override,
    reason,
    failsafe: fan.failsafe,
    triggerC: 85,
    releaseC: 75,
  };
}

/** Thermal override evaluation (agent side, every tick while manual control is active). */
function evaluateOverride(cpuTemp: number | null): void {
  if (fan.failsafe || !fan.manualActive || ADMIN0) {
    if (!fan.manualActive) {
      fan.override = false;
      fan.reason = null;
    }
    return;
  }
  if (cpuTemp == null) {
    fan.missingCount++;
    if (fan.missingCount >= 3 && !fan.override) {
      fan.override = true;
      fan.reason = "sensorMissing";
      fan.coolCount = 0;
    }
    return;
  }
  fan.missingCount = 0;
  if (cpuTemp >= 85) {
    if (!fan.override || fan.reason !== "cpuTemp") console.info("[nexum mock] fan override on: CPU ≥ 85 °C");
    fan.override = true;
    fan.reason = "cpuTemp";
    fan.coolCount = 0;
    return;
  }
  if (fan.override && cpuTemp <= 75) {
    fan.coolCount++;
    if (fan.coolCount >= 3) {
      console.info("[nexum mock] fan override released");
      fan.override = false;
      fan.reason = null;
      fan.coolCount = 0;
    }
  } else if (fan.override) {
    fan.coolCount = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Step: advance the simulation and produce a packet + frame           */
/* ------------------------------------------------------------------ */

let lastFrame: Frame | null = null;

function step(dt: number, ts: number): Frame {
  // Workload phases
  sim.profileLeft -= dt;
  if (sim.profileLeft <= 0) {
    sim.profile = pickProfile(sim.profile);
    sim.profileLeft = rand(14, 38);
  }
  const p = sim.profile;
  const sq = Math.sqrt(dt);
  sim.cpuWork = clampN(lag(sim.cpuWork, p.cpu, dt, 2.2) + gauss() * 0.035 * sq, 0, 1);
  sim.gpuWork = clampN(lag(sim.gpuWork, p.gpu, dt, 1.6) + gauss() * 0.03 * sq, 0, 1);

  // CPU: one load entry per PHYSICAL core; thread loads are derived for the sensor tree.
  const perCore = sim.coreBias.map((bias, i) => {
    const b = clampN(bias + gauss() * 0.08 * sq + (1 - bias) * 0.05, 0.25, 1.75);
    sim.coreBias[i] = b;
    const v = sim.cpuWork * 100 * b + Math.abs(gauss()) * 1.6 + (i < 2 ? 2.5 : 0);
    return clampN(v, 0, 100);
  });
  const threadsPerCore = Math.max(1, Math.round(THREADS / CORES));
  const threadLoad: number[] = [];
  perCore.forEach((c) => {
    for (let t = 0; t < threadsPerCore; t++) threadLoad.push(clampN(c * (t === 0 ? 1.15 : 0.85) + gauss() * 1.2, 0, 100));
  });
  const loadTotal = perCore.reduce((s, v) => s + v, 0) / perCore.length;
  const cpuTarget = HOT ? 87 + loadTotal * 0.08 : RIG.cpuTempBase + loadTotal * RIG.cpuTempSlope;
  sim.cpuTemp = lag(sim.cpuTemp, cpuTarget, dt, 3.5) + gauss() * 0.3;
  const clockTarget =
    loadTotal < 12
      ? RIG.cpuIdleClockLo + Math.random() * RIG.cpuIdleClockSpan
      : RIG.cpuLoadClockBase - loadTotal * RIG.cpuLoadClockSlope;
  sim.clock = clampN(lag(sim.clock, clockTarget, dt, 0.6), RIG.cpuClockMin, RIG.cpuClockMax);
  const coreClock = perCore.map(() => clampN(sim.clock + gauss() * 18, RIG.cpuClockMin, RIG.cpuClockMax));
  // Effective clock = time-weighted (idle cores sleep), which is what "Cores (Average Effective)" reports.
  const coreEff = coreClock.map((c, i) => c * clampN(0.08 + (perCore[i] / 100) * 0.92, 0.05, 1));
  const effAvg = coreEff.reduce((s, v) => s + v, 0) / coreEff.length;
  const voltage = RIG.cpuVoltBase + (sim.clock / RIG.cpuClockMax) * 0.42 + gauss() * 0.006;
  const cpuPower = RIG.cpuPowerBase + loadTotal * RIG.cpuPowerSlope + gauss() * 1.5;

  // Discrete GPU
  const gLoad = sim.gpuWork < 0.03 ? rand(0, 3) : clampN(sim.gpuWork * 100 + gauss() * 2.4, 0, 100);
  const coreClockG =
    gLoad < 6 ? rand(RIG.gpuIdleClockLo, RIG.gpuIdleClockHi) : RIG.gpuBoostBase + gLoad * RIG.gpuBoostSlope + gauss() * 12;
  const memClock = gLoad < 6 ? RIG.gpuMemIdle : RIG.gpuMemLoad;
  sim.vram = lag(sim.vram, RIG.gpuVramBase + sim.gpuWork * RIG.gpuVramSlope, dt, 5);
  const gpuTarget = HOT ? 86 + gLoad * 0.05 : RIG.gpuTempBase + gLoad * RIG.gpuTempSlope;
  sim.gpuTemp = lag(sim.gpuTemp, gpuTarget, dt, 5) + gauss() * 0.2;
  if (sim.gpuTemp >= 55) sim.gpuFanOn = true;
  else if (sim.gpuTemp <= 47) sim.gpuFanOn = false;
  const gpuFanPct = sim.gpuFanOn ? clampN(30 + (sim.gpuTemp - 50) * 1.15, 30, 100) : 0;
  const gpuFanRpm = sim.gpuFanOn ? 380 + gpuFanPct * 24 + gauss() * 6 : 0;
  // Memory junction: LHM "GPU Memory Junction" (NVIDIA) / "GPU Memory" (AMD, ~6 °C lower in this model).
  const memJunction = sim.gpuTemp + 12 + gLoad * 0.08;
  const memJunctionReported = RIG.dgpuVendor === "amd" ? memJunction - 6 : memJunction;
  const dgpu: GpuTelemetry = {
    name: DGPU_NAME,
    vendor: RIG.dgpuVendor,
    load: r1(gLoad),
    vramUsedGb: r2(sim.vram),
    vramTotalGb: RIG.gpuVramTotal,
    coreClockMhz: r1(coreClockG),
    memClockMhz: r1(memClock),
    tempC: r1(sim.gpuTemp),
    hotspotTempC: r1(sim.gpuTemp + RIG.gpuHotspotBase + gLoad * RIG.gpuHotspotSlope),
    powerW: r1(Math.max(8, RIG.gpuPowerBase + gLoad * RIG.gpuPowerSlope + gauss() * 2)),
    fanRpm: r1(Math.max(0, gpuFanRpm)),
    fanPct: r1(gpuFanPct),
    memJunctionTempC: r1(memJunctionReported),
  };
  const igpu: GpuTelemetry = {
    name: IGPU_NAME,
    vendor: "amd",
    load: r1(rand(0.4, 4)),
    vramUsedGb: r2(0.28 + Math.random() * 0.06),
    vramTotalGb: 0.5,
    coreClockMhz: r1(rand(600, 2200)),
    memClockMhz: 3000,
    tempC: null,
    hotspotTempC: null,
    powerW: null,
    fanRpm: null,
    fanPct: null,
    memJunctionTempC: null,
  };

  // RAM
  sim.ram = clampN(
    lag(sim.ram, RIG.ramBase + sim.cpuWork * RIG.ramCpu + sim.gpuWork * RIG.ramGpu, dt, 7) + gauss() * 0.03,
    6,
    OWNER ? RAM_TOTAL_GB - 1.5 : 60,
  );

  // Fans (motherboard headers; need ring 0)
  const cpuTempReported = NO_RING0 ? null : sim.cpuTemp;
  evaluateOverride(cpuTempReported);
  const forced = !ADMIN0 && (fan.failsafe || fan.override);
  const hottest = Math.max(sim.cpuTemp, sim.gpuTemp);
  FANS.forEach((f, i) => {
    const autoDuty =
      f.kind === "cpu" ? curve(sim.cpuTemp, 40, 85, 22, 100) : f.kind === "pump" ? 85 : curve(hottest, 40, 85, 25, 90);
    let duty: number;
    if (forced && f.controllable) duty = 100;
    else if (!f.controllable || sim.preset === "auto") duty = autoDuty;
    else if (sim.preset === "custom") duty = sim.customDuty[i];
    else duty = PRESET_DUTY[sim.preset];
    sim.fanDuty[i] = duty;
    const target = !f.connected || duty <= 0 ? 0 : f.minRpm + (f.maxRpm - f.minRpm) * (duty / 100);
    const noise = f.connected ? gauss() * (f.kind === "pump" ? 9 : 5) : 0;
    sim.fanRpm[i] = Math.max(0, lag(sim.fanRpm[i], target, dt, f.kind === "pump" ? 2 : 1.4) + noise);
  });
  const moboFans: FanTelemetry[] = NO_RING0
    ? []
    : FANS.map((f, i) => ({
        id: fanSensorId(f),
        name: fanName(f),
        hardware: RIG.superIoName,
        hwId: RIG.superIoId,
        rpm: r1(sim.fanRpm[i]),
        rpmMin: null,
        rpmMax: null,
        controllable: f.controllable && !ADMIN0,
        controlPct: f.controllable ? r1(sim.fanDuty[i]) : null,
      }));
  const gpuFanRpms = GPU_FAN_NAMES.map((_, k) => (gpuFanRpm > 0 ? Math.max(0, gpuFanRpm + (k === 0 ? 0 : 35) + gauss() * 4) : 0));
  const gpuFans: FanTelemetry[] = GPU_FAN_NAMES.map((name, k) => ({
    id: `${RIG.dgpuHwId}/fan/${k}`,
    name,
    hardware: DGPU_NAME,
    hwId: RIG.dgpuHwId,
    rpm: r1(gpuFanRpms[k]),
    rpmMin: null,
    rpmMax: null,
    controllable: false,
    controlPct: r1(gpuFanPct),
  }));

  // Disks
  const elapsedHours = Math.floor((ts - sim.startedAt) / 3_600_000);
  const disks: DiskTelemetry[] = DISKS.map((d, i) => {
    const s = sim.disk[i];
    const burstChance =
      d.role === "games" && p.name === "gaming" ? 0.22 : d.role === "system" ? 0.1 + sim.cpuWork * 0.15 : 0.03;
    if (s.burstLeft <= 0 && Math.random() < burstChance * dt) {
      s.burstLeft = rand(1, 5);
      s.burstRead = rand(0.08, 1) * d.maxRead * (Math.random() < 0.7 ? 1 : 0.15);
      s.burstWrite = Math.random() < 0.45 ? rand(0.05, 0.8) * d.maxWrite : rand(0, 4);
    }
    let read = Math.abs(gauss()) * (d.role === "archive" ? 0.05 : 0.6);
    let write = Math.abs(gauss()) * (d.role === "system" ? 1.4 : 0.2);
    if (s.burstLeft > 0) {
      s.burstLeft -= dt;
      read += s.burstRead * rand(0.75, 1.05);
      write += s.burstWrite * rand(0.7, 1.05);
    }
    s.read = read;
    s.write = write;
    if (d.tbw != null) s.tbw += (write * dt) / 1_000_000;
    if (d.readTb != null) s.readTb += (read * dt) / 1_000_000;
    const tTarget = d.baseTemp + Math.min(14, (read + write) / 180) + sim.cpuWork * 3;
    s.temp = lag(s.temp, tTarget, dt, 9) + gauss() * 0.1;
    const smart = !ADMIN0;
    const poh = smart ? d.poh + elapsedHours : null;
    return {
      id: d.id,
      name: d.name,
      diskNumber: d.diskNumber,
      serial: d.serial,
      tempC: smart ? r1(s.temp) : null,
      tempMinC: null,
      tempMaxC: null,
      readMBps: r2(read),
      writeMBps: r2(write),
      healthPct: smart ? d.life : null,
      tbw: smart && d.tbw != null ? r2(s.tbw) : null,
      powerOnHours: poh,
      usedPct: d.usedPct,
      health: classifyDisk(d, poh),
      criticalWarning: smart ? d.criticalWarning : null,
      availableSparePct: smart ? d.spare : null,
      availableSpareThresholdPct: smart ? d.spareThreshold : null,
      percentageUsed: smart && d.nvme && d.life != null ? 100 - d.life : null,
      mediaErrors: smart ? d.mediaErrors : null,
      unsafeShutdowns: smart ? d.unsafeShutdowns : null,
      powerCycles: smart ? d.powerCycles : null,
      errorLogEntries: smart ? d.errorLogEntries : null,
      warningTempC: smart ? d.warnTemp : null,
      criticalTempC: smart ? d.critTemp : null,
      warningTempMinutes: smart && d.nvme ? (d.life != null && d.life < 50 ? 37 : 0) : null,
      criticalTempMinutes: smart && d.nvme ? 0 : null,
      reallocatedSectors: smart ? d.realloc : null,
      pendingSectors: smart ? d.pending : null,
      uncorrectableSectors: smart ? d.uncorrectable : null,
      dataReadTb: smart && d.readTb != null ? r2(s.readTb) : null,
    };
  });

  // Network
  if (sim.net.burstLeft <= 0 && Math.random() < 0.04 * dt) {
    sim.net.burstLeft = rand(2, 8);
    sim.net.burstDown = rand(5, 92);
  }
  let down = 0.02 + Math.abs(gauss()) * 0.08;
  if (sim.net.burstLeft > 0) {
    sim.net.burstLeft -= dt;
    down += sim.net.burstDown * rand(0.8, 1.05);
  }
  const up = Math.max(0, 0.01 + Math.abs(gauss()) * 0.03 + (p.name === "streaming" ? 0.75 + gauss() * 0.04 : 0));
  sim.net.downGb += (down * dt) / 1024;
  sim.net.upGb += (up * dt) / 1024;

  const pkt: TelemetryPacket = {
    type: "telemetry",
    ts,
    cpu: {
      name: CPU_TELEMETRY_NAME,
      loadTotal: r1(loadTotal),
      loadPerCore: perCore.map(r1),
      // Without ring-0 access (not elevated / no PawnIO): no MSR/SMU → clock, temp, voltage, power are null.
      clockMhz: NO_RING0 ? null : r1(effAvg),
      maxClockMhz: NO_RING0 ? null : r1(Math.max(...coreClock)),
      packageTempC: NO_RING0 ? null : r1(sim.cpuTemp),
      voltage: NO_RING0 ? null : r3(voltage),
      powerW: NO_RING0 ? null : r1(cpuPower),
      cores: CORES,
      threads: THREADS,
    },
    gpu: dgpu,
    gpus: OWNER ? [dgpu] : [dgpu, igpu],
    ram: {
      usedGb: r2(sim.ram),
      availableGb: r2(RAM_TOTAL_GB - sim.ram),
      totalGb: RAM_TOTAL_GB,
      loadPct: r1((sim.ram / RAM_TOTAL_GB) * 100),
      speedMts: RIG.ramSpeedMts,
      formFactor: "DIMM",
      slotsUsed: 2,
      slotsTotal: 4,
    },
    fans: [...moboFans, ...gpuFans],
    disks,
    network: { downMBps: r2(down), upMBps: r2(up) },
    fanPreset: sim.preset,
    fanSafety: fanSafety(),
  };

  const vrm = 36 + cpuPower * 0.22 + gauss() * 0.2;
  const frame: Frame = {
    pkt,
    coreClock,
    coreEff,
    threadLoad,
    ccdTemp: Array.from({ length: RIG.ccds }, (_, k) => sim.cpuTemp - 4 - k * 1.5 + gauss() * 0.4),
    socVolt: 1.08 + gauss() * 0.003,
    socPower: 9 + sim.cpuWork * 6 + gauss() * 0.3,
    corePowerSvi: cpuPower * 0.72,
    fanRpm: [...sim.fanRpm],
    fanDuty: [...sim.fanDuty],
    moboTemps: {
      system1: 29 + sim.cpuWork * 3 + gauss() * 0.15,
      chipset: 47 + sim.cpuWork * 4 + gauss() * 0.2,
      cpu: sim.cpuTemp - 6 + gauss() * 0.3,
      pcie: 30 + gLoad * 0.12 + gauss() * 0.2,
      vrm,
      system2: 31 + sim.gpuWork * 4 + gauss() * 0.15,
      motherboard: 31 + sim.cpuWork * 3 + gauss() * 0.15,
    },
    volts: {
      vcore: voltage,
      v33: 3.312 + gauss() * 0.004,
      v12: 12.096 + gauss() * 0.02,
      v5: 5.03 + gauss() * 0.006,
      soc: 1.084 + gauss() * 0.002,
      vddp: 0.9 + gauss() * 0.002,
      dram: OWNER ? 1.356 + gauss() * 0.002 : 1.35 + gauss() * 0.002,
      vsb: 3.33 + gauss() * 0.004,
      vbat: 3.17,
    },
    gpuFanRpm: gpuFanRpms,
    gpuFanPct,
    gpuMemJunction: memJunction,
    netUpGb: sim.net.upGb,
    netDownGb: sim.net.downGb,
  };
  lastFrame = frame;
  return frame;
}

/* ------------------------------------------------------------------ */
/* Sensor tree (CONTRACT §1.3)                                         */
/* ------------------------------------------------------------------ */

type Reader = (f: Frame) => number | null | undefined;

interface SDef {
  kind: SensorKind;
  name: string;
  read: Reader;
}

interface HwDef {
  id: string;
  parentId: string | null;
  kind: HardwareKind;
  name: string;
  sensors: SDef[];
  /** Added by LHM's MemoryGroup ~10 s after start (bumps rev). */
  late?: boolean;
}

const S = (kind: SensorKind, name: string, read: Reader): SDef => ({ kind, name, read });

const KIND_TABLE: Record<SensorKind, { unit: SensorUnit; decimals: number }> = {
  voltage: { unit: "V", decimals: 3 },
  current: { unit: "A", decimals: 2 },
  power: { unit: "W", decimals: 1 },
  clock: { unit: "MHz", decimals: 0 },
  temperature: { unit: "°C", decimals: 1 },
  load: { unit: "%", decimals: 1 },
  frequency: { unit: "Hz", decimals: 0 },
  fan: { unit: "RPM", decimals: 0 },
  flow: { unit: "L/h", decimals: 0 },
  control: { unit: "%", decimals: 0 },
  level: { unit: "%", decimals: 1 },
  factor: { unit: "", decimals: 2 },
  data: { unit: "GB", decimals: 1 },
  smallData: { unit: "MB", decimals: 0 },
  throughput: { unit: "MB/s", decimals: 2 },
  timeSpan: { unit: "s", decimals: 0 },
  timing: { unit: "ns", decimals: 2 },
  energy: { unit: "mWh", decimals: 0 },
  noise: { unit: "dBA", decimals: 0 },
  conductivity: { unit: "µS/cm", decimals: 1 },
  humidity: { unit: "%", decimals: 0 },
};

function unitFor(kind: SensorKind, name: string): { unit: SensorUnit; decimals: number } {
  const base = KIND_TABLE[kind];
  if (kind === "data" && /count|cycles/i.test(name)) return { unit: "", decimals: 0 };
  if (kind === "smallData" && /count|cycles/i.test(name)) return { unit: "", decimals: base.decimals };
  if (kind === "timeSpan" && /hours/i.test(name)) return { unit: "h", decimals: base.decimals };
  return base;
}

function isStatic(kind: SensorKind, name: string): boolean {
  if (kind === "timing") return true;
  if ((kind === "data" || kind === "smallData") && ["Total Space", "Capacity", "Total Memory", "GPU Memory Total"].includes(name)) return true;
  if (kind === "temperature" && /Limit|Threshold|Warning Temperature|Critical Temperature/.test(name)) return true;
  return false;
}

const ring0 = (r: Reader): Reader => (NO_RING0 ? () => null : r);
const smartOnly = (r: Reader): Reader => (ADMIN0 ? () => null : r);

function cpuHw(): HwDef {
  const sensors: SDef[] = [];
  const svi = RIG.svi;
  sensors.push(S("voltage", `Core (${svi} TFN)`, ring0((f) => f.pkt.cpu.voltage)));
  sensors.push(S("voltage", `SoC (${svi} TFN)`, ring0((f) => f.socVolt)));
  sensors.push(S("current", `Core (${svi} TFN)`, ring0((f) => (f.pkt.cpu.voltage ? f.corePowerSvi / f.pkt.cpu.voltage : null))));
  sensors.push(S("current", `SoC (${svi} TFN)`, ring0((f) => f.socPower / f.socVolt)));
  sensors.push(S("power", "Package", ring0((f) => f.pkt.cpu.powerW)));
  for (let c = 0; c < CORES; c++)
    sensors.push(S("power", `Core #${c + 1} (SMU)`, ring0((f) => (f.corePowerSvi / CORES) * (0.4 + (f.pkt.cpu.loadPerCore[c] ?? 0) / 100))));
  sensors.push(S("power", `Core (${svi} TFN)`, ring0((f) => f.corePowerSvi)));
  sensors.push(S("power", `SoC (${svi} TFN)`, ring0((f) => f.socPower)));
  sensors.push(S("clock", "Bus Speed", ring0(() => 100 + gauss() * 0.02)));
  for (let c = 0; c < CORES; c++) sensors.push(S("clock", `Core #${c + 1}`, ring0((f) => f.coreClock[c])));
  sensors.push(S("clock", "Cores (Average Effective)", ring0((f) => f.pkt.cpu.clockMhz)));
  sensors.push(S("temperature", "Core (Tctl/Tdie)", ring0((f) => f.pkt.cpu.packageTempC)));
  for (let k = 0; k < RIG.ccds; k++) sensors.push(S("temperature", `CCD${k + 1} (Tdie)`, ring0((f) => f.ccdTemp[k])));
  sensors.push(S("load", "CPU Total", (f) => f.pkt.cpu.loadTotal));
  sensors.push(S("load", "CPU Core Max", (f) => Math.max(...f.threadLoad)));
  const tpc = Math.max(1, Math.round(THREADS / CORES));
  for (let c = 0; c < CORES; c++)
    for (let t = 0; t < tpc; t++)
      sensors.push(S("load", `CPU Core #${c + 1} Thread #${t + 1}`, (f) => f.threadLoad[c * tpc + t]));
  return { id: RIG.cpuHwId, parentId: null, kind: "cpu", name: CPU_TELEMETRY_NAME, sensors };
}

function superIoHw(): HwDef {
  const g = GENERIC_LABELS;
  const sensors: SDef[] = [];
  if (OWNER) {
    const volts: Array<[string, keyof Frame["volts"]]> = [
      ["Vcore", "vcore"],
      ["+3.3V", "v33"],
      ["+12V", "v12"],
      ["+5V", "v5"],
      ["VCore SoC", "soc"],
      ["VDDP", "vddp"],
      ["DRAM", "dram"],
      ["3VSB", "vsb"],
      ["VBat", "vbat"],
    ];
    volts.forEach(([name, key], i) => sensors.push(S("voltage", g ? `VIN${i}` : name, (f) => f.volts[key])));
    const temps: Array<[string, string]> = [
      ["System #1", "system1"],
      ["Chipset", "chipset"],
      ["CPU", "cpu"],
      ["PCIe x16", "pcie"],
      ["VRM MOS", "vrm"],
      ["System #2", "system2"],
    ];
    temps.forEach(([name, key], i) => sensors.push(S("temperature", g ? `TMPIN${i}` : name, (f) => f.moboTemps[key])));
  } else {
    const volts: Array<[string, keyof Frame["volts"]]> = [
      ["Vcore", "vcore"],
      ["+5V", "v5"],
      ["AVCC", "v33"],
      ["+3.3V", "v33"],
      ["+12V", "v12"],
      ["3VSB", "vsb"],
      ["VBat", "vbat"],
      ["DRAM", "dram"],
    ];
    volts.forEach(([name, key], i) => sensors.push(S("voltage", g ? `VIN${i}` : name, (f) => f.volts[key])));
    const temps: Array<[string, string]> = [
      ["CPU", "cpu"],
      ["Motherboard", "motherboard"],
      ["Chipset", "chipset"],
      ["VRM", "vrm"],
    ];
    temps.forEach(([name, key], i) => sensors.push(S("temperature", g ? `TMPIN${i}` : name, (f) => f.moboTemps[key])));
  }
  FANS.forEach((fs, i) => sensors.push(S("fan", fanName(fs), (f) => f.fanRpm[i])));
  FANS.forEach((fs, i) => {
    if (fs.controllable) sensors.push(S("control", fanName(fs), (f) => f.fanDuty[i]));
  });
  return { id: RIG.superIoId, parentId: "/motherboard", kind: "superio", name: RIG.superIoName, sensors };
}

function memoryHw(): HwDef[] {
  const total: HwDef = {
    id: "/ram",
    parentId: null,
    kind: "memory",
    name: "Total Memory",
    sensors: [
      S("data", "Memory Used", (f) => f.pkt.ram.usedGb),
      S("data", "Memory Available", (f) => f.pkt.ram.availableGb),
      S("data", "Virtual Memory Used", (f) => f.pkt.ram.usedGb + 4.2),
      S("data", "Virtual Memory Available", (f) => f.pkt.ram.availableGb + 6.1),
      S("load", "Memory", (f) => f.pkt.ram.loadPct),
      S("load", "Virtual Memory", (f) => (f.pkt.ram.loadPct * 0.92)),
    ],
  };
  if (NO_RING0) return [total];
  const ddr5 = !OWNER;
  const part = OWNER ? "F4-3600C16-16GVKC" : "F5-6000J3038F32G";
  const dimms: HwDef[] = [0, 1].map((k) => {
    const sensors: SDef[] = [];
    if (ddr5) sensors.push(S("temperature", "DIMM Temperature", (f) => 38 + f.pkt.ram.loadPct * 0.05 + k * 0.6));
    sensors.push(S("data", "Capacity", () => (OWNER ? 16 : 32)));
    const t = OWNER
      ? { tck: 0.555, taa: 8.88, trcd: 8.88, trp: 8.88, tras: 20.0 }
      : { tck: 0.333, taa: 10.0, trcd: 12.67, trp: 12.67, tras: 32.0 };
    sensors.push(S("timing", "tCK (min)", () => t.tck));
    sensors.push(S("timing", "tAA (min)", () => t.taa));
    sensors.push(S("timing", "tRCD (min)", () => t.trcd));
    sensors.push(S("timing", "tRP (min)", () => t.trp));
    sensors.push(S("timing", "tRAS (min)", () => t.tras));
    return { id: `/memory/dimm/${k}`, parentId: null, kind: "memory" as HardwareKind, name: `DIMM #${k + 1} - ${part}`, sensors, late: true };
  });
  return [total, ...dimms];
}

function gpuHw(): HwDef[] {
  const g = (f: Frame) => f.pkt.gpu;
  const out: HwDef[] = [];
  if (RIG.dgpuVendor === "nvidia") {
    out.push({
      id: RIG.dgpuHwId,
      parentId: null,
      kind: "gpuNvidia",
      name: DGPU_NAME,
      sensors: [
        S("power", "GPU Package", (f) => g(f)?.powerW),
        S("clock", "GPU Core", (f) => g(f)?.coreClockMhz),
        S("clock", "GPU Memory", (f) => g(f)?.memClockMhz),
        S("clock", "GPU Video", (f) => ((g(f)?.load ?? 0) > 5 ? 1950 : 1185)),
        S("temperature", "GPU Core", (f) => g(f)?.tempC),
        S("temperature", "GPU Hot Spot", (f) => g(f)?.hotspotTempC),
        S("temperature", "GPU Memory Junction", (f) => f.gpuMemJunction),
        S("load", "GPU Core", (f) => g(f)?.load),
        S("load", "GPU Memory Controller", (f) => (g(f)?.load ?? 0) * 0.42),
        S("load", "GPU Video Engine", () => 0),
        S("load", "GPU Bus", (f) => (g(f)?.load ?? 0) * 0.08),
        S("load", "GPU Memory", (f) => ((g(f)?.vramUsedGb ?? 0) / RIG.gpuVramTotal) * 100),
        S("fan", "GPU Fan 1", (f) => f.gpuFanRpm[0]),
        S("fan", "GPU Fan 2", (f) => f.gpuFanRpm[1]),
        S("control", "GPU Fan 1", (f) => f.gpuFanPct),
        S("control", "GPU Fan 2", (f) => f.gpuFanPct),
        S("smallData", "GPU Memory Free", (f) => (RIG.gpuVramTotal - (g(f)?.vramUsedGb ?? 0)) * 1024),
        S("smallData", "GPU Memory Used", (f) => (g(f)?.vramUsedGb ?? 0) * 1024),
        S("smallData", "GPU Memory Total", () => RIG.gpuVramTotal * 1024),
        S("throughput", "GPU PCIe Rx", (f) => (g(f)?.load ?? 0) * 2.1),
        S("throughput", "GPU PCIe Tx", (f) => (g(f)?.load ?? 0) * 0.6),
      ],
    });
    out.push({
      id: IGPU_HW_ID,
      parentId: null,
      kind: "gpuAmd",
      name: IGPU_NAME,
      sensors: [
        S("load", "D3D 3D", (f) => f.pkt.gpus[1]?.load),
        S("smallData", "D3D Shared Memory Used", (f) => (f.pkt.gpus[1]?.vramUsedGb ?? 0) * 1024),
        S("smallData", "GPU Memory Total", () => 512),
      ],
    });
  } else {
    out.push({
      id: RIG.dgpuHwId,
      parentId: null,
      kind: "gpuAmd",
      name: DGPU_NAME,
      sensors: [
        S("voltage", "GPU Core", (f) => ((g(f)?.load ?? 0) > 5 ? 1.05 : 0.72)),
        S("power", "GPU Package", (f) => g(f)?.powerW),
        S("clock", "GPU Core", (f) => g(f)?.coreClockMhz),
        S("clock", "GPU Memory", (f) => g(f)?.memClockMhz),
        S("temperature", "GPU Core", (f) => g(f)?.tempC),
        S("temperature", "GPU Hot Spot", (f) => g(f)?.hotspotTempC),
        S("temperature", "GPU Memory", (f) => f.gpuMemJunction - 6),
        S("load", "GPU Core", (f) => g(f)?.load),
        S("load", "GPU Memory", (f) => ((g(f)?.vramUsedGb ?? 0) / RIG.gpuVramTotal) * 100),
        S("load", "D3D 3D", (f) => g(f)?.load),
        S("fan", "GPU Fan", (f) => f.gpuFanRpm[0]),
        S("control", "GPU Fan", (f) => f.gpuFanPct),
        S("smallData", "GPU Memory Used", (f) => (g(f)?.vramUsedGb ?? 0) * 1024),
        S("smallData", "GPU Memory Free", (f) => (RIG.gpuVramTotal - (g(f)?.vramUsedGb ?? 0)) * 1024),
        S("smallData", "GPU Memory Total", () => RIG.gpuVramTotal * 1024),
      ],
    });
  }
  return out;
}

function storageHw(): HwDef[] {
  return DISKS.map((d, i) => {
    const t = (f: Frame) => f.pkt.disks[i];
    const sensors: SDef[] = [];
    if (d.nvme) {
      sensors.push(S("temperature", "Composite Temperature", smartOnly((f) => t(f)?.tempC)));
      sensors.push(S("temperature", "Temperature #1", smartOnly((f) => (t(f)?.tempC ?? 0) + 6)));
      sensors.push(S("temperature", "Warning Temperature", smartOnly(() => d.warnTemp)));
      sensors.push(S("temperature", "Critical Temperature", smartOnly(() => d.critTemp)));
      sensors.push(S("level", "Available Spare", smartOnly(() => d.spare)));
      sensors.push(S("level", "Available Spare Threshold", smartOnly(() => d.spareThreshold)));
      sensors.push(S("level", "Percentage Used", smartOnly(() => (d.life != null ? 100 - d.life : null))));
      sensors.push(S("data", "Data Read", smartOnly((f) => (t(f)?.dataReadTb ?? 0) * 1024)));
      sensors.push(S("data", "Data Written", smartOnly((f) => (t(f)?.tbw ?? 0) * 1024)));
      sensors.push(S("data", "Power Cycles", smartOnly(() => d.powerCycles)));
      sensors.push(S("data", "Error Info Log Count", smartOnly(() => d.errorLogEntries)));
      sensors.push(S("timeSpan", "Power On Hours", smartOnly((f) => t(f)?.powerOnHours)));
    } else {
      sensors.push(S("temperature", "Temperature", smartOnly((f) => t(f)?.tempC)));
      sensors.push(S("smallData", "Reallocated Sectors Count", smartOnly(() => d.realloc)));
      sensors.push(S("smallData", "Current Pending Sector Count", smartOnly(() => d.pending)));
      sensors.push(S("smallData", "Uncorrectable Sector Count", smartOnly(() => d.uncorrectable)));
      sensors.push(S("data", "Power Cycle Count", smartOnly(() => d.powerCycles)));
      sensors.push(S("timeSpan", "Power-On Hours", smartOnly((f) => t(f)?.powerOnHours)));
    }
    sensors.push(S("load", "Used Space", () => d.usedPct));
    sensors.push(S("load", "Read Activity", (f) => clampN(((t(f)?.readMBps ?? 0) / d.maxRead) * 100, 0, 100)));
    sensors.push(S("load", "Write Activity", (f) => clampN(((t(f)?.writeMBps ?? 0) / d.maxWrite) * 100, 0, 100)));
    sensors.push(S("load", "Total Activity", (f) => clampN((((t(f)?.readMBps ?? 0) + (t(f)?.writeMBps ?? 0)) / d.maxRead) * 100, 0, 100)));
    sensors.push(S("throughput", "Read Rate", (f) => t(f)?.readMBps));
    sensors.push(S("throughput", "Write Rate", (f) => t(f)?.writeMBps));
    return { id: d.id, parentId: null, kind: "storage" as HardwareKind, name: d.name, sensors };
  });
}

function networkHw(): HwDef {
  return {
    id: "/nic/%7B6F1A2B3C-0000-4000-8000-000000000001%7D",
    parentId: null,
    kind: "network",
    name: "Ethernet",
    sensors: [
      S("data", "Data Uploaded", (f) => f.netUpGb),
      S("data", "Data Downloaded", (f) => f.netDownGb),
      S("throughput", "Upload Speed", (f) => f.pkt.network?.upMBps),
      S("throughput", "Download Speed", (f) => f.pkt.network?.downMBps),
      S("load", "Network Utilization", (f) => clampN(((f.pkt.network?.downMBps ?? 0) / 118) * 100, 0, 100)),
    ],
  };
}

function allHardware(): HwDef[] {
  const list: HwDef[] = [{ id: "/motherboard", parentId: null, kind: "motherboard", name: RIG.boardName, sensors: [] }];
  if (!NO_RING0) list.push(superIoHw());
  list.push(cpuHw(), ...memoryHw(), ...gpuHw(), ...storageHw(), networkHw());
  return list;
}

const ALL_HW: HwDef[] = allHardware();

const sensorsState = {
  rev: 0,
  sessionStartTs: Date.now(),
  includeLate: false,
  tree: null as SensorTree | null,
  readers: [] as Reader[],
  metas: [] as SensorMeta[],
  streamOn: false,
};

interface Accum {
  min: number | null;
  max: number | null;
  sum: number;
  n: number;
}
const accum = new Map<string, Accum>();

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function readValue(i: number, f: Frame): number | null {
  const meta = sensorsState.metas[i];
  let v: number | null | undefined;
  try {
    v = sensorsState.readers[i](f);
  } catch {
    v = null;
  }
  if (v == null || !Number.isFinite(v)) return null;
  return roundTo(v, meta.decimals);
}

function buildTree(): void {
  const hardware: HardwareNode[] = [];
  const readers: Reader[] = [];
  const metas: SensorMeta[] = [];
  let idx = 0;
  for (const hw of ALL_HW) {
    if (hw.late && !sensorsState.includeLate) continue;
    const perKind = new Map<SensorKind, number>();
    const sensors: SensorMeta[] = hw.sensors.map((s) => {
      const n = perKind.get(s.kind) ?? 0;
      perKind.set(s.kind, n + 1);
      const { unit, decimals } = unitFor(s.kind, s.name);
      let initial: number | null | undefined = null;
      try {
        initial = lastFrame ? s.read(lastFrame) : null;
      } catch {
        initial = null;
      }
      const meta: SensorMeta = {
        id: `${hw.id}/${s.kind.toLowerCase()}/${n}`,
        idx: idx++,
        hwId: hw.id,
        name: s.name,
        kind: s.kind,
        unit,
        decimals,
        static: isStatic(s.kind, s.name),
        defaultHidden: initial == null || !Number.isFinite(initial),
      };
      readers.push(s.read);
      metas.push(meta);
      return meta;
    });
    hardware.push({ id: hw.id, parentId: hw.parentId, kind: hw.kind, name: hw.name, sensors });
  }
  sensorsState.rev += 1;
  sensorsState.readers = readers;
  sensorsState.metas = metas;
  sensorsState.tree = { type: "sensorTree", rev: sensorsState.rev, sessionStartTs: sensorsState.sessionStartTs, hardware };
}

function emitTree(): void {
  if (sensorsState.tree) emit("sensor-tree", { ...sensorsState.tree, sessionStartTs: sensorsState.sessionStartTs });
}

/** Update session accumulators from a frame; returns the values array (tree order). */
function sampleSensors(f: Frame): (number | null)[] {
  const values: (number | null)[] = [];
  for (let i = 0; i < sensorsState.metas.length; i++) {
    const v = readValue(i, f);
    values.push(v);
    const id = sensorsState.metas[i].id;
    let a = accum.get(id);
    if (!a) {
      a = { min: null, max: null, sum: 0, n: 0 };
      accum.set(id, a);
    }
    if (v != null) {
      a.min = a.min == null ? v : Math.min(a.min, v);
      a.max = a.max == null ? v : Math.max(a.max, v);
      a.sum += v;
      a.n += 1;
    }
  }
  return values;
}

function statsFor(id: string): Accum | null {
  return accum.get(id) ?? null;
}

/** Copy LHM-style session min/max into the packet (fans[].rpmMin/Max, disks[].tempMin/Max). */
function patchPacketStats(pkt: TelemetryPacket): void {
  for (const fanT of pkt.fans) {
    const a = statsFor(fanT.id);
    fanT.rpmMin = a?.min ?? null;
    fanT.rpmMax = a?.max ?? null;
  }
  for (const d of pkt.disks) {
    const node = sensorsState.tree?.hardware.find((h) => h.id === d.id);
    const tSensor = node?.sensors.find((s) => s.kind === "temperature");
    const a = tSensor ? statsFor(tSensor.id) : null;
    d.tempMinC = d.tempC == null ? null : (a?.min ?? null);
    d.tempMaxC = d.tempC == null ? null : (a?.max ?? null);
  }
}

function sensorValuesPacket(ts: number, values: (number | null)[]): SensorValues {
  const min: (number | null)[] = [];
  const max: (number | null)[] = [];
  const avg: (number | null)[] = [];
  for (const m of sensorsState.metas) {
    const a = accum.get(m.id);
    min.push(a?.min ?? null);
    max.push(a?.max ?? null);
    avg.push(a && a.n > 0 ? roundTo(a.sum / a.n, m.decimals) : null);
  }
  return { type: "sensorValues", ts, rev: sensorsState.rev, value: values, min, max, avg };
}

function resetSensors(ids: string[] | null): number {
  if (ids == null) {
    accum.clear();
    sensorsState.sessionStartTs = Date.now();
    if (sensorsState.tree) sensorsState.tree = { ...sensorsState.tree, sessionStartTs: sensorsState.sessionStartTs };
    return sensorsState.metas.length;
  }
  let n = 0;
  const known = new Set(sensorsState.metas.map((m) => m.id));
  for (const id of ids) {
    if (!known.has(id)) continue;
    accum.delete(id);
    n++;
  }
  return n;
}

/** New agent process: rev restarts at 1, stats and session restart, DIMMs re-appear ~10 s later. */
function resetSensorProcess(): void {
  sensorsState.rev = 0;
  sensorsState.includeLate = false;
  sensorsState.sessionStartTs = Date.now();
  accum.clear();
  buildTree();
}

/* ------------------------------------------------------------------ */
/* Agent status / degraded mode (CONTRACT §1.1 hello, §2.3)            */
/* ------------------------------------------------------------------ */

function sensorDriver(): SensorDriverStatus {
  const installed = PAWNIO_STATE !== "missing";
  const version = !installed ? null : PAWNIO_STATE === "outdated" ? "2.0.1" : "2.2.0";
  const reason: SensorDriverStatus["reason"] = !installed
    ? "missing"
    : PAWNIO_STATE === "outdated"
      ? "outdated"
      : ADMIN0
        ? "notElevated"
        : null;
  return {
    kind: installed ? "pawnio" : "none",
    version,
    minVersion: "2.1.0",
    ok: !ADMIN0 && installed && PAWNIO_STATE === "ok",
    reason,
  };
}

function limitedReasons(): LimitedReason[] {
  const out: LimitedReason[] = [];
  if (ADMIN0) out.push("notElevated");
  if (PAWNIO_STATE === "missing") out.push("pawnIoMissing");
  else if (PAWNIO_STATE === "outdated") out.push("pawnIoOutdated");
  return out;
}

function missingFeatures(reasons: LimitedReason[]): string[] {
  if (reasons.includes("notElevated"))
    return [
      "CPU temperature, power and clock",
      "Motherboard temperatures, voltages and fans",
      "Fan control",
      "Drive S.M.A.R.T. health",
      "Memory module details",
      "Windows Update cache, error report and crash dump cleanup",
    ];
  if (reasons.length > 0)
    return ["CPU temperature, power and clock", "Motherboard temperatures, voltages and fans", "Fan control", "Memory module details"];
  return [];
}

/* ------------------------------------------------------------------ */
/* Fan fail-safe state (Rust watchdog, CONTRACT §2.4)                  */
/* ------------------------------------------------------------------ */

const FAILSAFE_MESSAGES: Record<FanFailsafeKind, string> = {
  interrupted: "Fan control was interrupted. Fans are at 100% for safety. Restart the PC to return them to BIOS control.",
  agentLost:
    "Fan control was interrupted and Nexum is no longer controlling the fans. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.",
  previousBoot:
    "Nexum's fan control was interrupted before the last restart. If the fans behave unusually, shut down fully and power the PC on again.",
};

const FAILSAFE_OFF: FanFailsafeState = {
  active: false,
  kind: null,
  severity: null,
  fansAt100: false,
  message: "",
  sinceTs: null,
  dismissible: false,
};

function failsafeOf(kind: FanFailsafeKind): FanFailsafeState {
  return {
    active: true,
    kind,
    severity: kind === "previousBoot" ? "warn" : "crit",
    fansAt100: kind === "interrupted" && !ADMIN0,
    message: FAILSAFE_MESSAGES[kind],
    sinceTs: Date.now(),
    dismissible: kind === "previousBoot",
  };
}

let failsafeState: FanFailsafeState = FAILSAFE_OFF;

function setFailsafe(next: FanFailsafeState): void {
  failsafeState = next;
  emit("fan-failsafe", { ...failsafeState });
}

/* ------------------------------------------------------------------ */
/* Agent lifecycle + telemetry timer                                   */
/* ------------------------------------------------------------------ */

let booted = false;
let backfilled = false;
let agentRunning = !NO_AGENT && FAILSAFE_PARAM !== "agentLost";
let restarting = false;
let lastPacketTs: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;
let lateTimer: ReturnType<typeof setTimeout> | null = null;
let lastTick = 0;
const AGENT_PID = 4812;

/** "Try again" was pressed while the sensor service cannot come up (?sensors=…): phase "starting" for 1.5 s. */
let retrying = false;

/** Life-cycle phase as Rust reports it (CONTRACT §2.3.1). */
function sensorPhase(): SensorServicePhase {
  if (restarting) return "starting"; // restart_agent: "starting" until the new process says hello
  if (agentRunning) return "running";
  if (SENSORS_DOWN) return retrying ? "starting" : SENSORS_DOWN.phase;
  return "restarting"; // it stopped by itself (?failsafe=agentLost) and Rust is bringing it back
}

function agentStatus(): AgentStatus {
  const phase = sensorPhase();
  /** Hello received: only then are the driver state and the limited-mode reasons known. */
  const up = phase === "running";
  // Diagnostic text only: never rendered by the UI (CONTRACT §2.3).
  const message =
    phase === "running"
      ? `Sensor service v1.1.0 running (simulated, pid ${AGENT_PID})`
      : phase === "failed"
        ? "Sensor service could not be started (simulated failure)"
        : phase === "restarting"
          ? "Sensor service stopped unexpectedly (simulated); restarting"
          : "Sensor service starting (simulated)";
  const reasons = up ? limitedReasons() : [];
  return {
    // §2.3.1: a spawned process counts as running before its hello ("starting").
    running: phase === "running" || phase === "starting",
    isAdmin: !ADMIN0,
    message,
    lastPacketTs,
    sensorDriver: up ? sensorDriver() : null,
    limitedReasons: reasons,
    missingFeatures: up ? missingFeatures(reasons) : [],
    protocol: up ? AGENT_PROTOCOL : null,
    phase,
    failReason: phase === "failed" ? (SENSORS_DOWN?.reason ?? "crashed") : null,
  };
}

function emitStatus(): void {
  emit("agent-status", agentStatus());
}

function ack(cmd: string, ok: boolean, message: string, delay = 320): void {
  setTimeout(() => emit("agent-ack", { cmd, ok, message } satisfies AgentAck), delay);
}

/** One telemetry tick: packet, then (while streaming) the sensor values for the same rev. */
function produce(dt: number, ts: number, live: boolean): void {
  const f = step(dt, ts);
  const values = sampleSensors(f);
  patchPacketStats(f.pkt);
  lastPacketTs = f.pkt.ts;
  emit("telemetry", f.pkt);
  if (live && sensorsState.streamOn) emit("sensor-values", sensorValuesPacket(ts, values));
  if (live) onLivePacketV11(f.pkt);
}

function tick(): void {
  const now = performance.now();
  const dt = clampN((now - lastTick) / 1000, 0.05, 5);
  lastTick = now;
  produce(dt, Date.now(), true);
}

/** Emit ~90 seconds of history so charts are populated as soon as the preview opens. */
function backfill(): void {
  if (backfilled) return;
  backfilled = true;
  const count = 90;
  const dt = sim.intervalMs / 1000;
  const now = Date.now();
  for (let i = count; i >= 1; i--) produce(dt, now - i * sim.intervalMs, false);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  if (kickoff) clearTimeout(kickoff);
  timer = null;
  kickoff = null;
}

function scheduleLateHardware(): void {
  if (lateTimer) clearTimeout(lateTimer);
  if (!ALL_HW.some((h) => h.late)) return;
  // LHM's MemoryGroup adds the DIMMs ~10 s after Open(): the sensor set changes → rev + 1.
  lateTimer = setTimeout(() => {
    lateTimer = null;
    if (!agentRunning || restarting) return;
    sensorsState.includeLate = true;
    buildTree();
    emitTree();
  }, 10_000);
}

function startTimer(): void {
  stopTimer();
  lastTick = performance.now();
  // Give subscribers registered in the same tick a moment to attach.
  kickoff = setTimeout(() => {
    kickoff = null;
    backfill();
    emitTree(); // the tree precedes any values of its rev
    tick();
  }, 60);
  timer = setInterval(tick, sim.intervalMs);
}

function applyPollInterval(ms: number): void {
  sim.intervalMs = Math.round(clampN(ms, 250, 10_000));
  if (timer && agentRunning && !restarting) startTimer();
}

let previousBootReported = false;

/** The agent's start-up flag check (§1.5.3) and the watchdog state it produces. */
function agentStarted(): void {
  if (FAILSAFE_PARAM === "interrupted" || FAILSAFE_PARAM === "agentLost") {
    // Same-boot flag: an elevated agent latches every controllable header at 100% (§1.5.4).
    fan.failsafe = !ADMIN0;
    setFailsafe(failsafeOf("interrupted"));
  } else if (FAILSAFE_PARAM === "previousBoot" && !previousBootReported) {
    // The agent deletes a previous-boot flag after reporting it: later restarts report "none".
    previousBootReported = true;
    setFailsafe(failsafeOf("previousBoot"));
  }
  // [NEW 1.1] hello → one `stopped` frameSession; Rust re-sends frameWindow/frameExclude/frames when enabled.
  framesOnHello();
}

let selfUsageTimer: ReturnType<typeof setInterval> | null = null;
let selfCpu = 0.6;

function boot(): void {
  if (booted) return;
  booted = true;
  // Prime one frame so the first tree knows which sensors have values (defaultHidden).
  step(0.05, Date.now() - 91 * sim.intervalMs);
  buildTree();
  if (FAILSAFE_PARAM === "agentLost" && !NO_AGENT) {
    // Rust found the flag at start with no hello yet → agentLost; the restarted agent settles it.
    failsafeState = failsafeOf("agentLost");
    setTimeout(() => {
      agentRunning = true;
      resetSensorProcess();
      agentStarted();
      startTimer();
      scheduleLateHardware();
      emitStatus();
    }, 6000);
  }
  if (agentRunning) {
    agentStarted();
    startTimer();
    scheduleLateHardware();
  }
  setTimeout(emitStatus, 0);
  // self-usage every 5 s (first event 5 s after start), CONTRACT §2.5.
  selfUsageTimer = setInterval(() => {
    if (document.hidden) return;
    selfCpu = clampN(lag(selfCpu, 0.35 + (sensorsState.streamOn ? 0.45 : 0) + Math.random() * 0.25, 5, 12), 0.1, 3);
    const u: SelfUsage = {
      ts: Date.now(),
      cpuPct: r1(selfCpu),
      workingSetMb: Math.round(138 + (sensorsState.streamOn ? 9 : 0) + Math.random() * 6),
      processCount: 6,
    };
    emit("self-usage", u);
  }, 5000);
  void selfUsageTimer;
}

/* ------------------------------------------------------------------ */
/* Static inventory: system, volumes, disks                            */
/* ------------------------------------------------------------------ */

const bootedAt = Date.now() - (3 * 86_400 + 4 * 3_600 + 12 * 60 + 9) * 1000;
let lastDriverScan: string | null = null;

interface OsInfo {
  caption: string;
  version: string;
  build: string;
  displayVersion: string;
  architecture: string;
  installDate: string;
}

const OS_INFO: OsInfo = {
  caption: "Microsoft Windows 11 Pro",
  version: "10.0.26200",
  build: "26200.6899",
  displayVersion: "25H2",
  architecture: "64-bit",
  installDate: OWNER ? "2024-03-09" : "2025-10-04",
};

const BOARD = OWNER
  ? { manufacturer: "Gigabyte Technology Co., Ltd.", product: "B550 GAMING X", version: "x.x" }
  : { manufacturer: "ASUSTeK COMPUTER INC.", product: "ROG CROSSHAIR X670E HERO", version: "Rev 1.xx" };

const BIOS = OWNER
  ? { vendor: "American Megatrends International, LLC.", version: "F19c", releaseDate: "2026-08-18", mode: "UEFI" as const }
  : { vendor: "American Megatrends Inc.", version: "2413", releaseDate: "2025-06-18", mode: "UEFI" as const };

function systemInfo(): SystemInfo {
  return {
    hostname: RIG.hostname,
    cpuName: CPU_WMI_NAME,
    gpuNames: OWNER ? [DGPU_NAME] : [DGPU_NAME, IGPU_NAME],
    motherboard: { ...BOARD },
    bios: { ...BIOS },
    os: { ...OS_INFO },
    secureBoot: true,
    tpm: { present: true, version: "2.0" },
    uptimeSecs: Math.floor((Date.now() - bootedAt) / 1000),
    bootTs: bootedAt,
    isAdmin: !ADMIN0,
    ramTotalGb: RAM_TOTAL_GB,
    lastDriverScan,
  };
}

let systemDriveFreedBytes = 0;

interface VolumeSpec {
  letter: string;
  label: string;
  fileSystem: string;
  totalBytes: number;
  usedFraction: number;
  driveType: Volume["driveType"];
  isSystem: boolean;
}

// Reference rig: C: addlink (~237 GB partition, 49 % used), E: Seagate, F: Crucial P2.
// Labels left empty, as on most real installs ("Local Disk" in Explorer).
const OWNER_VOLUME_SPECS: VolumeSpec[] = [
  { letter: "C:", label: "", fileSystem: "NTFS", totalBytes: 254_481_870_848, usedFraction: 0.49, driveType: "Fixed", isSystem: true },
  { letter: "E:", label: "", fileSystem: "NTFS", totalBytes: 1_000_186_310_656, usedFraction: 0.216, driveType: "Fixed", isSystem: false },
  { letter: "F:", label: "", fileSystem: "NTFS", totalBytes: 1_000_186_310_656, usedFraction: 0.058, driveType: "Fixed", isSystem: false },
];

const DEFAULT_VOLUME_SPECS: VolumeSpec[] = [
  { letter: "C:", label: "Windows", fileSystem: "NTFS", totalBytes: 1_999_461_740_544, usedFraction: 0.61, driveType: "Fixed", isSystem: true },
  { letter: "D:", label: "Games", fileSystem: "NTFS", totalBytes: 1_000_186_310_656, usedFraction: 0.78, driveType: "Fixed", isSystem: false },
  { letter: "E:", label: "Archive", fileSystem: "NTFS", totalBytes: 4_000_768_323_584, usedFraction: 0.47, driveType: "Fixed", isSystem: false },
  ...(WITH_USB
    ? [{ letter: "F:", label: "NEXUM-USB", fileSystem: "exFAT", totalBytes: 61_530_439_680, usedFraction: 0.31, driveType: "Removable" as const, isSystem: false }]
    : []),
];

function volumes(): Volume[] {
  return (OWNER ? OWNER_VOLUME_SPECS : DEFAULT_VOLUME_SPECS).map((v) => {
    let used = Math.round(v.totalBytes * v.usedFraction);
    if (v.isSystem) used = Math.max(0, used - systemDriveFreedBytes);
    return {
      letter: v.letter,
      label: v.label,
      fileSystem: v.fileSystem,
      totalBytes: v.totalBytes,
      freeBytes: v.totalBytes - used,
      usedBytes: used,
      driveType: v.driveType,
      isSystem: v.isSystem,
    };
  });
}

// Windows MSFT_PhysicalDisk keeps reporting "Healthy" for a worn-but-not-failing SSD (44 % life):
// HealthStatus only flips on SMART critical-warning / predictive-failure, not on percentage used.
// Serials are fake. The Crucial's Windows serial differs only by separators (normSerial join).
const OWNER_PHYSICAL_DISKS: PhysicalDisk[] = [
  { deviceId: "0", model: "addlink M.2 PCIE G3x4 NVMe", mediaType: "SSD", busType: "NVMe", sizeBytes: 256_060_514_304, healthStatus: "Healthy", operationalStatus: "OK", serial: "2019_0A1B_2C3D.", volumes: ["C:"], isSystemDisk: true },
  { deviceId: "1", model: "CT1000P2SSD8", mediaType: "SSD", busType: "NVMe", sizeBytes: 1_000_204_886_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "2104E1A2B3C4", volumes: ["F:"], isSystemDisk: false },
  { deviceId: "2", model: "ST1000DM010-2EP102", mediaType: "HDD", busType: "SATA", sizeBytes: 1_000_204_886_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "Z9A1B2C3", volumes: ["E:"], isSystemDisk: false },
];

const DEFAULT_PHYSICAL_DISKS: PhysicalDisk[] = [
  { deviceId: "0", model: "Samsung SSD 990 PRO 2TB", mediaType: "SSD", busType: "NVMe", sizeBytes: 2_000_398_934_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "S73WNJ0W612345A", volumes: ["C:"], isSystemDisk: true },
  { deviceId: "1", model: "WD_BLACK SN850X 1000GB", mediaType: "SSD", busType: "NVMe", sizeBytes: 1_000_204_886_016, healthStatus: DRIVE_FAIL ? "Warning" : "Healthy", operationalStatus: DRIVE_FAIL ? "Degraded" : "OK", serial: "23125L801234", volumes: ["D:"], isSystemDisk: false },
  { deviceId: "2", model: "ST4000DM004-2CV104", mediaType: "HDD", busType: "SATA", sizeBytes: 4_000_787_030_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "ZFN0A1B2", volumes: ["E:"], isSystemDisk: false },
  ...(WITH_USB
    ? [{ deviceId: "3", model: "SanDisk Extreme 64GB", mediaType: "Unspecified" as const, busType: "USB", sizeBytes: 61_530_439_680, healthStatus: "Healthy" as const, operationalStatus: "OK", serial: "4C530001230512", volumes: ["F:"], isSystemDisk: false }]
    : []),
];

/* ------------------------------------------------------------------ */
/* Driver inventory (~180 entries)                                     */
/* ------------------------------------------------------------------ */

interface DriverSpec {
  names: string[];
  cls: string;
  cat: DriverCategory;
  provider: string;
  mfr: string;
  version: string;
  age: number; // days old at preview start
  inf: string;
  hwid: string;
  signed?: boolean;
}

const MS = "Microsoft";
const STD_SYS = "(Standard system devices)";
const MS_SIGNER = "Microsoft Windows";
const WHQL_SIGNER = "Microsoft Windows Hardware Compatibility Publisher";
const INBOX_VER = "10.0.26100.1";
const INBOX_AGE = 610;

function spec(
  name: string | string[],
  count: number,
  cls: string,
  cat: DriverCategory,
  provider: string,
  mfr: string,
  version: string,
  age: number,
  inf: string,
  hwid: string,
  signed = true,
): DriverSpec {
  const names = Array.isArray(name) ? name : Array.from({ length: count }, () => name);
  return { names, cls, cat, provider, mfr, version, age, inf, hwid, signed };
}

const DRIVER_SPECS: DriverSpec[] = [
  // Display
  spec("NVIDIA GeForce RTX 4080", 1, "Display", "Display", "NVIDIA", "NVIDIA", "32.0.15.6614", 48, "oem41.inf", "PCI\\VEN_10DE&DEV_2704&SUBSYS_167A10DE"),
  spec(IGPU_NAME, 1, "Display", "Display", "Advanced Micro Devices, Inc.", "Advanced Micro Devices, Inc.", "31.0.24033.1003", 265, "oem28.inf", "PCI\\VEN_1002&DEV_164E&SUBSYS_88771043"),
  spec("Generic PnP Monitor", 2, "Monitor", "Display", MS, "(Standard monitor types)", INBOX_VER, INBOX_AGE, "monitor.inf", "DISPLAY\\GSM5BBF"),

  // Chipset
  spec("AMD PCI", 1, "System", "Chipset", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "1.0.0.90", 330, "oem17.inf", "PCI\\VEN_1022&DEV_14D8"),
  spec("AMD GPIO Controller", 1, "System", "Chipset", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "2.2.0.130", 330, "oem19.inf", "ACPI\\AMDI0030"),
  spec("AMD SMBus", 1, "System", "Chipset", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "5.12.0.44", 330, "oem21.inf", "PCI\\VEN_1022&DEV_790B"),
  spec("AMD PSP 11.0 Device", 1, "SecurityDevices", "Chipset", "Advanced Micro Devices Inc.", "Advanced Micro Devices Inc.", "5.39.0.0", 210, "oem23.inf", "PCI\\VEN_1022&DEV_1649"),
  spec("AMD I2C Controller", 2, "System", "Chipset", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "1.2.0.124", 330, "oem24.inf", "ACPI\\AMDI0010"),
  spec("AMD Special Tools Driver", 1, "System", "Chipset", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "1.7.16.218", 300, "oem26.inf", "ROOT\\AMDSAFD"),
  spec("PCI Express Root Port", 8, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_14DB"),
  spec("PCI standard host CPU bridge", 6, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_14DA"),
  spec("PCI standard ISA bridge", 1, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_790E"),
  spec("PCI Express Upstream Switch Port", 2, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_43F4"),
  spec("PCI Express Downstream Switch Port", 4, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_43F5"),

  // Network
  spec("Intel(R) Ethernet Controller I226-V", 1, "Net", "Network", "Intel", "Intel", "2.1.4.3", 180, "oem52.inf", "PCI\\VEN_8086&DEV_125C&SUBSYS_88671043"),
  spec("MediaTek Wi-Fi 6E MT7922 (RZ616) 160MHz PCIe Adapter", 1, "Net", "Network", "MediaTek, Inc.", "MediaTek, Inc.", "3.3.0.908", 150, "oem61.inf", "PCI\\VEN_14C3&DEV_0616"),
  spec(
    ["WAN Miniport (IKEv2)", "WAN Miniport (IP)", "WAN Miniport (IPv6)", "WAN Miniport (L2TP)", "WAN Miniport (Network Monitor)", "WAN Miniport (PPPOE)", "WAN Miniport (PPTP)", "WAN Miniport (SSTP)"],
    0, "Net", "Network", MS, MS, INBOX_VER, INBOX_AGE, "netavpna.inf", "SWD\\MSRRAS",
  ),
  spec("Microsoft Kernel Debug Network Adapter", 1, "Net", "Network", MS, MS, INBOX_VER, INBOX_AGE, "kdnic.inf", "ROOT\\KDNIC"),
  spec("Bluetooth Device (Personal Area Network)", 1, "Net", "Network", MS, MS, INBOX_VER, INBOX_AGE, "bthpan.inf", "BTH\\MS_BTHPAN"),

  // Audio
  spec("NVIDIA High Definition Audio", 1, "MEDIA", "Audio", "NVIDIA Corporation", "NVIDIA", "1.4.2.6", 120, "oem43.inf", "HDAUDIO\\FUNC_01&VEN_10DE&DEV_00A5"),
  spec("NVIDIA Virtual Audio Device (Wave Extensible) (WDM)", 1, "MEDIA", "Audio", "NVIDIA", "NVIDIA", "4.65.0.3", 400, "oem46.inf", "USB\\VID_0955&PID_9000"),
  spec("Realtek USB Audio", 1, "MEDIA", "Audio", "Realtek Semiconductor Corp.", "Realtek", "6.3.9600.2355", 1720, "oem33.inf", "USB\\VID_0B05&PID_1A52&MI_00"),
  spec("AMD Streaming Audio Device", 1, "MEDIA", "Audio", "Advanced Micro Devices, Inc", "Advanced Micro Devices, Inc", "1.0.0.15", 330, "oem31.inf", "ROOT\\AMDSAFD&FUN_01"),
  spec("Microsoft Streaming Service Proxy", 1, "MEDIA", "Audio", MS, MS, INBOX_VER, INBOX_AGE, "ksfilter.inf", "SW\\{96E080C7-143C-11D1-B40F-00A0C9223196}"),
  spec(
    [
      "Speakers (Realtek USB Audio)",
      "Realtek Digital Output (Realtek USB Audio)",
      "Microphone (Realtek USB Audio)",
      "LG ULTRAGEAR (NVIDIA High Definition Audio)",
      "Headset Earphone (HyperX Cloud Alpha Wireless)",
      "Headset Microphone (HyperX Cloud Alpha Wireless)",
    ],
    0, "AudioEndpoint", "Audio", MS, MS, INBOX_VER, INBOX_AGE, "audioendpoint.inf", "SWD\\MMDEVAPI",
  ),
  spec("USB Audio Device", 1, "MEDIA", "Audio", MS, "(Generic USB Audio)", INBOX_VER, INBOX_AGE, "wdma_usb.inf", "USB\\VID_03F0&PID_098D&MI_00"),

  // Storage
  spec("Samsung NVMe Controller", 1, "SCSIAdapter", "Storage", "Samsung Electronics Co., Ltd.", "Samsung Electronics Co., Ltd.", "3.3.0.2003", 1460, "oem12.inf", "PCI\\VEN_144D&DEV_A80C"),
  spec("Standard NVM Express Controller", 1, "SCSIAdapter", "Storage", MS, "Standard NVM Express Controller", INBOX_VER, INBOX_AGE, "stornvme.inf", "PCI\\VEN_15B7&DEV_5030"),
  spec("Standard SATA AHCI Controller", 1, "HDC", "Storage", MS, "Standard SATA AHCI Controller", INBOX_VER, INBOX_AGE, "mshdc.inf", "PCI\\VEN_1022&DEV_43F6"),
  spec(["Samsung SSD 990 PRO 2TB", "WD_BLACK SN850X 1000GB", "ST4000DM004-2CV104"], 0, "DiskDrive", "Storage", MS, "(Standard disk drives)", INBOX_VER, INBOX_AGE, "disk.inf", "SCSI\\DISK"),
  spec("Microsoft Storage Spaces Controller", 1, "SCSIAdapter", "Storage", MS, MS, INBOX_VER, INBOX_AGE, "spaceport.inf", "ROOT\\SPACEPORT"),
  spec("Generic volume", 5, "Volume", "Storage", MS, MS, INBOX_VER, INBOX_AGE, "volume.inf", "STORAGE\\VOLUME"),
  spec("Volume Manager", 1, "System", "Storage", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ROOT\\VOLMGR"),

  // USB
  spec("AMD USB 3.10 eXtensible Host Controller - 1.10 (Microsoft)", 4, "USB", "USB", MS, "Generic USB xHCI Host Controller", INBOX_VER, INBOX_AGE, "usbxhci.inf", "PCI\\VEN_1022&DEV_15B6"),
  spec("USB Root Hub (USB 3.0)", 4, "USB", "USB", MS, "(Generic USB Hub)", INBOX_VER, INBOX_AGE, "usbhub3.inf", "USB\\ROOT_HUB30"),
  spec("Generic USB Hub", 3, "USB", "USB", MS, "(Generic USB Hub)", INBOX_VER, INBOX_AGE, "usb.inf", "USB\\VID_05E3&PID_0610"),
  spec("USB Composite Device", 5, "USB", "USB", MS, "(Standard USB Host Controller)", INBOX_VER, INBOX_AGE, "usb.inf", "USB\\VID_046D&PID_C547"),
  spec("ASMedia USB 3.2 eXtensible Host Controller", 1, "USB", "USB", "ASMedia Technology Inc", "ASMedia Technology Inc", "1.16.61.1", 1910, "oem14.inf", "PCI\\VEN_1B21&DEV_3241"),
  spec("USB Mass Storage Device", 1, "USB", "USB", MS, "Compatible USB storage device", INBOX_VER, INBOX_AGE, "usbstor.inf", "USB\\VID_0781&PID_5583"),
  spec("AURA LED Controller", 1, "USB", "USB", "ASUSTeK Computer Inc.", "ASUSTeK Computer Inc.", "1.0.0.12", 700, "oem71.inf", "USB\\VID_0B05&PID_19AF"),

  // Bluetooth
  spec("MediaTek Bluetooth Adapter", 1, "Bluetooth", "Bluetooth", "MediaTek, Inc.", "MediaTek, Inc.", "1.1037.0.395", 150, "oem63.inf", "USB\\VID_0E8D&PID_0616"),
  spec("Microsoft Bluetooth Enumerator", 1, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "bth.inf", "BTH\\MS_BTHBRB"),
  spec("Microsoft Bluetooth LE Enumerator", 1, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "bthleenum.inf", "BTH\\MS_BTHLE"),
  spec("Bluetooth Device (RFCOMM Protocol TDI)", 1, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "tdibth.inf", "BTH\\MS_RFCOMM"),
  spec("Bluetooth LE Generic Attribute Service", 4, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "bthleenum.inf", "BTHLEDEVICE\\{00001801-0000-1000-8000-00805F9B34FB}"),
  spec("Xbox Wireless Controller", 1, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "xinputhid.inf", "BTHLE\\DEV_XBOXCTRL"),
  spec("Microsoft Bluetooth Avrcp Transport Driver", 1, "Bluetooth", "Bluetooth", MS, MS, INBOX_VER, INBOX_AGE, "bthavrcp.inf", "BTHENUM\\{0000110E-0000-1000-8000-00805F9B34FB}"),

  // Firmware
  spec("System Firmware", 1, "Firmware", "Firmware", "ASUSTeK COMPUTER INC.", "ASUSTeK COMPUTER INC.", "2413.0.0.0", 160, "oem3.inf", "UEFI\\RES_{A7B1C2D3-0001-4A5B-9C8D-7E6F5A4B3C2D}"),
  spec("Device Firmware", 1, "Firmware", "Firmware", "Intel", "Intel", "2.17.0.0", 180, "oem53.inf", "UEFI\\RES_{3C2D1E0F-0002-4B6C-8D9E-0F1A2B3C4D5E}"),

  // Input
  spec("HID Keyboard Device", 3, "Keyboard", "Input", MS, "(Standard keyboards)", INBOX_VER, INBOX_AGE, "keyboard.inf", "HID\\VID_046D&PID_C33F&MI_00"),
  spec("HID-compliant mouse", 2, "Mouse", "Input", MS, MS, INBOX_VER, INBOX_AGE, "msmouse.inf", "HID\\VID_046D&PID_C547&MI_01"),
  spec("HID-compliant consumer control device", 4, "HIDClass", "Input", MS, MS, INBOX_VER, INBOX_AGE, "hidserv.inf", "HID\\VID_046D&PID_C33F&MI_01&COL01"),
  spec("HID-compliant system controller", 2, "HIDClass", "Input", MS, "(Standard system devices)", INBOX_VER, INBOX_AGE, "machine.inf", "HID\\VID_046D&PID_C33F&MI_01&COL02"),
  spec("HID-compliant vendor-defined device", 7, "HIDClass", "Input", MS, "(Standard system devices)", INBOX_VER, INBOX_AGE, "input.inf", "HID\\VID_0B05&PID_19AF&COL01"),
  spec("USB Input Device", 6, "HIDClass", "Input", MS, "(Standard system devices)", INBOX_VER, INBOX_AGE, "input.inf", "USB\\VID_046D&PID_C33F&MI_00"),
  spec("Logitech G HUB Virtual Bus Enumerator", 1, "System", "Input", "Logitech", "Logitech", "2021.3.9205.0", 1820, "oem88.inf", "ROOT\\LGHUBVIRTUALBUS"),
  spec("Logitech G HUB Virtual Mouse", 1, "Mouse", "Input", "Logitech", "Logitech", "2021.3.9205.0", 1820, "oem89.inf", "LGHUBDEVICE\\VID_046D&PID_C231"),
  spec("Third-party HID Filter Driver (macro tool)", 1, "HIDClass", "Input", "Unknown Publisher", "Unknown", "1.0.4.0", 1290, "oem94.inf", "ROOT\\HIDFILTER", false),

  // System
  spec(CPU_WMI_NAME, THREADS, "Processor", "System", MS, "Advanced Micro Devices", INBOX_VER, INBOX_AGE, "cpu.inf", "ACPI\\AuthenticAMD_-_AMD64_Family_25_Model_97"),
  spec("ACPI x64-based PC", 1, "Computer", "System", MS, "(Standard computers)", INBOX_VER, INBOX_AGE, "hal.inf", "ROOT\\ACPI_HAL"),
  spec("Microsoft ACPI-Compliant System", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "acpi.inf", "ACPI_HAL\\PNP0C08"),
  spec("ACPI Fixed Feature Button", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\FIXEDBUTTON"),
  spec("ACPI Power Button", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\PNP0C0C"),
  spec(
    ["System timer", "High precision event timer", "Programmable interrupt controller", "System CMOS/real time clock", "Direct memory access controller", "System speaker"],
    0, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\PNP0100",
  ),
  spec("Composite Bus Enumerator", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "compositebus.inf", "ROOT\\CompositeBus"),
  spec("UMBus Root Bus Enumerator", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "umbus.inf", "root\\umbus"),
  spec("Plug and Play Software Device Enumerator", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "swenum.inf", "ROOT\\SWENUM"),
  spec("Remote Desktop Device Redirector Bus", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "rdpbus.inf", "ROOT\\RDPBUS"),
  spec("Microsoft System Management BIOS Driver", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "mssmbios.inf", "ROOT\\mssmbios"),
  spec("Trusted Platform Module 2.0", 1, "SecurityDevices", "System", MS, "(Standard)", INBOX_VER, INBOX_AGE, "tpm.inf", "ACPI\\MSFT0101"),
  spec("Microsoft Windows Management Interface for ACPI", 2, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "wmiacpi.inf", "ACPI\\PNP0C14"),
  spec("Motherboard resources", 3, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\PNP0C02"),
  spec("Microsoft Virtual Drive Enumerator", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "vdrvroot.inf", "ROOT\\vdrvroot"),
  spec("NDIS Virtual Network Adapter Enumerator", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "ndisvirtualbus.inf", "ROOT\\NdisVirtualBus"),
  spec("Legacy Hardware Monitor Port I/O Driver", 1, "System", "System", "Unknown Publisher", "Unknown", "1.2.0.0", 2600, "oem97.inf", "ROOT\\LEGACYPORTIO", false),

  // Other
  spec("Microsoft Print to PDF", 1, "PrintQueue", "Other", MS, MS, INBOX_VER, INBOX_AGE, "printqueue.inf", "SWD\\PRINTENUM\\PRINTQUEUES"),
  spec("Root Print Queue", 1, "PrintQueue", "Other", MS, MS, INBOX_VER, INBOX_AGE, "printqueue.inf", "SWD\\PRINTENUM\\{ROOT}"),
  spec("Fax", 1, "PrintQueue", "Other", MS, MS, INBOX_VER, INBOX_AGE, "printqueue.inf", "SWD\\PRINTENUM\\{FAX}"),
  spec("NVIDIA Platform Controllers and Framework", 1, "SoftwareComponent", "Other", "NVIDIA", "NVIDIA", "32.0.15.6614", 48, "oem42.inf", "SWC\\NVIDIA_PLATFORM"),
];

// Owner rig driver inventory: AMD GPU/chipset, Realtek LAN + ALC audio, no Wi-Fi/Bluetooth adapter.
const AMD_INC = "Advanced Micro Devices, Inc.";
const AMD_INC2 = "Advanced Micro Devices, Inc";
const OWNER_DRIVER_SPECS: DriverSpec[] = [
  // Display
  spec(OWNER_RIG.dgpuName, 1, "Display", "Display", AMD_INC, AMD_INC, "32.0.21025.1024", 26, "oem58.inf", "PCI\\VEN_1002&DEV_7550&SUBSYS_24171458"),
  spec("Generic PnP Monitor", 1, "Monitor", "Display", MS, "(Standard monitor types)", INBOX_VER, INBOX_AGE, "monitor.inf", "DISPLAY\\AUS27AF"),

  // Chipset (AMD B550 / Vermeer)
  spec("AMD PCI", 1, "System", "Chipset", AMD_INC2, AMD_INC2, "1.0.0.90", 330, "oem17.inf", "PCI\\VEN_1022&DEV_1480"),
  spec("AMD GPIO Controller", 1, "System", "Chipset", AMD_INC2, AMD_INC2, "2.2.0.130", 330, "oem19.inf", "ACPI\\AMDI0030"),
  spec("AMD SMBus", 1, "System", "Chipset", AMD_INC2, AMD_INC2, "5.12.0.44", 330, "oem21.inf", "PCI\\VEN_1022&DEV_790B"),
  spec("AMD PSP 11.0 Device", 1, "SecurityDevices", "Chipset", "Advanced Micro Devices Inc.", "Advanced Micro Devices Inc.", "5.39.0.0", 210, "oem23.inf", "PCI\\VEN_1022&DEV_1486"),
  spec("AMD Ryzen Power Plan", 1, "System", "Chipset", AMD_INC2, AMD_INC2, "8.0.0.13", 330, "oem25.inf", "ROOT\\AMDPPM"),
  spec("PCI Express Root Port", 6, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_1483"),
  spec("PCI standard host CPU bridge", 4, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_1482"),
  spec("PCI standard ISA bridge", 1, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_790E"),
  spec("PCI Express Upstream Switch Port", 2, "System", "Chipset", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "PCI\\VEN_1022&DEV_43EE"),

  // Network
  spec("Realtek Gaming GbE Family Controller", 1, "Net", "Network", "Realtek", "Realtek", "10.68.815.2023", 400, "oem36.inf", "PCI\\VEN_10EC&DEV_8168&SUBSYS_E0001458"),
  spec(
    ["WAN Miniport (IKEv2)", "WAN Miniport (IP)", "WAN Miniport (IPv6)", "WAN Miniport (L2TP)", "WAN Miniport (Network Monitor)", "WAN Miniport (PPPOE)", "WAN Miniport (PPTP)", "WAN Miniport (SSTP)"],
    0, "Net", "Network", MS, MS, INBOX_VER, INBOX_AGE, "netavpna.inf", "SWD\\MSRRAS",
  ),
  spec("Microsoft Kernel Debug Network Adapter", 1, "Net", "Network", MS, MS, INBOX_VER, INBOX_AGE, "kdnic.inf", "ROOT\\KDNIC"),

  // Audio
  spec("Realtek High Definition Audio", 1, "MEDIA", "Audio", "Realtek Semiconductor Corp.", "Realtek", "6.0.9239.1", 1250, "oem40.inf", "HDAUDIO\\FUNC_01&VEN_10EC&DEV_0887&SUBSYS_1458A182"),
  spec("AMD High Definition Audio Device", 1, "MEDIA", "Audio", AMD_INC, AMD_INC, "10.0.1.36", 26, "oem59.inf", "HDAUDIO\\FUNC_01&VEN_1002&DEV_AA01"),
  spec("AMD Streaming Audio Device", 1, "MEDIA", "Audio", AMD_INC, AMD_INC, "1.0.0.15", 26, "oem60.inf", "ROOT\\AMDSAFD&FUN_01"),
  spec(
    ["Speakers (Realtek High Definition Audio)", "Realtek Digital Output (Realtek High Definition Audio)", "Microphone (Realtek High Definition Audio)", "VG27AQ (AMD High Definition Audio Device)"],
    0, "AudioEndpoint", "Audio", MS, MS, INBOX_VER, INBOX_AGE, "audioendpoint.inf", "SWD\\MMDEVAPI",
  ),

  // Storage
  spec("Standard NVM Express Controller", 2, "SCSIAdapter", "Storage", MS, "Standard NVM Express Controller", INBOX_VER, INBOX_AGE, "stornvme.inf", "PCI\\VEN_1DBE&DEV_5236"),
  spec("Standard SATA AHCI Controller", 1, "HDC", "Storage", MS, "Standard SATA AHCI Controller", INBOX_VER, INBOX_AGE, "mshdc.inf", "PCI\\VEN_1022&DEV_43EB"),
  spec(["addlink M.2 PCIE G3x4 NVMe", "CT1000P2SSD8", "ST1000DM010-2EP102"], 0, "DiskDrive", "Storage", MS, "(Standard disk drives)", INBOX_VER, INBOX_AGE, "disk.inf", "SCSI\\DISK"),
  spec("Generic volume", 4, "Volume", "Storage", MS, MS, INBOX_VER, INBOX_AGE, "volume.inf", "STORAGE\\VOLUME"),
  spec("Volume Manager", 1, "System", "Storage", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ROOT\\VOLMGR"),

  // USB
  spec("AMD USB 3.10 eXtensible Host Controller - 1.10 (Microsoft)", 2, "USB", "USB", MS, "Generic USB xHCI Host Controller", INBOX_VER, INBOX_AGE, "usbxhci.inf", "PCI\\VEN_1022&DEV_149C"),
  spec("USB Root Hub (USB 3.0)", 2, "USB", "USB", MS, "(Generic USB Hub)", INBOX_VER, INBOX_AGE, "usbhub3.inf", "USB\\ROOT_HUB30"),
  spec("Generic USB Hub", 2, "USB", "USB", MS, "(Generic USB Hub)", INBOX_VER, INBOX_AGE, "usb.inf", "USB\\VID_05E3&PID_0610"),
  spec("USB Composite Device", 3, "USB", "USB", MS, "(Standard USB Host Controller)", INBOX_VER, INBOX_AGE, "usb.inf", "USB\\VID_046D&PID_C547"),

  // Firmware
  spec("System Firmware", 1, "Firmware", "Firmware", "Gigabyte", "Gigabyte", "19.3.0.0", 101, "oem3.inf", "UEFI\\RES_{B550A1B2-0001-4A5B-9C8D-7E6F5A4B3C2D}"),

  // Input
  spec("HID Keyboard Device", 2, "Keyboard", "Input", MS, "(Standard keyboards)", INBOX_VER, INBOX_AGE, "keyboard.inf", "HID\\VID_046D&PID_C33F&MI_00"),
  spec("HID-compliant mouse", 2, "Mouse", "Input", MS, MS, INBOX_VER, INBOX_AGE, "msmouse.inf", "HID\\VID_046D&PID_C547&MI_01"),
  spec("HID-compliant consumer control device", 3, "HIDClass", "Input", MS, MS, INBOX_VER, INBOX_AGE, "hidserv.inf", "HID\\VID_046D&PID_C33F&MI_01&COL01"),
  spec("HID-compliant vendor-defined device", 4, "HIDClass", "Input", MS, "(Standard system devices)", INBOX_VER, INBOX_AGE, "input.inf", "HID\\VID_046D&PID_C547&COL01"),
  spec("USB Input Device", 4, "HIDClass", "Input", MS, "(Standard system devices)", INBOX_VER, INBOX_AGE, "input.inf", "USB\\VID_046D&PID_C33F&MI_00"),

  // System
  spec(OWNER_RIG.cpuWmiName, OWNER_RIG.threads, "Processor", "System", MS, "Advanced Micro Devices", INBOX_VER, INBOX_AGE, "cpu.inf", "ACPI\\AuthenticAMD_-_AMD64_Family_25_Model_33"),
  spec("ACPI x64-based PC", 1, "Computer", "System", MS, "(Standard computers)", INBOX_VER, INBOX_AGE, "hal.inf", "ROOT\\ACPI_HAL"),
  spec("Microsoft ACPI-Compliant System", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "acpi.inf", "ACPI_HAL\\PNP0C08"),
  spec(
    ["System timer", "High precision event timer", "Programmable interrupt controller", "System CMOS/real time clock", "Direct memory access controller"],
    0, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\PNP0100",
  ),
  spec("Composite Bus Enumerator", 1, "System", "System", MS, MS, INBOX_VER, INBOX_AGE, "compositebus.inf", "ROOT\\CompositeBus"),
  spec("Plug and Play Software Device Enumerator", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "swenum.inf", "ROOT\\SWENUM"),
  spec("Microsoft System Management BIOS Driver", 1, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "mssmbios.inf", "ROOT\\mssmbios"),
  spec("Trusted Platform Module 2.0", 1, "SecurityDevices", "System", MS, "(Standard)", INBOX_VER, INBOX_AGE, "tpm.inf", "ACPI\\MSFT0101"),
  spec("Motherboard resources", 3, "System", "System", MS, STD_SYS, INBOX_VER, INBOX_AGE, "machine.inf", "ACPI\\PNP0C02"),

  // Other
  spec("Microsoft Print to PDF", 1, "PrintQueue", "Other", MS, MS, INBOX_VER, INBOX_AGE, "printqueue.inf", "SWD\\PRINTENUM\\PRINTQUEUES"),
  spec("Root Print Queue", 1, "PrintQueue", "Other", MS, MS, INBOX_VER, INBOX_AGE, "printqueue.inf", "SWD\\PRINTENUM\\{ROOT}"),
];


let driverCache: DriverInfo[] | null = null;
const inventoryEpoch = Date.now();

/** Devices with a Windows problem code (ConfigManagerErrorCode): code ∉ {0,22,45} → status "problem". */
interface ProblemDevice {
  name: string;
  cls: string;
  cat: DriverCategory;
  provider: string;
  inf: string;
  hwid: string;
  code: number;
}

const PROBLEM_DEVICES: ProblemDevice[] = OWNER
  ? [
      // Code 28: drivers not installed. Code 45: not connected (shown neutrally).
      { name: "PCI Simple Communications Controller", cls: "Other", cat: "Chipset", provider: "", inf: "", hwid: "PCI\\VEN_1022&DEV_1485", code: 28 },
      { name: "USB Mass Storage Device", cls: "USB", cat: "USB", provider: MS, inf: "usbstor.inf", hwid: "USB\\VID_0781&PID_5583", code: 45 },
    ]
  : [
      { name: "Unknown USB Device (Device Descriptor Request Failed)", cls: "USB", cat: "USB", provider: MS, inf: "usb.inf", hwid: "USB\\VID_0000&PID_0002", code: 43 },
      // Code 22: disabled by the user (shown neutrally).
      { name: "Microsoft Wi-Fi Direct Virtual Adapter", cls: "Net", cat: "Network", provider: MS, inf: "netvwifimp.inf", hwid: "{5D624F94-8850-40C3-A3FA-A4FD2080BAF3}\\VWIFIMP_WFD", code: 22 },
    ];

function buildDrivers(): DriverInfo[] {
  if (driverCache) return driverCache;
  const rng = mulberry32(0x4e58554d);
  const hex = (len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += "0123456789ABCDEF"[Math.floor(rng() * 16)];
    return s;
  };
  const list: DriverInfo[] = [];
  for (const sp of OWNER ? OWNER_DRIVER_SPECS : DRIVER_SPECS) {
    sp.names.forEach((name, idx) => {
      const ageDays = sp.age;
      const signed = sp.signed !== false;
      list.push({
        deviceName: name,
        deviceClass: sp.cls,
        category: sp.cat,
        provider: sp.provider,
        manufacturer: sp.mfr,
        version: sp.version,
        date: isoDate(inventoryEpoch - ageDays * DAY_MS),
        signed,
        signer: !signed ? "" : sp.provider === MS ? MS_SIGNER : WHQL_SIGNER,
        infName: sp.inf,
        deviceId: `${sp.hwid}\\${idx}&${hex(8)}&0&${hex(4)}`,
        ageDays,
        // CONTRACT §2.7: problem > unsigned > ok. Age is information only.
        status: !signed ? "unsigned" : "ok",
        problemCode: null,
        isInbox: !/^oem\d+\.inf$/i.test(sp.inf),
      });
    });
  }
  for (const p of PROBLEM_DEVICES) {
    const neutral = p.code === 22 || p.code === 45;
    list.push({
      deviceName: p.name,
      deviceClass: p.cls,
      category: p.cat,
      provider: p.provider,
      manufacturer: p.provider || "(Unknown)",
      version: p.inf ? INBOX_VER : "",
      date: p.inf ? isoDate(inventoryEpoch - INBOX_AGE * DAY_MS) : "",
      signed: !!p.inf,
      signer: p.inf ? MS_SIGNER : "",
      infName: p.inf,
      deviceId: `${p.hwid}\\${hex(6)}&0`,
      ageDays: p.inf ? INBOX_AGE : null,
      status: neutral ? "ok" : "problem",
      problemCode: p.code,
      isInbox: !/^oem\d+\.inf$/i.test(p.inf),
    });
  }
  driverCache = list;
  return list;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function driversToCsv(list: DriverInfo[]): string {
  const cols: Array<keyof DriverInfo> = [
    "deviceName", "deviceClass", "category", "provider", "manufacturer", "version",
    "date", "signed", "signer", "infName", "deviceId", "ageDays", "status", "problemCode", "isInbox",
  ];
  const lines = [cols.join(",")];
  for (const d of list) lines.push(cols.map((c) => csvEscape(d[c])).join(","));
  return lines.join("\r\n");
}

function triggerDownload(filename: string, content: string, mime: string): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (err) {
    console.warn("[nexum mock] download failed", err);
  }
}

function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ */
/* Cache cleanup simulation (CONTRACT §3)                              */
/* ------------------------------------------------------------------ */

interface CacheDef {
  id: TrashCategoryId;
  label: string;
  description: string;
  /** Size when elevated. */
  gb: number;
  files: number;
  /** Fraction that is readable / deletable without elevation (temp: user %TEMP% only). */
  userFraction?: number;
  defaultOn: boolean;
  optional: boolean;
  requiresAdmin: boolean;
  /** Fraction of bytes skipped by rules 8/9 (apps open, update pending), with its note. */
  skipped?: { fraction: number; note: string };
}

const SHADER_FOLDERS = OWNER ? "DxCache, DxcCache, VkCache, GLCache" : "DXCache, GLCache, NV_Cache, DxCache, DxcCache, VkCache, GLCache";
const MEMORY_DUMP_DATE = "2025-10-02";

const CACHE_DEFS: CacheDef[] = [
  { id: "temp", label: "Temporary files", description: "Files in your Temp folder and the Windows Temp folder that are more than 24 hours old.", gb: 1.73, files: 5214, userFraction: 0.62, defaultOn: true, optional: false, requiresAdmin: false },
  {
    id: "wu-cache",
    label: "Windows Update cache",
    description: "Downloaded update files more than 24 hours old, plus the Delivery Optimization cache through Microsoft's own cleanup command.",
    gb: 0.98,
    files: 47,
    defaultOn: true,
    optional: false,
    requiresAdmin: true,
    ...(OWNER ? { skipped: { fraction: 0.71, note: "Skipped the Windows Update download cache: an update is waiting to install or restart." } } : {}),
  },
  { id: "logs", label: "Error reports and old logs", description: "Windows Error Reporting queue and archive, and component servicing logs older than 30 days.", gb: 0.21, files: 186, defaultOn: true, optional: false, requiresAdmin: true },
  { id: "dumps", label: "Old crash dumps", description: "Keeps the 5 newest dumps and anything less than 30 days old. Windows and support staff use dumps to diagnose crashes.", gb: 0.13, files: 9, defaultOn: false, optional: true, requiresAdmin: true },
  ...(OWNER
    ? [
        {
          id: "memory-dump" as const,
          label: "Full memory dump (MEMORY.DMP)",
          description: `Written by Windows after a system crash (${MEMORY_DUMP_DATE}, 1.9 GB). Delete it only if you do not need it for troubleshooting.`,
          gb: 1.9,
          files: 1,
          defaultOn: false,
          optional: true,
          requiresAdmin: true,
        },
      ]
    : []),
  { id: "shader", label: "Shader caches", description: `Only clear if a game shows corrupted graphics. Expect stutter while caches rebuild. Folders: ${SHADER_FOLDERS}.`, gb: 0.56, files: 2906, defaultOn: false, optional: true, requiresAdmin: false },
  { id: "recycle", label: "Recycle Bin", description: "Permanently deletes everything in the Recycle Bin.", gb: 1.21, files: 318, defaultOn: false, optional: true, requiresAdmin: false },
  {
    id: "browser",
    label: "Browser and Discord caches",
    description: "Chrome, Edge, Firefox and Discord caches. Logins, cookies and history are kept.",
    gb: 0.74,
    files: 8120,
    defaultOn: false,
    optional: true,
    requiresAdmin: false,
    skipped: OWNER ? { fraction: 0.38, note: "Skipped: Discord is open." } : { fraction: 0.55, note: "Skipped: Chrome and Discord are open." },
  },
];

const NEEDS_ADMIN_NOTE = "Needs administrator rights.";
const lastCleanAt: Partial<Record<TrashCategoryId, number>> = {};
let purgeRunning = false;

/** Cleaned categories regrow slowly so repeated demos stay believable. */
function regrowth(id: TrashCategoryId): number {
  const t = lastCleanAt[id];
  if (t == null) return 1;
  return clampN(0.015 + (Date.now() - t) / (10 * 60 * 1000), 0, 1);
}

function available(def: CacheDef): boolean {
  return !(def.requiresAdmin && ADMIN0);
}

/** Bytes/files this session can act on (rules 8/9 exclusions applied). */
function cleanable(def: CacheDef, recycleMinAgeDays: number | null = settings.recycleMinAgeDays): { bytes: number; files: number } {
  if (def.id === "recycle") {
    // [NEW 1.1] Real items with deletion dates (§3.2); a purge removes them.
    const q = recycleQualifying(recycleMinAgeDays);
    return { bytes: q.reduce((s, x) => s + x.bytes, 0), files: q.length };
  }
  const f = regrowth(def.id) * (def.id === "temp" && ADMIN0 ? def.userFraction ?? 1 : 1);
  const keep = def.skipped ? 1 - def.skipped.fraction : 1;
  return { bytes: Math.round(def.gb * GIB * f * keep), files: Math.round(def.files * f * keep) };
}

function toCategory(def: CacheDef, includeBrowser: boolean, recycleMinAgeDays: number | null = settings.recycleMinAgeDays): TrashCategory {
  const avail = available(def);
  const { bytes, files } = cleanable(def, recycleMinAgeDays);
  const ageNote = def.id === "recycle" && recycleMinAgeDays != null ? `Keeps items deleted in the last ${dayWord(recycleMinAgeDays)}.` : null;
  return {
    id: def.id,
    label: def.label,
    description:
      def.id === "recycle" && recycleMinAgeDays != null
        ? `Permanently deletes items that have been in the Recycle Bin for more than ${dayWord(recycleMinAgeDays)}.`
        : def.description,
    bytes,
    files,
    enabled: avail && (def.id === "browser" ? includeBrowser && def.defaultOn : def.defaultOn),
    optional: def.optional,
    requiresAdmin: def.requiresAdmin,
    available: avail,
    unavailableReason: avail ? null : "needsAdmin",
    note: !avail ? NEEDS_ADMIN_NOTE : (ageNote ?? def.skipped?.note ?? null),
  };
}

/* ------------------------------------------------------------------ */
/* System spec (CONTRACT §1.4, §2.6)                                   */
/* ------------------------------------------------------------------ */

const INSTR_BASE = ["MMX", "SSE", "SSE2", "SSE3", "SSSE3", "SSE4.1", "SSE4.2", "SSE4A", "AES", "AVX", "AVX2"];

/* ── [NEW 1.1] System view full (CONTRACT §1.4.1) ── */

const TIMINGS_NOTE = {
  notElevated: "Live timings need administrator rights.",
  pawnIo: "Live timings need the PawnIO driver.",
  unsupported: "Live timings are only read on AMD Ryzen (Zen 1 to Zen 3) with DDR4.",
} as const;

/** JEDEC minimum times (ns) → cycles at `mts`: ceil(ns / (2000 / mts) − 0.025). */
function spdInfo(mts: number | null, ns: SpdInfo["timingsNs"], tempC: number | null): SpdInfo {
  const cyc = (v: number | null) => (v == null || mts == null ? null : Math.ceil(v / (2000 / mts) - 0.025));
  return {
    source: "jedec",
    jedecSpeedMts: mts,
    timingsNs: ns,
    cycles: {
      cl: cyc(ns.tAA),
      rcd: cyc(ns.tRCD),
      rp: cyc(ns.tRP),
      ras: cyc(ns.tRAS),
      rc: cyc(ns.tRC),
      rfc: cyc(ns.tRFC1),
      faw: cyc(ns.tFAW),
      rrds: cyc(ns.tRRD_S),
      rrdl: cyc(ns.tRRD_L),
      wr: cyc(ns.tWR),
      wtrs: cyc(ns.tWTR_S),
      wtrl: cyc(ns.tWTR_L),
    },
    tempC,
    matchedBy: "order",
  };
}

/** DDR4-2666 JEDEC (19-19-19, 16 Gb dies) minimum times. */
const DDR4_2666_NS: SpdInfo["timingsNs"] = {
  tAA: 14.25, tRCD: 14.25, tRP: 14.25, tRAS: 32, tRC: 46.25, tRFC1: 350, tRFC2: 260, tRFC4: 160,
  tFAW: 21, tRRD_S: 3, tRRD_L: 4.9, tCCD_L: 5.355, tWR: 15, tWTR_S: 2.5, tWTR_L: 7.5,
};

/** DDR5-4800 JEDEC (40-39-39) minimum times; keys LHM does not report for DDR5 stay null. */
const DDR5_4800_NS: SpdInfo["timingsNs"] = {
  tAA: 16.666, tRCD: 16.25, tRP: 16.25, tRAS: 32, tRC: 48.25, tRFC1: 295, tRFC2: 160, tRFC4: null,
  tFAW: 13.333, tRRD_S: 3.333, tRRD_L: 5, tCCD_L: 5, tWR: 30, tWTR_S: 2.5, tWTR_L: 10,
};

function memorySpec(): MemorySpec {
  // SPD needs elevation + PawnIO (LHM DimmMemory); live UMC timings additionally need Zen 1–3 + DDR4.
  const spdOk = !NO_RING0;
  if (OWNER) {
    const dimms = ["DIMM_A2", "DIMM_B2"].map((slot) => ({
      slot,
      manufacturer: "G.Skill",
      partNumber: "F4-3600C16-16GVKC",
      sizeGb: 16,
      speedMts: 2666,
      configuredSpeedMts: 3600,
      ranks: 1,
      voltage: 1.35,
      formFactor: "DIMM",
      spd: spdOk ? spdInfo(2666, DDR4_2666_NS, null) : null,
    }));
    const live = !ADMIN0 && PAWNIO_STATE === "ok";
    return {
      type: "DDR4",
      totalGb: 32,
      channels: 2,
      slotsUsed: 2,
      slotsTotal: 4,
      dimms,
      timings: live
        ? { cl: 16, rcdRd: 19, rcdWr: 19, rp: 19, ras: 39, rc: 58, rfc: 630, rrds: 6, rrdl: 9, faw: 36, wtrs: 4, wtrl: 12, wr: 24, rtp: 12, cwl: 16, commandRate: "1T", gearDown: true }
        : null,
      timingsSource: live ? "umc" : "unavailable",
      timingsNote: live ? null : ADMIN0 ? TIMINGS_NOTE.notElevated : TIMINGS_NOTE.pawnIo,
      // UMC ratio when live, else configuredSpeedMts / 2: 1800 either way for DDR4-3600.
      memclkMhz: 1800,
      fclkMhz: NO_RING0 ? null : 1800,
      uclkMhz: NO_RING0 ? null : 1800,
      xmp: null,
    };
  }
  const dimms = ["DIMM_A2", "DIMM_B2"].map((slot) => ({
    slot,
    manufacturer: "G.Skill",
    partNumber: "F5-6000J3038F32G",
    sizeGb: 32,
    speedMts: 4800,
    configuredSpeedMts: 6000,
    ranks: 2,
    voltage: 1.35,
    formFactor: "DIMM",
    spd: spdOk ? spdInfo(4800, DDR5_4800_NS, r1(rand(38, 41))) : null,
  }));
  const first = dimms[0].spd;
  return {
    type: "DDR5",
    totalGb: 64,
    channels: 2,
    slotsUsed: 2,
    slotsTotal: 4,
    dimms,
    // Zen 4 + DDR5: no live read; the first DIMM's SPD JEDEC cycles are the fallback.
    timings: first
      ? {
          cl: first.cycles.cl, rcdRd: first.cycles.rcd, rcdWr: first.cycles.rcd, rp: first.cycles.rp, ras: first.cycles.ras,
          rc: first.cycles.rc, rfc: first.cycles.rfc, rrds: first.cycles.rrds, rrdl: first.cycles.rrdl, faw: first.cycles.faw,
          wtrs: first.cycles.wtrs, wtrl: first.cycles.wtrl, wr: first.cycles.wr, rtp: null, cwl: null, commandRate: null, gearDown: null,
        }
      : null,
    timingsSource: first ? "spd" : "unavailable",
    timingsNote: ADMIN0 ? TIMINGS_NOTE.notElevated : NO_RING0 ? TIMINGS_NOTE.pawnIo : TIMINGS_NOTE.unsupported,
    memclkMhz: 3000,
    fclkMhz: null,
    uclkMhz: null,
    xmp: null,
  };
}

function diskLinks(): DiskLink[] {
  return OWNER
    ? [
        { diskNumber: 0, model: "addlink M.2 PCIE G3x4 NVMe", bus: "nvme", gen: 3, width: 4, maxGen: 3, maxWidth: 4, sataGen: null },
        { diskNumber: 1, model: "CT1000P2SSD8", bus: "nvme", gen: 3, width: 4, maxGen: 3, maxWidth: 4, sataGen: null },
        { diskNumber: 2, model: "ST1000DM010-2EP102", bus: "sata", gen: null, width: null, maxGen: null, maxWidth: null, sataGen: 3 },
      ]
    : [
        { diskNumber: 0, model: "Samsung SSD 990 PRO 2TB", bus: "nvme", gen: 4, width: 4, maxGen: 4, maxWidth: 4, sataGen: null },
        { diskNumber: 1, model: "WD_BLACK SN850X 1000GB", bus: "nvme", gen: 4, width: 4, maxGen: 4, maxWidth: 4, sataGen: null },
        { diskNumber: 2, model: "ST4000DM004-2CV104", bus: "sata", gen: null, width: null, maxGen: null, maxWidth: null, sataGen: 3 },
        ...(WITH_USB
          ? [{ diskNumber: 3, model: "SanDisk Extreme 64GB", bus: "usb" as const, gen: null, width: null, maxGen: null, maxWidth: null, sataGen: null }]
          : []),
      ];
}

/** Rust's texts for a command that needs sensor reading while it is down (CONTRACT §4.8.1). */
const ERR_NOT_RUNNING = "Not available right now. Try again in a moment.";
const SPEC_ERR_NOT_RUNNING = "Hardware details are not available right now.";

function systemSpec(): SystemSpec {
  const os = { ...OS_INFO, bootTs: bootedAt };
  delete (os as Partial<OsInfo>).version;
  const security = { secureBoot: true, tpm: { present: true, version: "2.0" }, biosMode: "UEFI" as const };
  const base = { capturedTs: Date.now(), os: os as SystemSpec["os"], security };
  if (!agentRunning || restarting) {
    return { ...base, cpu: null, board: null, memory: null, gpus: [], diskLinks: [], errors: [SPEC_ERR_NOT_RUNNING] };
  }
  const gpus: GpuSpec[] = OWNER
    ? [
        {
          name: DGPU_NAME,
          vendor: "amd",
          vramGb: 16,
          driverVersion: "32.0.21025.1024",
          driverDate: isoDate(inventoryEpoch - 26 * DAY_MS),
          link: { gen: 4, width: 16, maxGen: 4, maxWidth: 16, source: "adl", note: null },
        },
      ]
    : [
        {
          name: DGPU_NAME,
          vendor: "nvidia",
          vramGb: 16,
          driverVersion: "32.0.15.6614",
          driverDate: isoDate(inventoryEpoch - 48 * DAY_MS),
          link: { gen: 4, width: 16, maxGen: 4, maxWidth: 16, source: "devpkey", note: null },
        },
        { name: IGPU_NAME, vendor: "amd", vramGb: 0.5, driverVersion: "31.0.24033.1003", driverDate: isoDate(inventoryEpoch - 265 * DAY_MS), link: null },
      ];
  if (OWNER) {
    return {
      ...base,
      diskLinks: diskLinks(),
      cpu: {
        name: CPU_TELEMETRY_NAME,
        vendor: "AMD",
        codename: "Vermeer",
        socket: "AM4",
        family: 25,
        model: 33,
        stepping: 2,
        cores: 8,
        threads: 16,
        baseClockMhz: 3000,
        caches: [
          { level: 1, type: "data", sizeKb: 32, ways: 8, instances: 8 },
          { level: 1, type: "instruction", sizeKb: 32, ways: 8, instances: 8 },
          { level: 2, type: "unified", sizeKb: 512, ways: 8, instances: 8 },
          { level: 3, type: "unified", sizeKb: 98304, ways: 16, instances: 1 },
        ],
        instructions: [...INSTR_BASE, "FMA3", "SHA", "x86-64", "AMD-V"],
      },
      board: {
        manufacturer: BOARD.manufacturer,
        product: BOARD.product,
        version: BOARD.version,
        biosVendor: BIOS.vendor,
        biosVersion: BIOS.version,
        biosDate: BIOS.releaseDate,
        superIo: NO_RING0 ? null : RIG.superIoName,
      },
      memory: memorySpec(),
      gpus,
      errors: [],
    };
  }
  return {
    ...base,
    diskLinks: diskLinks(),
    cpu: {
      name: CPU_TELEMETRY_NAME,
      vendor: "AMD",
      codename: "Raphael",
      socket: "AM5",
      family: 25,
      model: 97,
      stepping: 2,
      cores: 16,
      threads: 32,
      baseClockMhz: 4500,
      caches: [
        { level: 1, type: "data", sizeKb: 32, ways: 8, instances: 16 },
        { level: 1, type: "instruction", sizeKb: 32, ways: 8, instances: 16 },
        { level: 2, type: "unified", sizeKb: 1024, ways: 8, instances: 16 },
        { level: 3, type: "unified", sizeKb: 32768, ways: 16, instances: 2 },
      ],
      instructions: [...INSTR_BASE, "AVX-512F", "FMA3", "SHA", "x86-64", "AMD-V"],
    },
    board: {
      manufacturer: BOARD.manufacturer,
      product: BOARD.product,
      version: BOARD.version,
      biosVendor: BIOS.vendor,
      biosVersion: BIOS.version,
      biosDate: BIOS.releaseDate,
      superIo: NO_RING0 ? null : RIG.superIoName,
    },
    memory: memorySpec(),
    gpus,
    errors: [],
  };
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] Frame capture (CONTRACT §1.6, §2.13)                      */
/* ------------------------------------------------------------------ */

interface SimApp {
  pid: number;
  process: string;
  title: string;
  runtime: string;
  presentMode: string;
  allowsTearing: boolean;
  syncInterval: number;
  foreground: boolean;
  /** Frame time sampler (ms) and per-frame CPU / GPU busy (ms). */
  sample: () => { ft: number; cpu: number; gpu: number };
  /** Share of frames never displayed. */
  dropP: number;
  latency: number;
}

const GAME_PID = 18320;
const LAUNCHER_PID = 20544;

/** ~140 fps (144 Hz display, no cap) with jitter, 1.4% hitches and a rare 30–40 ms spike. */
function sampleGameFrame(): { ft: number; cpu: number; gpu: number } {
  const x = Math.random();
  if (x < 0.0007) {
    const ft = rand(30, 40);
    return { ft, cpu: ft * rand(0.7, 0.85), gpu: rand(6.2, 7.2) };
  }
  if (x < 0.0147) {
    const ft = rand(9.5, 12.5);
    return { ft, cpu: rand(5, 7), gpu: ft * rand(0.82, 0.92) };
  }
  const ft = clampN(7.08 + gauss() * 0.42, 5.9, 8.9);
  return { ft, cpu: clampN(4.8 + gauss() * 0.3, 3.6, 6.2), gpu: clampN(Math.min(ft - 0.25, 6.6 + gauss() * 0.28), 5.2, 8.6) };
}

const SIM_APPS: SimApp[] = OWNER
  ? [
      {
        pid: GAME_PID,
        process: "Game.exe",
        title: "Game",
        runtime: "DXGI",
        presentMode: "Hardware: Independent Flip",
        allowsTearing: true,
        syncInterval: 0,
        foreground: true,
        sample: sampleGameFrame,
        dropP: 0.003,
        latency: 11.2,
      },
      {
        pid: LAUNCHER_PID,
        process: "Launcher.exe",
        title: "Launcher",
        runtime: "DXGI",
        presentMode: "Composed: Flip",
        allowsTearing: false,
        syncInterval: 1,
        foreground: false,
        sample: () => ({ ft: clampN(33.33 + gauss() * 0.35, 31.5, 35.5), cpu: rand(1.6, 2.6), gpu: rand(1.1, 1.8) }),
        dropP: 0,
        latency: 41,
      },
    ]
  : [];

const SIGNATURE_NOT_CHECKED: FrameSignature = { status: "notChecked", signer: null, sha256Match: null };
const SIGNATURE_VALID: FrameSignature = { status: "valid", signer: "Intel Corporation", sha256Match: true };
const SIGNATURE_INVALID: FrameSignature = { status: "invalid", signer: null, sha256Match: false };
const FRAME_MESSAGES: Record<FrameSessionCode, string> = {
  notElevated: "Frame capture needs administrator rights.",
  exeMissing: "PresentMon is not installed with this copy of Nexum.",
  signatureInvalid: "PresentMon failed its signature check, so it was not started.",
  spawnFailed: "PresentMon could not be started: Access is denied.",
  unsupportedOutput: "PresentMon output is missing the MsBetweenAppStart column.",
  exited: "PresentMon stopped unexpectedly (exit code 1).",
};

const frames = {
  session: null as FrameSession | null,
  target: null as FrameTarget | null,
  stats: null as FrameStats | null,
  manualPid: null as number | null,
  buffers: new Map<number, SimFrame[]>(),
  pending: new Map<number, number[]>(),
  lastT: new Map<number, number>(),
  timer: null as ReturnType<typeof setInterval> | null,
  startTimer: null as ReturnType<typeof setTimeout> | null,
};

function frameSession(state: FrameSession["state"], code: FrameSessionCode | null, signature: FrameSignature): FrameSession {
  const message =
    state === "stopped"
      ? "Frame capture is off."
      : state === "starting"
        ? "Starting PresentMon…"
        : state === "running"
          ? "Capturing frames with Intel PresentMon 2.6.0."
          : FRAME_MESSAGES[code ?? "exited"];
  return {
    type: "frameSession",
    state,
    code: state === "error" ? code : null,
    message,
    backend: "presentmon-console",
    backendVersion: "2.6.0",
    sessionName: "NexumFrames",
    signature,
    childPid: state === "starting" || state === "running" ? 23716 : null,
    sinceTs: Date.now(),
  };
}

function setFrameSession(s: FrameSession): void {
  frames.session = s;
  emit(EVENTS.frameSession, s);
}

const NO_TARGET: FrameTarget = {
  type: "frameTarget",
  pid: null,
  process: null,
  windowTitle: null,
  reason: "none",
  runtime: null,
  presentMode: null,
  fullscreenExclusive: null,
};

function setFrameTargetState(t: FrameTarget): void {
  const prev = frames.target;
  frames.target = t;
  if (!prev || prev.pid !== t.pid || prev.reason !== t.reason) emit(EVENTS.frameTarget, t);
}

const isExcluded = (app: SimApp) => settings.fpsExcludes.some((n) => n.toLowerCase() === app.process.toLowerCase());
const frameCaptureRunning = () => frames.session?.state === "running";

/** Valid frames of `pid` (primary swap chain) whose CPU start is within the last `sec` seconds. */
function framesWithin(pid: number, sec: number, now: number): SimFrame[] {
  const buf = frames.buffers.get(pid) ?? [];
  const from = now - sec * 1000;
  return buf.filter((f) => f.t >= from);
}

function presenting(now: number): SimApp[] {
  return SIM_APPS.filter((a) => !isExcluded(a) && framesWithin(a.pid, 2, now).length > 0);
}

/** Generate the frames each app presented since the last tick (simulation clock = performance.now()). */
function generateFrames(now: number): void {
  const keepMs = Math.max(settings.fpsWindowSec, 5) * 1000;
  for (const app of SIM_APPS) {
    if (isExcluded(app)) {
      frames.buffers.delete(app.pid);
      frames.pending.delete(app.pid);
      frames.lastT.delete(app.pid);
      continue;
    }
    let t = frames.lastT.get(app.pid) ?? now - 1000;
    const buf = frames.buffers.get(app.pid) ?? [];
    const pend = frames.pending.get(app.pid) ?? [];
    while (t < now) {
      const s = app.sample();
      const shown = Math.random() >= app.dropP;
      buf.push({
        t,
        ft: s.ft,
        cpuBusy: s.cpu,
        gpuBusy: s.gpu,
        displayed: shown ? clampN(s.ft + gauss() * 0.2, 0.5, 200) : null,
        latency: shown ? app.latency + s.ft * 0.35 + gauss() * 0.6 : null,
      });
      pend.push(r2(s.ft));
      t += s.ft;
    }
    frames.lastT.set(app.pid, t);
    while (buf.length > 0 && buf[0].t < now - keepMs) buf.shift();
    frames.buffers.set(app.pid, buf);
    frames.pending.set(app.pid, pend);
  }
}

/** Target rule (§1.6.4): manual while presenting, else the presenting foreground app, else none. */
function evaluateFrameTarget(now: number): void {
  const live = presenting(now);
  let app: SimApp | undefined;
  let reason: FrameTarget["reason"] = "none";
  if (frames.manualPid != null) {
    app = live.find((a) => a.pid === frames.manualPid);
    if (app) reason = "manual";
    else frames.manualPid = null;
  }
  if (!app) {
    app = live.find((a) => a.foreground);
    if (app) reason = "foreground";
  }
  if (!app) {
    setFrameTargetState(NO_TARGET);
    return;
  }
  setFrameTargetState({
    type: "frameTarget",
    pid: app.pid,
    process: app.process,
    windowTitle: app.title,
    reason,
    runtime: app.runtime,
    presentMode: app.presentMode,
    fullscreenExclusive: app.presentMode.startsWith("Hardware: Legacy"),
  });
}

function frameTick(): void {
  if (!frameCaptureRunning() || !agentRunning || restarting) return;
  const now = performance.now();
  generateFrames(now);
  evaluateFrameTarget(now);
  const t = frames.target;
  // Drop pending batches of non-targets (the agent only sends the target's frame times).
  for (const pid of [...frames.pending.keys()]) if (pid !== t?.pid) frames.pending.set(pid, []);
  if (!t || t.pid == null) {
    frames.stats = null;
    return;
  }
  const app = SIM_APPS.find((a) => a.pid === t.pid);
  if (!app) return;
  const windowSec = settings.fpsWindowSec;
  const s = computeFrameStats(framesWithin(app.pid, windowSec, now));
  const pend = frames.pending.get(app.pid) ?? [];
  const omitted = Math.max(0, pend.length - 1000);
  const stats: FrameStats = {
    type: "frameStats",
    ts: Date.now(),
    pid: app.pid,
    process: app.process,
    windowSec,
    ...s,
    presentMode: app.presentMode,
    runtime: app.runtime,
    allowsTearing: app.allowsTearing,
    syncInterval: app.syncInterval,
    frametimes: omitted > 0 ? pend.slice(-1000) : pend,
    frametimesOmitted: omitted,
  };
  frames.pending.set(app.pid, []);
  frames.stats = stats;
  emit(EVENTS.frameStats, stats);
}

function clearFrameBuffers(): void {
  frames.buffers.clear();
  frames.pending.clear();
  frames.lastT.clear();
  frames.stats = null;
}

function stopFrameTimers(): void {
  if (frames.timer) clearInterval(frames.timer);
  if (frames.startTimer) clearTimeout(frames.startTimer);
  frames.timer = null;
  frames.startTimer = null;
}

/** `{cmd:"frames", enabled:true}` → { ok, message } (the ack). */
function framesEnable(): { ok: boolean; message: string } {
  const st = frames.session?.state;
  if (st === "starting" || st === "running") return { ok: true, message: "Frame capture is already on" };
  if (ADMIN0) {
    setFrameSession(frameSession("error", "notElevated", SIGNATURE_NOT_CHECKED));
    return { ok: false, message: FRAME_MESSAGES.notElevated };
  }
  if (FPS_PARAM === "error") {
    setFrameSession(frameSession("error", "signatureInvalid", SIGNATURE_INVALID));
    return { ok: false, message: FRAME_MESSAGES.signatureInvalid };
  }
  setFrameSession(frameSession("starting", null, SIGNATURE_VALID));
  stopFrameTimers();
  frames.startTimer = setTimeout(() => {
    frames.startTimer = null;
    if (!agentRunning || restarting || frames.session?.state !== "starting") return;
    setFrameSession(frameSession("running", null, SIGNATURE_VALID));
    frames.lastT.clear();
    frameTick();
    frames.timer = setInterval(frameTick, 1000);
  }, 900);
  return { ok: true, message: "Frame capture started" };
}

/** `{cmd:"frames", enabled:false}`: terminate the session, clear buffers, target none. */
function framesDisable(): { ok: boolean; message: string } {
  stopFrameTimers();
  clearFrameBuffers();
  frames.manualPid = null;
  const sig = frames.session?.signature ?? SIGNATURE_NOT_CHECKED;
  setFrameSession(frameSession("stopped", null, sig));
  if (frames.target && frames.target.reason !== "none") setFrameTargetState(NO_TARGET);
  else frames.target = NO_TARGET;
  return { ok: true, message: "Frame capture stopped" };
}

/** Rust after every hello: one `stopped` session from the agent, then re-enable when the setting is on. */
function framesOnHello(): void {
  stopFrameTimers();
  clearFrameBuffers();
  frames.manualPid = null;
  // Delayed so listeners registered in the same tick as boot() receive it.
  setTimeout(() => {
    if (!agentRunning || restarting) return;
    setFrameSession(frameSession("stopped", null, SIGNATURE_NOT_CHECKED));
    frames.target = NO_TARGET;
    if (settings.fpsCaptureEnabled) {
      const r = framesEnable();
      ack("frames", r.ok, r.message, 0);
    }
  }, 120);
}

/** Agent exited: Rust clears its caches (session null). */
function framesAgentDown(): void {
  stopFrameTimers();
  clearFrameBuffers();
  frames.session = null;
  frames.target = null;
  frames.manualPid = null;
}

/** Apply a changed fpsCaptureEnabled exactly like set_frame_capture (§2.13). */
function applyFrameCaptureSetting(enabled: boolean): void {
  if (!agentRunning || restarting) return;
  const r = enabled ? framesEnable() : framesDisable();
  ack("frames", r.ok, r.message);
}

function presentingList(): PresentingProcess[] {
  if (!frameCaptureRunning()) return [];
  const now = performance.now();
  generateFrames(now); // the agent's buffers are current to the last CSV line, not the last stats tick
  return presenting(now)
    .map((a) => ({
      pid: a.pid,
      process: a.process,
      windowTitle: a.title,
      fps: r1(framesWithin(a.pid, 2, now).length / 2),
      runtime: a.runtime,
      presentMode: a.presentMode,
      isForeground: a.foreground,
      isTarget: frames.target?.pid === a.pid,
    }))
    .sort((x, y) => y.fps - x.fps);
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] CSV sensor log (CONTRACT §2.9)                            */
/* ------------------------------------------------------------------ */

const LOG_FOLDER = "C:\\Users\\User\\Documents\\Nexum\\Logs";

const sensorLog = {
  status: {
    active: false,
    path: null,
    folder: LOG_FOLDER,
    rows: 0,
    totalRows: 0,
    startedTs: null,
    intervalMs: settings.sensorLogIntervalMs,
    sensorCount: 0,
    error: null,
  } as SensorLogStatus,
  lastRowTs: 0,
  sinceFlush: 0,
};

function emitSensorLog(): void {
  emit(EVENTS.sensorLog, { ...sensorLog.status });
}

/** Default column set: every sensor that is not static, not defaultHidden and not user-hidden. */
function defaultLogIds(): string[] {
  const tree = sensorsState.tree;
  if (!tree) return [];
  const hidden = new Set(settings.hiddenSensors);
  return tree.hardware.flatMap((h) => h.sensors.filter((s) => !s.static && !s.defaultHidden && !hidden.has(s.id)).map((s) => s.id));
}

function startLog(opts?: { intervalMs?: number; ids?: string[] | null }): SensorLogStatus {
  if (sensorLog.status.active) throw new Error("A sensor log is already running");
  const interval = opts?.intervalMs ?? settings.sensorLogIntervalMs;
  if (!SENSOR_LOG_INTERVALS_MS.includes(interval)) throw new Error("Unsupported log interval");
  const tree = agentRunning && !restarting ? sensorsState.tree : null;
  if (!tree) throw new Error("Sensor data is not available yet");
  let ids: string[];
  if (opts?.ids == null) ids = defaultLogIds();
  else {
    const known = new Set(tree.hardware.flatMap((h) => h.sensors.map((s) => s.id)));
    ids = opts.ids.filter((id) => known.has(id)).slice(0, 500);
  }
  if (ids.length === 0) throw new Error("No sensors to log");
  if (opts?.intervalMs != null) {
    settings = { ...settings, sensorLogIntervalMs: interval };
    persistSettings(settings);
  }
  sensorLog.status = {
    active: true,
    path: `${LOG_FOLDER}\\nexum-${fileStamp()}.csv`,
    folder: LOG_FOLDER,
    rows: 0,
    totalRows: 0,
    startedTs: Date.now(),
    intervalMs: interval,
    sensorCount: ids.length,
    error: null,
  };
  sensorLog.lastRowTs = 0;
  sensorLog.sinceFlush = 0;
  emitSensorLog();
  return { ...sensorLog.status };
}

function stopLog(): SensorLogStatus {
  if (sensorLog.status.active) {
    sensorLog.status = { ...sensorLog.status, active: false };
    emitSensorLog();
  }
  return { ...sensorLog.status };
}

/** One accepted sensor-values packet (Rust samples the stream it forwards). */
function sensorLogOnPacket(ts: number): void {
  const st = sensorLog.status;
  if (!st.active) return;
  if (sensorLog.lastRowTs !== 0 && ts - sensorLog.lastRowTs < st.intervalMs - 250) return;
  sensorLog.lastRowTs = ts;
  sensorLog.status = { ...st, rows: st.rows + 1, totalRows: st.totalRows + 1 };
  if (++sensorLog.sinceFlush >= 10) {
    sensorLog.sinceFlush = 0;
    emitSensorLog(); // event after every flush (every 10 rows)
  }
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] Alert engine — mirror of Rust alerts.rs (CONTRACT §2.10)  */
/* ------------------------------------------------------------------ */

const RULE_DRIVE_CRIT = "Critical when a drive reports a critical warning, spare below threshold, read-only, or ≤ 10% life left";
const RULE_DRIVE_WARN =
  "Attention when a drive has ≤ 50% life left, reallocated, pending or uncorrectable sectors, a temperature warning, or a Windows health warning";

const DRIVE_SHORT_TEXT: Record<string, string> = {
  Failing: "1 drive failing",
  "Replace soon": "1 drive: replace soon",
  Worn: "1 drive worn",
  "Check sectors": "1 drive: check sectors",
  Overheating: "1 drive overheating",
  "Windows warning": "1 drive: Windows warning",
};

const alertsState = {
  snapshot: {
    ready: false,
    evaluatedTs: null,
    alerts: [],
    rules: [],
    cpuLimit: { model: null, limitC: CPU_DEFAULT_LIMIT_C, warnC: CPU_DEFAULT_LIMIT_C - 5, source: "default" },
  } as HealthAlertsSnapshot,
  signals: new Map<string, SustainState>(),
  lastKey: "",
};

/** Per-model limit (§2.10.2): user override > AMD table > 90 °C default. */
function cpuLimitFor(cpuName: string | null | undefined): CpuLimitInfo {
  const m = /Ryzen\s+\d\s+(PRO\s+)?(\d{4}[A-Z0-9]*)/i.exec(cpuName ?? "");
  const model = m ? m[2].toUpperCase() : null;
  const user = settings.alerts.cpuTempC;
  if (user != null) return { model, limitC: user, warnC: user - 5, source: "user" };
  const table = model != null ? CPU_TJMAX_TABLE[model] : undefined;
  if (table != null) return { model, limitC: table, warnC: table - 5, source: "table" };
  return { model, limitC: CPU_DEFAULT_LIMIT_C, warnC: CPU_DEFAULT_LIMIT_C - 5, source: "default" };
}

function fmtAlertTemp(c: number): string {
  return settings.tempUnit === "F" ? `${Math.round((c * 9) / 5 + 32)} °F` : `${Math.round(c)} °C`;
}

function alertRules(limit: CpuLimitInfo): string[] {
  const a = settings.alerts;
  const S = a.sustainSec;
  const hsCrit = a.gpuHotspotC ?? GPU_HOTSPOT_CRIT_DEFAULT_C;
  const mjCrit = a.gpuMemJunctionC ?? GPU_MEM_JUNCTION_CRIT_DEFAULT_C;
  const t = fmtAlertTemp;
  return [
    RULE_DRIVE_CRIT,
    RULE_DRIVE_WARN,
    `Attention when the CPU stays at or above ${t(limit.warnC)} for ${S} s; critical at or above ${t(limit.limitC)}`,
    `Attention when a GPU hot spot stays at or above ${t(hsCrit - 10)} (edge ${t(GPU_EDGE_WARN_C)}) for ${S} s; critical at or above ${t(hsCrit)} (edge ${t(GPU_EDGE_CRIT_C)})`,
    `Attention when GPU memory stays at or above ${t(mjCrit - 10)} for ${S} s; critical at or above ${t(mjCrit)}`,
    `Attention when a drive stays at or above its warning temperature (${t(70)} if not reported) for ${S} s; critical at its critical temperature (${t(80)})`,
    `Attention when a fixed drive has less than ${a.freeSpacePct}% free space; critical below ${Math.max(1, Math.floor(a.freeSpacePct / 2))}%`,
  ];
}

/** LHM sensor id from the cached tree (first temperature sensor of `hwId` named one of `names`). */
function treeSensorId(match: (h: HardwareNode) => boolean, names: string[] | null): string | null {
  const tree = sensorsState.tree;
  if (!tree) return null;
  for (const h of tree.hardware) {
    if (!match(h)) continue;
    const temps = h.sensors.filter((s) => s.kind === "temperature");
    if (!names) return temps[0]?.id ?? null;
    for (const n of names) {
      const s = temps.find((x) => x.name === n);
      if (s) return s.id;
    }
  }
  return null;
}

const ALERT_RULE_ORDER = (id: string) =>
  id.startsWith("drive-temp:") ? 5 : id.startsWith("drive:") ? 1 : id === "cpu-temp" ? 2 : id.startsWith("gpu-mem-temp:") ? 4 : id.startsWith("gpu-temp:") ? 3 : 6;

function signal(id: string): SustainState {
  let s = alertsState.signals.get(id);
  if (!s) {
    s = newSustainState();
    alertsState.signals.set(id, s);
  }
  return s;
}

/** Evaluate one telemetry packet (Rust: every packet, also while the window is hidden). */
function evaluateAlerts(pkt: TelemetryPacket | null): void {
  const a = settings.alerts;
  const S = a.sustainSec;
  const limit = cpuLimitFor(pkt?.cpu?.name ?? CPU_TELEMETRY_NAME);
  const out: HealthAlert[] = [];
  const ts = pkt?.ts ?? Date.now();
  const physical = OWNER ? OWNER_PHYSICAL_DISKS : DEFAULT_PHYSICAL_DISKS;
  const up = agentRunning && !restarting && pkt != null;
  const base = (id: string, severity: "warn" | "crit", source: HealthAlert["source"], sinceTs: number) => ({
    id,
    severity,
    source,
    dismissKey: `${id}:${severity}`,
    sinceTs,
  });

  if (up && pkt) {
    const joined = joinDisks(physical, pkt.disks);
    const nameOf = (t: DiskTelemetry) => driveDisplayName(joined.find((j) => j.tele?.id === t.id)?.disk ?? null, t);

    // 1. Drive health (no sustain)
    for (const t of pkt.disks) {
      const st = t.health?.state;
      if (st !== "attention" && st !== "replace" && st !== "failing") continue;
      const crit = st !== "attention";
      const id = `drive:${t.id}`;
      const sig = signal(id);
      const sev = crit ? "crit" : "warn";
      if (sig.level !== sev) {
        sig.level = sev;
        sig.sinceTs = ts;
      }
      out.push({
        ...base(id, sev, "drive", sig.sinceTs),
        dismissKey: `${id}:${st}`,
        title: `${nameOf(t)} — ${t.health.label}`,
        detail: driveDetailSentence(t),
        short: DRIVE_SHORT_TEXT[t.health.label] ?? `1 drive: ${t.health.label.toLowerCase()}`,
        group: `drive:${t.health.label}`,
        rule: crit ? RULE_DRIVE_CRIT : RULE_DRIVE_WARN,
        value: t.healthPct,
        threshold: crit ? 10 : 50,
        subjectId: t.id,
        sensorId: null,
      });
    }
    // A drive that recovered (or vanished) starts from scratch next time.
    for (const k of [...alertsState.signals.keys()]) {
      if (k.startsWith("drive:") && !out.some((x) => x.id === k)) alertsState.signals.delete(k);
    }

    // 2. CPU temperature (sustained)
    {
      const v = pkt.cpu.packageTempC;
      const lvl = evaluateSustained(signal("cpu-temp"), ts, v, limit.warnC, limit.limitC, S);
      if (lvl && v != null) {
        const thr = lvl === "crit" ? limit.limitC : limit.warnC;
        const src = limit.source === "table" ? "AMD specification" : limit.source === "user" ? "your setting" : "default, this CPU model is not in Nexum's table";
        out.push({
          ...base("cpu-temp", lvl, "cpu", signal("cpu-temp").sinceTs),
          title: `CPU at ${fmtAlertTemp(v)}`,
          detail: `Above ${fmtAlertTemp(thr)} for ${S} s. Limit for this CPU: ${fmtAlertTemp(limit.limitC)} (${src}).`,
          short: "CPU hot",
          group: "cpu-temp",
          rule: alertRules(limit)[2],
          value: v,
          threshold: thr,
          subjectId: null,
          sensorId: treeSensorId((h) => h.kind === "cpu", ["Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core (Tdie)", "Tctl/Tdie", "Package"]),
        });
      }
    }

    // 3–4. GPU hot spot / edge and memory junction (sustained)
    pkt.gpus.forEach((g, i) => {
      const hwId = i === 0 ? RIG.dgpuHwId : IGPU_HW_ID;
      const hot = g.hotspotTempC != null;
      const hsCrit = a.gpuHotspotC ?? GPU_HOTSPOT_CRIT_DEFAULT_C;
      const critAt = hot ? hsCrit : GPU_EDGE_CRIT_C;
      const warnAt = hot ? hsCrit - 10 : GPU_EDGE_WARN_C;
      const v = hot ? g.hotspotTempC : g.tempC;
      const id = `gpu-temp:${i}`;
      const lvl = evaluateSustained(signal(id), ts, v, warnAt, critAt, S);
      if (lvl && v != null) {
        const thr = lvl === "crit" ? critAt : warnAt;
        out.push({
          ...base(id, lvl, "gpu", signal(id).sinceTs),
          title: `${g.name} at ${fmtAlertTemp(v)}`,
          detail: hot ? `Hot spot above ${fmtAlertTemp(thr)} for ${S} s.` : `Edge temperature above ${fmtAlertTemp(thr)} for ${S} s.`,
          short: "GPU hot",
          group: "gpu-temp",
          rule: alertRules(limit)[3],
          value: v,
          threshold: thr,
          subjectId: String(i),
          sensorId: treeSensorId((h) => h.id === hwId, hot ? ["GPU Hot Spot"] : ["GPU Core"]),
        });
      }
      const mj = g.memJunctionTempC;
      const mjCrit = a.gpuMemJunctionC ?? GPU_MEM_JUNCTION_CRIT_DEFAULT_C;
      const mid = `gpu-mem-temp:${i}`;
      const mlvl = evaluateSustained(signal(mid), ts, mj, mjCrit - 10, mjCrit, S);
      if (mlvl && mj != null) {
        const thr = mlvl === "crit" ? mjCrit : mjCrit - 10;
        out.push({
          ...base(mid, mlvl, "gpu", signal(mid).sinceTs),
          title: `${g.name} memory at ${fmtAlertTemp(mj)}`,
          detail: `Memory junction above ${fmtAlertTemp(thr)} for ${S} s.`,
          short: "GPU memory hot",
          group: "gpu-mem-temp",
          rule: alertRules(limit)[4],
          value: mj,
          threshold: thr,
          subjectId: String(i),
          sensorId: treeSensorId((h) => h.id === hwId, ["GPU Memory Junction", "GPU Memory"]),
        });
      }
    });

    // 5. Drive temperatures (sustained)
    for (const t of pkt.disks) {
      const warnAt = t.warningTempC ?? 70;
      const critAt = t.criticalTempC ?? 80;
      const id = `drive-temp:${t.id}`;
      const lvl = evaluateSustained(signal(id), ts, t.tempC, warnAt, critAt, S);
      if (!lvl || t.tempC == null) continue;
      const thr = lvl === "crit" ? critAt : warnAt;
      out.push({
        ...base(id, lvl, "drive", signal(id).sinceTs),
        title: `${nameOf(t)} at ${fmtAlertTemp(t.tempC)}`,
        detail: `Above ${fmtAlertTemp(thr)} for ${S} s.`,
        short: "Drive hot",
        group: "drive-temp",
        rule: alertRules(limit)[5],
        value: t.tempC,
        threshold: thr,
        subjectId: t.id,
        sensorId: treeSensorId((h) => h.id === t.id, null),
      });
    }
  } else {
    // Agent down or stale: every non-space alert and its samples are cleared.
    for (const k of [...alertsState.signals.keys()]) if (!k.startsWith("space:")) alertsState.signals.delete(k);
  }

  // 6. Free space (no sustain; also while the agent is down)
  const warnPct = a.freeSpacePct;
  const critPct = Math.max(1, Math.floor(warnPct / 2));
  for (const v of volumes()) {
    if (v.driveType !== "Fixed" || !(v.totalBytes > 0)) continue;
    const pct = (v.freeBytes / v.totalBytes) * 100;
    const id = `space:${v.letter}`;
    if (!(pct < warnPct)) {
      alertsState.signals.delete(id);
      continue;
    }
    const sev = pct < critPct ? "crit" : "warn";
    const sig = signal(id);
    if (sig.level !== sev) {
      sig.level = sev;
      sig.sinceTs = ts;
    }
    out.push({
      ...base(id, sev, "space", sig.sinceTs),
      title: `${v.letter} has ${fmtBytes(v.freeBytes)} free (${Math.round(pct)}%)`,
      detail: `Below ${sev === "crit" ? critPct : warnPct}% free.`,
      short: "Low disk space",
      group: "space",
      rule: alertRules(limit)[6],
      value: r1(pct),
      threshold: sev === "crit" ? critPct : warnPct,
      subjectId: v.letter,
      sensorId: null,
    });
  }

  // ?alerts=hot: demo conditions on top of the simulation.
  if (ALERTS_HOT && up && pkt) {
    if (!out.some((x) => x.id === "cpu-temp")) {
      const v = Math.max(pkt.cpu.packageTempC ?? limit.limitC, limit.limitC + 1);
      out.push({
        ...base("cpu-temp", "crit", "cpu", alertsState.snapshot.alerts.find((x) => x.id === "cpu-temp")?.sinceTs ?? ts),
        title: `CPU at ${fmtAlertTemp(v)}`,
        detail: `Above ${fmtAlertTemp(limit.limitC)} for ${S} s. Limit for this CPU: ${fmtAlertTemp(limit.limitC)} (${limit.source === "table" ? "AMD specification" : limit.source === "user" ? "your setting" : "default, this CPU model is not in Nexum's table"}).`,
        short: "CPU hot",
        group: "cpu-temp",
        rule: alertRules(limit)[2],
        value: v,
        threshold: limit.limitC,
        subjectId: null,
        sensorId: treeSensorId((h) => h.kind === "cpu", ["Core (Tctl/Tdie)", "CPU Package"]),
      });
    }
    const g = pkt.gpus[0];
    if (g && !out.some((x) => x.id === "gpu-temp:0")) {
      const crit = a.gpuHotspotC ?? GPU_HOTSPOT_CRIT_DEFAULT_C;
      const v = Math.max(g.hotspotTempC ?? crit - 8, crit - 8);
      out.push({
        ...base("gpu-temp:0", "warn", "gpu", alertsState.snapshot.alerts.find((x) => x.id === "gpu-temp:0")?.sinceTs ?? ts),
        title: `${g.name} at ${fmtAlertTemp(v)}`,
        detail: `Hot spot above ${fmtAlertTemp(crit - 10)} for ${S} s.`,
        short: "GPU hot",
        group: "gpu-temp",
        rule: alertRules(limit)[3],
        value: v,
        threshold: crit - 10,
        subjectId: "0",
        sensorId: treeSensorId((h) => h.id === RIG.dgpuHwId, ["GPU Hot Spot"]),
      });
    }
  }

  out.sort(
    (x, y) =>
      (x.severity === "crit" ? 0 : 1) - (y.severity === "crit" ? 0 : 1) ||
      ALERT_RULE_ORDER(x.id) - ALERT_RULE_ORDER(y.id) ||
      (x.subjectId ?? "").localeCompare(y.subjectId ?? ""),
  );
  const snapshot: HealthAlertsSnapshot = {
    ready: up,
    evaluatedTs: up ? ts : alertsState.snapshot.evaluatedTs,
    alerts: out,
    rules: alertRules(limit),
    cpuLimit: limit,
  };
  alertsState.snapshot = snapshot;
  const key = JSON.stringify({ r: snapshot.ready, a: snapshot.alerts, c: snapshot.cpuLimit, u: snapshot.rules });
  if (key !== alertsState.lastKey) {
    alertsState.lastKey = key;
    emit(EVENTS.healthAlerts, snapshot);
  }
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] Drive wear ledger (CONTRACT §2.11)                        */
/* ------------------------------------------------------------------ */

interface LedgerPlan {
  serial: string;
  days: number;
  life: [number, number] | null;
  written: [number, number] | null;
  poh: number;
}

/** Daily history ending today; life steps are integers like the drive reports them. */
function ledgerPoints(p: LedgerPlan): DriveHistoryPoint[] {
  const out: DriveHistoryPoint[] = [];
  const today = Date.now();
  for (let i = p.days - 1; i >= 0; i--) {
    const k = p.days > 1 ? (p.days - 1 - i) / (p.days - 1) : 1;
    out.push({
      date: isoDate(today - i * DAY_MS),
      healthPct: p.life ? Math.round(p.life[0] + (p.life[1] - p.life[0]) * k) : null,
      dataWrittenTb: p.written ? r2(p.written[0] + (p.written[1] - p.written[0]) * k + (i > 0 ? gauss() * 0.02 : 0)) : null,
      powerOnHours: Math.round(p.poh - i * 13.6),
    });
  }
  return out;
}

const LEDGER_PLANS: LedgerPlan[] = OWNER
  ? [
      // The worn system NVMe: 47% → 44% over 120 days, ~0.9 TB written per month.
      { serial: "20190A1B2C3D", days: 120, life: [47, 44], written: [84.7 - (0.9 * 120) / 30.4375, 84.7], poh: 20188 },
      // A drive whose ledger only started recently.
      { serial: "2104_E1A2_B3C4.", days: 3, life: [95, 95], written: [17.8, 17.9], poh: 15958 },
    ]
  : [
      { serial: "S73WNJ0W612345A", days: 120, life: [98, 98], written: [18.42 - (0.45 * 120) / 30.4375, 18.42], poh: 4210 },
      { serial: "23125L801234", days: 3, life: [100, 100], written: [6.1, 6.18], poh: 2655 },
      { serial: "ZFN0A1B2", days: 30, life: null, written: null, poh: 11826 },
    ];

const LEDGER = new Map<string, DriveHistoryPoint[]>(
  LEDGER_PLANS.map((p) => [normSerial(p.serial) ?? p.serial, ledgerPoints(p)]),
);

function driveHistory(serial: string): DriveHistory {
  const points = LEDGER.get(normSerial(serial) ?? "") ?? [];
  return { serial, points: points.map((p) => ({ ...p })), forecast: computeForecast(points, isoDate(Date.now())) };
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] GPU tuning, read-only (CONTRACT §1.7)                     */
/* ------------------------------------------------------------------ */

const TUNING_UNSUPPORTED_MESSAGE = {
  notElevated: "GPU tuning data needs administrator rights.",
  noAmdGpu: "No AMD Radeon GPU was found.",
} as const;

function tuningState(): TuningState {
  const common = { type: "tuningState" as const, ts: Date.now(), gpuIndex: 0, backend: "adl-od8" as const };
  const reason = ADMIN0 ? "notElevated" : !OWNER || GPU_PARAM === "nvidia" ? "noAmdGpu" : null;
  if (reason) {
    return {
      ...common,
      adapterName: null,
      supported: false,
      reason,
      message: TUNING_UNSUPPORTED_MESSAGE[reason],
      odVersion: null,
      caps: { powerLimit: false, autoUndervolt: false, fanCurve: false, zeroRpm: false, voltageOffset: false, gfxClockMax: false, memClockMax: false },
      ranges: { powerPct: null, voltageOffsetMv: null, gfxClockMaxMhz: null, memClockMaxMhz: null, fanCurveTempC: null, fanCurvePct: null },
      current: { powerPct: null, autoUndervolt: null, zeroRpm: null, voltageOffsetMv: null, gfxClockMaxMhz: null, memClockMaxMhz: null, fanCurve: null },
      isFactory: null,
      mode: "unknown",
      powerMode: null,
      vpuRecoveryCount: null,
    };
  }
  // RX 9070 XT-like OD8 table (RDNA4), factory settings.
  return {
    ...common,
    adapterName: DGPU_NAME,
    supported: true,
    reason: null,
    message: "Read-only. Nexum does not change GPU settings in this version.",
    odVersion: 8,
    caps: { powerLimit: true, autoUndervolt: true, fanCurve: true, zeroRpm: true, voltageOffset: true, gfxClockMax: true, memClockMax: true },
    ranges: {
      powerPct: { min: -30, max: 10, step: 1, default: 0 },
      voltageOffsetMv: { min: -200, max: 0, step: 1, default: 0 },
      // As read from an RX 9070 XT (Navi 48): OD8_GFXCLK_FMAX is an offset there, not an absolute clock.
      gfxClockMaxMhz: { min: -500, max: 1000, step: 1, default: 0 },
      memClockMaxMhz: { min: 2518, max: 3000, step: 1, default: 2518 },
      fanCurveTempC: { min: 25, max: 100, step: 1, default: null },
      fanCurvePct: { min: 0, max: 100, step: 1, default: null },
    },
    current: {
      powerPct: 0,
      autoUndervolt: false,
      zeroRpm: true,
      voltageOffsetMv: 0,
      gfxClockMaxMhz: 0,
      memClockMaxMhz: 2518,
      fanCurve: [
        { tempC: 40, pct: 20 },
        { tempC: 55, pct: 30 },
        { tempC: 70, pct: 45 },
        { tempC: 85, pct: 70 },
        { tempC: 95, pct: 100 },
      ],
    },
    isFactory: true,
    mode: "factory",
    powerMode: null,
    vpuRecoveryCount: 0,
  };
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] Cleaner extras: Recycle Bin age + drill-down (§3.2, §3.3) */
/* ------------------------------------------------------------------ */

interface RecycleItem {
  path: string;
  bytes: number;
  deletedTs: number;
  folder: boolean;
}

/** Deterministic Recycle Bin content (318 items, ~1.21 GB), ages from minutes to a year. */
const recycleItems: RecycleItem[] = (() => {
  const rnd = mulberry32(0x5ec1c1e);
  const kinds = [
    (n: number) => ({ path: `C:\\Users\\User\\Downloads\\setup-${1000 + n}.exe`, folder: false, w: 6 }),
    (n: number) => ({ path: `C:\\Users\\User\\Documents\\draft-${n}.docx`, folder: false, w: 0.4 }),
    (n: number) => ({ path: `C:\\Users\\User\\Pictures\\IMG_${2000 + n}.jpg`, folder: false, w: 1 }),
    (n: number) => ({ path: `C:\\Users\\User\\Videos\\clip-${n}.mp4`, folder: false, w: 14 }),
    (n: number) => ({ path: `C:\\Users\\User\\Downloads\\archive-${n}`, folder: true, w: 9 }),
    (n: number) => ({ path: `C:\\Users\\User\\Desktop\\notes-${n}.txt`, folder: false, w: 0.02 }),
  ];
  const list: RecycleItem[] = [];
  for (let i = 0; i < 318; i++) {
    const k = kinds[Math.floor(rnd() * kinds.length)](i);
    const ageDays = rnd() < 0.4 ? rnd() * 14 : rnd() < 0.55 ? 14 + rnd() * 16 : rnd() < 0.6 ? 30 + rnd() * 30 : 60 + rnd() * 300;
    list.push({ path: k.path, folder: k.folder, bytes: k.w * Math.exp(rnd() * 3), deletedTs: Math.round(Date.now() - ageDays * DAY_MS) });
  }
  const total = list.reduce((s, x) => s + x.bytes, 0);
  const target = 1.21 * GIB;
  for (const x of list) x.bytes = Math.max(512, Math.round((x.bytes / total) * target));
  return list;
})();

/** The age actually used: the argument when given, else Settings.recycleMinAgeDays. */
const recycleAge = (arg: number | null | undefined) => (arg === undefined ? settings.recycleMinAgeDays : arg);

function recycleQualifying(age: number | null): RecycleItem[] {
  if (age == null) return recycleItems;
  const cutoff = Date.now() - age * DAY_MS;
  return recycleItems.filter((x) => x.deletedTs <= cutoff);
}

const dayWord = (n: number) => (n === 1 ? "1 day" : `${n} days`);

const DO_CACHE_PATH = "C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache";

/** Plausible file names per category for the top-50 drill-down. */
function detailPath(id: TrashCategoryId, i: number, rnd: () => number): string {
  const hex = (len: number) => Array.from({ length: len }, () => Math.floor(rnd() * 16).toString(16)).join("");
  switch (id) {
    case "temp":
      return [
        `C:\\Users\\User\\AppData\\Local\\Temp\\${hex(8)}.tmp`,
        `C:\\Users\\User\\AppData\\Local\\Temp\\setup_${hex(6)}.log`,
        `C:\\Users\\User\\AppData\\Local\\Temp\\${hex(8)}-${hex(4)}\\installer.msi`,
        `C:\\Windows\\Temp\\MpCmdRun-${hex(4)}.log`,
      ][i % 4];
    case "wu-cache":
      return `C:\\Windows\\SoftwareDistribution\\Download\\${hex(32)}\\windows11.0-kb50${(i * 37) % 100}${hex(2)}-x64.${i % 3 === 0 ? "psf" : "cab"}`;
    case "logs":
      return i % 3 === 0
        ? `C:\\Windows\\Logs\\CBS\\CbsPersist_2025${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 27)).padStart(2, "0")}${hex(6)}.log`
        : `C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\AppCrash_${["Game.exe", "explorer.exe", "Launcher.exe"][i % 3]}_${hex(12)}\\Report.wer`;
    case "dumps":
      return i % 2 === 0
        ? `C:\\Windows\\Minidump\\2025${String(1 + (i % 9)).padStart(2, "0")}${String(10 + i).padStart(2, "0")}-01.dmp`
        : `C:\\Users\\User\\AppData\\Local\\CrashDumps\\Game.exe.${10000 + i}.dmp`;
    case "memory-dump":
      return "C:\\Windows\\MEMORY.DMP";
    case "shader":
      return OWNER
        ? `C:\\Users\\User\\AppData\\Local\\AMD\\${["DxCache", "DxcCache", "VkCache"][i % 3]}\\${hex(16)}.parc`
        : `C:\\Users\\User\\AppData\\Local\\${["D3DSCache", "NVIDIA\\DXCache", "NVIDIA\\GLCache"][i % 3]}\\${hex(16)}.${i % 2 ? "toc" : "bin"}`;
    case "recycle":
      return "";
    case "browser":
    default:
      return [
        `C:\\Users\\User\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data\\f_${hex(6)}`,
        `C:\\Users\\User\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Code Cache\\js\\${hex(16)}_0`,
        `C:\\Users\\User\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\x1y2z3.default-release\\cache2\\entries\\${hex(40).toUpperCase()}`,
        `C:\\Users\\User\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\GPUCache\\data_${i % 4}`,
      ][i % 4];
  }
}

/** Top items of a category: what a purge would delete now (age guards and skips already applied). */
function trashDetails(def: CacheDef, limit: number, age: number | null): TrashDetailItem[] {
  if (def.id === "recycle") {
    return recycleQualifying(age)
      .map((x) => ({ path: x.path, bytes: x.bytes, modifiedTs: x.deletedTs, kind: x.folder ? ("folder" as const) : ("file" as const) }))
      .sort((p, q) => q.bytes - p.bytes || p.path.localeCompare(q.path))
      .slice(0, limit);
  }
  const { bytes, files } = cleanable(def);
  const rnd = mulberry32([...def.id].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0);
  const items: TrashDetailItem[] = [];
  const minAgeDays = def.id === "dumps" || def.id === "logs" ? 31 : 1.05;
  let fileBytes = bytes;
  // Windows Update: the Delivery Optimization cache is one group row (deleted by Microsoft's cmdlet).
  if (def.id === "wu-cache") {
    const doBytes = Math.round(bytes * (OWNER ? 1 : 0.35));
    fileBytes = bytes - doBytes;
    items.push({ path: DO_CACHE_PATH, bytes: doBytes, modifiedTs: null, kind: "group" });
  }
  // Owner rig: an update is pending, so the SoftwareDistribution download folder is skipped entirely.
  const fileCount = def.id === "wu-cache" && OWNER ? 0 : def.id === "memory-dump" ? 1 : Math.min(files, 400);
  if (fileCount > 0 && fileBytes > 0) {
    const weights = Array.from({ length: fileCount }, (_, i) => Math.pow(i + 1, -0.85) * (0.6 + rnd() * 0.8));
    const sum = weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < Math.min(fileCount, limit); i++) {
      items.push({
        path: detailPath(def.id, i, rnd),
        bytes: Math.max(1, Math.round((weights[i] / sum) * fileBytes)),
        modifiedTs: def.id === "memory-dump" ? Date.parse(`${MEMORY_DUMP_DATE}T09:14:00`) : Math.round(Date.now() - (minAgeDays + rnd() * 120) * DAY_MS),
        kind: "file",
      });
    }
  }
  return items.sort((p, q) => q.bytes - p.bytes || p.path.localeCompare(q.path)).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* [NEW 1.1] Per-packet hooks and agent lifecycle                      */
/* ------------------------------------------------------------------ */

/** Rust-side work per live telemetry packet: CSV rows and the alert engine. */
function onLivePacketV11(pkt: TelemetryPacket): void {
  if (sensorsState.tree) sensorLogOnPacket(pkt.ts);
  evaluateAlerts(pkt);
}

/** The agent went away (restart): Rust clears frame caches and non-space alerts. */
function agentDownV11(): void {
  framesAgentDown();
  evaluateAlerts(null);
}

let traySensors: string[] = [];

/* ------------------------------------------------------------------ */
/* [NEW 1.2] In-app updates (CONTRACT §2.15): what updater.rs does,    */
/* without any network. Nothing is ever downloaded or run here.        */
/* ------------------------------------------------------------------ */

/** Channel compiled into the build; none = the updater is disabled for the whole session (?update=disabled). */
const BUILD_CHANNEL: UpdateChannel | null = UPDATE_PARAM === "disabled" ? null : "preview";
const UPDATE_ERR_ASK = "Choose how Nexum checks for updates first.";
const UPDATE_ERR_DISABLED = "This build does not update from inside the app.";
/** Size of the pretend installer. */
const UPDATE_BYTES = 48_312_320;

/** The version "GitHub" has on offer in this session; null = the running version is the newest. */
const UPDATE_OFFER: { version: string; notes: string; publishedAt: string } | null =
  UPDATE_PARAM === "available" || UPDATE_PARAM === "downloading"
    ? {
        version: "1.3.0",
        notes: [
          "What changed in 1.3.0",
          "",
          "• Sensors: a Limit column for more boards, and a faster start of the sensor list.",
          "• Storage: the wear forecast now also uses the data written per day.",
          "• Gaming: the frame time chart keeps its scale when you switch the window.",
          "• Fixes: the window position is kept across restarts; less memory is used while in the tray.",
        ]
          .join("\n")
          .slice(0, UPDATE_NOTES_MAX_CHARS),
        publishedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      }
    : null;

function effectiveUpdateChannel(): UpdateChannel | null {
  if (!BUILD_CHANNEL) return null;
  return settings.updateChannel === "default" ? BUILD_CHANNEL : settings.updateChannel;
}

function updateError(code: UpdateErrorCode): Pick<UpdateState, "state" | "error" | "errorCode"> {
  return { state: "error", error: UPDATE_ERROR_TEXT[code], errorCode: code };
}

function initialUpdateState(): UpdateState {
  const base: UpdateState = {
    ...INITIAL_UPDATE_STATE,
    currentVersion: __NEXUM_VERSION__,
    channel: effectiveUpdateChannel(),
    buildChannel: BUILD_CHANNEL,
    lastCheckTs: settings.lastUpdateCheckTs,
  };
  if (!BUILD_CHANNEL) return { ...base, state: "disabled" };
  const offer = UPDATE_OFFER
    ? { latestVersion: UPDATE_OFFER.version, notes: UPDATE_OFFER.notes, publishedAt: UPDATE_OFFER.publishedAt }
    : {};
  // The states below imply an answered check earlier in this (pretend) session.
  const checked = settings.lastUpdateCheckTs ?? Date.now() - 3 * 3_600_000;
  if (UPDATE_PARAM === "available") return { ...base, ...offer, state: "available", lastCheckTs: checked };
  if (UPDATE_PARAM === "downloading") {
    return {
      ...base,
      ...offer,
      state: "downloading",
      progress: 42,
      downloadedBytes: Math.round(UPDATE_BYTES * 0.42),
      totalBytes: UPDATE_BYTES,
      lastCheckTs: checked,
    };
  }
  if (UPDATE_PARAM === "error") return { ...base, ...updateError("offline") };
  return base;
}

let upd: UpdateState = initialUpdateState();

const updateStateNow = (): UpdateState["state"] => upd.state;

function setUpdate(next: UpdateState): void {
  upd = next;
  emit(EVENTS.updateState, { ...upd });
}

/** §2.15.4. `automatic` failures are silent: the state returns to what it was. */
async function checkForUpdateMock(kind: "user" | "automatic"): Promise<UpdateState> {
  if (!BUILD_CHANNEL) return { ...upd };
  if (settings.updateCheck === "ask") throw new Error(UPDATE_ERR_ASK);
  if (upd.state === "checking" || upd.state === "downloading" || upd.state === "ready" || upd.state === "installing") return { ...upd };
  const before = upd;
  setUpdate({ ...upd, state: "checking", error: null, errorCode: null });
  await sleep(1200);
  // Re-read through a function: the state may have changed during the wait (a channel change resets it).
  if (updateStateNow() !== "checking") return { ...upd };
  if (UPDATE_PARAM === "error") {
    if (kind === "automatic") setUpdate(before.state === "available" ? before : { ...before, state: "idle", error: null, errorCode: null });
    else setUpdate({ ...upd, ...updateError("offline") });
    return { ...upd };
  }
  const now = Date.now();
  settings = { ...settings, lastUpdateCheckTs: now };
  persistSettings(settings);
  const cleared = { ...upd, error: null, errorCode: null, progress: null, downloadedBytes: null, totalBytes: null, lastCheckTs: now };
  setUpdate(
    UPDATE_OFFER
      ? { ...cleared, state: "available", latestVersion: UPDATE_OFFER.version, notes: UPDATE_OFFER.notes, publishedAt: UPDATE_OFFER.publishedAt }
      : { ...cleared, state: "idle", latestVersion: null, notes: null, publishedAt: null },
  );
  return { ...upd };
}

let installTimer: ReturnType<typeof setInterval> | null = null;

/** §2.15.5 as a slide show: downloading 0 → 100 % in about 4 s, then ready, then installing (and it stays there). */
function runInstallMock(): void {
  if (installTimer) clearInterval(installTimer);
  let step = 0;
  const steps = 16;
  setUpdate({ ...upd, state: "downloading", error: null, errorCode: null, progress: 0, downloadedBytes: 0, totalBytes: UPDATE_BYTES });
  installTimer = setInterval(() => {
    step++;
    const pct = Math.min(100, Math.round((step / steps) * 100));
    setUpdate({ ...upd, state: "downloading", progress: pct, downloadedBytes: Math.round((UPDATE_BYTES * pct) / 100) });
    if (step < steps) return;
    if (installTimer) clearInterval(installTimer);
    installTimer = null;
    setTimeout(() => {
      setUpdate({ ...upd, state: "ready" });
      setTimeout(() => setUpdate({ ...upd, state: "installing" }), 1100);
    }, 300);
  }, 250);
}

/** save_settings side of §2.15.4: a channel change drops the offer; switching to "auto" checks when due. */
function updateSettingsChanged(prev: Settings): void {
  if (!BUILD_CHANNEL) return;
  const busy = upd.state === "downloading" || upd.state === "ready" || upd.state === "installing";
  const channelChanged = settings.updateChannel !== prev.updateChannel;
  if (channelChanged) {
    settings = { ...settings, lastUpdateCheckTs: null };
    if (!busy) {
      setUpdate({
        ...upd,
        state: "idle",
        latestVersion: null,
        notes: null,
        publishedAt: null,
        error: null,
        errorCode: null,
        channel: effectiveUpdateChannel(),
        lastCheckTs: null,
      });
    }
  }
  const becameAuto = settings.updateCheck === "auto" && prev.updateCheck !== "auto";
  const due = settings.lastUpdateCheckTs == null || Date.now() - settings.lastUpdateCheckTs >= DAY_MS;
  if (settings.updateCheck === "auto" && due && (becameAuto || channelChanged)) {
    setTimeout(() => void checkForUpdateMock("automatic").catch(() => undefined), 600);
  }
}

/* ------------------------------------------------------------------ */
/* Public mock backend (mirrors `api` in ./api.ts)                     */
/* ------------------------------------------------------------------ */

function fanCommandBlocked(cmd: string): boolean {
  if (fan.failsafe) {
    ack(cmd, false, FAILSAFE_LOCKED);
    return true;
  }
  if (ADMIN0 || NO_RING0) {
    ack(cmd, false, ADMIN0 ? NEEDS_ADMIN_FANS : "Fan control is unavailable without the PawnIO driver");
    return true;
  }
  return false;
}

export const mockBackend = {
  async getSystemInfo(): Promise<SystemInfo> {
    await sleep(rand(140, 320));
    return systemInfo();
  },

  async getDrivers(): Promise<DriverInfo[]> {
    await sleep(rand(900, 1500));
    lastDriverScan = new Date().toISOString();
    return buildDrivers().map((d) => ({ ...d }));
  },

  async getVolumes(): Promise<Volume[]> {
    await sleep(rand(60, 160));
    return volumes();
  },

  async getPhysicalDisks(): Promise<PhysicalDisk[]> {
    await sleep(rand(120, 260));
    return (OWNER ? OWNER_PHYSICAL_DISKS : DEFAULT_PHYSICAL_DISKS).map((d) => ({ ...d, volumes: [...d.volumes] }));
  },

  async scanTrash(includeBrowser: boolean, recycleMinAgeDays?: number | null): Promise<TrashScan> {
    const started = performance.now();
    await sleep(rand(850, 1400));
    const age = recycleAge(recycleMinAgeDays);
    const categories = CACHE_DEFS.filter((d) => d.id !== "browser" || includeBrowser).map((d) => toCategory(d, includeBrowser, age));
    return {
      categories,
      totalBytes: categories.reduce((s, c) => (c.available ? s + c.bytes : s), 0),
      durationMs: Math.round(performance.now() - started),
      isAdmin: !ADMIN0,
    };
  },

  async purgeTrash(categories: TrashCategoryId[], recycleMinAgeDays?: number | null): Promise<PurgeResult> {
    if (purgeRunning) throw new Error("A cleanup is already in progress");
    const age = recycleAge(recycleMinAgeDays);
    const known = new Set(CACHE_DEFS.map((d) => d.id));
    const unknown = categories.find((c) => !known.has(c));
    if (unknown) throw new Error(`Unknown category: ${unknown}`);
    purgeRunning = true;
    try {
      const started = performance.now();
      const wanted = new Set(categories);
      const defs = CACHE_DEFS.filter((d) => wanted.has(d.id));
      const totalSteps = defs.length;
      const perCategory: PurgeCategoryResult[] = [];
      let freed = 0;
      let deleted = 0;
      let skipped = 0;
      let stepNo = 0;
      const stepMs = totalSteps > 0 ? 2500 / totalSteps : 0;

      // Mirrors cleaner.rs: one event when a category starts and one when it ends (same step),
      // freedBytes always being the running total.
      for (const def of defs) {
        stepNo++;
        const progress = (): PurgeProgress => ({ categoryId: def.id, label: def.label, step: stepNo, totalSteps, freedBytes: freed });
        emit("purge-progress", progress());
        await sleep(stepMs * rand(0.8, 1.2));
        if (!available(def)) {
          perCategory.push({ id: def.id, label: def.label, freedBytes: 0, deleted: 0, skipped: 0, note: NEEDS_ADMIN_NOTE });
          emit("purge-progress", progress());
          continue;
        }
        const { bytes, files } = cleanable(def, age);
        const ratio = def.id === "recycle" || def.id === "memory-dump" ? 1 : rand(0.972, 0.994);
        const freedHere = Math.round(bytes * ratio);
        const del = Math.round(files * ratio);
        const sk = files - del + (def.skipped ? Math.round(def.files * def.skipped.fraction) : 0);
        if (def.id === "recycle") {
          // Only the qualifying items leave the bin; newer ones stay (§3.2).
          const gone = new Set(recycleQualifying(age));
          for (let i = recycleItems.length - 1; i >= 0; i--) if (gone.has(recycleItems[i])) recycleItems.splice(i, 1);
        } else {
          lastCleanAt[def.id] = Date.now();
        }
        freed += freedHere;
        deleted += del;
        skipped += sk;
        perCategory.push({ id: def.id, label: def.label, freedBytes: freedHere, deleted: del, skipped: sk, note: def.skipped?.note ?? null });
        emit("purge-progress", progress());
      }

      systemDriveFreedBytes += freed;
      return {
        freedBytes: freed,
        filesDeleted: deleted,
        filesSkipped: skipped,
        durationMs: Math.round(performance.now() - started),
        perCategory,
        logPath: `C:\\Users\\Demo\\AppData\\Local\\Nexum\\purge-logs\\${fileStamp()}.jsonl`,
      };
    } finally {
      purgeRunning = false;
    }
  },

  async exportDrivers(format: "json" | "csv"): Promise<string> {
    await sleep(rand(250, 500));
    const list = buildDrivers();
    const stamp = fileStamp();
    const filename = `nexum-drivers-${stamp}.${format}`;
    if (format === "json") {
      const payload = { generatedAt: new Date().toISOString(), hostname: RIG.hostname, count: list.length, drivers: list };
      triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
    } else {
      triggerDownload(filename, driversToCsv(list), "text/csv");
    }
    return `C:\\Users\\Demo\\Documents\\Nexum\\${filename}`;
  },

  async backupDrivers(): Promise<DriverBackupResult> {
    await sleep(rand(2400, 3200));
    const path = `C:\\Users\\Demo\\Documents\\Nexum\\DriverBackup-${fileStamp()}`;
    if (ADMIN0) {
      return {
        path,
        success: false,
        output: "Microsoft PnP Utility\r\n\r\nFailed to export driver packages.\r\nAccess is denied. Administrator privileges are required.",
      };
    }
    const third = buildDrivers().filter((d) => /^oem\d+\.inf$/i.test(d.infName));
    const unique = [...new Map(third.map((d) => [d.infName, d])).values()];
    const lines = unique.map((d) => `Exporting driver package:   ${d.infName} (${d.provider})\r\nDriver package exported successfully.`);
    return {
      path,
      success: true,
      output: `Microsoft PnP Utility\r\n\r\n${lines.join("\r\n\r\n")}\r\n\r\nTotal driver packages:  ${unique.length}\r\nExported driver packages:  ${unique.length}`,
    };
  },

  async setPollInterval(ms: number): Promise<void> {
    applyPollInterval(ms);
  },

  async setFanPreset(preset: FanPreset): Promise<void> {
    await sleep(40);
    if (!agentRunning) throw new Error(ERR_NOT_RUNNING);
    if (fanCommandBlocked("fanPreset")) return;
    const n = FANS.filter((f) => f.controllable).length;
    if (preset === "auto") {
      // BIOS control is always safe: applies immediately, ends manual mode and any override.
      sim.preset = "auto";
      fan.manualActive = false;
      fan.override = false;
      fan.reason = null;
      ack("fanPreset", true, `Released ${n} fans to BIOS control`);
      return;
    }
    if (preset === "custom") sim.customDuty = sim.fanDuty.map((d) => Math.round(d));
    sim.preset = preset;
    fan.manualActive = true;
    if (fan.override) {
      ack("fanPreset", true, fan.reason === "sensorMissing" ? OVERRIDE_SAVED_SENSOR : OVERRIDE_SAVED_CPU);
      return;
    }
    ack("fanPreset", true, `Applied ${PRESET_LABEL[preset]} to ${n} fans`);
  },

  async setFanControl(id: string, pct: number): Promise<void> {
    await sleep(30);
    if (!agentRunning) throw new Error(ERR_NOT_RUNNING);
    if (fanCommandBlocked("fanSet")) return;
    const idx = FANS.findIndex((f) => fanSensorId(f) === id);
    if (idx < 0) {
      ack("fanSet", false, `Unknown fan ${id}`);
      return;
    }
    const f = FANS[idx];
    if (!f.controllable) {
      ack("fanSet", false, `${fanName(f)} is not controllable (DC mode header)`);
      return;
    }
    if (sim.preset !== "custom") sim.customDuty = sim.fanDuty.map((d) => Math.round(d));
    sim.customDuty[idx] = Math.round(clampN(pct, 0, 100));
    sim.preset = "custom";
    fan.manualActive = true;
    if (fan.override) {
      ack("fanSet", true, fan.reason === "sensorMissing" ? OVERRIDE_SAVED_SENSOR : OVERRIDE_SAVED_CPU, 180);
      return;
    }
    ack("fanSet", true, `${fanName(f)} set to ${sim.customDuty[idx]}%`, 180);
  },

  async getSettings(): Promise<Settings> {
    await sleep(40);
    return { ...settings };
  },

  async saveSettings(next: Settings): Promise<Settings> {
    await sleep(rand(120, 260));
    const prev = settings;
    // [NEW 1.2] lastUpdateCheckTs is written by Rust only: the incoming value is ignored (§2.2).
    settings = { ...sanitizeSettings(next), lastUpdateCheckTs: prev.lastUpdateCheckTs };
    updateSettingsChanged(prev);
    persistSettings(settings);
    if (settings.pollIntervalMs !== sim.intervalMs) applyPollInterval(settings.pollIntervalMs);
    // [NEW 1.1] Same effect as the dedicated commands (§2.13), and alerts re-evaluate at once (§2.10).
    if (settings.fpsCaptureEnabled !== prev.fpsCaptureEnabled) applyFrameCaptureSetting(settings.fpsCaptureEnabled);
    if (settings.fpsWindowSec !== prev.fpsWindowSec) ack("frameWindow", true, `Window: ${settings.fpsWindowSec} s`);
    if (settings.fpsExcludes.join("\n") !== prev.fpsExcludes.join("\n")) ack("frameExclude", true, `Excluding ${settings.fpsExcludes.length} apps`);
    if (JSON.stringify(settings.alerts) !== JSON.stringify(prev.alerts) || settings.tempUnit !== prev.tempUnit) {
      evaluateAlerts(agentRunning && !restarting ? (lastFrame?.pkt ?? null) : null);
    }
    return { ...settings };
  },

  async getAgentStatus(): Promise<AgentStatus> {
    await sleep(60);
    return agentStatus();
  },

  /** [CHANGED 1.2] §2.3.1 item 8: phase "starting" at once, then "running" — or back to "failed" with ?sensors=…. */
  async restartAgent(): Promise<void> {
    if (SENSORS_DOWN) {
      if (retrying || SENSORS_DOWN.phase === "starting") return;
      retrying = true;
      emitStatus();
      setTimeout(() => {
        retrying = false;
        emitStatus();
      }, 1500);
      return;
    }
    if (restarting) return;
    restarting = true;
    stopTimer();
    agentDownV11();
    emitStatus();
    await sleep(100);
    setTimeout(() => {
      restarting = false;
      agentRunning = true;
      // A graceful exit restores BIOS control, except in failsafe mode (§1.5.4).
      if (!fan.failsafe) {
        sim.preset = "auto";
        fan.manualActive = false;
        fan.override = false;
        fan.reason = null;
      }
      resetSensorProcess();
      agentStarted();
      startTimer();
      scheduleLateHardware();
      emitStatus();
    }, 1400);
  },

  async openExternal(target: string): Promise<void> {
    if (/^https:\/\//i.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    console.info(`[nexum mock] open_external("${target}") — folders open only in the desktop app`);
  },

  async getSensorTree(): Promise<SensorTree | null> {
    await sleep(rand(30, 90));
    if (!agentRunning || restarting || !sensorsState.tree) return null;
    return { ...sensorsState.tree, sessionStartTs: sensorsState.sessionStartTs };
  },

  async setSensorStream(on: boolean): Promise<void> {
    sensorsState.streamOn = !!on;
  },

  async resetSensorStats(ids: string[] | null): Promise<void> {
    await sleep(60);
    if (!agentRunning || restarting) throw new Error(ERR_NOT_RUNNING);
    const n = resetSensors(ids);
    if (ids == null) emitTree(); // same rev, new sessionStartTs
    ack("sensorReset", true, `Reset ${n} sensors`, 0);
  },

  async getSystemSpec(refresh = false): Promise<SystemSpec> {
    await sleep(refresh ? rand(700, 1300) : rand(250, 600));
    return systemSpec();
  },

  async getFanFailsafeState(): Promise<FanFailsafeState> {
    await sleep(20);
    return { ...failsafeState };
  },

  async dismissFanFailsafe(): Promise<FanFailsafeState> {
    await sleep(40);
    if (!failsafeState.active || failsafeState.kind !== "previousBoot") {
      throw new Error("Only a previous-boot fan notice can be dismissed");
    }
    setFailsafe({ ...FAILSAFE_OFF });
    return { ...failsafeState };
  },

  async restartAsAdmin(): Promise<void> {
    await sleep(200);
    if (!ADMIN0) throw new Error("Nexum is already running as administrator");
    // Preview: "relaunch elevated" = reload without the not-elevated switches.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("admin");
      const mock = (url.searchParams.get("mock") ?? "")
        .split(/[,+\s]+/)
        .filter((s) => s && s.toLowerCase() !== "limited");
      if (mock.length) url.searchParams.set("mock", mock.join(","));
      else url.searchParams.delete("mock");
      window.location.assign(url.toString());
    } catch {
      throw new Error("Could not restart (preview)");
    }
  },

  async openReliabilityMonitor(): Promise<void> {
    await sleep(30);
    console.info("[nexum mock] open_reliability_monitor → perfmon.exe /rel (desktop app only)");
  },

  /* ── [NEW 1.1] Cleaner drill-down (§3.3) ── */

  async scanTrashDetails(categoryId: TrashCategoryId, limit: number, recycleMinAgeDays?: number | null): Promise<TrashDetailItem[]> {
    await sleep(rand(250, 600));
    const def = CACHE_DEFS.find((d) => d.id === categoryId);
    if (!def) throw new Error("Unknown category");
    if (!available(def)) throw new Error(NEEDS_ADMIN_NOTE);
    const n = Math.round(clampN(Number.isFinite(limit) ? limit : TRASH_DETAILS_LIMIT, 1, TRASH_DETAILS_LIMIT));
    return trashDetails(def, n, recycleAge(recycleMinAgeDays));
  },

  /* ── [NEW 1.1] Frame capture (§2.13) ── */

  async getFrameState(): Promise<FrameState> {
    await sleep(20);
    return {
      session: frames.session ? { ...frames.session } : null,
      target: frames.target ? { ...frames.target } : null,
      stats: frames.stats ? { ...frames.stats, frametimes: [] } : null,
    };
  },

  async setFrameCapture(enabled: boolean): Promise<Settings> {
    await sleep(rand(60, 140));
    const changed = settings.fpsCaptureEnabled !== !!enabled;
    settings = { ...settings, fpsCaptureEnabled: !!enabled };
    persistSettings(settings);
    if (changed || (enabled && frames.session?.state !== "running" && frames.session?.state !== "starting")) {
      applyFrameCaptureSetting(!!enabled);
    }
    return { ...settings };
  },

  async setFrameTarget(pid: number | null): Promise<void> {
    await sleep(rand(40, 120));
    if (!agentRunning || restarting) throw new Error(ERR_NOT_RUNNING);
    if (pid == null) {
      frames.manualPid = null;
      evaluateFrameTarget(performance.now());
      ack("frameTarget", true, "Automatic target", 0);
      return;
    }
    const app = frameCaptureRunning() ? presenting(performance.now()).find((a) => a.pid === pid) : undefined;
    if (!app) {
      ack("frameTarget", false, "That app is not presenting frames.", 0);
      throw new Error("That app is not presenting frames.");
    }
    frames.manualPid = pid;
    evaluateFrameTarget(performance.now());
    ack("frameTarget", true, `Target: ${app.process}`, 0);
  },

  async setFrameWindow(sec: number): Promise<Settings> {
    await sleep(rand(60, 140));
    const v = Math.round(clampN(Number.isFinite(sec) ? sec : 30, 5, 120));
    settings = { ...settings, fpsWindowSec: v };
    persistSettings(settings);
    if (agentRunning && !restarting) ack("frameWindow", true, `Window: ${v} s`);
    return { ...settings };
  },

  async setFrameExcludes(names: string[]): Promise<Settings> {
    await sleep(rand(60, 140));
    settings = { ...settings, fpsExcludes: sanitizeExcludeList(names) };
    persistSettings(settings);
    if (agentRunning && !restarting) {
      ack("frameExclude", true, `Excluding ${settings.fpsExcludes.length} apps`);
      // The target rule runs at once when the current target became excluded.
      if (frameCaptureRunning()) {
        const now = performance.now();
        generateFrames(now);
        evaluateFrameTarget(now);
      }
    }
    return { ...settings };
  },

  async listPresentingProcesses(): Promise<PresentingProcess[]> {
    await sleep(rand(80, 200));
    if (!agentRunning || restarting) throw new Error(ERR_NOT_RUNNING);
    return presentingList();
  },

  /* ── [NEW 1.1] CSV sensor log (§2.9) ── */

  async startSensorLog(opts?: { intervalMs?: number; ids?: string[] | null }): Promise<SensorLogStatus> {
    await sleep(rand(60, 140));
    return startLog(opts);
  },

  async stopSensorLog(): Promise<SensorLogStatus> {
    await sleep(rand(40, 100));
    return stopLog();
  },

  async getSensorLogStatus(): Promise<SensorLogStatus> {
    await sleep(20);
    return { ...sensorLog.status, intervalMs: sensorLog.status.active ? sensorLog.status.intervalMs : settings.sensorLogIntervalMs };
  },

  /* ── [NEW 1.1] Alerts, notifications, tray (§2.10) ── */

  async getHealthAlerts(): Promise<HealthAlertsSnapshot> {
    await sleep(30);
    return { ...alertsState.snapshot, alerts: alertsState.snapshot.alerts.map((a) => ({ ...a })) };
  },

  async dismissAlert(dismissKey: string): Promise<Settings> {
    await sleep(rand(60, 140));
    const list = settings.dismissedAlerts.filter((k) => k !== dismissKey);
    list.push(dismissKey);
    settings = { ...settings, dismissedAlerts: list.slice(-200) };
    persistSettings(settings);
    return { ...settings };
  },

  async setTraySensors(ids: string[]): Promise<void> {
    traySensors = ids.slice(0, 4);
    console.debug("[nexum mock] tray sensors:", traySensors);
  },

  /* ── [NEW 1.1] Drive wear ledger (§2.11) ── */

  async getDriveHistory(serial: string): Promise<DriveHistory> {
    await sleep(rand(80, 200));
    return driveHistory(serial);
  },

  /* ── [NEW 1.1] Save report (§2.12) ── */

  async saveReport(format: ReportFormat): Promise<string> {
    await sleep(rand(300, 700));
    if (format !== "txt" && format !== "html") throw new Error("Unsupported report format");
    const path = `C:\\Users\\User\\Documents\\Nexum\\Reports\\nexum-report-${fileStamp()}.${format}`;
    console.info(`[nexum mock] save_report → ${path} (written by the desktop app only)`);
    return path;
  },

  /* ── [NEW 1.1] GPU tuning, read-only (§2.14) ── */

  async getTuningState(refresh = false): Promise<TuningState | null> {
    await sleep(refresh ? rand(150, 400) : 30);
    if (!agentRunning || restarting) return null;
    const s = tuningState();
    if (refresh) emit(EVENTS.tuningState, s);
    return s;
  },

  async runTuningProbe(write: boolean): Promise<TuningProbeSummary> {
    if (write) throw new Error("The write probe is not available in this version.");
    await sleep(rand(900, 1500));
    if (!agentRunning || restarting) throw new Error(ERR_NOT_RUNNING);
    const s = tuningState();
    emit(EVENTS.tuningState, s);
    return {
      ranTs: Date.now(),
      write: false,
      ok: s.supported,
      message: s.supported ? "Read-only probe finished." : s.message,
      path: `C:\\Users\\User\\AppData\\Local\\Nexum\\tuning-probe-${fileStamp()}.json`,
    };
  },

  /* ── [NEW 1.2] In-app updates (§2.15) ── */

  async getUpdateState(): Promise<UpdateState> {
    await sleep(30);
    return { ...upd };
  },

  async checkForUpdate(): Promise<UpdateState> {
    return checkForUpdateMock("user");
  },

  async installUpdate(): Promise<void> {
    await sleep(60);
    if (!BUILD_CHANNEL) throw new Error(UPDATE_ERR_DISABLED);
    if (settings.updateCheck === "ask") throw new Error(UPDATE_ERR_ASK);
    if (upd.state === "downloading" || upd.state === "ready" || upd.state === "installing") throw new Error(UPDATE_ERROR_TEXT.busy);
    if (!upd.latestVersion) throw new Error("Check for updates first.");
    runInstallMock();
  },
};

export type MockBackendType = typeof mockBackend;
