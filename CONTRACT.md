# Nexum — Internal Integration Contract

**Contract version: 1.2.0** (2026-11-27). Three owner requirements on top of the shipped 1.1.0 contract (commit `b274964`):

1. **Redesign:** a clean, professional light theme in white and Nexum Crimson, macOS-grade. The design package is in [`docs/design/`](docs/design/) (`SPEC.md`, `RATIONALE.md`, `tokens.css`, `contrast.txt`, logo sources); the renders in the package are the acceptance target. Sections §4.6.1 (shell), §4.7 (primitives), §4.9 (tokens) and §4.10.3 (views).
2. **In-app updates:** a must. Updates come only from this repository's GitHub Releases, are checked only after the user agrees, and are installed only after a click. Section §2.15.
3. **No "agent" wording:** nothing a user can read says "agent". When sensors work the UI says nothing; when they stop Rust restarts them; only if that fails the UI shows one plain banner. Sections §2.3.1, §4.8.1 and §5.

**Decisions already made for 1.2 (not open for implementers):** native window decorations (`"decorations": true`, window theme forced to Light, no custom caption buttons, no drag region); light theme only (no dark mode); Inter with tabular figures for every number, never SF Pro; brand crimson only for the selected sidebar row, the ONE primary button of a screen, and the logo; status is never conveyed by colour alone.

**Not in scope for 1.2:** any change to `nexum-agent/**` (the sidecar keeps protocol 3 and reports version `1.1.0`), dark mode, a global search, a custom tooltip component, the overlay window, tuning writes, and any behaviour change of a 1.1 feature other than the layout changes listed in §4.6.1 and §4.10.3.

