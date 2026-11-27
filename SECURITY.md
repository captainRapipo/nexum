# Security policy

Nexum runs with Administrator rights, reads hardware at a low level, controls fans, deletes files and (when you turn
frame capture on) starts Intel's PresentMon. Security reports are welcome and are treated as the highest priority.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/captainRapipo/nexum/security/advisories/new)
(repository → *Security* tab → *Report a vulnerability*).

Please include:

* the Nexum version (Settings / About, or the installer file name) and Windows version;
* what an attacker needs (local unprivileged user, another process, a crafted file, physical access …);
* steps to reproduce or a proof of concept;
* the impact you expect (privilege escalation, arbitrary file deletion, hardware damage risk, information disclosure …).

What to expect:

* an acknowledgement within 7 days;
* an assessment and a planned fix date, or a reasoned "not a vulnerability", within 30 days;
* a fixed release, a GitHub security advisory, and credit if you want it. Please give us up to 90 days before public
  disclosure, less if the issue is already being exploited.

## Supported versions

Only the latest released version receives security fixes. Preview builds (`vX.Y.Z-preview.N`, unsigned) are for
testing and are not supported.

| Version | Supported |
| --- | --- |
| 1.1.x (latest release) | Yes |
| 1.0.x | No (update to 1.1.x) |
| Preview builds and anything older than the latest release | No |

## Privileged surface

These are the parts of Nexum where a bug matters most, and where reports are most valuable.

| Component | Runs as | What it can do | Boundary |
| --- | --- | --- | --- |
| `Nexum.exe` (Tauri / Rust core) | Administrator (`requireAdministrator`) | Deletes files in the cache cleaner, queries WMI, runs `pnputil` for driver backup, starts and supervises the agent | The WebView UI talks to it only through Tauri commands. Strict CSP, no shell permission for the WebView, `open_external` limited to `http(s)` URLs and existing folders. |
| `nexum-agent.exe` (.NET 8 sidecar) | Administrator (inherits the elevated token) | Reads sensors through LibreHardwareMonitorLib and, if installed, the PawnIO driver; writes fan duty cycles; reads live DDR4 timings from the AMD memory controller (read-only SMN reads through PawnIO, holding LibreHardwareMonitor's global `Access_PCI` mutex) | **Stdio only**: one JSON command per line from its parent process. No pipes, sockets, ports, COM servers or files are accepted as input. It is started with one optional argument, `--presentmon "<path>"`, supplied by `Nexum.exe`. |
| Frame capture: **spawns the Intel-signed PresentMon exe** (`presentmon\PresentMon-2.6.0-x64.exe` in the install folder) | Administrator (child of the agent) | Reads Windows ETW present events system-wide (an ETW session named `NexumFrames`) and writes CSV rows to the agent's pipe. Off by default; runs only after you turn frame capture on. | Started only from the path Nexum passes (never from `PATH` or the current folder), **after a hash + signature check**: pinned SHA-256, `WinVerifyTrust` with no network access, signer `CN=Intel Corporation`, the file kept open without write/delete sharing until the process is created. Fixed arguments; no user text on its command line. Runs in a Job Object that kills it when the agent exits. Nexum never injects code, installs hooks, opens handles on, or sends messages to games or other processes. |
| GPU tuning panel: **reads AMD ADL tuning data read-only** | Administrator (agent) | Calls 11 functions of the AMD driver's `atiadlxx.dll` (set-up, tear-down, `Get`/`Caps` reads) to show Overdrive 8 ranges and current values | The DLL is loaded from System32 only. No ADL function with `_Set` in its name exists in the code (CI fails the build otherwise), and the write probe is rejected by both the agent and the Rust core. Nexum 1.1 does not change GPU settings. |
| Fan state flag `%ProgramData%\Nexum\fan-manual.flag` | Written by the elevated agent | Records that fans are under manual control so a crash can be detected | Folder owned by Administrators with a protected DACL (SYSTEM and Administrators full control, Users read-only); reparse points refuse fan control. |
| Cache cleaner (`src-tauri/src/cleaner.rs`) | Administrator | Deletes files, including Recycle Bin items older than a chosen age (only the current user's own bin) | Allow-listed roots only, immutable deny-list after canonicalization, no link or junction following, locked files skipped, Recycle Bin metadata of an unknown format means the item is skipped, per-run audit log. |
| Files the elevated core writes in your folders: sensor logs (`Documents\Nexum\Logs\*.csv`), drive history (`%LOCALAPPDATA%\Nexum\history\drives.jsonl`), saved system reports, the tuning probe report | Administrator (`Nexum.exe`) | Creates or appends to files | Only through `safe_fs::PinnedDir`: every folder is opened without following links and pinned, files are created new (never overwritten) and their final path is verified. The agent writes nothing outside `%ProgramData%\Nexum`. |
| Desktop notifications | `Nexum.exe` | Shows Windows notifications for health alerts (opt-in, off by default) | Local only, through the Windows notification API; no network, no actions besides opening Nexum. |
| PawnIO kernel driver | Kernel | Port I/O and SMBus access for sensors and fan control | **Not part of Nexum.** Installed separately by the user from [pawnio.eu](https://pawnio.eu/); report driver bugs upstream. |

Out of scope: attacks that already require Administrator rights or physical access, issues in PawnIO, WebView2,
LibreHardwareMonitor, PresentMon, the AMD driver or Windows itself (please report those upstream; tell us if Nexum's use of them makes things
worse), and fan or thermal behaviour outside Nexum's control (BIOS, firmware).

## What Nexum will never do

* Clean or "fix" the registry.
* Download or install drivers.
* Inject code into other processes.
* Collect telemetry, analytics or usage data, or send anything about your PC anywhere.
* Bundle offers, toolbars or other software.
* Auto-update by downloading and running installers.
* Open a localhost web server, WebSocket or any other network API.

Anything that contradicts this list is a bug and a security issue. CI enforces the network part: the build fails on any
network-client API (`reqwest`, `hyper`, `HttpClient`, `WebClient`, `WebSocket`, `fetch(`, `XMLHttpRequest`, …) in the
Rust, C# or frontend sources unless it is explicitly approved in
[`.github/network-allowlist.txt`](.github/network-allowlist.txt) (empty). CI also fails if a known-vulnerable kernel
driver (WinRing0, InpOut, OpenHardwareMonitor) ever appears in the build output, if any process-injection, hook or
cross-process window-message API appears in the sources, if any AMD ADL write function appears, or if the shipped
PresentMon is not Intel's unmodified, Intel-signed file.

PresentMon is a file **shipped in the installer**. Nexum never downloads it (or anything else) at runtime; only the CI
build downloads the pinned release from Intel's GitHub repository and verifies it ([`docs/SIGNING.md`](docs/SIGNING.md)).

## Verifying a release

Signed releases are built by GitHub Actions from a tagged commit and signed through SignPath Foundation
([`docs/SIGNING.md`](docs/SIGNING.md)). Before running a download:

```powershell
Get-FileHash -Algorithm SHA256 .\Nexum_1.1.0_x64-setup.exe   # must match SHA256SUMS.txt on the release page
Get-AuthenticodeSignature .\Nexum_1.1.0_x64-setup.exe        # Status must be Valid
```
