# Nexum — Internal Integration Contract

**Contract version: 1.1.0** (2026-11-27). Implements **v1.1** of [`docs/ROADMAP.md`](docs/ROADMAP.md) on top of the shipped 1.0.0-gate contract: the §3 "v1.1" table (except the kernel-driver/vendor security audit), §4 FPS architecture (§4.2 contract, §4.3 gates), the **read-only** parts of §5 tuning (§5.3 probe with `write:false` only), §6.3 frametime chart and §6.5 IA (F8 Gaming).

In scope (seven work items): (1) FPS capture + Gaming view, (2) CSV sensor logging, (3) Rust alert engine + desktop notifications + tray tooltip, (4) drive wear ledger + forecast, (5) System view full (live DDR4 timings, SPD JEDEC timings, FCLK/UCLK/MEMCLK, codename, GPU/NVMe link, Save report), (6) GPU tuning step 0 (read-only state + read-only probe), (7) cleaner extras (top-50 drill-down, Recycle Bin age filter).
**Not in scope:** kernel-driver/vendor security audit (blocked on ROADMAP Q13), overlay window, benchmarks, **any tuning write** (including the probe's `write:true` path, blocked on ROADMAP Q5), fan curves, split privilege, XMP parsing, tray-icon temperature digits.

Single source of truth for how the three layers talk. Every implementer follows it literally.
The TypeScript mirror is [`src-frontend/types.ts`](src-frontend/types.ts): it is authoritative for field names, unions and defaults. Where this file and `types.ts` disagree, `types.ts` wins for names/types and this file wins for behaviour; report the conflict to the contract owner.

Markers: **[NEW 1.1]** added in 1.1.0 · **[BREAKING 1.1]** removed, renamed or re-typed in 1.1.0 (no compatibility shim unless stated) · **[CHANGED 1.1]** same shape, new semantics in 1.1.0. Unsuffixed **[NEW]** / **[BREAKING]** / **[CHANGED]** markers are historical (1.0.0-gate) and describe shipped behaviour that still holds unless a 1.1 marker says otherwise. The full 1.1.0 breaking-change list is §6.1.

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
- **No new third-party dependencies** (npm, NuGet, crates), with exactly one exception **[NEW 1.1]**: the crate `tauri-plugin-notification` 2.x in `src-tauri/Cargo.toml` (B), used only from Rust (no JS package, no capability for the WebView). Allowed: new `windows` crate *features*. Virtualized lists are hand-written (fixed row height windowing). The ADL bindings are hand-written P/Invoke (§1.7), not a NuGet package.
- **No network code** anywhere (MF-11). The only outbound action is `open_external` handing an `https://` URL to the default browser. **[NEW 1.1]** PresentMon is a file shipped in the installer and spawned locally (§1.6); nothing is ever downloaded at runtime. CI may download the pinned PresentMon release at build time (§7).
- **[NEW 1.1] Anti-cheat stance** (strictest case; the owner has not named games): no injection, no hooks, no `OpenProcess`/`ReadProcessMemory`/handles on any process other than Nexum's own children, no window messages to other processes, no priority/affinity changes. Process names come from PresentMon output and Toolhelp32 snapshots; window titles from `EnumWindows` + `GetWindowTextW` only. Never touch game processes.
- **[NEW 1.1] Read-only tuning:** no code path in any layer may call an ADL function whose name contains the segment `_Set` (§1.7.1). CI enforces it (§7 item 9).
- **[NEW 1.1] Elevated writes to user folders** (Documents, `%LOCALAPPDATA%`) go only through Rust `safe_fs::PinnedDir` (open the chain without following links, `create_new_file`). The agent never writes files outside `%ProgramData%\Nexum` (its existing fan flag).
- **Privacy:** no real hostnames, serials or personal data in tracked files. Mock profiles use `WORKSTATION-01` / `WORKSTATION-02` and fake serials. Serials are masked (`••••` + last 4) in any export or "Copy as text".
- **Unavailable is not zero** (MF-2): a value the layer cannot read is `null`, never `0`, and no layer substitutes a different sensor (e.g. never a GPU fan for a motherboard fan).
- Rust is verified only in CI (Smart App Control blocks local `cargo`). Keep Rust changes conservative and covered by `#[cfg(test)]` unit tests where logic is pure.

---

## 1. Sidecar (nexum-agent) ⇄ Rust — NDJSON over stdio

The sidecar writes ONE JSON object per line to **stdout** (UTF-8, no BOM, camelCase, `\n` terminated, flush after every line). Never write anything else to stdout (logs → stderr). It reads ONE JSON command per line from **stdin**. Nullable members are always written (null is never omitted). Lines are emitted in causal order on a single writer (a `sensorTree` with a new `rev` is always written before any `sensorValues` with that `rev`).

### 1.1 Outgoing messages (sidecar → Rust)

```jsonc
{ "type": "hello", "version": "1.1.0", "protocol": 3, "isAdmin": true, "pid": 1234,   // [BREAKING 1.1] protocol 3
  "sensorDriver": SensorDriverStatus, "fanFlag": "none"|"interrupted"|"previousBoot" }   // [NEW fields]
{ "type": "telemetry", ...TelemetryPacket }            // every intervalMs (default 1000)
{ "type": "sensorTree", ...SensorTree }                // [NEW] §1.3
{ "type": "sensorValues", ...SensorValues }            // [NEW] §1.3, only while the stream is on
{ "type": "spec", ...AgentSpec }                       // [NEW] §1.4, reply to {"cmd":"spec"}
{ "type": "frameSession", ...FrameSession }            // [NEW 1.1] §1.6
{ "type": "frameTarget", ...FrameTarget }              // [NEW 1.1] §1.6
{ "type": "frameStats", ...FrameStats }                // [NEW 1.1] §1.6, 1 Hz while a target exists
{ "type": "presentingList", ...PresentingList }        // [NEW 1.1] §1.6, reply to {"cmd":"presentingList"}
{ "type": "tuningState", ...TuningState }              // [NEW 1.1] §1.7, reply to {"cmd":"tuningGet"}
{ "type": "tuningProbe", ...TuningProbeMessage }       // [NEW 1.1] §1.7, reply to {"cmd":"tuningProbe","write":false}
{ "type": "ack", "cmd": "fanPreset", "ok": true, "message": "Applied Balanced to 4 fans" }
{ "type": "error", "message": "..." }                  // non-fatal
```

`hello` is the first line, written after LHM `Open()` and before the first `telemetry`.

**[BREAKING 1.1] Protocol 3.** A 1.1.0 agent sends `"version":"1.1.0"` and `"protocol":3` (`AGENT_PROTOCOL` in `types.ts`). Rust's mismatch check (§2.3) compares against 3. No v1.0 message changes shape except the additive `GpuTelemetry.memJunctionTempC` (§1.1.1) and the §1.4 spec fields.

**[NEW 1.1] Agent command line.** Rust starts the agent as `nexum-agent [--presentmon "<absolute path>"]`. The path is the PresentMon exe resolved by Rust (§2.13). The flag is omitted when Rust cannot resolve the resource or the file does not exist. The agent never searches for PresentMon anywhere else (no PATH lookup, no current directory, no fallback path).

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
  "tempC": 38.0, "hotspotTempC": 45.0, "powerW": 18.0, "fanRpm": 0.0, "fanPct": 0.0,
  "memJunctionTempC": 62.0 }                 // [NEW 1.1]
```

- **[NEW 1.1]** `GpuTelemetry.memJunctionTempC`: first present temperature sensor of the GPU hardware named `"GPU Memory Junction"` (NVIDIA) or `"GPU Memory"` (AMD), else null. Owner A2 (`GpuMonitor.cs`). Input of the `gpu-mem-temp` alert (§2.10).

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
{ "cmd": "frames", "enabled": true }                   // [NEW 1.1] §1.6 start/stop frame capture; ack + frameSession
{ "cmd": "frameTarget", "pid": 18320 | null }          // [NEW 1.1] §1.6 manual target; null = automatic (foreground)
{ "cmd": "frameWindow", "sec": 30 }                    // [NEW 1.1] §1.6 stats window, integer, clamp 5..120
{ "cmd": "frameExclude", "names": ["obs64.exe"] }      // [NEW 1.1] §1.6 user excludes (replaces the previous list)
{ "cmd": "presentingList" }                            // [NEW 1.1] §1.6 reply {"type":"presentingList",...}
{ "cmd": "tuningGet" }                                 // [NEW 1.1] §1.7 reply {"type":"tuningState",...}
{ "cmd": "tuningProbe", "write": false }               // [NEW 1.1] §1.7 reply {"type":"tuningProbe",...}; write:true is rejected
{ "cmd": "shutdown" }                                  // restore default fan control (unless failsafe), then stop frame capture (≤ 2 s, §1.6.6), close Computer, exit 0
```

