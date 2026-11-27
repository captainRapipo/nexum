# Nexum — Internal Integration Contract

**Contract version: 1.0.0-gate** (2026-11-27). Implements the v1.0 gate of [`docs/ROADMAP.md`](docs/ROADMAP.md): MF-1 … MF-13, the "v1.0: ship now" table (§3), the §6 design-system changes and the C2/§6.5 keymap.
Not in scope: anything labelled v1.1 / v1.2+ (FPS capture, CSV logging, Rust alert engine, tuning, overlay).

Single source of truth for how the three layers talk. Every implementer follows it literally.
The TypeScript mirror is [`src-frontend/types.ts`](src-frontend/types.ts): it is authoritative for field names, unions and defaults. Where this file and `types.ts` disagree, `types.ts` wins for names/types and this file wins for behaviour; report the conflict to the contract owner.

Markers: **[NEW]** added in 1.0.0-gate · **[BREAKING]** removed, renamed or re-typed (pre-1.0, no compatibility shim unless stated) · **[CHANGED]** same shape, new semantics.

---

## 0. Layout, versions, global rules

```
nexum-monitor/
├── package.json, vite.config.ts, tsconfig*.json, index.html (Vite root = src-frontend/)
├── src-frontend/            React 18 + TS + Tailwind v4 (@tailwindcss/vite) + echarts
├── src-tauri/               Tauri v2 Rust core (crate name `nexum`, productName `Nexum`)
└── nexum-agent/             C# .NET 8 sidecar (NexumAgent.csproj, LibreHardwareMonitorLib 0.9.6)
```

Versions: tauri 2.x, tauri-build 2.x, tauri-plugin-shell 2.x, @tauri-apps/api ^2, **@tauri-apps/cli >=2.9.3 [CHANGED, MF-8]**,
react ^18.3, vite ^6, typescript ^5.6, tailwindcss ^4 + @tailwindcss/vite ^4, echarts ^5.5, lucide-react.
Identifier: `net.nexum.monitor`. Window: 1600x960, min 1280x800, decorations true, title "Nexum".
Frontend dist: `../dist` (relative to src-tauri). Dev URL: `http://localhost:1420`.

Global rules for this round:
- **No new third-party dependencies** (npm, NuGet, crates). Allowed: new `windows` crate *features* in `src-tauri/Cargo.toml`. Virtualized lists are hand-written (fixed row height windowing).
- **No network code** anywhere (MF-11). The only outbound action is `open_external` handing an `https://` URL to the default browser.
- **Privacy:** no real hostnames, serials or personal data in tracked files. Mock profiles use `WORKSTATION-01` / `WORKSTATION-02` and fake serials. Serials are masked (`••••` + last 4) in any export or "Copy as text".
- **Unavailable is not zero** (MF-2): a value the layer cannot read is `null`, never `0`, and no layer substitutes a different sensor (e.g. never a GPU fan for a motherboard fan).
- Rust is verified only in CI (Smart App Control blocks local `cargo`). Keep Rust changes conservative and covered by `#[cfg(test)]` unit tests where logic is pure.

---

## 1. Sidecar (nexum-agent) ⇄ Rust — NDJSON over stdio

The sidecar writes ONE JSON object per line to **stdout** (UTF-8, no BOM, camelCase, `\n` terminated, flush after every line). Never write anything else to stdout (logs → stderr). It reads ONE JSON command per line from **stdin**. Nullable members are always written (null is never omitted). Lines are emitted in causal order on a single writer (a `sensorTree` with a new `rev` is always written before any `sensorValues` with that `rev`).

### 1.1 Outgoing messages (sidecar → Rust)

```jsonc
{ "type": "hello", "version": "1.0.0", "protocol": 2, "isAdmin": true, "pid": 1234,
  "sensorDriver": SensorDriverStatus, "fanFlag": "none"|"interrupted"|"previousBoot" }   // [NEW fields]
{ "type": "telemetry", ...TelemetryPacket }            // every intervalMs (default 1000)
{ "type": "sensorTree", ...SensorTree }                // [NEW] §1.3
{ "type": "sensorValues", ...SensorValues }            // [NEW] §1.3, only while the stream is on
{ "type": "spec", ...AgentSpec }                       // [NEW] §1.4, reply to {"cmd":"spec"}
{ "type": "ack", "cmd": "fanPreset", "ok": true, "message": "Applied Balanced to 4 fans" }
{ "type": "error", "message": "..." }                  // non-fatal
```

`hello` is the first line, written after LHM `Open()` and before the first `telemetry`.

**`hello.sensorDriver` [NEW, MF-2]** — `SensorDriverStatus`:

| Field | Type | Rule |
|---|---|---|
| `kind` | `"pawnio"\|"none"` | `"pawnio"` iff `LibreHardwareMonitor.PawnIo.PawnIo.IsInstalled` |
| `version` | `string\|null` | `PawnIo.Version` formatted `major.minor.patch`; null if not installed or unreadable |
| `minVersion` | `"2.1.0"` | constant |
| `ok` | `boolean` | `isAdmin && kind=="pawnio" && version != null && version >= minVersion` |
| `reason` | `"missing"\|"outdated"\|"notElevated"\|null` | first match of: not installed → `missing`; version known and `< 2.1.0` → `outdated`; `!isAdmin` → `notElevated`; else `null` |

**`hello.fanFlag` [NEW, MF-13]** — result of the write-ahead flag check at agent start (§1.5.3).

#### 1.1.1 TelemetryPacket

All temps °C, clocks MHz, sizes GB unless suffixed, `null` when the sensor is unavailable.

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
              "hwId": "/lpc/nct6798d/0",                         // [NEW]
              "rpm": 1150.0, "rpmMin": 980.0, "rpmMax": 1420.0, // [NEW] min/max
              "controllable": true, "controlPct": 45.0 } ],
  "disks": [ DiskTelemetry, ... ],           // §1.1.3
  "network": { "downMBps": 0.12, "upMBps": 0.03 } | null,
  "fanPreset": "balanced",                   // "auto" | "silent" | "balanced" | "turbo" | "custom" — last REQUESTED preset
  "fanSafety": FanSafety                     // [NEW] §1.5
}
GpuTelemetry = { "name": "NVIDIA GeForce RTX 4080", "vendor": "nvidia"|"amd"|"intel"|"unknown",
  "load": 3.0, "vramUsedGb": 1.4, "vramTotalGb": 16.0, "coreClockMhz": 210.0, "memClockMhz": 405.0,
  "tempC": 38.0, "hotspotTempC": 45.0, "powerW": 18.0, "fanRpm": 0.0, "fanPct": 0.0 }
```

- `fans[]` lists motherboard/controller fans and GPU fans; `hwId` tells them apart. `fans[].id` is the LHM **sensor** identifier of the RPM sensor and is the key for user labels (§2.2). `rpmMin`/`rpmMax` are LHM `ISensor.Min/Max` (session, reset by `sensorReset`).
- **[NEW, MF-7]** After `Open()` and on every `HardwareAdded`, the sidecar sets `sensor.ValuesTimeWindow = TimeSpan.Zero` for every sensor (recursively through sub-hardware). Min/Max keep working.

#### 1.1.2 CPU semantics [CHANGED, MF-9]

- `cpu.loadPerCore`: one entry per **physical** core (LHM `CPU Core #n Thread #m` folded per core), length = `cpu.cores`. UI label: `Per-core load (8C/16T)`.
- `cpu.clockMhz`: LHM clock sensor `"Cores (Average Effective)"`; if absent, mean of `"Core #n (Effective)"` sensors; if absent, mean of raw `"Core #n"` clocks; else null.
- `cpu.maxClockMhz`: max of raw `"Core #n"` clocks this tick.
- `cpu.packageTempC`: first present of `"Core (Tctl/Tdie)"`, `"CPU Package"`, `"Core (Tctl)"`, `"Core (Tdie)"`, `"Tctl/Tdie"`, `"Package"` (temperature sensors of the CPU hardware). This same value is the fan-override input (§1.5).
- `gpu.tempC` is the **edge** temperature (UI: "Edge temp"); `hotspotTempC` is "GPU Hot Spot".

#### 1.1.3 Disk telemetry and the drive-health classifier [NEW, MF-1]

```jsonc
DiskTelemetry = {
  "id": "/nvme/0",                 // LHM hardware identifier == HardwareNode.id in the sensor tree
  "name": "Samsung SSD 990 PRO 2TB",
  "diskNumber": 0,                 // [NEW] Windows PhysicalDriveN, null if unknown
  "serial": "S6Z2NF0W123456A",     // [NEW] trimmed, null if unknown
  "tempC": 41.0, "tempMinC": 35.0, "tempMaxC": 52.0,          // [NEW] min/max = LHM session
  "readMBps": 0.4, "writeMBps": 1.2,
  "healthPct": 99.0,               // remaining life %, = 100 − percentageUsed (clamped 0..100) for NVMe
  "tbw": 12.3,                     // host TB written
  "powerOnHours": 2210, "usedPct": 61.0,
  "health": { "state": "good", "label": "Good", "reason": "99% life left · 1% of rated endurance used · 2,210 power-on hours", "source": "nvme" },
  "criticalWarning": 0,            // NVMe critical-warning byte, null otherwise
  "availableSparePct": 100, "availableSpareThresholdPct": 10, "percentageUsed": 1,
  "mediaErrors": 0, "unsafeShutdowns": 31, "powerCycles": 812, "errorLogEntries": 0,
  "warningTempC": 82, "criticalTempC": 85,           // drive thresholds (WCTEMP/CCTEMP)
  "warningTempMinutes": 0, "criticalTempMinutes": 0, // time above them
  "reallocatedSectors": null, "pendingSectors": null, "uncorrectableSectors": null,  // ATA 05 / C5 / C6 raw
  "dataReadTb": 20.4
}
```

All new numeric fields are `number|null`, sourced from LHM `StorageDevice` sensors and `Attributes` ([SmartAttributeTranslator.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Storage/SmartAttributeTranslator.cs)) and the existing `MSFT_StorageReliabilityCounter` cache.

**Classifier.** The sidecar is the single classifier (`DriveHealth.Classify` in `nexum-agent`). Rust and the UI never re-derive state from `healthPct` or Windows `HealthStatus`. Inputs per drive: the fields above, `life = healthPct`, and Windows `MSFT_PhysicalDisk.HealthStatus` joined inside the sidecar by the join rule below. Rules are evaluated top to bottom; the first matching row sets `state` and `label`; `reason` lists every matching trigger of that state joined with " · ".

| # | state | label (exact) | Trigger |
|---|---|---|---|
| 1 | `failing` | `Failing` | `criticalWarning & 0x1D ≠ 0` (bit0 spare below threshold, bit2 reliability degraded, bit3 read-only, bit4 volatile backup failed); or `availableSparePct < availableSpareThresholdPct` (both non-null, threshold > 0); or Windows `HealthStatus == Unhealthy` |
| 2 | `replace` | `Replace soon` | `life ≤ 10` |
| 3 | `attention` | `Worn` | `10 < life ≤ 50` |
| 4 | `attention` | `Check sectors` | any of `reallocatedSectors`, `pendingSectors`, `uncorrectableSectors` > 0 |
| 5 | `attention` | `Overheating` | `criticalWarning & 0x02 ≠ 0` (temperature threshold) |
| 6 | `attention` | `Windows warning` | Windows `HealthStatus == Warning` |
| 7 | `good` | `Good` | `life > 50`, or (`life == null` and `source == "smart"` and all three sector counts are `0`) |
| 8 | `unknown` | see below | anything else (no SMART data, or data without wear/sector evidence). **Never green.** |

