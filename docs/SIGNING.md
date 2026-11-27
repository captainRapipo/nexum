# Code signing (SignPath Foundation)

Windows **Smart App Control** (SAC) and **SmartScreen** block or warn on unsigned executables. Microsoft's guidance is to
sign "all binaries, such as exe, dll, temp installer files, scripts, and uninstallers"
([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/smart-app-control)).
Nexum is signed through [SignPath Foundation](https://signpath.org), which provides free code-signing certificates to
open-source projects. Background and decisions: [`ROADMAP.md`](ROADMAP.md) MF-8.

## What the build produces

The installer formats are whatever `bundle.targets` lists in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json).
CI does not override it (`npm run tauri -- build` without `--bundles`), so the config is the single source of truth.

| Artifact | Contents | Today |
| --- | --- | --- |
| `nexum-installers-unsigned` | one installer per `bundle.targets` entry: NSIS `Nexum_<ver>_x64-setup.exe`, and `Nexum_<ver>_x64_en-US.msi` if `msi` is listed | `bundle.targets = ["nsis"]`: the NSIS installer only |
| `nexum-portable-unsigned` | `Nexum.exe`, `nexum-agent.exe`, any native `.dll` the agent publish leaves next to it, `LICENSE`, `licenses/` | |
| `nexum-sha256-unsigned` | `SHA256SUMS-unsigned.txt` for every file above | |

MSI is the documented fallback (ROADMAP MF-8 item 2): it is removed by Microsoft-signed `msiexec`, so it has no unsigned
uninstaller and no plugin DLLs. Add `"msi"` to `bundle.targets` to build it alongside NSIS, or switch to it alone if the
NSIS checks below cannot be made to pass.

Native libraries: once the agent is published with `IncludeNativeLibrariesForSelfExtract=false` (MF-8 item 1), its native
DLLs (today `MonoPosixHelper.dll` and `libMonoPosixHelper.dll`, already signed by their vendor) sit next to
`nexum-agent.exe` instead of being extracted to the user-writable `%TEMP%\.net`. They must be installed with the agent.

## How releases are signed

1. A maintainer pushes a tag `vX.Y.Z`.
2. The `build` job in [`.github/workflows/build.yml`](../.github/workflows/build.yml) compiles everything from source on
   a clean GitHub-hosted runner, runs the checks below, and uploads the unsigned artifacts.
3. The `sign` job (needs `build` and `policy`) submits the installers and the portable files to SignPath. SignPath
   verifies they came from this repository's workflow (origin verification), a maintainer approves the request, and the
   signed files are returned.
4. The `sign` job unpacks and test-installs the signed installers and requires **every** PE to be Authenticode `Valid`
   (see below). Only then does it attach the signed installers, the portable zip and `SHA256SUMS.txt` to a **draft**
   GitHub release, which a maintainer reviews and publishes.

Unsigned CI artifacts from regular commits are for testing only.

## Preview releases (unsigned)