**[NEW 1.1] Ack rules for the new commands.** Every new command is answered with exactly one `ack` (`cmd` = the command name), except `presentingList`, `tuningGet` and `tuningProbe` with `write:false`, which are answered by their reply message (and an `ack ok:false` only when they cannot run at all, e.g. invalid arguments). A missing or wrongly typed argument → `ack ok:false`, message `Invalid command`. Commands that need hardware wait until `hello` (as today).

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
| `memory.timings/timingsSource/timingsNote` | **[CHANGED 1.1]** §1.4.1 |
| `memory.xmp` | `null` (XMP parsing is v1.3+) |
| `memory.memclkMhz/fclkMhz/uclkMhz` | **[NEW 1.1]** §1.4.1 |
| `memory.dimms[].spd` | **[NEW 1.1]** §1.4.1 |
| `gpus[]` | `Win32_VideoController` rows whose `PNPDeviceID` starts with `PCI\`: `Name`; vendor from `VEN_10DE`/`VEN_1002`/`VEN_8086`; `vramGb` from the matching LHM GPU "GPU Memory Total" sensor (MB → GB, 1 decimal), else null (never `AdapterRAM`, which caps at 4 GB); `DriverVersion`; `DriverDate` → `YYYY-MM-DD` or null |
| `gpus[].link` | **[NEW 1.1]** §1.4.1 |
| `diskLinks[]` | **[NEW 1.1]** §1.4.1 |

#### 1.4.1 System spec, full [NEW 1.1] (owner A2)

All of this is computed by A2 inside the existing `SystemSpec.CaptureLhm` / `SystemSpec.Build` path, so Program.cs needs no change for it. Every new field is nullable; a failure of one part never fails the section, it only nulls that part (and may add a line to `errors`, exact text `"<Part> query failed: <message>"`, parts `Memory timings`, `SPD`, `GPU link`, `Disk links`).

**Live DDR4 timings (`timingsSource:"umc"`).**
- Preconditions, all required: agent elevated; `hello.sensorDriver.ok`; CPU vendor AMD with display family `0x17` or `0x19` (Zen 1–3, AM4); `memory.type == "DDR4"`. Otherwise skip to the SPD fallback with the `timingsNote` from the table below.
- Read path: a **new** `LibreHardwareMonitor.PawnIo.AmdFamily17()` instance (public parameterless constructor, public `uint ReadSmn(uint offset)`, `Close()`), created for this read and closed right after. Never reflect into LHM's private `_pawnModule`.
- **Mutual exclusion (mandatory):** every `ReadSmn` call happens while holding the system-wide named mutex **`Global\Access_PCI`**. This is the exact mutex LHM 0.9.6 takes around its own SMN reads (`LibreHardwareMonitor.Hardware.Mutexes._pciBusMutex`, `WaitPciBus`/`ReleasePciBus`, used by `Amd17Cpu+Processor.UpdateSensors` around `ReadSmn`; verified in the 0.9.6 binary by the contract owner). `Mutexes` is `internal`, so A2 opens it by name: `Mutex.TryOpenExisting(@"Global\Access_PCI", out m)` (LHM creates it in `Computer.Open()`), in a `Spec/PciBusGuard.cs` modelled on `IsaBusGuard.cs`. Take it once per batch of reads (one channel's registers), wait ≤ 500 ms, release on the same thread. If the mutex does not exist or cannot be taken within 500 ms (another tool holds it), **do not read without it**: retry once after 1 s, then give up with `timingsNote:"The PCI bus was busy (another hardware tool?)."`. `AbandonedMutexException` = acquired.
- Register map: AMD UMC per channel, base `0x50000 + ch × 0x100000` (ch 0..1), offsets and bit fields exactly as in [ZenStates-Core `DDR4Dictionary.cs`](https://github.com/irusanov/ZenStates-Core/blob/master/Dictionaries/DDR4Dictionary.cs) (GPL-3.0, compatible). A2 records the commit hash it used in a comment and adds the attribution to `licenses/` through F's THIRD_PARTY list (§4.1). A channel is "populated" if its timing register reads non-zero and not `0xFFFFFFFF`; use the first populated channel.
- Read **once per agent process** (first `spec` request after `hello`) and cache, including the failure. `{cmd:"spec"}` replies reuse the cache.
- Plausibility: if `cl` is not in 8..40 or `ras` < `cl`, discard the read (`timingsNote:"The memory controller returned implausible values."`).

**SPD JEDEC fallback (`timingsSource:"spd"`)** — when the live read is unavailable and at least one DIMM has `spd != null`: `timings` = the cycle values of the first DIMM's `spd.cycles`, with `commandRate` and `gearDown` null. The UI must label these `SPD JEDEC (not the running timings)`.

**`timingsSource:"unavailable"`** — `timings:null`.

`timingsNote` (exact strings; null only when `timingsSource == "umc"`):

| Case | `timingsNote` |
|---|---|
| not elevated | `Live timings need administrator rights.` |
| PawnIO missing/outdated | `Live timings need the PawnIO driver.` |
| not AMD Zen 1–3 or not DDR4 | `Live timings are only read on AMD Ryzen (Zen 1 to Zen 3) with DDR4.` |
| mutex busy | `The PCI bus was busy (another hardware tool?).` |
| implausible | `The memory controller returned implausible values.` |
| any exception | `Live timings could not be read.` (+ `errors` line) |

When the fallback applies, the UI shows the note and the `SPD JEDEC` label together.

`MemoryTimings` (all cycles, `number|null` each): `cl, rcdRd, rcdWr, rp, ras, rc, rfc, rrds, rrdl, faw, wtrs, wtrl, wr, rtp, cwl` (numbers), `commandRate: "1T"|"2T"|null`, `gearDown: boolean|null`.

**Clocks.** `memclkMhz`: UMC ratio from the same read (`ratio / 3 × 100` per ZenStates-Core, 0 decimals), else `DimmSpec.configuredSpeedMts / 2` of the first DIMM, else null. `fclkMhz` / `uclkMhz`: LHM CPU clock sensors named `"Fabric Clock"` / `"Uncore Clock"` (SMU PM table; present only on supported Zen 2/3 tables), captured in `CaptureLhm`, else null. Never computed from guesses (no "FCLK = MEMCLK" assumption).

**`dimms[].spd` (`SpdInfo|null`).** Source: LHM `HardwareType.Memory` sub-hardware `/memory/dimm/<n>` (`DimmMemory`, RAMSPDToolkit; needs elevation + PawnIO). `SensorType.Timing` sensors are JEDEC **minimum** times in ns:
- `timingsNs`: object with keys `tAA, tRCD, tRP, tRAS, tRC, tRFC1, tRFC2, tRFC4, tFAW, tRRD_S, tRRD_L, tCCD_L, tWR, tWTR_S, tWTR_L` (value `number|null`; key = the LHM sensor name with spaces removed; a sensor name that is not in this list is ignored).
- `jedecSpeedMts`: the DIMM's `speedMts` (SMBIOS rated speed); null → `cycles` null.
- `cycles`: `{ cl, rcd, rp, ras, rc, rfc, faw, rrds, rrdl, wr, wtrs, wtrl }` from `tAA, tRCD, tRP, tRAS, tRC, tRFC1, tFAW, tRRD_S, tRRD_L, tWR, tWTR_S, tWTR_L`: `tCK = 2000 / jedecSpeedMts` ns; `cycles = ceil(ns / tCK − 0.025)` (JEDEC 2.5% guard band), integer; null when the ns value is null.
- `tempC`: the DIMM's temperature sensor value at capture time, or null (only modules with a thermal sensor).
- `matchedBy: "order"|"partNumber"`. **Join** LHM DIMM nodes to `dimms[]`: if every LHM node name contains exactly one distinct `partNumber` (trimmed, case-insensitive) that occurs once in `dimms[]`, join by part number; else if the counts are equal, join by order (LHM node order ↔ `Win32_PhysicalMemory` order); else no `spd` on any DIMM (and `errors` gets `SPD query failed: could not match modules to slots`).
- No serial numbers, ever.

**`gpus[].link` (`PcieLink|null`):** `{ gen: number|null, width: number|null, maxGen: number|null, maxWidth: number|null, source: "adl"|"devpkey"|"unknown", note: string|null }`.
- AMD: from LHM's ADL report for that GPU (`IHardware.GetReport()` lines for the PCIe link) → `source:"adl"`. If not found, fall back to devpkey with `note:"Radeon cards sit behind an on-board PCIe switch; Windows may report the switch link, not the GPU link."`.
- Others: `DEVPKEY_PciDevice_CurrentLinkSpeed/CurrentLinkWidth/MaxLinkSpeed/MaxLinkWidth` of the device (`CM_Get_DevNode_PropertyW` via the `PNPDeviceID`) → `source:"devpkey"`. Link speed codes 1..6 → gen 1..6.
- Nothing readable → `link:null`.

**`diskLinks[]` (`DiskLink[]`):** one entry per `Win32_DiskDrive` with an index: `{ diskNumber: number, model: string, bus: "nvme"|"sata"|"usb"|"other", gen: number|null, width: number|null, maxGen: number|null, maxWidth: number|null, sataGen: number|null }`. NVMe: the devpkey link of the parent PCI controller (walk `CM_Get_Parent` from the disk devnode to the first `PCI\` node). SATA: `sataGen` from the negotiated speed when LHM/`MSFT_PhysicalDisk` exposes it, else null; `gen/width` null. USB/other: all link fields null. No serials here (Rust joins on `diskNumber`).

**`cpu.codename` [CHANGED 1.1]:** the static table must at least cover (vendor AMD, family 0x19): model 0x21 → `Vermeer`, 0x50 → `Cezanne`, 0x61 → `Raphael`, 0x44 → `Rembrandt`, 0x74/0x75 → `Phoenix`; family 0x17: 0x71 → `Matisse`, 0x08 → `Pinnacle Ridge`, 0x01 → `Summit Ridge`, 0x18 → `Picasso`, 0x60 → `Renoir`; family 0x1A model 0x44 → `Granite Ridge`. Intel entries only with a cited source in a code comment. The X3D parts share the Vermeer model (0x21) → codename `Vermeer` (the UI may append `-X3D` when the name contains `X3D`). Unknown → null.

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
- **Check at agent start** (sets `hello.fanFlag`): flag absent → `"none"`. Flag present and *same boot* → `"interrupted"`. Flag present from another boot → delete it, `"previousBoot"`. Same boot = (`bootId` non-null in both and equal) or (`bootId` null in either and `|flag.bootTs − current bootTs| ≤ 120000`). An unreadable/corrupt flag counts as same boot, unless its last-write time is more than 120 s before the current `bootTs` (then `previousBoot`). An elevated agent trusts a flag only inside a folder that already has the owner/DACL above: if the folder is a reparse point or not admin-only, the flag cannot have been written by Nexum (a standard user could have planted it), so the agent secures the folder, deletes the flag and reports `"none"`. Non-elevated agents only read the flag (report `interrupted`/`previousBoot`, never delete, cannot force fans).

#### 1.5.4 Failsafe mode (agent)

Entered at start when `fanFlag == "interrupted"` and the agent is elevated:
- Writes 100% to every controllable control, rewrites the flag with `mode:"failsafe"`, sets `fanSafety.failsafe = overrideActive = manualActive = true`, `reason:"failsafe"`.
- Latched until process exit. Every `fanPreset` (including `auto`) and `fanSet` → `ack ok:false`, message exactly `Fan control is locked at 100% after an interruption. Restart the PC to return fans to BIOS control.`
- On `shutdown`/EOF in failsafe mode the agent does **not** call `SetDefault()` (it would restore the stale manual values captured at this process's init) and leaves the flag in place. It also does not close the LHM `Computer`, because LHM's `SuperIOHardware.Close()` writes those same stale values back.
- While latched, every evaluation re-writes 100% to any control whose read-back is below 99%.

Rationale: after a hard kill on boards like the IT8688E the original PWM registers and Gigabyte controller state exist only in the dead process (ROADMAP MF-13), so only a reboot restores BIOS control.

#### 1.5.5 Owner test result (pending)

> To be filled after the ROADMAP MF-13 test on the reference rig: `taskkill /F` the agent under each preset; record header behaviour and whether a warm reboot or only a cold power cycle restores BIOS control. Until then the banner says "Restart the PC".

### 1.6 Frame capture (FPS) [NEW 1.1] (owner A1, ROADMAP §4)

Opt-in (`Settings.fpsCaptureEnabled:false` by default). Backend: Intel's **unmodified, Intel-signed** PresentMon console exe **2.6.0** (`PresentMon-2.6.0-x64.exe`, MIT), spawned by the elevated agent. No injection, no hooks, no handles on game processes (§0).

#### 1.6.1 Executable trust check (before every spawn, including the terminate call)

1. The path comes only from `--presentmon` (§1.1). Missing flag or missing file → `frameSession {state:"error", code:"exeMissing"}`.
2. Open the file with `FileShare.Read` only (no write, no delete sharing), `FILE_FLAG_OPEN_REPARSE_POINT`; if it is a reparse point → `code:"signatureInvalid"`. **Keep this handle open until `CreateProcess` has returned** (it blocks a swap between check and spawn). The drive must be local (`GetDriveTypeW` not remote/unknown, checked before the open), and the handle's own path (`GetFinalPathNameByHandleW`, every junction/link resolved) must be a plain local drive-letter path; that resolved path is the one spawned (§1.6.2). Otherwise → `code:"signatureInvalid"`.
3. SHA-256 of the file content (read through that handle) must equal the pinned constant `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` (ROADMAP V1).
4. `WinVerifyTrust` (`WINTRUST_ACTION_GENERIC_VERIFY_V2`, revocation check `WTD_REVOKE_NONE`, no UI, cache-only URL retrieval — **no network**) must return 0, and the leaf signer certificate subject must start with `CN=Intel Corporation`.
5. Any failure → `state:"error", code:"signatureInvalid"`, `signature.status` = `"invalid"` (hash mismatch or WinVerifyTrust ≠ 0) or `"untrusted"` (valid chain, wrong signer). The feature stays off until the next `frames enabled:true`.
Result reporting: `FrameSession.signature = { status: "valid"|"invalid"|"untrusted"|"notChecked", signer: string|null /* subject CN, e.g. "Intel Corporation" */, sha256Match: boolean|null }`.

#### 1.6.2 Spawn

```
"<exe>" --output_stdout --no_console_stats --session_name NexumFrames --stop_existing_session
        --qpc_time_ms --no_track_input --exclude dwm.exe --exclude msedgewebview2.exe
        --exclude Nexum.exe --exclude nexum-agent.exe
