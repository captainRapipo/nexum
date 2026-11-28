// Authoritative frontend mirror of CONTRACT.md — contract version 1.2.0.
// Field names, unions and defaults here are binding for all three layers (C# sidecar,
// Rust core, React frontend). Do not rename fields. Change this file only together with
// CONTRACT.md. Owner: the contract owner (foundation); implementers do not edit it.
//
// Legend used in comments:  [NEW 1.2] added in 1.2.0 · [BREAKING 1.2] removed/renamed/re-typed
// in 1.2.0 · [CHANGED 1.2] same type, new semantics in 1.2.0. The 1.1 markers ([NEW 1.1] …) and
// the unsuffixed [NEW] / [BREAKING] / [CHANGED] markers are historical (1.1.0, 1.0.0-gate).
//
// Wording rule (CONTRACT §4.8): the word "agent" never appears in text people can see. Identifiers
// in this file keep it (AgentStatus, agent-status, agentOffline, agentLost): they are internal.

export const CONTRACT_VERSION = "1.2.0";
/**
 * [BREAKING 1.1] Value of `hello.protocol` sent by a sidecar that implements this contract (was 2).
 * Unchanged in 1.2: the sidecar is not touched this round and still reports version "1.1.0".
 */
export const AGENT_PROTOCOL = 3;

// ───────────────────────────────────────────────────────────────────────────────
// Navigation & keymap (CONTRACT §4.6)
// ───────────────────────────────────────────────────────────────────────────────

/** [BREAKING 1.1] "gaming" added (F8). */
export type ViewId =
  | "dashboard"
  | "sensors"
  | "system"
  | "storage"
  | "cooling"
  | "drivers"
  | "gaming"
  | "cleaner";

/** Order of the top-bar tabs and of the Ctrl+1..8 aliases (index + 1). [BREAKING 1.1] Ctrl+7 = Gaming, Ctrl+8 = Cleaner. */
export const VIEW_ORDER: readonly ViewId[] = [
  "dashboard",
  "sensors",
  "system",
  "storage",
  "cooling",
  "drivers",
  "gaming",
  "cleaner",
] as const;

export const VIEW_LABELS: Record<ViewId, string> = {
  dashboard: "Dashboard",
  sensors: "Sensors",
  system: "System",
  storage: "Storage",
  cooling: "Cooling",
  drivers: "Drivers",
  gaming: "Gaming",
  cleaner: "Cleaner",
};

/**
 * [NEW 1.2] Sidebar row label and page title per view (CONTRACT §4.6). Differs from VIEW_LABELS
 * only for the cleaner ("Clean caches"). VIEW_LABELS stays for the tray menu and existing callers.
 */
export const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: "Dashboard",
  sensors: "Sensors",
  system: "System",
  storage: "Storage",
  cooling: "Cooling",
  drivers: "Drivers",
  gaming: "Gaming",
  cleaner: "Clean caches",
};

/** [NEW 1.2] Sidebar groups, top to bottom. Flattened, the order equals VIEW_ORDER (F1–F9 stay monotonic). */
export type NavGroupId = "monitor" | "hardware" | "tools";
export interface NavGroup {
  id: NavGroupId;
  /** Group label, exactly as shown. */
  label: string;
  views: readonly ViewId[];
}
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "monitor", label: "Monitor", views: ["dashboard", "sensors", "system"] },
  { id: "hardware", label: "Hardware", views: ["storage", "cooling", "drivers"] },
  { id: "tools", label: "Tools", views: ["gaming", "cleaner"] },
] as const;

/**
 * [NEW 1.2] Page kind (CONTRACT §4.6). "list" pages (Sensors, Drivers) are full-bleed white, never
 * show a large title and always show their title in the toolbar. "grouped" pages sit on the canvas,
 * show a large title in regular mode and move it into the toolbar in tight mode.
 */
export type PageKind = "grouped" | "list";
export const PAGE_KIND: Record<ViewId, PageKind> = {
  dashboard: "grouped",
  sensors: "list",
  system: "grouped",
  storage: "grouped",
  cooling: "grouped",
  drivers: "list",
  gaming: "grouped",
  cleaner: "grouped",
};

/**
 * [NEW 1.2] Tight mode = viewport at most 1399 px wide OR at most 899 px tall. The same rule as the
 * `tight:` Tailwind variant in styles/nexum.css; hooks/useTightMode.ts feeds this to matchMedia.
 */
export const TIGHT_MEDIA_QUERY = "(max-width: 1399px), (max-height: 899px)";

/** [NEW 1.2] Shortcut that focuses the toolbar filter field when the page has one (Ctrl+K). */
export const SEARCH_HOTKEY_LABEL = "Ctrl K";

export type KeyAction =
  | { type: "view"; view: ViewId }
  | { type: "rescan" }
  | { type: "cleanCaches" };

/** Function-key map. [CHANGED 1.1] F8 = Gaming. F10 is never bound. */
export const FKEY_MAP: Readonly<Record<string, KeyAction>> = {
  F1: { type: "view", view: "dashboard" },
  F2: { type: "view", view: "sensors" },
  F3: { type: "view", view: "system" },
  F4: { type: "view", view: "storage" },
  F5: { type: "rescan" },
  F6: { type: "view", view: "cooling" },
  F7: { type: "view", view: "drivers" },
  F8: { type: "view", view: "gaming" },
  F9: { type: "cleanCaches" },
};