- `source`: `"nvme"` when the NVMe health log was read, `"smart"` when ATA SMART attributes were read, else `"none"`.
- Unknown labels (exact): `!isAdmin` → `Health unknown — run as administrator`; otherwise `source == "none"` → `Health unknown — no S.M.A.R.T. data`; otherwise `Health unknown — no wear data`. (SMART needs elevation, not PawnIO.)
- `reason` fragments (exact formats, numbers with thousands separators, `en-US`): `"{life}% life left"`, `"{percentageUsed}% of rated endurance used"`, `"{powerOnHours} power-on hours"`, `"NVMe critical warning: available spare below threshold"`, `"NVMe critical warning: reliability degraded"`, `"NVMe critical warning: drive is read-only"`, `"NVMe critical warning: volatile memory backup failed"`, `"available spare {availableSparePct}% is below the {availableSpareThresholdPct}% threshold"`, `"Windows reports this drive as Unhealthy"`, `"{n} reallocated / {n} pending / {n} uncorrectable sectors"`, `"drive reported a temperature warning"`, `"Windows reports a warning for this drive"`. For `good` the reason is the life/endurance/hours fragments that are non-null; for `unknown` it repeats the cause ("S.M.A.R.T. needs administrator rights", "The drive or its USB bridge does not report S.M.A.R.T. data", "No wear or sector data reported").

**Join rule (telemetry disk ⇄ `PhysicalDisk` ⇄ Windows disk).** Used identically by the sidecar (for `HealthStatus`) and the frontend (`lib/disks.ts`):
1. `normSerial(s) = s.replace(/[\s._-]/g, "").toUpperCase()`; empty → null. Match when both normalized serials are non-null and equal.
2. Else match `DiskTelemetry.diskNumber === Number(PhysicalDisk.deviceId)`.
3. Else unmatched (frontend shows the PhysicalDisk with health `unknown`, label `Health unknown — no S.M.A.R.T. data`).

### 1.2 Incoming commands (Rust → sidecar stdin)

```jsonc
{ "cmd": "interval", "ms": 1000 }                     // clamp 250..10000
{ "cmd": "fanPreset", "preset": "silent"|"balanced"|"turbo"|"auto" }   // auto = release to BIOS
{ "cmd": "fanSet", "id": "/lpc/.../fan/0", "pct": 55 }                // id = fan id; maps to its control
{ "cmd": "sensorTree" }                                // [NEW] re-emit the current sensorTree
{ "cmd": "sensorStream", "on": true }                  // [NEW] start/stop sensorValues; default off at start
{ "cmd": "sensorReset", "ids": ["/lpc/it8688e/0/temperature/4"] | null }   // [NEW] ack.ok
{ "cmd": "spec" }                                      // [NEW] reply {"type":"spec",...}
{ "cmd": "shutdown" }                                  // restore default fan control (unless failsafe), close Computer, exit 0
```

- **[BREAKING, MF-4]** `{ "cmd": "flushStandby" }` is removed. `MemoryFlush.cs` is deleted. An unknown `cmd` gets `{"type":"ack","cmd":<cmd>,"ok":false,"message":"Unknown command"}`.
- Preset duty cycles (unchanged): silent 30%, balanced 50%, turbo 100%, custom = last fanSet values; auto = `Control.SetDefault()`. Presets are **fixed speed and ignore temperature**; the UI subtitle for every non-auto preset is exactly `Fixed speed, ignores temperature`. `fanPreset:"auto"` stays the default.
- Fan commands while not elevated → `ack ok:false`, message `Fan control needs administrator rights`. All fan-command behaviour under override/failsafe is in §1.5.
- The sidecar restores default fan control on stdin EOF / process exit (graceful paths), **except** in failsafe mode (§1.5.4).

### 1.3 Sensor tree protocol [NEW, Sensors view]

```jsonc
{ "type":"sensorTree", "rev":3, "sessionStartTs":1764230000000, "hardware":[ HardwareNode, ... ] }
{ "type":"sensorValues", "ts":1764230001000, "rev":3, "value":[...], "min":[...], "max":[...], "avg":[...] }
HardwareNode = { "id":"/lpc/it8688e/0", "parentId":"/motherboard", "kind":"superio", "name":"ITE IT8688E", "sensors":[ SensorMeta, ... ] }
SensorMeta   = { "id":"/lpc/it8688e/0/temperature/4", "idx":17, "hwId":"/lpc/it8688e/0", "name":"VRM MOS",
                 "kind":"temperature", "unit":"°C", "decimals":1, "static":false, "defaultHidden":false }
```

**Emission.**
- `sensorTree` is written once after `hello` (after the first `Update()`), again with `rev+1` whenever the sensor set or order changes (`HardwareAdded`, `HardwareRemoved`, `SensorAdded`, `SensorRemoved`, including DIMMs that `MemoryGroup` adds ~10 s late), on `{cmd:"sensorTree"}` (same rev), and after a reset-all (same rev, new `sessionStartTs`).
- `sensorValues` is written once per telemetry tick, immediately after the `telemetry` line, only while the stream is on. Default off at agent start.

**Tree shape.** `hardware` is the LHM hardware list flattened depth-first (each parent before its sub-hardware), in LHM enumeration order. Root nodes have `parentId:null`. Every LHM hardware and sensor appears; nothing is renamed (`ISensor.Name` is never written by Nexum, because the mappers look sensors up by name).

**idx/rev stability rule.** `idx` is dense `0..N−1` in tree order (hardware order, then sensor order within a node as LHM lists them). For a given `rev` the mapping `idx ⇄ id` is fixed. `rev` starts at 1 in each agent process and increases by 1 on every change of the sensor set or order; it never changes for value-only updates. Consumers drop any `sensorValues` whose `rev` differs from the tree they hold and request the tree (`get_sensor_tree`). After an agent restart, the new process's first `sensorTree` (rev 1) always precedes its values; consumers replace their tree on **every** `sensor-tree` event regardless of `rev`.

**Values.** Arrays have length N. Each entry is the value in `SensorMeta.unit`, rounded to `SensorMeta.decimals`, or `null` (NaN/unavailable). `min`/`max` are LHM `ISensor.Min/Max` (converted to the same unit). `avg` is the arithmetic mean of all non-null samples taken at telemetry ticks since `sessionStartTs` or the sensor's last reset (sidecar accumulator; not LHM history).

**`sensorReset`.** `ids:null` → `ResetMin()`/`ResetMax()` and avg reset for every sensor, `sessionStartTs = now`, re-emit `sensorTree` (same rev). `ids:[…]` → the same for those sensors only (unknown ids ignored). Reply `ack {cmd:"sensorReset", ok:true, message:"Reset N sensors"}`. This also resets `fans[].rpmMin/rpmMax` and `disks[].tempMinC/tempMaxC`, which read the same LHM Min/Max.

**HardwareKind** = LHM `HardwareType` camelCased: `Motherboard→motherboard`, `SuperIO→superio`, `Cpu→cpu`, `Memory→memory`, `GpuNvidia→gpuNvidia`, `GpuAmd→gpuAmd`, `GpuIntel→gpuIntel`, `Storage→storage`, `Network→network`, `Cooler→cooler`, `EmbeddedController→embeddedController`, `Psu→psu`, `Battery→battery`, `PowerMonitor→powerMonitor`; any other value → `other`.

**SensorKind, unit and decimals** (LHM `SensorType` → wire). A sensor of an LHM type not in this table is omitted from the tree.

| LHM SensorType | kind | unit | decimals | conversion / special cases |
|---|---|---|---|---|
| Voltage | `voltage` | `V` | 3 | |
| Current | `current` | `A` | 2 | |
| Power | `power` | `W` | 1 | |
| Clock | `clock` | `MHz` | 0 | |
| Temperature | `temperature` | `°C` | 1 | |
| Load | `load` | `%` | 1 | |
| Frequency | `frequency` | `Hz` | 0 | |
| Fan | `fan` | `RPM` | 0 | |
| Flow | `flow` | `L/h` | 0 | |
| Control | `control` | `%` | 0 | |
| Level | `level` | `%` | 1 | |
| Factor | `factor` | `""` | 2 | |
| Data | `data` | `GB` | 1 | name matches `/count\|cycles/i` → unit `""`, decimals 0 |
| SmallData | `smallData` | `MB` | 0 | name matches `/count\|cycles/i` → unit `""` |
| Throughput | `throughput` | `MB/s` | 2 | LHM B/s ÷ 1,048,576 |
| TimeSpan | `timeSpan` | `s` | 0 | name matches `/hours/i` → unit `h` |
| Timing | `timing` | `ns` | 2 | |
| Energy | `energy` | `mWh` | 0 | |
| Noise | `noise` | `dBA` | 0 | |
| Conductivity | `conductivity` | `µS/cm` | 1 | |
| Humidity | `humidity` | `%` | 0 | |

**`static`** is true for: every `timing` sensor; `data`/`smallData` sensors named `Total Space`, `Capacity`, `Total Memory`, `GPU Memory Total`; temperature sensors whose name contains `Limit`, `Threshold`, `Warning Temperature` or `Critical Temperature`. **`defaultHidden`** is true when the sensor's value is NaN/null at the moment the tree is built.

### 1.4 System spec (agent part) [NEW, System view lite]

`{"cmd":"spec"}` → one line `{ "type":"spec", "capturedTs":…, "cpu":CpuSpec|null, "board":BoardSpec|null, "memory":MemorySpec|null, "gpus":GpuSpec[], "errors":string[] }` (= `AgentSpec`; the TS shapes are in `types.ts`). Each section is computed independently; a section that throws becomes `null` (or `[]` for gpus) and adds `"<Section> query failed: <message>"` to `errors`. The reply is produced on a background thread; it must not stall telemetry for more than one tick. No driver is required for any v1.0 field except `board.superIo` (needs PawnIO via LHM; null otherwise).

**Field ownership — one owner per field.** Sidecar (A) owns `cpu`, `board`, `memory`, `gpus`. Rust (B) owns `os`, `security` and the merge (§2.6).