SignPath Foundation signs only projects that are "already released in the form that should be signed" and executables
with "a certain verifiable reputation" ([terms](https://signpath.org/terms)). To build that history before the first
signed release:

* Push a tag matching `v*-preview*`, for example `v1.0.0-preview.1`.
* The `preview` job publishes the unsigned CI build as a GitHub **pre-release** titled
  "Nexum vX.Y.Z-preview.N — Preview — unsigned — will not run with Smart App Control on". Every file name ends in
  `-UNSIGNED-PREVIEW`, the release notes repeat the warning, and `SHA256SUMS.txt` is attached. It is never marked latest.
* The `sign` job does not run for preview tags.
* Preview builds will not start on a PC with Smart App Control on (including the maintainer's). Test them in a VM or on a
  PC with SAC off.

If the SignPath application is delayed, the fallback is Microsoft Artifact Signing (formerly Trusted Signing), once
eligibility for individuals is confirmed (ROADMAP Q12).

## CI checks

| Check | Where | Fails the job when |
| --- | --- | --- |
| **No network code** (MF-11) — `.github/scripts/check-network.mjs` | `policy` job | `reqwest`, `ureq`, `hyper`, `HttpClient`, `WebClient`, `HttpWebRequest`, `TcpClient`, `TcpListener`, `TcpStream`, `UdpClient`, `UdpSocket`, `HttpListener`, `WebSocket`, `XMLHttpRequest`, `EventSource(`, `sendBeacon`, `fetch(` or `axios` appears in `src-tauri/src/**`, `nexum-agent/**/*.cs` or `src-frontend/**`, unless its `path:line` is in `.github/network-allowlist.txt` |
| **UI copy rules** (CONTRACT §4.8) — `.github/scripts/check-copy.mjs` | `policy` job | a banned word (boost, optimize, speed up, free RAM, junk, trash, purge, deep purge, outdated) is in user-visible text in `src-frontend/**/*.tsx`, unless allow-listed in `.github/copy-allowlist.txt` |
| **Forbidden kernel drivers** (MF-3) — `.github/scripts/check-forbidden-drivers.mjs` | `build` and `sign` | `WinRing0*.sys`, `inpout*.sys` or `OpenHardwareMonitorLib.sys` is anywhere in the agent publish output, the Tauri bundle output, the portable folder or the unpacked installers |
| **Tauri CLI ≥ 2.9.3** (MF-8 item 2) | `build` | the installed `@tauri-apps/cli` is older than 2.9.3 (older bundlers embed the NSIS plugin DLLs unsigned) |
| **Authenticode report** (MF-8) — `.github/scripts/check-authenticode.ps1` | `build` | report-only, unless the repository variable `NEXUM_SIGNING_ENABLED` is `true` (signing inside the build) |
| **Authenticode must be `Valid`** (MF-8) | `sign` | any PE in the signed installers, the signed portable files, the installers' unpacked contents or the test-install image is not `Valid`. The release is not published. |
| **Sidecar unit tests** | `build` | only runs when a `.csproj` references `Microsoft.NET.Test.Sdk` |

The Authenticode checks find PE files by their header, not their extension, and cover:

* the installers themselves (`.exe`, `.msi`);
* the portable folder, including the agent's loose native DLLs;
* the NSIS installer's unpacked contents (7-Zip), including `$PLUGINSDIR` (`System.dll`, `nsDialogs.dll`, Tauri's NSIS
  plugins …), which the installer extracts to `%TEMP%` at install time;
* the MSI's administrative image (`msiexec /a`), if an MSI is built;
* a silent test install of the NSIS installer on the runner, which includes the generated `uninstall.exe`;
* in the `build` job, the bundler's own NSIS plugin folder (`%LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode`).

Each run writes a table of file, status and signer to the job summary. `SHA256SUMS` are printed in the `build` job log
and summary, uploaded as `nexum-sha256-unsigned`, and attached to every release.

### Known gap: files inside the installers

SignPath signs the files it is given. Signing the finished NSIS installer does **not** sign what is packed inside it:
the `Nexum.exe` and `nexum-agent.exe` it installs, the NSIS plugin DLLs and the uninstaller. Until that is solved, the
enforcing check in the `sign` job is expected to fail and block the release, which is the intended behaviour. Options,
in order of preference:

1. **Sign during bundling.** Configure `bundle.windows.signCommand` in `tauri.conf.json` so tauri-bundler (≥ 2.9.3)
   signs `Nexum.exe`, the sidecar, the NSIS plugin DLLs and the uninstaller as it builds the installer. This needs a
   signing service callable per file from CI (SignPath's per-file signing, or Artifact Signing).
2. **MSI with deep signing.** Build `msi` and configure the SignPath `installers` artifact configuration to sign the PE
   files inside the MSI before signing the MSI itself.
3. **MSI only** (ROADMAP MF-8 item 2) if NSIS cannot pass.

Third-party binaries are **never re-signed** (MF-8 item 7). Every shipped third-party PE (for example the Xamarin-signed
`MonoPosixHelper.dll`) must already carry its vendor's valid signature, and the SignPath artifact configurations must
sign only Nexum's own files.

## One-time setup (maintainer)

1. Publish at least one preview release (above), then apply at <https://signpath.org/apply> with this repository URL.
2. After approval, in the SignPath project create:
   * signing policy slug **`release-signing`** (manual approval required);
   * artifact configuration **`installers`**: a zip containing the installers produced by `bundle.targets`
     (`*.exe`, plus `*.msi` if built) → sign each with Authenticode (for MSI, also the PE files inside it);
   * artifact configuration **`portable`**: a zip containing `Nexum.exe`, `nexum-agent.exe`, third-party DLLs and
     licence files → sign **only** `Nexum.exe` and `nexum-agent.exe` with Authenticode and pass everything else through
     unchanged.
3. Install the SignPath GitHub App on the repository (enables origin verification).
4. In GitHub → Settings → Secrets and variables → Actions:
   * secret `SIGNPATH_API_TOKEN` (a SignPath CI user token);
   * variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`;
   * variable `NEXUM_SIGNING_ENABLED` = `true` only once the build itself signs (option 1 above), so the `build` job's
     Authenticode report becomes enforcing.
5. Enable multi-factor authentication on both GitHub and SignPath accounts (SignPath Foundation requirement).
6. Enable **private vulnerability reporting** (Settings → Code security) so [`SECURITY.md`](../SECURITY.md) works.

## Verifying a download

```powershell
Get-FileHash -Algorithm SHA256 .\Nexum_1.0.0_x64-setup.exe   # compare with SHA256SUMS.txt on the release page
Get-AuthenticodeSignature .\Nexum_1.0.0_x64-setup.exe        # Status must be Valid
```

## Roles

| Role | People |
| --- | --- |
| Committers & reviewers | @captainRapipo |
| Approvers | @captainRapipo |
