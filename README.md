<p align="center">
  <img src="app-icon.svg" width="96" alt="Nexum emblem" />
</p>

<h1 align="center">Nexum</h1>

<p align="center">
  <b>BIOS-style PC telemetry, sensors, frame-rate capture, driver inventory and safe cache cleanup for Windows 10/11.</b><br/>
  Lightweight · native · open source (GPL-3.0) · no telemetry, no network code
</p>

<p align="center">
  <a href="../../actions/workflows/build.yml"><img src="../../actions/workflows/build.yml/badge.svg" alt="Build status" /></a>
</p>

![Nexum dashboard](docs/screenshots/dashboard.png)

> Screenshots are rendered with the built-in **preview data** (no hardware access in the browser preview), using a
> realistic three-fan desktop with one worn NVMe drive. More views:
> [Sensors](docs/screenshots/sensors.png) · [System](docs/screenshots/system.png) ·
> [System → Memory timings](docs/screenshots/system-memory.png) · [Storage](docs/screenshots/storage.png) · [Storage → Wear forecast](docs/screenshots/storage-forecast.png) ·
> [Cooling](docs/screenshots/cooling.png) · [Cooling → GPU tuning (read-only)](docs/screenshots/cooling-tuning.png) ·
> [Gaming](docs/screenshots/gaming.png) · [Drivers](docs/screenshots/drivers.png) · [Cleaner](docs/screenshots/cleaner.png) ·
> [Clean caches dialog](docs/screenshots/purge.png) · [1280 × 800](docs/screenshots/dashboard-1280.png) ·
> [Without administrator rights](docs/screenshots/dashboard-limited.png)

## What it does