```
- Exactly these arguments (fixed excludes only). **User excludes are applied by the agent's own row filter (§1.6.4), never as CLI arguments**, so changing them never restarts the ETW session (EA Javelin blocks new sessions while a game runs).
- `CreateProcessW` with `CREATE_NO_WINDOW | CREATE_SUSPENDED`, explicit `lpApplicationName` = the verified absolute path (the resolved path of §1.6.1 step 2), current directory = the exe's folder, inherited handles = only the stdout/stderr pipes, image-load mitigations `PREFER_SYSTEM32 | NO_REMOTE | NO_LOW_LABEL` (a DLL planted next to the exe is not loaded in place of a system DLL); the suspended child's image path (`QueryFullProcessImageNameW`) must equal the verified path, else it is terminated before it runs (`spawnFailed`); assign to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (the job handle lives for the agent process), then resume. Child priority `BELOW_NORMAL_PRIORITY_CLASS`.
- stdout is read line by line on a dedicated thread (`frames-reader`, BelowNormal); stderr is drained on another thread and logged (throttled, 1 line / 30 s).
- **Session lifetime:** the session starts on `{cmd:"frames", enabled:true}` (Rust sends it right after every `hello` when the setting is on, §2.13) — i.e. when Nexum starts, **not** when a game starts. It keeps running while the window is hidden.
- **Unexpected child exit** while enabled: restart with the full trust check after 2 s, 10 s, 30 s (3 attempts per enable); after the third failure `state:"error", code:"exited"`, `message:"PresentMon stopped unexpectedly (exit code <n>)."`. A child that ran ≥ 10 min resets the attempt counter.
- Not elevated → `state:"error", code:"notElevated"`, no spawn.

#### 1.6.3 CSV parsing — by header name

The first stdout line is the header. Build a case-insensitive `name → column index` map; every lookup below tries the names **in order** and uses the first present. Values are invariant-culture numbers; `NA`, empty or unparsable → null. Never index by position.

| Field | Header names tried (PresentMon 2.6.0 first, older 2.x / 1.x fallbacks) | If none present |
|---|---|---|
| process | `Application` | fatal → `code:"unsupportedOutput"` |
| pid | `ProcessID` | fatal |
| swap chain | `SwapChainAddress` | treat all rows of a pid as one swap chain |
| runtime | `PresentRuntime` | `"Other"` |
| syncInterval | `SyncInterval` | null |
| allowsTearing | `AllowsTearing` (`1`/`0`) | null |
| presentMode | `PresentMode` (verbatim string) | `"Unknown"` |
| cpu start (ms, QPC clock) | `CPUStartQPCTimeInMs` (2.6.0, produced by `--qpc_time_ms`), `CPUStartQPCTime` | rows get the agent's QPC time at line receipt (`Stopwatch.GetTimestamp()` in ms) |
| **frametime (ms)** | `MsBetweenAppStart`, `FrameTime`, `MsBetweenPresents` | fatal |
| cpuBusy (ms) | `MsCPUBusy`, `CPUBusy` | null for all frames |
| gpuBusy (ms) | `MsGPUBusy`, `GPUBusy` | null |
| displayed time (ms) | `MsBetweenDisplayChange` (2.6.0), `DisplayedTime`, `MsDisplayedTime` (`NA` = not displayed) | display metrics null |
| display latency (ms) | `MsUntilDisplayed` (2.6.0: from the Present() call to display), `DisplayLatency`, `MsDisplayLatency` | null |

- The README for 2.6.0 lists `MsCPUBusy`, `MsGPUBusy`, `MsBetweenAppStart`, `DisplayedTime` (`NA` if not displayed) and `DisplayLatency`. A1 must confirm the real 2.6.0 header once (run the pinned exe elevated and save the header line into `nexum-agent/Frames/HEADER-2.6.0.txt`); if a name differs, add it **in front of** the list above and report it to the contract owner. A CI test (A1, `--selftest`) parses that saved header and fails if a fatal column cannot be resolved.
- **[CONFIRMED 1.1]** The real 2.6.0 header is saved in `nexum-agent/Frames/HEADER-2.6.0.txt` (A1). It has no `DisplayedTime`/`DisplayLatency` columns (those are probably the `--v2_metrics` names, kept as fallbacks); the 2.6.0 names were added in front above. `displayLatencyMs` therefore measures Present() → display, not CPU start → display (UI tooltip says so).
- A row is a valid frame iff pid > 0 and frametime is a finite number in `(0, 5000]` ms. Invalid rows are ignored entirely.
- Header missing a fatal column → stop the child, `state:"error", code:"unsupportedOutput"`, `message:"PresentMon output is missing the <name> column."`.

#### 1.6.4 Target selection, filtering and buffers

- **Filter:** rows whose `Application` equals (case-insensitive) any user exclude (`frameExclude`) or any fixed exclude are dropped before buffering.
- **Per-process buffer:** a ring per pid holding the last `max(windowSec, 5)` seconds of valid frames of its **primary swap chain** (the swap chain with the most frames in the last 2 s; re-evaluated every second). Processes with no frame for 10 s are evicted.
- **Presenting** = a pid with ≥ 1 valid frame in the last 2 s.
- **Bounds:** at most 64 processes are buffered (rows of a new pid beyond that are dropped until a silent one is evicted); a ring holds at most 2^18 frames (oldest overwritten); a line longer than 16 K characters is dropped up to its newline.
- **Foreground tracker** (every 500 ms): `GetForegroundWindow` → `GetWindowThreadProcessId`. No process handles.
- **Target rule** (evaluated every 500 ms; emit `frameTarget` only when `pid` or `reason` changes):
  1. A manual pid (from `frameTarget`) wins while it has presented within the last 5 s; when it has not presented for 5 s **and** is absent from a Toolhelp32 process snapshot, the manual pid is cleared (back to automatic).
  2. Else, if the foreground pid is presenting → that pid, `reason:"foreground"`.
  3. Else keep the previous automatic target while it has presented within the last 5 s (alt-tab to Nexum or a browser keeps the game as target).
  4. Else `reason:"none"`, `pid:null`.
- `FrameTarget = { type:"frameTarget", pid: number|null, process: string|null, windowTitle: string|null /* top-level visible window of that pid via EnumWindows+GetWindowTextW, ≤ 120 chars, null if none */, reason: "foreground"|"manual"|"none", runtime: string|null, presentMode: string|null, fullscreenExclusive: boolean|null /* presentMode starts with "Hardware: Legacy" */ }`.

#### 1.6.5 Statistics (`frameStats`, 1 Hz)

Emitted once per second **only while a target exists** (no `frameStats` while `reason:"none"`). Window = the target's valid frames whose cpu-start time is within the last `windowSec` seconds of the agent's QPC clock (`Stopwatch.GetTimestamp()`, same clock as `CPUStartQPCTime`). Let `n` = frame count and `f[]` the frametimes in ms.

| Field | Definition | Null when |
|---|---|---|
| `frames` | `n` | never (0 allowed) |
| `fpsAvg` | `1000 × n / Σf` (time-weighted, **not** the mean of per-frame fps) | `n < 2` |
| `frametimeAvgMs` | `Σf / n` | `n < 2` |
| `frametimeP99Ms` / `frametimeP999Ms` | nearest-rank percentile of `f` sorted ascending: `P(q) = sorted[ceil(q/100 × n) − 1]` | `n < 100` / `n < 1000` |
| `fpsLow1` ("P1") | `1000 / frametimeP99Ms` | `n < 100` |
| `fpsLow01` ("P0.1") | `1000 / frametimeP999Ms` | `n < 1000` |
| `frametimeMaxMs` | `max(f)` | `n < 1` |
| `cpuBusyMs` / `gpuBusyMs` | arithmetic mean over frames where that value is non-null | column missing or no values |
| `boundBy` | rule below | see rule |
| `fpsDisplayedAvg` | `1000 × D / Σ displayedTime` over the `D` displayed frames | display column missing or `D < 2` |
| `droppedPct` | `100 × (frames with displayedTime == NA) / n` | display column missing or `n < 1` |
| `displayLatencyMs` | mean `displayLatency` over displayed frames | column missing or `D < 1` |
| `presentMode`, `runtime`, `allowsTearing`, `syncInterval` | from the newest frame | as parsed |
| `frametimes` | the frametimes of the target's frames received **since the previous `frameStats`**, oldest first, 2 decimals, at most **1000** (if more arrived, the newest 1000) | never (may be `[]`) |
| `frametimesOmitted` | frames not sent because of the 1000 cap | never |

- `P1` / `P0.1` are **percentile lows** (1000 ÷ the 99th / 99.9th frametime percentile), not "average of the slowest 1%". The UI tooltip states this definition verbatim: `P1 = 1000 ÷ 99th-percentile frame time in the window. P0.1 uses the 99.9th percentile.`
- **`boundBy`** (`"gpu"|"cpu"|"balanced"|"capped"|null`), with `c = cpuBusyMs`, `g = gpuBusyMs`, `t = frametimeAvgMs`: null if any is null or `n < 30`; else `"capped"` if `max(c, g) < 0.75 × t` (frame limiter, V-Sync or sync interval — neither side is busy); else `"gpu"` if `g ≥ 1.1 × c`; else `"cpu"` if `c ≥ 1.1 × g`; else `"balanced"`.
- Rounding: fps values 1 decimal, ms values 2 decimals, `droppedPct` 1 decimal.
- `FrameStats` also carries `type:"frameStats"`, `ts` (unix ms at emission), `pid`, `process`, `windowSec`.

#### 1.6.6 Commands, session state and shutdown

`FrameSession = { type:"frameSession", state: "stopped"|"starting"|"running"|"error", code: FrameSessionCode|null, message: string, backend:"presentmon-console", backendVersion:"2.6.0", sessionName:"NexumFrames", signature: FrameSignature, childPid: number|null, sinceTs: number }`; `FrameSessionCode = "notElevated"|"exeMissing"|"signatureInvalid"|"spawnFailed"|"unsupportedOutput"|"exited"`.

- One `frameSession` (`stopped`, `signature.status:"notChecked"`) is written right after `hello`. Afterwards one on every state change. `starting` = trust check passed and child spawned, header not yet parsed; `running` = header parsed. Messages (exact): stopped `Frame capture is off.`; starting `Starting PresentMon…`; running `Capturing frames with Intel PresentMon 2.6.0.`; error codes: notElevated `Frame capture needs administrator rights.`, exeMissing `PresentMon is not installed with this copy of Nexum.`, signatureInvalid `PresentMon failed its signature check, so it was not started.`, spawnFailed `PresentMon could not be started: <win32 message>.`, unsupportedOutput (above), exited (§1.6.2).
- `frames {enabled:true}`: when already starting/running → ack ok:true `Frame capture is already on`; else trust check + spawn; ack ok:true `Frame capture started` once the child is spawned, or ok:false with the error message.
- `frames {enabled:false}`: run the exe (same trust check) with `--terminate_existing_session --session_name NexumFrames` (no other args, wait ≤ 5 s), then `TerminateJobObject` if the capture child is still alive after 3 s more; clear all buffers; `state:"stopped"`; emit `frameTarget {reason:"none", pid:null}` if a target existed. Ack ok:true `Frame capture stopped`. The terminate call is attempted even when the capture child already died, so an orphaned ETW session does not survive (ROADMAP §4.3 gate 3).
- **Leftover session fallback (no process):** when elevated, the agent stops an ETW session named exactly `NexumFrames` with `ControlTraceW(EVENT_TRACE_CONTROL_STOP)` (a) once at agent start, before any `frames` command, so a session orphaned by a hard-killed agent does not hold kernel buffers until reboot while capture stays off; (b) after every stop sequence, after the 2 s shutdown budget, after the final unexpected-exit failure and after a final trust/spawn failure, in case the terminate call could not run. No other session name is ever touched; no session is ever started this way.
- `shutdown`/EOF/process exit: **fans first** — the existing fan restore (§1.5) runs before anything frame-related, because the parent's shutdown grace is 6 s. Then the frame stop runs with a hard budget of **2 s** total: start the terminate call, `TerminateJobObject` at the 2 s mark at the latest, never wait for the terminate process beyond that. A session orphaned by a short budget or a hard kill is removed by `--stop_existing_session` at the next start (fixed session name).
- `frameTarget {pid}`: `pid:null` → automatic, ack ok:true `Automatic target`; a pid that is presenting → manual, ack ok:true `Target: <process>`; otherwise ack ok:false `That app is not presenting frames.`.
- `frameWindow {sec}`: integer, clamped 5..120; ack ok:true `Window: <sec> s`.
- `frameExclude {names}`: sanitized exactly like Rust (§2.13); replaces the list; ack ok:true `Excluding <n> apps`. If the current target becomes excluded, the target rule runs at once.
- `presentingList` → `{ type:"presentingList", ts, items: PresentingProcess[] }` sorted by `fps` desc, where `PresentingProcess = { pid, process, windowTitle: string|null, fps: number /* last 2 s, 1 decimal */, runtime: string, presentMode: string, isForeground: boolean, isTarget: boolean }`. Excluded processes are not listed. When capture is not running: `items:[]`.
- Gate (ROADMAP §4.3 gate 1): PresentMon + agent parsing ≤ 0.5% total CPU at 144 fps over 10 min on the reference rig; parsing must not allocate per row beyond the ring slot (span-based split, no LINQ in the hot path).

### 1.7 GPU tuning, read-only [NEW 1.1] (owner A2, ROADMAP §5)

#### 1.7.1 ADL binding rules (safety)

- AMD ADL (MIT, header text in `licenses/ADL/`), loaded from the **installed driver only**: `atiadlxx.dll` via `[DllImport]` with `[DefaultDllImportSearchPaths(DllImportSearchPath.System32)]`. Never shipped, never loaded from another folder. Missing DLL → `supported:false, reason:"adlMissing"`.
- All ADL declarations live in **one file**, `nexum-agent/Tuning/AdlNative.cs`, and may only be these entry points: `ADL2_Main_Control_Create`, `ADL2_Main_Control_Destroy`, `ADL2_Adapter_NumberOfAdapters_Get`, `ADL2_Adapter_AdapterInfo_Get`, `ADL2_Adapter_Active_Get`, `ADL2_Overdrive_Caps`, `ADL2_Overdrive8_Init_Setting_Get`, `ADL2_Overdrive8_Init_SettingX2_Get`, `ADL2_Overdrive8_Current_Setting_Get`, `ADL2_Overdrive8_Current_SettingX2_Get`, `ADL2_OverdriveN_CountOfEvents_Get`. Adding any other entry point is a contract change.
- **Forbidden:** any entry point matching `/_Set(?![a-z])/` (e.g. `ADL2_Overdrive8_Setting_Set`), `GetProcAddress`, `NativeLibrary.GetExport`/`TryGetExport`, function pointers to ADL, and reflection-based invoke anywhere under `nexum-agent/Tuning/**`. CI (§7 item 9) enforces this.
- The memory-allocation callback passed to `ADL2_Main_Control_Create` uses `Marshal.AllocCoTaskMem` (zeroed, ≤ 1 MiB, never throws: failure returns NULL) and records each allocation's size; every buffer ADL returns is freed with `Marshal.FreeCoTaskMem` only if the callback allocated it (a foreign pointer is neither read nor freed), and a returned list is never read beyond the bytes allocated for it. One ADL context per call of the entry points below, destroyed before returning.

#### 1.7.2 Entry points (A2 implements, A1 wires)

```csharp
namespace NexumAgent.Tuning;
public static class TuningService
{
    // {cmd:"tuningGet"}. Blocking (≤ 10 s), thread-safe (internal lock: one ADL session at a time),
    // never throws (failures become supported:false / reason:"adlError").
    public static TuningStateMessage GetState(bool isAdmin);
    // {cmd:"tuningProbe", write:false}. Same guarantees. Read-only by construction.
    public static TuningProbeMessage ProbeReadOnly(bool isAdmin);
}
```
A1 (Program.cs): on `tuningGet` / `tuningProbe` start a background thread (`Name="tuning"`, BelowNormal); if one is already running, do not start a second — the running one's reply answers both. Emit the returned object. `tuningProbe` with `write:true` → `ack {cmd:"tuningProbe", ok:false, message:"The write probe is not available in this version."}` **without calling A2**. `write` missing or not a boolean → `ack ok:false "Invalid command"`.

#### 1.7.3 `tuningState`

```jsonc
{ "type":"tuningState", "ts":1764230000000, "gpuIndex":0, "adapterName":"AMD Radeon RX 9070 XT",
  "backend":"adl-od8", "supported":true, "reason":null, "message":"Read-only. Nexum does not change GPU settings in this version.",
  "odVersion":8,
  "caps":{ "powerLimit":true, "autoUndervolt":true, "fanCurve":true, "zeroRpm":true, "voltageOffset":true, "gfxClockMax":true, "memClockMax":true },
  "ranges":{ "powerPct":{ "min":-30, "max":10, "step":1, "default":0 },
             "voltageOffsetMv":null, "gfxClockMaxMhz":{…}, "memClockMaxMhz":{…},
             "fanCurveTempC":{ "min":25, "max":100, "step":1, "default":null },
             "fanCurvePct":{ "min":0, "max":100, "step":1, "default":null } },
  "current":{ "powerPct":0, "autoUndervolt":false, "zeroRpm":true, "voltageOffsetMv":null,
              "gfxClockMaxMhz":3100, "memClockMaxMhz":2518, "fanCurve":[{ "tempC":40, "pct":20 }, …] },
  "isFactory":true, "mode":"factory", "powerMode":null, "vpuRecoveryCount":0 }
```
- Adapter: the first **active** AMD adapter (`ADL2_Adapter_Active_Get`), deduplicated by bus number; `gpuIndex` = its position among AMD GPUs in `telemetry.gpus` order (0 if unknown).
- `supported:false` with `reason` (`TuningUnsupportedReason`) and exact `message`: `notElevated` `GPU tuning data needs administrator rights.`; `noAmdGpu` `No AMD Radeon GPU was found.`; `adlMissing` `The AMD driver's ADL library was not found.`; `odUnsupported` `This GPU does not report Overdrive 8 tuning data.`; `adlError` `The AMD driver returned an error (<code>).`. With `supported:false`, `caps` are all false, `ranges` and `current` have every member null, `isFactory:null`, `mode:"unknown"`.
- `caps.*`: from the OD8 Init table's feature-capability bits (`ADL_OD8_*` in `adl_defines.h`). A range or current value is null when its cap is false.
- `Range = { min:number, max:number, step:number, default:number|null }` from the Init table (`step` 1 when not reported).
- `current.fanCurve`: the five OD8 fan-curve points in order (`OD8_FAN_CURVE_TEMPERATURE_1..5`, `OD8_FAN_CURVE_SPEED_1..5`), or null.
- `isFactory` = every capped current value equals its `default` (features whose `default` is null are ignored); `mode`: `"autoUndervolt"` if `current.autoUndervolt`, else `"factory"` if `isFactory`, else `"custom"`; `"unknown"` when not supported. (`"external"` and the transaction states are v1.2.)
- `powerMode`: the raw `OD8_OPTIMZED_POWER_MODE` current value as a string, or null (values are undocumented; display raw).
- `vpuRecoveryCount`: `ADL2_OverdriveN_CountOfEvents_Get` with the VPU-recovery event type, or null when the call fails.
- No polling in the agent: state is read only on `tuningGet`.

#### 1.7.4 `tuningProbe` (read-only)

`{ "type":"tuningProbe", "ts":…, "write":false, "ok":true, "message":"Read-only probe finished.", "report":{…} }`. `report` is a JSON object for the owner's ROADMAP §5.3 question list: `{ "agentVersion", "adapters":[{index, name, busNumber, active, vendorId}], "odVersion", "capsBits", "initTable":[{index, featureName|null, min, max, defaultValue}], "currentTable":[{index, featureName|null, value}], "vpuRecoveryCount", "state": TuningState (as above), "errors": string[] }` — the full raw tables, every index ADL returns. No serials, no hostnames. `ok:false` + message when nothing could be read. The agent does **not** write the file; Rust does (§2.14).

---

## 2. Rust core ⇄ Frontend — Tauri commands & events

All structs `#[serde(rename_all = "camelCase")]`. Commands are async where they do IO and return `Result<T, String>`. Frontend calls `invoke('<snake_name>', { camelCaseArgs })`.

| Command | Args | Returns | Notes |
|---|---|---|---|
| `get_system_info` | – | `SystemInfo` | **[CHANGED]** adds `bootTs` |
| `get_drivers` | – | `DriverInfo[]` | **[BREAKING]** status union, `problemCode`, `isInbox` (§2.7) |
| `get_volumes` | – | `Volume[]` | |
| `get_physical_disks` | – | `PhysicalDisk[]` | **[CHANGED]** adds `volumes`, `isSystemDisk` (§2.8) |
| `scan_trash` | `{ includeBrowser: bool, recycleMinAgeDays?: number\|null }` | `TrashScan` | **[CHANGED]** §3 · **[CHANGED 1.1]** optional `recycleMinAgeDays` (§3.2); absent → `Settings.recycleMinAgeDays` |
| `purge_trash` | `{ categories: string[], recycleMinAgeDays?: number\|null }` | `PurgeResult` (emits `purge-progress`) | **[BREAKING]** `flushStandby` arg removed · **[CHANGED 1.1]** optional `recycleMinAgeDays`, same default; the UI passes the value it scanned with |
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
| `scan_trash_details` | `{ categoryId: string, limit: number }` | `TrashDetailItem[]` | **[NEW 1.1]** §3.3 |
| `get_frame_state` | – | `FrameState` | **[NEW 1.1]** §2.13 cached session/target/stats |
| `set_frame_capture` | `{ enabled: bool }` | `Settings` | **[NEW 1.1]** §2.13 saves `fpsCaptureEnabled`, forwards `frames` |
| `set_frame_target` | `{ pid: number\|null }` | `()` | **[NEW 1.1]** §2.13 waits for the ack ≤ 3 s; Err(message) on `ok:false`/timeout |
| `set_frame_window` | `{ sec: number }` | `Settings` | **[NEW 1.1]** clamps 5..120, saves `fpsWindowSec`, forwards `frameWindow` |
| `set_frame_excludes` | `{ names: string[] }` | `Settings` | **[NEW 1.1]** sanitizes (§2.13), saves `fpsExcludes`, forwards `frameExclude` |
| `list_presenting_processes` | – | `PresentingProcess[]` | **[NEW 1.1]** sends `presentingList`, waits ≤ 3 s; `[]` when capture is off; Err on timeout |
| `start_sensor_log` | `{ intervalMs?: number, ids?: string[]\|null }` | `SensorLogStatus` | **[NEW 1.1]** §2.9 |
| `stop_sensor_log` | – | `SensorLogStatus` | **[NEW 1.1]** §2.9 |
| `get_sensor_log_status` | – | `SensorLogStatus` | **[NEW 1.1]** §2.9 |
| `get_health_alerts` | – | `HealthAlertsSnapshot` | **[NEW 1.1]** §2.10 |
| `dismiss_alert` | `{ dismissKey: string }` | `Settings` | **[NEW 1.1]** §2.10 appends to `dismissedAlerts` |
| `set_tray_sensors` | `{ ids: string[] }` | `()` | **[NEW 1.1]** §2.10.5 resolved pinned ids from the UI (first 4 used) |
| `get_drive_history` | `{ serial: string }` | `DriveHistory` | **[NEW 1.1]** §2.11 |
| `save_report` | `{ format: "txt"\|"html" }` | `string` (absolute path) | **[NEW 1.1]** §2.12 |
| `get_tuning_state` | `{ refresh?: bool }` | `TuningState \| null` | **[NEW 1.1]** §2.14 |
| `run_tuning_probe` | `{ write: bool }` | `TuningProbeSummary` | **[NEW 1.1]** §2.14; `write:true` → Err, never forwarded |

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
- **[NEW 1.1]** `frame-session` → `FrameSession`, `frame-target` → `FrameTarget`, `frame-stats` → `FrameStats` (verbatim sidecar lines, §2.13)
- **[NEW 1.1]** `sensor-log` → `SensorLogStatus` (§2.9)
- **[NEW 1.1]** `health-alerts` → `HealthAlertsSnapshot` on every change (§2.10)
- **[NEW 1.1]** `tuning-state` → `TuningState` whenever a `tuningState` line arrives or a probe finishes (§2.14)
- **[CHANGED 1.1]** `navigate` values gain `"gaming"`.

**Tray menu [CHANGED 1.1]** (ids → action): `show` "Show Nexum" → show window · separator · `dashboard` "Dashboard", `sensors` "Sensors", `system` "System", `storage` "Storage", `cooling` "Cooling", `drivers` "Drivers", **`gaming` "Gaming"** → `navigate` with that ViewId · separator · **`sensor-log` "Start sensor log" / "Stop sensor log"** (label follows `SensorLogStatus.active`; starts with `Settings.sensorLogIntervalMs` and `ids:null`) · `clean-caches` "Clean caches…" → `navigate "quick-clean"` · separator · `quit` "Quit". Tray tooltip: §2.10.5.

**Minimized to tray (ROADMAP §6.8) [CHANGED 1.1]:** while hidden, Rust sets the poll interval to `max(pollIntervalMs, 5000)` — or `min(that, sensor log intervalMs)` while a sensor log is active — stops `self-usage`, and sets the effective sensor stream per §2.9 (`wish ∧ visible` ∨ logging ∨ (hidden ∧ tray sensors non-empty)); on show it restores all. Frame capture is **not** paused while hidden (the ETW session must keep running, §1.6.2). The frontend pauses chart rendering while `document.hidden`.

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
SystemSpec { capturedTs, cpu, board, memory, gpus, os, security, errors, diskLinks /* [NEW 1.1] */ }          // §2.6
// [NEW 1.1] — exact members in types.ts
FrameState { session, target, stats }                                                                         // §2.13
FrameSession, FrameTarget, FrameStats, PresentingProcess                                                      // §1.6
SensorLogStatus { active, path, folder, rows, totalRows, startedTs, intervalMs, sensorCount, error }          // §2.9
HealthAlert, HealthAlertsSnapshot, CpuLimitInfo                                                               // §2.10
DriveHistory { serial, points, forecast }, DriveHistoryPoint, DriveForecast                                   // §2.11
TuningState, TuningProbeSummary                                                                               // §1.7.3, §2.14
TrashDetailItem { path, bytes, modifiedTs, kind }                                                             // §3.3
MemoryTimings, SpdInfo, PcieLink, DiskLink                                                                    // §1.4.1
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
| `fpsCaptureEnabled` | bool | `false` | **[NEW 1.1]** opt-in frame capture (§1.6) |
| `fpsWindowSec` | number | `30` | **[NEW 1.1]** integer, clamp 5..120 |
| `fpsExcludes` | `string[]` | `[]` | **[NEW 1.1]** sanitized per §2.13 (max 50) |
| `sensorLogIntervalMs` | number | `1000` | **[NEW 1.1]** one of 1000, 2000, 5000, 10000; anything else → 1000 |
| `alerts` | `AlertSettings` | see below | **[NEW 1.1]** each member sanitized on its own; a missing/malformed member → its default |
| `recycleMinAgeDays` | `number \| null` | `30` | **[NEW 1.1]** one of `null` (= every item), 1, 14, 30, 60; anything else → 30 |

