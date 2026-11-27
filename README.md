<p align="center">
  <img src="app-icon.svg" width="96" alt="Nexum emblem" />
</p>

<h1 align="center">Nexum</h1>

<p align="center">
  <b>BIOS-style PC telemetry, sensors, driver inventory and safe cache cleanup for Windows 10/11.</b><br/>
  Lightweight · native · open source (GPL-3.0) · no telemetry, no network code
</p>

<p align="center">
  <a href="../../actions/workflows/build.yml"><img src="../../actions/workflows/build.yml/badge.svg" alt="Build status" /></a>
</p>

![Nexum dashboard](docs/screenshots/dashboard.png)

> Screenshots are rendered with the built-in **preview data** (no hardware access in the browser preview), using a
> realistic three-fan desktop with one worn NVMe drive. More views:
> [Sensors](docs/screenshots/sensors.png) · [System](docs/screenshots/system.png) ·
> [Storage](docs/screenshots/storage.png) · [Cooling](docs/screenshots/cooling.png) ·
> [Drivers](docs/screenshots/drivers.png) · [Cleaner](docs/screenshots/cleaner.png) ·
> [Clean caches dialog](docs/screenshots/purge.png) · [1280 × 800](docs/screenshots/dashboard-1280.png) ·
> [Without administrator rights](docs/screenshots/dashboard-limited.png)

## What it does

| View | Key | Highlights |
| --- | --- | --- |
| **Dashboard** | `F1` | KPI strip, a live load chart (CPU / GPU / RAM as separate lines on a 0–100% axis), **Health alerts** (every active condition, with the rule that raised it), your **pinned sensors**, and a short system summary. The header status pill (Optimal / Attention / Critical / Partial sensors) follows documented rules; hover it to see them. |
| **Sensors** | `F2` | The full sensor tree (motherboard Super I/O, CPU, memory, GPU, drives) with **Value / Min / Max / Avg** for the session and a 60 s sparkline. Reset all or selected rows, search, hide unused sensors, rename any sensor (`F2` or double-click), hide it, or pin it to the Dashboard. Your names follow the sensor everywhere in the app. |
| **System** | `F3` | A CPU-Z-style summary: CPU (name, socket, family/model/stepping, caches), mainboard, BIOS and Super I/O chip, memory type, size, channels and per-DIMM details, graphics, and OS & security status (Secure Boot, TPM). "Copy as text" masks serial numbers. |
| **Storage** | `F4` | Physical drives (NVMe / SATA SSD / HDD) with one consistent **drive-health model** (Good / Worn / Replace soon / Failing / Health unknown), a S.M.A.R.T. details drawer (spare vs threshold, % used, media errors, unsafe shutdowns, temperature history), live read/write throughput, and which volumes sit on which drive. |
| **Cooling** | `F6` | Every motherboard fan header and GPU fan with live RPM and session min/max, fan presets (Auto (BIOS) / Silent / Balanced / Turbo) and per-fan duty sliders. Requires Administrator, PawnIO and a supported Super I/O chip. See [fan-control safety](#fan-control-safety). |
| **Drivers** | `F7` | A full driver inventory (provider, version, date, signature, INF) across every device class, with JSON/CSV export and driver backup via `pnputil`. Driver age is shown as neutral information; only devices Windows reports as having a problem, and unsigned drivers, are flagged. **Nexum never installs drivers.** |
| **Clean caches** | `F9` | A dry-run scan first, then removes reclaimable caches: temporary files, the Windows Update download cache, error reports and old logs are on by default. Crash dumps, `MEMORY.DMP`, shader caches, the Recycle Bin and browser/Discord caches are **off** by default and must be switched on. Every cleanup writes an audit log. See [cleaner safety](#safety-guarantees-of-the-cleaner). |

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
| `F9` | Clean caches |
| `Ctrl+1` … `Ctrl+7` | Dashboard, Sensors, System, Storage, Cooling, Drivers, Clean caches |
| `Esc` | Close dialogs |

`F8` is reserved for a future Gaming view. `F10` is never bound because Windows uses it for menu activation.

## Requirements

* Windows 10 or 11, x64. Nexum runs as Administrator (needed for fan control, S.M.A.R.T., motherboard sensors and the
  Windows Update / error-report cleanup).
* Microsoft Edge WebView2 Runtime (included with Windows 11; the installer downloads it from Microsoft if missing).
* **Optional: [PawnIO](https://pawnio.eu/) ≥ 2.1.0 for full sensor access** (CPU temperature, power and clock,
  motherboard fan headers and voltages, fan control). PawnIO is a separate, vendor-signed kernel driver. Nexum asks
  before you install it, never bundles or installs it itself, and never removes it (other apps may use it). Without it,
  Nexum runs in a clearly labelled "Partial sensors" mode: values it cannot read show as "—" with the reason, never as 0.

Nexum never uses the WinRing0 driver (CVE-2020-14979), and CI fails the build if WinRing0, InpOut or the
OpenHardwareMonitor driver ever appears in the output.

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
        │  NDJSON over stdio (1 Hz) — no sockets, no ports
        ▼
nexum-agent (C# .NET 8 sidecar) ── LibreHardwareMonitorLib + WMI (+ PawnIO, if installed)
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
npm run tauri -- build
```

Outputs: `src-tauri/target/release/Nexum.exe` and the installers listed in `bundle.targets`
(`src-tauri/tauri.conf.json`) under `src-tauri/target/release/bundle/`. If `build/agent` contains native `.dll` files
next to `nexum-agent.exe`, a portable copy needs them in the same folder.

UI-only development (no Rust needed — uses simulated data): `npm run dev` → <http://localhost:1420>. Add `?rig=owner`,
`?admin=0` or `?pawnio=missing` to preview other hardware and degraded modes.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

* Release binaries are built exclusively from this repository by GitHub Actions ([`build.yml`](.github/workflows/build.yml))
  and signed via SignPath only from tagged releases. Third-party binaries are never re-signed.
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
downloads the Microsoft WebView2 runtime if it is missing.

## Security

Please report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).

## License

[GPL-3.0](LICENSE). Includes [LibreHardwareMonitorLib](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor)
(MPL-2.0) and the Inter and JetBrains Mono fonts (SIL Open Font License 1.1). Third-party notices are in
[`licenses/`](licenses/). PawnIO is not included.

Nexum reads and controls hardware at a low level. It is provided **without warranty**; use fan control at your own risk.
