# Nexum — Internal Integration Contract

Single source of truth for how the three layers talk. All builders MUST follow it exactly.
Frontend TypeScript mirror lives in `src-frontend/types.ts` (authoritative for field names).

## 0. Layout

```
nexum-monitor/
├── package.json, vite.config.ts, tsconfig*.json, index.html (Vite root = src-frontend/)
├── src-frontend/            React 18 + TS + Tailwind v4 (@tailwindcss/vite) + echarts
├── src-tauri/               Tauri v2 Rust core (crate name `nexum`, productName `Nexum`)
└── nexum-agent/             C# .NET 8 sidecar (NexumAgent.csproj, LibreHardwareMonitorLib)
```

Versions: tauri 2.x, tauri-build 2.x, tauri-plugin-shell 2.x, @tauri-apps/api ^2, @tauri-apps/cli ^2,
react ^18.3, vite ^6, typescript ^5.6, tailwindcss ^4 + @tailwindcss/vite ^4, echarts ^5.5, lucide-react.
Identifier: `net.nexum.monitor`. Window: 1600x960, min 1280x800, decorations true, title "Nexum".
Frontend dist: `../dist` (relative to src-tauri). Dev URL: `http://localhost:1420`.

## 1. Sidecar (nexum-agent) ⇄ Rust — NDJSON over stdio

The sidecar writes ONE JSON object per line to **stdout** (UTF-8, no BOM, camelCase, `\n` terminated,
flush after every line). Never write anything else to stdout (logs → stderr). It reads ONE JSON
command per line from **stdin**.

### 1.1 Outgoing messages (sidecar → Rust)

```jsonc
{ "type": "hello", "version": "1.0.0", "isAdmin": true, "pid": 1234 }
{ "type": "telemetry", ...TelemetryPacket }            // every intervalMs (default 1000)
{ "type": "ack", "cmd": "fanPreset", "ok": true, "message": "Applied Balanced to 4 fans" }
{ "type": "error", "message": "..." }                 // non-fatal
```

TelemetryPacket (all temps °C, clocks MHz, sizes GB unless suffixed, null when sensor unavailable):

```jsonc
{
  "type": "telemetry",
  "ts": 1732700000000,                       // unix ms
  "cpu": {
    "name": "AMD Ryzen 9 7950X", "loadTotal": 12.5, "loadPerCore": [10.1, ...],
    "clockMhz": 4500.0, "maxClockMhz": 5700.0, "packageTempC": 52.0, "voltage": 1.2,
    "powerW": 65.0, "cores": 16, "threads": 32
  },
  "gpu": GpuTelemetry | null,                // primary = first discrete (nvidia/amd) else first
  "gpus": [ GpuTelemetry, ... ],
  "ram": { "usedGb": 14.2, "availableGb": 17.8, "totalGb": 32.0, "loadPct": 44.4,
           "speedMts": 6000, "formFactor": "DIMM", "slotsUsed": 2, "slotsTotal": 4 },
  "fans": [ { "id": "/lpc/nct6798d/0/fan/0", "name": "CPU Fan", "hardware": "Nuvoton NCT6798D",
              "rpm": 1150.0, "controllable": true, "controlPct": 45.0 } ],
  "disks": [ { "id": "/nvme/0", "name": "Samsung SSD 990 PRO 2TB", "tempC": 41.0,
               "readMBps": 0.4, "writeMBps": 1.2, "healthPct": 99.0, "tbw": 12.3,
               "powerOnHours": 2210, "usedPct": 61.0 } ],
  "network": { "downMBps": 0.12, "upMBps": 0.03 } | null,
  "fanPreset": "balanced"                     // "auto" | "silent" | "balanced" | "turbo" | "custom"
}
GpuTelemetry = { "name": "NVIDIA GeForce RTX 4080", "vendor": "nvidia"|"amd"|"intel"|"unknown",
  "load": 3.0, "vramUsedGb": 1.4, "vramTotalGb": 16.0, "coreClockMhz": 210.0, "memClockMhz": 405.0,
  "tempC": 38.0, "hotspotTempC": 45.0, "powerW": 18.0, "fanRpm": 0.0, "fanPct": 0.0 }
```

### 1.2 Incoming commands (Rust → sidecar stdin)