**`AlertSettings` [NEW 1.1]** (defaults in `DEFAULT_ALERT_SETTINGS`, `types.ts`):

| Member | Type | Default | Sanitization / meaning |
|---|---|---|---|
| `desktopNotifications` | bool | `false` | opt-in Windows notifications (§2.10.4) |
| `cpuTempC` | `number\|null` | `null` | CPU **limit** override, integer clamp 60..105; null = per-model table (§2.10.2) |
| `gpuHotspotC` | `number\|null` | `null` | hotspot **crit** override, integer clamp 70..115; null = 110 |
| `gpuMemJunctionC` | `number\|null` | `null` | memory-junction **crit** override, integer clamp 70..115; null = 105 |
| `freeSpacePct` | number | `10` | low-space **warn** threshold, integer clamp 1..50; crit = `max(1, floor(freeSpacePct / 2))` |
| `sustainSec` | number | `60` | integer clamp 10..600 (§2.10.3) |

ROADMAP listed `alerts.enabled` and `alerts.driveLifePct`; both are **intentionally not in the contract**. Alerts are always evaluated because the header pill depends on them (MF-6: the pill must never say Optimal over a worn drive); only notifications are opt-in. Drive-life thresholds stay in the single sidecar classifier (§1.1.3) so there is exactly one drive-health rule.

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
- If `hello.protocol != 3` **[CHANGED 1.1]** (was 2), Rust logs a warning and sets `message` to `Hardware agent version mismatch (protocol <n>)`.

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
- **[NEW 1.1]** `SystemSpec.diskLinks` is copied from `AgentSpec.diskLinks` (`[]` when the agent is down). Rust adds nothing to it; the UI joins `diskNumber` to `PhysicalDisk.deviceId`.

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

### 2.9 CSV sensor logging [NEW 1.1] (B: `sensor_log.rs`)

**Who samples:** Rust, from the `sensorValues` lines it already forwards (never the WebView, never a second agent stream). While a log is active the effective stream is forced on: `effective = (wish ∧ visible) ∨ logActive ∨ (hidden ∧ traySensors ≠ ∅)`, and `agent running` (extends `sync_sensor_stream`).

**`start_sensor_log { intervalMs?, ids? }`** → `SensorLogStatus`
- `intervalMs` absent → `Settings.sensorLogIntervalMs`; must be one of 1000, 2000, 5000, 10000, else `Err("Unsupported log interval")`. A valid value given here is also saved to `Settings.sensorLogIntervalMs`.
- `ids`: `null`/absent → every sensor of the current tree with `!static`, `!defaultHidden` and not in `Settings.hiddenSensors`, in tree order. A list → those ids in the given order, unknown ids dropped; max 500. Empty result → `Err("No sensors to log")`. No tree cached → `Err("Sensor data is not available yet")`.
- Already active → `Err("A sensor log is already running")`.
- The column set is **fixed at start** (ids + their labels + units). On a new tree `rev` columns are re-mapped by id; a vanished sensor writes empty cells; new sensors are not added.
- Agent down/restarting: no rows are written for that time (no filler rows); the log stays active.

**Row cadence:** a row is written for an accepted `sensorValues` packet when `packet.ts − lastRowTs ≥ intervalMs − 250` (first packet after start always writes). The agent's poll interval is never raised for logging; if `pollIntervalMs > intervalMs`, rows follow the poll interval. While hidden, the poll interval is `min(max(pollIntervalMs, 5000), intervalMs)` while a log is active.

**File:** `<Documents>\Nexum\Logs\nexum-YYYYMMDD-HHMMSS.csv` (local start time). `<Documents>` = `SHGetKnownFolderPath(FOLDERID_Documents)`; the `Nexum` and `Logs` folders are created/opened through `safe_fs::PinnedDir::open(<Documents>, …, true)` and the file with `create_new_file` (a name collision → append `-2`, `-3`, … before `.csv`). Nothing ever follows a link.
- Encoding UTF-8 **with BOM** (so spreadsheet apps read `°C`), `\r\n` line ends, RFC 4180 quoting (a field containing `,`, `"`, CR or LF is wrapped in `"` with `"` doubled).
- Header: `Date,Time,<col>,<col>,…` with `<col>` = `<HardwareNode.name> | <label> [<unit>]`; `<label>` = `Settings.sensorLabels[id]` else `SensorMeta.name`; ` [<unit>]` omitted when the unit is `""`.
- Rows: `Date` = local `YYYY-MM-DD`, `Time` = local `HH:MM:SS` of `packet.ts`; each value = the packet's `value[idx]` formatted with **invariant culture, `.` decimal separator, no thousands separator**, exactly `SensorMeta.decimals` decimals; null → empty field. Temperatures stay in °C whatever `tempUnit` says (the unit is in the header).
- **Flush** every 10 rows, on stop, and on app exit.
- **Rotation:** when the file reaches 100 MiB (checked at each flush) it is closed and a new file (new start-time name, same header) is opened; `rows` restarts at 0, `totalRows` continues.
- Write error (disk full, file gone) → stop the log, `error` set to `Could not write the sensor log: <os message>.`, emit `sensor-log`.

**`stop_sensor_log`** → flushes, closes, returns the final status (`active:false`, `path` kept so "Open folder" works). Not active → returns the current status (not an error). App exit stops the log; a log never survives a restart of Nexum.

**`SensorLogStatus`** `{ active: boolean, path: string|null /* current or last file */, folder: string /* <Documents>\Nexum\Logs, for open_external */, rows: number /* rows in the current file */, totalRows: number, startedTs: number|null, intervalMs: number, sensorCount: number, error: string|null }`. Initial: `active:false, path:null, rows:0, totalRows:0, startedTs:null, intervalMs:Settings.sensorLogIntervalMs, sensorCount:0, error:null`. Event `sensor-log` on start, stop, rotation, error and after every flush.

### 2.10 Alert engine, notifications and tray tooltip [NEW 1.1] (B: `alerts.rs`)

Rust evaluates the hardware conditions so they work while the window is hidden. **One source of truth per condition** (§5): Rust owns `cpu-temp`, `gpu-temp:<i>`, `gpu-mem-temp:<i>`, `drive:<id>`, `drive-temp:<id>`, `space:<letter>`; the frontend owns `fan-failsafe`, `agent-offline`, `fan-override`, `limited-mode`, `drive-unknown:*` and no longer computes the Rust-owned ones.

#### 2.10.1 Shapes

```ts
HealthAlert { id, severity: "warn"|"crit", source: "cpu"|"gpu"|"drive"|"space",
  title, detail, short, group, rule,          // display-ready, exact texts below
  dismissKey,                                 // "<id>:<state>" — state = health.state for drive:*, else severity
  sinceTs,                                    // unix ms the alert entered its current severity
  value: number|null, threshold: number|null, // °C or % (space: free %), raw numbers
  subjectId: string|null,                     // DiskTelemetry.id (drive, drive-temp), "C:" (space), GPU index as string (gpu), null (cpu)
  sensorId: string|null }                     // LHM sensor id from the cached tree when resolvable (findSensor rules of lib/sensors.ts), else null
HealthAlertsSnapshot { ready: boolean, evaluatedTs: number|null, alerts: HealthAlert[], rules: string[], cpuLimit: CpuLimitInfo }
CpuLimitInfo { model: string|null, limitC: number, warnC: number, source: "table"|"user"|"default" }
```
- `alerts` are sorted crit first, then by the rule order of §2.10.3 table, then by `subjectId`.
- `rules` = the seven Rust rule texts in table order (drive crit, drive warn, then rules 2–6; always all seven, numbers filled in), for the pill hover and the empty Health alerts card.
- `ready` becomes true after Rust has evaluated at least one telemetry packet **and** one volume scan; it returns to false while the agent is down (then only `space:*` alerts remain).
- `get_health_alerts` returns the current snapshot; `health-alerts` is emitted on every change of `ready`, `alerts` (any member) or `cpuLimit`.

#### 2.10.2 Per-model CPU limit table

Key = the model token from `telemetry.cpu.name` matched case-insensitively by `/Ryzen\s+\d\s+(PRO\s+)?(\d{4}[A-Z0-9]*)/` (group 2, uppercased). Limit = AMD's published "Max. Operating Temperature (Tjmax)":

| Token | Limit °C | | Token | Limit °C |
|---|---|---|---|---|
| `5600X` | 95 | | `5800X3D` | 90 |
| `5800X` | 90 | | `5700X3D` | 90 |
| `5900X` | 90 | | `7800X3D` | 89 |
| `5950X` | 90 | | `7950X` | 95 |
| `9800X3D` | 95 | | | |

Source: AMD product pages (amd.com → Processors → *model* → Specifications → "Max. Operating Temperature (Tjmax)"). The table was compiled by the contract owner from AMD's spec pages as known on 2026-11-27; **F must re-check every row on amd.com before release and record the check date in `docs/`** (ROADMAP Q9). Precedence: `Settings.alerts.cpuTempC` (source `user`) > table (`table`) > default **90 °C** (`default`). `warnC = limitC − 5`, crit at `limitC`. With `source:"default"` the cpu-temp detail says so (below) and the Settings UI shows `This CPU model is not in Nexum's table; using a conservative 90 °C limit.` The agent's fan override stays at its fixed 85 °C (§1.5.2) — independent of this table.

#### 2.10.3 Rules

Inputs: every `telemetry` packet (CPU/GPU/drive), and `get_volumes` data refreshed by Rust every 60 s (and whenever the frontend calls `get_volumes`). Drive names use the same join as §1.1.3 with the cached `get_physical_disks` result (refreshed every 10 min): `<name>` = `<volumes joined ", "> (<model>)` when the joined disk has volumes, else `<model>`, else `DiskTelemetry.name`. Temperatures in text use `Settings.tempUnit`, 0 decimals, `°C`/`°F`; `value`/`threshold` stay °C. `<S>` = `sustainSec`.

| Order | id | Signal | warn / crit thresholds | short · group | title / detail |
|---|---|---|---|---|---|
| 1 | `drive:<tele.id>` | `health.state` (no sustain) | attention → warn; replace, failing → crit | label-based short exactly as v1.0 (`1 drive worn`, `1 drive failing`, `1 drive: replace soon`, `1 drive: check sectors`, `1 drive overheating`, `1 drive: Windows warning`) · `drive:<health.label>` | `<name> — <health.label>` / the §5.2 drive detail sentence |
| 2 | `cpu-temp` | `cpu.packageTempC` | `warnC` / `limitC` (§2.10.2) | `CPU hot` · `cpu-temp` | `CPU at <t>` / `Above <thr> for <S> s. Limit for this CPU: <limit> (<src>).` with `<src>` = `AMD specification` \| `your setting` \| `default, this CPU model is not in Nexum's table` |
| 3 | `gpu-temp:<i>` | `gpus[i].hotspotTempC`, else `gpus[i].tempC` (edge) | hotspot: `crit − 10` / `crit = gpuHotspotC ?? 110`; edge: 85 / 95 | `GPU hot` · `gpu-temp` | `<gpu name> at <t>` / `Hot spot above <thr> for <S> s.` or `Edge temperature above <thr> for <S> s.` |
| 4 | `gpu-mem-temp:<i>` | `gpus[i].memJunctionTempC` | `crit − 10` / `crit = gpuMemJunctionC ?? 105` | `GPU memory hot` · `gpu-mem-temp` | `<gpu name> memory at <t>` / `Memory junction above <thr> for <S> s.` |
| 5 | `drive-temp:<tele.id>` | `disks[].tempC` | `warningTempC ?? 70` / `criticalTempC ?? 80` | `Drive hot` · `drive-temp` | `<name> at <t>` / `Above <thr> for <S> s.` |
| 6 | `space:<letter>` | free % of each `Volume` with `driveType=="Fixed"`, `totalBytes > 0` (no sustain) | `< freeSpacePct` / `< max(1, floor(freeSpacePct/2))` | `Low disk space` · `space` | `<letter> has <fmtBytes(free)> free (<pct>%)` / `Below <thr>% free.` (`fmtBytes` = 1024-based, 1 decimal, units `B KB MB GB TB`; `<pct>` integer) |

