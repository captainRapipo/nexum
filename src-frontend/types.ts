// Authoritative frontend mirror of CONTRACT.md — contract version 1.0.0-gate.
// Field names, unions and defaults here are binding for all three layers (C# sidecar,
// Rust core, React frontend). Do not rename fields. Change this file only together with
// CONTRACT.md. Owner: implementer C (frontend core).
//
// Legend used in comments:  [NEW] added in 1.0.0-gate · [BREAKING] removed/renamed/re-typed
// in 1.0.0-gate · [CHANGED] same type, new semantics.

export const CONTRACT_VERSION = "1.0.0-gate";
/** [NEW] Value of `hello.protocol` sent by a sidecar that implements this contract. */
export const AGENT_PROTOCOL = 2;

// ───────────────────────────────────────────────────────────────────────────────
// Navigation & keymap (CONTRACT §4.6)
// ───────────────────────────────────────────────────────────────────────────────

/** [BREAKING] "fans" → "cooling"; "sensors" and "system" added. "gaming" arrives in v1.1. */
export type ViewId = "dashboard" | "sensors" | "system" | "storage" | "cooling" | "drivers" | "cleaner";

/** Order of the top-bar tabs and of the Ctrl+1..7 aliases (index + 1). */
export const VIEW_ORDER: readonly ViewId[] = [
  "dashboard",
  "sensors",
  "system",
  "storage",
  "cooling",
  "drivers",
  "cleaner",
] as const;

export const VIEW_LABELS: Record<ViewId, string> = {
  dashboard: "Dashboard",
  sensors: "Sensors",
  system: "System",
  storage: "Storage",
  cooling: "Cooling",
  drivers: "Drivers",
  cleaner: "Cleaner",
};

export type KeyAction =
  | { type: "view"; view: ViewId }
  | { type: "rescan" }
  | { type: "cleanCaches" };

/** Function-key map. F8 is reserved for "gaming" (v1.1) and must stay unbound; F10 is never bound. */
export const FKEY_MAP: Readonly<Record<string, KeyAction>> = {
  F1: { type: "view", view: "dashboard" },
  F2: { type: "view", view: "sensors" },
  F3: { type: "view", view: "system" },
  F4: { type: "view", view: "storage" },
  F5: { type: "rescan" },
  F6: { type: "view", view: "cooling" },
  F7: { type: "view", view: "drivers" },
  F9: { type: "cleanCaches" },
};

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

/** Reasons accepted by the <Unavailable> primitive. */
export type UnavailableReason = LimitedReason | "unsupported" | "agentOffline";

/** What a value needs in order to be readable (CONTRACT §4.5 resolveUnavailable). */
export type FeatureNeed = "admin" | "pawnio" | "none";

/** Same-boot write-ahead flag found by the agent at startup (CONTRACT §1.5). */
export type FanFlagState = "none" | "interrupted" | "previousBoot";

/** Shape of the sidecar `hello` line (consumed by Rust only; mirrored for documentation/tests). */
export interface AgentHello {
  type: "hello";
  version: string;
  /** [NEW] Always AGENT_PROTOCOL (2). */
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
  message: string;
  lastPacketTs: number | null;
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
  /** v1.0: always null (live timings arrive in v1.1). */
  timings: null;
  /** v1.0: always "unavailable". */
  timingsSource: "unavailable";
  /** v1.0: always null (XMP parsing is v1.3+). */
  xmp: null;
}

export interface GpuSpec {
  name: string;
  vendor: GpuVendor;
  vramGb: number | null;
  driverVersion: string | null;
  /** "YYYY-MM-DD" or null. */
  driverDate: string | null;
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
  errors: string[];
}

/** Returned by `get_system_spec`. cpu/board/memory/gpus come from the sidecar; os/security from Rust. */
export interface SystemSpec {
  capturedTs: number;
  cpu: CpuSpec | null;
  board: BoardSpec | null;
  memory: MemorySpec | null;
  gpus: GpuSpec[];
  os: OsSpec;
  security: SecuritySpec;
  /** Section-level failures, display-ready ("Hardware agent is not running", "Memory query failed: …"). */
  errors: string[];
}

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

// ───────────────────────────────────────────────────────────────────────────────
// Fan fail-safe (MF-13, CONTRACT §2.4) and self-usage (CONTRACT §2.5)
// ───────────────────────────────────────────────────────────────────────────────

export type FanFailsafeKind = "interrupted" | "agentLost" | "previousBoot";

export interface FanFailsafeState {
  /** True → show the banner. */
  active: boolean;
  kind: FanFailsafeKind | null;
  /** "crit" (rose) for interrupted/agentLost, "warn" (amber) for previousBoot, null when inactive. */
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
  /** Nexum.exe + nexum-agent + WebView2 descendants. */
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
};

// ───────────────────────────────────────────────────────────────────────────────
// Frontend-derived health (MF-6, CONTRACT §5). Not on the wire in v1.0.
// ───────────────────────────────────────────────────────────────────────────────

export type HealthSeverity = "crit" | "warn" | "info";
export type HealthSource = "drive" | "cpu" | "gpu" | "agent" | "space" | "fan";

/** A condition's button: either in-app navigation or one of the fixed commands. */
export type HealthAction =
  | { label: string; nav: NavRequest }
  | { label: string; command: "restartAsAdmin" | "getPawnIo" };

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

export type SystemHealthLevel = "optimal" | "attention" | "critical" | "partial";

export interface SystemHealth {
  level: SystemHealthLevel;
  /** "Optimal" | "Attention" | "Critical" | "Partial sensors". */
  label: string;
  /** Text after the label, e.g. "1 drive worn"; null for optimal/partial without detail. */
  summary: string | null;
  /** Sorted: crit, warn, info; then by rule order (CONTRACT §5.2). */
  conditions: HealthCondition[];
  /** All rule texts, for the pill hover and the empty Health alerts card. */
  rules: string[];
}

/** v1.0 fixed thresholds (°C / %). v1.1 moves evaluation to Rust with per-model CPU limits. */
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
  /** Agent is considered offline when no packet for max(staleMinMs, 3 × pollIntervalMs). */
  staleMinMs: 5_000,
} as const;
