// Browser-preview backend. Simulates "WORKSTATION-01 — Ryzen 9 7950X / RTX 4080"
// so `vite dev` shows a live UI without Tauri. Only loaded when !isTauri.
//
// Scenario switches via URL query (comma separated): ?mock=limited,hot,noagent
//   limited  → not running as admin (fan control / admin categories restricted)
//   hot      → CPU + GPU above 85°C (Thermal Alert)
//   noagent  → sidecar never starts (no telemetry, agent not running)

import type {
  AgentAck,
  AgentStatus,
  DriverBackupResult,
  DriverCategory,
  DriverInfo,
  FanPreset,
  FanTelemetry,
  GpuTelemetry,
  PhysicalDisk,
  PurgeCategoryResult,
  PurgeProgress,
  PurgeResult,
  Settings,
  SystemInfo,
  TelemetryPacket,
  TrashCategory,
  TrashCategoryId,
  TrashScan,
  Volume,
} from "../types";
import { DEFAULT_SETTINGS } from "../types";

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

const SCENARIO = readScenario();
const LIMITED = SCENARIO.has("limited");
const HOT = SCENARIO.has("hot");
const NO_AGENT = SCENARIO.has("noagent");

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
/* Settings (persisted in localStorage for the preview)                */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = "nexum.mock.settings";

function sanitizeSettings(input: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const poll =
    typeof input.pollIntervalMs === "number" && Number.isFinite(input.pollIntervalMs)
      ? Math.round(clampN(input.pollIntervalMs, 250, 10_000))
      : d.pollIntervalMs;
  return {
    launchOnStartup: bool(input.launchOnStartup, d.launchOnStartup),
    minimizeToTray: bool(input.minimizeToTray, d.minimizeToTray),
    pollIntervalMs: poll,
    includeBrowserCaches: bool(input.includeBrowserCaches, d.includeBrowserCaches),
    confirmBeforePurge: bool(input.confirmBeforePurge, d.confirmBeforePurge),
    flushStandbyOnPurge: bool(input.flushStandbyOnPurge, d.flushStandbyOnPurge),
    tempUnit: input.tempUnit === "F" ? "F" : "C",
    startMinimized: bool(input.startMinimized, d.startMinimized),
  };
}

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    // Storage unavailable or corrupt; fall back to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

function persistSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Non-fatal in preview mode.
  }
}

let settings: Settings = loadSettings();

/* ------------------------------------------------------------------ */
/* Hardware model                                                      */
/* ------------------------------------------------------------------ */

const CPU_TELEMETRY_NAME = "AMD Ryzen 9 7950X";
const CPU_WMI_NAME = "AMD Ryzen 9 7950X 16-Core Processor";
const DGPU_NAME = "NVIDIA GeForce RTX 4080";
const IGPU_NAME = "AMD Radeon(TM) Graphics";
const CORES = 16;
const THREADS = 32;
const RAM_TOTAL_GB = 63.6;

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

interface FanSpec {
  id: string;
  name: string;
  maxRpm: number;
  minRpm: number;
  controllable: boolean;
  kind: "cpu" | "pump" | "case";
}

const FAN_HARDWARE = "Nuvoton NCT6799D";
const FANS: FanSpec[] = [
  { id: "/lpc/nct6799d/0/fan/0", name: "CPU Fan", maxRpm: 2100, minRpm: 380, controllable: true, kind: "cpu" },
  { id: "/lpc/nct6799d/0/fan/1", name: "AIO Pump", maxRpm: 3050, minRpm: 1150, controllable: true, kind: "pump" },
  { id: "/lpc/nct6799d/0/fan/2", name: "Case Fan 1", maxRpm: 1850, minRpm: 320, controllable: true, kind: "case" },
  { id: "/lpc/nct6799d/0/fan/3", name: "Case Fan 2", maxRpm: 1850, minRpm: 320, controllable: true, kind: "case" },
  { id: "/lpc/nct6799d/0/fan/4", name: "Case Fan 3", maxRpm: 1550, minRpm: 300, controllable: true, kind: "case" },
  // DC-mode header: readable, not controllable (exercises the UI's read-only path).
  { id: "/lpc/nct6799d/0/fan/5", name: "Case Fan 4", maxRpm: 1550, minRpm: 300, controllable: false, kind: "case" },
];

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