Rule texts (`rule`, exact, with numbers filled in): (1) crit drive alerts `Critical when a drive reports a critical warning, spare below threshold, read-only, or ≤ 10% life left`; warn drive alerts `Attention when a drive has ≤ 50% life left, reallocated, pending or uncorrectable sectors, a temperature warning, or a Windows health warning` (both unchanged from v1.0) (2) `Attention when the CPU stays at or above <warnC> for <S> s; critical at or above <limitC>` (3) `Attention when a GPU hot spot stays at or above <hsWarn> (edge 85 °C) for <S> s; critical at or above <hsCrit> (edge 95 °C)` (4) `Attention when GPU memory stays at or above <mjWarn> for <S> s; critical at or above <mjCrit>` (5) `Attention when a drive stays at or above its warning temperature (70 °C if not reported) for <S> s; critical at its critical temperature (80 °C)` (6) `Attention when a fixed drive has less than <freeSpacePct>% free space; critical below <crit>%`. Edge/fallback numbers in (3) and (5) are printed in the chosen `tempUnit` too.

**Sustained evaluation** (rules 2–5), per signal, over the samples (packet `ts`, value) of the last `S` seconds:
- A level is **met** when the window holds ≥ 3 samples, the oldest sample is at least `0.8 × S` seconds old (window coverage; avoids firing right after start), every sample is non-null, and the **minimum** ≥ the level's threshold.
- Not active → becomes crit if crit is met, else warn if warn is met.
- Active warn → becomes crit when crit is met; clears when the last 3 samples are all non-null and `< warnThreshold − 3 °C`.
- Active crit → when the last 3 samples are all non-null and `< critThreshold − 3 °C`: becomes warn, or clears if they are also `< warnThreshold − 3 °C`.
- Null samples never clear an alert; they only prevent a new one.
- Telemetry stale (`no packet for max(5000, 3 × effective interval)`) or agent down → clear every non-`space` alert and their sample buffers.
- `sinceTs` changes on every severity change.

#### 2.10.4 Desktop notifications (opt-in)

Only when `Settings.alerts.desktopNotifications` is true, through `tauri-plugin-notification` (Rust API only). Title `Nexum: <alert.title>`, body `<alert.detail>`. Sent when an alert **becomes active or escalates** (warn → crit), and only if all hold:
- its `dismissKey` is not in `Settings.dismissedAlerts`;
- the main window is hidden, minimized, or not focused;
- no notification for the same `id` in the last **30 minutes** (de-escalation and re-activation inside that window are silent; escalation to crit ignores this rule once);
- no other notification in the last **60 s** — otherwise hold it and send one summary `Nexum: <n> new alerts` / `Open Nexum to see them.` when the 60 s pass (pending ones that cleared meanwhile are dropped).
Clicking a notification shows the main window (`navigate "dashboard"`). No sound setting, no actions. Notification permission is the OS default for the app; Nexum does not prompt.

#### 2.10.5 Tray tooltip

Rebuilt at most every 5 s and only when the text changes. Lines joined with `\n`:
1. `Nexum · No alerts` / `Nexum · <n> alert(s)` (`1 alert`, `2 alerts`; from the Rust snapshot only; `Nexum · Agent offline` while the agent is down).
2. Up to **4** tray sensors: ids from `set_tray_sensors` (the UI sends `useSensorLabels().pinned` whenever it changes; in-memory only, empty until the UI sends it). Each line `<label>: <value>` — label as in §2.9, value from the latest `sensorValues` formatted with `SensorMeta.decimals` and unit (temperatures converted to °F when `tempUnit == "F"`), `—` when null or when the latest values are older than 15 s. Ids not in the tree are skipped.
3. If no tray sensor line was produced: fallback lines from telemetry `CPU: <cpu.packageTempC>` and `GPU: <gpu.hotspotTempC ?? gpu.tempC>` (skipped when null).
Truncate at a line boundary so the result is ≤ 127 UTF-16 code units (Windows `szTip` limit). While tray sensors are set and the window is hidden, the sensor stream stays on at the hidden poll interval (§2.9 formula). Tray-icon temperature digits are **not** in v1.1.

`dismiss_alert { dismissKey }`: appends to `Settings.dismissedAlerts` (dedupe, keep last 200), saves, returns `Settings`. It hides Dashboard banners and suppresses notifications for that key; it never removes an alert from the snapshot, the pill or the card.

### 2.11 Drive wear ledger and forecast [NEW 1.1] (B: `drive_history.rs`)

**File:** `%LOCALAPPDATA%\Nexum\history\drives.jsonl`, `%LOCALAPPDATA%` from `FOLDERID_LocalAppData` and verified inside the user profile (same rule as the purge log, §3 rule 11); folders through `safe_fs::PinnedDir::open(<LocalAppData>, …\Nexum\history, true)`. Appending: open the existing file through the pinned folder without following links (`FILE_FLAG_OPEN_REPARSE_POINT`, final-path verified like `create_new_file`; add a `PinnedDir::open_append(name)` helper with the same checks) or create it with `create_new_file`.

**Line format** (one JSON object per line, UTF-8, `\n`):
`{"v":1,"date":"2026-11-27","ts":1764230000000,"serial":"<trimmed serial>","model":"…","healthPct":44,"percentageUsed":56,"dataWrittenTb":12.3,"dataReadTb":20.4,"powerOnHours":20188,"availableSparePct":100,"mediaErrors":0}` (numbers nullable; `dataWrittenTb` = `DiskTelemetry.tbw`). The serial is stored in clear in this local file (never in exports or reports).

**Snapshot cadence:** at most **one line per (normalized serial, local date)**. Rust loads the set of existing `(normSerial, date)` pairs at start, then on the first telemetry packet and every 10 minutes appends a line for each disk with a non-null serial and at least one of `healthPct`, `tbw`, `powerOnHours` non-null, whose pair is not in the set. Corrupt lines are skipped on read. No rotation in v1.1 (~70 KB per drive per year).

**`get_drive_history { serial }`** → `DriveHistory`:
- `{ serial: string /* as given */, points: DriveHistoryPoint[], forecast: DriveForecast }`, `DriveHistoryPoint = { date: "YYYY-MM-DD", healthPct: number|null, dataWrittenTb: number|null, powerOnHours: number|null }`, lines matched by `normSerial` (§1.1.3), sorted by date, the last line per date wins.
- Unknown serial → `points: []` and a `notEnoughData` forecast (not an error). Read error → `Err(message)`.

**Forecast** (`DriveForecast = { tbPerMonth: number|null, monthsTo10Pct: number|null, basisDays: number, points: number, status: "ok"|"notEnoughData"|"noWear"|"noLifeData"|"beyondHorizon" }`):
- Basis = points of the **last 365 days**; `x` = days since the first basis point (from `date`), `basisDays` = span in days, `points` = basis count.
- **Minimum:** ≥ 7 basis points **and** `basisDays ≥ 14`; otherwise both numbers null, `status:"notEnoughData"`.
- `tbPerMonth` = ordinary-least-squares slope of `dataWrittenTb` over `x` (points with non-null values; ≥ 7 needed, else null) × `30.4375`, 2 decimals, floored at 0.
- `monthsTo10Pct`: OLS slope `m` of `healthPct` over `x` (non-null points, ≥ 7 needed, else null + `status:"noLifeData"`). Latest `healthPct` = `h`. If `h ≤ 10` → `0`. Else if `m ≥ −0.001` %/day → null, `status:"noWear"`. Else `(h − 10) / (−m) / 30.4375`, 1 decimal; above **600** months → null, `status:"beyondHorizon"`. Otherwise `status:"ok"`.
- `status` precedence when several apply: `notEnoughData` > `noLifeData` > `noWear` > `beyondHorizon` > `ok`.

### 2.12 Save report [NEW 1.1] (B: `report.rs`)

`save_report { format: "txt"|"html" }` → absolute path of `<Documents>\Nexum\Reports\nexum-report-YYYYMMDD-HHMMSS.<txt|html>` (PinnedDir + `create_new_file`, collision suffix as §2.9).
- Data: the cached `SystemSpec` (calls the §2.6 path with `refresh:false`; fetches if nothing is cached) + `get_physical_disks` for disk names. No hostname, no user name, no serial numbers (none are in `SystemSpec`; disk serials are never printed), no drive-history data.
- Sections in this order, mirroring the System view tabs: `CPU`, `Mainboard`, `Memory` (incl. timings with the source label `Live (memory controller)` / `SPD JEDEC (not the running timings)` / `Not available` + `timingsNote`, MEMCLK/FCLK/UCLK), `SPD` (per DIMM), `Graphics` (incl. PCIe link + note), `Storage links` (`diskLinks` joined to disk model by `diskNumber`), `OS & Security`, then `Notes` (= `errors`). First line `Nexum <app version> system report — <local YYYY-MM-DD HH:MM>`.
- `txt`: UTF-8 with BOM, `\r\n`, `Label ........ value` rows (dot leaders to column 32). `html`: one self-contained UTF-8 document, inline `<style>` only, **no scripts, no external URLs, no images**, every value HTML-escaped; light background so it prints well.
- Returns the path; the UI shows `Saved to <path>` with an `Open folder` button (`open_external` on the folder).

### 2.13 Frame capture, Rust side [NEW 1.1] (B: `frames.rs`)

- **PresentMon path:** `app.path().resolve("presentmon/PresentMon-2.6.0-x64.exe", BaseDirectory::Resource)` (bundled by F, §4.1). If it resolves and `is_file()`, the agent is spawned with `--presentmon "<path>"` (shell sidecar `.args([...])`); else without the flag. Rust does not verify the signature (the elevated agent does, right before spawning).
- **After every `hello`**, if `Settings.fpsCaptureEnabled`: send `frameWindow {sec: fpsWindowSec}`, `frameExclude {names: fpsExcludes}`, then `frames {enabled:true}` — in that order.
- **Caches** (cleared when the agent exits; `session` then becomes null): latest `frameSession`, `frameTarget`, `frameStats`. `get_frame_state` → `FrameState { session: FrameSession|null, target: FrameTarget|null, stats: FrameStats|null }` (cached `stats` is returned with `frametimes: []`).
- Events forward the verbatim lines: `frame-session`, `frame-target`, `frame-stats`.
- `set_frame_capture {enabled}`: save `fpsCaptureEnabled`; if the agent runs, send (when enabling) `frameWindow`, `frameExclude`, `frames {enabled:true}`, or (when disabling) `frames {enabled:false}`; return the saved `Settings`. Never waits for the session to start (the UI follows `frame-session`).
- `set_frame_window {sec}`: integer clamp 5..120, save, forward if running, return `Settings`.
- `save_settings` with changed `fpsCaptureEnabled` / `fpsWindowSec` / `fpsExcludes` (compared with the previously saved values, after sanitization) applies them exactly as the dedicated commands do, so the two paths can never disagree. Likewise a changed `alerts` or `tempUnit` makes `alerts.rs` re-evaluate at once and emit `health-alerts` (new thresholds and texts).
- `set_frame_excludes {names}`: sanitize — trim; keep entries matching `/^[A-Za-z0-9 _.()\-]{1,60}\.exe$/i`; drop the fixed excludes (`dwm.exe`, `msedgewebview2.exe`, `Nexum.exe`, `nexum-agent.exe`); dedupe case-insensitively keeping the first spelling; max 50. Save, forward, return `Settings`.
- `set_frame_target {pid}` and `list_presenting_processes`: one request of each kind in flight (mutex), wait ≤ 3 s for the matching `ack {cmd:"frameTarget"}` / `presentingList` line. Agent not running → `Err("Hardware agent is not running")`; timeout → `Err("Hardware agent did not answer")`.

### 2.14 GPU tuning, Rust side [NEW 1.1] (B: `tuning.rs`)

- `get_tuning_state { refresh? }`: cached `TuningState` (latest `tuningState` line, cleared on agent exit). If `refresh:true` or nothing is cached and the agent runs: send `{cmd:"tuningGet"}`, wait ≤ 12 s, return the new state; on timeout return the cache (may be null). Agent down → `null`. The UI calls it with `refresh:true` every 5 s **only while the GPU tuning tab is visible** (ROADMAP §5.2 item 8).
- `run_tuning_probe { write }`: `write:true` → `Err("The write probe is not available in this version.")` **without sending anything to the agent**. `write:false`: send `{cmd:"tuningProbe","write":false}`, wait ≤ 15 s for the `tuningProbe` line (or an `ack {cmd:"tuningProbe", ok:false}` → `Err(message)`); write `report` (pretty JSON, plus `"nexumVersion"` and `"capturedTs"` at the top level) to `%LOCALAPPDATA%\Nexum\tuning-probe-YYYYMMDD-HHMMSS.json` through PinnedDir/`create_new_file`; update the cache with `report.state`, emit `tuning-state`; return `TuningProbeSummary { ranTs, write:false, ok, message, path: string|null }`.
- Tuning state is never polled while the tab is hidden; no tuning call ever runs at app start.

---

## 3. Cache cleanup safety rules (Rust `cleaner.rs`) — NON-NEGOTIABLE

UI name: "Cache cleanup" / "Reclaimable caches". Internal identifiers (`scan_trash`, `purge_trash`, `TrashCategory`) keep their names; they are not UI copy.

