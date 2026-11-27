# Security policy

Nexum runs with Administrator rights, reads hardware at a low level, controls fans and deletes files. Security reports
are welcome and are treated as the highest priority.

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
| 1.0.x (latest release) | Yes |
| Preview builds and anything older than the latest release | No |

## Privileged surface

These are the parts of Nexum where a bug matters most, and where reports are most valuable.

| Component | Runs as | What it can do | Boundary |
| --- | --- | --- | --- |
| `Nexum.exe` (Tauri / Rust core) | Administrator (`requireAdministrator`) | Deletes files in the cache cleaner, queries WMI, runs `pnputil` for driver backup, starts and supervises the agent | The WebView UI talks to it only through Tauri commands. Strict CSP, no shell permission for the WebView, `open_external` limited to `http(s)` URLs and existing folders. |
| `nexum-agent.exe` (.NET 8 sidecar) | Administrator (inherits the elevated token) | Reads sensors through LibreHardwareMonitorLib and, if installed, the PawnIO driver; writes fan duty cycles | **Stdio only**: one JSON command per line from its parent process. No pipes, sockets, ports, COM servers or files are accepted as input. |
| Fan state flag `%ProgramData%\Nexum\fan-manual.flag` | Written by the elevated agent | Records that fans are under manual control so a crash can be detected | Folder owned by Administrators with a protected DACL (SYSTEM and Administrators full control, Users read-only); reparse points refuse fan control. |
| Cache cleaner (`src-tauri/src/cleaner.rs`) | Administrator | Deletes files | Allow-listed roots only, immutable deny-list after canonicalization, no link or junction following, locked files skipped, per-run audit log. |
| PawnIO kernel driver | Kernel | Port I/O and SMBus access for sensors and fan control | **Not part of Nexum.** Installed separately by the user from [pawnio.eu](https://pawnio.eu/); report driver bugs upstream. |

Out of scope: attacks that already require Administrator rights or physical access, issues in PawnIO, WebView2,
LibreHardwareMonitor or Windows itself (please report those upstream; tell us if Nexum's use of them makes things
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
driver (WinRing0, InpOut, OpenHardwareMonitor) ever appears in the build output.

## Verifying a release

Signed releases are built by GitHub Actions from a tagged commit and signed through SignPath Foundation
([`docs/SIGNING.md`](docs/SIGNING.md)). Before running a download:

```powershell
Get-FileHash -Algorithm SHA256 .\Nexum_1.0.0_x64-setup.exe   # must match SHA256SUMS.txt on the release page
Get-AuthenticodeSignature .\Nexum_1.0.0_x64-setup.exe        # Status must be Valid
```