/** [NEW 1.1] Every event name Rust emits (CONTRACT §2). Use these constants with api.onEvent/subscribe. */
export const EVENTS = {
  telemetry: "telemetry",
  agentStatus: "agent-status",
  agentAck: "agent-ack",
  purgeProgress: "purge-progress",
  navigate: "navigate",
  sensorTree: "sensor-tree",
  sensorValues: "sensor-values",
  fanFailsafe: "fan-failsafe",
  selfUsage: "self-usage",
  frameSession: "frame-session",
  frameTarget: "frame-target",
  frameStats: "frame-stats",
  sensorLog: "sensor-log",
  healthAlerts: "health-alerts",
  tuningState: "tuning-state",
  /** [NEW 1.2] UpdateState on every change (CONTRACT §2.15). */
  updateState: "update-state",
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Payload of the Rust `navigate` event (tray menu). */
export type NavTarget = ViewId | "quick-clean" | "settings";

/**
 * In-app navigation request (DOM CustomEvent "nexum:navigate", detail = NavRequest | NavTarget).
 * `focus` lets a view scroll to / open an item, e.g. storage + DiskTelemetry.id, sensors + sensor id.
 */
export interface NavRequest {
  view: ViewId;
  focus?: string | null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Telemetry (sidecar → Rust → frontend, CONTRACT §1.1)
// ───────────────────────────────────────────────────────────────────────────────

export type FanPreset = "auto" | "silent" | "balanced" | "turbo" | "custom";
export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";

export interface CpuTelemetry {
  name: string;
  loadTotal: number;
  /** [CHANGED doc] One entry per PHYSICAL core (SMT threads folded), length === cores. Label: "Per-core load (8C/16T)". */
  loadPerCore: number[];
  /** [CHANGED] LHM "Cores (Average Effective)"; fallbacks in CONTRACT §1.1.2. */
  clockMhz: number | null;
  /** Highest raw per-core clock this tick. */
  maxClockMhz: number | null;
  /** AMD: "Core (Tctl/Tdie)"; Intel: "CPU Package" (source order in CONTRACT §1.1.2). Also the fan-override input. */
  packageTempC: number | null;
  voltage: number | null;
  powerW: number | null;
  /** Physical cores. */
  cores: number;
  /** Logical processors. */
  threads: number;
}

export interface GpuTelemetry {
  name: string;
  vendor: GpuVendor;
  load: number | null;
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  coreClockMhz: number | null;
  memClockMhz: number | null;
  /** [CHANGED doc] EDGE temperature (LHM "GPU Core"). UI label: "Edge temp". */
  tempC: number | null;
  hotspotTempC: number | null;
  powerW: number | null;
  fanRpm: number | null;
  fanPct: number | null;
  /** [NEW 1.1] "GPU Memory Junction" (NVIDIA) or "GPU Memory" (AMD) temperature, °C. Input of the gpu-mem-temp alert. */
  memJunctionTempC: number | null;
}

export interface RamTelemetry {
  usedGb: number;
  availableGb: number;
  totalGb: number;
  loadPct: number;
  speedMts: number | null;
  formFactor: string | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
}

export interface FanTelemetry {
  /** LHM sensor identifier of the RPM sensor, e.g. "/lpc/it8688e/0/fan/1". Also the label key. */
  id: string;
  /** LHM default name ("CPU Fan", "System Fan #1"). Display via the label overlay, never raw. */
  name: string;
  hardware: string;
  /** [NEW] LHM hardware identifier that owns this fan, e.g. "/lpc/it8688e/0" or "/gpu-amd/0". */
  hwId: string;
  rpm: number;
  /** [NEW] LHM session minimum / maximum RPM (reset by sensorReset). */
  rpmMin: number | null;
  rpmMax: number | null;
  controllable: boolean;
  controlPct: number | null;
}

// ── Drive health (MF-1, CONTRACT §1.1.3) ──

export type DriveHealthState = "good" | "attention" | "replace" | "failing" | "unknown";
export type DriveHealthSource = "nvme" | "smart" | "none";

export interface DriveHealth {
  state: DriveHealthState;
  /** Short label produced by the sidecar classifier (exact strings in CONTRACT §1.1.3). */
  label: string;
  /** One sentence explaining the trigger, e.g. "44% life left · 56% of rated endurance used · 20,188 power-on hours". */
  reason: string;
  source: DriveHealthSource;
}

export interface DiskTelemetry {
  /** LHM hardware identifier ("/nvme/0", "/ssd/1", "/hdd/2"). Equals HardwareNode.id in the sensor tree. */
  id: string;
  name: string;
  /** [NEW] Windows physical disk number (PhysicalDriveN) or null. Fallback join key to PhysicalDisk.deviceId. */
  diskNumber: number | null;
  /** [NEW] Drive serial as reported by the drive (trimmed). Primary join key, see normSerial(). */
  serial: string | null;
  tempC: number | null;
  /** [NEW] LHM session min / max of the temperature sensor. */
  tempMinC: number | null;
  tempMaxC: number | null;
  readMBps: number | null;
  writeMBps: number | null;
  /** Remaining life % (100 − percentageUsed for NVMe). */
  healthPct: number | null;
  /** Host data written, TB. */
  tbw: number | null;
  powerOnHours: number | null;
  usedPct: number | null;
  /** [NEW] Single source of truth for drive health. Never derive state from healthPct in the UI. */
  health: DriveHealth;
  /** [NEW] NVMe critical-warning byte (bit field), null if not NVMe / unknown. */
  criticalWarning: number | null;
  /** [NEW] NVMe available spare % and its threshold %. */
  availableSparePct: number | null;
  availableSpareThresholdPct: number | null;
  /** [NEW] NVMe "Percentage Used" (may exceed 100). */
  percentageUsed: number | null;
  /** [NEW] NVMe counters. */
  mediaErrors: number | null;
  unsafeShutdowns: number | null;
  powerCycles: number | null;
  errorLogEntries: number | null;
  /** [NEW] Drive thresholds (NVMe WCTEMP / CCTEMP), °C. */
  warningTempC: number | null;
  criticalTempC: number | null;
  /** [NEW] Minutes spent above the warning / critical composite temperature (NVMe). */
  warningTempMinutes: number | null;
  criticalTempMinutes: number | null;
  /** [NEW] ATA SMART raw counts: 05 Reallocated, C5 Pending, C6 Offline uncorrectable. */
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  uncorrectableSectors: number | null;
  /** [NEW] Host data read, TB. */
  dataReadTb: number | null;
}

export interface NetworkTelemetry {
  downMBps: number;
  upMBps: number;
}

// ── Fan safety (MF-13, CONTRACT §1.5) ──

export type FanOverrideReason = "failsafe" | "sensorMissing" | "cpuTemp" | "gpuTemp";

export interface FanSafety {
  /** True while at least one header is under Nexum's manual (software) control. */
  manualActive: boolean;
  /** True while the thermal override holds every controlled header at 100%. */
  overrideActive: boolean;
  /** Why the override (or failsafe) is active; null when overrideActive is false. */
  reason: FanOverrideReason | null;
  /** True when this agent started with a same-boot write-ahead flag and latched fans at 100%. */
  failsafe: boolean;
  /** Always 85. */
  triggerC: number;
  /** Always 75 (trigger − 10 °C hysteresis). */
  releaseC: number;
}

export interface TelemetryPacket {
  type: "telemetry";
  ts: number;
  cpu: CpuTelemetry;
  gpu: GpuTelemetry | null;
  gpus: GpuTelemetry[];
  ram: RamTelemetry;
  fans: FanTelemetry[];
  disks: DiskTelemetry[];
  network: NetworkTelemetry | null;
  /** Last preset the user requested (not the override state; see fanSafety). */
  fanPreset: FanPreset;
  /** [NEW] */
  fanSafety: FanSafety;
}

export interface AgentAck {
  cmd: string;
  ok: boolean;
  message: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// Agent status / degraded mode (MF-2, CONTRACT §1.1 hello, §2.3)
// ───────────────────────────────────────────────────────────────────────────────

export type SensorDriverReason = "missing" | "outdated" | "notElevated";

export interface SensorDriverStatus {
  kind: "pawnio" | "none";
  /** Installed PawnIO version ("2.2.0") or null. */
  version: string | null;
  /** Always "2.1.0". */
  minVersion: string;
  /** isAdmin && installed && version ≥ minVersion. */
  ok: boolean;
  /** Precedence missing > outdated > notElevated; null when ok. */
  reason: SensorDriverReason | null;
}

export type LimitedReason = "notElevated" | "pawnIoMissing" | "pawnIoOutdated";

/**
 * Reasons accepted by the <Unavailable> primitive. [CHANGED 1.2] The id "agentOffline" stays, but its
 * text is now NOT_AVAILABLE_TEXT ("Not available right now"); no visible text says "agent".
 */
export type UnavailableReason = LimitedReason | "unsupported" | "agentOffline";

/** [NEW 1.2] Tooltip / cause text of a value that cannot be read at the moment (CONTRACT §4.8). */
export const NOT_AVAILABLE_TEXT = "Not available right now";

/**
 * [NEW 1.2] Life cycle of the background sensor service as Rust reports it (CONTRACT §2.3).
 * starting   → spawned, no hello yet (also right after "Try again")
 * running    → hello received
 * restarting → it stopped or stopped answering; Rust is restarting it (SENSOR_RESTART_* policy)
 * failed     → Rust gave up; the UI shows the one banner (SENSORS_DOWN_TITLE) with "Try again"
 * stopped    → Nexum itself stopped it (app exit, installing an update)
 * The UI shows nothing for starting / running / restarting / stopped.
 */
export type SensorServicePhase = "starting" | "running" | "restarting" | "failed" | "stopped";

/** [NEW 1.2] Why the sensor service is in phase "failed" (CONTRACT §2.3). */
export type SensorFailReason = "blocked" | "missing" | "crashed" | "notResponding" | "startFailed";

/** [NEW 1.2] Automatic restart policy (CONTRACT §2.3). Rust implements it; mirrored for the mock. */
export const SENSOR_RESTART_MAX = 5;
/** Delay before automatic restart 1..5. */
export const SENSOR_RESTART_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000] as const;
/** The restart counter returns to 0 after the service has run this long without stopping. */
export const SENSOR_HEALTHY_RUN_MS = 60_000;

/** [NEW 1.2] The one banner shown when the sensor service is in phase "failed" (CONTRACT §4.8.1). Exact texts. */
export const SENSORS_DOWN_TITLE = "Nexum can't read sensors right now.";
export const SENSORS_RETRY_LABEL = "Try again";
/** Short plain reason under the title; no line when failReason is null. */
export const SENSORS_DOWN_REASON: Record<SensorFailReason, string> = {
  blocked: "Windows security blocked part of Nexum.",
  missing: "Part of Nexum is missing. Installing Nexum again fixes this.",
  crashed: "Sensor reading stopped and could not be restarted.",
  notResponding: "Sensor reading stopped responding.",
  startFailed: "Sensor reading could not be started.",
};
/** Pill fragment for the same condition ("Attention · Sensors unavailable") and the tray tooltip head. */
export const SENSORS_DOWN_SHORT = "Sensors unavailable";

/** What a value needs in order to be readable (CONTRACT §4.5 resolveUnavailable). */
export type FeatureNeed = "admin" | "pawnio" | "none";

/** Same-boot write-ahead flag found by the agent at startup (CONTRACT §1.5). */
export type FanFlagState = "none" | "interrupted" | "previousBoot";

/** Shape of the sidecar `hello` line (consumed by Rust only; mirrored for documentation/tests). */
export interface AgentHello {
  type: "hello";
  version: string;
  /** Always AGENT_PROTOCOL ([BREAKING 1.1] 3; was 2). `version` is "1.1.0". */
  protocol: number;
  isAdmin: boolean;
  pid: number;
  /** [NEW] */
  sensorDriver: SensorDriverStatus;
  /** [NEW] */
  fanFlag: FanFlagState;
}

export interface AgentStatus {
  running: boolean;
  isAdmin: boolean;
  /** [CHANGED 1.2] Diagnostic text for logs only. Never rendered in the UI (it may name internals). */
  message: string;
  lastPacketTs: number | null;
  /** [NEW 1.2] Life cycle of the sensor service. The UI shows the "can't read sensors" banner only for "failed". */
  phase: SensorServicePhase;
  /** [NEW 1.2] Set only while phase === "failed", else null. */
  failReason: SensorFailReason | null;
  /** [NEW] Copied from the last hello; null until a hello arrives or while the agent is down. */
  sensorDriver: SensorDriverStatus | null;
  /** [NEW] Empty while the agent is down (offline is not "limited"). Order: notElevated, pawnIoMissing|pawnIoOutdated. */
  limitedReasons: LimitedReason[];
  /** [NEW] Display-ready feature names, fixed vocabulary and order (CONTRACT §2.3). */
  missingFeatures: string[];
  /** [NEW] hello.protocol of the running agent, null if unknown. */
  protocol: number | null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Sensors view (CONTRACT §1.3)
// ───────────────────────────────────────────────────────────────────────────────

/** = LHM SensorType (0.9.6), camelCased. Display order of groups is SENSOR_KIND_ORDER. */
export type SensorKind =
  | "voltage"
  | "current"
  | "power"
  | "clock"
  | "temperature"
  | "load"
  | "frequency"
  | "fan"
  | "flow"
  | "control"
  | "level"
  | "factor"
  | "data"
  | "smallData"
  | "throughput"
  | "timeSpan"
  | "timing"
  | "energy"
  | "noise"
  | "conductivity"
  | "humidity";

/** HWMonitor-style group order inside one hardware node. */
export const SENSOR_KIND_ORDER: readonly SensorKind[] = [
  "voltage",
  "current",
  "power",
  "clock",
  "frequency",
  "temperature",
  "load",
  "fan",
  "control",
  "flow",
  "level",
  "factor",
  "data",
  "smallData",
  "throughput",
  "timeSpan",
  "timing",
  "energy",
  "noise",
  "conductivity",
  "humidity",
] as const;

/** = LHM HardwareType (0.9.6), camelCased; "other" for any value added later. */
export type HardwareKind =
  | "motherboard"
  | "superio"
  | "cpu"
  | "memory"
  | "gpuNvidia"
  | "gpuAmd"
  | "gpuIntel"
  | "storage"
  | "network"
  | "cooler"
  | "embeddedController"
  | "psu"
  | "battery"
  | "powerMonitor"
  | "other";

export type SensorUnit =
  | "V"
  | "A"
  | "W"
  | "MHz"
  | "°C"
  | "%"
  | "Hz"
  | "RPM"
  | "L/h"
  | "GB"
  | "MB"
  | "MB/s"
  | "s"
  | "h"
  | "ns"
  | "mWh"
  | "dBA"
  | "µS/cm"
  | "";

export interface SensorMeta {
  /** LHM sensor Identifier, e.g. "/lpc/it8688e/0/temperature/4". Stable key for labels/pins/hidden. */
  id: string;
  /** Dense index 0..N−1 into SensorValues arrays; valid only for the tree `rev` it came with. */
  idx: number;
  /** HardwareNode.id that owns this sensor. */
  hwId: string;
  /** LHM default name ("VRM MOS"). Never renamed by the sidecar. */
  name: string;
  kind: SensorKind;
  unit: SensorUnit;
  /** Display decimals; the sidecar already rounds values to this. */
  decimals: number;
  /** Value never changes during a session (SPD timings, capacities, limits). No sparkline. */
  static: boolean;
  /** Sidecar hint: sensor had no value when the tree was built. */
  defaultHidden: boolean;
}

export interface HardwareNode {
  /** LHM hardware Identifier, e.g. "/lpc/it8688e/0", "/amdcpu/0", "/nvme/0". */
  id: string;
  /** Parent hardware id for sub-hardware (Super I/O under Motherboard), null for roots. */
  parentId: string | null;
  kind: HardwareKind;
  name: string;
  sensors: SensorMeta[];
}

export interface SensorTree {
  type: "sensorTree";
  /** Monotonic within one agent process; bumps whenever the set or order of sensors changes. */
  rev: number;
  /** Unix ms of agent start or of the last reset-all. Header shows "since HH:MM (elapsed)". */
  sessionStartTs: number;
  /** Depth-first order: each parent precedes its children. */
  hardware: HardwareNode[];
}

export interface SensorValues {
  type: "sensorValues";
  ts: number;
  /** Must equal the current SensorTree.rev, otherwise drop the packet and re-fetch the tree. */
  rev: number;
  /** Arrays indexed by SensorMeta.idx, length = sensor count; null = n/a. Values in SensorMeta.unit. */
  value: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  avg: (number | null)[];
}

// ───────────────────────────────────────────────────────────────────────────────
// System view lite (CONTRACT §1.4, §2.6)
// ───────────────────────────────────────────────────────────────────────────────

export interface CpuCacheSpec {
  level: 1 | 2 | 3;
  type: "data" | "instruction" | "unified";
  /** Size of ONE instance in KB. */
  sizeKb: number;
  /** Associativity; null = fully associative (0xFF) or unknown. */
  ways: number | null;
  /** Number of instances (e.g. 8 × 32 KB). */
  instances: number;
}

export interface CpuSpec {
  name: string;
  vendor: "AMD" | "Intel" | "Other";
  /** From a small static table; null if unknown. */
  codename: string | null;
  /** Win32_Processor.SocketDesignation (e.g. "AM4"); null if empty. */
  socket: string | null;
  /** Display family/model (base + extended), decimal. UI shows hex, e.g. 25 → "19h". */
  family: number;
  model: number;
  stepping: number;
  cores: number;
  threads: number;
  /** Win32_Processor.MaxClockSpeed (nominal base), MHz. */
  baseClockMhz: number | null;
  /** Sorted: L1 data, L1 instruction, L2, L3. */
  caches: CpuCacheSpec[];
  /** Fixed vocabulary and order, see CONTRACT §1.4. */
  instructions: string[];
}

export interface BoardSpec {
  /** Raw strings (trimmed). Display normalization (e.g. "AMI", "Gigabyte") is done by lib/format.ts. */
  manufacturer: string;
  product: string;
  version: string;
  biosVendor: string;
  biosVersion: string;
  /** "YYYY-MM-DD" or "". */
  biosDate: string;
  /** LHM Super I/O chip name ("ITE IT8688E"), null without PawnIO / not found. */
  superIo: string | null;
}

export type MemoryType = "DDR3" | "DDR4" | "DDR5" | "LPDDR4" | "LPDDR5" | "Unknown";

export interface DimmSpec {
  /** Win32_PhysicalMemory.DeviceLocator ("DIMM 1", "A2"). Never invent slot positions. */
  slot: string;
  manufacturer: string;
  partNumber: string;
  sizeGb: number;
  /** Rated speed (Win32_PhysicalMemory.Speed), MT/s. */
  speedMts: number | null;
  /** ConfiguredClockSpeed, MT/s. */
  configuredSpeedMts: number | null;
  /** Win32_PhysicalMemory.Attributes (rank count), null if 0/absent. */
  ranks: number | null;
  /** ConfiguredVoltage / 1000, volts. */
  voltage: number | null;
  /** "DIMM" | "SODIMM" | other SMBIOS form-factor names. */
  formFactor: string;
  /** [NEW 1.1] SPD JEDEC data from LHM DimmMemory (needs admin + PawnIO); null when unavailable or unmatched (CONTRACT §1.4.1). */
  spd: SpdInfo | null;
}

/** [NEW 1.1] DDR4 timings in clock cycles (CONTRACT §1.4.1). Every member null when not read. */
export interface MemoryTimings {
  cl: number | null;
  rcdRd: number | null;
  rcdWr: number | null;
  rp: number | null;
  ras: number | null;
  rc: number | null;
  rfc: number | null;
  rrds: number | null;
  rrdl: number | null;
  faw: number | null;
  wtrs: number | null;
  wtrl: number | null;
  wr: number | null;
  rtp: number | null;
  cwl: number | null;
  /** null for SPD-derived timings. */
  commandRate: "1T" | "2T" | null;
  /** Gear-down mode; null for SPD-derived timings. */
  gearDown: boolean | null;
}

/**
 * [NEW 1.1] "umc" = live, read from the AMD memory controller; "spd" = JEDEC minimums from the first
 * DIMM's SPD converted to cycles (UI label "SPD JEDEC (not the running timings)"); "unavailable".
 */
export type TimingsSource = "umc" | "spd" | "unavailable";

/** [NEW 1.1] Keys of SpdInfo.timingsNs (LHM DimmMemory Timing sensor names without spaces). */
export type SpdTimingKey =
  | "tAA"
  | "tRCD"
  | "tRP"
  | "tRAS"
  | "tRC"
  | "tRFC1"
  | "tRFC2"
  | "tRFC4"
  | "tFAW"
  | "tRRD_S"
  | "tRRD_L"
  | "tCCD_L"
  | "tWR"
  | "tWTR_S"
  | "tWTR_L";

/** [NEW 1.1] JEDEC timings in cycles at jedecSpeedMts: cycles = ceil(ns / (2000 / jedecSpeedMts) − 0.025). */
export interface SpdCycles {
  cl: number | null;
  rcd: number | null;
  rp: number | null;
  ras: number | null;
  rc: number | null;
  rfc: number | null;
  faw: number | null;
  rrds: number | null;
  rrdl: number | null;
  wr: number | null;
  wtrs: number | null;
  wtrl: number | null;
}

/** [NEW 1.1] One DIMM's SPD data (CONTRACT §1.4.1). Never contains serial numbers. */
export interface SpdInfo {
  source: "jedec";
  /** = DimmSpec.speedMts; null → cycles members are null. */
  jedecSpeedMts: number | null;
  /** JEDEC minimum times in ns, keyed by SpdTimingKey (null when the sensor is absent). */
  timingsNs: Record<SpdTimingKey, number | null>;
  cycles: SpdCycles;
  /** Module thermal sensor at capture time; null when the module has none. */
  tempC: number | null;
  /** How the LHM DIMM node was matched to this slot. */
  matchedBy: "order" | "partNumber";
}

export interface MemorySpec {
  type: MemoryType;
  totalGb: number;
  /** Distinct channels parsed from BankLabel/DeviceLocator; null if not derivable. */
  channels: number | null;
  /** Populated / total slots ("2 of 4 DIMMs"). */
  slotsUsed: number;
  slotsTotal: number | null;
  dimms: DimmSpec[];
  /** [BREAKING 1.1] was always null. Live (umc) or SPD-derived (spd) timings; null when unavailable. */
  timings: MemoryTimings | null;
  /** [BREAKING 1.1] was always "unavailable". */
  timingsSource: TimingsSource;
  /** [NEW 1.1] Exact display sentence why live timings are not shown (CONTRACT §1.4.1 table); null when timingsSource === "umc". */
  timingsNote: string | null;
  /** [NEW 1.1] Memory clock MHz (DDR4-3200 → 1600). */
  memclkMhz: number | null;
  /** [NEW 1.1] Infinity Fabric clock MHz (LHM "Fabric Clock"); null when not reported. */
  fclkMhz: number | null;
  /** [NEW 1.1] Memory-controller clock MHz (LHM "Uncore Clock"); null when not reported. */
  uclkMhz: number | null;
  /** Always null (XMP parsing is v1.3+). */
  xmp: null;
}

/** [NEW 1.1] PCIe link (CONTRACT §1.4.1). */
export interface PcieLink {
  gen: number | null;
  width: number | null;
  maxGen: number | null;
  maxWidth: number | null;
  source: "adl" | "devpkey" | "unknown";
  /** Display-ready caveat (Radeon on-board switch), or null. */
  note: string | null;
}

export interface GpuSpec {
  name: string;
  vendor: GpuVendor;
  vramGb: number | null;
  driverVersion: string | null;
  /** "YYYY-MM-DD" or null. */
  driverDate: string | null;
  /** [NEW 1.1] null when nothing readable. */
  link: PcieLink | null;
}

/** [NEW 1.1] Storage link per Windows disk (CONTRACT §1.4.1). Join diskNumber ↔ PhysicalDisk.deviceId. */
export interface DiskLink {
  diskNumber: number;
  model: string;
  bus: "nvme" | "sata" | "usb" | "other";
  /** PCIe generation/width (NVMe only). */
  gen: number | null;
  width: number | null;
  maxGen: number | null;
  maxWidth: number | null;
  /** SATA generation (1/2/3) when reported. */
  sataGen: number | null;
}

export interface OsSpec {
  caption: string;
  displayVersion: string;
  build: string;
  architecture: string;
  /** "YYYY-MM-DD" or "". */
  installDate: string;
  /** Unix ms of the last boot. Uptime = now − bootTs (the only uptime source in the UI). */
  bootTs: number;
}

export interface SecuritySpec {
  secureBoot: boolean | null;
  tpm: { present: boolean; version: string | null } | null;
  biosMode: "UEFI" | "Legacy" | "Unknown";
}

/** The sidecar's `{type:"spec"}` reply (CONTRACT §1.4); Rust merges it into SystemSpec. */
export interface AgentSpec {
  type: "spec";
  capturedTs: number;
  cpu: CpuSpec | null;
  board: BoardSpec | null;
  memory: MemorySpec | null;
  gpus: GpuSpec[];
  /** [NEW 1.1] */
  diskLinks: DiskLink[];
  errors: string[];
}

/** Returned by `get_system_spec`. cpu/board/memory/gpus/diskLinks come from the sidecar; os/security from Rust. */
export interface SystemSpec {
  capturedTs: number;
  cpu: CpuSpec | null;
  board: BoardSpec | null;
  memory: MemorySpec | null;
  gpus: GpuSpec[];
  os: OsSpec;
  security: SecuritySpec;
  /** [NEW 1.1] Copied from AgentSpec.diskLinks; [] when the agent is down. */
  diskLinks: DiskLink[];
  /** Section-level failures, display-ready ("Hardware agent is not running", "Memory query failed: …"). */
  errors: string[];
}

/** [NEW 1.1] `save_report` format (CONTRACT §2.12). */
export type ReportFormat = "txt" | "html";

// ───────────────────────────────────────────────────────────────────────────────
// Rust-gathered inventory (CONTRACT §2.1)
// ───────────────────────────────────────────────────────────────────────────────

export interface SystemInfo {
  hostname: string;
  cpuName: string;
  gpuNames: string[];
  motherboard: { manufacturer: string; product: string; version: string };
  bios: { vendor: string; version: string; releaseDate: string; mode: "UEFI" | "Legacy" | "Unknown" };
  os: {
    caption: string;
    version: string;
    build: string;
    displayVersion: string;
    architecture: string;
    installDate: string;
  };
  secureBoot: boolean | null;
  tpm: { present: boolean; version: string | null } | null;
  /** Deprecated for display: use bootTs. */
  uptimeSecs: number;
  /** [NEW] Unix ms of the last boot. */
  bootTs: number;
  isAdmin: boolean;
  ramTotalGb: number;
  lastDriverScan: string | null;
}

export type DriverCategory =
  | "Display"
  | "Chipset"
  | "Network"
  | "Audio"
  | "Storage"
  | "USB"
  | "Bluetooth"
  | "Firmware"
  | "Input"
  | "System"
  | "Other";

/** [BREAKING] "outdated" removed. v1.1 adds "vulnerable". */
export type DriverStatus = "ok" | "unsigned" | "problem";

export interface DriverInfo {
  deviceName: string;
  deviceClass: string;
  category: DriverCategory;
  provider: string;
  manufacturer: string;
  version: string;
  date: string;
  signed: boolean;
  signer: string;
  infName: string;
  deviceId: string;
  /** Neutral information only; never drives status or colour. */
  ageDays: number | null;
  /** [BREAKING] problem > unsigned > ok (CONTRACT §2.7). */
  status: DriverStatus;
  /** [NEW] Win32_PnPEntity.ConfigManagerErrorCode when ≠ 0, else null. */
  problemCode: number | null;
  /** [NEW] INF is not an oemNN.inf (ships with Windows). */
  isInbox: boolean;
}

export interface Volume {
  letter: string;
  label: string;
  fileSystem: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  driveType: "Fixed" | "Removable" | "Network" | "CD-ROM" | "Unknown";
  isSystem: boolean;
}

export interface PhysicalDisk {
  /** Windows disk number as a string ("0"). */
  deviceId: string;
  model: string;
  mediaType: "SSD" | "HDD" | "Unspecified";
  busType: string;
  sizeBytes: number;
  /** Windows' own opinion. Display-only; drive health comes from DiskTelemetry.health. */
  healthStatus: "Healthy" | "Warning" | "Unhealthy" | "Unknown";
  operationalStatus: string;
  serial: string;
  /** [NEW] Drive letters on this disk ("C:", "E:"), sorted, from MSFT_Partition. */
  volumes: string[];
  /** [NEW] True if %SystemDrive% is on this disk. */
  isSystemDisk: boolean;
}

// ───────────────────────────────────────────────────────────────────────────────
// Cache cleanup (MF-4, CONTRACT §3)
// ───────────────────────────────────────────────────────────────────────────────

/** [BREAKING] "standby" removed; "dumps" and "memory-dump" added. */
export type TrashCategoryId =
  | "temp"
  | "wu-cache"
  | "logs"
  | "dumps"
  | "memory-dump"
  | "shader"
  | "recycle"
  | "browser";

/** Categories run by F9 when confirmBeforePurge is false (and pre-selected otherwise). */
export const DEFAULT_ON_CATEGORIES: readonly TrashCategoryId[] = ["temp", "wu-cache", "logs"] as const;

export interface TrashCategory {
  id: TrashCategoryId;
  label: string;
  description: string;
  /** For unavailable categories: best-effort read-only estimate (0 if unreadable). */
  bytes: number;
  files: number;
  /** Default selection. Always false when available is false. */
  enabled: boolean;
  /** [CHANGED] True = never run by the F9 quick path (shader, recycle, browser, dumps, memory-dump). */
  optional: boolean;
  requiresAdmin: boolean;
  /** [NEW] False when the category cannot run in this session. */
  available: boolean;
  /** [NEW] */
  unavailableReason: "needsAdmin" | null;
  /** [NEW] Display-ready sentence about parts that will be skipped (apps open, update pending, …), or null. */
  note: string | null;
}

export interface TrashScan {
  categories: TrashCategory[];
  /** Sum of bytes of categories with available === true only. */
  totalBytes: number;
  durationMs: number;
  /** [NEW] Whether the Rust process that scans/deletes is elevated. */
  isAdmin: boolean;
}

export interface PurgeCategoryResult {
  id: TrashCategoryId;
  label: string;
  freedBytes: number;
  deleted: number;
  skipped: number;
  /** [NEW] Display-ready sentence about skipped parts ("Skipped: Chrome is open."), or null. */
  note: string | null;
}

export interface PurgeResult {
  freedBytes: number;
  filesDeleted: number;
  filesSkipped: number;
  durationMs: number;
  perCategory: PurgeCategoryResult[];
  /** [NEW] Absolute path of the JSONL audit log for this run. "View log" opens its folder. */
  logPath: string;
  // [BREAKING] standbyFlushed and standbyMessage removed.
}

export interface PurgeProgress {
  categoryId: TrashCategoryId;
  label: string;
  step: number;
  totalSteps: number;
  freedBytes: number;
}

export interface DriverBackupResult {
  path: string;
  success: boolean;
  output: string;
}

/** [NEW 1.1] One row of `scan_trash_details` (CONTRACT §3.3): exactly what a purge would delete now. */
export interface TrashDetailItem {
  /** Absolute path; for recycle rows the item's ORIGINAL path (from $I). */
  path: string;
  bytes: number;
  /** Last-write time (unix ms); recycle rows: deletion time; null for "group" rows. */
  modifiedTs: number | null;
  /** "group" = one summary row for content Nexum does not delete file by file (Delivery Optimization). */
  kind: "file" | "folder" | "group";
}

/** [NEW 1.1] Max and default `limit` of scan_trash_details. */
export const TRASH_DETAILS_LIMIT = 50;

/** [NEW 1.1] Allowed Settings.recycleMinAgeDays values; null = every item (v1.0 behaviour). */
export const RECYCLE_AGE_OPTIONS: readonly (number | null)[] = [null, 1, 14, 30, 60] as const;

// ───────────────────────────────────────────────────────────────────────────────
// Frame capture / Gaming (CONTRACT §1.6, §2.13) [NEW 1.1]
// ───────────────────────────────────────────────────────────────────────────────

export type FrameSessionState = "stopped" | "starting" | "running" | "error";

export type FrameSessionCode =
  | "notElevated"
  | "exeMissing"
  | "signatureInvalid"
  | "spawnFailed"
  | "unsupportedOutput"
  | "exited";

export interface FrameSignature {
  /** notChecked until the first trust check of this agent process. */
  status: "valid" | "invalid" | "untrusted" | "notChecked";
  /** Leaf signer subject CN, e.g. "Intel Corporation"; null when not checked/unreadable. */
  signer: string | null;
  /** SHA-256 equals the pinned PresentMon 2.6.0 hash; null when not checked. */
  sha256Match: boolean | null;
}

/** Sidecar `frameSession` line, forwarded verbatim as event `frame-session`. */
export interface FrameSession {
  type: "frameSession";
  state: FrameSessionState;
  /** Set only when state === "error". */
  code: FrameSessionCode | null;
  /** Exact display text (CONTRACT §1.6.6). */
  message: string;
  backend: "presentmon-console";
  backendVersion: string;
  sessionName: "NexumFrames";
  signature: FrameSignature;
  /** PresentMon child pid while starting/running. */
  childPid: number | null;
  /** Unix ms of entering this state. */
  sinceTs: number;
}

export type FrameTargetReason = "foreground" | "manual" | "none";

/** Sidecar `frameTarget` line (event `frame-target`); emitted when pid or reason changes. */
export interface FrameTarget {
  type: "frameTarget";
  pid: number | null;
  process: string | null;
  /** Top-level window title (≤ 120 chars) or null. */
  windowTitle: string | null;
  reason: FrameTargetReason;
  /** PresentMon PresentRuntime ("DXGI", "D3D9", "Other"). */
  runtime: string | null;
  /** PresentMon PresentMode verbatim, e.g. "Hardware: Independent Flip". */
  presentMode: string | null;
  /** presentMode starts with "Hardware: Legacy". */
  fullscreenExclusive: boolean | null;
}

/** [NEW 1.1] CONTRACT §1.6.5 boundBy rule. */
export type FrameBoundBy = "gpu" | "cpu" | "balanced" | "capped";

/** Sidecar `frameStats` line (event `frame-stats`), 1 Hz while a target exists. Definitions in CONTRACT §1.6.5. */
export interface FrameStats {
  type: "frameStats";
  /** Unix ms at emission. */
  ts: number;
  pid: number;
  process: string;
  windowSec: number;
  /** Valid frames in the window. */
  frames: number;
  /** 1000 × n / Σ frametime (time-weighted). null if n < 2. */
  fpsAvg: number | null;
  /** 1000 × displayed / Σ displayedTime. null if no display data or < 2 displayed. */
  fpsDisplayedAvg: number | null;
  /** "P1" = 1000 / P99 frametime. null if n < 100. */
  fpsLow1: number | null;
  /** "P0.1" = 1000 / P99.9 frametime. null if n < 1000. */
  fpsLow01: number | null;
  frametimeAvgMs: number | null;
  /** Nearest-rank percentile: sorted[ceil(q/100 × n) − 1]. */
  frametimeP99Ms: number | null;
  frametimeP999Ms: number | null;
  frametimeMaxMs: number | null;
  cpuBusyMs: number | null;
  gpuBusyMs: number | null;
  boundBy: FrameBoundBy | null;
  displayLatencyMs: number | null;
  droppedPct: number | null;
  presentMode: string | null;
  runtime: string | null;
  allowsTearing: boolean | null;
  syncInterval: number | null;
  /** Frametimes (ms, 2 decimals) received since the previous frameStats, oldest first, ≤ 1000. */
  frametimes: number[];
  /** Frames not included in `frametimes` because of the 1000 cap. */
  frametimesOmitted: number;
}

/** One row of `presentingList` / `list_presenting_processes`. */
export interface PresentingProcess {
  pid: number;
  process: string;
  windowTitle: string | null;
  /** Over the last 2 s, 1 decimal. */
  fps: number;
  runtime: string;
  presentMode: string;
  isForeground: boolean;
  isTarget: boolean;
}

/** Sidecar `presentingList` line (reply to {cmd:"presentingList"}; Rust returns `items`). */
export interface PresentingList {
  type: "presentingList";
  ts: number;
  items: PresentingProcess[];
}

/** `get_frame_state`: Rust's cached latest lines (stats returned with frametimes: []). */
export interface FrameState {
  session: FrameSession | null;
  target: FrameTarget | null;
  stats: FrameStats | null;
}

/** Frametime chart reference lines (ms → label), ROADMAP §6.3. */
export const FRAMETIME_BANDS_MS: readonly { ms: number; label: string }[] = [
  { ms: 16.7, label: "60 Hz" },
  { ms: 8.3, label: "120 Hz" },
  { ms: 6.9, label: "144 Hz" },
] as const;

/** Stats window bounds (s) and the Segmented options of the Gaming view. */
export const FPS_WINDOW_MIN_SEC = 5;
export const FPS_WINDOW_MAX_SEC = 120;
export const FPS_WINDOW_OPTIONS: readonly number[] = [10, 30, 60, 120] as const;

/** Always excluded by the agent's CLI arguments; never stored in Settings.fpsExcludes. */
export const FIXED_FRAME_EXCLUDES: readonly string[] = [
  "dwm.exe",
  "msedgewebview2.exe",
  "Nexum.exe",
  "nexum-agent.exe",
] as const;

/** User exclude entry rule (Rust and agent sanitize with the same pattern; max FPS_EXCLUDES_MAX entries). */
export const FPS_EXCLUDE_PATTERN = /^[A-Za-z0-9 _.()-]{1,60}\.exe$/i;
export const FPS_EXCLUDES_MAX = 50;

// ───────────────────────────────────────────────────────────────────────────────
// CSV sensor logging (CONTRACT §2.9) [NEW 1.1]
// ───────────────────────────────────────────────────────────────────────────────

export const SENSOR_LOG_INTERVALS_MS: readonly number[] = [1000, 2000, 5000, 10000] as const;

export interface SensorLogStatus {
  active: boolean;
  /** Current (or last) CSV file; null before the first log of this app session. */
  path: string | null;
  /** <Documents>\Nexum\Logs — for "Open folder". */
  folder: string;
  /** Rows in the current file (restarts at 0 after a 100 MiB rotation). */
  rows: number;
  totalRows: number;
  startedTs: number | null;
  intervalMs: number;
  sensorCount: number;
  /** Display-ready error that stopped the log, or null. */
  error: string | null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Rust alert engine (CONTRACT §2.10) [NEW 1.1]
// ───────────────────────────────────────────────────────────────────────────────

/** Sources of Rust-evaluated alerts. Frontend-owned conditions keep using HealthSource. */
export type HealthAlertSource = "cpu" | "gpu" | "drive" | "space";

export interface HealthAlert {
  /** "cpu-temp" | "gpu-temp:<i>" | "gpu-mem-temp:<i>" | "drive:<tele.id>" | "drive-temp:<tele.id>" | "space:<letter>". */
  id: string;
  severity: "warn" | "crit";
  source: HealthAlertSource;
  /** Display-ready texts (CONTRACT §2.10.3); temperatures already in Settings.tempUnit. */
  title: string;
  detail: string;
  short: string;
  group: string;
  rule: string;
  /** "<id>:<health.state>" for drive:*, else "<id>:<severity>". */
  dismissKey: string;
  /** Unix ms the alert entered its current severity. */
  sinceTs: number;
  /** Latest reading (°C, or free % for space). */
  value: number | null;
  /** Threshold of the current severity (°C, or %). */
  threshold: number | null;
  /** DiskTelemetry.id (drive, drive-temp), drive letter "C:" (space), GPU index as string (gpu), null (cpu). */
  subjectId: string | null;
  /** LHM sensor id when Rust can resolve it from the cached tree, else null. */
  sensorId: string | null;
}

export interface CpuLimitInfo {
  /** Model token matched from cpu.name ("5700X3D"), null when none matched. */
  model: string | null;
  /** Crit threshold °C. */
  limitC: number;
  /** limitC − 5. */
  warnC: number;
  source: "table" | "user" | "default";
}

export interface HealthAlertsSnapshot {
  /** False until Rust evaluated one telemetry packet and one volume scan; false while the agent is down. */
  ready: boolean;
  evaluatedTs: number | null;
  /** Sorted crit first, then rule order, then subjectId. */
  alerts: HealthAlert[];
  /** Seven Rust rule texts (drive crit, drive warn, cpu, gpu, gpu-mem, drive-temp, space). */
  rules: string[];
  cpuLimit: CpuLimitInfo;
}

export const EMPTY_ALERTS_SNAPSHOT: HealthAlertsSnapshot = {
  ready: false,
  evaluatedTs: null,
  alerts: [],
  rules: [],
  cpuLimit: { model: null, limitC: 90, warnC: 85, source: "default" },
};

export interface AlertSettings {
  /** Opt-in Windows notifications. */
  desktopNotifications: boolean;
  /** CPU limit override °C (60..105); null = per-model table, else 90. */
  cpuTempC: number | null;
  /** GPU hot-spot crit override °C (70..115); null = 110. Warn = crit − 10. */
  gpuHotspotC: number | null;
  /** GPU memory-junction crit override °C (70..115); null = 105. Warn = crit − 10. */
  gpuMemJunctionC: number | null;
  /** Low-space warn threshold % (1..50); crit = max(1, floor(freeSpacePct / 2)). */
  freeSpacePct: number;
  /** Sustained window, seconds (10..600). */
  sustainSec: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  desktopNotifications: false,
  cpuTempC: null,
  gpuHotspotC: null,
  gpuMemJunctionC: null,
  freeSpacePct: 10,
  sustainSec: 60,
};

/**
 * Per-model CPU limits (AMD "Max. Operating Temperature (Tjmax)", CONTRACT §2.10.2). Mirror of the
 * Rust table for the mock and the Settings UI; Rust is authoritative. Re-check on amd.com before release.
 */
export const CPU_TJMAX_TABLE: Readonly<Record<string, number>> = {
  "5600X": 95,
  "5800X": 90,
  "5900X": 90,
  "5950X": 90,
  "5800X3D": 90,
  "5700X3D": 90,
  "7800X3D": 89,
  "7950X": 95,
  "9800X3D": 95,
};
export const CPU_DEFAULT_LIMIT_C = 90;
export const GPU_HOTSPOT_CRIT_DEFAULT_C = 110;
export const GPU_EDGE_WARN_C = 85;
export const GPU_EDGE_CRIT_C = 95;
export const GPU_MEM_JUNCTION_CRIT_DEFAULT_C = 105;

// ───────────────────────────────────────────────────────────────────────────────
// Drive wear ledger (CONTRACT §2.11) [NEW 1.1]
// ───────────────────────────────────────────────────────────────────────────────

export interface DriveHistoryPoint {
  /** Local date "YYYY-MM-DD" (one point per day). */
  date: string;
  healthPct: number | null;
  /** = DiskTelemetry.tbw on that day. */
  dataWrittenTb: number | null;
  powerOnHours: number | null;
}

export type DriveForecastStatus = "ok" | "notEnoughData" | "noWear" | "noLifeData" | "beyondHorizon";

export interface DriveForecast {
  /** OLS slope of dataWrittenTb × 30.4375, 2 decimals, ≥ 0. */
  tbPerMonth: number | null;
  /** Months until healthPct reaches 10 (OLS), 1 decimal; 0 when already ≤ 10. */
  monthsTo10Pct: number | null;
  /** Span of the basis points (last 365 days), days. */
  basisDays: number;
  /** Number of basis points. Forecast needs ≥ 7 points and ≥ 14 days. */
  points: number;
  status: DriveForecastStatus;
}

export interface DriveHistory {
  serial: string;
  points: DriveHistoryPoint[];
  forecast: DriveForecast;
}

// ───────────────────────────────────────────────────────────────────────────────
// GPU tuning, read-only (CONTRACT §1.7, §2.14) [NEW 1.1]
// ───────────────────────────────────────────────────────────────────────────────

export type TuningUnsupportedReason = "notElevated" | "noAmdGpu" | "adlMissing" | "odUnsupported" | "adlError";

export interface TuningRange {
  min: number;
  max: number;
  step: number;
  default: number | null;
}

export interface FanCurvePoint {
  tempC: number;
  pct: number;
}

export interface TuningCaps {
  powerLimit: boolean;
  autoUndervolt: boolean;
  fanCurve: boolean;
  zeroRpm: boolean;
  voltageOffset: boolean;
  gfxClockMax: boolean;
  memClockMax: boolean;
}

export interface TuningRanges {
  powerPct: TuningRange | null;
  voltageOffsetMv: TuningRange | null;
  gfxClockMaxMhz: TuningRange | null;
  memClockMaxMhz: TuningRange | null;
  fanCurveTempC: TuningRange | null;
  fanCurvePct: TuningRange | null;
}

export interface TuningCurrent {
  powerPct: number | null;
  autoUndervolt: boolean | null;
  zeroRpm: boolean | null;
  voltageOffsetMv: number | null;
  gfxClockMaxMhz: number | null;
  memClockMaxMhz: number | null;
  /** Five OD8 points in order, or null. */
  fanCurve: FanCurvePoint[] | null;
}

/** Sidecar `tuningState` line (event `tuning-state`, `get_tuning_state`). Read-only data. */
export interface TuningState {
  type: "tuningState";
  ts: number;
  gpuIndex: number;
  adapterName: string | null;
  backend: "adl-od8";
  supported: boolean;
  reason: TuningUnsupportedReason | null;
  /** Exact display text (CONTRACT §1.7.3). */
  message: string;
  odVersion: number | null;
  caps: TuningCaps;
  ranges: TuningRanges;
  current: TuningCurrent;
  /** Every capped current value equals its default; null when unsupported. */
  isFactory: boolean | null;
  mode: "factory" | "custom" | "autoUndervolt" | "unknown";
  /** Raw OD8 optimized-power-mode value (undocumented), or null. */
  powerMode: string | null;
  vpuRecoveryCount: number | null;
}

/** `run_tuning_probe` result. v1.1 never sends write:true (Rust rejects it). */
export interface TuningProbeSummary {
  ranTs: number;
  write: false;
  ok: boolean;
  message: string;
  /** %LOCALAPPDATA%\Nexum\tuning-probe-<ts>.json, or null when nothing was written. */
  path: string | null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Fan fail-safe (MF-13, CONTRACT §2.4) and self-usage (CONTRACT §2.5)
// ───────────────────────────────────────────────────────────────────────────────

export type FanFailsafeKind = "interrupted" | "agentLost" | "previousBoot";

export interface FanFailsafeState {
  /** True → show the banner. */
  active: boolean;
  kind: FanFailsafeKind | null;
  /** "crit" (vermilion, octagon) for interrupted/agentLost, "warn" (amber) for previousBoot, null when inactive. */
  severity: "crit" | "warn" | null;
  /** True when a running agent confirms every controllable header is held at 100%. */
  fansAt100: boolean;
  /** Exact banner text (CONTRACT §2.4). Empty when inactive. */
  message: string;
  sinceTs: number | null;
  /** Only previousBoot can be dismissed. */
  dismissible: boolean;
}

export interface SelfUsage {
  ts: number;
  /** % of total machine CPU capacity (all logical processors = 100%), 1 decimal. */
  cpuPct: number;
  /** Sum of working sets, MB (integer). */
  workingSetMb: number;
  /** Nexum.exe + its sensor service process + WebView2 descendants. */
  processCount: number;
}

// ───────────────────────────────────────────────────────────────────────────────
// Settings (CONTRACT §2.2)
// ───────────────────────────────────────────────────────────────────────────────

export interface SensorLabelMeta {
  /** SensorMeta.name at the time the label was set. */
  defaultName: string;
  /** HardwareNode.name at the time the label was set. */
  hardwareName: string;
}

export type SensorDriverChoice = "undecided" | "pawnio" | "none";

/**
 * [NEW 1.2] Update-check consent (CONTRACT §2.15.3).
 * "ask"    → not answered yet: the first-run question is shown once; NO network request is made.
 * "auto"   → Nexum checks at most once every 24 h and shows a quiet toolbar indicator. It never downloads
 *            or installs on its own.
 * "manual" → Nexum checks only when the user presses "Check now".
 */
export type UpdateCheckMode = "ask" | "auto" | "manual";

/** [NEW 1.2] Release channel (CONTRACT §2.15.2). */
export type UpdateChannel = "stable" | "preview";
/** [NEW 1.2] "default" = the channel this build was made for (UpdateState.buildChannel). */
export type UpdateChannelSetting = "default" | UpdateChannel;

export interface Settings {
  launchOnStartup: boolean;
  minimizeToTray: boolean;
  pollIntervalMs: number;
  includeBrowserCaches: boolean;
  confirmBeforePurge: boolean;
  // [BREAKING] flushStandbyOnPurge removed.
  tempUnit: "C" | "F";
  startMinimized: boolean;
  /** [NEW] User labels keyed by LHM sensor id (fan ids are sensor ids). Max 64 chars each. */
  sensorLabels: Record<string, string>;
  /** [NEW] Re-match data for each labelled id. */
  sensorLabelMeta: Record<string, SensorLabelMeta>;
  /** [NEW] Sensor ids hidden in the Sensors view. */
  hiddenSensors: string[];
  /** [NEW] Pinned sensor ids, max 12. null = use the default-pin rule (CONTRACT §4.5). */
  pinnedSensors: string[] | null;
  /** [NEW] */
  hideUnusedSensors: boolean;
  /** [NEW] Dismissed banner keys ("<conditionId>:<state>"), max 200. Never hides the pill or alerts card. */
  dismissedAlerts: string[];
  /** [NEW] First-run PawnIO consent result (MF-3). */
  sensorDriverChoice: SensorDriverChoice;
  /** [NEW 1.1] Opt-in frame capture (CONTRACT §1.6). Change through set_frame_capture. */
  fpsCaptureEnabled: boolean;
  /** [NEW 1.1] Stats window, integer seconds 5..120. Change through set_frame_window. */
  fpsWindowSec: number;
  /** [NEW 1.1] User excludes ("obs64.exe"), FPS_EXCLUDE_PATTERN, max 50. Change through set_frame_excludes. */
  fpsExcludes: string[];
  /** [NEW 1.1] One of SENSOR_LOG_INTERVALS_MS. */
  sensorLogIntervalMs: number;
  /** [NEW 1.1] Alert thresholds and notification opt-in (CONTRACT §2.2, §2.10). */
  alerts: AlertSettings;
  /** [NEW 1.1] Recycle Bin age filter: one of RECYCLE_AGE_OPTIONS (null = every item). */
  recycleMinAgeDays: number | null;
  /** [NEW 1.2] Update-check consent. Default "ask". Unknown value → "ask". */
  updateCheck: UpdateCheckMode;
  /**
   * [NEW 1.2] Unix ms of the last update check that got an answer from GitHub (update or no update);
   * null = never. Written by Rust only: save_settings keeps the stored value and ignores this member.
   */
  lastUpdateCheckTs: number | null;
  /** [NEW 1.2] Channel choice. Default "default". Unknown value → "default". */
  updateChannel: UpdateChannelSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  launchOnStartup: false,
  minimizeToTray: true,
  pollIntervalMs: 1000,
  includeBrowserCaches: false,
  confirmBeforePurge: true,
  tempUnit: "C",
  startMinimized: false,
  sensorLabels: {},
  sensorLabelMeta: {},
  hiddenSensors: [],
  pinnedSensors: null,
  hideUnusedSensors: true,
  dismissedAlerts: [],
  sensorDriverChoice: "undecided",
  fpsCaptureEnabled: false,
  fpsWindowSec: 30,
  fpsExcludes: [],
  sensorLogIntervalMs: 1000,
  alerts: DEFAULT_ALERT_SETTINGS,
  recycleMinAgeDays: 30,
  updateCheck: "ask",
  lastUpdateCheckTs: null,
  updateChannel: "default",
};

// ───────────────────────────────────────────────────────────────────────────────
// In-app updates [NEW 1.2] (CONTRACT §2.15). The frontend never talks to the network: Rust owns the
// check, the download, the signature check and the install. These shapes mirror the Rust structs.
// ───────────────────────────────────────────────────────────────────────────────

/**
 * idle        → nothing to do: never checked, or the last check found no newer version
 * checking    → asking GitHub
 * available   → a newer version exists (latestVersion, notes, publishedAt are set); nothing downloaded
 * downloading → the user clicked Install; `progress` is set when the size is known
 * ready       → downloaded and the signature is verified; the installer is about to start
 * installing  → the installer was started; Nexum exits within a few seconds
 * error       → `error` and `errorCode` are set; latestVersion stays set if an update had been found
 * disabled    → this build does not update from inside the app (no channel compiled in: forks, dev builds)
 */
export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error" | "disabled";

/** Stable error ids; the display text is UpdateState.error (= UPDATE_ERROR_TEXT[errorCode]). */
export type UpdateErrorCode =
  | "offline"
  | "notPublished"
  | "badManifest"
  | "notNewer"
  | "badSignature"
  | "blocked"
  | "write"
  | "launch"
  | "busy"
  | "unknown";

export interface UpdateState {
  state: UpdateStatus;
  /** Version of the running app, SemVer without a leading "v" (e.g. "1.2.0", "1.2.0-preview.2"). */
  currentVersion: string;
  /** Version on offer; null unless a newer version was found. Always strictly greater than currentVersion. */
  latestVersion: string | null;
  /** Release notes as plain text (max 4000 chars, shown as text, never as HTML); null if none. */
  notes: string | null;
  /** ISO 8601 UTC publication time of the version on offer; null if unknown. */
  publishedAt: string | null;
  /** Download progress 0..100 (integer) while downloading and the size is known; else null. */
  progress: number | null;
  /** Bytes received so far while downloading; else null. */
  downloadedBytes: number | null;
  /** Download size if GitHub reported it; else null. */
  totalBytes: number | null;
  /** Plain-language error (one of UPDATE_ERROR_TEXT), set only in state "error". */
  error: string | null;
  errorCode: UpdateErrorCode | null;
  /** Channel in effect (the setting, or the build channel for "default"); null when disabled. */
  channel: UpdateChannel | null;
  /** Channel compiled into this build; null = this build never updates from inside the app. */
  buildChannel: UpdateChannel | null;
  /** = Settings.lastUpdateCheckTs. */
  lastCheckTs: number | null;
}

/** State before Rust answers get_update_state (also the mock's default). */
export const INITIAL_UPDATE_STATE: UpdateState = {
  state: "idle",
  currentVersion: "",
  latestVersion: null,
  notes: null,
  publishedAt: null,
  progress: null,
  downloadedBytes: null,
  totalBytes: null,
  error: null,
  errorCode: null,
  channel: null,
  buildChannel: null,
  lastCheckTs: null,
};

/** The only hosts and paths the updater may contact (CONTRACT §2.15.2). Documentation + mock; Rust owns the real constants. */
export const UPDATE_REPO_URL = "https://github.com/captainRapipo/nexum";
/** Opened in the browser by "Open the releases page" (api.openExternal): not a request made by Nexum. */
export const UPDATE_RELEASES_URL = "https://github.com/captainRapipo/nexum/releases";
/** Fixed-URL manifests: assets of the permanent release tagged "updates". */
export const UPDATE_MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: "https://github.com/captainRapipo/nexum/releases/download/updates/stable.json",
  preview: "https://github.com/captainRapipo/nexum/releases/download/updates/preview.json",
};
/** Every download URL in a manifest must start with this. */
export const UPDATE_DOWNLOAD_PREFIX = "https://github.com/captainRapipo/nexum/releases/download/";
/** "auto" checks at most once per this period, counted from Settings.lastUpdateCheckTs. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** First automatic check this long after start; then the due rule is re-evaluated every hour. */
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000;
/** Release notes are cut to this many characters (then "…"). */
export const UPDATE_NOTES_MAX_CHARS = 4000;

/** Exact error texts (CONTRACT §2.15.6). Rust sends the same strings in UpdateState.error. */
export const UPDATE_ERROR_TEXT: Record<UpdateErrorCode, string> = {
  offline: "Could not reach GitHub. Check your internet connection and try again.",
  notPublished: "No update information has been published for this version line yet.",
  badManifest: "The update information from GitHub could not be read.",
  notNewer: "The version on offer is not newer than this one, so nothing was installed.",
  badSignature: "The download did not pass Nexum's signature check, so it was not installed.",
  blocked: "Windows security blocked the installer. Nothing was changed.",
  write: "The update could not be saved in Nexum's folder. Nothing was changed.",
  launch: "The installer could not be started. Nothing was changed.",
  busy: "An update is already in progress.",
  unknown: "The update could not be completed. Nothing was changed.",
};

/** Exact UI texts of the update flow (CONTRACT §2.15.7). `{v}` = latestVersion, `{c}` = currentVersion. */
export const UPDATE_TEXT = {
  /** First-run question (shown once while Settings.updateCheck === "ask"). */
  askTitle: "Check for updates automatically?",
  askBody:
    "Nexum can ask GitHub once a day whether a newer version exists. That check, and the download when you choose to install, are the only times Nexum goes online. It sends no information about you or this PC, and nothing is installed until you click Install.",
  askNote: "You can change this any time in Settings, under Updates.",
  askYes: "Check automatically",
  askNo: "Not now",
  /** Toolbar indicator (state available / downloading / ready / installing). */
  indicator: "Update available",
  indicatorTitle: "Nexum {v} is available",
  /** Update dialog. */
  dialogTitle: "Nexum {v} is available",
  dialogCurrent: "You have Nexum {c}.",
  dialogClose: "Nexum closes while the update installs. If it does not open again by itself, start it from the Start menu.",
  dialogPreview: "This is a preview version. It is not code-signed yet, so Windows may warn about it or block it.",
  dialogVerified: "Nexum checks the download against its signing key before anything runs.",
  install: "Install update",
  later: "Later",
  downloading: "Downloading…",
  ready: "Download verified. Starting the installer…",
  installing: "Installing. Nexum will close now.",
  retry: "Try again",
  close: "Close",
  openReleases: "Open the releases page",
  /** Settings section "Updates". */
  sectionTitle: "Updates",
  modeLabel: "Check for updates",
  modeAuto: "Automatically, once a day",
  modeManual: "Only when I ask",
  previewToggle: "Get preview versions",
  previewToggleNote: "Preview versions arrive earlier and are not code-signed yet. Windows may warn about them or block them.",
  checkNow: "Check now",
  viewUpdate: "View update",
  statusNever: "Not checked yet.",
  statusChecking: "Checking…",
  statusUpToDate: "Nexum is up to date.",
  statusAvailable: "Nexum {v} is available.",
  lastChecked: "Last checked {when}.",
  sourceNote: "Updates come from Nexum's GitHub releases page and are verified with Nexum's signing key before they run.",
  disabled: "This build does not update from inside the app. New versions are on the releases page.",
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// Health derivation (MF-6, CONTRACT §5). [CHANGED 1.1] Conditions drive:*, cpu-temp, gpu-temp:*,
// gpu-mem-temp:*, drive-temp:*, space:* come from Rust (HealthAlert → alertToCondition, §5.0);
// fan-failsafe, agent-offline, fan-override, limited-mode, drive-unknown:* stay frontend-derived.
// [CHANGED 1.2] "agent-offline" (id kept, internal) exists only while AgentStatus.phase === "failed";
// its texts are SENSORS_DOWN_*; while the service is starting or restarting the level is "checking".
// ───────────────────────────────────────────────────────────────────────────────

export type HealthSeverity = "crit" | "warn" | "info";
export type HealthSource = "drive" | "cpu" | "gpu" | "agent" | "space" | "fan";

/** A condition's button: either in-app navigation or one of the fixed commands. */
export type HealthAction =
  | { label: string; nav: NavRequest }
  /** [CHANGED 1.2] "retrySensors" added: api.restartAgent() (label SENSORS_RETRY_LABEL). */
  | { label: string; command: "restartAsAdmin" | "getPawnIo" | "retrySensors" };

export interface HealthCondition {
  /** Stable id, e.g. "drive:/nvme/0", "cpu-temp", "gpu-temp:0", "space:C:", "fan-failsafe". */
  id: string;
  severity: HealthSeverity;
  source: HealthSource;
  /** Summary group key; conditions with the same group merge in the pill text. */
  group: string;
  /** Pill fragment for this group with count n=1 (e.g. "1 drive worn"); see CONTRACT §5.3. */
  short: string;
  title: string;
  detail: string;
  /** Rule text that produced this condition (shown on hover). */
  rule: string;
  /** Key used for banner dismissal: "<id>:<state>". */
  dismissKey: string;
  action: HealthAction | null;
}

/**
 * [BREAKING 1.1] "checking" added. [CHANGED 1.2] It now also covers the sensor service starting or
 * restarting (no data yet, not failed). Pill tone "checking" (StatusPillTone): neutral, dashed ring.
 */
export type SystemHealthLevel = "optimal" | "attention" | "critical" | "partial" | "checking";

export interface SystemHealth {
  level: SystemHealthLevel;
  /** "Optimal" | "Attention" | "Critical" | "Partial sensors" | "Checking". */
  label: string;
  /** Text after the label, e.g. "1 drive worn"; null for optimal/partial without detail. */
  summary: string | null;
  /** Sorted: crit, warn, info; then by rule order (CONTRACT §5.2). */
  conditions: HealthCondition[];
  /** All rule texts, for the pill hover and the empty Health alerts card. */
  rules: string[];
}

/**
 * v1.0 fixed thresholds (°C / %). [CHANGED 1.1] Temperature and space conditions are evaluated in Rust
 * (per-model CPU limits, Settings.alerts, sustainSec); the cpu/gpu/drive/space members below are no
 * longer used for conditions — free-space colours use spaceThresholds(settings) (lib/status.ts).
 * staleMinMs still defines "offline" for the frontend rules.
 */
export const HEALTH_THRESHOLDS = {
  cpuWarnC: 90,
  cpuCritC: 95,
  gpuHotspotWarnC: 100,
  gpuHotspotCritC: 110,
  gpuEdgeWarnC: 85,
  gpuEdgeCritC: 95,
  driveWarnFallbackC: 70,
  driveCritFallbackC: 80,
  freeSpaceWarnPct: 10,
  freeSpaceCritPct: 5,
  /** Sustained window: a temperature condition is active when the MIN of samples in the window ≥ threshold. */
  sustainWindowMs: 10_000,
  sustainMinSamples: 3,
  /** Sensor data counts as stale when no packet arrived for max(staleMinMs, 3 × pollIntervalMs). */
  staleMinMs: 5_000,
} as const;
