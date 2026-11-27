// Authoritative frontend mirror of CONTRACT.md. Do not rename fields.

export type ViewId = "dashboard" | "drivers" | "storage" | "fans" | "cleaner";
export type FanPreset = "auto" | "silent" | "balanced" | "turbo" | "custom";
export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";

export interface CpuTelemetry {
  name: string;
  loadTotal: number;
  loadPerCore: number[];
  clockMhz: number | null;
  maxClockMhz: number | null;
  packageTempC: number | null;
  voltage: number | null;
  powerW: number | null;
  cores: number;
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
  id: string;
  name: string;
  hardware: string;
  rpm: number;
  controllable: boolean;
  controlPct: number | null;
}

export interface DiskTelemetry {
  id: string;
  name: string;
  tempC: number | null;
  readMBps: number | null;
  writeMBps: number | null;
  healthPct: number | null;
  tbw: number | null;
  powerOnHours: number | null;
  usedPct: number | null;
}

export interface NetworkTelemetry {
  downMBps: number;
  upMBps: number;
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
  fanPreset: FanPreset;
}

export interface AgentAck {
  cmd: string;
  ok: boolean;
  message: string;
}

export interface AgentStatus {
  running: boolean;
  isAdmin: boolean;
  message: string;
  lastPacketTs: number | null;
}

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
  uptimeSecs: number;
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
  ageDays: number | null;
  status: "ok" | "outdated" | "unsigned";
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
  deviceId: string;
  model: string;
  mediaType: "SSD" | "HDD" | "Unspecified";
  busType: string;
  sizeBytes: number;
  healthStatus: "Healthy" | "Warning" | "Unhealthy" | "Unknown";
  operationalStatus: string;
  serial: string;
}

export type TrashCategoryId = "temp" | "recycle" | "wu-cache" | "shader" | "browser" | "logs" | "standby";

export interface TrashCategory {
  id: TrashCategoryId;
  label: string;
  description: string;
  bytes: number;
  files: number;
  enabled: boolean;
  optional: boolean;
  requiresAdmin: boolean;
}

export interface TrashScan {
  categories: TrashCategory[];
  totalBytes: number;
  durationMs: number;
}

export interface PurgeCategoryResult {
  id: TrashCategoryId;
  label: string;
  freedBytes: number;
  deleted: number;
  skipped: number;
}

export interface PurgeResult {
  freedBytes: number;
  filesDeleted: number;
  filesSkipped: number;
  durationMs: number;
  perCategory: PurgeCategoryResult[];
  standbyFlushed: boolean | null;
  standbyMessage: string | null;
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

export interface Settings {
  launchOnStartup: boolean;
  minimizeToTray: boolean;
  pollIntervalMs: number;
  includeBrowserCaches: boolean;
  confirmBeforePurge: boolean;
  flushStandbyOnPurge: boolean;
  tempUnit: "C" | "F";
  startMinimized: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  launchOnStartup: false,
  minimizeToTray: true,
  pollIntervalMs: 1000,
  includeBrowserCaches: false,
  confirmBeforePurge: true,
  flushStandbyOnPurge: false,
  tempUnit: "C",
  startMinimized: false,
};
