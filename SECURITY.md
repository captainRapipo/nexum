# Security policy

Nexum runs with Administrator rights, reads hardware at a low level, controls fans, deletes files, (when you turn
frame capture on) starts Intel's PresentMon and (when you click Install update) downloads and runs its own signed
installer. Security reports are welcome and are treated as the highest priority.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/captainRapipo/nexum/security/advisories/new)
(repository → *Security* tab → *Report a vulnerability*).

Please include:

* the Nexum version (Settings → Updates, or the installer file name) and Windows version;
* what an attacker needs (local unprivileged user, another process, a crafted file, a position on the network, a
  compromised GitHub account, physical access …);
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
| 1.2.x (latest release) | Yes |
| 1.1.x, 1.0.x | No (update to 1.2.x) |
| Preview builds and anything older than the latest release | No |

## Privileged surface

These are the parts of Nexum where a bug matters most, and where reports are most valuable.

| Component | Runs as | What it can do | Boundary |
| --- | --- | --- | --- |
| `Nexum.exe` (Tauri / Rust core) | Administrator (`requireAdministrator`) | Deletes files in the cache cleaner, queries WMI, runs `pnputil` for driver backup, starts and supervises the agent | The WebView UI talks to it only through Tauri commands. Strict CSP (`connect-src 'self' ipc: http://ipc.localhost`: the UI cannot reach the network), no shell permission and no updater permission for the WebView, `open_external` limited to `http(s)` URLs and existing folders. |
| **In-app updater** (`src-tauri/src/updater.rs`, the only network code) | Administrator (`Nexum.exe`) | Downloads one small JSON file from this repository's GitHub releases; after a click, downloads the installer it names, saves it and starts it | See [In-app updates](#in-app-updates) below: off until the user agrees; one host; signature and version check before anything runs; staged where only administrators can write; started only after a click. |
| `nexum-agent.exe` (.NET 8 sidecar) | Administrator (inherits the elevated token) | Reads sensors through LibreHardwareMonitorLib and, if installed, the PawnIO driver; writes fan duty cycles; reads live DDR4 timings from the AMD memory controller (read-only SMN reads through PawnIO, holding LibreHardwareMonitor's global `Access_PCI` mutex) | **Stdio only**: one JSON command per line from its parent process. No pipes, sockets, ports, COM servers or files are accepted as input. It is started with one optional argument, `--presentmon "<path>"`, supplied by `Nexum.exe`. `Nexum.exe` restarts it automatically a limited number of times (1, 2, 4, 8, 15 s apart, at most 5 in a row) and never when Windows blocked it or the file is missing. |
| Frame capture: **spawns the Intel-signed PresentMon exe** (`presentmon\PresentMon-2.6.0-x64.exe` in the install folder) | Administrator (child of the agent) | Reads Windows ETW present events system-wide (an ETW session named `NexumFrames`) and writes CSV rows to the agent's pipe. Off by default; runs only after you turn frame capture on. | Started only from the path Nexum passes (never from `PATH` or the current folder), **after a hash + signature check**: pinned SHA-256, `WinVerifyTrust` with no network access, signer `CN=Intel Corporation`, the file kept open without write/delete sharing until the process is created. Fixed arguments; no user text on its command line. Runs in a Job Object that kills it when the agent exits. Nexum never injects code, installs hooks, opens handles on, or sends messages to games or other processes. |
| GPU tuning panel: **reads AMD ADL tuning data read-only** | Administrator (agent) | Calls 11 functions of the AMD driver's `atiadlxx.dll` (set-up, tear-down, `Get`/`Caps` reads) to show Overdrive 8 ranges and current values | The DLL is loaded from System32 only. No ADL function with `_Set` in its name exists in the code (CI fails the build otherwise), and the write probe is rejected by both the agent and the Rust core. Nexum does not change GPU settings. |
| Fan state flag `%ProgramData%\Nexum\fan-manual.flag` | Written by the elevated agent | Records that fans are under manual control so a crash can be detected | Folder owned by Administrators with a protected DACL (SYSTEM and Administrators full control, Users read-only); reparse points refuse fan control. |
| Cache cleaner (`src-tauri/src/cleaner.rs`) | Administrator | Deletes files, including Recycle Bin items older than a chosen age (only the current user's own bin) | Allow-listed roots only, immutable deny-list after canonicalization, no link or junction following, locked files skipped, Recycle Bin metadata of an unknown format means the item is skipped, per-run audit log. |
| Files the elevated core writes in your folders: sensor logs (`Documents\Nexum\Logs\*.csv`), drive history (`%LOCALAPPDATA%\Nexum\history\drives.jsonl`), saved system reports, the tuning probe report | Administrator (`Nexum.exe`) | Creates or appends to files | Only through `safe_fs::PinnedDir`: every folder is opened without following links and pinned, files are created new (never overwritten) and their final path is verified. The agent writes nothing outside `%ProgramData%\Nexum`. |
| Desktop notifications | `Nexum.exe` | Shows Windows notifications for health alerts (opt-in, off by default) | Local only, through the Windows notification API; no network, no actions besides opening Nexum. Updates never use notifications. |
| PawnIO kernel driver | Kernel | Port I/O and SMBus access for sensors and fan control | **Not part of Nexum.** Installed separately by the user from [pawnio.eu](https://pawnio.eu/); report driver bugs upstream. |

Out of scope: attacks that already require Administrator rights or physical access, issues in PawnIO, WebView2,
LibreHardwareMonitor, PresentMon, the AMD driver, GitHub or Windows itself (please report those upstream; tell us if Nexum's use of them makes things
worse), and fan or thermal behaviour outside Nexum's control (BIOS, firmware).

## In-app updates

Added in 1.2 by the owner's decision. Nexum runs elevated, so an updater is the most sensitive thing it does: a flaw
here would let someone run their own program as Administrator. This section says what it does, what it trusts and
what it does not defend against.

### What it does

| Step | Detail |
| --- | --- |
| **Consent** | `Settings.updateCheck` starts as "ask". While it is "ask", the Rust core builds no request: the scheduler does not run and the commands refuse. The first-start question sets it to "auto" or "manual". This is enforced in Rust, not in the UI. |
| **What it contacts** | Exactly one of two fixed URLs: `https://github.com/captainRapipo/nexum/releases/download/updates/stable.json` or `…/preview.json` (assets of the permanent `updates` release). GitHub redirects asset requests to its own file hosts; the HTTPS client follows them. No other host is named in the code, and CI fails the build if one appears. The request carries no identifier, no hardware data and no version: only a generic client name (`tauri-plugin-updater/<version>`). |
| **When** | "auto": at most one answered check per 24 hours (first evaluated 30 s after start, then hourly; at most 3 failed automatic attempts per run; automatic failures are silent). "manual": only when the user presses *Check now*. A check never downloads the installer. |
| **What it accepts** | A manifest whose version is **strictly greater** than the running version (SemVer precedence) and whose download URL starts with `https://github.com/captainRapipo/nexum/releases/download/`. Anything else is discarded. |
| **What it verifies** | After the click on *Install update*, the installer is downloaded **into memory** (at most 300 MB) and its [minisign](https://jedisct1.github.io/minisign/) signature is verified against the public key compiled into the app, before anything touches the disk. Then the **signed** trusted comment is read: it names the file (`Nexum_<version>_x64-setup.exe`) and the version the signature was made for, and both must match the version on offer. The manifest itself is not signed, so this is what stops a manifest from pairing a new version number with an old, genuinely signed installer (a downgrade to a version with a known flaw). |
| **Where it stages** | `<folder of Nexum.exe>\updates\Nexum-update-<version>.exe`. The per-machine installer puts Nexum under `Program Files`, where only administrators can create, rename or replace files. The folder chain is opened without following links, must not contain a reparse point, and is pinned; the file is created new, never overwritten. `%TEMP%`, `%LOCALAPPDATA%` and `%ProgramData%` are **not** used, because a non-elevated process can create or pre-create entries there. The Tauri updater plugin's own install routine (which writes to `%TEMP%`) is never called. |
| **How a swap is prevented** | The staged file is reopened with read sharing only (no other handle may have write or delete access, and none can be opened while it is held), read back **through that handle**, and compared byte for byte with the verified download. The handle stays open until Nexum exits. |
| **What it executes** | That one file, by absolute path, without a shell, with the fixed arguments `/P /R /UPDATE` (Tauri's NSIS installer: passive UI, relaunch, update mode). Before that, Nexum stops the sensor log and shuts the agent down as on Quit, which returns the fans to BIOS control. |
| **Afterwards** | At the next start the `updates` folder is emptied and removed. |
| **Who can use it** | Only installed copies of release builds made by this repository's GitHub Actions with the update key. Builds from source, builds from forks, debug builds and portable copies have no update channel and never make a request. |

The WebView cannot reach any of this by itself: it has no network access (CSP), no permission for the updater plugin's
own commands, and no JavaScript updater package. It can call three commands of Nexum's own (`get_update_state`,
`check_for_update`, `install_update`), none of which takes a URL, a path or a version as an argument.

### Threat model

| Attacker | Outcome |
| --- | --- |
| On the network path, or controlling DNS or a proxy | Cannot change the traffic without breaking TLS. Even with a certificate the PC trusts (a corporate proxy, a rogue root), an installer that is not signed with Nexum's update key is refused, and so is a signed installer of an older version. They can make the check fail, which the app reports as "could not reach GitHub" (silently for automatic checks). |
| With write access to this repository's releases (for example a stolen maintainer session), **without** the update key | Can replace manifests and release files, but cannot produce an installer the app accepts: wrong key → refused; an old genuine installer under a new version number → refused (signed file name and version do not match). They can withhold updates. People who download by hand from the releases page are protected by Authenticode on signed releases, not by this check. |
| With the update private key, **without** repository access | Cannot deliver anything: the app only downloads from this repository. |
| With **both** the update key and write access to releases (or control of the release workflow) | Can deliver a malicious update to users who click *Install update*. This is the residual risk of any updater. Mitigations: the key exists only as a GitHub Actions secret and in the maintainer's offline backup; the maintainer's GitHub account uses multi-factor authentication (the code signing policy requires it); installing always needs a click; signed releases also carry Authenticode (a second, independent key held by SignPath and released only after manual approval). Windows enforces Authenticode where Smart App Control is on; Nexum itself does not check it. |
| A non-elevated process on the same PC | Cannot write into the staging folder under `Program Files`, cannot replace the staged file (it is held without write/delete sharing and was compared with the verified bytes through the held handle), and cannot plant links in the path (no link following, reparse points refused). If Nexum was installed into a folder that normal users can write to, such a user can already replace `Nexum.exe` itself; the updater adds no new exposure. |
| A malicious manifest (oversized download, odd URL, control characters in the notes) | The URL must match the fixed prefix; downloads over 300 MB are aborted; notes are shown as plain text, with control characters removed and cut at 4000 characters; a version that is not valid SemVer or not newer is discarded. |

### Known limits

* The NSIS installer unpacks its own helper files into a private temporary folder, as every NSIS installer does. In
  signed releases those files are Authenticode-signed (CI checks every one); in unsigned previews they are not.
* **Preview builds are not Authenticode-signed.** On a PC with Smart App Control on, Windows blocks the preview
  installer, and the app reports that Windows security blocked it. The updater signature still protects previews
  against tampering, but Windows cannot tell you who published them.
* After an update the installer may not be able to reopen Nexum, because Nexum needs Administrator rights and the
  installer relaunches as the signed-in user. The update dialog says so; start Nexum from the Start menu.
* The update key has no expiry and cannot be revoked remotely. If it leaks, the only remedy is a new key, which
  existing installs cannot learn through the updater (they trust the old one): users must install the next version by
  hand from the releases page. See [`docs/SIGNING.md`](docs/SIGNING.md#the-update-signing-key).
* GitHub is trusted for availability, not for integrity. If the repository or the account disappears, installed copies
  simply stop finding updates.
* Each release must pass a manual gate on a real PC or VM before it is published (no request before the first-start
  answer; a tampered installer is refused; an older signed installer under a newer version is refused); it is recorded
  in the release notes. CI cannot run the installed app.

### Key handling

* The **private** update key exists in two places only: the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` of this
  repository, and the maintainer's offline backup. It is never committed, never printed in logs, and no script in this
  repository reads it; it is handed to the Tauri CLI as an environment variable of the one step that signs.
* The **public** key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (minisign key ID `3D7778DED94C74A6`)
  and is compiled into every build.
* Pull requests from forks never receive the secret. A build without it succeeds, has no update channel and makes no
  `.sig`.
* Before a manifest is published, a separate workflow that does **not** have the key downloads the installer from its
  public URL and verifies it against the public key, the same way the app does.

## What Nexum will never do

* Clean or "fix" the registry.
* Download or install drivers.
* Inject code into other processes.
* Collect telemetry, analytics or usage data, ask for an account, or send anything about you or your PC anywhere.
* Bundle offers, toolbars or other software.
* Make any network request other than the update check to GitHub and, after you click **Install update**, the update
  download from GitHub. That check is off until you agree to it.
* Install anything without your click, or anything that is not signed with Nexum's update key.
* Open a localhost web server, WebSocket or any other network listener.

Anything that contradicts this list is a bug and a security issue. CI enforces the network part
([`check-network.mjs`](.github/scripts/check-network.mjs)): the build fails on any network-client API (`reqwest`,
`hyper`, `HttpClient`, `WebClient`, `WebSocket`, `fetch(`, `XMLHttpRequest`, the updater plugin …) in the Rust, C# or
frontend sources **outside one file**. The allow-list ([`.github/network-allowlist.txt`](.github/network-allowlist.txt))
can hold exactly two entries, and the check rejects anything else: the updater module `src-tauri/src/updater.rs` as a
whole, and the single line in `src-tauri/src/lib.rs` that registers the updater plugin. The frontend and the sidecar
cannot be allow-listed. The same check fails if a capability grants the WebView an `updater:` permission, if
`package.json` lists the JavaScript updater package, if the CSP `connect-src` is widened, or if the updater or its
configuration names any address outside `https://github.com/captainRapipo/nexum`.

CI also fails if a known-vulnerable kernel driver (WinRing0, InpOut, OpenHardwareMonitor) ever appears in the build
output, if any process-injection, hook or cross-process window-message API appears in the sources, if any AMD ADL write
function appears, or if the shipped PresentMon is not Intel's unmodified, Intel-signed file.

PresentMon is a file **shipped in the installer**. Nexum never downloads it at runtime; only the CI build downloads the
pinned release from Intel's GitHub repository and verifies it ([`docs/SIGNING.md`](docs/SIGNING.md)). The only thing
Nexum downloads at runtime is its own update, after a click.

## Verifying a release

Signed releases are built by GitHub Actions from a tagged commit and signed through SignPath Foundation
([`docs/SIGNING.md`](docs/SIGNING.md)). Before running a download:

```powershell
Get-FileHash -Algorithm SHA256 .\Nexum_1.2.0_x64-setup.exe   # must match SHA256SUMS.txt on the release page
Get-AuthenticodeSignature .\Nexum_1.2.0_x64-setup.exe        # Status must be Valid
```

The updater signature (the `.sig` file next to the installer) can be checked by hand with minisign; the commands are
in the README under [Updates](README.md#updates).