| View | Key | Highlights |
| --- | --- | --- |
| **Dashboard** | `F1` | KPI strip (a 6th **FPS** card appears only while a game is being captured), a live load chart (CPU / GPU / RAM as separate lines on a 0–100% axis), **Health alerts** (every active condition, with the rule that raised it), your **pinned sensors**, and a short system summary. The header status pill (Checking / Optimal / Attention / Critical / Partial sensors) follows documented rules; hover it to see them. See [alerts](#health-alerts-notifications-and-the-tray). |
| **Sensors** | `F2` | The full sensor tree (motherboard Super I/O, CPU, memory, GPU, drives) with **Value / Min / Max / Avg** for the session and a 60 s sparkline. Reset all or selected rows, search, hide unused sensors, rename any sensor (`F2` or double-click), hide it, or pin it to the Dashboard. Your names follow the sensor everywhere in the app. **Log to CSV** every 1, 2, 5 or 10 s ([sensor logging](#sensor-logging-csv)). |
| **System** | `F3` | A CPU-Z-style summary: CPU (name, codename, socket, family/model/stepping, caches), mainboard, BIOS and Super I/O chip, memory type, size, channels, **live DDR4 timings**, MEMCLK / FCLK / UCLK, per-DIMM SPD details, graphics with the **PCIe link** (current vs maximum), NVMe/SATA links, and OS & security status (Secure Boot, TPM). **Save report** as `.txt` or `.html`; "Copy as text" and reports mask serial numbers. See [memory timings](#system-report-and-memory-timings). |
| **Storage** | `F4` | Physical drives (NVMe / SATA SSD / HDD) with one consistent **drive-health model** (Good / Worn / Replace soon / Failing / Health unknown), a S.M.A.R.T. details drawer (spare vs threshold, % used, media errors, unsafe shutdowns, temperature history, **wear history and forecast**), live read/write throughput, and which volumes sit on which drive. See [drive wear forecast](#drive-wear-forecast). |
| **Cooling** | `F6` | **Case fans:** every motherboard fan header and GPU fan with live RPM and session min/max, fan presets (Auto (BIOS) / Silent / Balanced / Turbo) and per-fan duty sliders. Requires Administrator, PawnIO and a supported Super I/O chip. See [fan-control safety](#fan-control-safety). **GPU tuning (read-only):** the AMD Radeon tuning ranges and current values; Nexum does not change them. See [GPU tuning](#gpu-tuning-read-only). |
| **Drivers** | `F7` | A full driver inventory (provider, version, date, signature, INF) across every device class, with JSON/CSV export and driver backup via `pnputil`. Driver age is shown as neutral information; only devices Windows reports as having a problem, and unsigned drivers, are flagged. **Nexum never installs drivers.** |
| **Gaming** | `F8` | **Opt-in, off by default.** Rendered FPS, P1 / P0.1 lows, a frame-time chart with 60 / 120 / 144 Hz reference lines, CPU busy vs GPU busy (which one limits the frame rate), present mode, V-Sync and tearing, a target picker and an exclude list. Uses Intel's signed PresentMon; nothing is injected into games. See [Gaming (frame capture)](#gaming-frame-capture). |
| **Clean caches** | `F9` | A dry-run scan first, then removes reclaimable caches: temporary files, the Windows Update download cache, error reports and old logs are on by default. Crash dumps, `MEMORY.DMP`, shader caches, the Recycle Bin and browser/Discord caches are **off** by default and must be switched on. **Show files** lists the 50 largest items of each category exactly as a cleanup would remove them. The Recycle Bin can be limited to items deleted more than 1, 14, 30 (default) or 60 days ago. Every cleanup writes an audit log. See [cleaner safety](#safety-guarantees-of-the-cleaner). |

The status bar shows Nexum's own CPU and memory use (the app, the hardware agent and its WebView2 processes), so the
low-overhead claim can be checked.

### Keyboard

| Key | Action |
| --- | --- |
| `F1` | Dashboard |
| `F2` | Sensors (inside Sensors: rename the selected row) |
| `F3` | System |
| `F4` | Storage |
| `F5` | Rescan |
| `F6` | Cooling |
| `F7` | Drivers |
| `F8` | Gaming |
| `F9` | Clean caches |
| `Ctrl+1` … `Ctrl+8` | Dashboard, Sensors, System, Storage, Cooling, Drivers, Gaming, Clean caches |
| `Esc` | Close dialogs |

Changed in 1.1: `Ctrl+7` now opens Gaming and Clean caches moved to `Ctrl+8`. `F10` is never bound because Windows
uses it for menu activation.

## Requirements

* Windows 10 or 11, x64. Nexum runs as Administrator (needed for fan control, S.M.A.R.T., motherboard sensors and the
  Windows Update / error-report cleanup).
* Microsoft Edge WebView2 Runtime (included with Windows 11; the installer downloads it from Microsoft if missing).
* **Optional: [PawnIO](https://pawnio.eu/) ≥ 2.1.0 for full sensor access** (CPU temperature, power and clock,
  motherboard fan headers and voltages, fan control, live DDR4 memory timings). PawnIO is a separate, vendor-signed kernel driver. Nexum asks
  before you install it, never bundles or installs it itself, and never removes it (other apps may use it). Without it,
  Nexum runs in a clearly labelled "Partial sensors" mode: values it cannot read show as "—" with the reason, never as 0.

Nexum never uses the WinRing0 driver (CVE-2020-14979), and CI fails the build if WinRing0, InpOut or the
OpenHardwareMonitor driver ever appears in the output.

## Gaming (frame capture)

Frame capture is **opt-in and off by default** (Gaming view → *Turn on frame capture*, or Settings).

* **How it works.** Nexum runs Intel's [PresentMon](https://github.com/GameTechDev/PresentMon) 2.6.0 console
  application, **unmodified and signed by Intel**, which reads the present events Windows already publishes through ETW
  (Event Tracing for Windows). Nothing is injected into games, no hooks are installed, and Nexum does not open, read,
  or send messages to game processes. The same approach is used by HWiNFO and by press frame-time testing.
* **Checked before every start.** The hardware agent starts PresentMon only from Nexum's install folder, after checking
  its SHA-256 against the pinned value and its Intel signature (offline). If either check fails, frame capture stays off
  and the Gaming view says why. PresentMon runs inside a Windows Job Object, so it always ends with Nexum.
* **One fixed session.** The ETW session is always called `NexumFrames`. It starts **when Nexum starts** (with frame
  capture on), not when a game starts, and a session left behind by a crash is cleaned up at the next start.
* **Start Nexum before EA Javelin games.** EA Javelin anti-cheat (for example Battlefield 6) blocks new ETW sessions
  while the game runs, so frame capture must already be running when you launch such a game. Changing the exclude list
  never restarts the session.
* **What the numbers mean.** The headline is *Rendered FPS (game)*: frames the game rendered. Frames added by AMD driver
  frame generation (AFMF) may not be counted. *P1* = 1000 ÷ the 99th-percentile frame time in the chosen window
  (10–120 s); *P0.1* uses the 99.9th percentile. They are percentile lows, not an "average of the slowest 1%", and need
  at least 100 / 1000 frames. GPU timing is less accurate with Hardware-Accelerated GPU Scheduling on (about 0.5 ms
  high).
* **Needs Administrator rights** (Nexum already runs elevated).

### Anti-cheat compatibility

Nexum is built for the strictest case, but no anti-cheat vendor has published a statement about PresentMon-based tools,
and none of the titles below has been tested with Nexum yet. Results will be recorded here and in the release notes.

| Game | Anti-cheat | Result |
| --- | --- | --- |
| Valorant | Riot Vanguard | not tested yet |
| Fortnite / Apex Legends | Easy Anti-Cheat | not tested yet |
| PUBG / Rainbow Six Siege | BattlEye | not tested yet |
| Battlefield 6 | EA Javelin (start Nexum first) | not tested yet |
| Counter-Strike 2 | VAC | not tested yet |
| FACEIT client | FACEIT AC (needs PawnIO ≥ 2.1.0, not WinRing0) | not tested yet |

If a game refuses to start or warns about Nexum, turn frame capture off and please
[open an issue](../../issues) with the game, its anti-cheat and the message.

## Sensor logging (CSV)

Sensors view → **Log to CSV** (or the tray menu → *Start sensor log*). Nexum writes one row every 1, 2, 5 or 10 s to
`Documents\Nexum\Logs\nexum-YYYYMMDD-HHMMSS.csv`:

* header `Date,Time,<hardware> | <sensor> [<unit>],…`; by default every visible sensor, or only the rows you selected;
* UTF-8 with BOM (so spreadsheet apps show `°C`), `.` as the decimal separator, empty cells for values that cannot be
  read (never 0), temperatures always in °C;
* flushed every 10 rows; a new file starts at 100 MB; logging keeps running while Nexum is in the tray and stops when
  Nexum exits.

## Health alerts, notifications and the tray

Alerts are evaluated by Nexum's core, so they also work while the window is hidden. Temperature alerts fire only on
**sustained** readings (every sample of the last 60 s at or above the threshold, configurable 10–600 s), never on
spikes, and clear 3 °C below the threshold.

| Condition | Attention | Critical |
| --- | --- | --- |
| CPU temperature | 5 °C below the CPU's limit | at the limit (per-model table below; 90 °C if the model is unknown) |
| GPU hot spot | 100 °C | 110 °C (edge sensor only: 85 / 95 °C) |
| GPU memory junction | 95 °C | 105 °C |
| Drive temperature | the drive's warning temperature (70 °C if not reported) | its critical temperature (80 °C if not reported) |
| Drive health | ≤ 50% life left, sector or Windows warnings | ≤ 10% life left, critical warning, spare below threshold, read-only |
| Free space (fixed drives) | below 10% | below 5% |

All thresholds except drive health can be changed in Settings → Alerts. **Desktop notifications are opt-in** (off by
default): Nexum notifies when an alert starts or becomes critical while its window is hidden or in the background, at
most once per alert every 30 minutes, and groups bursts. The **tray tooltip** shows the alert count and up to four of
your pinned sensors (or CPU and GPU temperature).

**CPU limits** come from AMD's published "Max. Operating Temperature (Tjmax)", not a global 85 °C:

| CPU | Limit | | CPU | Limit |
| --- | --- | --- | --- | --- |
| Ryzen 5 5600X | 95 °C | | Ryzen 7 5800X3D | 90 °C |
| Ryzen 7 5800X | 90 °C | | Ryzen 7 5700X3D | 90 °C |
| Ryzen 9 5900X | 90 °C | | Ryzen 7 7800X3D | 89 °C |
| Ryzen 9 5950X | 90 °C | | Ryzen 9 7950X | 95 °C |
| Ryzen 7 9800X3D | 95 °C | | *any other CPU* | 90 °C (conservative default; Nexum says so) |

Every row was re-checked on amd.com on **2026-11-27** ([record](docs/TJMAX-CHECK.md)). The fan thermal override is
separate and stays at a fixed 85 °C.

## Drive wear forecast

Once a day Nexum adds one line per drive to `%LOCALAPPDATA%\Nexum\history\drives.jsonl` (health %, data written,
power-on hours; about 70 KB per drive per year, kept on your PC only). The S.M.A.R.T. drawer then shows a wear chart and,
after at least 7 snapshots over 14 days, the **TB written per month** and the **months until 10% life remains** (a
straight-line fit over the last year; "not enough data yet" or "no measurable wear" otherwise).

## System report and memory timings

* **Live DDR4 timings** (CL-tRCD-tRP-tRAS, tRC, tRFC, tFAW and more) are read from the AMD memory controller on AM4
  Ryzen (Zen, Zen 2, Zen 3) with DDR4. This needs **Administrator rights and PawnIO**; the reads are read-only and use the same
  system-wide lock as LibreHardwareMonitor, so they cannot collide with other monitoring tools. The register map follows
  [ZenStates-Core](https://github.com/irusanov/ZenStates-Core) (GPL-3.0).
* Without that, Nexum shows the module's **SPD JEDEC** timings, clearly labelled "SPD JEDEC (not the running timings)":
  they are the module's base specification, not your XMP or BIOS settings.
* **Save report** writes a self-contained `.txt` or `.html` (no scripts, no external links) to
  `Documents\Nexum\Reports\`. Serial numbers are masked.

## GPU tuning (read-only)

Cooling → **GPU tuning** shows what an AMD Radeon GPU reports through AMD's Overdrive 8 interface: power-limit range,
clock and memory limits, voltage offset, the fan curve, zero-RPM, Auto Undervolt, the power mode and the number of
driver recoveries since boot, plus whether the card runs at factory settings. **Nexum 1.1 does not change any GPU
setting**: it calls only the read functions of the AMD driver's own ADL library (CI fails the build if any write function
appears). *Run read-only probe* saves the full raw tables to `%LOCALAPPDATA%\Nexum\tuning-probe-*.json` so support for
your card can be checked before any write feature is considered.

## What Nexum will never do

* Clean or "fix" the registry.
* Download or install drivers.
* Inject code into other processes.
* Collect telemetry, analytics or usage data, or send anything about your PC anywhere.
* Bundle offers, toolbars or other software.
* Auto-update by downloading and running installers.
* Open a localhost web server, WebSocket or any other network API.

These commitments are enforced where they can be: CI fails on any network-client code in the Rust, C# and frontend
sources. See [`SECURITY.md`](SECURITY.md).

## Safety guarantees of the cleaner

* **Allow-list only.** Files are deleted solely *inside* a fixed set of known cache/temp folders; the folders themselves
  are never removed.
* **Immutable deny-list.** `System32`, `SysWOW64`, `WinSxS`, `Program Files`, registry hives, your
  Documents/Desktop/Pictures/Downloads/OneDrive and drive roots are refused after path canonicalization.
* **No link following.** Symlinks, junctions and mount points are skipped, never traversed.
* **Locked files are skipped**, never forced. Browser and Discord caches are skipped while that app is open, and the
  summary says so.
* **Windows Update is left alone while it is busy.** The update download cache is skipped while an update is waiting to
  install or restart. The Delivery Optimization cache is cleared only through Microsoft's own
  `Delete-DeliveryOptimizationCache` cmdlet. Nexum never stops Windows services.
* **Crash dumps are kept** unless you opt in, and even then the 5 newest dumps and anything less than 30 days old stay.
  Prefetch is never touched.
* **Dry run = real run.** The scan and the cleanup use the same enumerator, so the reclaimable figure is what actually
  gets removed. Categories that need Administrator rights are excluded from that figure when Nexum is not elevated.
* **Audit log.** Every cleanup writes `%LOCALAPPDATA%\Nexum\purge-logs\<timestamp>.jsonl` (path, size, date, result) and
  links to it from the summary.

Unit tests for these rules run in CI on every commit (`src-tauri/src/cleaner.rs`).

## Fan-control safety

* Fans start and stay under BIOS control (**Auto**) unless you choose otherwise. Silent / Balanced / Turbo are fixed
  speeds that ignore temperature, and the app says so.
* **Thermal override:** while Nexum controls any fan, the agent drives every controlled fan to 100% if the CPU reaches
  85 °C (or a controlled GPU gets too hot, or a temperature sensor stops reporting), and returns to your setting only
  after it has cooled 10 °C.
* **Crash fail-safe:** a state flag is written before the first manual fan write. If the agent is killed or hangs while
  it controls fans, Nexum sets every fan to 100% and tells you to restart the PC to return control to the BIOS.
* Fans return to BIOS control when Nexum exits normally.

## Architecture

```text
Tauri v2 (Rust) shell ── React + TypeScript + Tailwind UI (ECharts)
        │  alerts, CSV log, drive history, reports, notifications
        │  NDJSON over stdio (1 Hz) — no sockets, no ports
        ▼
nexum-agent (C# .NET 8 sidecar) ── LibreHardwareMonitorLib + WMI (+ PawnIO, if installed)
        │                       └─ AMD ADL (driver's atiadlxx.dll, read-only)
        └─ PresentMon-2.6.0-x64.exe (Intel-signed, only with frame capture on; ETW, Job Object)
```

See [`CONTRACT.md`](CONTRACT.md) for the exact IPC protocol and command surface, and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for the plan.

## Building from source

Prerequisites: Node.js 22+, Rust (stable, MSVC), .NET 8 SDK, Visual Studio 2022 Build Tools ("Desktop development with C++").

```powershell
npm ci
npm run build
dotnet publish nexum-agent/NexumAgent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o build/agent
copy build\agent\nexum-agent.exe src-tauri\binaries\nexum-agent-x86_64-pc-windows-msvc.exe
pwsh .github/scripts/fetch-presentmon.ps1   # downloads Intel's PresentMon 2.6.0 into build/presentmon and verifies it
npm run tauri -- build
```

The Rust build needs `build/presentmon/PresentMon-2.6.0-x64.exe` (a bundled resource). The script downloads the pinned
release from Intel's GitHub repository and stops unless the SHA-256 and the Intel signature match
[`.github/presentmon.json`](.github/presentmon.json). The file is never committed.

Outputs: `src-tauri/target/release/Nexum.exe` and the installers listed in `bundle.targets`
(`src-tauri/tauri.conf.json`) under `src-tauri/target/release/bundle/`. If `build/agent` contains native `.dll` files
next to `nexum-agent.exe`, a portable copy needs them in the same folder.

UI-only development (no Rust needed — uses simulated data): `npm run dev` → <http://localhost:1420>. Add `?rig=owner`,
`?admin=0` or `?pawnio=missing` to preview other hardware and degraded modes, `?fps=on` to start with frame capture on
(with `?rig=owner`, a simulated game is running), and `?alerts=hot` to preview temperature alerts.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

* Release binaries are built exclusively from this repository by GitHub Actions ([`build.yml`](.github/workflows/build.yml))
  and signed via SignPath only from tagged releases. Third-party binaries are never re-signed: Intel's PresentMon and
  the Mono helper DLLs ship with their vendors' own signatures, and CI fails if PresentMon's hash changes.
* Every release lists SHA-256 hashes (`SHA256SUMS.txt`). Check a download with `Get-FileHash -Algorithm SHA256 <file>`
  and `Get-AuthenticodeSignature <file>` (must be `Valid`).
* **Preview builds** (tags `vX.Y.Z-preview.N`) are published as GitHub pre-releases **unsigned**. They will not run with
  Smart App Control on; use them only in a VM or on a test PC.
* **Committers and reviewers:** [@captainRapipo](https://github.com/captainRapipo)
* **Approvers:** [@captainRapipo](https://github.com/captainRapipo)

Details: [`docs/SIGNING.md`](docs/SIGNING.md).

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Nexum has no telemetry, analytics, accounts or auto-update calls. All sensor data stays on your PC. Network access happens
only when *you* click a link (a vendor driver portal or the PawnIO site opens in your browser) or when the installer
downloads the Microsoft WebView2 runtime if it is missing. PresentMon is shipped in the installer; Nexum never downloads
it. Files Nexum writes stay local: sensor logs and saved reports in `Documents\Nexum\`, the drive history, cleanup audit
logs and tuning probe reports in `%LOCALAPPDATA%\Nexum\`.

## Security

Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## License

[GPL-3.0](LICENSE). Includes [LibreHardwareMonitorLib](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
(MPL-2.0), Intel's [PresentMon](https://github.com/GameTechDev/PresentMon) console application (MIT, unmodified) and the
Inter and JetBrains Mono fonts (SIL Open Font License 1.1). The read-only GPU tuning code follows the AMD ADL SDK headers
(MIT) and the memory-timing code follows ZenStates-Core (GPL-3.0). Third-party notices are in [`licenses/`](licenses/)
([`THIRD_PARTY.txt`](licenses/THIRD_PARTY.txt)). PawnIO is not included.

Nexum reads and controls hardware at a low level. It is provided **without warranty**; use fan control at your own risk.