**1.1.0 scope (shipped, still binding unless a 1.2 marker says otherwise):** implements **v1.1** of [`docs/ROADMAP.md`](docs/ROADMAP.md) on top of the 1.0.0-gate contract: the §3 "v1.1" table (except the kernel-driver/vendor security audit), §4 FPS architecture (§4.2 contract, §4.3 gates), the **read-only** parts of §5 tuning (§5.3 probe with `write:false` only), §6.3 frametime chart and §6.5 IA (F8 Gaming). Seven work items: (1) FPS capture + Gaming view, (2) CSV sensor logging, (3) Rust alert engine + desktop notifications + tray tooltip, (4) drive wear ledger + forecast, (5) System view full (live DDR4 timings, SPD JEDEC timings, FCLK/UCLK/MEMCLK, codename, GPU/NVMe link, Save report), (6) GPU tuning step 0 (read-only state + read-only probe), (7) cleaner extras (top-50 drill-down, Recycle Bin age filter). Still out: kernel-driver/vendor security audit (blocked on ROADMAP Q13), overlay window, benchmarks, **any tuning write** (including the probe's `write:true` path, blocked on ROADMAP Q5), fan curves, split privilege, XMP parsing, tray-icon temperature digits.

Single source of truth for how the three layers talk. Every implementer follows it literally.
The TypeScript mirror is [`src-frontend/types.ts`](src-frontend/types.ts): it is authoritative for field names, unions, defaults and the exact 1.2 UI texts (`UPDATE_TEXT`, `UPDATE_ERROR_TEXT`, `SENSORS_DOWN_*`, `NOT_AVAILABLE_TEXT`). Where this file and `types.ts` disagree, `types.ts` wins for names/types/texts and this file wins for behaviour; report the conflict to the contract owner.

Markers: **[NEW 1.2]** added in 1.2.0 · **[BREAKING 1.2]** removed, renamed or re-typed in 1.2.0 · **[CHANGED 1.2]** same shape, new semantics or new look in 1.2.0. The 1.1 markers (**[NEW 1.1]**, **[BREAKING 1.1]**, **[CHANGED 1.1]**) and the unsuffixed **[NEW]** / **[BREAKING]** / **[CHANGED]** markers are historical (1.1.0, 1.0.0-gate) and describe shipped behaviour that still holds unless a 1.2 marker says otherwise. The 1.2.0 change list is §6.0; the 1.1.0 one is §6.1.

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
react ^18.3, vite ^6, typescript ^5.6, tailwindcss ^4 + @tailwindcss/vite ^4, echarts ^5.5, lucide-react; Rust plugins `tauri-plugin-notification` 2.x and **`tauri-plugin-updater` 2.x [NEW 1.2]**.
Identifier: `net.nexum.monitor`. Window: 1600x960 (inner size), min 1280x800, decorations true (native title bar), title "Nexum"; **[NEW 1.2]** `theme: "Light"`, `backgroundColor: "#F5F5F7"`. App version **1.2.0** in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
Frontend dist: `../dist` (relative to src-tauri). Dev URL: `http://localhost:1420`.

Global rules for this round:
- **No new third-party dependencies** (npm, NuGet, crates). Exceptions: the crate `tauri-plugin-notification` 2.x (1.1) and **[NEW 1.2]** the crate `tauri-plugin-updater` 2.x in `src-tauri/Cargo.toml` (R). Both are used only from Rust: no JS package (`@tauri-apps/plugin-updater` is **not** added) and no plugin permission for the WebView. R may also name crates the updater plugin already pulls in as direct dependencies when it needs their API (`semver`, `url`, `base64`, `minisign-verify`); nothing else. No new npm package: the fonts come from the two `@fontsource` packages already present. Allowed: new `windows` crate *features*. Virtualized lists are hand-written (fixed row height windowing). The ADL bindings are hand-written P/Invoke (§1.7), not a NuGet package.
- **[CHANGED 1.2] Network:** Nexum makes exactly one kind of network request: the **update check**, and after a click the **update download**, both from this repository's GitHub Releases (§2.15). It lives only in `src-tauri/src/updater.rs`, is off until the user agrees, and never installs without a click. Everything else stays as in 1.1 (MF-11): no telemetry, no analytics, no accounts, no localhost listeners, no network API in the frontend or in the sidecar. `open_external` only hands an `https://` URL to the default browser. PresentMon is a file shipped in the installer and spawned locally (§1.6); nothing but an update the user asked for is ever downloaded at runtime. CI may download the pinned PresentMon release at build time (§7). CI enforces all of this (§7 items 3 and 12).
- **[NEW 1.2] The sidecar is frozen:** nothing under `nexum-agent/**` changes in 1.2. It keeps protocol 3 and reports version `1.1.0` in `hello`.
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
| `save_settings` | `{ settings: Settings }` | `Settings` | applies autostart + poll interval; sanitizes (§2.2) · **[CHANGED 1.2]** keeps the stored `lastUpdateCheckTs`; a change of `updateCheck` or `updateChannel` re-arms the updater (§2.15.4) |
| `get_agent_status` | – | `AgentStatus` | **[CHANGED]** §2.3 |
| `restart_agent` | – | `()` | **[CHANGED 1.2]** also resets the automatic-restart counter and sets `phase:"starting"` (§2.3.1). This is the banner's `Try again`. |
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
| `get_update_state` | – | `UpdateState` | **[NEW 1.2]** §2.15.6; never touches the network |
| `check_for_update` | – | `UpdateState` | **[NEW 1.2]** §2.15.4; a check the user asked for (a click); resolves when it has finished; Err while `updateCheck == "ask"` |
| `install_update` | – | `()` | **[NEW 1.2]** §2.15.5; download → verify → stage → start the installer → exit. Returns once started; progress and failures through `update-state` |

Events emitted by Rust (`app.emit`):
- `telemetry` → `TelemetryPacket` (forwarded verbatim from the sidecar line, parsed as `serde_json::Value`)
- `agent-status` → `AgentStatus` (**[CHANGED 1.2]** carries `phase` and `failReason`; emitted on every phase change, §2.3.1)
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
- **[NEW 1.2]** `update-state` → `UpdateState` on every change (§2.15)

**Tray menu [CHANGED 1.1]** (ids → action): `show` "Show Nexum" → show window · separator · `dashboard` "Dashboard", `sensors` "Sensors", `system` "System", `storage` "Storage", `cooling` "Cooling", `drivers` "Drivers", **`gaming` "Gaming"** → `navigate` with that ViewId · separator · **`sensor-log` "Start sensor log" / "Stop sensor log"** (label follows `SensorLogStatus.active`; starts with `Settings.sensorLogIntervalMs` and `ids:null`) · `clean-caches` "Clean caches…" → `navigate "quick-clean"` · separator · `quit` "Quit". Tray tooltip: §2.10.5. **[CHANGED 1.2]** No tray string contains the word "agent" (§4.8.1). The tray has no update item: an available update is announced only by the toolbar indicator (§2.15.7).

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
AgentStatus { running, isAdmin, message, lastPacketTs, sensorDriver, limitedReasons, missingFeatures, protocol, phase, failReason }  // §2.3, [CHANGED 1.2]
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
// [NEW 1.2] — exact members in types.ts
UpdateState { state, currentVersion, latestVersion, notes, publishedAt, progress, downloadedBytes, totalBytes,
  error, errorCode, channel, buildChannel, lastCheckTs }                                                      // §2.15.6
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
| `updateCheck` | `"ask"\|"auto"\|"manual"` | `"ask"` | **[NEW 1.2]** update-check consent (§2.15.3); unknown value → `"ask"` |
| `lastUpdateCheckTs` | `number \| null` | `null` | **[NEW 1.2]** unix ms of the last answered check; **written by Rust only** (§2.15.4): `save_settings` ignores the incoming value and keeps the stored one; not a finite number → `null` |
| `updateChannel` | `"default"\|"stable"\|"preview"` | `"default"` | **[NEW 1.2]** §2.15.2; unknown value → `"default"` |

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

### 2.3 AgentStatus and degraded mode [CHANGED, MF-2] [CHANGED 1.2]

```ts
AgentStatus { running: boolean, isAdmin: boolean, message: string, lastPacketTs: number|null,
  sensorDriver: SensorDriverStatus|null, limitedReasons: LimitedReason[], missingFeatures: string[], protocol: number|null,
  phase: "starting"|"running"|"restarting"|"failed"|"stopped",                              // [NEW 1.2] §2.3.1
  failReason: "blocked"|"missing"|"crashed"|"notResponding"|"startFailed"|null }            // [NEW 1.2] §2.3.1
```

Rust sets these from each `hello`; while the agent is down: `sensorDriver:null`, `limitedReasons:[]`, `missingFeatures:[]` (down is reported by `running:false` and `phase`, not as limited mode).
- `limitedReasons` (this order): `"notElevated"` if `!isAdmin`; then `"pawnIoMissing"` if `sensorDriver.reason == "missing"`, else `"pawnIoOutdated"` if `sensorDriver.reason == "outdated"`.
- `missingFeatures` — fixed strings, in this order, deduplicated:
  - if `notElevated`: `CPU temperature, power and clock`, `Motherboard temperatures, voltages and fans`, `Fan control`, `Drive S.M.A.R.T. health`, `Memory module details`, `Windows Update cache, error report and crash dump cleanup`
  - else if `pawnIoMissing` or `pawnIoOutdated`: `CPU temperature, power and clock`, `Motherboard temperatures, voltages and fans`, `Fan control`, `Memory module details`
- If `hello.protocol != 3`, Rust logs a warning and sets `message` to a diagnostic text. Nothing is shown to the user for a mismatch.
- **[CHANGED 1.2] `message` is diagnostic only.** Rust keeps writing it (and may keep its 1.1 texts, which name internals); **no layer renders `AgentStatus.message`** any more (S removes it from Settings and deletes the footer). It is exempt from the §4.8 wording rule for that reason; if a CI check trips on it, R rewords it rather than allow-listing.

#### 2.3.1 Sensor service: life cycle and automatic restart [NEW 1.2] (R: `agent.rs`)

"Sensor service" is this contract's name for the `nexum-agent` process in anything that concerns the user. The UI never names it at all: it shows nothing while it works, and one banner when it cannot be brought back (§4.8.1, §5.4).

| `phase` | When | `running` |
|---|---|---|
| `starting` | spawned by app start or by `restart_agent`, no `hello` yet | true |
| `running` | `hello` received | true |
| `restarting` | it stopped or stopped answering and an automatic restart is pending or under way (stays `restarting` until the new process's `hello`, then `running`) | false while waiting, true once respawned |
| `failed` | the policy below gave up, or the start error cannot be fixed by retrying. `failReason` is set (null in every other phase) | false |
| `stopped` | Nexum stopped it on purpose (app exit, `install_update`) | false |

**Restart policy** (replaces the 1.1 rule "at most 5 restarts per rolling 60 s", which could retry for ever when the process died every ~10 s):
1. **Triggers:** an abnormal exit (not `shutting_down` / `expected_exit`), a hang kill (§2.4 item 2: no stdout line for `max(15000 ms, 3 × effective interval)`; 60 000 ms before the first line of a process), or a spawn error.
2. **Counter `n`** = automatic restarts since the last healthy run. It returns to 0 when a process has stayed up for **60 s** after its `hello` (`SENSOR_HEALTHY_RUN_MS`), and when `restart_agent` is called.
3. On a trigger with `n < 5` (`SENSOR_RESTART_MAX`): `phase:"restarting"`, wait `SENSOR_RESTART_DELAYS_MS[n]` = **1 s, 2 s, 4 s, 8 s, 15 s**, spawn, `n += 1`.
4. On a trigger with `n == 5`: `phase:"failed"`, `failReason` = `"notResponding"` if this trigger was a hang kill, `"startFailed"` if it was a spawn error, else `"crashed"`. Nothing restarts until `restart_agent`.
5. **Start errors that retrying cannot fix go straight to `failed`** (no restart, `n` untouched): the sidecar cannot be resolved, or the spawn fails with OS error 2 / 3 (file or path not found) → `"missing"`; OS error 4551 (blocked by an Application Control policy, which is what Smart App Control returns), 1260 (blocked by policy), 225 or 226 (blocked or removed by antivirus) → `"blocked"`. A spawn error without an OS code is retried like any other trigger.
6. The fan fail-safe's one immediate restart (§2.4 item 1) is unchanged and does not count towards `n`.
7. Every phase change emits `agent-status`. Worst case from the first failure to `failed` for a process that dies at once: 30 s of delays plus five start attempts. During that time the UI shows no message; values render `—` (§4.8.1).
8. `restart_agent` (the banner's `Try again`, and Settings › Sensors › `Restart sensor reading`): `n = 0`, `phase:"starting"`, `failReason:null`, then start as in 1.1.

The step function is pure and unit-tested in Rust: `next_step(n, trigger) -> Restart { delay_ms } | Fail { reason }`, plus the OS-error classification of rule 5.

### 2.4 Fan fail-safe watchdog and banner [NEW, MF-13]

Rust holds one `FanFailsafeState` (initially inactive), emits `fan-failsafe` on every change and returns it from `get_fan_failsafe_state` (the UI calls it on mount, then listens).

| kind | severity | Set when | fansAt100 | message (exact) | dismissible |
|---|---|---|---|---|---|
| `interrupted` | `crit` | a `hello` with `fanFlag:"interrupted"`, or a telemetry packet with `fanSafety.failsafe:true` | `true` if the agent is elevated, else `false` | `Fan control was interrupted. Fans are at 100% for safety. Restart the PC to return them to BIOS control.` | no |
| `agentLost` | `crit` | agent exits abnormally (not `shutting_down`/`expected_exit`) **and** the flag file exists; or at app start the flag exists and no `hello` has arrived yet | `false` | **[CHANGED 1.2]** `Fan control was interrupted and Nexum is no longer controlling the fans. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.` | no |
| `previousBoot` | `warn` | a `hello` with `fanFlag:"previousBoot"` | `false` | `Nexum's fan control was interrupted before the last restart. If the fans behave unusually, shut down fully and power the PC on again.` | yes (`dismiss_fan_failsafe`) |

Transitions: `agentLost` → `interrupted` when the restarted agent says so; any kind other than `previousBoot` stays active until the app exits (it describes hardware state that only a reboot clears). A `hello` with `fanFlag:"none"` clears only an `agentLost` that was set provisionally at app start.

**Watchdog behaviour (Rust, `agent.rs`):**
1. On abnormal exit, check `%ProgramData%\Nexum\fan-manual.flag` (read-only). If present: set `agentLost`, and restart the agent **immediately** (no back-off delay) for that first restart; the new agent finds the same-boot flag and enters failsafe itself (§1.5.4), which moves the state to `interrupted` with `fansAt100:true`. Later restarts follow the §2.3.1 policy (this immediate one does not count towards its counter).
2. **Hang detection [NEW]:** if the agent is running and no stdout line arrives for `max(15000 ms, 3 × effective interval)`, Rust kills it and treats it as an abnormal exit.
3. At app start Rust reads the flag before starting the agent; if present, set `agentLost` provisionally (the banner shows immediately; the `hello` then settles it).
4. Rust never deletes or writes the flag.

### 2.5 Self-usage [NEW]

Rust emits `self-usage` every 5 s while the window is visible (first event 5 s after start): `{ ts, cpuPct, workingSetMb, processCount }`.
- Process set: `Nexum.exe` (own pid), the `nexum-agent` child, and every `msedgewebview2.exe` whose parent chain leads to Nexum's pid (Toolhelp32 snapshot each sample).
- `cpuPct` = Σ Δ(kernel+user CPU time) ÷ (Δwall × logical processor count) × 100, 1 decimal (0–100 for the whole machine).
- `workingSetMb` = Σ `WorkingSetSize` ÷ 1,048,576, rounded to an integer. `processCount` = size of the set.
- **[CHANGED 1.2]** Shown as the fourth line of the sidebar footer card (S, §4.6.1): `Nexum 0.6% CPU · 142 MB`; `—` until the first event. (The 1.1 status bar is gone.)

### 2.6 `get_system_spec` merge [NEW]

`SystemSpec = { capturedTs, cpu, board, memory, gpus, os, security, errors }`.
- Rust sends `{cmd:"spec"}` (one request in flight, serialized by a mutex), waits ≤ 15 s for the `spec` line and caches the merged result until `refresh:true` or an agent restart (F5 in the System view passes `refresh:true`).
- If the agent is down or times out: `cpu:null, board:null, memory:null, gpus:[]` and `errors` gets **[CHANGED 1.2]** `Hardware details are not available right now.` / `Hardware details took too long to read. Press F5 to try again.` (§4.8.1).
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
- Header: `Date,Time,<col>,<col>,…` with `<col>` = `<HardwareNode.name> | <label> [<unit>]`; `<label>` = `Settings.sensorLabels[id]` else `SensorMeta.name`; ` [<unit>]` omitted when the unit is `""`. **[REVIEW 1.1]** CSV-injection guard (OWASP): a header cell whose first non-space character is `=`, `+`, `-`, `@`, tab, CR (or the full-width `＝ ＋ － ＠`) gets a leading `'` before RFC 4180 quoting; data cells are numbers and are never prefixed.
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
1. `Nexum · No alerts` / `Nexum · <n> alert(s)` (`1 alert`, `2 alerts`; from the Rust snapshot only; **[CHANGED 1.2]** `Nexum · Sensors unavailable` while `phase == "failed"`, and plain `Nexum` while the sensor service is starting or restarting).
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
- `set_frame_target {pid}` and `list_presenting_processes`: one request of each kind in flight (mutex), wait ≤ 3 s for the matching `ack {cmd:"frameTarget"}` / `presentingList` line. Agent not running → `Err("Not available right now. Try again in a moment.")`; timeout → `Err("That took too long. Try again.")` (**[CHANGED 1.2]** texts, §4.8.1; the constants `ERR_NOT_RUNNING` / `ERR_NO_ANSWER` are used by every request/reply command).

### 2.14 GPU tuning, Rust side [NEW 1.1] (B: `tuning.rs`)

- `get_tuning_state { refresh? }`: cached `TuningState` (latest `tuningState` line, cleared on agent exit). If `refresh:true` or nothing is cached and the agent runs: send `{cmd:"tuningGet"}`, wait ≤ 12 s, return the new state; on timeout return the cache (may be null). Agent down → `null`. The UI calls it with `refresh:true` every 5 s **only while the GPU tuning tab is visible** (ROADMAP §5.2 item 8).
- `run_tuning_probe { write }`: `write:true` → `Err("The write probe is not available in this version.")` **without sending anything to the agent**. `write:false`: send `{cmd:"tuningProbe","write":false}`, wait ≤ 15 s for the `tuningProbe` line (or an `ack {cmd:"tuningProbe", ok:false}` → `Err(message)`); write `report` (pretty JSON, plus `"nexumVersion"` and `"capturedTs"` at the top level) to `%LOCALAPPDATA%\Nexum\tuning-probe-YYYYMMDD-HHMMSS.json` through PinnedDir/`create_new_file`; update the cache with `report.state`, emit `tuning-state`; return `TuningProbeSummary { ranTs, write:false, ok, message, path: string|null }`.
- Tuning state is never polled while the tab is hidden; no tuning call ever runs at app start.

### 2.15 In-app updates [NEW 1.2] (R: `updater.rs`; UI: S; release pipeline: F)

#### 2.15.1 Rules

1. Nexum updates only from **this repository's GitHub Releases** (`github.com/captainRapipo/nexum`). No other host is named anywhere in the code.
2. **No network request is made before the user has answered the first-run question** (§2.15.3). Rust enforces it, not the UI.
3. `"auto"` only **checks**, at most once per 24 h, and shows a quiet toolbar indicator. Nothing is downloaded and nothing is installed without a click on `Install update`.
4. The download is verified against the public key compiled into the app **before anything runs**, and the verified bytes never sit in a place a non-elevated process can write to (§2.15.5).
5. **Never downgrade:** the version on offer must be strictly greater than the running version (SemVer precedence), and that version is bound to the signed file (§2.15.5 step 2). The stable channel never takes a preview version (§2.15.4 step 3).
5a. **[1.2 security review] The manifest is not trusted.** It is not signed, so everything in it counts as something an attacker may have written: it is read with a size limit, its notes are plain text, its `url` must match the fixed prefix, and its `version` counts only when the installer's signature names the same version. The only trust anchor is the public key compiled into the app.
6. The frontend has no network API. It uses three commands and one event (`get_update_state`, `check_for_update`, `install_update`, `update-state`). The CSP stays `connect-src 'self' ipc: http://ipc.localhost`.
7. All updater code lives in **`src-tauri/src/updater.rs`** (plus the plugin registration line in `lib.rs`). It is the only file the network check allows (§7 item 12).

#### 2.15.2 Plugin, channels, endpoints, manifest

**Plugin.** Crate `tauri-plugin-updater` 2.x, registered with exactly `tauri_plugin_updater::Builder::new().build()` and used only through `tauri_plugin_updater::UpdaterExt::updater_builder()`. No JS package, **no `updater:*` permission in any capability** (the plugin's own commands stay unreachable from the WebView). **[1.2 security review]** The plugin does three things for Nexum: it parses the manifest (`Updater::restore_update`, which makes no request), downloads the installer (`Update::download`) and verifies its signature. The manifest request itself is made by `updater.rs` with `reqwest` (§2.15.4 step 2), because the plugin reads a response of any size into memory. `reqwest` and `rustls` are therefore direct dependencies, with exactly the features the plugin already enables (nothing new is compiled); they may be used in `updater.rs` only (§7 item 12). `src-tauri/tauri.conf.json`:

```jsonc
"plugins": {
  "updater": {
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNENzc3OERFRDk0Qzc0QTYKUldTbWRFelozbmgzUFh5azMwYUR6bjF6MUNIU3dGNVRsRURvQnVVclZEL1FUc05PMVF1eTJKU2UK",
    "endpoints": ["https://github.com/captainRapipo/nexum/releases/download/updates/stable.json"],
    "requireSignedVersion": true
  }
}
```

**[1.2 security review]** `requireSignedVersion: true` makes the plugin refuse an installer whose signature does not carry the announced version. `plugins.updater` holds these three keys and nothing else: no `dangerous…` switch, no `allowDowngrades`, no `windows.installerArgs` (§7 item 12 enforces it).

`bundle.createUpdaterArtifacts` is **not** set in the committed config, so a build without the signing secret (forks, pull requests, local builds) succeeds and produces no `.sig`. CI turns it on with `--config` only when the secret exists (§7 item 14). The private key is the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (empty password); nobody prints, reads or commits it.

**Build channel.** `option_env!("NEXUM_UPDATE_CHANNEL")` at compile time: `"stable"`, `"preview"`, anything else or unset → none. Debug builds (`cfg!(debug_assertions)`) → none. With no build channel the updater is **`disabled`** for the life of the process: no request is ever made, `get_update_state` and `check_for_update` return `state:"disabled"`, `install_update` returns `Err("This build does not update from inside the app.")`. CI sets the variable only for tag builds that have the signing secret (§7 item 14), so a fork's build never replaces itself with an upstream release.

**Effective channel** = `Settings.updateChannel`, or the build channel when it is `"default"`. `UpdateState.channel` is the effective one, `UpdateState.buildChannel` the compiled one.

**Endpoints** (exact, one per channel, passed with `.endpoints(vec![url])`; `UPDATE_MANIFEST_URLS` in `types.ts`):

| Channel | URL | Describes |
|---|---|---|
| `stable` | `https://github.com/captainRapipo/nexum/releases/download/updates/stable.json` | the newest stable release |
| `preview` | `https://github.com/captainRapipo/nexum/releases/download/updates/preview.json` | the newest release of **any** kind (so preview users also get stable releases) |

Both files are assets of **one permanent GitHub release with the tag `updates`** (title `Update manifests`, marked pre-release so it never becomes "Latest"; its body says the two files are read by the app and are not downloads). Reason: GitHub's `/releases/latest/download/…` skips pre-releases, and every Nexum release so far is one; a fixed tag gives both channels a URL that never changes. GitHub redirects asset requests to its own asset hosts (`release-assets.githubusercontent.com`, `objects.githubusercontent.com`); the HTTP client follows them. A manifest that does not exist yet (404) is the normal state of a channel before its first 1.2 release (`notPublished`).

**Manifest** = the plugin's static JSON format (the plugin's documented format; the crate source was not available locally, R confirms the field names against the version `Cargo.lock` resolves):

```jsonc
{
  "version": "1.2.0-preview.1",                 // SemVer, no leading "v"
  "notes": "Plain text. What changed.",         // optional; shown as text, cut at 4000 characters
  "pub_date": "2026-11-27T20:00:00Z",           // optional; RFC 3339
  "platforms": {
    "windows-x86_64":      { "signature": "<content of the .sig file>", "url": "https://github.com/captainRapipo/nexum/releases/download/v1.2.0-preview.1/Nexum_1.2.0-preview.1_x64-setup-UNSIGNED-PREVIEW.exe" },
    "windows-x86_64-nsis": { "signature": "<the same>",                 "url": "<the same>" }
  }
}
```

Both platform keys carry the same entry: newer plugin versions look up `<os>-<arch>-<installer>` first, older ones only `<os>-<arch>`. Rust re-checks that `url` starts with `https://github.com/captainRapipo/nexum/releases/download/` (`UPDATE_DOWNLOAD_PREFIX`); anything else is `badManifest`.

**Versions.** Tag `vX.Y.Z` → app version `X.Y.Z`, build channel `stable`. Tag `vX.Y.Z-preview.N` → app version `X.Y.Z-preview.N`, build channel `preview`. CI overrides `version` with `--config` for tag builds (the committed `tauri.conf.json`, `Cargo.toml` and `package.json` say `1.2.0`). SemVer precedence then orders `1.2.0-preview.1 < 1.2.0-preview.2 < 1.2.0 < 1.3.0-preview.1`, which is exactly the upgrade order wanted on the preview channel. The frontend shows `UpdateState.currentVersion` (from `app.package_info().version`), not the baked `__NEXUM_VERSION__`.

**Signature.** The Tauri updater signature (minisign) of the installer, made with the secret key. In the **preview** job it is the `.sig` the bundler writes for the unsigned build. In the **sign** job the installer's bytes change when SignPath adds the Authenticode signature, so the build-time `.sig` is discarded and a new one is made from the signed file with `tauri signer sign` **after** signing. At signing time the file must be named `Nexum_<version>_x64-setup.exe` (the name goes into the signature's trusted comment, §2.15.5 step 2); renaming the asset afterwards (`…-UNSIGNED-PREVIEW.exe`) is fine. Each release also publishes the `.sig` as an asset next to the installer.

**Publishing order (F).** A manifest is written only after the release it points to is public: `preview.json` after every published release, `stable.json` only after a published stable release. A draft release must never be referenced.

#### 2.15.3 Consent

`Settings.updateCheck`:

| Value | Meaning |
|---|---|
| `"ask"` (default) | Not answered yet. **Rust makes no request at all**: the scheduler does not run, and `check_for_update` / `install_update` return `Err("Choose how Nexum checks for updates first.")`. |
| `"auto"` | Rust checks on its own, at most once per 24 h (§2.15.4). It never downloads or installs on its own. |
| `"manual"` | Rust checks only when the user presses `Check now`. |

**First-run question (S).** Shown once, as a dialog, when `settings.updateCheck === "ask"` and the update state is not `disabled`, after the PawnIO first-run screen (if any) has been answered and while no other dialog is open. Exact texts (`UPDATE_TEXT` in `types.ts`):

- Title: `Check for updates automatically?`
- Body: `Nexum can ask GitHub once a day whether a newer version exists. That check, and the download when you choose to install, are the only times Nexum goes online. It sends no information about you or this PC, and nothing is installed until you click Install.`
- Note: `You can change this any time in Settings, under Updates.`
- Buttons: `Check automatically` (primary) → `updateCheck:"auto"` · `Not now` (secondary) → `updateCheck:"manual"`. Esc and closing the dialog mean `Not now`. Either way the question never returns.

In Settings › Updates, pressing `Check now` while the value is still `"ask"` first saves `"manual"` (the click is the answer), then calls `check_for_update`.

#### 2.15.4 Checking (R)

`check(kind)` with `kind = user | automatic`:
1. Guards, in this order: no build channel → return the `disabled` state; `updateCheck == "ask"` → Err (above); state `checking`, `downloading`, `ready` or `installing` → return the current state without a new request.
2. `state:"checking"` → emit. **[1.2 security review]** Rust requests the channel's manifest itself: one `GET` to the fixed URL, HTTPS only (redirects included), a 20 s timeout, the headers `Accept: application/json` and `User-Agent: nexum-updater` and nothing else, and **at most 256 KiB** (`MAX_MANIFEST_BYTES`): a response that announces or sends more is dropped unparsed. The body must be a JSON object. It is then handed to the plugin: an updater built with the channel's endpoint, `version_comparator(|current, release| release.version > current)` (strictly greater; stated explicitly although it is the plugin default) and an HTTPS-only download client, and `restore_update(manifest)` (the plugin's parser, platform selection and version rule; no request).
3. **A newer version** → validate (`url` prefix; version parses; version > current; **on the stable channel the version has no pre-release part**, else `badManifest`) → `state:"available"` with `latestVersion`, `notes` (control characters removed, cut at 4000 characters + `…`), `publishedAt` (RFC 3339 UTC or null). Rust keeps the plugin's `Update` object in memory for `install_update`.
   **No newer version** → `state:"idle"`, `latestVersion:null`.
   Both write `Settings.lastUpdateCheckTs = now` (saved to disk) and mirror it in `UpdateState.lastCheckTs`.
4. **Failure** → `errorCode`: HTTP 404 → `notPublished`; DNS, TLS, timeout, connection error or any other HTTP status → `offline`; a manifest over 256 KiB, unreadable JSON, missing platform entry, bad version, bad `url`, a preview version on the stable channel → `badManifest`. `lastUpdateCheckTs` is not changed. For `kind = user`: `state:"error"` with the §2.15.6 text. For `kind = automatic`: **silent** — the state returns to what it was before the check (`idle` or `available`), nothing is shown.
5. `check_for_update` (command) is `kind = user`; it resolves with the final `UpdateState` (also emitted).

**Automatic schedule** (only while `updateCheck == "auto"` and a build channel exists): the rule "due" is evaluated 30 s after app start, then every 60 min, and at once when `save_settings` changes `updateCheck` to `"auto"` or changes `updateChannel`. **Due** = `lastUpdateCheckTs == null`, or `now − lastUpdateCheckTs ≥ 24 h`, or `lastUpdateCheckTs > now` (clock moved back). A failed automatic attempt is retried at the next hourly evaluation, at most **3** failed automatic attempts per app run. So: at most one answered check per 24 h. The schedule keeps running while the window is hidden in the tray and while an update is `available` (a newer offer replaces the older one).

A change of `updateChannel` discards a pending offer (`state:"idle"`, `latestVersion:null`) and clears `lastUpdateCheckTs`, so the next check (automatic, or `Check now`) asks the new channel.

#### 2.15.5 Installing: download, verify, stage, run (R)

Nexum runs elevated, so a file that will be executed must never be replaceable by a non-elevated process between the signature check and the start of the installer. **The plugin's `Update::install` and `download_and_install` are never called**: they write the installer into `%TEMP%`, which any process of the same user can write to. `install_update` does this instead:

0. **Preconditions.** An offer is in memory (state `available`, or `error` after a failed install of that offer), else `Err("Check for updates first.")`. State `downloading` / `ready` / `installing` → `Err` with the `busy` text. The command returns `Ok(())` as soon as the work has started; progress and failures arrive through `update-state`.
1. **Download into memory.** `update.download(on_chunk, on_finish)`: `state:"downloading"`, `downloadedBytes`, `totalBytes`, `progress` (integer percent, null when the size is unknown), emitted at most 4 times a second. HTTPS only, redirects included. The plugin verifies the minisign signature of the bytes against the compiled-in public key before it returns them, and that the signed trusted comment carries the announced version (`requireSignedVersion`); a failure is `badSignature` (`notNewer` for a version mismatch). More than 300 MB announced or received → abort with `badManifest`.
2. **Bind the version to the signed file (anti-rollback). [CHANGED by the 1.2 security review: strict]** The manifest is not signed, only the installer is. So: base64-decode `update.signature` exactly as the verifier does (no trimming) and read the trusted comment **from the third line, with the exact prefix `trusted comment: `** — never by searching for a line that starts with those words: the first line is the *untrusted* comment, which no signature covers, so whoever writes the manifest could put a `trusted comment:` line of their own there. Step 1 verified minisign's global signature, which covers the third line. From it take the tab-separated fields `version:<v>` and `file:<name>` (first occurrence of each). **Both must be present**, `<name>` must be exactly `Nexum_<semver>_x64-setup.exe`, and `<v>` and `<semver>` must both equal the manifest's version and be greater than the running version. A missing field or another file name → `badSignature`; a different or not-newer version → `notNewer`. Nothing is "logged and accepted": every signature the release pipeline makes carries both fields (§7 item 14), so a signature without them was not made for an update. This stops anyone who can edit a manifest from serving an old, validly signed installer as "newer".
3. **Stage in an admin-only folder. [CHANGED by the 1.2 security review]** `<folder of the running Nexum.exe>\updates`, made by `safe_fs::PinnedDir::create_admin_only(exe_dir, "updates")`: whatever has that name already (leftovers, or something planted) is emptied and removed, never reused — if it cannot be removed, the install fails with `write`; the folder is then created with an explicit security descriptor **in the creating call** (owner Administrators; a protected DACL: full access for SYSTEM and Administrators, inheritable, nothing inherited from the parent; SDDL `O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`), opened without following links, checked not to be a reparse point, pinned without `FILE_SHARE_DELETE`, and its owner and DACL are read back and must be exactly that shape. The installer is written as `Nexum-update-<version>.exe` with `create_new_file_admin_only` (`CREATE_NEW`, share read only, the same descriptor for a file set in the creating call), then `sync_all`, then closed. So no process without administrator rights can ever hold a handle to the folder or the file, or a writable mapping of the file — **wherever Nexum was installed**, including a folder normal users can write to. `%TEMP%`, `%LOCALAPPDATA%` and `%ProgramData%` are not used (non-elevated processes can create or pre-create entries there).
4. **Pin and re-check.** Reopen the staged file for reading with share mode `FILE_SHARE_READ` only (new helper `PinnedDir::open_read_exclusive`): the open fails if any other handle has write or delete access, and while it is held nobody can write to, delete or rename the file. Read the file back **through that handle** and compare length and bytes with the verified buffer; a difference deletes the file and fails with `badSignature`. **The handle stays open until the process exits.**
5. `state:"ready"` → emit. Stop what Quit stops, in the same order: sensor log, then the sensor service with the graceful `shutdown` (which returns the fans to BIOS control and stops frame capture), `phase:"stopped"`, no automatic restart.
6. **Start the installer** with `CreateProcessW` (`std::process::Command`, absolute path, no shell, no inherited handles, current directory `System32` from `GetSystemWindowsDirectoryW`) and the arguments `/P /R /UPDATE` (Tauri's NSIS installer: passive UI, relaunch when done, update mode). A failure: OS error 4551, 1260, 225 or 226 → `blocked`, anything else → `launch`; the staged file is deleted, the sensor service is started again, `state:"error"`.
7. `state:"installing"` → emit, then `app.exit(0)` after 1.5 s (time for the UI to show the text). The installer closes any Nexum process that is still running.
8. **Next start:** delete everything in `<exe dir>\updates` and remove the folder (best effort, through `PinnedDir`).

Any failure in steps 1–4 → `state:"error"` with `errorCode` (`offline`, `badSignature`, `notNewer`, `badManifest`, `write`) and the offer is kept, so `Try again` can call `install_update` again. Pure parts are unit-tested in Rust: the due rule, the error mapping, the manifest size and status rules, the trusted-comment reader (including a forged first line), the version binding, the stable-channel rule, the notes clean-up, the URL prefix check, the admin-only rule for a security descriptor. The staging folder and file are tested on the real file system in CI (an elevated runner).

Known limits (documented in `SECURITY.md` by F): a manifest can still withhold updates or offer an older release than the newest one, as long as it is newer than the running version and genuinely signed (there is no signed "newest version" statement); the NSIS installer unpacks its own helper files to a temporary folder of the account that runs it, as every NSIS installer does, the first installation included; after the update the installer may not be able to relaunch Nexum because Nexum requires elevation (the dialog text says what to do); on a PC with Smart App Control on, an unsigned preview installer is blocked by Windows (`blocked`).

#### 2.15.6 UpdateState and error texts

`UpdateState` (exact members in `types.ts`): `state` (`idle|checking|available|downloading|ready|installing|error|disabled`), `currentVersion`, `latestVersion`, `notes`, `publishedAt`, `progress`, `downloadedBytes`, `totalBytes`, `error`, `errorCode`, `channel`, `buildChannel`, `lastCheckTs`. `get_update_state` returns the current one and never touches the network. `update-state` is emitted on every change.

`error` is always one of these exact texts (`UPDATE_ERROR_TEXT`):

| `errorCode` | Text |
|---|---|
| `offline` | `Could not reach GitHub. Check your internet connection and try again.` |
| `notPublished` | `No update information has been published for this version line yet.` |
| `badManifest` | `The update information from GitHub could not be read.` |
| `notNewer` | `The version on offer is not newer than this one, so nothing was installed.` |
| `badSignature` | `The download did not pass Nexum's signature check, so it was not installed.` |
| `blocked` | `Windows security blocked the installer. Nothing was changed.` |
| `write` | `The update could not be saved in Nexum's folder. Nothing was changed.` |
| `launch` | `The installer could not be started. Nothing was changed.` |
| `busy` | `An update is already in progress.` |
| `unknown` | `The update could not be completed. Nothing was changed.` |

Technical detail (HTTP status, OS error) goes to stderr only.

#### 2.15.7 UI (S)

All texts are the `UPDATE_TEXT` constants; `{v}` = `latestVersion`, `{c}` = `currentVersion`.

- **`hooks/useUpdater.ts`**: `UpdaterProvider` (in `App.tsx`) and `useUpdater(): { update: UpdateState; check(): Promise<void>; install(): Promise<void> }` (`get_update_state` on mount, then `update-state`; initial `INITIAL_UPDATE_STATE`).
- **Toolbar indicator.** Rendered only in states `available`, `downloading`, `ready`, `installing`. A plain small button, left of the filter field: icon `ArrowDownToLine` + `Update available` (tight mode: icon only), `title`/`aria-label` `Nexum {v} is available`. Graphite, never crimson, no badge, no animation. Click opens the update dialog. There is no toast, no notification, no tray item and no dialog that opens by itself.
- **Update dialog** (`components/layout/UpdateDialog.tsx`, `Modal variant="alert"`): title `Nexum {v} is available`; lines `You have Nexum {c}.`, the release date when known, the notes as plain pre-wrapped text in a `ScrollFade` (max height 200 px), `Nexum checks the download against its signing key before anything runs.`, `Nexum closes while the update installs. If it does not open again by itself, start it from the Start menu.`, and on the preview channel `This is a preview version. It is not code-signed yet, so Windows may warn about it or block it.` Buttons: `Later` (secondary), `Install update` (primary; the only primary on screen). While `downloading`: a 4 px graphite progress bar with `Downloading…` and the percent; `ready`: `Download verified. Starting the installer…`; `installing`: `Installing. Nexum will close now.`; in these three states the dialog cannot be dismissed and has no buttons. `error`: the error text with `Try again` (secondary → `install()` if an offer exists, else `check()`), `Close`, and the link `Open the releases page` (`api.openExternal(UPDATE_RELEASES_URL)`).
- **Settings › Updates** (`SettingsModal`): row `Version` = `Nexum {c}` plus a neutral tag `Preview` on the preview channel; `Check for updates` as a two-option `Segmented`: `Automatically, once a day` / `Only when I ask` (`"ask"` displays as `Only when I ask`); toggle `Get preview versions` with the note `Preview versions arrive earlier and are not code-signed yet. Windows may warn about them or block them.` (on = effective channel `preview`; writes `"preview"` / `"stable"`); status line by state: `Not checked yet.` · `Checking…` · `Nexum is up to date.` + `Last checked {when}.` · `Nexum {v} is available.` with `View update` · the error text; button `Check now` (secondary); note `Updates come from Nexum's GitHub releases page and are verified with Nexum's signing key before they run.` State `disabled`: only `This build does not update from inside the app. New versions are on the releases page.` and `Open the releases page`.
- **Mock** (`lib/mock.ts`): default `updateCheck:"manual"` (so screenshots never show the first-run question), `buildChannel:"preview"`, state `idle`; `check` → `checking` for 1.2 s → `idle`. URL params: `?update=ask` (settings start at `"ask"`), `?update=available` (offer `1.3.0`, sample notes; `install` walks `downloading` 0→100 % in about 4 s → `ready` → `installing` and stays there), `?update=downloading`, `?update=error` (`offline`), `?update=disabled`.

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

**Owner letters.** Sections not marked 1.2 still name the 1.1 owners. In 1.2: **C** (frontend core) → **S** for `App.tsx`, `layout/`, `hooks/`, `lib/` and **P** for `components/ui/`; **D** and **E** (views) → **V1**, **V2**, **V3**; **B** → **R**; **A1** / **A2** (sidecar) have no successor because the sidecar is frozen. The 1.1 sidecar entry points (`TuningService.GetState` / `ProbeReadOnly`, `SystemSpec.CaptureLhm` / `Build`) are unchanged.

### 4.1 File ownership map — v1.2 round (seven implementers, disjoint files) [CHANGED 1.2]

Replaces the 1.1 map. Nobody edits a file owned by someone else. If you need a change in another owner's file, code against the interface written here and note it in your report. A path not listed belongs to nobody this round (do not edit it).

| Id | Owner of | Paths | Work |
|---|---|---|---|
| **P** | Primitives | `src-frontend/components/ui/**` **except** `tones.ts` and `echartsTheme.ts`; `src-frontend/components/feedback/Toast.tsx`; `src-frontend/components/layout/GlassCard.tsx` (the card primitive) | §4.7: restyle every primitive to `docs/design/SPEC.md`, finish the new ones, register the light chart theme, the alert-style `Modal`, the app-icon asset for it |
| **S** | Shell | `src-frontend/App.tsx`, `main.tsx`, `index.html`, `src-frontend/components/layout/**` except `GlassCard.tsx` (new `Sidebar.tsx`, `Toolbar.tsx`, `AppBanners.tsx`, `UpdateDialog.tsx`, `UpdatePrompt.tsx`; `PageChrome.tsx`; `SettingsModal.tsx`; `NexumEmblem.tsx` ← `design-final/logo/NexumEmblem.tsx`; delete `TopBar.tsx`, `HeaderStrip.tsx`, `StatusFooter.tsx`), `src-frontend/components/feedback/AppBanners.tsx` (delete: moves to `layout/`) and `PawnIoConsent.tsx`, `src-frontend/hooks/**`, `src-frontend/lib/**` (status texts, `api` updater wrappers, `mock.ts` incl. `?update=` and `?sensors=`) | §4.6.1 shell, §2.15.7 update UI, §4.3–§4.5 1.2 additions, §4.8.1 texts in `lib/`, §5 changes |
| **V1** | Views 1 | `src-frontend/views/DashboardView.tsx`, `SensorsView.tsx`, `DriversView.tsx`; `src-frontend/components/{telemetry,sensors,drivers}/**` | §4.10.3 |
| **V2** | Views 2 | `src-frontend/views/StorageView.tsx`, `CoolingView.tsx`, `SystemView.tsx`; `src-frontend/components/{storage,fans,tuning,system}/**` | §4.10.3 |
| **V3** | Views 3 | `src-frontend/views/GamingView.tsx`, `CleanerView.tsx`; `src-frontend/components/{gaming,cleaner}/**` | §4.10.3 |
| **R** | Rust | `src-tauri/**`: new `updater.rs`; `agent.rs` (§2.3.1, strings); `alerts.rs`, `failsafe.rs`, `spec.rs` (strings); `settings.rs` (three members); `safe_fs.rs` (`open_read_exclusive`); `lib.rs` (plugin, commands, exit path); `Cargo.toml` / `Cargo.lock` (version 1.2.0, `tauri-plugin-updater`); `tauri.conf.json` (version 1.2.0, window `theme: "Light"`, `backgroundColor: "#F5F5F7"`, `plugins.updater`, description text); `icons/**` ← `design-final/logo/tauri-icons/*` (identical file names); `capabilities/**` (no new permission expected) | §2.3.1, §2.15, §4.8.1 Rust rows |
| **F** | CI & docs | `.github/**`, `README.md`, `SECURITY.md`, `docs/**` except the gitignored `docs/target-hardware.md` (new `docs/design/`: `SPEC.md`, `RATIONALE.md`, `tokens.css`, `contrast.txt`, `logo/*.svg` copied from the design package), root `app-icon.svg`, root `package.json` and `package-lock.json` (version 1.2.0 only), `licenses/**`, `.gitignore` | §7 items 12–18 |
| – | Contract owner (foundation; done before the round) | `CONTRACT.md`, `src-frontend/types.ts`, `src-frontend/styles/**`, `src-frontend/components/ui/tones.ts`, `src-frontend/components/ui/echartsTheme.ts`, the font setup (`styles/fonts.css`) | this document |

`nexum-agent/**`, `LICENSE`, `vite.config.ts`, `tsconfig*.json`, `src-frontend/vite-env.d.ts`: nobody this round. `docs/screenshots/**` is re-shot by the integrator after the round (F lists the files the README needs).

**Scaffolding the foundation step left in other owners' files** (so every implementer can build from the first minute; the owner now owns them and finishes them, the exported API is frozen):
- S: `hooks/useTightMode.ts`, `components/layout/PageChrome.tsx` (complete, see §4.6.1); `index.html` (light background, favicon); `main.tsx` (font imports moved to `styles/fonts.css`); two-line compile fixes in `hooks/useTelemetryStream.ts` and `lib/mock.ts` for the new `AgentStatus` / `Settings` members (marked `[1.2 foundation]`).
- P: plain working versions marked `[1.2 foundation]` — `Button`, `StatusPill` (+ `StatusIcon`), `SegmentedBar` / `Meter` and `GlassCard` / `Card` rewritten to the §4.7 props; `Segmented` (`lg`, `count`), `Sparkline`, `EChart` (light theme registered, `MarkLineComponent`) and `Unavailable` (new text) adjusted; `Modal.variant` and `HealthBanner.variant` / `busy` accepted by the types but not drawn yet; the new primitives `Tag`, `Checkbox`, `TextField`, `IconButton`, `Slider`, `EmptyState`, `InkLink`, `ProgressBar` in `components/ui/controls.tsx`; everything exported from `components/ui/index.ts`. P brings every one of them to the SPEC (and may split `controls.tsx`), restyles the untouched ones (`Toggle`, `Modal`, `HealthBanner`, `DottedLeaderRow`, `DotMatrix`, `TrendArrow`, `StatCells`, `ScrollFade`, `Toast`) and adds the app-icon asset for the alert dialog (`design-final/logo/icon-128.png` → `components/ui/assets/`).

**Import rules that keep the round parallel:** views import primitives only from `components/ui` (the index) and `components/layout/GlassCard`; they import nothing from `Sidebar`, `Toolbar`, `App` or each other's folders. S imports views only through the lazy loaders in `App.tsx`. Nobody imports from `components/layout/TopBar`, `HeaderStrip` or `StatusFooter` (they are deleted); `useNow` comes from `hooks/useNow`.

**PresentMon packaging (1.1, unchanged; F owns it):** CI downloads `https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe` into `build/presentmon/` (gitignored, never committed), checks SHA-256 `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` and `Get-AuthenticodeSignature` = `Valid` with a subject starting `CN=Intel Corporation`, **before any job that compiles `src-tauri`** (tauri-build validates resources). `tauri.conf.json` `bundle.resources` keeps `"../build/presentmon/PresentMon-2.6.0-x64.exe": "presentmon/PresentMon-2.6.0-x64.exe"`. The signing configuration must never re-sign it (MF-8 item 7).

### 4.2 Work split by v1.2 requirement [CHANGED 1.2]

| Requirement | P | S | V1 / V2 / V3 | R | F |
|---|---|---|---|---|---|
| (1) Redesign | every primitive to the SPEC; light chart theme; alert dialog; new primitives | Sidebar + Toolbar + page chrome; banners; Settings restyle; emblem; tight mode | each view matches its render at 1600×960 and, where one exists, at 1280×800; colour codemod in its own files; one primary button per screen | window theme Light, background colour, bundle icons | `docs/design/`, README lockup and screenshot list, app icon, social preview note |
| (2) In-app updates | `Modal variant="alert"`, progress bar look | `useUpdater`, `api` wrappers, mock, first-run question, toolbar indicator, update dialog, Settings › Updates | – | `updater.rs`, plugin, commands, settings members, staging helper, tests | updater artifacts and manifests in CI, network allow-list, README / SECURITY / ROADMAP texts |
| (3) No "agent" wording | `Unavailable` text and look | banner, Settings › Sensors, `lib/status.ts` rule 2 and checking state, footer removed, mock | every string in §4.8.1 inside its files | restart policy, `phase` / `failReason`, every string in §4.8.1, tray tooltip | "agent" added to the copy check (`.tsx` **and** `.ts` literals, plus Rust string literals), allow-list kept empty |

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

**[NEW 1.2] api additions (exact, S):**
```ts
  getUpdateState(): Promise<UpdateState>,
  checkForUpdate(): Promise<UpdateState>,     // only from a click (or right after the first-run answer is saved)
  installUpdate(): Promise<void>,             // only from the "Install update" click
```
`restartAgent()` keeps its shape and is now the banner's `Try again` and Settings › Sensors › `Restart sensor reading`. `getAppVersion()` stays; wherever a version is shown, `UpdateState.currentVersion` is used when it is non-empty.

**[NEW 1.2] mock (`lib/mock.ts`, S):** every `AgentStatus` carries `phase` / `failReason`; error strings are the §4.8.1 Rust texts; settings default to `updateCheck:"manual"`; the update commands and `update-state` are served as in §2.15.7 (`?update=ask|available|downloading|error|disabled`). Sensor-service params: `?sensors=failed` (`phase:"failed"`, `failReason:"crashed"`, no telemetry: the banner, `—` everywhere), `?sensors=blocked` (`failReason:"blocked"`), `?sensors=starting` (stays in `starting`: no banner, pill `Checking`, `—`). `restartAgent()` in the mock goes `starting` → `running` after 1.5 s, or back to `failed` when a `?sensors=` failure param is set. The existing params (`?rig=owner`, `?admin=0`, `?pawnio=missing`, `?failsafe=…`, `?fps=…`, `?alerts=hot`, `?gpu=nvidia`) keep working; `?rig=owner` is the data set of the design renders.

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

**[NEW 1.2] hooks (S) — exact exports:**
- `hooks/useUpdater.ts` — `UpdaterProvider` (mounted in `App.tsx`); `useUpdater(): { update: UpdateState; check(): Promise<void>; install(): Promise<void> }` (`get_update_state` on mount, then `update-state`; initial `INITIAL_UPDATE_STATE`; `check` / `install` swallow the rejection after putting its text into a toast only when the state did not already carry the error).
- `hooks/useTightMode.ts` — `useTightMode(): boolean` (§4.6.1; exists).
- `hooks/useTelemetryStream.ts` — unchanged API; `normalizeAgentStatus` fills `phase` (`running ? "running" : "starting"` when an older core omits it) and `failReason`.
- `hooks/useHealth.ts` — unchanged API; also feeds the sidebar's Storage badge and the toolbar pill.

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

- **[CHANGED 1.2]** `lib/status.ts` (S): `resolveUnavailable` keeps its logic (agent null or `!running` → `agentOffline`, whose text is now `Not available right now`); `healthLevelTone(level): StatusPillTone` returns `"checking"` for the level `checking` (was `unknown`); `HEALTH_RULES.offline` and rule 2 use the §4.8.1 / §5.2 texts (the `SENSORS_DOWN_*` constants of `types.ts`); `runHealthAction` handles `{ command: "retrySensors" }` → `api.restartAgent()`; `deriveHealth` follows §5 as changed in 1.2. No file in `lib/` may contain the word "agent" in a string a user can see.

### 4.6 Keymap, views and navigation [BREAKING, C2 / §6.5] [CHANGED 1.2]

- `ViewId = "dashboard" | "sensors" | "system" | "storage" | "cooling" | "drivers" | "gaming" | "cleaner"` (unchanged).
- Function keys (`FKEY_MAP` in `types.ts`, unchanged): **F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F8 Gaming · F9 Clean caches**. F10 is never bound. `Ctrl+1..8` → `VIEW_ORDER[n−1]` = Dashboard, Sensors, System, Storage, Cooling, Drivers, Gaming, Cleaner. **[NEW 1.2] `Ctrl+K`** focuses the toolbar filter field when the page has one (§4.6.1); no effect otherwise.
- F8 is `preventDefault`ed like the other F-keys. F5 on Gaming refreshes the presenting list; on the Cooling GPU tuning tab it calls `useTuningState().refresh()`.
- Global handler rules (S, `App.tsx`; unchanged): `preventDefault` on every F-key above and on F5/Ctrl+F5/Shift+F5/Ctrl+R in production (never reload the WebView); F7 is always `preventDefault`ed (caret browsing); keys are ignored while focus is in `input`, `textarea` or `[contenteditable]` (except Esc); F1–F9 and Ctrl+K are ignored while a modal is open; **when `view === "sensors"` the global F2 is a no-op** and the Sensors view handles F2 as "rename selected row"; Esc closes modals, sheets and popovers.
- F5 = Rescan: `useSystemInfo().refresh()`, `useDriverScan().rescan()` when on Drivers, `useSystemSpec().refresh()` when on System, cleaner rescan when on Cleaner.
- **[CHANGED 1.2] F9** opens `<OneClickPurgeModal open onClose autoStart />` with `autoStart = (opened by F9) && !settings.confirmBeforePurge` (unchanged). There is no "Clean caches" button in the chrome any more: the sidebar row `Clean caches` (hint `F9`) **navigates to CleanerView**. The tray's `quick-clean` still opens the modal with `autoStart=false`.
- Views (`src-frontend/views/`, default export, no props): `DashboardView`, `SensorsView`, `SystemView`, `StorageView`, `CoolingView`, `DriversView`, `GamingView`, `CleanerView`, lazy-loaded by `App.tsx`. Tray labels: `VIEW_LABELS` (unchanged). **[NEW 1.2]** sidebar labels and page titles: `VIEW_TITLES` (the cleaner is `Clean caches`).
- `navigate` event values: `NavTarget` (§2). DOM event `nexum:navigate` detail: `NavTarget | NavRequest`; `NavRequest.focus` examples: `{view:"storage", focus: DiskTelemetry.id}`, `{view:"sensors", focus: sensorId}`.
- **[BREAKING 1.2]** `components/layout/TopBar.tsx`, `HeaderStrip.tsx` and `StatusFooter.tsx` are deleted (with `VIEW_TABS`, `fkeyFor` and the `useNow` re-export). The shell below replaces them.

#### 4.6.1 Shell: Sidebar, Toolbar, page chrome, tight mode [NEW 1.2] (S)

Reference: `docs/design/SPEC.md` §1–§4 and every render. Three things differ from the renders on purpose: (a) the window keeps the **native title bar**, so the toolbar has no minimise / maximise / close buttons and no drag region; (b) the sidebar footer has **no connection line** (requirement 3); (c) the toolbar shows a field **only on pages that have a filter** (there is no global search this round).

**Window (R).** `decorations: true`, `theme: "Light"`, `backgroundColor: "#F5F5F7"`, 1600×960, minimum 1280×800 (Tauri's `width` / `height` are the inner size, so the WebView is exactly 1600×960 and the renders apply unchanged). No window permission is added to the capability.

**Layout (`App.tsx`).**

```
┌────────────┬───────────────────────────────────────────────┐
│ <Sidebar>  │ <Toolbar>                       52 px         │
│ 220 px     ├───────────────────────────────────────────────┤
│ (200 px    │ <AppBanners>   full-bleed, 0–3 bars           │
│  tight)    ├───────────────────────────────────────────────┤
│            │ <main id="nexum-main">  the active view       │
└────────────┴───────────────────────────────────────────────┘
```

- Root: `grid h-full grid-cols-[var(--sidebar-w)_minmax(0,1fr)]`; right column `flex min-w-0 flex-col`. `<PageChromeProvider>` wraps Toolbar + banners + main. `UpdaterProvider` joins the provider stack.
- `<main>` by `PAGE_KIND[view]` (`types.ts`): **grouped** pages (Dashboard, System, Storage, Cooling, Gaming, Clean caches) → `overflow-y-auto bg-canvas`, and App wraps the view in `px-(--page-pad-x) py-(--page-pad-y)` (28 px / 20 px; 24 px sides in tight mode); **list** pages (Sensors, Drivers) → `overflow-hidden bg-content`, no padding, the view fills the height (`flex min-h-0 flex-1 flex-col`) and scrolls its own table. **Views add no outer page padding and no page background of their own.**
- The error boundary, `Suspense`, lazy views, key handling, nav events, the cleanup modal, `SettingsModal`, `PawnIoConsent`, `ToastHost` and `TraySensorSync` stay as they are. New mounts: `UpdatePrompt` (first-run question, §2.15.3) and `UpdateDialog`.

**`components/layout/Sidebar.tsx`** — `Sidebar(props: { view: ViewId; onNavigate(v: ViewId): void })` (SPEC §2):
- Brand row (52 px, aligned with the toolbar): `<NexumEmblem size={18} />` + the `NEXUM` wordmark (11 px tall, from `docs/design/logo/wordmark.svg`, inline SVG in ink).
- Groups from `NAV_GROUPS`: `Monitor` (Dashboard F1, Sensors F2, System F3), `Hardware` (Storage F4, Cooling F6, Drivers F7), `Tools` (Gaming F8, Clean caches F9). Row = 16 px icon + `VIEW_TITLES[view]` + right-aligned key hint taken from `FKEY_MAP` (the cleaner row shows `F9`). `<nav aria-label="Views">`, rows are buttons, the selected row has `aria-current="page"`.
- Selected row: crimson (`bg-brand`, white text and icon, hint `text-brand-key`). This is the only crimson in the shell besides the emblem. Hover `bg-hover`, pressed `bg-selected`, focus `.focus-inset` (`.focus-inset-on-brand` on the selected row).
- **Storage badge:** shown when `useHealth().conditions` contains a condition with `source === "drive"` and severity `warn` or `crit`: a white capsule with the status icon and the count, warn palette, or the crit palette with the octagon when any of them is crit; `title` = `1 drive needs attention` / `<n> drives need attention`. It keeps its status colours on the selected row.
- **Footer card** (machine identity), bottom of the sidebar: line 1 monitor icon + `info.hostname` (600); line 2 `<short CPU> · <short GPU>` (`shortCpuName`, `shortGpuName` from `lib/format`); line 3 shield + `Administrator` or lock + `Standard user` (`info.isAdmin`); line 4 **Nexum's own usage** `Nexum 0.6% CPU · 142 MB` (`useSelfUsage()`, `—` until the first event; `title` = `Nexum's own use of this PC: <n> processes. CPU is a share of the whole PC.`). No dot, no link state, no poll rate here.

**`components/layout/Toolbar.tsx`** — `Toolbar(props: { view: ViewId; onRefresh(): void | Promise<unknown>; onSettings(): void; onOpenUpdate(): void; refreshing?: boolean })` (SPEC §1, §4). 52 px, `bg-toolbar`, bottom hairline, left padding `--page-pad-x`. Left to right:
1. **Title block**, only in tight mode or on a list page: `<h1>` `VIEW_TITLES[view]` (`text-toolbar-title`) and the page's `subtitle` (`text-toolbar-sub text-ink-2`, max 420 px, ellipsis).
2. **Health pill**: `<StatusPill size="pill" tone={healthLevelTone(level)} summary={health.summary} onClick expanded>` with the label; click opens the popover of SPEC §4 (440 px; `N active conditions` + `evaluated HH:MM:SS`; one row per condition with icon, title, detail and its action button; the rules as a footer; Esc closes). `title` / `aria-label` list the conditions (§5.3).
3. **Freshness**, hidden in tight mode: `Updated <n> s ago · <rate>` — `n = max(0, round((now − agent.lastPacketTs) / 1000))`; rate from `settings.pollIntervalMs`: 1000 → `1 Hz`, 500 → `2 Hz`, 250 → `4 Hz`, 2000 and above → `every <s> s`. Not rendered while `lastPacketTs` is null or the sensor data is stale (§5.1 `offline`): when there is nothing to say, the toolbar says nothing.
4. Spacer.
5. **Update indicator** (§2.15.7), only while an update is on offer.
6. **Filter field**, only when the active view published `search` (§ below): 210×28, leading search icon, the view's placeholder (`Filter sensors`, `Filter drivers`), trailing `kbd` `Ctrl K`; Esc clears, then blurs.
7. **Rescan** icon button (`title` `Rescan (F5)`, the icon spins while `refreshing` or while the returned promise is pending) and **Settings** icon button (`title` `Settings`). 30×28 each.

No caption buttons, no `data-tauri-drag-region`, no `@tauri-apps/api/window` calls.

**Page chrome (`components/layout/PageChrome.tsx`, exists).** How a view publishes its title, subtitle, actions and filter:

```ts
export interface PageSearch { value: string; onChange(value: string): void; placeholder: string; ariaLabel?: string }
export interface PageChrome { subtitle?: string | null; search?: PageSearch | null }
export function PageChromeProvider(props: { children: ReactNode }): JSX.Element;      // App.tsx
export function usePageChrome(chrome: PageChrome): void;                              // every view, every render
export function usePageChromeValue(): PageChrome;                                     // Toolbar only
export function PageHeader(props: { view: ViewId; description?: ReactNode; actions?: ReactNode;
                                    tightActions?: "row" | "none"; className?: string }): JSX.Element | null;
```

- The **title** is never passed: it is `VIEW_TITLES[view]`.
- Every view calls **`usePageChrome({ subtitle })`** with a short live summary for the toolbar (shown in tight mode and on list pages). Sensors and Drivers also pass **`search`** (their existing filter state); the toolbar renders the field and the view no longer renders its own search box. The call is a no-op without a provider, and the chrome is cleared when the view unmounts.
- Every **grouped** page renders **`<PageHeader view="…" description="…" actions={…} />`** as its first child. Regular mode: large title (26/32 semibold) + description + the actions on the title baseline. Tight mode: the title is in the toolbar, so `PageHeader` renders only a compact right-aligned actions row — or nothing with `tightActions="none"`, when the view puts the same controls into its first card header (use `useTightMode()` to render them once). List pages never render `PageHeader`.
- At most one action on a page is `variant="primary"`, and only when the page has no dialog that owns the primary action (§4.9 rule 1).

| View | Toolbar `subtitle` (live) | `PageHeader` `description` (regular mode) |
|---|---|---|
| Dashboard | `<short CPU> · <short GPU> · up <uptime>` | `<CPU> · <GPU> · <RAM total and type> · up <uptime>` |
| Sensors (list) | `<n> sensors from <m> devices` | – |
| System | the selected tab's name (`Processor`, `Mainboard`, `Memory`, …) | `Processor, mainboard, memory, graphics and Windows. Read once and kept until you refresh.` |
| Storage | `<n> drives · <m> volumes` | `Physical drives with S.M.A.R.T. health, the volumes on each and live throughput.` |
| Cooling | `Case fans · <preset label>` or `GPU tuning · read-only` | `Motherboard fan headers, fixed-speed presets and the temperatures behind fan decisions. GPU values are read-only.` |
| Drivers (list) | `Installed drivers · read-only` | – |
| Gaming | `Frame capture is off` or `<process> · <fps> fps` or `No game detected` | `Frame rate and frame times measured by Intel PresentMon from Windows performance events (ETW). Nothing is injected into games.` |
| Clean caches | `<size> ready · measured <HH:MM>` or `Measuring…` | `Measured first with a dry run. Protected system paths, cookies, logins and personal files are never touched.` |

**Tight mode.** One rule everywhere: the viewport is **at most 1399 px wide or at most 899 px tall** (`TIGHT_MEDIA_QUERY` in `types.ts`).
- CSS: the Tailwind variants **`tight:`** and its complement **`regular:`** (`styles/nexum.css`): `tight:hidden`, `hidden tight:block`, `text-display tight:text-display-tight`. `max-compact:` is the width-only variant (below 1400 px) for the few width-only cases (the Drivers `Category` column).
- JS: **`useTightMode(): boolean`** (`hooks/useTightMode.ts`, exists), only where the DOM differs: `PageHeader`, the S.M.A.R.T. sheet vs. the docked inspector, column sets.
- The variables `--sidebar-w` (220 → 200 px) and `--page-pad-x` (28 → 24 px) switch by themselves; use `w-(--sidebar-w)`, `px-(--page-pad-x)`.
- What changes in tight mode (SPEC "Responsive breakpoints"): sidebar 200 px; page padding 24 px; large titles move into the toolbar; the freshness text hides; KPI numerals 30/34 instead of 36/40; the Gaming hero 64 px instead of 84 px; the S.M.A.R.T. details dock as a 380 px inspector without scrim; pinned-sensor sparklines hide; the update indicator is icon-only.

**App-level banners (`components/layout/AppBanners.tsx`)** — `AppBanners()`, full-bleed bars under the toolbar (`HealthBanner variant="bar"`, SPEC §17), in this order, each only when active: (1) fan fail-safe (`useFanFailsafe`), (2) **sensors** (§4.8.1: `agent.phase === "failed"`), (3) limited mode (rule 9 data; hidden while (2) shows). No banner uses a crimson button.

### 4.7 Shared UI primitives (`components/ui/`, P) — exact props [CHANGED 1.2]

Rule for 1.2: **every export name and every prop of 1.1 stays**, so call sites compile; only the looks change (to `docs/design/SPEC.md`, section numbers below), old variant names stay as aliases, and the additions are optional props or new exports. Everything is exported from `components/ui/index.ts`. Props marked *ignored* are still accepted. A `…` in a signature means the 1.1 props not listed are unchanged.

**Existing primitives**

- `GlassCard({ title?, icon?, actions?, accent?, className?, bodyClassName?, children, ...sectionAttrs })` — the SPEC §6 card: white, radius 14, `shadow-card`, no border, padding 16 × 20; header min-height 22 with the title in `text-title-2` (sentence case). **[CHANGED 1.2]** `accent` and `icon` are *ignored* (cards have no accent bar and no title icon). **[NEW 1.2]** `subtitle?: ReactNode` (callout under the title), `footer?: ReactNode` (footer line: top divider, `margin-top:auto`, callout), `padded?: boolean = true` (`false` for a card whose body is a flush table or list), `selected?: boolean` (`shadow-selected`: 1 px ink + 3 px neutral ring; never crimson). File `components/layout/GlassCard.tsx` (owner P); also exported as **`Card`**.
- `Button({ variant?, size?, icon?, iconRight?, loading?, ...buttonAttrs })` — SPEC §12. `variant: "primary" | "secondary" | "destructive" | "plain"` plus the 1.1 names as aliases: **`gold` → `secondary`**, `teal` → `secondary`, `ghost` → `plain`, `danger` → `destructive`. **[CHANGED 1.2] the default is `secondary`** (was `ghost`). Crimson appears only when a call site writes `variant="primary"`: an old `gold` button does **not** become crimson (the design's "gold → primary" mapping is replaced by this, because a screen may have only ONE primary button; each owner decides which one). `size: "sm" | "md" | "lg"` = 24 / 28 / 32 px (default `md`; `lg` is new). Label 500 13 px (12 px for `sm`), no letter-spacing, no glow. An icon-only button is square and needs `aria-label`.
- `StatusPill({ tone, children, icon?, pulse?, title?, className? })` — **[CHANGED 1.2]** `tone: StatusPillTone = StatusTone | "checking"`. **[NEW 1.2]** `size?: "chip" | "pill"`: `"chip"` (default) is the SPEC §21 status chip (20 px, radius 10, 600 11 px, 13 px icon) used in content; `"pill"` is the SPEC §4 header pill (26 px, 600 12 px label, 15 px icon). `summary?: ReactNode` (rendered after ` · ` in weight 500), `onClick?: () => void` (renders a `<button>` with a 12 px chevron) and `expanded?: boolean` (`aria-expanded`, chevron turned) are for the header pill. Sentence case: no uppercase, no letter-spacing. `pulse` is *ignored*. Colours come only from the status tokens (`STATUS_CLASS`, `CHECKING_CLASS`).
- `STATUS_ICON: Record<StatusTone, LucideIcon>` — **[CHANGED 1.2]** ok `CircleCheck`, warn `TriangleAlert`, crit **the filled octagon** (a local SVG that takes `size` and `className` like a lucide icon; never the outline `OctagonAlert`), info `Info`, unknown **`Contrast`** (half-filled circle; was `Lock`). **[NEW 1.2]** `StatusIcon({ tone: StatusPillTone, size? = 14, className? })` renders the glyph in the tone's icon colour and is the way to draw a status icon anywhere (`CircleDashed` for `checking`). State is never colour alone: an icon and a word always go with it.
- `Toggle({ checked, onChange, label?, description?, disabled?, id?, className?, ariaLabel? })` — SPEC §14: 32 × 18; off = white track, 1 px `control-border` outline, hollow look; on = graphite `control-on` with a white knob. Never crimson, never green.
- `Segmented<T>({ value, options, onChange, size?, ariaLabel?, className?, disabled? })` — SPEC §13: track `seg-track`, selected segment graphite with white 600 text. `size: "sm" | "md" | "lg"`: `sm` / `md` = 22 px segments, **`lg`** (new) = 26 px, 13 px, for view tabs (System, Cooling). `SegmentedOption<T> = { value, label, title?, disabled?, count?: number }` — `count` (new) is shown after the label in tertiary text.
- `Modal({ open, onClose, title?, subtitle?, icon?, children?, footer?, size?, width?, dismissible?, closeOnBackdrop?, initialFocusRef?, ariaLabel?, className?, bodyClassName? })` and `isModalOpen()` — **[CHANGED 1.2]** the scrim is `position: fixed; inset: 0` in a portal on `document.body` and covers the **whole window, sidebar and toolbar included** (`bg-scrim`); panel radius 16, `shadow-sheet`, motion `animate-dialog-in`. **[NEW 1.2]** `variant?: "dialog" | "alert"`: `"dialog"` (default) keeps the header / body / footer layout; `"alert"` is the NSAlert layout of SPEC §18 (468 px wide, the app icon at 56 px from the bundled `icon-128.png`, title 600 16/21, body in secondary text, `footer` buttons right-aligned with min-width 96). Enter triggers the default button, Esc cancels, focus is trapped.
- `EChart({ option, className?, style?, notMerge?, theme?, onInit?, onEvents? })` — **[CHANGED 1.2]** registers `NEXUM_LIGHT_THEME` from `components/ui/echartsTheme.ts` under the unchanged name `"nexum"` (`NEXUM_CHART_THEME`), and registers `MarkLineComponent` too. Charts: no animation for live data, at most one update per animation frame, paused while `document.hidden`.
- `Sparkline({ data, color?, height = 32, className?, fill?, min?, max?, strokeWidth? })` — SPEC §10. **[CHANGED 1.2]** `color` is optional (default `SERIES_HEX.neutral`), `fill` defaults to `false` (when true: a flat 8 % area, no gradient), `strokeWidth` defaults to 1.5. Renders nothing when every point is null. A sparkline never takes a status colour.
- `DottedLeaderRow({ label, value, valueClassName?, className?, hint? })` — **[CHANGED 1.2]** a 28 px key-value row with a hairline bottom border (no dotted leader): label in secondary text, value right-aligned in ink with tabular figures. Also exported as **`KeyValueRow`**.
- `SegmentedBar({ value, segments?, tone?, zoned?, height?, className?, label? })` — **[CHANGED 1.2]** a plain meter: track `meter-track`, graphite fill `meter-fill`, radius 3, default height 6. `tone?: Tone | "auto" | "warn"`: only **`"warn"`** (new) changes the fill (amber `meter-warn`); every other value, `segments` and `zoned` are *ignored*. Also exported as **`Meter`**.
- `DotMatrix({ values, rows?, tone?, className?, height? })` — **[CHANGED 1.2]** thin graphite bars, one per value (0–100); no dots, no glow; `rows` and `tone` are *ignored*.
- `TrendArrow({ delta, invert?, unit?, precision?, showValue?, threshold?, className? })` — colours only: neutral ink-2; no red / green.
- `StatCells({ value, min, max, avg, meta, tempUnit, className? })` — value cell 600 ink with the unit once in tertiary; min / max / avg in secondary, number only.
- `ScrollFade({ children, className?, maxHeight? })` — unchanged.
- `Unavailable({ reason, compact?, className? })` — SPEC §22: em dash + 12 px `Lock` in `text-ink-3`, cause text in the full variant, `title` / `aria-label` in the compact one. Cause texts (`UNAVAILABLE_TEXT`, exact): notElevated `Needs administrator`, pawnIoMissing `Needs PawnIO driver`, pawnIoOutdated `PawnIO update needed`, unsupported `Not reported by this hardware`, **[CHANGED 1.2] agentOffline `Not available right now`**. For `agentOffline` both variants render **only the em dash** with that text as `title` and `aria-label` (no lock: nothing is locked, the value is just not there at the moment). Use `Unavailable` in place of any null value.
- `HealthBanner({ alert, onAction?, onDismiss?, className? })` — SPEC §17: tint, 1 px border and 18 px icon from the status tokens (warn = amber triangle, crit = vermilion **filled octagon**, info = blue); title 600 + detail in secondary; the action is a small **secondary** button (`alert.action.label`), then a plain `Dismiss` (only with `onDismiss`). **[NEW 1.2]** `variant?: "inline" | "bar"`: `"inline"` (default) is the in-page banner (radius 10); `"bar"` is the app-level banner (full-bleed, bottom border only, min-height 44, side padding `--page-pad-x`). `busy?: boolean` shows the action button as loading.
- `renderIcon`, `IconLike` — unchanged.
- `Toast` (`components/feedback/Toast.tsx`): `toast()`, `dismissToast()`, `ToastHost`, unchanged API; white, `shadow-popover`, status icon + text.

**New primitives [NEW 1.2]** (plain working versions exist in `components/ui/controls.tsx`; P finishes them)

- `Tag({ children, title?, className? })` — SPEC §21 neutral tag: 18 px, radius 5, `bg-tag`, 600 10.5 px secondary text (`PWM`, `Admin`, `Optional`, `BIOS auto`, `GPU-bound`, `Preview`). A tag never conveys health.
- `Checkbox({ checked, onChange, label?, disabled?, indeterminate?, id?, className?, ariaLabel? })` — SPEC §14: 15 × 15, radius 4, graphite when on.
- `TextField({ value, onChange, placeholder?, icon?, kbd?, invalid?, message?, mono?, className?, inputRef?, ...inputAttrs })` — SPEC §11: 28 px, radius 6, white, 1 px `control-border`; `onChange(value: string)`; `kbd` = trailing key hint; `invalid` + `message` = critical border and a message line with the octagon; `mono` = JetBrains Mono 12 (`name.exe`).
- `IconButton({ icon, label, onClick?, active?, disabled?, loading?, spin?, className?, ...buttonAttrs })` — 30 × 28, radius 7, 17 px icon; `label` is the `title` and `aria-label`.
- `Slider({ value, onChange, onCommit?, min = 0, max = 100, step = 1, disabled?, ariaLabel, className? })` — SPEC §15: 4 px track, graphite fill, 16 px white thumb; arrows ±1 step, Page Up / Down ±10.
- `EmptyState({ icon, title, body?, note?, action?, children?, className? })` — SPEC §20: 72 px icon tile, title 600 22/28, body, tertiary note, at most one (primary, large) button passed as `action`, optional tiles as `children`.
- `InkLink({ children, onClick?, chevron? = true, className?, ...buttonAttrs })` — SPEC §9: ink text, 500, grey 13 px chevron, underline on hover. **Links are never red and never blue.**
- `ProgressBar({ value, indeterminate?, label?, className? })` — 4 px graphite bar (`value` 0–100 or null); used by the update dialog and the cleanup progress.

**Colour maps (`components/ui/tones.ts`, foundation)**: `StatusTone`, **`StatusPillTone`**, `STATUS_HEX` (icon colours: ok `#28A04D`, warn `#C47A00`, crit `#D9381E`, info `#1F74DB`, unknown `#7A8291`), **`STATUS_TEXT_HEX`**, `STATUS_CLASS: Record<StatusTone, { text, bg, soft, border, icon }>` (`text` = AA text colour, `bg` = solid icon colour, `soft` = tint, `border` = tint border; `icon` is new; the unused `led` field was removed at 1.2 integration), **`CHECKING_CLASS`**, `SERIES_HEX` (re-exported from `echartsTheme.ts`: cpu navy `#1E4FC2`, gpu teal `#0E97A6`, ram violet `#B06CF0`, vram graphite `#5B5B61` and always dashed, disk = cpu, net = gpu, `single` `#3A3A3E`, `neutral` `#8E8E95`), **`SERIES_CLASS`**. The legacy maps `TONE_HEX`, `TONE_CLASS` and `toneForLevel` existed for the migration only and were **removed at 1.2 integration** (no file used them); the type `Tone` stays for the ignored `accent` prop of `GlassCard`. **`components/ui/echartsTheme.ts`** exports `NEXUM_CHART_THEME`, `NEXUM_LIGHT_THEME`, `SERIES_HEX`, `SeriesKey`, `nexumLine(name, key, data, unit?, opts?)` (a themed line whose right end carries `<value><unit> <name>`), `FRAMETIME_MARKLINE`, `CHART_HEX`, `CHART_FONT`, `VRAM_DASH`, `CHART_GRID_WITH_END_LABELS`. **No hex colour appears in any other `.ts` / `.tsx` file**: use these maps or the CSS variables (`var(--color-series-cpu)`), which are always emitted.

**Not primitives:** `SensorRow` stays in `components/sensors/` (V1). `LedProgress` (V3) and `FanGauge` (V2) lose their LED / gauge looks inside their owners' folders (§4.10.3); `StorageGauge` (V2) had no caller left after the Dashboard got its own `DrivesCard` and was deleted at 1.2 integration. Tooltips are the native `title` attribute this round (SPEC §23's custom tooltip is not built); chart tooltips come from the chart theme.

Purge flow: `components/cleaner/OneClickPurgeModal.tsx` (V3) — `<OneClickPurgeModal open onClose autoStart? />` (props unchanged): scan → "Reclaimable caches" headline (§3.1 quick path text) → per-category toggles (unavailable ones disabled with `Needs administrator`) → live progress via `purge-progress` → `CleanupSummary` "Freed 6.4 GB in 2.3 s" + per-category notes + "View log" (opens the folder of `logPath`) + "Open Reliability Monitor" link next to `dumps`. **[CHANGED 1.2]** it uses `Modal variant="alert"`; its `Clean <size>` button is the primary; `Cancel` is secondary and has the initial focus.

### 4.8 Copy rules (ROADMAP §6.6) — all UI text [CHANGED 1.2]

- **Banned** in user-visible strings (case-insensitive, whole word): `boost`, `optimize`/`optimise`, `speed up`, `free RAM`, `junk`, `trash`, `purge` (as a button/CTA or heading), `deep purge`, `outdated`, and **[NEW 1.2] `agent`** (also `agents`, `agent's`). `Optimal` only as the rule-backed pill label from `lib/status.ts`. Identifiers in code are exempt (`AgentStatus`, `agent-status`, `agentOffline`, `agentLost`, `restartAgent`, `nexum-agent.exe` as a process name in an exclusion list).
- **[NEW 1.2] "User-visible" means** anything that can reach a screen, a tooltip, a tray menu or tooltip, a notification, a dialog, an exported report or a toast: JSX text and attributes, string literals in `.ts` and `.tsx` (including `lib/`, `types.ts` and the mock), Rust strings returned from commands (`Err(String)`), put into emitted payloads or shown by the tray. Not user-visible: log lines (`eprintln!`), `AgentStatus.message` (§2.3), test code, comments, documentation (README, SECURITY and this file may use "agent" as the technical name of the sidecar).
- "Trash"/"junk" → "Reclaimable caches"; "Deep Purge" → "Cache cleanup". "Freed" is used only for disk bytes.
- Gaming and tuning copy: never "boost", "game mode", "game booster" or "FPS boost"; AMD's boost clock is shown as `Max clock`. The GPU tuning panel never says "overclock", "tune" as a call to action, or "unlock" — it is read-only. Frame capture never claims to be "safe with anti-cheat"; it states what it does (ETW, no injection) and that the anti-cheat matrix is untested until the README says otherwise.
- **[NEW 1.2] Sentence case everywhere.** No uppercase-tracked labels (`.label-caps` no longer transforms text, so write the text the way it should read). A button that opens a confirmation ends with `…` and is secondary; the dialog owns the primary button.
- **[NEW 1.2] Plain words for plain things:** say what the user can see or do, not which part of Nexum did it. No process names, protocol numbers, pids or exit codes in the UI.
- Every status claim (pill, chip, badge) has a hover showing the rule that produced it.
- Units: one unit per list (GB, or MB below 1 GB); buttons repeat the headline number exactly. In tables the unit is shown once (value cell or group row), never in the Min / Max / Avg cells.
- Buttons and icon-only controls carry text labels or `title` + `aria-label`.
- Labels (MF-9): `Per-core load (8C/16T)`; CPU fan KPI `CPU fan` (fan whose `name` matches `/^CPU Fan$/i`, else first fan whose `hwId` is not a GPU and name contains `CPU` but not `Opt`; else `<Unavailable>` — never another fan, never an average); GPU `Edge temp` + `Zero-RPM idle` tag when `fanRpm === 0 && (fanPct ?? 0) === 0`; memory `2 of 4 DIMMs`; uptime shown once per view from `bootTs`.
- Preset subtitle: `Fixed speed, ignores temperature` (Cooling, under Silent/Balanced/Turbo/Custom). Drivers status bar: `Nexum never installs drivers.`
- Status words are the same everywhere: `Good` / `Worn` / `Failing` / `Unknown` (drive labels come from the classifier, §1.1.3), `Optimal` / `Attention` / `Critical` / `Partial sensors` / `Checking` (pill).

#### 4.8.1 Sensor-service wording [NEW 1.2]

**Behaviour.** While sensors work the UI shows **nothing** about how they are read: no "linked", no dot, no status row. When the sensor service stops, Rust restarts it by the §2.3.1 policy and the UI still shows nothing; values that are missing meanwhile render `—` with the tooltip **`Not available right now`** (`NOT_AVAILABLE_TEXT`; `<Unavailable reason="agentOffline">`), and the pill reads `Checking`. Only when Rust reports `phase:"failed"` does the UI show **one banner** (app level, under the toolbar, warn tone, triangle icon):

- Title (exact): **`Nexum can't read sensors right now.`** (`SENSORS_DOWN_TITLE`)
- Reason line under it, by `failReason` (`SENSORS_DOWN_REASON`; no line when null): blocked `Windows security blocked part of Nexum.` · missing `Part of Nexum is missing. Installing Nexum again fixes this.` · crashed `Sensor reading stopped and could not be restarted.` · notResponding `Sensor reading stopped responding.` · startFailed `Sensor reading could not be started.`
- One button: **`Try again`** (`SENSORS_RETRY_LABEL`, secondary) → `api.restartAgent()`; it shows as loading until the phase leaves `starting`. No Dismiss.
- Nowhere else is the same message shown as a banner. The pill reads `Attention · Sensors unavailable` and the Health card lists the condition as an ordinary row (§5.2 rule 2).

**Every "agent" string at commit `b274964` and what replaces it.** Line numbers are those of that commit.

| Where | Old text | New text | Owner |
|---|---|---|---|
| `components/ui/Unavailable.tsx:11` | `Hardware agent offline` | `Not available right now` (em dash only, no lock) | P |
| `components/system/specModel.ts:43` | `Hardware agent offline` | `Not available right now` | V2 |
| `components/telemetry/KpiStrip.tsx:20` | `Agent offline` | `Not available right now` | V1 |
| `components/tuning/GpuTuningPanel.tsx:355` (title) | `Hardware agent offline` | `Not available right now` | V2 |
| `components/gaming/FrameSessionBar.tsx:98` | `Waiting for the hardware agent to start frame capture…` | `Starting frame capture…` | V3 |
| `components/gaming/FrameSessionBar.tsx:99` | `Hardware agent offline. Frame capture starts when it reconnects.` | `Frame capture is paused. It starts again by itself.` While `agent.phase === "failed"` (nothing restarts by itself; the app banner offers `Try again`): `Frame capture is paused until Nexum can read sensors again.`, a pause glyph instead of the spinner, and the empty-state title `Frame capture is paused`. | V3 |
| `components/storage/SmartDrawer.tsx:184` | `Min and max since the hardware agent started. Average is in the Sensors view.` | `Min and max since Nexum started. Average is in the Sensors view.` | V2 |
| `views/CleanerView.tsx:40` | `%ProgramData%\Nexum and the hardware agent's folder` | `%ProgramData%\Nexum and Nexum's own program folder` | V3 |
| `views/SensorsView.tsx:286` | `Every sensor the hardware agent reads, with session Min, Max and Avg. Log any of them to a CSV file.` | `Every sensor this PC reports, with session Min, Max and Avg. Log any of them to a CSV file.` | V1 |
| `views/SensorsView.tsx:391` | `The sensor list appears when the hardware agent is running. Use Restart agent in Settings if it stays offline.` | `The sensor list appears as soon as Nexum can read the sensors.` | V1 |
| `views/SensorsView.tsx:396` | `The hardware agent has not sent a sensor list yet.` | `Reading the sensor list…` | V1 |
| `views/SystemView.tsx:102` | `These details come from the hardware agent, which is not running.` | `These details are not available right now.` | V2 |
| `views/SystemView.tsx:103` | `The hardware agent did not return these details.` | `This PC did not report these details.` | V2 |
| `components/layout/StatusFooter.tsx:100,109` | `…(Nexum, hardware agent, WebView2)…`, `Agent link`, `Agent offline` | file deleted. Nexum's own usage moves to the sidebar footer with the title `Nexum's own use of this PC: <n> processes. CPU is a share of the whole PC.` No link indicator anywhere. | S |
| `components/layout/SettingsModal.tsx:552` (section) | `Hardware Agent` | `Sensors` | S |
| `…SettingsModal.tsx:313–314` (status row) | `Running` / `Stopped` / `Unknown` | row `Sensor reading`: `Working` (phase running) · `Starting…` (starting, restarting) · `Not working` (failed, stopped) | S |
| `…SettingsModal.tsx:558` (button) | `Restart agent` | `Restart sensor reading` | S |
| `…SettingsModal.tsx:296` | `Restart requested. The agent reconnects in a few seconds.` | `Restarting sensor reading. Values return in a few seconds.` | S |
| `…SettingsModal.tsx:383` | `How often the hardware agent samples sensors.` | `How often Nexum reads the sensors.` | S |
| `…SettingsModal.tsx:568` | row `Agent protocol` | removed | S |
| `…SettingsModal.tsx:569` | `agent.message` shown in monospace | removed (`message` is never rendered, §2.3) | S |
| `lib/status.ts:157` (rule text) | `Attention when the hardware agent sends no data for 5 seconds (or 3 poll intervals)` | `Attention when Nexum cannot read sensors and restarting sensor reading did not help` | S |
| `lib/status.ts:273–275` (rule 2) | `Agent offline` / `Hardware agent offline` / `Sensor values are not updating. Use Restart agent in Settings.` | short `Sensors unavailable` / title `Nexum can't read sensors right now.` / detail = the reason line, or `Sensor values are not updating.` when there is none; action `Try again` | S |
| `lib/mock.ts:1707` | the `agentLost` fail-safe message (below) | the new message | S |
| `lib/mock.ts` (7 × `Hardware agent is not running`, `:2651` spec error, `:4008`) | – | the new Rust texts below | S |
| `lib/mock.ts:1759–1765` (`AgentStatus.message`) | `Restarting hardware agent…` etc. | diagnostic only; reword without "agent" so the copy check stays clean | S |
| `src-tauri/src/alerts.rs:1343` (tray tooltip head) | `Nexum · Agent offline` | `Nexum · Sensors unavailable` when `phase == failed`; plain `Nexum` while starting or restarting | R |
| `src-tauri/src/failsafe.rs:16` (`agentLost` banner) | `Fan control was interrupted and the hardware agent is not running. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.` | `Fan control was interrupted and Nexum is no longer controlling the fans. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.` | R |
| `src-tauri/src/agent.rs:34, 362` (`ERR_NOT_RUNNING`), `:354`, `:844` | `Hardware agent is not running`, `Hardware agent exited before answering`, `Hardware agent exited` | `Not available right now. Try again in a moment.` | R |
| `src-tauri/src/agent.rs:35, 363` (`ERR_NO_ANSWER`), `:351` | `Hardware agent did not answer`, `Timed out waiting for the hardware agent (<cmd>)` | `That took too long. Try again.` | R |
| `src-tauri/src/agent.rs:322` | `Could not talk to the hardware agent: <e>` | `Not available right now. Try again in a moment.` (the detail goes to stderr) | R |
| `src-tauri/src/agent.rs:460` | `The hardware agent could not run this command` | `Nexum could not do that. Try again.` | R |
| `src-tauri/src/agent.rs:1185` | `The hardware agent could not reset the sensors` | `The sensor statistics could not be reset. Try again.` | R |
| `src-tauri/src/spec.rs` (`SystemSpec.errors`, §2.6) | `Hardware agent is not running` / `Hardware agent did not answer` | `Hardware details are not available right now.` / `Hardware details took too long to read. Press F5 to try again.` | R |
| `src-tauri/src/agent.rs:170–178, 251, 584–610, 735, 823–827, 860, 894–910` | `AgentStatus.message` values | diagnostic only, never rendered; R rewords them without "agent" if the CI check reads them | R |

Texts that come from the sidecar (`ack.message`, `error.message`, `frameSession.message`, `tuningState.message`, `timingsNote`) contain no "agent" today and do not change (the sidecar is not touched). The tray menu labels contain none.

### 4.9 Design tokens (Tailwind v4 `@theme` in `styles/nexum.css`, foundation) [BREAKING 1.2]

The dark teal / gold theme is gone. `styles/nexum.css` is the light theme of the design package (`docs/design/tokens.css` holds the same values with their rationale; `docs/design/contrast.txt` the computed contrast of every text pair). **Light theme only**: `color-scheme: light`, no `dark:` variants, no theme switch.

**Four rules the tokens cannot enforce (they are review criteria):**
1. **Crimson (`brand`, `#C8102E`) has exactly three jobs:** the selected sidebar row, the ONE primary button of a screen (the default button of a dialog or sheet, or the single call to action of an empty state), and the logo. Never on data, charts, values, chips, links, toggles, focus rings, table rows or banners. A button that opens a confirmation is secondary; the dialog owns the primary.
2. **Controls are graphite:** toggles, checkboxes, radios, segmented controls, sliders, meters, the focus ring and links (`control-on` `#2C2C2E`, `meter-fill`, `ink`). Selection inside content is neutral grey (`bg-selected`, `shadow-selected`), never red.
3. **Status is icon + word + tint**, never colour alone. Critical is vermilion (`crit`), a different hue from the brand, and always carries the **filled octagon** and its word. Driver age is neutral grey.
4. **Chart series never use red, amber or green.** CPU navy, GPU teal, RAM violet, VRAM graphite and dashed, single-series charts ink.

**Tokens** (utility names; every one is also a CSS variable `--color-<name>` etc. and is always emitted, so `var(--color-series-cpu)` works in inline styles, SVG and chart options):

| Group | Names |
|---|---|
| Brand | `brand` `#C8102E`, `brand-hover`, `brand-pressed`, `brand-key` (key hint on the selected row) |
| Text | `ink` `#1D1D1F` (primary), `ink-2` `#5F5F65` (secondary), `ink-3` `#646469` (tertiary: units, meta, axis labels), `ink-disabled` |
| Surfaces | `canvas` `#F5F5F7` (grouped pages), `content` white (list pages), `card`, `sidebar` `#EFEFF2`, `sidebar-card`, `toolbar` `#FAFAFB`, `inset` (wells), `row-alt` (zebra), `hover`, `selected`, `pressed`, `disabled`, `scrim` |
| Lines | `hairline` / `line` (8 % black), `subtle` (12 %), `strong` (20 %), `divider` `#ECECEF` |
| Controls | `control-border` `#86868B`, `control-on` `#2C2C2E`, `seg-track`, `seg-count`, `slider-track`, `meter-track`, `meter-fill`, `meter-warn`, `kbd`, `tag`, `icon`, `icon-2`, `fill` (black, for `bg-fill/5`-style overlays) |
| Status (each: text / `-icon` / `-bg` / `-border`) | `ok` `#1B7A3A`, `warn` `#925200`, `crit` `#B3260F`, `info` `#0A5FC2`, `unknown` `#535A66`. The bare name is the **text** colour (AA on white and on its own tint); `-icon` is the glyph / dot colour; `-bg` + `-border` make the tint. Use `STATUS_CLASS` from `tones.ts` rather than spelling them. |
| Series | `series-cpu`, `series-gpu`, `series-ram`, `series-vram`, `series-single`, `series-neutral`; `chart-grid`, `chart-axis`, `chart-ref` |
| Type (`text-<name>` sets size, line height, tracking and weight) | `hero` 84, `hero-tight` 64, `display` 36/40, `display-tight` 30/34, `large-num` 26/30, `title-1` 26/32, `title-2` 15/20, `toolbar-title` 15/19, `toolbar-sub` 11.5/14, `headline` 13/18, `body` 13/20, `table` 12.5/24, `callout` 12/17, `caption` 11/14, `mono` 11.5/16. (`text-toolbar` is the toolbar **colour**; the title size is `text-toolbar-title`.) |
| Radii | `rounded-xs` 4, `-sm` 6, `-btn` 7, `-md` 7, `-lg` 10, `-card` 14, `-sheet` 16 |
| Shadows | `shadow-card`, `-raised`, `-popover`, `-sheet`, `-control`, `-control-disabled`, `-primary`, `-selected`, `-focus` |
| Layout variables | `--sidebar-w` 220 (200 tight), `--toolbar-h` 52, `--nav-item-h` 28, `--page-pad-x` 28 (24 tight), `--page-pad-y` 20, `--grid-gap` 16, `--card-pad-x` 20, `--card-pad-y` 16, `--row-h-dense` 24, `--row-h-regular` 32, `--inspector-w` 380, `--sheet-w` 520, `--dialog-w` 468 |
| Motion | `--dur-instant` 80 ms, `--dur-fast` 140, `--dur-base` 220, `--dur-slow` 300; `ease-standard`; `animate-view-in`, `animate-fade-in`, `animate-dialog-in`, `animate-sweep`. 1 Hz sensor text never animates; `prefers-reduced-motion` sets everything to 0. |
| Variants | `tight:` (≤ 1399 px wide or ≤ 899 px tall), `regular:` (its complement), `max-compact:` / `compact:` (width 1400 only) |
| Helper classes | `.num` / `.tnum` (tabular figures), `.zebra` (even children get `row-alt`), `.link-ink`, `.focus-inset`, `.focus-inset-on-brand`, `.kbd`, `.kbd-sm` |

**Legacy names are aliases for the migration only** and must not be used in new code: `canvas-0`, `canvas-1`, `card`, `line`, `silver` (= `ink-2`), `muted` (= `ink-3`), `teal` and `gold` (= graphite `control-on`; `gold` is **not** crimson), `purple` (= `series-ram`), `rose` (= `crit`), `cyan` (= `info`); the classes `.glass`, `.glass-strong`, `.label-caps`, `.led-*`, `.glow-*`, `.text-glow-*`, `.leader` existed flat during the migration. **Removed at 1.2 integration**, once no file used them: those classes and the colour aliases `canvas-0`, `canvas-1`, `silver`, `muted`, `teal`, `gold`, `purple`, `rose`, `cyan` (`card`, `line` and `ink` stay). **Done means:** in an owner's files there is no `text-slate-*`, `bg-white/…`, `border-white/…`, `bg-black/…`, `text-rose-*`, `text-purple-*`, `shadow-[…rgba…]`, no legacy colour name (`teal`, `gold`, `rose`, `cyan`, `silver`, `muted`, `canvas-0`, `canvas-1`), no `uppercase` + `tracking-[…]` label and no hex colour. Codemod table: `text-slate-100/200/300` → `text-ink`; `text-slate-400` → `text-ink-2`; `text-slate-500/600/700` → `text-ink-3`; `bg-white/[a]` → `bg-fill/[a]` (same alpha); `border-white/…`, `divide-white/…` → `border-line`, `divide-line`; `bg-black/…` → `bg-inset`; `text-rose-300/400` → `text-crit`; purple → `series-ram`; glow shadows → delete; `text-teal` / `bg-teal` / `border-teal` → by meaning: accent or selection → `text-ink` / `bg-control-on` / `border-ink`, "ok" → `text-ok`; `gold` → by meaning: the one call to action → `Button variant="primary"`, GPU series → `series-gpu`, anything else → neutral; `cyan` → `info`.

**Focus ring** (SPEC §24): graphite, 2 px, with a 1 px gap; never crimson. It is drawn as an **outline** on `:focus-visible` (not a box-shadow, so a component's own shadow cannot erase it and it survives Windows high-contrast mode). Inside rows, list items and clipped containers add `.focus-inset`; on the crimson selected sidebar row `.focus-inset-on-brand`. Never remove the outline without replacing it.

**Fonts.** **Inter (400 / 500 / 600) for all UI text and all numbers**, with tabular figures (`.num`, `.tnum`, or `tabular-nums`) wherever numbers line up or change in place. **JetBrains Mono (400 / 500) only for identifiers**: hex IDs, INF names, hardware IDs, paths, serials, `name.exe` inputs. Never SF Pro. Both are bundled from the `@fontsource` packages through `styles/fonts.css` (no CDN, no network fonts). No other weight is shipped; `font-bold` and heavier resolve to 600. The body sets `font-feature-settings: "cv05"`, which the bundled Inter subset does not contain (verified: it has `tnum`, not `cv05`), so it has no effect today; do not rely on it.

**Charts** (SPEC §25; theme in `components/ui/echartsTheme.ts`): live telemetry is **unstacked** lines on a labelled 0–100 % y-axis; series with no data are hidden; line width 1.75, no symbols; solid grid lines `chart-grid`, x-axis line only; labels Inter 500 11 px in `ink-3`; reference lines dashed `chart-ref` with an end label. Multi-series charts label every line end with its live value (`nexumLine()`; grid right margin 92) and have **no legend row**. The tooltip appears only on hover (never pinned, never part of the default render). No animation for live data.

**Layout:** 12-column grids with a 16 px gap, or `auto-fit, minmax()`; cards end at content or at a footer line, not at arbitrary whitespace; dates never wrap; dense tables use 24 px rows with zebra and no row borders; numbers right-aligned.

**Deliberate differences from the design package** (decided by the lead or the contract owner; the package's files in `docs/design/` are not edited to match):
1. Native title bar: no caption buttons, no drag region (§4.6.1).
2. Sidebar footer: no "linked" line; the fourth line is Nexum's own usage (§4.6.1, requirement 3).
3. The toolbar field exists only on pages with a filter; there is no global search (§4.6.1).
4. The focus ring is an outline with the same look (above).
5. The legacy `gold` name maps to `secondary` (buttons), to graphite (the colour token) and to the GPU series colour (`TONE_HEX`), never to the brand: crimson needs an explicit `variant="primary"` (§4.7).
6. Tooltips are native `title` attributes (§4.7).
7. The toolbar title size token is `toolbar-title` (the package's `--text-toolbar` collides with the `toolbar` colour: `text-toolbar` would set a colour).
8. Retired LED classes (`.led-gold` …) are neutral grey, not crimson (migration only; the classes were removed at 1.2 integration).

### 4.10 View requirements (D, E) — from ROADMAP MF-1/2/5/9/10, §3, §6.5

**[CHANGED 1.2]** The look and layout of every view are redefined by §4.10.3. The data rules, texts and behaviours in §4.10, §4.10.1 and §4.10.2 stay in force, except the lines §4.10.3 lists as superseded. Colour words in the 1.1 text ("rose", "amber banner", "gold") now mean the status tokens of §4.9 (crit, warn) — never the brand.

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

#### 4.10.3 v1.2 redesign: view requirements (V1, V2, V3) [NEW 1.2]

**Acceptance.** Each view must match its render in the design package (`design-final/renders/*.png`, markup and CSS reference in `design-final/mocks/*.html`) at **1600 × 960**, and the **1280 × 800** render (Dashboard, Sensors, Drivers, Storage, Gaming) in tight mode, with the mock data of `?rig=owner` — apart from the three shell differences of §4.6.1. Views without a 1280 render follow the tight-mode rules of §4.6.1. Where a render shows wording that conflicts with §4.8 or §4.8.1, this contract wins.

**For every view.** No behaviour change: every 1.1 feature, control, text rule and data rule of §4.10, §4.10.1 and §4.10.2 stays, unless a line below says otherwise. Where the design package was written before 1.1 landed and shows no treatment for a 1.1 component, apply the same system to it (cards, key-value rows, graphite controls, status chips, neutral tags, ink links). The view's files meet the "Done means" rule of §4.9. Every view calls `usePageChrome`; grouped pages start with `PageHeader` (§4.6.1). At most one `variant="primary"` button on screen at any time. Charts use the theme and `nexumLine()` (§4.7); a chart's default render never shows a tooltip (delete any `dispatchAction("showTip")`). Numbers use Inter with tabular figures; JetBrains Mono only for identifiers. Missing values use `<Unavailable>`; a large value slot (KPI, hero) shows `—` at display size in tertiary text with the cause in the meta line.

Superseded lines of §4.10 / §4.10.2 (everything else there still holds): the Dashboard's "Storage with a `Life NN%` chip" becomes the Drives card below; Drivers' stat tiles move to the status bar; Storage's per-drive cards become a table; "sticky `Ready to clean` footer" becomes the summary column; the Sensors toolbar search moves to the app toolbar.

**V1 · Dashboard** (`DashboardView`, `telemetry/*`; renders `dashboard-1600x960`, `dashboard-1280x800`, `dashboard-limited-1600x960`)
- Grid: KPI strip, then 8 + 4 columns (Load chart | Health + This PC), then 4 + 4 + 4 (Pinned sensors | Cooling | Drives). The bottom row stretches to the window; every card ends at content or a footer line.
- `KpiStrip`: **one card** with cells divided by 1 px `divider` (`repeat(auto-fit, minmax(150px, 1fr))`, 5 cells, 6 while `fpsKpi().visible`): label with an 8 px series dot (CPU navy, GPU teal, Memory violet, Video memory graphite, CPU fan and Frame rate neutral), value in `text-display` (`text-display-tight` in tight mode) with the unit in 500 16 px secondary, one meta line, a 22 px sparkline in the series colour. The Frame rate cell stays clickable (→ Gaming) with hover and focus states.
- `LiveChart` ("Load"): `nexumLine()` series with end labels, no legend, range `Segmented` (1 min / 2 min / 10 min as today's options allow), subtitle `Share of capacity in use · lines labelled with live values`.
- `HealthAlertsCard` ("Health"): rows with status icon, title, detail, a small secondary action and a plain `Dismiss` where dismissal exists; header meta `<n> item(s) need attention`; when empty `No active alerts` and the rules. `DriveWearBanners` stay (in-page `HealthBanner`s for drive conditions, §5.4).
- `SystemSummaryCard` ("This PC"): key-value rows Motherboard, Processor, Graphics, and Windows (regular mode only); link `System`.
- `PinnedSensorsCard`: up to 5 rows (name, device, value 600, `max`), an 18 px neutral sparkline hidden in tight mode, links `Edit` and `Sensors`.
- `FanList` ("Cooling"): per fan name, rpm, duty %, a meter; neutral tag for the preset (`BIOS auto` …); footer `Curve driven by` with the driving temperatures; link `Cooling`.
- `DrivesCard` ("Drives"): per drive letter tile, model, status chip from `driveHealthView`, a life meter (amber only for worn drives via `Meter tone="warn"`), `NN% life left`, free space; footer `S.M.A.R.T. read HH:MM` and the total free space; link `Storage`.

**V1 · Sensors** (`SensorsView`, `sensors/*`; renders `sensors-1600x960`, `sensors-1280x800`) — list page: full-bleed white, no card.
- Filter bar 44 px (the existing toggles and buttons: `Hide unused`, `Show hidden`, `Expand all` / `Collapse all`, `Reset all` / `Reset selected`, the `Log to CSV` group with `SensorLogControls`), the tree-table, a 30 px status bar (counts and `since HH:MM (elapsed)` on the left, key hints on the right). The search box moves to the app toolbar: `usePageChrome({ subtitle: "<n> sensors from <m> devices", search: { value, onChange, placeholder: "Filter sensors" } })`.
- Tree-table (SPEC §8): constant **24 px** rows (update the virtualiser's row height), zebra, sticky 28 px header, columns `Sensor | Value | Min | Max | Avg | Limit | Last 60 s` with widths flex / 112 / 76 / 76 / 76 / 72 / 168 (tight: 68 / 60 / 120 for Min-Max-Avg / Limit / sparkline). Hardware rows 600 with a 15 px icon; group rows `Temperatures · °C` + count; the value cell is 600 with the unit once in tertiary; Min / Max / Avg are numbers only.
- **New `Limit` column:** the CPU limit from `useHealthAlerts().snapshot.cpuLimit` on the CPU package temperature row, the drive's `warningTempC` on drive temperature rows, the GPU hot-spot and memory-junction critical limits on those rows; blank everywhere else. No new data is fetched for it.
- Hot rows: a 14 px `StatusIcon` before the value, value and limit in the status text colour, sensor name 500; **no row tint**. Selection is neutral (`bg-selected`). Pinned rows show a 12 px pin glyph; rename is an inline `TextField`.
- Empty tree: `EmptyState` with the §4.8.1 texts.

**V1 · Drivers** (`DriversView`, `drivers/*`; renders `drivers-1600x960`, `drivers-1280x800`) — list page.
- The stat tiles (`StatTile`) leave the top; their numbers move into the 30 px status bar (`<n> drivers · <n> need attention · <n> unsigned · scanned <time>` on the left, `Nexum never installs drivers.` on the right). `StatTile.tsx` may be deleted.
- Filter bar: category filter as `Segmented` with counts, `Third-party only` toggle, `Export list` and `Back up drivers` small buttons. Search via `usePageChrome({ subtitle: "Installed drivers · read-only", search: { …, placeholder: "Filter drivers" } })`.
- Table (SPEC §7): 24 px rows, zebra, problems first, identical devices grouped (`× 16` in tertiary), age column tertiary, `Category` hidden below 1440 px, INF only in the detail panel. Status cell: chips for problems (`Code 28 · no driver` warn; codes 22 and 45 neutral `unknown`), unsigned warn; an OK row shows the quiet 13 px green check + `OK` in secondary text. Identifiers in JetBrains Mono 11.5. The detail panel is the docked 380 px inspector at every size.

**V2 · Storage** (`StorageView`, `storage/*`; renders `storage-1600x960`, `storage-1280x800`)
- Top: one summary card with four divided cells (Drive health, Capacity, Used, Live I/O).
- **`Physical drives` table** replaces the large per-drive cards (`PhysicalDiskCard` becomes the row; columns Drive, Life left with a meter, Temp, Health chip, chevron), so wear compares down one column; header meta `S.M.A.R.T. read HH:MM` + `Refresh`. `StorageGauge` is deleted (no caller).
- `Volumes` card: per volume name, file system, `on <model> (Life NN%)`, a meter, used / free. `ThroughputChart` ("Live I/O · <drive>"): two lines with end labels, range `Segmented`.
- **`SmartDrawer`**: a floating sheet in regular mode (top 12, right 12, 520 px, radius 16, over the full-window scrim, footer with `Copy as text`, `Windows reports: <status>` and the primary `Done`) and a **docked 380 px inspector** in tight mode (no scrim, the content area reflows, `Done` hidden, × closes); choose with `useTightMode()`. Content: life hero (warn tint, 34 px number, word + icon, meter, the forecast sentence from `fmtForecast`), the health log table (ID in mono | Attribute | Value | Threshold | status icon; 25 px zebra rows), the `WearHistory` chart (74 px, single ink series) with the rate. `DriveWearBanners` unchanged in behaviour.

**V2 · Cooling** (`CoolingView`, `fans/*`, `tuning/*`; renders `cooling-fans-1600x960`, `cooling-gpu-1600x960`)
- Tabs `Case fans` | `GPU tuning` as `Segmented size="lg"`, actions on the right. `PresetSelector` tiles use the neutral selected look (`shadow-selected`), never crimson. Fan cards (`FanCard`, `FanGauge`): big rpm number, 30 px sparkline, `Slider` (disabled with the hint `Set a preset to change` while BIOS-controlled), min / max underneath; neutral tags (`PWM`, `BIOS auto`). The thermal-override bar is an in-page warn `HealthBanner`-style banner. `CoolingTemps` as key-value rows.
- `GpuTuningPanel` (read-only, §4.10.1 unchanged): an info banner with the read-only sentence, a settings table of key-value rows with ranges in tertiary, `FanCurveChart` as a single ink line with point labels, a `Now` card, the probe card with one secondary button `Run read-only probe`. No control that changes a value.

**V2 · System** (`SystemView`, `system/*`; renders `system-cpu-1600x960`, `system-memory-1600x960`)
- Tabs as `Segmented size="lg"`; on the right `Read at HH:MM` in tertiary, `Copy as text` and the `Save report` menu (secondary). One hero card per tab, then key-value rows (`KeyValueRow`) in cards; the cache and timing tables as dense tables; source chips (`Live (memory controller)` / `SPD JEDEC (not the running timings)`) as neutral tags or info chips. The optional `Cores now` (CPU) and `Usage` (Memory) cards of the mocks may be built from existing telemetry or left out.

**V3 · Gaming** (`GamingView`, `gaming/*`; renders `gaming-1600x960`, `gaming-1280x800`, `gaming-off-1600x960`)
- Capture off: `EmptyState` with the §4.10.1 texts and the single primary button `Turn on frame capture` (the only primary on that screen), optional three "what you'll get" tiles.
- Capture on: hero in `text-hero` (`text-hero-tight` in tight mode) with the fps strip (P1, P0.1, average and maximum frame time, displayed fps, dropped); `FrametimeChart` as a single ink line with `FRAMETIME_MARKLINE` reference lines; `BusyBars` in graphite with the bound-by neutral tag; `PresentInfo` as key-value rows with status chips from `presentModeBadge`; `TargetPicker`, the window `Segmented`, `ExcludesEditor` (mono `TextField`, small buttons), `FrameSessionBar` (session line; the error state is a crit `HealthBanner` with the secondary `Try again`). `Turn off` is a plain or secondary button. The mock's `While playing` card (CPU / GPU averages over the frame window) may be computed in the view from `useTelemetry().history` or left out.

**V3 · Clean caches** (`CleanerView`, `cleaner/*`; renders `cleaner-1600x960`, `cleaner-confirm-1600x960`)
- Two columns: the category list (`CategoryList` with `Checkbox` rows, sizes right-aligned, neutral tags `Admin` / `Optional`, the `Show files` disclosure with `CategoryDetails`, the Recycle Bin age `Segmented`) and the summary column (total, what is never touched, the last cleanup from `CleanupSummary`).
- The page button **`Clean <size>…` is secondary** (it opens the confirmation). The dialog's `Clean <size>` is the only primary. `OneClickPurgeModal` uses `Modal variant="alert"` with the app icon, the summary well, the reassurance line, `Cancel` (focused first) and the primary. `PurgeProgressPanel` and `LedProgress` become a 4 px graphite `ProgressBar` with the counts; `ScanningState` uses the same bar.

---

## 5. Health status derivation (frontend + Rust alerts) [CHANGED 1.1]

Implemented once in `lib/status.ts` `deriveHealth` (C). Consumed by the header pill (C), the Health alerts card and the Dashboard banners (E).

### 5.0 One source of truth per condition (1.1) [CHANGED 1.1]

| Condition id | v1.0 rule # | Evaluated by (1.1) | How `deriveHealth` gets it |
|---|---|---|---|
| `fan-failsafe` | 1 | frontend | from `FanFailsafeState` (unchanged) |
| `agent-offline` | 2 | frontend | **[CHANGED 1.2]** exists only while `agent.phase === "failed"` (§5.2); the id is internal and unchanged |
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
- **Checking state [NEW 1.1] [CHANGED 1.2]:** when no crit / warn / info condition exists and either `!alerts.ready` or `sensorsPending` (§5.1: sensor data is missing or stale but the sensor service has not failed — app start, an automatic restart, the moment after `Try again`), then `level = "checking"`, `label = "Checking"`, `summary = null`, pill tone **`checking`** (neutral, dashed ring; was `unknown`). The pill never shows `Optimal` before Rust has evaluated once and never while sensor data is missing.
- Dashboard banners (§5.4): unchanged rule (drive conditions only), now fed by the Rust drive alerts; Dismiss calls `api.dismissAlert(dismissKey)` (same effect as the v1.0 `settings.update`). `dismissKey` formats are unchanged (`drive:<id>:<health.state>`), so v1.0 dismissals stay valid.
- Components that show a free-space colour (`VolumeList`, E) take warn/crit from `Settings.alerts.freeSpacePct` via `spaceThresholds(settings)` in `lib/status.ts` (C): `{ warnPct: freeSpacePct, critPct: max(1, floor(freeSpacePct / 2)) }`.

The v1.0 text below (§5.1–§5.4) stays authoritative for the frontend-owned rules, texts, level/summary logic and banners; for rules 4–8 it now documents what Rust reproduces (§2.10.3 is authoritative for them).

### 5.1 Inputs and helpers

- `offline` = `!agent || !agent.running || latest == null || now − agent.lastPacketTs > max(5000, 3 × pollIntervalMs)`.
- **[NEW 1.2]** `sensorsFailed` = `agent?.phase === "failed"`. `sensorsPending` = `offline && !sensorsFailed`. Neither state produces a message by itself: `sensorsPending` only makes values render `—` and the pill read `Checking`; `sensorsFailed` produces rule 2 and the one banner (§4.8.1).
- `sustained(series, threshold)` = the samples from `history` with `ts ≥ now − 10000` number ≥ 3, are all non-null, and their **minimum** ≥ `threshold`.
- `T` thresholds: `HEALTH_THRESHOLDS` in `types.ts`.

### 5.2 Rules (evaluated in this order; the order is also the display order within a severity)

| # | id | severity | Condition | short (n=1 group text) | title / detail | action |
|---|---|---|---|---|---|---|
| 1 | `fan-failsafe` | crit (warn if `kind=="previousBoot"`) | `failsafe.active` | `Fan fail-safe` | `Fan control interrupted` / `failsafe.message` | – |
| 2 | `agent-offline` | warn | **[CHANGED 1.2]** `sensorsFailed` (was `offline`) | `Sensors unavailable` | `Nexum can't read sensors right now.` / `SENSORS_DOWN_REASON[agent.failReason]`, or `Sensor values are not updating.` when `failReason` is null | `{label:"Try again", command:"retrySensors"}` → `api.restartAgent()` |
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
- `summary`: take the conditions of the top severity; group by `group` (`drive:<health.label>`, `cpu-temp`, `gpu-temp`, `gpu-mem-temp` **[NEW 1.1]**, `drive-temp`, `space`, otherwise the id). If exactly one group: its short text, with `1 drive` replaced by `<n> drives` when the group has n > 1 members (`2 drives worn`, `2 drives: check sectors`; non-drive groups keep their short text); otherwise `<total> alerts`. `optimal` → null. **[CHANGED 1.2]** Exception: when the top severity is info and one of those conditions is `limited-mode`, the summary names the cause instead: `needs administrator` when its action is `restartAsAdmin`, else `needs PawnIO driver` (`LIMITED_SUMMARY`). Drives whose health is unknown for that reason never turn the pill into `<n> alerts`.
- **[NEW 1.2] Rows (`healthRows(conditions)` in `lib/status.ts`):** the Health card and the pill's list show one row per condition, except `drive-unknown:*` conditions that share the same label and detail (typically every drive while Nexum runs without administrator rights): those fold into one row titled `<n> drives — <label>` whose hover lists every drive. The card's `<n> item(s)` and the list's `<n> active condition(s)` count rows. `conditions` itself is unchanged.
- `HealthCondition.action` is a `HealthAction`: `{label, nav}` → `requestNavigate(nav)`; `{label, command:"restartAsAdmin"}` → `api.restartAsAdmin()`; `{label, command:"getPawnIo"}` → `api.openExternal("https://pawnio.eu/")`; **[NEW 1.2]** `{label, command:"retrySensors"}` → `api.restartAgent()`.
- Pill text = `label` + (summary ? ` · ` + summary : ""), e.g. `Attention · 1 drive worn`. Pill tone: critical→crit, attention→warn, partial→unknown, optimal→ok, **[CHANGED 1.2]** checking→`checking`. Hover lists active conditions' titles, then `rules`; a click opens the popover (§4.6.1).
- **Optimal** therefore requires: sensor data arriving, no limited reasons, every drive `good`, no temperature or space condition, no fan safety condition.

### 5.4 Health alerts card and banners (E)

- Dashboard **Health alerts** card replaces the Thermal & Load Index card: lists `conditions` (crit, warn, then info) with tone icon, title, detail and action button; when empty, `No active alerts` followed by the `rules` list.
- Dashboard **banners**: one `HealthBanner` per drive condition (rule 4) with severity warn/crit whose `dismissKey` is not in `settings.dismissedAlerts`; Dismiss appends the key. A worse state produces a new key, so the banner returns. Dismissal never hides the pill or the card.
- **[CHANGED 1.2]** App-level banners (S, `components/layout/AppBanners.tsx`, full-bleed under the toolbar, §4.6.1), in this order: fan fail-safe (`useFanFailsafe`, always first); the **sensors banner** while `sensorsFailed` (title, reason line and `Try again` per §4.8.1 — the only banner that ever shows this condition: the Dashboard renders no `HealthBanner` for `agent-offline`, the Health card lists it as a plain row); and limited mode, hidden while the sensors banner shows (rule 9 data; buttons `Restart as administrator` → `api.restartAsAdmin()`, `Get PawnIO` → `api.openExternal("https://pawnio.eu/")`; not shown when `sensorDriverChoice === "none"` and the only reasons are PawnIO ones — the pill still says Partial sensors).
- First-run PawnIO screen (C, MF-3): shown once when `sensorDriverChoice === "undecided"` and the agent reports `pawnIoMissing` or `pawnIoOutdated`. Explains that PawnIO is a vendor-signed kernel driver installed from the official site, needs ≥ 2.1.0, and that Nexum never installs or uninstalls it. Buttons: `Get PawnIO` (opens pawnio.eu, sets `"pawnio"`) and `Continue without kernel driver` (sets `"none"`).

---

## 6. Breaking-change checklists

### 6.0 1.2.0 [NEW 1.2]

| Change | Layers |
|---|---|
| `AgentStatus` gains required `phase` and `failReason`; `message` is no longer rendered; the restart policy is counter-based (§2.3.1) | R, S (mock, `lib/status.ts`), every view that showed a connection state |
| `Settings` gains required `updateCheck`, `lastUpdateCheckTs`, `updateChannel` (Rust `#[serde(default)]` keeps old files loading; `save_settings` keeps the stored `lastUpdateCheckTs`) | R, S |
| New commands `get_update_state`, `check_for_update`, `install_update`; new event `update-state`; new crate `tauri-plugin-updater`; `plugins.updater` in `tauri.conf.json` | R, S, F |
| The "no network code" rule becomes "no network code outside `src-tauri/src/updater.rs`" (§0, §7 item 12); README / SECURITY promises change with it | R, F |
| `HealthAction.command` gains `"retrySensors"`; rule 2 (`agent-offline`) exists only while `phase == "failed"` and has new texts; level `checking` also covers starting / restarting; pill tone `checking` (`StatusPillTone`) | S, P, V1 |
| Every user-visible "agent" string is replaced (§4.8.1); `UNAVAILABLE_TEXT.agentOffline` = `Not available right now`; the `agentLost` fail-safe message and the tray tooltip head change | P, S, V1, V2, V3, R |
| `TopBar`, `HeaderStrip`, `StatusFooter` deleted; `Sidebar`, `Toolbar`, `PageChrome`, `AppBanners` (in `layout/`) added; views lose their outer padding and get their title from the shell (§4.6.1) | S, V1, V2, V3 |
| Theme: dark tokens replaced by the light set; legacy colour names are aliases with new meanings (`teal` and `gold` = graphite); `.num` is Inter, not monospace; `.label-caps` no longer uppercases; focus ring is an outline | everyone in the frontend |
| `Button` default variant `ghost` → `secondary`; `gold` no longer highlights (→ `secondary`); `StatusPill` default size is the 20 px chip; `STATUS_ICON.unknown` is `Contrast`; `Sparkline.fill` defaults to false; `SegmentedBar` / `DotMatrix` / `GlassCard.accent` / `GlassCard.icon` decoration props are ignored | P, V1, V2, V3 |
| `STATUS_HEX` now holds the icon colours of the light theme; `SERIES_HEX.gpu` is teal (was gold), `vram` graphite + dashed; `TONE_CLASS` is removed at integration | P, V1, V2, V3 |
| Window: `theme: "Light"`, `backgroundColor: "#F5F5F7"`; new bundle icons; version 1.2.0 in `tauri.conf.json`, `Cargo.toml`, `package.json` | R, F |

Additive (not breaking): `VIEW_TITLES`, `NAV_GROUPS`, `PAGE_KIND`, `TIGHT_MEDIA_QUERY`, `useTightMode`, the new primitives and optional props of §4.7, `Ctrl+K`.

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
3. **MF-11 no network:** fail on any of `reqwest`, `ureq`, `hyper`, `HttpClient`, `WebClient`, `HttpWebRequest`, `TcpClient`, `TcpListener`, `HttpListener`, `WebSocket`, `XMLHttpRequest`, `fetch(` in `src-tauri/src/**`, `nexum-agent/**/*.cs`, `src-frontend/**` (excluding `node_modules`), unless the file:line is listed in `.github/network-allowlist.txt` (starts empty). **[CHANGED 1.2]** The allow-list now holds exactly the updater module (item 12).
4. **Copy rules:** a check greps `src-frontend/**/*.tsx` string literals and JSX text for the §4.8 banned words and fails unless allow-listed in `.github/copy-allowlist.txt`.
5. **MF-7 soak test:** documented procedure (24 h, agent working set growth < 10 MB) in `docs/`; not a CI job.
6. **Docs:** `SECURITY.md` (reporting address placeholder, supported versions, privileged surface = elevated agent + stdio protocol, the "never" list: registry cleaning, driver downloads or installs, process injection, telemetry, bundled offers, auto-updaters that run downloaded installers, localhost web APIs); the same "never" list and the §4.6 keymap in `README.md` (**[CHANGED 1.2]** the list and the network wording are replaced by item 16); `docs/DESIGN-SPEC.md` §6.3 says PawnIO, not WinRing0; a "Code signing policy" section per ROADMAP MF-8 item 6.

7. **[NEW 1.1] PresentMon at build time:** a step before every job that compiles `src-tauri` downloads the pinned `PresentMon-2.6.0-x64.exe` (v2.6.0 release asset) into `build/presentmon/`, fails unless SHA-256 = `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` and `Get-AuthenticodeSignature` = `Valid` with a subject starting `CN=Intel Corporation`. The URL and hash live in one place (`.github/presentmon.json`, `{ "version":"2.6.0", "url":…, "sha256":… }`); updating it is a deliberate PR (ROADMAP §4.3 gate 4). The release-asset Authenticode check (item 2) treats this file as third-party-signed (Intel) and must find it `Valid`; the signing step must skip it. `check-network.mjs` does not scan `.github/**` (build-time download is allowed; runtime code is not).
8. **[NEW 1.1] Licences:** `licenses/PresentMon/LICENSE.txt` (MIT, copied from the v2.6.0 tag), `licenses/ADL/LICENSE.txt` (the MIT notice text from `include/adl_sdk.h`, ROADMAP V2), ZenStates-Core attribution (GPL-3.0, register map in `nexum-agent/Spec/MemoryTimings.cs`), and a root-level `licenses/THIRD_PARTY.txt` listing every bundled third-party component, its licence and its upstream URL; `licenses/README.md` updated.
9. **[NEW 1.1] Read-only tuning check:** fail if any file under `nexum-agent/Tuning/**` (or anywhere in `nexum-agent/**/*.cs`) contains an ADL entry point matching `/ADL2?_\w*_Set(?![a-z])\w*/`, or if any file under `nexum-agent/Tuning/**` other than `AdlNative.cs` contains `DllImport`/`LibraryImport`, or if any file under `nexum-agent/Tuning/**` contains `GetProcAddress`, `NativeLibrary.`, `delegate* unmanaged` or `Marshal.GetDelegateForFunctionPointer`. Script `.github/scripts/check-tuning-readonly.mjs`, allow-list none.
10. **[NEW 1.1] Agent self-test:** CI runs `nexum-agent --selftest` (A1 adds frame-parser and statistics tests: header resolution against `Frames/HEADER-2.6.0.txt`, percentile/boundBy vectors from §1.6.5, NA handling, 1000-cap batching).
11. **[NEW 1.1] Docs:** README gains a `Gaming (frame capture)` section (opt-in, Intel PresentMon over ETW, no injection, the §4.3 anti-cheat matrix as a table with every title `not tested` until the owner tests it, the EA Javelin "start Nexum first" note), the 1.1 keymap (F8, Ctrl+8), CSV logging location, alert defaults and the Tjmax table with its re-check date; `SECURITY.md` privileged-surface list gains "spawns the Intel-signed PresentMon exe from the install folder after a hash + signature check" and "reads AMD ADL tuning data read-only"; `docs/ROADMAP.md` is not edited except to tick the v1.1 rows when done.

12. **[CHANGED 1.2] Network check (replaces the scope of item 3):** `check-network.mjs` keeps failing on every pattern of item 3 in `src-tauri/src/**`, `nexum-agent/**/*.cs` and `src-frontend/**`, and adds `tauri_plugin_updater` and `updater_builder` to the Rust patterns. The allow-list changes from "file:line" entries to exactly one whole-file entry: **`src-tauri/src/updater.rs`** (plus the single plugin registration line in `src-tauri/src/lib.rs`, listed by line). Nothing else may be allow-listed; the frontend and the sidecar stay at zero. The script also fails if `src-tauri/capabilities/**` contains a permission starting with `updater:` or if `package.json` lists `@tauri-apps/plugin-updater`. **[1.2 security review]** It also fails when the updater's safety switches are weakened: `plugins.updater` in `tauri.conf.json` lacks `requireSignedVersion: true`, sets a `dangerous…` switch or `allowDowngrades` to anything but `false`, or holds any key other than `pubkey`, `endpoints`, `requireSignedVersion` and those switches; the plugin registration line is anything but `.plugin(tauri_plugin_updater::Builder::new().build())`; or the code of `updater.rs` (outside tests and comments) uses `download_and_install`, `.install(`, `.pubkey(`, `danger_accept_invalid_certs` / `_hostnames`, a `dangerous_…` name or `allow_downgrades`.
13. **[CHANGED 1.2] Copy check:** `check-copy.mjs` adds `agent` (`/\bagents?\b/i`, which also covers `agent's`) to the banned words and scans string literals and JSX text in `src-frontend/**/*.ts` as well as `*.tsx` (the texts live in `lib/`, `types.ts` and `*Copy.ts` / `*Text.ts` files). Identifier-like literals without a space stay exempt (`"agent-status"`, `"agentOffline"`). A second pass covers Rust: any string literal in `src-tauri/src/**/*.rs` outside `#[cfg(test)]` modules and outside `eprintln!` / `println!` / `format_args!` log calls that contains the whole word fails. The allow-list stays empty for `agent`; `nexum-agent.exe` in `FIXED_FRAME_EXCLUDES` passes because it has no space.
14. **[NEW 1.2] Updater artifacts and manifests (§2.15.2).** (a) Builds without the secret `TAURI_SIGNING_PRIVATE_KEY` (pull requests, forks, branch pushes) build exactly as before: no `createUpdaterArtifacts`, no `NEXUM_UPDATE_CHANNEL`. (b) For a tag build with the secret present, the build job sets `NEXUM_UPDATE_CHANNEL` (`preview` when the tag contains `-preview`, else `stable`), overrides the app version with the tag's version, and passes `bundle.createUpdaterArtifacts: true` through `tauri build --config`; the secret is passed only as the environment variable of that one step and is never echoed. (c) **preview job:** publishes the installer, its `.sig` (from the build) and, after the release is public, uploads `preview.json` to the `updates` release (`--clobber`). (d) **sign job:** after SignPath returns the Authenticode-signed installer, runs `tauri signer sign` on it under the name `Nexum_<version>_x64-setup.exe`, publishes installer + new `.sig` with the draft; `stable.json` and `preview.json` are uploaded only when that release is published (a `release: published` workflow, or a manual `workflow_dispatch`). (e) Before uploading any manifest CI checks: the JSON parses; `version` equals the tag without `v`; both platform keys exist with the same `url` and `signature`; the `url` starts with the §2.15.2 prefix and answers 200; the decoded signature's trusted comment contains `file:Nexum_<version>_x64-setup.exe`. (f) The `updates` release is created once (pre-release, `make_latest: false`) if it does not exist. (g) **Rehearsal.** `build.yml` started by hand (`workflow_dispatch`) with the input `rehearse_tag` plans and builds exactly as (b) does for that tag, runs the signature self-check, and builds the manifest of (e) from the local files and checks it (all of (e) except "answers 200"). It publishes nothing: no release, no manifest; the sign, preview and manifest jobs do not run. It fails without the secret. **[1.2 security review]** A rehearsal signs its installer with the real update key, and that installer is not a release. So `rehearse_tag` must be **`vX.Y.Z-preview.0`** and nothing else, and **no pushed tag may use preview number 0**: the release plan refuses both, and `update-manifest.yml` refuses to describe a `-preview.0` release. A rehearsal installer therefore never carries the version of a release, and it is older than every real preview of its version line. (h) **[1.2 security review] Pinned actions.** Third-party actions in `build.yml` (`dtolnay/rust-toolchain`, `Swatinem/rust-cache`, `signpath/github-action-submit-signing-request`, `softprops/action-gh-release`) are referenced by commit SHA with the version in a comment, never by a tag or branch: the build job later holds the update key and the release jobs can write releases. `check-actions-pinned.mjs` (policy job) fails on any `uses:` that is not GitHub's own `actions/*`, a workflow of this repository, or `owner/action@<40-character commit>`.
15. **[NEW 1.2] Design hygiene checks** (script `check-design.mjs`, report-only until the round is integrated, then enforcing): no hex colour literal in `src-frontend/**/*.{ts,tsx}` outside `components/ui/tones.ts`, `components/ui/echartsTheme.ts` and `lib/mock.ts`; none of the retired class patterns of §4.9 ("Done means"); `variant="primary"` occurrences listed per file so a reviewer can confirm one per screen.
16. **[NEW 1.2] Docs (truthful after 1.2):** `README.md` — the new lockup through `<picture>` for GitHub's light and dark themes, the tagline without "no network code", the privacy section and "What Nexum will never do" rewritten to: no telemetry, no analytics, no accounts; **the only network request Nexum makes is the update check to GitHub (and the update download after you click Install); it is off until you agree, it never installs without a click, and every download is signature-verified before it runs**; a short "Updates" section (channels, where manifests live, how to turn checks off, how to verify a download by hand); the screenshot list for the new UI. `SECURITY.md` — the privileged-surface table gains the updater row (what it contacts, what it verifies, where it stages, what it executes, the known limits of §2.15.5), the "never" list is aligned with the README ("auto-updaters that run downloaded installers" becomes "installing anything without your click, or anything that is not signed with Nexum's update key"), the CI paragraph describes the one-file allow-list. `docs/ROADMAP.md` — the "Not doing: auto-updater" row gets an owner-decision note (in-app updates added in 1.2 by the owner's decision: opt-in check, click to install, signature-verified), nothing else is edited. `docs/SIGNING.md` — the updater key (what it is, that it is separate from Authenticode, the secret's name, how to rotate it) and the after-SignPath signing order. `docs/design/` — the design package files listed in §4.1.
17. **[NEW 1.2] Versions and assets:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock` say 1.2.0; `src-tauri/icons/*` are the design package's files (same names); root `app-icon.svg` is the new mark; `licenses/THIRD_PARTY.txt` lists `tauri-plugin-updater` (MIT / Apache-2.0) and the crates it adds to the shipped binary (`minisign-verify`, `reqwest`, `rustls` …) as `cargo` resolves them.
18. **[NEW 1.2] Release gate for the updater (manual, on the reference rig or a VM, recorded in the release notes):** install `1.2.0-preview.N`, publish `N+1`, confirm: no request before the first-run answer; `Check now` finds it; the dialog shows version and notes; `Install update` downloads, verifies, closes Nexum, installs and (if Windows allows) reopens it; a tampered installer is refused (`badSignature`); a manifest pointing at an older signed installer is refused (`notNewer`).

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
- **[NEW 1.2]** The updater could not be exercised locally (Smart App Control blocks `cargo` and unsigned executables): the plugin's manifest field names, the `<os>-<arch>-<installer>` lookup, `Update::download` returning verified bytes, the trusted-comment format of `tauri signer sign` and the NSIS arguments `/P /R /UPDATE` are taken from the plugin's documented behaviour and must be confirmed by R against the crate version that `Cargo.lock` resolves, and by the §7 item 18 gate.
- **[NEW 1.2]** A SemVer pre-release app version (`1.2.0-preview.1`) in the NSIS bundle and the Windows version resource: the first tag build shows whether the bundler accepts it. If it does not, the fallback is numeric build metadata, and §2.15.2 "Versions" must be revised before any preview is published.
- **[NEW 1.2]** After an update the NSIS installer may fail to reopen Nexum, because Nexum requires elevation and the installer relaunches as the signed-in user. The dialog text already tells the user what to do; R may improve it later.
- **[NEW 1.2]** Unsigned preview installers are blocked on PCs with Smart App Control on, so the preview channel cannot complete an install there until SignPath signing is live.
- **[NEW 1.2]** `tauri signer sign` with an empty key password in a non-interactive job: F sets the password variable to an empty string explicitly and confirms the step does not wait for input.
- **[NEW 1.2]** OS error codes for "blocked by Windows security" (4551, 1260, 225, 226) are from the Win32 error list, not from a test on a Smart App Control machine.
- **[NEW 1.2]** The bundled Inter subset has no `cv05` (§4.9); the design's "l with a tail" is therefore not rendered.
- **[NEW 1.2]** Trademark: the N-with-node-terminals mark has close prior art (`docs/design/RATIONALE.md`); a clearance opinion is wanted before the first stable release.