interface DiskSpec {
  id: string;
  name: string;
  baseTemp: number;
  health: number | null;
  tbw: number | null;
  poh: number;
  usedPct: number;
  maxRead: number;
  maxWrite: number;
  role: "system" | "games" | "archive";
}

const DISKS: DiskSpec[] = [
  { id: "/nvme/0", name: "Samsung SSD 990 PRO 2TB", baseTemp: 37, health: 98, tbw: 18.42, poh: 4210, usedPct: 61, maxRead: 2600, maxWrite: 1500, role: "system" },
  { id: "/nvme/1", name: "WD_BLACK SN850X 1000GB", baseTemp: 35, health: 100, tbw: 6.18, poh: 2655, usedPct: 78, maxRead: 3600, maxWrite: 900, role: "games" },
  { id: "/hdd/0", name: "ST4000DM004-2CV104", baseTemp: 33, health: null, tbw: null, poh: 11826, usedPct: 47, maxRead: 185, maxWrite: 160, role: "archive" },
];

interface DiskState {
  temp: number;
  read: number;
  write: number;
  burstLeft: number;
  burstRead: number;
  burstWrite: number;
  tbw: number;
}

const sim = {
  intervalMs: settings.pollIntervalMs,
  profile: PROFILES[1],
  profileLeft: 16,
  cpuWork: 0.1,
  gpuWork: 0.06,
  coreBias: Array.from({ length: CORES }, () => rand(0.6, 1.4)),
  cpuTemp: HOT ? 88 : 44,
  clock: 4300,
  gpuTemp: HOT ? 86 : 36,
  gpuFanOn: HOT,
  vram: 1.6,
  ram: 12.4,
  fanRpm: FANS.map((f) => f.minRpm + (f.maxRpm - f.minRpm) * 0.35),
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
  })),
  net: { burstLeft: 0, burstDown: 0 },
  startedAt: Date.now(),
};