| Field | Source (sidecar) |
|---|---|
| `cpu.name` | LHM CPU hardware name (fallback `Win32_Processor.Name`), trimmed |
| `cpu.vendor` | CPUID vendor string → `"AMD"`, `"Intel"`, else `"Other"` |
| `cpu.family/model/stepping` | CPUID leaf 1 via LHM `CpuId` (public). Display family = base + extended family when base == 0xF; display model = (extModel << 4) + baseModel when base family == 0xF, or Intel family 6; decimal numbers on the wire |
| `cpu.codename` | static table keyed by (vendor, family, model); include only entries you can source; else `null` |
| `cpu.socket` | `Win32_Processor.SocketDesignation`, null if empty |
| `cpu.cores/threads` | physical cores / logical processors (same as telemetry) |
| `cpu.baseClockMhz` | `Win32_Processor.MaxClockSpeed`, null if 0 |
| `cpu.caches` | `GetLogicalProcessorInformationEx(RelationCache)`; group identical (level, type, size, ways) entries and count them as `instances`; `type`: CacheData→`data`, CacheInstruction→`instruction`, CacheUnified→`unified`, CacheTrace skipped; `ways` 0xFF → null; sort L1 data, L1 instruction, L2, L3 |
| `cpu.instructions` | CPUID feature bits; include those present, in this exact order: `MMX, SSE, SSE2, SSE3, SSSE3, SSE4.1, SSE4.2, SSE4A, AES, AVX, AVX2, AVX-512F, FMA3, SHA, x86-64, AMD-V, VT-x` |
| `board.manufacturer/product/version` | `Win32_BaseBoard` (raw, trimmed) |
| `board.biosVendor/biosVersion/biosDate` | `Win32_BIOS.Manufacturer`, `SMBIOSBIOSVersion`, `ReleaseDate` → `YYYY-MM-DD` or `""` (raw vendor; the UI normalizes) |
| `board.superIo` | name of the first LHM `HardwareType.SuperIO` hardware, else null |
| `memory.type` | `Win32_PhysicalMemory.SMBIOSMemoryType` of the first populated DIMM: 24 `DDR3`, 26 `DDR4`, 34 `DDR5`, 30 `LPDDR4`, 35 `LPDDR5`, else `Unknown` |
| `memory.totalGb` | Σ `Capacity` / 2^30, 1 decimal |
| `memory.channels` | distinct channel letters parsed from each populated DIMM's `BankLabel` (`/CHANNEL\s*([A-H])/i`) or `DeviceLocator` (`/(?:DIMM|CHANNEL)[_\s-]*([A-H])\d?/i`); null if any populated DIMM is unparseable |
| `memory.slotsUsed/slotsTotal` | populated rows / Σ `Win32_PhysicalMemoryArray.MemoryDevices` where `Use = 3` (null if unknown) |
| `memory.dimms[]` | `Win32_PhysicalMemory`: `DeviceLocator`→slot, `Manufacturer`, `PartNumber` (trimmed), `Capacity`→sizeGb, `Speed`→speedMts, `ConfiguredClockSpeed`→configuredSpeedMts, `Attributes`→ranks (0 → null), `ConfiguredVoltage`/1000→voltage (0 → null), `FormFactor` (8 `DIMM`, 12 `SODIMM`, else `Other`). **No serial numbers.** |
| `memory.timings/timingsSource/xmp` | v1.0 constants: `null`, `"unavailable"`, `null` |
| `gpus[]` | `Win32_VideoController` rows whose `PNPDeviceID` starts with `PCI\`: `Name`; vendor from `VEN_10DE`/`VEN_1002`/`VEN_8086`; `vramGb` from the matching LHM GPU "GPU Memory Total" sensor (MB → GB, 1 decimal), else null (never `AdapterRAM`, which caps at 4 GB); `DriverVersion`; `DriverDate` → `YYYY-MM-DD` or null |

### 1.5 Fan control fail-safe [NEW, MF-13]

#### 1.5.1 `telemetry.fanSafety`

```jsonc
"fanSafety": { "manualActive": false, "overrideActive": false, "reason": null, "failsafe": false, "triggerC": 85, "releaseC": 75 }
```

- `manualActive`: at least one control is in software mode written by this agent (any successful non-`auto` `fanPreset`, any `fanSet`, the override, or failsafe). `fanPreset:"auto"` that succeeds sets it false.
- `overrideActive` / `reason` (`"failsafe"|"sensorMissing"|"cpuTemp"|"gpuTemp"|null`): precedence failsafe > sensorMissing > cpuTemp > gpuTemp.
- `failsafe`: the agent latched fans at 100% after a same-boot flag (§1.5.3).
- Without admin rights all four booleans/reason are false/null.

#### 1.5.2 Thermal override (agent)

Evaluated whenever `manualActive` is true, on every telemetry tick, and **at least every 1000 ms** (if `intervalMs > 1000` the agent runs an extra CPU/GPU-only `Update()` for the evaluation).
- `T_cpu` = the value published as `cpu.packageTempC` (§1.1.2).
- **cpuTemp:** `T_cpu ≥ 85.0` → override on. Releases when `T_cpu ≤ 75.0` on 3 consecutive evaluations.
- **gpuTemp:** for each GPU that owns at least one fan under manual control: `T_gpu = hotspotTempC ?? tempC`; trigger `T_gpu ≥ 100.0` (hotspot) or `≥ 90.0` (edge, when hotspot is null); release `≤ trigger − 10` on 3 consecutive evaluations. *(Safety addition beyond ROADMAP MF-13, which names only the CPU.)*
- **sensorMissing:** `T_cpu` null/NaN on 3 consecutive evaluations (or `T_gpu` null for a GPU whose fan is under manual control) → override on. Releases when the reading is back and ≤ its release temperature on 3 consecutive evaluations.
- While the override is on: every controllable control is written to 100%. `fanPreset`/`fanSet` commands are stored as the user's target and acked `ok:true` with message exactly `Saved. Fans stay at 100% until the CPU cools to 75 °C.` (GPU/sensor variants: `…until the GPU cools.` / `…until the temperature sensor reads again.`). When the override releases, the stored target is applied. Exception: `fanPreset:"auto"` always applies immediately (BIOS control is safe), ends manual mode and the override, and deletes the flag.
- Every override transition is logged to stderr.

#### 1.5.3 Write-ahead flag

- **Path:** `%ProgramData%\Nexum\fan-manual.flag` (resolve `%ProgramData%` with `Environment.SpecialFolder.CommonApplicationData`).
- **Folder ACL** (agent creates/repairs it whenever elevated, before first use; lesson from Razer CVE-2021-44226): owner `BUILTIN\Administrators`; protected DACL (inheritance from `C:\ProgramData` disabled) with exactly: `NT AUTHORITY\SYSTEM` Full control, `BUILTIN\Administrators` Full control, `BUILTIN\Users` Read & execute; inherited by files. If the folder exists with another owner or any ACE granting write/delete/change-permissions to a non-admin SID, the agent resets owner and DACL. If the folder or the flag path is a reparse point, the agent refuses manual fan control (`ack ok:false`, `Fan control is unavailable: unsafe state folder`).
- **Content** (one JSON line, UTF-8): `{"v":1,"pid":1234,"bootTs":1764200000000,"bootId":null,"ts":1764230000000,"mode":"preset"|"fanSet"|"override"|"failsafe","agentVersion":"1.0.0"}`. `bootTs` = `now − Environment.TickCount64` (unix ms); `bootId` = DWORD `BootId` from `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters` if present, else null.
- **Write-ahead:** before the first manual write of a session the agent writes the flag (`FileOptions.WriteThrough`, then flush). If the flag cannot be written, the manual write is refused (`ack ok:false`, `Fan control is unavailable: could not record the fan-control state`).
- **Delete:** only after `SetDefault()` succeeded for every control the agent touched (auto preset or graceful shutdown).
- **Check at agent start** (sets `hello.fanFlag`): flag absent → `"none"`. Flag present and *same boot* → `"interrupted"`. Flag present from another boot → delete it, `"previousBoot"`. Same boot = (`bootId` non-null in both and equal) or (`bootId` null in either and `|flag.bootTs − current bootTs| ≤ 120000`). An unreadable/corrupt flag counts as same boot. Non-elevated agents only read the flag (report `interrupted`/`previousBoot`, never delete, cannot force fans).

#### 1.5.4 Failsafe mode (agent)

Entered at start when `fanFlag == "interrupted"` and the agent is elevated:
- Writes 100% to every controllable control, rewrites the flag with `mode:"failsafe"`, sets `fanSafety.failsafe = overrideActive = manualActive = true`, `reason:"failsafe"`.
- Latched until process exit. Every `fanPreset` (including `auto`) and `fanSet` → `ack ok:false`, message exactly `Fan control is locked at 100% after an interruption. Restart the PC to return fans to BIOS control.`
- On `shutdown`/EOF in failsafe mode the agent does **not** call `SetDefault()` (it would restore the stale manual values captured at this process's init) and leaves the flag in place.

Rationale: after a hard kill on boards like the IT8688E the original PWM registers and Gigabyte controller state exist only in the dead process (ROADMAP MF-13), so only a reboot restores BIOS control.

#### 1.5.5 Owner test result (pending)

> To be filled after the ROADMAP MF-13 test on the reference rig: `taskkill /F` the agent under each preset; record header behaviour and whether a warm reboot or only a cold power cycle restores BIOS control. Until then the banner says "Restart the PC".

---

## 2. Rust core ⇄ Frontend — Tauri commands & events

All structs `#[serde(rename_all = "camelCase")]`. Commands are async where they do IO and return `Result<T, String>`. Frontend calls `invoke('<snake_name>', { camelCaseArgs })`.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_system_info` | – | `SystemInfo` | **[CHANGED]** adds `bootTs` |
| `get_drivers` | – | `DriverInfo[]` | **[BREAKING]** status union, `problemCode`, `isInbox` (§2.7) |
| `get_volumes` | – | `Volume[]` | |
| `get_physical_disks` | – | `PhysicalDisk[]` | **[CHANGED]** adds `volumes`, `isSystemDisk` (§2.8) |
| `scan_trash` | `{ includeBrowser: bool }` | `TrashScan` | **[CHANGED]** §3 |
| `purge_trash` | `{ categories: string[] }` | `PurgeResult` (emits `purge-progress`) | **[BREAKING]** `flushStandby` arg removed |
| `export_drivers` | `{ format: "json"\|"csv" }` | `string` (absolute path under `Documents\Nexum\`) | |
| `backup_drivers` | – | `DriverBackupResult` | |
| `set_poll_interval` | `{ ms: number }` | `()` | |
| `set_fan_preset` | `{ preset: string }` | `()` | |
| `set_fan_control` | `{ id: string, pct: number }` | `()` | |
| ~~`flush_standby`~~ | | | **[BREAKING]** removed |
| `get_settings` | – | `Settings` | |
| `save_settings` | `{ settings: Settings }` | `Settings` | applies autostart + poll interval; sanitizes (§2.2) |
| `get_agent_status` | – | `AgentStatus` | **[CHANGED]** §2.3 |
| `restart_agent` | – | `()` | |
| `open_external` | `{ target: string }` | `()` | http(s) URL or existing folder path only |
| `get_sensor_tree` | – | `SensorTree \| null` | **[NEW]** cached; if none cached and agent running, sends `{cmd:"sensorTree"}` and waits ≤ 5 s; null when agent down/timeout |
| `set_sensor_stream` | `{ on: bool }` | `()` | **[NEW]** stores the UI's wish; effective = wish ∧ window visible ∧ agent running; re-sent after every `hello` |
| `reset_sensor_stats` | `{ ids: string[] \| null }` | `()` | **[NEW]** forwards `sensorReset`, waits for the ack (≤ 5 s); Err on `ok:false`/timeout |
| `get_system_spec` | `{ refresh?: bool }` | `SystemSpec` | **[NEW]** §2.6; cached until `refresh:true` or agent restart |
| `get_fan_failsafe_state` | – | `FanFailsafeState` | **[NEW]** §2.4 |
| `dismiss_fan_failsafe` | – | `FanFailsafeState` | **[NEW]** clears only `kind:"previousBoot"`; Err otherwise |
| `restart_as_admin` | – | `()` | **[NEW]** `ShellExecuteExW` verb `runas` on the current exe with the same args, then `app.exit(0)`; Err if already admin or UAC cancelled |
| `open_reliability_monitor` | – | `()` | **[NEW]** spawns `%SystemRoot%\System32\perfmon.exe /rel` (fixed path, no user args) |

Events emitted by Rust (`app.emit`):
- `telemetry` → `TelemetryPacket` (forwarded verbatim from the sidecar line, parsed as `serde_json::Value`)
- `agent-status` → `AgentStatus`
- `agent-ack` → `{ cmd, ok, message }`
- `purge-progress` → `PurgeProgress`
- `navigate` → `NavTarget` string: a `ViewId` (`"dashboard"|"sensors"|"system"|"storage"|"cooling"|"drivers"|"cleaner"`), `"quick-clean"` (open the clean-caches modal with confirmation) or `"settings"`
- **[NEW]** `sensor-tree` → `SensorTree` (verbatim line, includes `type`); Rust caches the latest and clears the cache on agent exit
- **[NEW]** `sensor-values` → `SensorValues` (verbatim line)
- **[NEW]** `fan-failsafe` → `FanFailsafeState` (on every change)
- **[NEW]** `self-usage` → `SelfUsage` every 5 s (§2.5)

**Tray menu [CHANGED]** (ids → action): `show` "Show Nexum" → show window · separator · `dashboard` "Dashboard", `sensors` "Sensors", `system` "System", `storage` "Storage", `cooling` "Cooling", `drivers` "Drivers" → `navigate` with that ViewId · separator · `clean-caches` "Clean caches…" → `navigate "quick-clean"` · separator · `quit` "Quit".

**Minimized to tray (ROADMAP §6.8):** while hidden, Rust sets the poll interval to ≥ 5000 ms (existing), sends `{cmd:"sensorStream","on":false}` and stops `self-usage`; on show it restores both. The frontend pauses chart rendering while `document.hidden`.

### 2.1 Shapes

Exact TypeScript in `types.ts`. Rust structs mirror them field for field.

```ts
SystemInfo { hostname, cpuName, gpuNames: string[], motherboard: { manufacturer, product, version },
  bios: { vendor, version, releaseDate /* YYYY-MM-DD or "" */, mode /* "UEFI"|"Legacy"|"Unknown" */ },
  os: { caption, version, build, displayVersion, architecture, installDate },
  secureBoot: boolean|null, tpm: { present: boolean, version: string|null }|null,
  uptimeSecs: number /* deprecated for display */, bootTs: number /* [NEW] unix ms */,
  isAdmin: boolean, ramTotalGb: number, lastDriverScan: string|null }
DriverInfo { deviceName, deviceClass, category, provider, manufacturer, version, date /* YYYY-MM-DD or "" */,
  signed: boolean, signer, infName, deviceId, ageDays: number|null,
  status: "ok"|"unsigned"|"problem" /* [BREAKING] */, problemCode: number|null /* [NEW] */, isInbox: boolean /* [NEW] */ }
  category ∈ "Display"|"Chipset"|"Network"|"Audio"|"Storage"|"USB"|"Bluetooth"|"Firmware"|"Input"|"System"|"Other"
Volume { letter /* "C:" */, label, fileSystem, totalBytes, freeBytes, usedBytes, driveType, isSystem }
PhysicalDisk { deviceId /* disk number as string */, model, mediaType, busType, sizeBytes, healthStatus, operationalStatus, serial,
  volumes: string[] /* [NEW] */, isSystemDisk: boolean /* [NEW] */ }
TrashCategory { id, label, description, bytes, files, enabled, optional, requiresAdmin,
  available: boolean /* [NEW] */, unavailableReason: "needsAdmin"|null /* [NEW] */, note: string|null /* [NEW] */ }
TrashScan { categories, totalBytes /* available categories only */, durationMs, isAdmin /* [NEW] */ }
PurgeCategoryResult { id, label, freedBytes, deleted, skipped, note: string|null /* [NEW] */ }
PurgeResult { freedBytes, filesDeleted, filesSkipped, durationMs, perCategory, logPath: string /* [NEW] */ }
  // [BREAKING] standbyFlushed, standbyMessage removed
DriverBackupResult { path, success, output }
AgentStatus { running, isAdmin, message, lastPacketTs, sensorDriver, limitedReasons, missingFeatures, protocol }  // §2.3
FanFailsafeState { active, kind, severity, fansAt100, message, sinceTs, dismissible }                          // §2.4
SelfUsage { ts, cpuPct, workingSetMb, processCount }                                                          // §2.5
SystemSpec { capturedTs, cpu, board, memory, gpus, os, security, errors }                                     // §2.6
```

### 2.2 Settings [CHANGED]

| Field | Type | Default | Rust sanitization on load and save |
|---|---|---|---|
| `launchOnStartup` | bool | `false` | |
| `minimizeToTray` | bool | `true` | |
| `pollIntervalMs` | number | `1000` | clamp 250..10000 |
| `includeBrowserCaches` | bool | `false` | |
| `confirmBeforePurge` | bool | `true` | |
| ~~`flushStandbyOnPurge`~~ | | | **[BREAKING]** removed; ignored if present in an old file |
| `tempUnit` | `"C"\|"F"` | `"C"` | |
| `startMinimized` | bool | `false` | |
| `sensorLabels` | `Record<string,string>` | `{}` | **[NEW]** trim; drop empty; max 64 chars; max 2000 entries |
| `sensorLabelMeta` | `Record<string,{defaultName,hardwareName}>` | `{}` | **[NEW]** drop entries whose key has no label |
| `hiddenSensors` | `string[]` | `[]` | **[NEW]** dedupe; max 2000 |
| `pinnedSensors` | `string[] \| null` | `null` | **[NEW]** null = default-pin rule (§4.5); dedupe; max 12 |
| `hideUnusedSensors` | bool | `true` | **[NEW]** |
| `dismissedAlerts` | `string[]` | `[]` | **[NEW]** dedupe; keep last 200 |
| `sensorDriverChoice` | `"undecided"\|"pawnio"\|"none"` | `"undecided"` | **[NEW]** unknown value → `"undecided"` |

Rust uses `#[serde(default)]` per field and no `deny_unknown_fields`, so 0.x settings files load. Labels are a UI overlay keyed by LHM sensor id; Nexum never writes `ISensor.Name`.

### 2.3 AgentStatus and degraded mode [CHANGED, MF-2]

```ts
AgentStatus { running: boolean, isAdmin: boolean, message: string, lastPacketTs: number|null,
  sensorDriver: SensorDriverStatus|null, limitedReasons: LimitedReason[], missingFeatures: string[], protocol: number|null }
```

Rust sets these from each `hello`; while the agent is down: `sensorDriver:null`, `limitedReasons:[]`, `missingFeatures:[]` (offline is reported by `running:false`, not as limited mode).
- `limitedReasons` (this order): `"notElevated"` if `!isAdmin`; then `"pawnIoMissing"` if `sensorDriver.reason == "missing"`, else `"pawnIoOutdated"` if `sensorDriver.reason == "outdated"`.
- `missingFeatures` — fixed strings, in this order, deduplicated:
  - if `notElevated`: `CPU temperature, power and clock`, `Motherboard temperatures, voltages and fans`, `Fan control`, `Drive S.M.A.R.T. health`, `Memory module details`, `Windows Update cache, error report and crash dump cleanup`
  - else if `pawnIoMissing` or `pawnIoOutdated`: `CPU temperature, power and clock`, `Motherboard temperatures, voltages and fans`, `Fan control`, `Memory module details`
- If `hello.protocol != 2`, Rust logs a warning and sets `message` to `Hardware agent version mismatch (protocol <n>)`.

### 2.4 Fan fail-safe watchdog and banner [NEW, MF-13]

Rust holds one `FanFailsafeState` (initially inactive), emits `fan-failsafe` on every change and returns it from `get_fan_failsafe_state` (the UI calls it on mount, then listens).

| kind | severity | Set when | fansAt100 | message (exact) | dismissible |
|---|---|---|---|---|---|
| `interrupted` | `crit` | a `hello` with `fanFlag:"interrupted"`, or a telemetry packet with `fanSafety.failsafe:true` | `true` if the agent is elevated, else `false` | `Fan control was interrupted. Fans are at 100% for safety. Restart the PC to return them to BIOS control.` | no |
| `agentLost` | `crit` | agent exits abnormally (not `shutting_down`/`expected_exit`) **and** the flag file exists; or at app start the flag exists and no `hello` has arrived yet | `false` | `Fan control was interrupted and the hardware agent is not running. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.` | no |
| `previousBoot` | `warn` | a `hello` with `fanFlag:"previousBoot"` | `false` | `Nexum's fan control was interrupted before the last restart. If the fans behave unusually, shut down fully and power the PC on again.` | yes (`dismiss_fan_failsafe`) |

Transitions: `agentLost` → `interrupted` when the restarted agent says so; any kind other than `previousBoot` stays active until the app exits (it describes hardware state that only a reboot clears). A `hello` with `fanFlag:"none"` clears only an `agentLost` that was set provisionally at app start.

**Watchdog behaviour (Rust, `agent.rs`):**
1. On abnormal exit, check `%ProgramData%\Nexum\fan-manual.flag` (read-only). If present: set `agentLost`, and restart the agent **immediately** (no back-off delay) for that first restart; the new agent finds the same-boot flag and enters failsafe itself (§1.5.4), which moves the state to `interrupted` with `fansAt100:true`. Later restarts follow the normal back-off/limit.
2. **Hang detection [NEW]:** if the agent is running and no stdout line arrives for `max(15000 ms, 3 × effective interval)`, Rust kills it and treats it as an abnormal exit.
3. At app start Rust reads the flag before starting the agent; if present, set `agentLost` provisionally (the banner shows immediately; the `hello` then settles it).
4. Rust never deletes or writes the flag.

### 2.5 Self-usage [NEW]

Rust emits `self-usage` every 5 s while the window is visible (first event 5 s after start): `{ ts, cpuPct, workingSetMb, processCount }`.
- Process set: `Nexum.exe` (own pid), the `nexum-agent` child, and every `msedgewebview2.exe` whose parent chain leads to Nexum's pid (Toolhelp32 snapshot each sample).
- `cpuPct` = Σ Δ(kernel+user CPU time) ÷ (Δwall × logical processor count) × 100, 1 decimal (0–100 for the whole machine).
- `workingSetMb` = Σ `WorkingSetSize` ÷ 1,048,576, rounded to an integer. `processCount` = size of the set.
- Status-bar copy (C): `Nexum 0.6% CPU · 142 MB`; `—` until the first event.

### 2.6 `get_system_spec` merge [NEW]

`SystemSpec = { capturedTs, cpu, board, memory, gpus, os, security, errors }`.
- Rust sends `{cmd:"spec"}` (one request in flight, serialized by a mutex), waits ≤ 15 s for the `spec` line and caches the merged result until `refresh:true` or an agent restart (F5 in the System view passes `refresh:true`).
- If the agent is down or times out: `cpu:null, board:null, memory:null, gpus:[]` and `errors` gets `Hardware agent is not running` / `Hardware agent did not answer`.
- Rust owns: `os = { caption, displayVersion, build, architecture, installDate, bootTs }` and `security = { secureBoot, tpm, biosMode }`, from the same functions as `get_system_info` (`bootTs` = `Win32_OperatingSystem.LastBootUpTime` as unix ms). `errors` = agent errors + Rust section errors.
- `SystemInfo` keeps its fields for existing consumers; the System view uses only `SystemSpec`; "BIOS & OS" leaves the Drivers view.

### 2.7 Driver status [BREAKING, MF-5]

- Join `Win32_PnPSignedDriver` rows with `Win32_PnPEntity` by `PNPDeviceID` → `ConfigManagerErrorCode` (`code`).
- `problemCode` = `code` when `code ≠ 0`, else `null`.
- `status` = `"problem"` if `code ∉ {0, 22, 45}` (22 = disabled by the user, 45 = not connected; both are shown neutrally from `problemCode`); else `"unsigned"` if `!signed`; else `"ok"`.
- `isInbox` = `infName` does not match `/^oem\d+\.inf$/i`.
- `ageDays` stays, as neutral information only; `OUTDATED_DAYS` and the "outdated" status are deleted.

### 2.8 Physical disk volumes [NEW, MF-1]

- `volumes`: drive letters from `MSFT_Partition` (namespace `root\Microsoft\Windows\Storage`) grouped by `DiskNumber`, formatted `"C:"`, sorted, deduplicated; partitions without a letter are skipped.
- `isSystemDisk`: `volumes` contains `%SystemDrive%` (uppercase compare).
- Drive health always comes from the telemetry disk joined by the §1.1.3 join rule. `healthStatus` (Windows) is display-only information.

---

## 3. Cache cleanup safety rules (Rust `cleaner.rs`) — NON-NEGOTIABLE

UI name: "Cache cleanup" / "Reclaimable caches". Internal identifiers (`scan_trash`, `purge_trash`, `TrashCategory`) keep their names; they are not UI copy.

1. Allow-list: only delete *inside* the enumerated category roots (§3.1). Never delete the root itself.
2. Deny-list (checked after canonicalization, case-insensitive): `%WINDIR%\System32`, `%WINDIR%\SysWOW64`, `%WINDIR%\WinSxS`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%WINDIR%\System32\config`, user Documents/Desktop/Pictures/Videos/Music/Downloads/OneDrive, any file named `NTUSER.DAT*`, `UsrClass.dat*`, `*.regtrans-ms`, `*.blf`, and the drive roots themselves. **[NEW]** Also `%ProgramData%\Nexum` and the agent's install folder.
3. Never follow reparse points (symlinks/junctions/mount points): use `symlink_metadata`; if `FILE_ATTRIBUTE_REPARSE_POINT` is set, skip (do not descend; do not delete target).
4. Every delete is individually error-handled; locked/in-use/permission-denied files increment `skipped`.
5. Dry-run (`scan_trash`) and purge use the SAME enumerator and the SAME skip checks (rules 8–10), so reported numbers match.
6. Browser category never touches `Cookies`, `Login Data`, `Web Data`, `History`, `Local Storage`, `IndexedDB`, `Session Storage`, `*.sqlite` outside cache2.
7. **[BREAKING, rewritten]** Crash dumps: keep the newest 5 and anything < 30 days old; no Prefetch. (`dumps`: a `*.dmp`/`*.mdmp`/`*.hdmp` file is deleted only if it is older than 30 days **and** not among the 5 newest by mtime in its folder. `memory-dump` is the single explicit `MEMORY.DMP` opt-in and has no age guard.) `%WINDIR%\Prefetch` is never touched.
8. **[NEW] Running apps:** a browser's/Discord's cache roots are skipped while that app runs (any process of the current user named `chrome.exe`, `msedge.exe`, `firefox.exe`, `Discord.exe` respectively; `msedgewebview2.exe` does not count). Reported through `note`.
9. **[NEW] Windows Update:** `SoftwareDistribution\Download` is skipped entirely while an update is pending or installing: registry key `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired` exists, or `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending` exists, or service `TrustedInstaller` is running. Nexum never stops or starts services. The 24 h age guard stays.
10. **[NEW] Delivery Optimization** is cleared only through Microsoft's cmdlet: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "Delete-DeliveryOptimizationCache -Force"` (no `-IncludePinnedFiles`), `CREATE_NO_WINDOW`, 120 s timeout. Scan bytes = read-only size of `%WINDIR%\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`; freed = size before − size after. If the cmdlet is missing or fails, report it in `note`; **never** fall back to deleting those files directly.
11. **[NEW] Audit log:** every purge writes `%LOCALAPPDATA%\Nexum\purge-logs\<YYYYMMDD-HHMMSS>.jsonl` (folder created if needed). If the log cannot be created the purge is aborted with `Err("Could not create the cleanup log: …")`. Line 1 `{"type":"header","version":"<app version>","startedTs":…,"isAdmin":…,"categories":[…]}`; one line per file `{"type":"file","categoryId":"temp","path":"…","bytes":123,"mtime":<unix ms>,"result":"deleted"|"skipped"|"failed","reason":null|"locked"|"accessDenied"|"reparsePoint"|"tooNew"|"keptNewest"|"appRunning"|"updatePending"|"denyList"|"<os error text>"}`; one line per cmdlet/bulk action `{"type":"action","categoryId":…,"action":"Delete-DeliveryOptimizationCache"|"SHEmptyRecycleBinW","result":…,"freedBytes":…,"message":…}`; last line `{"type":"summary",…PurgeResult without logPath}`. `PurgeResult.logPath` is the absolute path; "View log" opens its folder through `open_external`.
12. **[NEW] Availability:** without admin rights, admin-only categories get `available:false`, `unavailableReason:"needsAdmin"`, `enabled:false`; their `bytes`/`files` are a best-effort read-only estimate (0 if unreadable). `TrashScan.totalBytes` counts available categories only. `purge_trash` given an unavailable id skips it with `note:"Needs administrator rights."` (not an error); an unknown id → `Err`.

### 3.1 Categories, defaults and roots [BREAKING]

| id | label (exact) | default `enabled` | `requiresAdmin` | `optional` | Roots |
|---|---|---|---|---|---|
| `temp` | `Temporary files` | ON | no | no | `%TEMP%` (user, GetTempPath2/env); `%WINDIR%\Temp` only when elevated. 24 h age guard |
| `wu-cache` | `Windows Update cache` | ON | yes | no | `%WINDIR%\SoftwareDistribution\Download` (24 h guard; rule 9) + Delivery Optimization via rule 10 |
| `logs` | `Error reports and old logs` | ON | yes | no | `%PROGRAMDATA%\Microsoft\Windows\WER\ReportArchive`, `…\WER\ReportQueue`, `%LOCALAPPDATA%\Microsoft\Windows\WER\ReportArchive`, `…\WER\ReportQueue`; `%WINDIR%\Logs\CBS\*.log` older than 30 days except `CBS.log`. **No Prefetch, no dumps.** |
| `dumps` | `Old crash dumps` | **OFF** | yes | yes | `%WINDIR%\Minidump`, `%LOCALAPPDATA%\CrashDumps`; rule 7 |
| `memory-dump` | `Full memory dump (MEMORY.DMP)` | **OFF** | yes | yes | `%WINDIR%\MEMORY.DMP` (single file); description includes its date and size |
| `shader` | `Shader caches` | **OFF** | no | yes | `%LOCALAPPDATA%\D3DSCache` always; plus only the detected GPU vendors' folders (vendor from `Win32_VideoController` PNPDeviceID `VEN_10DE`/`VEN_1002`/`VEN_8086`): NVIDIA `%LOCALAPPDATA%\NVIDIA\DXCache`, `%LOCALAPPDATA%\NVIDIA\GLCache`, `%PROGRAMDATA%\NVIDIA Corporation\NV_Cache`; AMD `%LOCALAPPDATA%\AMD\DxCache`, `…\AMD\DxcCache`, `…\AMD\VkCache`, `…\AMD\GLCache`; Intel `%LOCALAPPDATA%\Intel\ShaderCache` |
| `recycle` | `Recycle Bin` | **OFF** | no | yes | `SHQueryRecycleBinW(null)` for size/count; `SHEmptyRecycleBinW(NULL, NULL, SHERB_NOCONFIRMATION\|SHERB_NOPROGRESSUI\|SHERB_NOSOUND)` |
| `browser` | `Browser and Discord caches` | OFF | no | yes | Only listed when `includeBrowser`. Chrome & Edge `User Data\<profile>\{Cache\Cache_Data, Code Cache, GPUCache}` and `User Data\{ShaderCache, GrShaderCache}`; Firefox `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2`; Discord `%APPDATA%\discord\{Cache, Code Cache, GPUCache}`; rule 8 |
| ~~`standby`~~ | | | | | **[BREAKING]** removed (ROADMAP C5) |

Descriptions (exact for these; others are plain one-sentence descriptions with no banned words):
- `shader`: `Only clear if a game shows corrupted graphics. Expect stutter while caches rebuild.` followed by ` Folders: <comma-separated detected-vendor folder names>.`
- `dumps`: `Keeps the 5 newest dumps and anything less than 30 days old. Windows and support staff use dumps to diagnose crashes.`
- `memory-dump`: `Written by Windows after a system crash (<YYYY-MM-DD>, <size>). Delete it only if you do not need it for troubleshooting.`
- `recycle`: `Permanently deletes everything in the Recycle Bin.`

**Notes** (`TrashCategory.note` at scan time, `PurgeCategoryResult.note` at purge time; one sentence, null when nothing is skipped; exact templates):
- running apps: `Skipped: <App1> and <App2> are open.` / `Skipped: <App> is open.` (names `Chrome`, `Edge`, `Firefox`, `Discord`)
- update pending: `Skipped the Windows Update download cache: an update is waiting to install or restart.`
- DO cmdlet: `Delivery Optimization cache was not cleared: <reason>.`
- unavailable: `Needs administrator rights.`
- several notes in one category are joined with a space.

**Quick path:** with `confirmBeforePurge=false`, F9 runs exactly the ids in `DEFAULT_ON_CATEGORIES` (`temp`, `wu-cache`, `logs`) that are `available`; never `recycle`, `browser`, `dumps`, `memory-dump` or `shader`. The headline is `<available selected bytes> now · <unavailable bytes> more as administrator` (second part only when > 0).

---

## 4. Frontend contract, file ownership and shared modules

### 4.1 File ownership map (six implementers, disjoint files)

Nobody edits a file owned by someone else. If you need a change in another owner's file, code against the interface written here and note it in your report.

| Id | Owner of | Paths |
|---|---|---|
| **A** | Sidecar | `nexum-agent/**` (all `.cs`, `NexumAgent.csproj`, `app.manifest`). MF-1 classifier, MF-2 hello, MF-4 remove `flushStandby`/`MemoryFlush.cs`, MF-7, MF-8 item 1 (`IncludeNativeLibrariesForSelfExtract=false`), MF-9 CPU clock, MF-13 agent side, §1.3 sensor tree, §1.4 spec |
| **B** | Rust core | `src-tauri/**` except `src-tauri/icons/**` (includes `Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/**`). MF-1 volumes/isSystemDisk, MF-2 AgentStatus, MF-4 cleaner, MF-5 drivers, MF-8 item 2 (`signCommand`/bundle config), MF-13 watchdog, §2 new commands/events, tray, self-usage, spec merge |
| **C** | Frontend core | `src-frontend/types.ts`, `src-frontend/lib/**`, `src-frontend/hooks/**`, `src-frontend/App.tsx`, `src-frontend/main.tsx`, `src-frontend/styles/**`, `src-frontend/components/layout/**`, `src-frontend/components/ui/**`, `src-frontend/components/feedback/**`. Keymap, nav, header pill, limited-mode + fan-failsafe banners, first-run PawnIO screen, status bar self-usage, mock backend for every new command/event |
| **D** | New views | `src-frontend/views/SensorsView.tsx`, `src-frontend/views/SystemView.tsx`, `src-frontend/components/sensors/**` (incl. `SensorRow.tsx`), `src-frontend/components/system/**` |
| **E** | Existing views | `src-frontend/views/DashboardView.tsx`, `StorageView.tsx`, `DriversView.tsx`, `CoolingView.tsx` (**rename** from `FanControlView.tsx`; delete the old file), `CleanerView.tsx`; `src-frontend/components/telemetry/**`, `components/storage/**`, `components/drivers/**`, `components/fans/**`, `components/cleaner/**` |
| **F** | CI & docs | `.github/**`, `README.md`, `SECURITY.md` (new), `docs/**` except `docs/screenshots/**` and the gitignored `docs/target-hardware.md`, root `package.json` (version pins only) and `package-lock.json` |

`CONTRACT.md` is owned by the contract owner; implementers do not edit it. `LICENSE`, `src-tauri/icons/**`, `docs/screenshots/**`: nobody this round.

### 4.2 Work split by gate item

| Item | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| MF-1 drive health | classifier, disk fields | `volumes`, `isSystemDisk` | `lib/disks.ts`, `driveHealthView`, mock | – | Storage card/drawer, Dashboard banner + chips + KPI | – |
| MF-2 degraded mode | `hello.sensorDriver` | AgentStatus fields, `restart_as_admin` | `Unavailable`, limited banner, pill | use `Unavailable` | use `Unavailable`, hide null series | – |
| MF-3 PawnIO | version check | – | first-run screen | – | – | CI forbidden-driver check, DESIGN-SPEC fix |
| MF-4 cleaner | delete `flushStandby` | cleaner rules §3 | API/settings/TopBar button | – | Cleaner view + modal copy | – |
| MF-5 drivers | – | §2.7 | – | – | Drivers table, Gigabyte portal, "Nexum never installs drivers." | – |
| MF-6 status | – | – | `lib/status.ts` `deriveHealth`, header pill | – | Health alerts card, remove Thermal & Load Index | – |
| MF-7 history | ValuesTimeWindow | – | – | – | – | soak-test doc |
| MF-8 signing | csproj item 1 | bundle/sign config | – | – | – | CI Authenticode checks, SIGNING.md, hashes, cli pin |
| MF-9 labels | CPU clock source | – | `fmtBiosVendor`, `fmtBoardName` | – | labels/chart changes | – |
| MF-10 layout | – | – | `ScrollFade` | – | layouts | – |
| MF-11 no network | – | – | – | – | – | CI grep, SECURITY.md, README "never" list |
| MF-12 hygiene | – | – | mock generic names | – | – | docs |
| MF-13 fan fail-safe | §1.5 | §2.4 | failsafe banner | – | Cooling override banner, preset subtitle | – |
| Sensors / labels / pins | §1.3 | §2 commands | hooks, `lib/sensors.ts`, Settings | SensorsView | Pinned sensors, Cooling temps, fan labels | – |
| System lite | §1.4 | §2.6 | `useSystemSpec` | SystemView | remove BIOS & OS from Drivers | – |
| Self-usage | – | §2.5 | status bar | – | – | – |
| Keymap | – | tray | App, TopBar, footer | F2 rename handling | – | README |

### 4.3 `lib/api.ts` (C) — exact exports

```ts
export const isTauri: boolean;
export function errorMessage(err: unknown): string;
export const api = {
  getSystemInfo(): Promise<SystemInfo>,
  getDrivers(): Promise<DriverInfo[]>,
  getVolumes(): Promise<Volume[]>,
  getPhysicalDisks(): Promise<PhysicalDisk[]>,
  scanTrash(includeBrowser: boolean): Promise<TrashScan>,
  purgeTrash(categories: readonly TrashCategoryId[]): Promise<PurgeResult>,        // [BREAKING] no flushStandby
  exportDrivers(format: "json" | "csv"): Promise<string>,
  backupDrivers(): Promise<DriverBackupResult>,
  setPollInterval(ms: number): Promise<void>,
  setFanPreset(p: FanPreset): Promise<void>,
  setFanControl(id: string, pct: number): Promise<void>,
  // [BREAKING] flushStandby() removed
  getSettings(): Promise<Settings>,
  saveSettings(s: Settings): Promise<Settings>,
  getAgentStatus(): Promise<AgentStatus>,
  restartAgent(): Promise<void>,
  openExternal(target: string): Promise<void>,
  getSensorTree(): Promise<SensorTree | null>,                // [NEW]
  setSensorStream(on: boolean): Promise<void>,                // [NEW] (use useSensorStream instead)
  resetSensorStats(ids: string[] | null): Promise<void>,      // [NEW]
  getSystemSpec(refresh?: boolean): Promise<SystemSpec>,      // [NEW]
  getFanFailsafeState(): Promise<FanFailsafeState>,           // [NEW]
  dismissFanFailsafe(): Promise<FanFailsafeState>,            // [NEW]
  restartAsAdmin(): Promise<void>,                            // [NEW]
  openReliabilityMonitor(): Promise<void>,                    // [NEW]
  getAppVersion(): Promise<string>,
};
export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void>;
export function subscribe<T>(name: string, cb: (payload: T) => void): () => void;
```

When `!isTauri` every call and event is served by `lib/mock.ts`, including `sensor-tree`, `sensor-values` (only while the mock stream is on), `fan-failsafe`, `self-usage`. Mock URL params: `?rig=owner` (`WORKSTATION-02`, IT8688E with LHM B550 GAMING X labels, 3 live fans + 2 at 0 RPM, 44% NVMe system drive → `attention`/`Worn`), `?admin=0` (not elevated: CPU temp/power/clock null, no motherboard fans, SMART unknown, `limitedReasons:["notElevated"]`), `?pawnio=missing` (elevated, `pawnIoMissing`), `?failsafe=interrupted|agentLost|previousBoot`. Generic hostnames and fake serials only.

### 4.4 Hooks (C) — exact exports

- `hooks/useTelemetryStream.ts` — `useTelemetry(): { latest: TelemetryPacket|null, history: TelemetryPacket[] /* last 120 */, agent: AgentStatus|null }` (unchanged; `TelemetryProvider`).
- `hooks/useDriverScan.ts` — `useDriverScan(): { drivers, loading, error, lastScan: Date|null, rescan() }` (unchanged).
- `hooks/useSystemInfo.ts` — `useSystemInfo(): { info, volumes, disks, refresh() }` (unchanged).
- `hooks/useSettings.ts` — `useSettings(): { settings, update(partial: Partial<Settings>) }` (unchanged).
- **[NEW]** `hooks/useSensors.ts` — `SensorsProvider`; `useSensors(): { tree: SensorTree|null, values: SensorValues|null, tick: number /* increments per accepted values packet */, byId: ReadonlyMap<string, { meta: SensorMeta; hw: HardwareNode }>, statsOf(id: string): { value: number|null; min: number|null; max: number|null; avg: number|null } | null, historyOf(idx: number): readonly (number|null)[] /* last 60 s, oldest first */, reset(ids: string[] | null): Promise<void>, refreshTree(): Promise<void> }`; `useSensorStream(active: boolean): void` (ref-counted: the stream is on while ≥ 1 mounted caller passes `true`; call it from the Sensors view, from the Dashboard when it shows pinned sensors, and from Cooling). The provider applies the §1.3 rev rule.
- **[NEW]** `hooks/useSensorLabels.ts` — `useSensorLabels(): { labelOf(id: string, defaultName: string): string, setLabel(id: string, label: string /* "" restores default */, meta: SensorLabelMeta): void, pinned: string[] /* resolved: explicit list or default rule */, isPinned(id): boolean, togglePin(id): void, hidden: ReadonlySet<string>, toggleHidden(id): void, hideUnused: boolean, setHideUnused(on: boolean): void }`. Labels apply everywhere a sensor or fan name is shown (FanCard, FanList, Sensors, Pinned sensors, Cooling).
- **[NEW]** `hooks/useSystemSpec.ts` — `SystemSpecProvider`; `useSystemSpec(): { spec: SystemSpec|null, loading: boolean, error: string|null, refresh(): Promise<void> /* refresh:true */ }`.
- **[NEW]** `hooks/useFanFailsafe.ts` — `useFanFailsafe(): { state: FanFailsafeState, dismiss(): Promise<void> }` (calls `get_fan_failsafe_state` on mount, then `fan-failsafe`).
- **[NEW]** `hooks/useSelfUsage.ts` — `useSelfUsage(): SelfUsage | null`.
- **[NEW]** `hooks/useHealth.ts` — `useHealth(): SystemHealth` (memoized `deriveHealth` over telemetry, agent, volumes, physical disks, failsafe, settings, `now` ticking each second).

### 4.5 `lib/` helpers (C) — exact exports

- `lib/format.ts` (existing exports unchanged: `fmtBytes(n, digits=1)`, `fmtGb(n)`, `fmtPct(n)`, `fmtTemp(c, unit)`, `fmtRpm(n)`, `fmtUptime(secs)`, `fmtMhz(n)`, `clamp(n,a,b)`, `cn(...classes)`) **[NEW]**: `fmtBiosVendor(raw: string): string` — trim, strip a trailing `/,?\s*(Inc\.?|LLC|Ltd\.?|Co\.?,?\s*Ltd\.?)$/i`, then `American Megatrends*` → `AMI`; `fmtBoardName(manufacturer: string, product: string): string` — vendor alias (`Gigabyte Technology Co., Ltd.` → `Gigabyte`, `ASUSTeK COMPUTER INC.` → `ASUS`, `Micro-Star International Co., Ltd.` → `MSI`, `ASRock` stays) + `" " + product` (e.g. `Gigabyte B550 GAMING X`); `fmtSensorValue(v: number|null, meta: SensorMeta, tempUnit: "C"|"F"): string` (`—` for null; converts °C to °F when asked); `fmtCount(n: number): string` (en-US thousands separators); `maskSerial(s: string): string` (`••••` + last 4).
- `lib/disks.ts` **[NEW]** — `normSerial(s: string|null|undefined): string|null`; `joinDisks(physical: PhysicalDisk[], tele: DiskTelemetry[]): { disk: PhysicalDisk; tele: DiskTelemetry|null }[]` (§1.1.3 join rule); `systemDiskTelemetry(physical, tele): DiskTelemetry|null`.
- `lib/status.ts` **[NEW]** — one function per domain producing label **and** tone together (ROADMAP §6.1):
  - `driveHealthView(h: DriveHealth): { tone: StatusTone; label: string; icon: LucideIcon }` — good→ok/check, attention→warn/triangle, replace→crit/octagon, failing→crit/octagon, unknown→unknown/lock; label = `h.label`.
  - `sensorState(value: number|null, warnAt: number, critAt: number): StatusTone` — null→unknown.
  - `alertState(sev: HealthSeverity): StatusTone` — crit→crit, warn→warn, info→info.
  - `resolveUnavailable(agent: AgentStatus|null, need: FeatureNeed): UnavailableReason` — agent null or `!running` → `agentOffline`; `need=="none"` → `unsupported`; `notElevated` in `limitedReasons` → `notElevated`; `need=="pawnio"` and `pawnIoMissing` → `pawnIoMissing`; `need=="pawnio"` and `pawnIoOutdated` → `pawnIoOutdated`; else `unsupported`.
  - `FEATURE_NEEDS`: CPU temp/power/clock/voltage, motherboard sensors, fan RPM, fan control, SPD → `"pawnio"`; drive SMART/temperature, admin cleanup categories → `"admin"`; GPU sensors, CPU load, RAM, network → `"none"`.
  - `deriveHealth(input: { agent: AgentStatus|null; latest: TelemetryPacket|null; history: TelemetryPacket[]; volumes: Volume[]; physical: PhysicalDisk[]; failsafe: FanFailsafeState; pollIntervalMs: number; now: number }): SystemHealth` — rules in §5.
- `lib/sensors.ts` **[NEW]** — `SensorRule = { hwKinds: HardwareKind[]; kind: SensorKind; names: string[] /* exact, priority order */ }`; `findSensor(tree: SensorTree, rule: SensorRule): SensorMeta|null`; `DEFAULT_PIN_RULES`; `COOLING_TEMP_RULES`; `resolveDefaultPins(tree, physical: PhysicalDisk[], tele: DiskTelemetry[]): string[]`; `isUnused(meta: SensorMeta, max: number|null): boolean`; `rematchLabels(tree, settings): Partial<Settings> | null`.
  - **Default pins** (used while `settings.pinnedSensors === null`), in order, each only if found: (1) CPU temperature — hwKinds `["cpu"]`, names `["Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core (Tdie)", "Tctl/Tdie", "Package"]`; (2) GPU hot spot — first node of hwKinds `["gpuAmd","gpuNvidia","gpuIntel"]` (discrete first), names `["GPU Hot Spot"]`; (3) VRM — hwKinds `["superio"]`, names `["VRM MOS", "VRM"]`; (4) system-drive temperature — the HardwareNode whose `id` equals the `DiskTelemetry.id` joined to the `PhysicalDisk` with `isSystemDisk`, first sensor of kind `temperature`. The first user pin/unpin writes the resolved list plus the change to `pinnedSensors`.
  - **Cooling temperatures** (`COOLING_TEMP_RULES`): CPU (as pin 1), superio `["VRM MOS"]`, `["Chipset"]`, `["System #1"]`, `["System #2"]`, GPU `["GPU Hot Spot"]`; missing ones are omitted.
  - **Unused rule:** `isUnused = meta.defaultHidden || ((meta.kind === "fan" || meta.kind === "voltage") && (max === null || max === 0))`. Applied when `hideUnusedSensors` is true; user-hidden ids are always hidden.
  - **Label re-match:** when a tree loads, for each labelled id absent from the tree, if exactly one sensor in the tree has `name === meta.defaultName`, its node `name === meta.hardwareName`, and no label of its own, move the label and meta to that id (one `settings.update`).
- `lib/nav.ts` **[NEW]** — `requestNavigate(target: NavTarget | NavRequest): void` (dispatches `nexum:navigate`). All in-app "View …" links use it.

### 4.6 Keymap, views and navigation [BREAKING, C2 / §6.5]

- `ViewId = "dashboard" | "sensors" | "system" | "storage" | "cooling" | "drivers" | "cleaner"` (`"fans"` → `"cooling"`; `"gaming"` comes in v1.1).
- Function keys (`FKEY_MAP` in `types.ts`): **F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F9 Clean caches**. F8 is reserved (v1.1 Gaming) and unbound; F10 is never bound. `Ctrl+1..7` → `VIEW_ORDER[n−1]` (Dashboard, Sensors, System, Storage, Cooling, Drivers, Cleaner).
- Global handler rules (C, `App.tsx`): `preventDefault` on every F-key above and on F5/Ctrl+F5/Shift+F5/Ctrl+R in production (never reload the WebView); F7 is always `preventDefault`ed (caret browsing); keys are ignored while focus is in `input`, `textarea` or `[contenteditable]` (except Esc); F1–F9 are ignored while a modal is open; **when `view === "sensors"` the global F2 is a no-op** and the Sensors view handles F2 as "rename selected row"; Esc closes modals.
- F5 = Rescan: `useSystemInfo().refresh()`, `useDriverScan().rescan()` when on Drivers, `useSystemSpec().refresh()` when on System, cleaner rescan when on Cleaner.
- F9 / top-bar **"Clean caches (F9)"** (ghost button, not gold): opens `<OneClickPurgeModal open onClose autoStart />` with `autoStart = (opened by F9) && !settings.confirmBeforePurge`. The tray's `quick-clean` always opens with `autoStart=false`. `cleaner` is both a page (CleanerView) and this modal.
- Views (`src-frontend/views/`, default export, no props): `DashboardView`, `SensorsView`, `SystemView`, `StorageView`, `CoolingView`, `DriversView`, `CleanerView`. Tab labels: `VIEW_LABELS`.
- `components/layout/TopBar.tsx` (C) props: `{ view: ViewId; onNavigate(v: ViewId): void; onCleanCaches(): void; onRefresh(): void; onSettings(): void; refreshing?: boolean }`. Footer key hints list the keymap above.
- `navigate` event values: `NavTarget` (§2). DOM event `nexum:navigate` detail: `NavTarget | NavRequest`; `NavRequest.focus` examples: `{view:"storage", focus: DiskTelemetry.id}`, `{view:"sensors", focus: sensorId}`.

### 4.7 Shared UI primitives (`components/ui/`, C) — exact props

Existing (unchanged unless noted): `GlassCard({title?, icon?, actions?, accent?: "teal"|"gold"|"purple"|"rose"|"cyan"|"silver", className?, bodyClassName?, children})` (accent is decoration only, never state); `DottedLeaderRow({label, value, valueClassName?})`; `SegmentedBar({value, segments=24, tone?})`; `DotMatrix({values, rows=6, tone?})`; `Sparkline({data: (number|null)[], color, height=32})` **[CHANGED]**: renders nothing when every point is null; `TrendArrow({delta})`; `Toggle({checked, onChange, label?})`; `Button({variant:"gold"|"ghost"|"teal"|"danger", size?, icon?, iconRight?, loading?, ...})`; `EChart({option, className?, style?})`; `Modal`; `Segmented`.

- `StatusPill({ tone, children, icon?, pulse?, title?, className? })` **[CHANGED]** — `tone: StatusTone = "ok"|"warn"|"crit"|"info"|"unknown"`, colours from the §4.9 status tokens only; renders a default icon per tone (ok `CheckCircle2`, warn `AlertTriangle`, crit `OctagonAlert`, unknown `Lock`, info `Info`) unless `icon` is given. State is never colour alone.
- **[NEW]** `Unavailable({ reason: UnavailableReason, compact?: boolean, className?: string })` — em dash + `Lock` icon + cause; `compact` shows only the em dash and the lock icon, with the cause as `title`/`aria-label`. Cause text (exact): notElevated `Needs administrator`, pawnIoMissing `Needs PawnIO driver`, pawnIoOutdated `PawnIO update needed`, unsupported `Not reported by this hardware`, agentOffline `Hardware agent offline`. Use in place of any null value.
- **[NEW]** `HealthBanner({ alert: HealthCondition, onAction?: () => void, onDismiss?: () => void })` — full-width bar; warn = amber, crit = rose, info = cyan; shows `alert.title` + `alert.detail`; action button text = `alert.action.label`; dismiss button text `Dismiss` (shown only when `onDismiss`).
- **[NEW]** `StatCells({ value, min, max, avg, meta, tempUnit, className? })` — `value|min|max|avg: number|null`, `meta: Pick<SensorMeta,"unit"|"decimals"|"kind">`, `tempUnit: "C"|"F"`; four right-aligned tabular-number cells via `fmtSensorValue`; null → `—`.
- **[NEW]** `ScrollFade({ children, className?, maxHeight?: number|string })` — overflow-y auto, thin visible scrollbar, bottom fade mask only while not scrolled to the end.
- `SensorRow` (ROADMAP §6.2) lives in **`components/sensors/SensorRow.tsx` (D)** because only the Sensors view uses it: fixed row height, inline rename input (Enter saves, Esc cancels, empty restores the default name), row actions Rename / Hide / Pin / Copy value — all with text labels or `title`+`aria-label`.
- `tones.ts` **[NEW exports]**: `STATUS_HEX: Record<StatusTone, string>`, `SERIES_HEX: { cpu, gpu, ram, vram, disk, net }` (GPU = gold). `toneForLevel` stays for series accents only; state uses `sensorState`.

Purge flow: `components/cleaner/OneClickPurgeModal.tsx` (E) — `<OneClickPurgeModal open onClose autoStart? />` (props unchanged): scan → "Reclaimable caches" headline (§3.1 quick path text) → per-category toggles (unavailable ones disabled with `Needs administrator`) → live progress via `purge-progress` → `CleanupSummary` "Freed 6.4 GB in 2.3 s" + per-category notes + "View log" (opens the folder of `logPath`) + "Open Reliability Monitor" link next to `dumps`.

### 4.8 Copy rules (ROADMAP §6.6) — all UI text

- **Banned** in user-visible strings (case-insensitive, whole word): `boost`, `optimize`/`optimise`, `speed up`, `free RAM`, `junk`, `trash`, `purge` (as a button/CTA or heading), `deep purge`, `outdated`. `Optimal` only as the rule-backed pill label from `lib/status.ts`. Identifiers in code are exempt.
- "Trash"/"junk" → "Reclaimable caches"; "Deep Purge" → "Cache cleanup"; top-bar button `Clean caches (F9)`. "Freed" is used only for disk bytes.
- Every status claim (pill, chip, badge) has a hover showing the rule that produced it.
- Units: one unit per list (GB, or MB below 1 GB); buttons repeat the headline number exactly.
- Buttons and icon-only controls carry text labels or `title` + `aria-label`.
- Labels (MF-9): `Per-core load (8C/16T)`; CPU fan KPI `CPU fan` (fan whose `name` matches `/^CPU Fan$/i`, else first fan whose `hwId` is not a GPU and name contains `CPU` but not `Opt`; else `<Unavailable>` — never another fan, never an average); GPU `Edge temp` + `Zero-RPM idle` badge when `fanRpm === 0 && (fanPct ?? 0) === 0`; memory `2 of 4 DIMMs`; uptime shown once per view from `bootTs`.
- Preset subtitle: `Fixed speed, ignores temperature` (Cooling, under Silent/Balanced/Turbo/Custom). Drivers footer: `Nexum never installs drivers.`

### 4.9 Theme tokens (Tailwind v4 `@theme` in `styles/nexum.css`, C)

Existing: `--color-canvas-0:#070B0E; --color-canvas-1:#0D1B1E; --color-card: rgba(16,26,30,0.72); --color-line: rgba(255,255,255,0.08); --color-teal:#2DD4BF; --color-gold:#D4A359; --color-purple:#9333EA; --color-rose:#E11D48; --color-cyan:#22D3EE; --color-silver:#CBD5E1; --color-ink:#F8FAFC; --color-muted:#64748B;`

**[NEW] semantic status tokens (ROADMAP §6.1), separate from series colours:**
```
--color-ok:      #2DD4BF;   /* = teal */
--color-warn:    #F59E0B;   /* amber, distinct from brand gold #D4A359 */
--color-crit:    #E11D48;   /* = rose */
--color-unknown: #64748B;   /* = muted; "unavailable" and "health unknown" */
```
- `StatusPill`, `HealthBanner`, health chips and drive-health colours use only these (info uses cyan).
- **Gold** is reserved for brand accents and the GPU data series; never for state. Rose is never used for driver age.
- One function per domain produces label and tone together (`driveHealthView`, `sensorState`, `alertState`).
- Charts (E): live telemetry is **unstacked** lines on a labelled 0–100% y-axis; series with no data are hidden (also from the legend).
- Layout: grids use `min(n, 4)` columns or `auto-fit, minmax()`; at 1280–1439 px shorter KPI sub-labels, Drivers drops Category and INF, dates never wrap; long actions in a sticky footer.

Fonts: "Inter" for UI, "JetBrains Mono" for numeric readouts (bundled via @fontsource, no network fonts).

### 4.10 View requirements (D, E) — from ROADMAP MF-1/2/5/9/10, §3, §6.5

- **Dashboard (E):** KPI strip (CPU, GPU, VRAM, RAM, `CPU fan`); live chart (unstacked, 0–100%, null series hidden); Health alerts card (§5.4); Pinned sensors card (`useSensorLabels().pinned` + `useSensors().statsOf`, `useSensorStream(true)` while shown; Unpin action); Storage with a `Life NN%` chip per drive (tone from `driveHealthView`) and KPI `N of M drives need attention` (replaces "Hottest drive"); 3-line System summary (`fmtBoardName`, CPU, uptime from `bootTs`) with a `System →` link. Remove `HardwareSnapshotGrid`, `ThermalLoadCard` ("Thermal & Load Index") and `DriverStatusList`. Columns that scroll use `ScrollFade`.
- **Storage (E):** health chip/label from `DiskTelemetry.health` only (never `healthPct` colour, never Windows `healthStatus` as the state); `on <model> (Life NN%)` under each volume via `PhysicalDisk.volumes`; per-drive S.M.A.R.T. details drawer: spare vs threshold, % used, media errors, unsafe shutdowns, power cycles, error-log entries, warning/critical temperature thresholds and minutes, ATA 05/C5/C6, data read/written, temperature now/min/max (`StatCells`); `NavRequest.focus` = `DiskTelemetry.id` opens that drawer.
- **Drivers (E):** status pills ok/unsigned/problem (problem shows `problemCode` text; codes 22 "Disabled" and 45 "Not connected" render neutral); age is a neutral grey column; problems sorted first; identical rows grouped (`Processor × 16`, same deviceName+version+provider); Category hidden below 1440 px; INF only in the detail panel; date column `nowrap`; Gigabyte added to `PORTALS`; `Nexum never installs drivers.`; the "Outdated" tile and the BIOS & OS panel are removed.
- **Cooling (E):** fans with user labels, RPM, `rpmMin`/`rpmMax`; headers with `rpmMax === 0` and no Nexum control hidden by default ("Show N unused headers" toggle); grid `min(n, 4)` columns; preset subtitle; an amber banner while `fanSafety.overrideActive && !failsafe` (`Fans are at 100% because <reason>.`); temperatures list from `COOLING_TEMP_RULES`; CPU/GPU/RAM panels removed. No GPU tuning tab in v1.0.
- **Cleaner (E):** copy per §4.8; unavailable categories disabled with `Needs administrator`; notes shown under each category; sticky `Ready to clean` footer with the headline number; summary with "View log".
- **Sensors (D):** hostname root → hardware nodes (tree order, collapsible) → kind groups in `SENSOR_KIND_ORDER`; columns Sensor | Value | Min | Max | Avg | 60 s sparkline (none for `static`); header `since HH:MM (elapsed)` from `sessionStartTs`; toolbar: search (matches label, default name, hardware name), `Reset all` / `Reset selected`, `Hide unused` toggle, `Expand all` / `Collapse all`, `Show hidden` toggle; row actions Rename (F2 / double-click), Hide, Pin, Copy value; hand-written fixed-height virtualization (~300 rows) with updates applied once per animation frame; values via `fmtSensorValue` honouring `tempUnit`; `useSensorStream(true)` while mounted; `<Unavailable>` empty state when the tree is null. No logging in v1.0.
- **System (D):** tabs CPU | Mainboard | Memory | SPD | Graphics | OS & Security, `DottedLeaderRow` throughout. CPU: name, codename, socket, family/model/stepping (hex, e.g. `19h / 21h / 2`), cores/threads, base clock, instruction list, cache table (Level / Type / Size × instances / Ways). Mainboard: `fmtBoardName`, version, BIOS (`fmtBiosVendor`, version, date), Super I/O (`<Unavailable>` when null). Memory: type, total, channels, `N of M DIMMs`, timings row `Not available in this version`. SPD: slot picker by `slot`; size, ranks, manufacturer, part number, rated and configured speed, voltage, form factor (SMBIOS data; no XMP). Graphics: per GPU name, vendor, VRAM, driver version/date. OS & Security: caption, display version, build, architecture, install date, uptime (from `bootTs`), Secure Boot, TPM, BIOS mode. `Copy as text` (plain text of all tabs). `errors` shown as a quiet note.

---

## 5. Health status derivation (frontend, MF-6)

Implemented once in `lib/status.ts` `deriveHealth` (C). Consumed by the header pill (C), the Health alerts card and the Dashboard banners (E). v1.1 moves evaluation to Rust; until then these rules are the spec.

### 5.1 Inputs and helpers

- `offline` = `!agent || !agent.running || latest == null || now − agent.lastPacketTs > max(5000, 3 × pollIntervalMs)`.
- `sustained(series, threshold)` = the samples from `history` with `ts ≥ now − 10000` number ≥ 3, are all non-null, and their **minimum** ≥ `threshold`.
- `T` thresholds: `HEALTH_THRESHOLDS` in `types.ts`.

### 5.2 Rules (evaluated in this order; the order is also the display order within a severity)

| # | id | severity | Condition | short (n=1 group text) | title / detail | action |
|---|---|---|---|---|---|---|
| 1 | `fan-failsafe` | crit (warn if `kind=="previousBoot"`) | `failsafe.active` | `Fan fail-safe` | `Fan control interrupted` / `failsafe.message` | – |
| 2 | `agent-offline` | warn | `offline` | `Agent offline` | `Hardware agent offline` / `Sensor values are not updating. Use Restart agent in Settings.` | – |
| 3 | `fan-override` | warn | `!offline && latest.fanSafety.overrideActive && !latest.fanSafety.failsafe` | `Fans at 100%` | `Fans held at 100%` / by reason: `CPU reached 85 °C.` · `GPU temperature limit reached.` · `A temperature sensor stopped reporting.` | `View cooling` → `{view:"cooling"}` |
| 4 | `drive:<tele.id>` | failing/replace → crit; attention → warn | each telemetry disk with that `health.state` (skipped when `offline`) | by label: Failing `1 drive failing` · Replace soon `1 drive: replace soon` · Worn `1 drive worn` · Check sectors `1 drive: check sectors` · Overheating `1 drive overheating` · Windows warning `1 drive: Windows warning` | `<name>` — `<health.label>` / sentence below; `<name>` = `<volumes joined ", "> (<model>)` when the joined PhysicalDisk has volumes, else `<model>` (`DiskTelemetry.name` when unjoined) | `View drive` → `{view:"storage", focus: tele.id}` |
| 5 | `cpu-temp` | crit if sustained ≥ 95, warn if sustained ≥ 90 | `cpu.packageTempC` | `CPU hot` | `CPU at <t> °C` / `Above <threshold> °C for 10 s.` | `View sensors` → `{view:"sensors"}` |
| 6 | `gpu-temp:<i>` | hotspot: crit ≥ 110, warn ≥ 100; edge (hotspot null): crit ≥ 95, warn ≥ 85 (sustained) | each `gpus[i]` | `GPU hot` | `<gpu name> at <t> °C` / same pattern | `View sensors` → `{view:"sensors"}` |
| 7 | `drive-temp:<tele.id>` | crit sustained ≥ `criticalTempC ?? 80`; warn sustained ≥ `warningTempC ?? 70` | each disk `tempC` | `Drive hot` | `<name> at <t> °C` / pattern | `View drive` → `{view:"storage", focus: tele.id}` |
| 8 | `space:<letter>` | crit if free < 5%, warn if free < 10% | each `Volume` with `driveType=="Fixed"` and `totalBytes > 0` | `Low disk space` | `<letter> has <fmtBytes(free)> free (<pct>%)` / `Below <10/5>% free.` | `View storage` → `{view:"storage"}` |
| 9 | `limited-mode` | info | `!offline && agent.limitedReasons.length > 0` | `Partial sensors` | `Partial sensors` / `Unavailable: ` + `missingFeatures.join(", ")` + `.` | `{label:"Restart as administrator", command:"restartAsAdmin"}` when `notElevated`, else `{label:"Get PawnIO", command:"getPawnIo"}` (opens `https://pawnio.eu/`) |
| 10 | `drive-unknown:<tele.id or deviceId>` | info | `!offline` and a joined disk's health is `unknown` (or a PhysicalDisk has no telemetry match) | `Drive health unknown` | `<volumes or model> — <label>` / `health.reason` | – |

Drive detail sentence (rule 4), exact: `<life>% life left (<percentageUsed>% of rated endurance used, <fmtCount(powerOnHours)> h). ` + by label: Worn/Replace soon → `Copy important files and plan a replacement.`; Failing → `Back up important files now and replace this drive.`; Check sectors → `Back up important files and run the drive maker's diagnostic.`; Overheating → `Improve airflow around the drive.`; Windows warning → `Back up important files and check the drive in Windows Settings › Storage.` Omit the parenthesis parts whose values are null.

Every condition's `rule` is the row's condition text in plain English (e.g. `Critical when a drive reports a critical warning, spare below threshold, read-only, or ≤ 10% life left`), and `dismissKey` = `<id>:<state or severity>`.

### 5.3 Level, label and summary

- `level` = `critical` if any crit; else `attention` if any warn; else `partial` if any info; else `optimal`. `label` = `Critical` / `Attention` / `Partial sensors` / `Optimal`.
- `summary`: take the conditions of the top severity; group by `group` (`drive:<health.label>`, `cpu-temp`, `gpu-temp`, `drive-temp`, `space`, otherwise the id). If exactly one group: its short text, with `1 drive` replaced by `<n> drives` when the group has n > 1 members (`2 drives worn`, `2 drives: check sectors`; non-drive groups keep their short text); otherwise `<total> alerts`. `optimal` → null.
- `HealthCondition.action` is a `HealthAction`: `{label, nav}` → `requestNavigate(nav)`; `{label, command:"restartAsAdmin"}` → `api.restartAsAdmin()`; `{label, command:"getPawnIo"}` → `api.openExternal("https://pawnio.eu/")`.
- Pill text = `label` + (summary ? ` · ` + summary : ""), e.g. `Attention · 1 drive worn`. Pill tone: critical→crit, attention→warn, partial→unknown, optimal→ok. Hover lists active conditions' titles, then `rules`.
- **Optimal** therefore requires: agent connected, no limited reasons, every drive `good`, no temperature or space condition, no fan safety condition.

### 5.4 Health alerts card and banners (E)

- Dashboard **Health alerts** card replaces the Thermal & Load Index card: lists `conditions` (crit, warn, then info) with tone icon, title, detail and action button; when empty, `No active alerts` followed by the `rules` list.
- Dashboard **banners**: one `HealthBanner` per drive condition (rule 4) with severity warn/crit whose `dismissKey` is not in `settings.dismissedAlerts`; Dismiss appends the key. A worse state produces a new key, so the banner returns. Dismissal never hides the pill or the card.
- App-level banners (C, above every view): fan fail-safe (`useFanFailsafe`, always first) and limited mode (rule 9 data; buttons `Restart as administrator` → `api.restartAsAdmin()`, `Get PawnIO` → `api.openExternal("https://pawnio.eu/")`; not shown when `sensorDriverChoice === "none"` and the only reasons are PawnIO ones — the pill still says Partial sensors).
- First-run PawnIO screen (C, MF-3): shown once when `sensorDriverChoice === "undecided"` and the agent reports `pawnIoMissing` or `pawnIoOutdated`. Explains that PawnIO is a vendor-signed kernel driver installed from the official site, needs ≥ 2.1.0, and that Nexum never installs or uninstalls it. Buttons: `Get PawnIO` (opens pawnio.eu, sets `"pawnio"`) and `Continue without kernel driver` (sets `"none"`).

---

## 6. Breaking-change checklist (1.0.0-gate)

| Change | Layers |
|---|---|
| `{cmd:"flushStandby"}`, `MemoryFlush.cs`, Tauri `flush_standby`, `purge_trash.flushStandby`, `Settings.flushStandbyOnPurge`, `PurgeResult.standbyFlushed/standbyMessage`, category `standby`, `api.flushStandby`, `api.purgeTrash(…, flushStandby)` removed | A, B, C, E |
| Category `logs` loses dumps and Prefetch; new `dumps`, `memory-dump`; defaults shader/recycle OFF | B, C (mock), E |
| `DriverInfo.status` `"outdated"` → removed; `"problem"` added; `problemCode`, `isInbox` | B, C (mock), E |
| `ViewId` `"fans"` → `"cooling"`; `"sensors"`, `"system"` added; F-key renumbering; tray ids | B, C, D, E, F (README) |
| `FanControlView.tsx` → `CoolingView.tsx` | E (C imports the new name) |
| `StatusTone` gains `"unknown"`; StatusPill colours move to status tokens | C, D, E |
| `TopBar` prop `onPurge` → `onCleanCaches` | C |
| Agent protocol 2: new `hello` fields, `telemetry.fanSafety`, new disk/fan fields | A, B, C (mock) |

Everything else in this document is additive.

---

## 7. CI and documentation requirements (F, with A/B where noted)

1. **MF-3 forbidden drivers:** fail if `WinRing0*.sys`, `inpout*.sys` or `OpenHardwareMonitorLib.sys` appears anywhere in the agent publish output or the Tauri bundle output.
2. **MF-8 signing:** `@tauri-apps/cli` pinned to `>=2.9.3` with the lockfile committed. A job runs `Get-AuthenticodeSignature` on every PE under the bundler's NSIS `Plugins/x86-unicode/` output and on every PE in the install image (including `uninstall.exe` and the loose .NET native DLLs after A sets `IncludeNativeLibrariesForSelfExtract=false`). While no signing certificate is configured (repository variable `NEXUM_SIGNING_ENABLED` unset), the job lists unsigned files as warnings and does not fail; with it set, anything not `Valid` fails. Release builds publish SHA-256 hashes. `docs/SIGNING.md` matches the real `bundle.targets`.
3. **MF-11 no network:** fail on any of `reqwest`, `ureq`, `hyper`, `HttpClient`, `WebClient`, `HttpWebRequest`, `TcpClient`, `TcpListener`, `HttpListener`, `WebSocket`, `XMLHttpRequest`, `fetch(` in `src-tauri/src/**`, `nexum-agent/**/*.cs`, `src-frontend/**` (excluding `node_modules`), unless the file:line is listed in `.github/network-allowlist.txt` (starts empty).
4. **Copy rules:** a check greps `src-frontend/**/*.tsx` string literals and JSX text for the §4.8 banned words and fails unless allow-listed in `.github/copy-allowlist.txt`.
5. **MF-7 soak test:** documented procedure (24 h, agent working set growth < 10 MB) in `docs/`; not a CI job.
6. **Docs:** `SECURITY.md` (reporting address placeholder, supported versions, privileged surface = elevated agent + stdio protocol, the "never" list: registry cleaning, driver downloads or installs, process injection, telemetry, bundled offers, auto-updaters that run downloaded installers, localhost web APIs); the same "never" list and the §4.6 keymap in `README.md`; `docs/DESIGN-SPEC.md` §6.3 says PawnIO, not WinRing0; a "Code signing policy" section per ROADMAP MF-8 item 6.

## 8. Known open items (not blocking implementation)

- §1.5.5 owner test (fan behaviour after `taskkill /F`, warm vs cold reboot).
- HDD spin-down test (ROADMAP §6.8): if SMART polling keeps a rotational drive awake, A refreshes rotational `StorageDevice` hardware every 600 s instead of every tick; the telemetry shape does not change.
- Minimized-idle CPU budget test (< 0.5% over 10 min, ROADMAP §6.8).
- `cpu.codename` coverage depends on the static table A ships.