1. Allow-list: only delete *inside* the enumerated category roots (§3.1). Never delete the root itself.
2. Deny-list (checked after canonicalization, case-insensitive): `%WINDIR%\System32`, `%WINDIR%\SysWOW64`, `%WINDIR%\WinSxS`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%WINDIR%\System32\config`, user Documents/Desktop/Pictures/Videos/Music/Downloads/OneDrive, any file named `NTUSER.DAT*`, `UsrClass.dat*`, `*.regtrans-ms`, `*.blf`, and the drive roots themselves. **[NEW]** Also `%ProgramData%\Nexum` and the agent's install folder.
3. Never follow reparse points (symlinks/junctions/mount points): use `symlink_metadata`; if `FILE_ATTRIBUTE_REPARSE_POINT` is set, skip (do not descend; do not delete target).
4. Every delete is individually error-handled; locked/in-use/permission-denied files increment `skipped`.
5. Dry-run (`scan_trash`) and purge use the SAME enumerator and the SAME skip checks (rules 8–10), so reported numbers match. **[CHANGED 1.1]** `scan_trash_details` (§3.3) uses that same enumerator and skip checks too.
6. Browser category never touches `Cookies`, `Login Data`, `Web Data`, `History`, `Local Storage`, `IndexedDB`, `Session Storage`, `*.sqlite` outside cache2.
7. **[BREAKING, rewritten]** Crash dumps: keep the newest 5 and anything < 30 days old; no Prefetch. (`dumps`: a `*.dmp`/`*.mdmp`/`*.hdmp` file is deleted only if it is older than 30 days **and** not among the 5 newest by mtime in its folder. `memory-dump` is the single explicit `MEMORY.DMP` opt-in and has no age guard.) `%WINDIR%\Prefetch` is never touched.
8. **[NEW] Running apps:** a browser's/Discord's cache roots are skipped while that app runs (any process of the current user named `chrome.exe`, `msedge.exe`, `firefox.exe`, `Discord.exe` respectively; `msedgewebview2.exe` does not count). Reported through `note`.
9. **[NEW] Windows Update:** `SoftwareDistribution\Download` is skipped entirely while an update is pending or installing: registry key `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired` exists, or `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending` exists, or service `TrustedInstaller` is running. Nexum never stops or starts services. The 24 h age guard stays.
10. **[NEW] Delivery Optimization** is cleared only through Microsoft's cmdlet: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -Command "<script>"` (no `-IncludePinnedFiles`), `CREATE_NO_WINDOW`, 120 s timeout. **Hardening (elevated child, user-writable search paths):** `%SystemRoot%` = `GetSystemWindowsDirectoryW`; the child gets a cleared environment (only `SystemRoot`, `windir`, `SystemDrive`, `PATH` = System32 folders, `PATHEXT`, `PSModulePath` = `<windir>\System32\WindowsPowerShell\v1.0\Modules`, `PSModuleAnalysisCachePath=NUL`, `TEMP`/`TMP` = `<windir>\Temp`) and working directory System32; `<script>` sets `$ErrorActionPreference='Stop'; $PSModuleAutoloadingPreference='None'`, imports `Microsoft.PowerShell.Utility`, `CimCmdlets` and `DeliveryOptimization` by absolute path from that Modules folder (`-DisableNameChecking`) and calls `DeliveryOptimization\Delete-DeliveryOptimizationCache -Force`. Scan bytes = read-only size of `%WINDIR%\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache`; freed = size before − size after. If the cmdlet is missing or fails, report it in `note`; **never** fall back to deleting those files directly.
11. **[NEW] Audit log:** every purge writes `%LOCALAPPDATA%\Nexum\purge-logs\<YYYYMMDD-HHMMSS>.jsonl` (folder created if needed; `%LOCALAPPDATA%` must lie inside the user's profile, and every folder below the profile and the file itself are created/opened without following reparse points and verified by final path, so the log is never written through a planted link). If the log cannot be created the purge is aborted with `Err("Could not create the cleanup log: …")`. Line 1 `{"type":"header","version":"<app version>","startedTs":…,"isAdmin":…,"categories":[…]}`; one line per file `{"type":"file","categoryId":"temp","path":"…","bytes":123,"mtime":<unix ms>,"result":"deleted"|"skipped"|"failed","reason":null|"locked"|"accessDenied"|"reparsePoint"|"tooNew"|"keptNewest"|"appRunning"|"updatePending"|"denyList"|"<os error text>"}`; one line per cmdlet/bulk action `{"type":"action","categoryId":…,"action":"Delete-DeliveryOptimizationCache"|"SHEmptyRecycleBinW","result":…,"freedBytes":…,"message":…}`; last line `{"type":"summary",…PurgeResult without logPath}`. `PurgeResult.logPath` is the absolute path; "View log" opens its folder through `open_external`.
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
| `recycle` | `Recycle Bin` | **OFF** | no | yes | **[CHANGED 1.1]** with a numeric `recycleMinAgeDays`: §3.2. With `null`: `SHQueryRecycleBinW(null)` for size/count; `SHEmptyRecycleBinW(NULL, NULL, SHERB_NOCONFIRMATION\|SHERB_NOPROGRESSUI\|SHERB_NOSOUND)` |
| `browser` | `Browser and Discord caches` | OFF | no | yes | Only listed when `includeBrowser`. Chrome & Edge `User Data\<profile>\{Cache\Cache_Data, Code Cache, GPUCache}` and `User Data\{ShaderCache, GrShaderCache}`; Firefox `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2`; Discord `%APPDATA%\discord\{Cache, Code Cache, GPUCache}`; rule 8 |
| ~~`standby`~~ | | | | | **[BREAKING]** removed (ROADMAP C5) |

Descriptions (exact for these; others are plain one-sentence descriptions with no banned words):
- `shader`: `Only clear if a game shows corrupted graphics. Expect stutter while caches rebuild.` followed by ` Folders: <comma-separated detected-vendor folder names>.`
- `dumps`: `Keeps the 5 newest dumps and anything less than 30 days old. Windows and support staff use dumps to diagnose crashes.`
- `memory-dump`: `Written by Windows after a system crash (<YYYY-MM-DD>, <size>). Delete it only if you do not need it for troubleshooting.`
- `recycle`: `Permanently deletes everything in the Recycle Bin.` **[CHANGED 1.1]** when `recycleMinAgeDays` is a number: `Permanently deletes items that have been in the Recycle Bin for more than <N> days.` (`1 day` when N = 1).

**Notes** (`TrashCategory.note` at scan time, `PurgeCategoryResult.note` at purge time; one sentence, null when nothing is skipped; exact templates):
- running apps: `Skipped: <App1> and <App2> are open.` / `Skipped: <App> is open.` (names `Chrome`, `Edge`, `Firefox`, `Discord`)
- update pending: `Skipped the Windows Update download cache: an update is waiting to install or restart.`
- DO cmdlet: `Delivery Optimization cache was not cleared: <reason>.`
- unavailable: `Needs administrator rights.`
- several notes in one category are joined with a space.

**Quick path:** with `confirmBeforePurge=false`, F9 runs exactly the ids in `DEFAULT_ON_CATEGORIES` (`temp`, `wu-cache`, `logs`) that are `available`; never `recycle`, `browser`, `dumps`, `memory-dump` or `shader`. The headline is `<available selected bytes> now · <unavailable bytes> more as administrator` (second part only when > 0).

### 3.2 Recycle Bin age filter [NEW 1.1]

Follows Storage Sense ("delete files in my recycle bin if they have been there for over N days"). `recycleMinAgeDays` ∈ {`null`, 1, 14, 30, 60}; default `Settings.recycleMinAgeDays = 30`. `null` keeps the v1.0 behaviour (everything, via `SHEmptyRecycleBinW`).

With a number N:
- Enumerate, for every fixed volume root, `<root>\$Recycle.Bin\<current user SID>\` (SID of the process token; Nexum never touches other users' bins). Each item is a pair `$I<suffix>` (metadata) / `$R<suffix>` (the file or folder).
- Parse `$I`: little-endian `int64 version` (1 or 2), `int64 originalSize`, `FILETIME deletedAt` (offset 16); v2: `int32 pathChars` then UTF-16 path; v1: 260 UTF-16 chars, NUL-terminated. Unknown version or short file → the item is skipped (never deleted).
- An item qualifies when `now − deletedAt ≥ N × 86 400 000` ms. Scan `bytes` = Σ on-disk size of qualifying `$R` entries (folders recursively, reparse points not followed and not counted); `files` = number of qualifying items.
- Purge deletes `$R` first (folders recursively under §3 rules 3–4), then its `$I`; a failure on `$R` keeps the `$I` (the item stays visible in Explorer) and counts as skipped. Audit log lines use `categoryId:"recycle"` with the `$R` path and `reason` per rule 11; no `SHEmptyRecycleBinW` action line in this mode.
- `note` at scan time in this mode (always shown, even when nothing qualifies): `Keeps items deleted in the last <N> days.` (`1 day` when N = 1).

### 3.3 Drill-down: `scan_trash_details` [NEW 1.1]

`scan_trash_details { categoryId, limit, recycleMinAgeDays? }` → `TrashDetailItem[]`, `TrashDetailItem = { path: string, bytes: number, modifiedTs: number|null, kind: "file"|"folder"|"group" }`.
- `limit` integer clamped 1..50 (the UI asks for 50). Sorted by `bytes` desc, then `path` asc.
- Items are exactly what a purge of that category would delete right now: the same roots, enumerator, age guards and skip checks (rules 1–10). Skipped/locked/too-new files are **not** listed. `kind:"file"` for files, `modifiedTs` = last-write time.
- `recycle`: one row per qualifying item (§3.2; with `recycleMinAgeDays == null` every item), `path` = the **original** path from `$I`, `bytes` = `$R` size, `modifiedTs` = `deletedAt`, `kind` = `"folder"` when `$R` is a folder. `recycleMinAgeDays` absent → `Settings.recycleMinAgeDays`.
- `wu-cache`: files under `SoftwareDistribution\Download` as usual, plus one `kind:"group"` row for the Delivery Optimization cache (`path` = the cache folder, `bytes` = its read-only size, `modifiedTs:null`) because the cmdlet, not Nexum, deletes it (rule 10).
- `browser` may be queried regardless of `includeBrowser`.
- Errors: unknown `categoryId` → `Err("Unknown category")`; a category that is unavailable in this session → `Err("Needs administrator rights.")`.
- The UI shows path, size and age (`modifiedTs`), with `Open folder` (`open_external` on the parent folder) except for `recycle` rows (the original folder may no longer exist).

---

## 4. Frontend contract, file ownership and shared modules

### 4.1 File ownership map — v1.1 round (seven implementers, disjoint files) [CHANGED 1.1]

Replaces the 1.0.0-gate map. Nobody edits a file owned by someone else. If you need a change in another owner's file, code against the interface written here and note it in your report. A path not listed belongs to nobody this round (do not edit it).

| Id | Owner of | Paths | Work items |
|---|---|---|---|
| **A1** | Sidecar: frames + wiring | `nexum-agent/Program.cs` (dispatch for **all** new commands, including A2's; `--presentmon` arg; protocol 3 / version 1.1.0 constants; shutdown order), `nexum-agent/NexumAgent.csproj` (version 1.1.0; no new packages), `nexum-agent/Frames/**` (new: `FrameMonitor.cs`, trust check, CSV parser, target tracker, stats, `FrameModels.cs` DTOs, `HEADER-2.6.0.txt`), `nexum-agent/SelfTest.cs` (frames parser/stats tests) | §1.1 hello/args, §1.2 dispatch, §1.6 entirely, §1.7.2 wiring |
| **A2** | Sidecar: hardware | `nexum-agent/Models.cs` (spec DTOs, `GpuTelemetry.memJunctionTempC`), `nexum-agent/SystemSpec.cs`, `nexum-agent/GpuMonitor.cs`, `nexum-agent/Spec/**` (new: `MemoryTimings.cs`, `PciBusGuard.cs`, `SpdReader.cs`, `PcieLinks.cs`), `nexum-agent/Tuning/**` (new: `AdlNative.cs`, `TuningService.cs`, `TuningModels.cs`) | §1.1.1 memJunction, §1.4.1, §1.7.1/.3/.4 |
| **B** | Rust core | `src-tauri/**` **except** `src-tauri/tauri.conf.json` and `src-tauri/icons/**` (includes `Cargo.toml` — may add `tauri-plugin-notification` 2.x —, `Cargo.lock`, `build.rs`, `capabilities/**`). New modules: `frames.rs`, `sensor_log.rs`, `alerts.rs`, `drive_history.rs`, `report.rs`, `tuning.rs`; changes in `agent.rs`, `lib.rs` (tray, handlers), `settings.rs`, `spec.rs`, `cleaner.rs`, `safe_fs.rs` (`open_append`) | §2 (all 1.1 rows), §2.9–§2.14, §3.2, §3.3 |
| **C** | Frontend core | `src-frontend/types.ts` (finalize; only additive fixes after this contract), `src-frontend/lib/**` (incl. `lib/mock.ts`), `src-frontend/hooks/**`, `src-frontend/App.tsx`, `src-frontend/main.tsx`, `src-frontend/styles/**`, `src-frontend/components/layout/**` (incl. `SettingsModal.tsx`: Alerts, Notifications, Frame capture, Sensor log interval, Recycle Bin age), `src-frontend/components/ui/**`, `src-frontend/components/feedback/**` | §4.3–§4.6 1.1 additions, §5 1.1 changes, keymap, tray-sensor sync, mock for every new command/event |
| **D** | Gaming + tuning UI | `src-frontend/views/GamingView.tsx` (new), `src-frontend/components/gaming/**` (new; incl. `FrametimeChart.tsx`), `src-frontend/components/tuning/**` (new; default export `GpuTuningPanel` from `components/tuning/GpuTuningPanel.tsx`, no props) | §4.10.1 |
| **E** | Existing views | `src-frontend/views/DashboardView.tsx`, `SensorsView.tsx`, `SystemView.tsx`, `StorageView.tsx`, `CoolingView.tsx`, `CleanerView.tsx`, `DriversView.tsx` (no change expected); `src-frontend/components/{telemetry,storage,drivers,fans,cleaner,sensors,system}/**` | §4.10.2 |
| **F** | CI, packaging & docs | `.github/**`, `src-tauri/tauri.conf.json` (bundle.resources for PresentMon; version 1.1.0), `licenses/**` (`licenses/PresentMon/LICENSE.txt`, `licenses/ADL/` header text, ZenStates-Core attribution, `THIRD_PARTY.txt`), `README.md`, `SECURITY.md`, `docs/**` except `docs/screenshots/**` and the gitignored `docs/target-hardware.md`, root `package.json` (version 1.1.0 only), `.gitignore` (`build/presentmon/`) | §7 1.1 items |

`CONTRACT.md` is owned by the contract owner; implementers do not edit it. `LICENSE`, `src-tauri/icons/**`, `docs/screenshots/**`: nobody this round.

**PresentMon packaging (F, consumed by B and A1):** CI downloads `https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe` into `build/presentmon/` (gitignored, never committed), checks SHA-256 `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` and `Get-AuthenticodeSignature` = `Valid` with a subject starting `CN=Intel Corporation`, **before any job that compiles `src-tauri`** (tauri-build validates resources). `tauri.conf.json` `bundle.resources` gains `"../build/presentmon/PresentMon-2.6.0-x64.exe": "presentmon/PresentMon-2.6.0-x64.exe"` (the existing `"../licenses/": "licenses/"` entry already ships `licenses/PresentMon/LICENSE.txt`). The signing configuration must never re-sign it (MF-8 item 7); the Authenticode CI check expects it `Valid` as Intel-signed.

**Agent entry points A2 exposes to A1** (exact signatures; A1 codes against them before A2 lands, using a stub in a throwaway branch only):
```csharp
namespace NexumAgent.Tuning;
public static class TuningService
{
    public static TuningStateMessage GetState(bool isAdmin);   // never throws, ≤ 10 s, thread-safe
    public static TuningProbeMessage ProbeReadOnly(bool isAdmin); // never throws, ≤ 10 s, thread-safe
}
// TuningStateMessage / TuningProbeMessage: sealed classes in Tuning/TuningModels.cs serialized by Program.Emit
// (camelCase, nulls written) to exactly the §1.7.3 / §1.7.4 JSON, including "type".
```
The System-spec work needs **no** new entry point: `SystemSpec.CaptureLhm(TelemetryService)` and `SystemSpec.Build(SystemSpec.LhmFacts, StaticInfo)` keep their signatures and A2 extends them internally. `Program.IsAdmin` and `Program.SensorDriverOk` stay public static for A2 to read.

### 4.2 Work split by v1.1 item [CHANGED 1.1]

| Item | A1 | A2 | B | C | D | E | F |
|---|---|---|---|---|---|---|---|
| (1) FPS + Gaming | §1.6, wiring | – | §2.13, `--presentmon` | `useFrames`, `lib/frames.ts`, keymap F8/Ctrl+8, mock `?fps=on` | GamingView, gaming components | Dashboard 6th KPI | bundle.resources, CI download/verify, licence, README anti-cheat notes |
| (2) CSV logging | – | – | §2.9, tray item | `useSensorLog`, Settings interval | – | Sensors view log controls | docs |
| (3) Alerts | – | `memJunctionTempC` | §2.10, notifications, tray tooltip | `useHealthAlerts`, `deriveHealth` change (§5), tray-sensor sync, Settings Alerts section | – | Health alerts card/banners consume conditions (unchanged API) | Tjmax table re-check in docs |
| (4) Drive ledger | – | – | §2.11 | `useDriveHistory` | – | Storage drawer forecast | – |
| (5) System full | wiring unchanged | §1.4.1 | §2.6 diskLinks, §2.12 report | `useSystemSpec` (unchanged API), mock data | – | System view timings/SPD/links/Save report | ZenStates attribution |
| (6) Tuning read-only | §1.7.2 wiring | §1.7 | §2.14 | `useTuningState` | GpuTuningPanel | Cooling tab shell | CI read-only ADL check, ADL licence text |
| (7) Cleaner extras | – | – | §3.2, §3.3 | api + Settings | – | Cleaner drill-down, Recycle age control | – |

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

**[NEW 1.1] api additions (exact):**
```ts
  scanTrash(includeBrowser: boolean, recycleMinAgeDays?: number | null): Promise<TrashScan>,            // [CHANGED 1.1]
  purgeTrash(categories: readonly TrashCategoryId[], recycleMinAgeDays?: number | null): Promise<PurgeResult>, // [CHANGED 1.1]
  scanTrashDetails(categoryId: TrashCategoryId, limit?: number /* 50 */, recycleMinAgeDays?: number | null): Promise<TrashDetailItem[]>,
  getFrameState(): Promise<FrameState>,
  setFrameCapture(enabled: boolean): Promise<Settings>,
  setFrameTarget(pid: number | null): Promise<void>,
  setFrameWindow(sec: number): Promise<Settings>,
  setFrameExcludes(names: string[]): Promise<Settings>,
  listPresentingProcesses(): Promise<PresentingProcess[]>,
  startSensorLog(opts?: { intervalMs?: number; ids?: string[] | null }): Promise<SensorLogStatus>,
  stopSensorLog(): Promise<SensorLogStatus>,
  getSensorLogStatus(): Promise<SensorLogStatus>,
  getHealthAlerts(): Promise<HealthAlertsSnapshot>,
  dismissAlert(dismissKey: string): Promise<Settings>,
  setTraySensors(ids: string[]): Promise<void>,
  getDriveHistory(serial: string): Promise<DriveHistory>,
  saveReport(format: ReportFormat): Promise<string>,
  getTuningState(refresh?: boolean): Promise<TuningState | null>,
  runTuningProbe(write: boolean): Promise<TuningProbeSummary>,   // the UI only ever passes false