```jsonc
{ "cmd": "interval", "ms": 1000 }                     // clamp 250..10000
{ "cmd": "fanPreset", "preset": "silent"|"balanced"|"turbo"|"auto" }   // auto = release to BIOS
{ "cmd": "fanSet", "id": "/lpc/.../control/0", "pct": 55 }            // id = fan id; maps to its control
{ "cmd": "flushStandby" }                              // ack.ok + message "Freed X MB"
{ "cmd": "shutdown" }                                  // restore default fan control, close Computer, exit 0
```
Preset duty cycles: silent 30%, balanced 50%, turbo 100%, custom = last fanSet values; auto = `Control.SetDefault()`.
The sidecar must also restore default fan control on stdin EOF / process exit.

## 2. Rust core ⇄ Frontend — Tauri commands & events

All structs `#[serde(rename_all = "camelCase")]`. Commands are async where they do IO, return
`Result<T, String>`. Frontend calls `invoke('<snake_name>', { camelCaseArgs })`.

| Command | Args | Returns |
|---|---|---|
| `get_system_info` | – | `SystemInfo` |
| `get_drivers` | – | `DriverInfo[]` |
| `get_volumes` | – | `Volume[]` |
| `get_physical_disks` | – | `PhysicalDisk[]` |
| `scan_trash` | `{ includeBrowser: bool }` | `TrashScan` |
| `purge_trash` | `{ categories: string[], flushStandby: bool }` | `PurgeResult` (emits `purge-progress`) |
| `export_drivers` | `{ format: "json"\|"csv" }` | `string` (absolute file path written under `Documents\Nexum\`) |
| `backup_drivers` | – | `DriverBackupResult` |
| `set_poll_interval` | `{ ms: number }` | `()` |
| `set_fan_preset` | `{ preset: string }` | `()` |
| `set_fan_control` | `{ id: string, pct: number }` | `()` |
| `flush_standby` | – | `()` (result arrives as `agent-ack` event) |
| `get_settings` | – | `Settings` |
| `save_settings` | `{ settings: Settings }` | `Settings` (applies autostart + poll interval side effects) |
| `get_agent_status` | – | `AgentStatus` |
| `restart_agent` | – | `()` |
| `open_external` | `{ target: string }` | `()` (http(s) URL or existing folder path only) |

Events emitted by Rust (`app.emit`):
- `telemetry` → `TelemetryPacket` (forwarded verbatim from sidecar line, parsed as serde_json::Value)
- `agent-status` → `AgentStatus`
- `agent-ack` → `{ cmd, ok, message }`
- `purge-progress` → `{ categoryId, label, step, totalSteps, freedBytes }`
- `navigate` → `string` view id (from tray menu / global actions)

### 2.1 Shapes

```ts
SystemInfo { hostname, cpuName, gpuNames: string[], motherboard: { manufacturer, product, version },
  bios: { vendor, version, releaseDate /* YYYY-MM-DD or "" */, mode /* "UEFI"|"Legacy"|"Unknown" */ },
  os: { caption, version, build, displayVersion, architecture, installDate },
  secureBoot: boolean|null, tpm: { present: boolean, version: string|null }|null,
  uptimeSecs: number, isAdmin: boolean, ramTotalGb: number, lastDriverScan: string|null }
DriverInfo { deviceName, deviceClass, category /* see below */, provider, manufacturer, version,
  date /* YYYY-MM-DD or "" */, signed: boolean, signer, infName, deviceId, ageDays: number|null,
  status: "ok"|"outdated"|"unsigned" }   // outdated = date older than 3 years
  category ∈ "Display"|"Chipset"|"Network"|"Audio"|"Storage"|"USB"|"Bluetooth"|"Firmware"|"Input"|"System"|"Other"
Volume { letter /* "C:" */, label, fileSystem, totalBytes, freeBytes, usedBytes, driveType /* "Fixed"|"Removable"|"Network"|"CD-ROM"|"Unknown" */, isSystem }
PhysicalDisk { deviceId, model, mediaType /* "SSD"|"HDD"|"Unspecified" */, busType /* "NVMe"|"SATA"|"USB"|... */, sizeBytes, healthStatus /* "Healthy"|"Warning"|"Unhealthy"|"Unknown" */, operationalStatus, serial }
TrashCategory { id, label, description, bytes, files, enabled /* default selection */, optional: boolean, requiresAdmin: boolean }
  ids: "temp" | "recycle" | "wu-cache" | "shader" | "browser" | "logs" | "standby"
TrashScan { categories: TrashCategory[], totalBytes, durationMs }
PurgeCategoryResult { id, label, freedBytes, deleted, skipped }
PurgeResult { freedBytes, filesDeleted, filesSkipped, durationMs, perCategory: PurgeCategoryResult[], standbyFlushed: boolean|null, standbyMessage: string|null }
DriverBackupResult { path, success, output }
Settings { launchOnStartup: false, minimizeToTray: true, pollIntervalMs: 1000, includeBrowserCaches: false,
  confirmBeforePurge: true, flushStandbyOnPurge: false, tempUnit: "C"|"F", startMinimized: false }
AgentStatus { running: boolean, isAdmin: boolean, message: string, lastPacketTs: number|null }
```

## 3. Deep Purge safety rules (Rust `cleaner.rs`) — NON-NEGOTIABLE

1. Allow-list: only delete *inside* the enumerated category roots (§3.1). Never delete the root itself.
2. Deny-list (checked after canonicalization, case-insensitive): `%WINDIR%\System32`, `%WINDIR%\SysWOW64`,
   `%WINDIR%\WinSxS`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%WINDIR%\System32\config`, user
   Documents/Desktop/Pictures/Videos/Music/Downloads/OneDrive, any file named `NTUSER.DAT*`, `UsrClass.dat*`,
   `*.regtrans-ms`, `*.blf`, and the drive roots themselves.
3. Never follow reparse points (symlinks/junctions/mount points): use `symlink_metadata`; if
   `FILE_ATTRIBUTE_REPARSE_POINT` is set, skip (do not descend; do not delete target).
4. Every delete is individually error-handled; locked/in-use/permission-denied files increment `skipped`.
5. Dry-run (`scan_trash`) and purge use the SAME enumerator, so reported numbers match.
6. Browser category never touches `Cookies`, `Login Data`, `Web Data`, `History`, `Local Storage`,
   `IndexedDB`, `Session Storage`, `*.sqlite` outside cache2.
7. Prefetch: only `*.pf` files older than 30 days. Crash dumps: `*.dmp`, `*.mdmp`, `*.hdmp`.

### 3.1 Category roots
- temp: `%TEMP%` (user, via GetTempPath2/env), `%WINDIR%\Temp`
- recycle: `SHQueryRecycleBinW(null)` for size/count; `SHEmptyRecycleBinW(NULL, NULL, SHERB_NOCONFIRMATION|SHERB_NOPROGRESSUI|SHERB_NOSOUND)`
- wu-cache: `%WINDIR%\SoftwareDistribution\Download`, `%WINDIR%\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`
- shader: `%LOCALAPPDATA%\D3DSCache`, `%LOCALAPPDATA%\NVIDIA\DXCache`, `%LOCALAPPDATA%\NVIDIA\GLCache`, `%LOCALAPPDATA%\AMD\DxCache`, `%LOCALAPPDATA%\AMD\DxcCache`, `%LOCALAPPDATA%\AMD\VkCache`, `%LOCALAPPDATA%\AMD\GLCache`, `%PROGRAMDATA%\NVIDIA Corporation\NV_Cache`, `%LOCALAPPDATA%\Intel\ShaderCache`
- browser (optional): Chrome & Edge `User Data\<profile>\{Cache\Cache_Data, Code Cache, GPUCache}` and `User Data\{ShaderCache, GrShaderCache}`; Firefox `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2`; Discord `%APPDATA%\discord\{Cache, Code Cache, GPUCache}`
- logs: `%WINDIR%\Minidump`, `%WINDIR%\MEMORY.DMP` (single file), `%LOCALAPPDATA%\CrashDumps`, `%PROGRAMDATA%\Microsoft\Windows\WER\ReportArchive`, `%PROGRAMDATA%\Microsoft\Windows\WER\ReportQueue`, `%LOCALAPPDATA%\Microsoft\Windows\WER`, `%WINDIR%\Prefetch` (*.pf >30d), `%WINDIR%\Logs\CBS\*.log` older than 30 days except `CBS.log`
- standby: no files; bytes = 0, label "RAM Standby List", handled by sidecar `flushStandby`.

## 4. Frontend file ownership & shared primitives

Builders own disjoint files. Shared primitives (built by the FOUNDATION builder, consumed by others —
use exactly these exports/props):

- `src-frontend/types.ts` — all shapes above (pre-written; do not change field names).
- `src-frontend/lib/api.ts` — typed wrappers: `api.getSystemInfo()`, `api.getDrivers()`, `api.getVolumes()`,
  `api.getPhysicalDisks()`, `api.scanTrash(includeBrowser)`, `api.purgeTrash(categories, flushStandby)`,
  `api.exportDrivers(format)`, `api.backupDrivers()`, `api.setPollInterval(ms)`, `api.setFanPreset(p)`,
  `api.setFanControl(id, pct)`, `api.flushStandby()`, `api.getSettings()`, `api.saveSettings(s)`,
  `api.getAgentStatus()`, `api.restartAgent()`, `api.openExternal(target)`,
  `onEvent<T>(name, cb): Promise<() => void>`. Exports `isTauri: boolean`. When `!isTauri` every call
  is served by `lib/mock.ts` (realistic animated fake data) so `vite dev` in a browser shows a live UI.
- `src-frontend/lib/format.ts` — `fmtBytes(n, digits=1)`, `fmtGb(n)`, `fmtPct(n)`, `fmtTemp(c, unit)`,
  `fmtRpm(n)`, `fmtUptime(secs)`, `fmtMhz(n)`, `clamp(n,a,b)`, `cn(...classes)`.
- `src-frontend/hooks/useTelemetryStream.ts` — `useTelemetry(): { latest: TelemetryPacket|null, history: TelemetryPacket[] /* last 120 */, agent: AgentStatus|null }` (implemented via a React context `TelemetryProvider` in the same file; App wraps everything in it).
- `src-frontend/hooks/useDriverScan.ts` — `useDriverScan(): { drivers, loading, error, lastScan: Date|null, rescan() }` (context `DriverScanProvider`, same file).
- `src-frontend/hooks/useSystemInfo.ts` — `useSystemInfo(): { info, volumes, disks, refresh() }` (context `SystemInfoProvider`).
- `src-frontend/hooks/useSettings.ts` — `useSettings(): { settings, update(partial) }` (context `SettingsProvider`).
- `src-frontend/components/layout/GlassCard.tsx` — `<GlassCard title? icon? actions? accent?="teal"|"gold"|"purple"|"rose"|"cyan"|"silver" className? bodyClassName? children />`
- `src-frontend/components/ui/` — `StatusPill({tone:"ok"|"warn"|"crit"|"info", children, pulse?})`,
  `DottedLeaderRow({label, value, valueClassName?})`, `SegmentedBar({value /*0-100*/, segments=24, tone?})`,
  `DotMatrix({values:number[] /*0-100*/, rows=6, tone?})`, `Sparkline({data:number[], color, height=32})`,
  `TrendArrow({delta})`, `Toggle({checked, onChange, label?})`, `Button({variant:"gold"|"ghost"|"teal"|"danger", size?:"sm"|"md", icon?, ...buttonProps})`,
  `EChart({option, className?, style?})` (thin echarts wrapper: init on mount, setOption(notMerge=false) on change, resize observer, dispose on unmount, renderer 'canvas').
  Barrel `components/ui/index.ts` re-exports all.
- Views (one file each in `src-frontend/views/`): `DashboardView`, `DriversView`, `StorageView`, `FanControlView`, `CleanerView`. Each default-exported, no props.
- `ViewId = "dashboard"|"drivers"|"storage"|"fans"|"cleaner"`. App holds current view; `components/layout/TopBar.tsx`
  receives `{ view, onNavigate, onPurge, onRefresh, onSettings }`.
- Purge flow: `components/cleaner/OneClickPurgeModal.tsx` — `<OneClickPurgeModal open onClose />` self-contained
  (scans on open → shows "X GB Ready to Purge" with per-category toggles → purge with live progress via `purge-progress` →
  `CleanupSummary` "Freed 6.4 GB in 2.3s"). Respects `settings.confirmBeforePurge` (if false and opened via F9 → run immediately).
  Opened from TopBar button and F9. Export also `CleanupSummary.tsx`.
- Keyboard: F1 dashboard, F2 drivers, F3 storage, F4 fans, F5 rescan (preventDefault — must not reload WebView), F9 quick clean, Esc closes modals. Disable WebView default context menu in production.

### Theme tokens (Tailwind v4 `@theme` in `styles/nexum.css`)
`--color-canvas-0:#070B0E; --color-canvas-1:#0D1B1E; --color-card: rgba(16,26,30,0.72); --color-line: rgba(255,255,255,0.08);
--color-teal:#2DD4BF; --color-gold:#D4A359; --color-purple:#9333EA; --color-rose:#E11D48; --color-cyan:#22D3EE; --color-silver:#CBD5E1;
--color-ink:#F8FAFC; --color-muted:#64748B;` Fonts: "Inter" for UI, "JetBrains Mono" for numeric readouts (bundle via
@fontsource packages — no network fonts at runtime). Body: radial gradient canvas-1 → canvas-0, subtle scanline/grid overlay.