/** Advance the simulation by `dt` seconds and produce a packet stamped `ts`. */
function step(dt: number, ts: number): TelemetryPacket {
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

  // CPU
  const perCore = sim.coreBias.map((bias, i) => {
    const b = clampN(bias + gauss() * 0.08 * sq + (1 - bias) * 0.05, 0.25, 1.75);
    sim.coreBias[i] = b;
    const v = sim.cpuWork * 100 * b + Math.abs(gauss()) * 1.6 + (i < 2 ? 2.5 : 0);
    return clampN(v, 0, 100);
  });
  const loadTotal = perCore.reduce((s, v) => s + v, 0) / perCore.length;
  const cpuTarget = HOT ? 87 + loadTotal * 0.08 : 40 + loadTotal * 0.44;
  sim.cpuTemp = lag(sim.cpuTemp, cpuTarget, dt, 3.5) + gauss() * 0.3;
  const clockTarget = loadTotal < 12 ? 3800 + Math.random() * 1700 : 5450 - loadTotal * 3.6;
  sim.clock = clampN(lag(sim.clock, clockTarget, dt, 0.6), 545, 5750);
  const voltage = 0.9 + (sim.clock / 5750) * 0.42 + gauss() * 0.006;
  const cpuPower = 34 + loadTotal * 1.65 + gauss() * 1.5;

  // Discrete GPU (RTX 4080)
  const gLoad = sim.gpuWork < 0.03 ? rand(0, 3) : clampN(sim.gpuWork * 100 + gauss() * 2.4, 0, 100);
  const coreClock = gLoad < 6 ? rand(210, 345) : 2520 + gLoad * 2.4 + gauss() * 12;
  const memClock = gLoad < 6 ? 405 : 11201;
  sim.vram = lag(sim.vram, 1.3 + sim.gpuWork * 10.4, dt, 5);
  const gpuTarget = HOT ? 86 + gLoad * 0.05 : 33 + gLoad * 0.37;
  sim.gpuTemp = lag(sim.gpuTemp, gpuTarget, dt, 5) + gauss() * 0.2;
  if (sim.gpuTemp >= 55) sim.gpuFanOn = true;
  else if (sim.gpuTemp <= 47) sim.gpuFanOn = false;
  const gpuFanPct = sim.gpuFanOn ? clampN(30 + (sim.gpuTemp - 50) * 1.15, 30, 100) : 0;
  const gpuFanRpm = sim.gpuFanOn ? 380 + gpuFanPct * 24 + gauss() * 6 : 0;
  const dgpu: GpuTelemetry = {
    name: DGPU_NAME,
    vendor: "nvidia",
    load: r1(gLoad),
    vramUsedGb: r2(sim.vram),
    vramTotalGb: 16,
    coreClockMhz: r1(coreClock),
    memClockMhz: r1(memClock),
    tempC: r1(sim.gpuTemp),
    hotspotTempC: r1(sim.gpuTemp + 7.5 + gLoad * 0.07),
    powerW: r1(Math.max(8, 13 + gLoad * 2.95 + gauss() * 2)),
    fanRpm: r1(Math.max(0, gpuFanRpm)),
    fanPct: r1(gpuFanPct),
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
  };

  // RAM
  sim.ram = clampN(lag(sim.ram, 9.8 + sim.cpuWork * 15 + sim.gpuWork * 7.5, dt, 7) + gauss() * 0.03, 6, 60);

  // Fans
  const hottest = Math.max(sim.cpuTemp, sim.gpuTemp);
  const fans: FanTelemetry[] = FANS.map((f, i) => {
    const autoDuty =
      f.kind === "cpu" ? curve(sim.cpuTemp, 40, 85, 22, 100) : f.kind === "pump" ? 85 : curve(hottest, 40, 85, 25, 90);
    let duty: number;
    if (!f.controllable || sim.preset === "auto") duty = autoDuty;
    else if (sim.preset === "custom") duty = sim.customDuty[i];
    else duty = PRESET_DUTY[sim.preset];
    sim.fanDuty[i] = duty;
    const target = duty <= 0 ? 0 : f.minRpm + (f.maxRpm - f.minRpm) * (duty / 100);
    sim.fanRpm[i] = Math.max(0, lag(sim.fanRpm[i], target, dt, f.kind === "pump" ? 2 : 1.4) + gauss() * (f.kind === "pump" ? 9 : 5));
    return {
      id: f.id,
      name: f.name,
      hardware: FAN_HARDWARE,
      rpm: r1(sim.fanRpm[i]),
      controllable: f.controllable,
      controlPct: f.controllable ? r1(duty) : null,
    };
  });

  // Disks
  const elapsedHours = Math.floor((ts - sim.startedAt) / 3_600_000);
  const disks = DISKS.map((d, i) => {
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
    const tTarget = d.baseTemp + Math.min(14, (read + write) / 180) + sim.cpuWork * 3;
    s.temp = lag(s.temp, tTarget, dt, 9) + gauss() * 0.1;
    return {
      id: d.id,
      name: d.name,
      tempC: r1(s.temp),
      readMBps: r2(read),
      writeMBps: r2(write),
      healthPct: d.health,
      tbw: d.tbw == null ? null : r2(s.tbw),
      powerOnHours: d.poh + elapsedHours,
      usedPct: d.usedPct,
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
  const up = 0.01 + Math.abs(gauss()) * 0.03 + (p.name === "streaming" ? 0.75 + gauss() * 0.04 : 0);

  return {
    type: "telemetry",
    ts,
    cpu: {
      name: CPU_TELEMETRY_NAME,
      loadTotal: r1(loadTotal),
      loadPerCore: perCore.map(r1),
      clockMhz: r1(sim.clock),
      maxClockMhz: 5700,
      packageTempC: r1(sim.cpuTemp),
      voltage: r3(voltage),
      powerW: r1(cpuPower),
      cores: CORES,
      threads: THREADS,
    },
    gpu: dgpu,
    gpus: [dgpu, igpu],
    ram: {
      usedGb: r2(sim.ram),
      availableGb: r2(RAM_TOTAL_GB - sim.ram),
      totalGb: RAM_TOTAL_GB,
      loadPct: r1((sim.ram / RAM_TOTAL_GB) * 100),
      speedMts: 6000,
      formFactor: "DIMM",
      slotsUsed: 2,
      slotsTotal: 4,
    },
    fans,
    disks,
    network: { downMBps: r2(down), upMBps: r2(Math.max(0, up)) },
    fanPreset: sim.preset,
  };
}

/* ------------------------------------------------------------------ */
/* Agent lifecycle + telemetry timer                                   */
/* ------------------------------------------------------------------ */

let booted = false;
let backfilled = false;
let agentRunning = !NO_AGENT;
let restarting = false;
let lastPacketTs: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let kickoff: ReturnType<typeof setTimeout> | null = null;
let lastTick = 0;

function agentStatus(): AgentStatus {
  let message: string;
  if (restarting) message = "Restarting nexum-agent…";
  else if (!agentRunning) message = "nexum-agent.exe could not be started (simulated failure)";
  else if (LIMITED) message = "nexum-agent 1.0.0 (simulated) · limited privileges, fan control unavailable";
  else message = "nexum-agent 1.0.0 (simulated) · LibreHardwareMonitor sensors online";
  return { running: agentRunning && !restarting, isAdmin: !LIMITED, message, lastPacketTs };
}

function emitStatus(): void {
  emit("agent-status", agentStatus());
}

function ack(cmd: string, ok: boolean, message: string, delay = 320): void {
  setTimeout(() => emit("agent-ack", { cmd, ok, message } satisfies AgentAck), delay);
}

function tick(): void {
  const now = performance.now();
  const dt = clampN((now - lastTick) / 1000, 0.05, 5);
  lastTick = now;
  const pkt = step(dt, Date.now());
  lastPacketTs = pkt.ts;
  emit("telemetry", pkt);
}

/** Emit ~90 seconds of history so charts are populated as soon as the preview opens. */
function backfill(): void {
  if (backfilled) return;
  backfilled = true;
  const count = 90;
  const dt = sim.intervalMs / 1000;
  const now = Date.now();
  for (let i = count; i >= 1; i--) {
    const pkt = step(dt, now - i * sim.intervalMs);
    emit("telemetry", pkt);
  }
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  if (kickoff) clearTimeout(kickoff);
  timer = null;
  kickoff = null;
}

function startTimer(): void {
  stopTimer();
  lastTick = performance.now();
  // Give subscribers registered in the same tick a moment to attach.
  kickoff = setTimeout(() => {
    kickoff = null;
    backfill();
    tick();
  }, 60);
  timer = setInterval(tick, sim.intervalMs);
}

function applyPollInterval(ms: number): void {
  sim.intervalMs = Math.round(clampN(ms, 250, 10_000));
  if (timer && agentRunning && !restarting) startTimer();
}

function boot(): void {
  if (booted) return;
  booted = true;
  if (agentRunning) startTimer();
  setTimeout(emitStatus, 0);
}

/* ------------------------------------------------------------------ */
/* Static inventory: system, volumes, disks                            */
/* ------------------------------------------------------------------ */

const bootedAt = Date.now() - (3 * 86_400 + 4 * 3_600 + 12 * 60 + 9) * 1000;
let lastDriverScan: string | null = null;

function systemInfo(): SystemInfo {
  return {
    hostname: "WORKSTATION-01",
    cpuName: CPU_WMI_NAME,
    gpuNames: [DGPU_NAME, IGPU_NAME],
    motherboard: { manufacturer: "ASUSTeK COMPUTER INC.", product: "ROG CROSSHAIR X670E HERO", version: "Rev 1.xx" },
    bios: { vendor: "American Megatrends Inc.", version: "2413", releaseDate: "2025-06-18", mode: "UEFI" },
    os: {
      caption: "Microsoft Windows 11 Pro",
      version: "10.0.26200",
      build: "26200.6899",
      displayVersion: "25H2",
      architecture: "64-bit",
      installDate: "2025-10-04",
    },
    secureBoot: true,
    tpm: { present: true, version: "2.0" },
    uptimeSecs: Math.floor((Date.now() - bootedAt) / 1000),
    isAdmin: !LIMITED,
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

const VOLUME_SPECS: VolumeSpec[] = [
  { letter: "C:", label: "Windows", fileSystem: "NTFS", totalBytes: 1_999_461_740_544, usedFraction: 0.61, driveType: "Fixed", isSystem: true },
  { letter: "D:", label: "Games", fileSystem: "NTFS", totalBytes: 1_000_186_310_656, usedFraction: 0.78, driveType: "Fixed", isSystem: false },
  { letter: "E:", label: "Archive", fileSystem: "NTFS", totalBytes: 4_000_768_323_584, usedFraction: 0.47, driveType: "Fixed", isSystem: false },
  { letter: "F:", label: "NEXUM-USB", fileSystem: "exFAT", totalBytes: 61_530_439_680, usedFraction: 0.31, driveType: "Removable", isSystem: false },
];

function volumes(): Volume[] {
  return VOLUME_SPECS.map((v) => {
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

const PHYSICAL_DISKS: PhysicalDisk[] = [
  { deviceId: "0", model: "Samsung SSD 990 PRO 2TB", mediaType: "SSD", busType: "NVMe", sizeBytes: 2_000_398_934_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "S73WNJ0W612345A" },
  { deviceId: "1", model: "WD_BLACK SN850X 1000GB", mediaType: "SSD", busType: "NVMe", sizeBytes: 1_000_204_886_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "23125L801234" },
  { deviceId: "2", model: "ST4000DM004-2CV104", mediaType: "HDD", busType: "SATA", sizeBytes: 4_000_787_030_016, healthStatus: "Healthy", operationalStatus: "OK", serial: "ZFN0A1B2" },
  { deviceId: "3", model: "SanDisk Extreme 64GB", mediaType: "Unspecified", busType: "USB", sizeBytes: 61_530_439_680, healthStatus: "Healthy", operationalStatus: "OK", serial: "4C530001230512" },
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

let driverCache: DriverInfo[] | null = null;
const inventoryEpoch = Date.now();

function buildDrivers(): DriverInfo[] {
  if (driverCache) return driverCache;
  const rng = mulberry32(0x4e58554d);
  const hex = (len: number) => {
    let s = "";
    for (let i = 0; i < len; i++) s += "0123456789ABCDEF"[Math.floor(rng() * 16)];
    return s;
  };
  const list: DriverInfo[] = [];
  for (const sp of DRIVER_SPECS) {
    sp.names.forEach((name, idx) => {
      const ageDays = sp.age;
      const signed = sp.signed !== false;
      const status: DriverInfo["status"] = !signed ? "unsigned" : ageDays > 1095 ? "outdated" : "ok";
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
        status,
      });
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
    "date", "signed", "signer", "infName", "deviceId", "ageDays", "status",
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
/* Deep Purge simulation                                               */
/* ------------------------------------------------------------------ */

interface TrashDef {
  id: TrashCategoryId;
  label: string;
  description: string;
  gb: number;
  files: number;
  optional: boolean;
  requiresAdmin: boolean;
}

// Non-optional categories add up to exactly 4.82 GB on a fresh preview.
const TRASH_DEFS: TrashDef[] = [
  { id: "temp", label: "Temporary Files", description: "User %TEMP% and C:\\Windows\\Temp. Locked or in-use files are skipped.", gb: 1.73, files: 5214, optional: false, requiresAdmin: false },
  { id: "recycle", label: "Recycle Bin", description: "Deleted items on all mounted drives.", gb: 1.21, files: 318, optional: false, requiresAdmin: false },
  { id: "wu-cache", label: "Windows Update Cache", description: "SoftwareDistribution\\Download and Delivery Optimization cache.", gb: 0.98, files: 47, optional: false, requiresAdmin: true },
  { id: "shader", label: "GPU Shader Caches", description: "DirectX D3DSCache, NVIDIA DXCache/GLCache and AMD shader caches.", gb: 0.56, files: 2906, optional: false, requiresAdmin: false },
  { id: "browser", label: "Browser & App Caches", description: "Chrome, Edge, Firefox and Discord caches. Logins and cookies are kept.", gb: 0.74, files: 8120, optional: true, requiresAdmin: false },
  { id: "logs", label: "Logs & Crash Dumps", description: "Minidumps, WER reports, Prefetch older than 30 days, old CBS logs.", gb: 0.34, files: 214, optional: false, requiresAdmin: true },
  { id: "standby", label: "RAM Standby List", description: "Flush cached standby memory through nexum-agent.", gb: 0, files: 0, optional: true, requiresAdmin: true },
];

const lastPurgeAt: Partial<Record<TrashCategoryId, number>> = {};
let purgeRunning = false;

/** Purged categories regrow slowly so repeated demos stay believable. */
function regrowth(id: TrashCategoryId): number {
  const t = lastPurgeAt[id];
  if (t == null) return 1;
  return clampN(0.015 + (Date.now() - t) / (10 * 60 * 1000), 0, 1);
}

function categoryBytes(def: TrashDef): { bytes: number; files: number } {
  const f = regrowth(def.id);
  return { bytes: Math.round(def.gb * GIB * f), files: Math.round(def.files * f) };
}

/* ------------------------------------------------------------------ */
/* Public mock backend (mirrors `api` in ./api.ts)                     */
/* ------------------------------------------------------------------ */

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
    return PHYSICAL_DISKS.map((d) => ({ ...d }));
  },

  async scanTrash(includeBrowser: boolean): Promise<TrashScan> {
    const started = performance.now();
    await sleep(rand(850, 1400));
    const categories: TrashCategory[] = TRASH_DEFS.map((def) => {
      // Mirrors cleaner.rs: browser caches are always measured; includeBrowser only pre-selects them.
      const { bytes, files } = categoryBytes(def);
      const enabled =
        def.id === "browser" ? includeBrowser : def.id === "standby" ? settings.flushStandbyOnPurge : true;
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        bytes,
        files,
        enabled,
        optional: def.optional,
        requiresAdmin: def.requiresAdmin,
      };
    });
    return {
      categories,
      totalBytes: categories.reduce((s, c) => s + c.bytes, 0),
      durationMs: Math.round(performance.now() - started),
    };
  },

  async purgeTrash(categories: string[], flushStandby: boolean): Promise<PurgeResult> {
    if (purgeRunning) throw new Error("A purge is already in progress");
    purgeRunning = true;
    try {
      const started = performance.now();
      const wanted = new Set(categories);
      const fileDefs = TRASH_DEFS.filter((d) => wanted.has(d.id) && d.id !== "standby");
      const doStandby = flushStandby || wanted.has("standby");
      const totalSteps = fileDefs.length + (doStandby ? 1 : 0);
      const perCategory: PurgeCategoryResult[] = [];
      let freed = 0;
      let deleted = 0;
      let skipped = 0;
      let stepNo = 0;
      const stepMs = totalSteps > 0 ? 2500 / totalSteps : 0;

      // Mirrors cleaner.rs: one event when a category starts and one when it ends (same step),
      // freedBytes always being the running total.
      for (const def of fileDefs) {
        stepNo++;
        emit("purge-progress", {
          categoryId: def.id,
          label: def.label,
          step: stepNo,
          totalSteps,
          freedBytes: freed,
        } satisfies PurgeProgress);
        await sleep(stepMs * rand(0.8, 1.2));
        const { bytes, files } = categoryBytes(def);
        const blocked = LIMITED && def.requiresAdmin;
        const ratio = blocked ? 0.22 : rand(0.972, 0.994);
        const freedHere = Math.round(bytes * ratio);
        const del = Math.round(files * ratio);
        const sk = files - del;
        lastPurgeAt[def.id] = Date.now();
        freed += freedHere;
        deleted += del;
        skipped += sk;
        perCategory.push({ id: def.id, label: def.label, freedBytes: freedHere, deleted: del, skipped: sk });
        emit("purge-progress", {
          categoryId: def.id,
          label: def.label,
          step: stepNo,
          totalSteps,
          freedBytes: freed,
        } satisfies PurgeProgress);
      }

      let standbyFlushed: boolean | null = null;
      let standbyMessage: string | null = null;
      if (doStandby) {
        stepNo++;
        emit("purge-progress", {
          categoryId: "standby",
          label: "RAM Standby List",
          step: stepNo,
          totalSteps,
          freedBytes: freed,
        } satisfies PurgeProgress);
        await sleep(stepMs);
        if (LIMITED) {
          standbyFlushed = false;
          standbyMessage = "Standby flush requires administrator privileges";
        } else {
          const mb = Math.round(rand(1400, 3600));
          standbyFlushed = true;
          standbyMessage = `Freed ${mb.toLocaleString("en-US")} MB`;
        }
        perCategory.push({ id: "standby", label: "RAM Standby List", freedBytes: 0, deleted: 0, skipped: 0 });
        emit("purge-progress", {
          categoryId: "standby",
          label: "RAM Standby List",
          step: stepNo,
          totalSteps,
          freedBytes: freed,
        } satisfies PurgeProgress);
        ack("flushStandby", standbyFlushed, standbyMessage, 0);
      }

      systemDriveFreedBytes += freed;
      return {
        freedBytes: freed,
        filesDeleted: deleted,
        filesSkipped: skipped,
        durationMs: Math.round(performance.now() - started),
        perCategory,
        standbyFlushed,
        standbyMessage,
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
      const payload = { generatedAt: new Date().toISOString(), hostname: "WORKSTATION-01", count: list.length, drivers: list };
      triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json");
    } else {
      triggerDownload(filename, driversToCsv(list), "text/csv");
    }
    return `C:\\Users\\Demo\\Documents\\Nexum\\${filename}`;
  },

  async backupDrivers(): Promise<DriverBackupResult> {
    await sleep(rand(2400, 3200));
    const path = `C:\\Users\\Demo\\Documents\\Nexum\\DriverBackup-${fileStamp()}`;
    if (LIMITED) {
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
    if (!agentRunning) throw new Error("nexum-agent is not running");
    if (LIMITED) {
      ack("fanPreset", false, "Fan control requires administrator privileges");
      return;
    }
    if (preset === "custom") {
      // Freeze current duties as the custom curve starting point.
      sim.customDuty = sim.fanDuty.map((d) => Math.round(d));
    }
    sim.preset = preset;
    const n = FANS.filter((f) => f.controllable).length;
    ack(
      "fanPreset",
      true,
      preset === "auto" ? `Released ${n} fans to BIOS control` : `Applied ${PRESET_LABEL[preset]} to ${n} fans`,
    );
  },

  async setFanControl(id: string, pct: number): Promise<void> {
    await sleep(30);
    if (!agentRunning) throw new Error("nexum-agent is not running");
    const idx = FANS.findIndex((f) => f.id === id);
    if (idx < 0) {
      ack("fanSet", false, `Unknown fan ${id}`);
      return;
    }
    const fan = FANS[idx];
    if (LIMITED) {
      ack("fanSet", false, "Fan control requires administrator privileges");
      return;
    }
    if (!fan.controllable) {
      ack("fanSet", false, `${fan.name} is not controllable (DC mode header)`);
      return;
    }
    if (sim.preset !== "custom") sim.customDuty = sim.fanDuty.map((d) => Math.round(d));
    sim.customDuty[idx] = Math.round(clampN(pct, 0, 100));
    sim.preset = "custom";
    ack("fanSet", true, `${fan.name} set to ${sim.customDuty[idx]}%`, 180);
  },

  async flushStandby(): Promise<void> {
    await sleep(30);
    if (!agentRunning) throw new Error("nexum-agent is not running");
    if (LIMITED) {
      ack("flushStandby", false, "Standby flush requires administrator privileges", 400);
      return;
    }
    const mb = Math.round(rand(1400, 3600));
    ack("flushStandby", true, `Freed ${mb.toLocaleString("en-US")} MB`, 650);
  },

  async getSettings(): Promise<Settings> {
    await sleep(40);
    return { ...settings };
  },

  async saveSettings(next: Settings): Promise<Settings> {
    await sleep(rand(120, 260));
    settings = sanitizeSettings(next);
    persistSettings(settings);
    if (settings.pollIntervalMs !== sim.intervalMs) applyPollInterval(settings.pollIntervalMs);
    return { ...settings };
  },

  async getAgentStatus(): Promise<AgentStatus> {
    await sleep(60);
    return agentStatus();
  },

  async restartAgent(): Promise<void> {
    if (NO_AGENT) {
      await sleep(600);
      emitStatus();
      throw new Error("nexum-agent.exe could not be started (simulated failure)");
    }
    if (restarting) return;
    restarting = true;
    stopTimer();
    emitStatus();
    await sleep(400);
    setTimeout(() => {
      restarting = false;
      agentRunning = true;
      sim.preset = "auto"; // sidecar restores BIOS fan control on exit
      startTimer();
      emitStatus();
    }, 1400);
  },

  async openExternal(target: string): Promise<void> {
    if (/^https?:\/\//i.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    console.info(`[nexum mock] open_external("${target}") — folders open only in the desktop app`);
  },
};

export type MockBackendType = typeof mockBackend;