```
Event names are the `EVENTS` constants in `types.ts` (existing and new).

**[NEW 1.1] mock (`lib/mock.ts`, C) must serve every new command and event**, with the §2 error strings:
- Frame capture: off by default (`fpsCaptureEnabled:false`, session `stopped`). `?fps=on` → the mock starts as enabled. With `?rig=owner` **and** capture enabled: a running game `Game.exe` (generic name, pid 18320, title `Game`), `DXGI`, `Hardware: Independent Flip`, ~140 fps with realistic jitter and an occasional 30–40 ms spike, cpuBusy ≈ 4.8 ms, gpuBusy ≈ 6.6 ms (`boundBy:"gpu"`), 1 Hz `frame-stats` with real `frametimes` batches; a second presenting app (`Launcher.exe`, ~30 fps) in `list_presenting_processes`. Other rigs with capture on: session `running`, target `none` (no game). `?fps=error` → session `error`, code `signatureInvalid`.
- Sensor log: start/stop with a ticking `rows` counter and path `C:\Users\User\Documents\Nexum\Logs\nexum-<ts>.csv`.
- Health alerts: `?rig=owner` → one `drive:*` warn (`Worn`, 44%) + `cpuLimit {model:"5700X3D", limitC:90, warnC:85, source:"table"}`; default rig → `source:"default"`; `?alerts=hot` → add a `cpu-temp` crit and a `gpu-temp:0` warn.
- Drive history: ≥ 60 daily points for the owner rig's worn NVMe (life 47% → 44%, ~0.9 TB/month) → forecast `status:"ok"`; another drive with 3 points → `notEnoughData`.
- System spec: owner rig DDR4-3200 `timingsSource:"umc"` (16-18-18-36, 1T, GDM on), `memclkMhz:1600, fclkMhz:1600, uclkMhz:1600`, `dimms[].spd` (JEDEC 2666 cycles), GPU link `{gen:4, width:16, maxGen:4, maxWidth:16, source:"adl"}`, NVMe link Gen3 x4; `?admin=0` → `timingsSource:"unavailable"` with the notElevated note.
- Tuning: owner rig → `supported:true`, RX 9070 XT-like ranges (power −30..+10%), `isFactory:true`; `?gpu=nvidia` or default rig → `supported:false, reason:"noAmdGpu"`; probe returns a summary with a fake path.
- Cleaner: `scan_trash_details` returns plausible top-50 lists (generic paths under `C:\Users\User\…`).

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
- **[NEW]** `hooks/useHealth.ts` — `useHealth(): SystemHealth` (memoized `deriveHealth` over telemetry, agent, volumes, physical disks, failsafe, settings, `now` ticking each second). **[CHANGED 1.1]** also over `useHealthAlerts().snapshot` (§5).

**[NEW 1.1] hooks (C) — exact exports:**
- `hooks/useFrames.ts` — `FramesProvider` (mounted in `App.tsx` above every view); `useFrames(): { enabled: boolean /* settings.fpsCaptureEnabled */; session: FrameSession|null; target: FrameTarget|null; stats: FrameStats|null; statsFresh: boolean /* stats != null && stats.pid === target?.pid && now − stats.ts ≤ 3000 */; frametimes: readonly number[] /* rolling: concatenation of the last fpsWindowSec frame-stats batches for the current target, oldest first; cleared when the target pid changes */; setEnabled(on: boolean): Promise<void>; setTarget(pid: number|null): Promise<void>; setWindow(sec: number): Promise<void>; setExcludes(names: string[]): Promise<void>; listPresenting(): Promise<PresentingProcess[]> }`. Calls `get_frame_state` on mount, then follows `frame-session`/`frame-target`/`frame-stats`; resets on `agent-status` with `running:false`.
- `hooks/useSensorLog.ts` — `useSensorLog(): { status: SensorLogStatus; start(opts?: { intervalMs?: number; ids?: string[]|null }): Promise<void>; stop(): Promise<void>; openFolder(): Promise<void> }` (`get_sensor_log_status` on mount, then `sensor-log`).
- `hooks/useHealthAlerts.ts` — `useHealthAlerts(): { snapshot: HealthAlertsSnapshot; dismiss(dismissKey: string): Promise<void> }` (`get_health_alerts` on mount, then `health-alerts`; initial `EMPTY_ALERTS_SNAPSHOT`).
- `hooks/useDriveHistory.ts` — `useDriveHistory(serial: string|null): { history: DriveHistory|null; loading: boolean; error: string|null; reload(): Promise<void> }` (fetches when `serial` changes; null serial → `history:null`).
- `hooks/useTuningState.ts` — `useTuningState(active: boolean): { state: TuningState|null; loading: boolean; error: string|null; refresh(): Promise<void>; runProbe(): Promise<TuningProbeSummary> }`: while `active`, calls `get_tuning_state {refresh:true}` immediately and every 5 s; when inactive, never calls; listens to `tuning-state`. `runProbe` always passes `write:false`.
- `hooks/useTraySensorSync.ts` — `useTraySensorSync(): void`, mounted once in `App.tsx`: sends `set_tray_sensors` with `useSensorLabels().pinned` on mount and whenever that list changes.

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
- **[NEW 1.1]** `lib/frames.ts` (C) — `fpsKpi(f: { enabled: boolean; session: FrameSession|null; target: FrameTarget|null; stats: FrameStats|null; statsFresh: boolean }): { visible: boolean; fps: number|null; low1: number|null; process: string|null }` — **the 6th Dashboard KPI rule**: `visible = enabled && session?.state === "running" && target?.reason !== "none" && target?.pid != null && statsFresh`; `boundByLabel(b: FrameBoundBy|null): string` (`GPU-bound`, `CPU-bound`, `Balanced`, `Frame-rate capped`, `—`); `fmtFps(n: number|null): string` (0 decimals ≥ 100, else 1 decimal; `—` for null); `fmtFrametime(ms: number|null): string` (2 decimals + ` ms`); `presentModeBadge(mode: string|null): { label: string; tone: StatusTone; title: string }` (`Hardware: Independent Flip`/`Hardware Composed: Independent Flip` → ok `Independent Flip`; `Hardware: Legacy Flip`/`…Copy to front buffer` → info `Exclusive fullscreen`; `Composed: *` → warn `Composed` with title `Windows composes this window, which adds latency.`; other/null → unknown).
- **[NEW 1.1]** `lib/alerts.ts` (C) — `alertToCondition(a: HealthAlert): HealthCondition` (copies `id, severity, source, group, short, title, detail, rule, dismissKey`; `action` by source: `drive` → `{label:"View drive", nav:{view:"storage", focus:a.subjectId}}`; `space` → `{label:"View storage", nav:{view:"storage"}}`; `cpu`/`gpu` → `{label:"View sensors", nav:{view:"sensors", focus:a.sensorId}}`); `fmtForecast(f: DriveForecast): string` (`About <n> months to 10% life at the current rate` / `<x> TB written per month` / status texts: notEnoughData `Forecast after 7 days of history (2 weeks minimum).`, noWear `No measurable wear in the last year.`, noLifeData `This drive does not report remaining life.`, beyondHorizon `More than 50 years at the current rate.`).
- **[CHANGED 1.1]** `lib/status.ts` `deriveHealth` input gains `alerts: HealthAlertsSnapshot` (§5). `HEALTH_RULES.cpuTemp/gpuTemp/driveTemp/space` are no longer used for conditions (rule texts now come from `alerts.rules`). **[NEW 1.1]** `spaceThresholds(s: Settings): { warnPct: number; critPct: number }` (§5.0); `level "checking"` → `StatusPill` tone `unknown`, label `Checking`.

### 4.6 Keymap, views and navigation [BREAKING, C2 / §6.5]

- **[BREAKING 1.1]** `ViewId = "dashboard" | "sensors" | "system" | "storage" | "cooling" | "drivers" | "gaming" | "cleaner"` (`"gaming"` added).
- Function keys (`FKEY_MAP` in `types.ts`): **F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F8 Gaming [NEW 1.1] · F9 Clean caches**. F10 is never bound. **[BREAKING 1.1]** `Ctrl+1..8` → `VIEW_ORDER[n−1]` = Dashboard, Sensors, System, Storage, Cooling, Drivers, **Gaming**, Cleaner (Cleaner moves from Ctrl+7 to Ctrl+8). Tab label `Gaming`. The Gaming tab is always present (it shows the opt-in card while capture is off).
- F8 is `preventDefault`ed like the other F-keys. F5 on Gaming refreshes the presenting list; on the Cooling GPU tuning tab it calls `useTuningState().refresh()`.
- Global handler rules (C, `App.tsx`): `preventDefault` on every F-key above and on F5/Ctrl+F5/Shift+F5/Ctrl+R in production (never reload the WebView); F7 is always `preventDefault`ed (caret browsing); keys are ignored while focus is in `input`, `textarea` or `[contenteditable]` (except Esc); F1–F9 are ignored while a modal is open; **when `view === "sensors"` the global F2 is a no-op** and the Sensors view handles F2 as "rename selected row"; Esc closes modals.
- F5 = Rescan: `useSystemInfo().refresh()`, `useDriverScan().rescan()` when on Drivers, `useSystemSpec().refresh()` when on System, cleaner rescan when on Cleaner.
- F9 / top-bar **"Clean caches (F9)"** (ghost button, not gold): opens `<OneClickPurgeModal open onClose autoStart />` with `autoStart = (opened by F9) && !settings.confirmBeforePurge`. The tray's `quick-clean` always opens with `autoStart=false`. `cleaner` is both a page (CleanerView) and this modal.
- Views (`src-frontend/views/`, default export, no props): `DashboardView`, `SensorsView`, `SystemView`, `StorageView`, `CoolingView`, `DriversView`, `GamingView` **[NEW 1.1]**, `CleanerView`. Tab labels: `VIEW_LABELS`. C lazy-loads `GamingView` like the others.
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
- **[NEW 1.1]** Gaming and tuning copy: never "boost", "game mode", "game booster" or "FPS boost"; AMD's boost clock is shown as `Max clock`. The GPU tuning panel never says "overclock", "tune" as a call to action, or "unlock" — it is read-only. Frame capture never claims to be "safe with anti-cheat"; it states what it does (ETW, no injection) and that the anti-cheat matrix is untested until the README says otherwise.
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

#### 4.10.1 v1.1 Gaming view and GPU tuning panel (D) [NEW 1.1]

- **GamingView (F8)** uses `useFrames()` only (no direct `api` calls except through the hook).
  - **Capture off** (`!enabled`): an opt-in card: title `Frame capture is off`; body `Nexum can measure frame rate and frame times with Intel PresentMon, which reads Windows performance events (ETW). Nothing is injected into games and no game files or processes are touched.`; second paragraph `Start Nexum before launching games that use EA Javelin anti-cheat: frame capture must already be running when they start.`; button `Turn on frame capture` → `setEnabled(true)`. No other controls.
  - **Session line** (always when enabled): from `session` — running: `Intel-signed PresentMon 2.6.0 · session NexumFrames` with a `Turn off` button; starting: spinner + message; error: rose `HealthBanner`-style bar with `session.message` and `Try again` (→ `setEnabled(false)` then `setEnabled(true)`).
  - **No target** (`target?.reason === "none"` or null): empty state `No game detected. Start a game, or pick an app below.` plus the target picker.
  - **Hero:** `fmtFps(stats.fpsAvg)` labelled `Rendered FPS (game)` with an info tooltip: `Frames the game rendered. Frames added by AMD driver frame generation (AFMF) may not be counted.`; next to it `P1` and `P0.1` (`fpsLow1`, `fpsLow01`) with the §1.6.5 definition tooltip; `Avg frame time` (`frametimeAvgMs`), `Max` (`frametimeMaxMs`), `Displayed FPS` (`fpsDisplayedAvg`, hidden when null), `Dropped` (`droppedPct`). A null value renders `—` with `title` = why (`Needs at least 100 frames in the window.` / `Needs at least 1000 frames in the window.`).
  - **Frametime chart** (`components/gaming/FrametimeChart.tsx`, ECharts via the `EChart` primitive): line of `useFrames().frametimes` (x = frame index, y = ms, auto max with a floor of 20 ms), horizontal reference bands/lines at `FRAMETIME_BANDS_MS` (16.7 ms `60 Hz`, 8.3 ms `120 Hz`, 6.9 ms `144 Hz`) with labels; no animation; rendering paused while `document.hidden`; updates at most once per animation frame.
  - **CPU vs GPU busy:** two horizontal bars `CPU busy <ms>` / `GPU busy <ms>` against `frametimeAvgMs`, and a badge `boundByLabel(stats.boundBy)` with a hover listing the §1.6.5 rule and the HAGS note: `GPU timing is less accurate with Hardware-Accelerated GPU Scheduling on (about 0.5 ms high).`
  - **Present mode badge:** `presentModeBadge(stats.presentMode)`; plus `runtime`, `V-Sync: on/off` (syncInterval > 0), `Tearing allowed` (allowsTearing).
  - **Target picker:** `Auto (foreground game)` + `listPresenting()` items (`<process> · <fps> fps`, refreshed on open and on F5) → `setTarget(pid|null)`; shows `target.reason` (`Following the foreground app` / `Pinned by you`).
  - **Window selector:** `Segmented` 10 / 30 / 60 / 120 s → `setWindow`.
  - **Excludes editor:** list of `fpsExcludes` with remove buttons and an input `name.exe` + `Add` (validation identical to §2.13; invalid → inline `Use the program's file name, for example obs64.exe.`) → `setExcludes`.
  - Footer note (small, muted): `Known limits: some apps (runtime "Other") report less detail; frames from driver frame generation may not be counted.`
- **GpuTuningPanel** (`components/tuning/GpuTuningPanel.tsx`, default export, **no props**), rendered by Cooling's `GPU tuning` tab only while that tab is selected; uses `useTuningState(true)` while mounted.
  - Header text (always): `Read-only. Nexum shows the GPU's tuning ranges and current values but does not change them in this version.`
  - `supported:false` → `<Unavailable reason="unsupported">`-style empty state with `state.message`.
  - Otherwise: adapter name; `Mode` (`Factory settings` / `Custom (set in AMD Software)` / `Auto Undervolt`), `Power limit` current % with the range `min … max %` and default; `Auto Undervolt` on/off; `Zero RPM` on/off; GPU max clock and memory max clock with ranges; voltage offset (only when capped); fan curve as a read-only 5-point chart (temperature → %); `Power mode` raw value; `VPU recoveries since boot` (`vpuRecoveryCount`, `—` when null). Every value carries `title` = its range and default.
  - Button `Run read-only probe` → `runProbe()`; afterwards `Saved the probe report to <path>.` with `Open folder`. **No control that changes a value exists in the panel** (no sliders, no inputs, no Apply).

#### 4.10.2 v1.1 changes to existing views (E) [NEW 1.1]

- **Dashboard:** 6th KPI card `FPS` (value `fmtFps(fps)`, sub-label `P1 <low1> · <process>`) shown **only** while `fpsKpi(useFrames()).visible`; clicking it navigates to `gaming`. The strip re-flows from 5 to 6 cards without layout jump (grid `repeat(auto-fit, minmax(…))`). Health alerts card and banners keep their props; their data now comes partly from Rust via `deriveHealth` (§5) — no change needed in E's components beyond texts.
- **Sensors:** a `Log to CSV` control group in the toolbar: interval `Segmented` 1 / 2 / 5 / 10 s (bound to `Settings.sensorLogIntervalMs`), `Start log` / `Stop log` button (`useSensorLog`), while active `Logging <sensorCount> sensors · <rows> rows` and `Open folder`; on error the `status.error` text in rose. `Start log` logs `ids:null` (§2.9 default set) unless rows are selected, then `ids` = the selected ids. Remove the v1.0 "No logging in v1.0." note.
- **System:** Memory tab shows `Timings` rows `CL-tRCDRD-tRCDWR-tRP-tRAS` as `16-18-18-18-36`, then `tRC`, `tRFC`, `tRRDS/tRRDL`, `tFAW`, `tWTRS/tWTRL`, `tWR`, `tRTP`, `tCWL`, `Command rate`, `Gear-down mode`, with a source chip `Live (memory controller)` / `SPD JEDEC (not the running timings)` and the `timingsNote` below when non-null; `MEMCLK`, `FCLK`, `UCLK` rows (`—` + `Not reported by this hardware` when null). SPD tab per DIMM adds `JEDEC timings at <jedecSpeedMts> MT/s` (cycles) and the ns table, and `Module temperature` when `spd.tempC` is non-null. CPU tab shows `codename`. Graphics tab adds `PCIe link: Gen <gen> x<width> (max Gen <maxGen> x<maxWidth>)` + `note`. A Storage-links block (in the OS & Security tab or a new `Storage` sub-section) lists `diskLinks` joined to the disk model. Toolbar: `Save report` menu (`Text (.txt)`, `Web page (.html)`) → `saveReport`, then a toast `Saved to <path>` + `Open folder`. `Copy as text` stays.
- **Storage:** the S.M.A.R.T. drawer gains a `Wear history` section (`useDriveHistory(tele.serial)`): a small line chart of `healthPct` over `points[].date` (and `dataWrittenTb` on a second axis), and `fmtForecast(history.forecast)`; hidden when the drive has no serial.
- **Cooling:** two tabs `Case fans` (all v1.0 content) | `GPU tuning` (renders `<GpuTuningPanel />` from D, mounted only while selected). Tab choice is remembered per session in component state (no setting).
- **Cleaner:** each category row gets a `Show files` disclosure → `scanTrashDetails(id, 50, recycleMinAgeDays)` list (path middle-truncated with full path in `title`, size, age as `3 days ago`/`2 months ago`, `Open folder` per §3.3), loading/error states; the Recycle Bin row gets an age control `Segmented` `All` / `1 day` / `14 days` / `30 days` / `60 days` bound to `Settings.recycleMinAgeDays` (null = All) and passed to `scanTrash`/`purgeTrash`/`scanTrashDetails`; changing it rescans that estimate. Copy per §4.8.

---

## 5. Health status derivation (frontend + Rust alerts) [CHANGED 1.1]

Implemented once in `lib/status.ts` `deriveHealth` (C). Consumed by the header pill (C), the Health alerts card and the Dashboard banners (E).

### 5.0 One source of truth per condition (1.1) [CHANGED 1.1]

| Condition id | v1.0 rule # | Evaluated by (1.1) | How `deriveHealth` gets it |
|---|---|---|---|
| `fan-failsafe` | 1 | frontend | from `FanFailsafeState` (unchanged) |
| `agent-offline` | 2 | frontend | unchanged |
| `fan-override` | 3 | frontend | unchanged (agent `fanSafety`) |
| `drive:<id>` | 4 | **Rust** §2.10 | `alerts.alerts` mapped with `alertToCondition` |
| `cpu-temp` | 5 | **Rust** | same (thresholds per-model, sustained `sustainSec`, default 60 s — no longer 10 s) |
| `gpu-temp:<i>` | 6 | **Rust** | same |
| `gpu-mem-temp:<i>` | – (new) | **Rust** | same |
| `drive-temp:<id>` | 7 | **Rust** | same |
| `space:<letter>` | 8 | **Rust** | same (threshold from `Settings.alerts.freeSpacePct`) |
| `limited-mode` | 9 | frontend | unchanged |
| `drive-unknown:*` | 10 | frontend | unchanged (info only, never notified) |

Rules for `deriveHealth` 1.1 (input gains `alerts: HealthAlertsSnapshot`):
- It **must not** compute rules 4–8 any more (delete that code and the 10 s `sustained` helper's use for them). It appends `alerts.alerts.map(alertToCondition)` — except that when `offline` is true it drops every Rust alert whose `source` is not `space` (Rust clears them too; this covers the stale gap).
- Display order: severity (crit, warn, info), then the v1.0 rule number of the table above (`gpu-mem-temp` sorts right after `gpu-temp`), then the order Rust sent.
- `rules` (pill hover, empty card) = frontend rule texts (1, 2, 3, 9, 10 in that order) followed by `alerts.rules`.
- **Checking state [NEW 1.1]:** while `!alerts.ready` and the agent is online and no crit/warn/info condition exists, `level = "checking"`, `label = "Checking"`, `summary = null`, pill tone `unknown`. It never shows `Optimal` before Rust has evaluated once.
- Dashboard banners (§5.4): unchanged rule (drive conditions only), now fed by the Rust drive alerts; Dismiss calls `api.dismissAlert(dismissKey)` (same effect as the v1.0 `settings.update`). `dismissKey` formats are unchanged (`drive:<id>:<health.state>`), so v1.0 dismissals stay valid.
- Components that show a free-space colour (`StorageGauge`, `VolumeList`, E) take warn/crit from `Settings.alerts.freeSpacePct` via `spaceThresholds(settings)` in `lib/status.ts` (C): `{ warnPct: freeSpacePct, critPct: max(1, floor(freeSpacePct / 2)) }`.

The v1.0 text below (§5.1–§5.4) stays authoritative for the frontend-owned rules, texts, level/summary logic and banners; for rules 4–8 it now documents what Rust reproduces (§2.10.3 is authoritative for them).

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
- `summary`: take the conditions of the top severity; group by `group` (`drive:<health.label>`, `cpu-temp`, `gpu-temp`, `gpu-mem-temp` **[NEW 1.1]**, `drive-temp`, `space`, otherwise the id). If exactly one group: its short text, with `1 drive` replaced by `<n> drives` when the group has n > 1 members (`2 drives worn`, `2 drives: check sectors`; non-drive groups keep their short text); otherwise `<total> alerts`. `optimal` → null.
- `HealthCondition.action` is a `HealthAction`: `{label, nav}` → `requestNavigate(nav)`; `{label, command:"restartAsAdmin"}` → `api.restartAsAdmin()`; `{label, command:"getPawnIo"}` → `api.openExternal("https://pawnio.eu/")`.
- Pill text = `label` + (summary ? ` · ` + summary : ""), e.g. `Attention · 1 drive worn`. Pill tone: critical→crit, attention→warn, partial→unknown, optimal→ok. Hover lists active conditions' titles, then `rules`.
- **Optimal** therefore requires: agent connected, no limited reasons, every drive `good`, no temperature or space condition, no fan safety condition.

### 5.4 Health alerts card and banners (E)

- Dashboard **Health alerts** card replaces the Thermal & Load Index card: lists `conditions` (crit, warn, then info) with tone icon, title, detail and action button; when empty, `No active alerts` followed by the `rules` list.
- Dashboard **banners**: one `HealthBanner` per drive condition (rule 4) with severity warn/crit whose `dismissKey` is not in `settings.dismissedAlerts`; Dismiss appends the key. A worse state produces a new key, so the banner returns. Dismissal never hides the pill or the card.
- App-level banners (C, above every view): fan fail-safe (`useFanFailsafe`, always first) and limited mode (rule 9 data; buttons `Restart as administrator` → `api.restartAsAdmin()`, `Get PawnIO` → `api.openExternal("https://pawnio.eu/")`; not shown when `sensorDriverChoice === "none"` and the only reasons are PawnIO ones — the pill still says Partial sensors).
- First-run PawnIO screen (C, MF-3): shown once when `sensorDriverChoice === "undecided"` and the agent reports `pawnIoMissing` or `pawnIoOutdated`. Explains that PawnIO is a vendor-signed kernel driver installed from the official site, needs ≥ 2.1.0, and that Nexum never installs or uninstalls it. Buttons: `Get PawnIO` (opens pawnio.eu, sets `"pawnio"`) and `Continue without kernel driver` (sets `"none"`).

---

## 6. Breaking-change checklists

### 6.1 1.1.0 [NEW 1.1]

| Change | Layers |
|---|---|
| Agent protocol **3** (`hello.protocol`, `AGENT_PROTOCOL`); Rust mismatch check compares with 3 | A1, B, C (mock) |
| `ViewId` gains `"gaming"`; `VIEW_ORDER` inserts Gaming before Cleaner, so **Ctrl+7 = Gaming and Ctrl+8 = Cleaner** (was Ctrl+7 Cleaner); `FKEY_MAP` binds F8; `NavTarget`/`navigate` gain `"gaming"`; tray gains `gaming` and `sensor-log` items | B, C, D, E (any `Record<ViewId, …>`), F (README keymap) |
| `MemorySpec.timings` re-typed `null` → `MemoryTimings \| null`; `timingsSource` `"unavailable"` → `"umc" \| "spd" \| "unavailable"`; new required `timingsNote`, `memclkMhz`, `fclkMhz`, `uclkMhz`; `DimmSpec.spd`, `GpuSpec.link`, `AgentSpec.diskLinks`, `SystemSpec.diskLinks` added (required members, nullable values) | A2, B (spec merge), C (mock), E (System view) |
| `deriveHealth` input gains `alerts`; rules 4–8 move to Rust (§5.0); `SystemHealthLevel` gains `"checking"` (any exhaustive `switch`/`Record` over it must handle it) | B, C, E |
| `Settings` gains required members `fpsCaptureEnabled`, `fpsWindowSec`, `fpsExcludes`, `sensorLogIntervalMs`, `alerts`, `recycleMinAgeDays` (Rust `#[serde(default)]` keeps old files loading) | B, C |
| `TelemetryPacket.gpus[]/gpu` gain required `memJunctionTempC` (nullable) | A2, C (mock) |

Additive (not breaking): every new command, event and message; optional `recycleMinAgeDays` args on `scan_trash`/`purge_trash`.

### 6.2 1.0.0-gate (historical)

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

7. **[NEW 1.1] PresentMon at build time:** a step before every job that compiles `src-tauri` downloads the pinned `PresentMon-2.6.0-x64.exe` (v2.6.0 release asset) into `build/presentmon/`, fails unless SHA-256 = `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` and `Get-AuthenticodeSignature` = `Valid` with a subject starting `CN=Intel Corporation`. The URL and hash live in one place (`.github/presentmon.json`, `{ "version":"2.6.0", "url":…, "sha256":… }`); updating it is a deliberate PR (ROADMAP §4.3 gate 4). The release-asset Authenticode check (item 2) treats this file as third-party-signed (Intel) and must find it `Valid`; the signing step must skip it. `check-network.mjs` does not scan `.github/**` (build-time download is allowed; runtime code is not).
8. **[NEW 1.1] Licences:** `licenses/PresentMon/LICENSE.txt` (MIT, copied from the v2.6.0 tag), `licenses/ADL/LICENSE.txt` (the MIT notice text from `include/adl_sdk.h`, ROADMAP V2), ZenStates-Core attribution (GPL-3.0, register map in `nexum-agent/Spec/MemoryTimings.cs`), and a root-level `licenses/THIRD_PARTY.txt` listing every bundled third-party component, its licence and its upstream URL; `licenses/README.md` updated.
9. **[NEW 1.1] Read-only tuning check:** fail if any file under `nexum-agent/Tuning/**` (or anywhere in `nexum-agent/**/*.cs`) contains an ADL entry point matching `/ADL2?_\w*_Set(?![a-z])\w*/`, or if any file under `nexum-agent/Tuning/**` other than `AdlNative.cs` contains `DllImport`/`LibraryImport`, or if any file under `nexum-agent/Tuning/**` contains `GetProcAddress`, `NativeLibrary.`, `delegate* unmanaged` or `Marshal.GetDelegateForFunctionPointer`. Script `.github/scripts/check-tuning-readonly.mjs`, allow-list none.
10. **[NEW 1.1] Agent self-test:** CI runs `nexum-agent --selftest` (A1 adds frame-parser and statistics tests: header resolution against `Frames/HEADER-2.6.0.txt`, percentile/boundBy vectors from §1.6.5, NA handling, 1000-cap batching).
11. **[NEW 1.1] Docs:** README gains a `Gaming (frame capture)` section (opt-in, Intel PresentMon over ETW, no injection, the §4.3 anti-cheat matrix as a table with every title `not tested` until the owner tests it, the EA Javelin "start Nexum first" note), the 1.1 keymap (F8, Ctrl+8), CSV logging location, alert defaults and the Tjmax table with its re-check date; `SECURITY.md` privileged-surface list gains "spawns the Intel-signed PresentMon exe from the install folder after a hash + signature check" and "reads AMD ADL tuning data read-only"; `docs/ROADMAP.md` is not edited except to tick the v1.1 rows when done.

## 8. Known open items (not blocking implementation)

- §1.5.5 owner test (fan behaviour after `taskkill /F`, warm vs cold reboot).
- HDD spin-down test (ROADMAP §6.8): if SMART polling keeps a rotational drive awake, A refreshes rotational `StorageDevice` hardware every 600 s instead of every tick; the telemetry shape does not change.
- Minimized-idle CPU budget test (< 0.5% over 10 min, ROADMAP §6.8).
- `cpu.codename` coverage depends on the static table A ships.
- **[NEW 1.1]** PresentMon 2.6.0 real CSV header: A1 confirms it on a machine where the exe can run elevated (§1.6.3); until then the alias lists are based on the v2.6.0 README.
- **[NEW 1.1]** ROADMAP §4.3 gates (overhead ≤ 0.5% at 144 fps, anti-cheat matrix, no orphaned `NexumFrames` session after `taskkill /F` of the agent) need the owner's rig; the owner has not named the games they play (ROADMAP Q6).
- **[NEW 1.1]** Tjmax table (§2.10.2) re-check on amd.com (ROADMAP Q9).
- **[NEW 1.1]** ADL OD8 on RDNA4 (ROADMAP V3) is unverified: the read-only probe answers the "caps reported?" half; writes stay out until ROADMAP Q5.
- **[NEW 1.1]** LHM's ADL report format for the GPU PCIe link and the `"Fabric Clock"` / `"Uncore Clock"` sensor names must be confirmed with `nexum-agent --dump` on the reference rig (A2).
- **[NEW 1.1]** Recycle Bin `$I` parsing is reverse-engineered (no Microsoft spec); B treats unknown versions as "skip, never delete".
