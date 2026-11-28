# Signing: Authenticode (SignPath Foundation) and the update key

Nexum's release files carry **two different signatures**, made with two different keys, for two different readers:

| | Authenticode | Updater signature |
| --- | --- | --- |
| Who checks it | Windows (Smart App Control, SmartScreen, the UAC prompt) | Nexum itself, before it runs a downloaded update |
| Where it is | Inside every `.exe` / `.dll` | A separate `.sig` file next to the installer, and the `signature` field of the update manifest |
| Key | SignPath Foundation's certificate; the key never leaves SignPath | Nexum's own minisign key; private part in the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` |
| Covers | Each signed file | The finished installer as a whole, plus its file name and app version |
| Status | Signed releases only (previews are unsigned) | Every release built with the key, previews included |

Neither replaces the other. Authenticode tells Windows who published a file. The updater signature tells an installed
Nexum that a download really is the next Nexum, whatever GitHub or the network served. The first half of this document
is about Authenticode; [The update signing key](#the-update-signing-key) is about the second.

Windows **Smart App Control** (SAC) and **SmartScreen** block or warn on unsigned executables. Microsoft's guidance is to
sign "all binaries, such as exe, dll, temp installer files, scripts, and uninstallers"
([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/smart-app-control)).
Nexum is signed through [SignPath Foundation](https://signpath.org), which provides free code-signing certificates to
open-source projects. Background and decisions: [`ROADMAP.md`](ROADMAP.md) MF-8.

## What the build produces

The installer formats are whatever `bundle.targets` lists in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json).
CI does not override it (`npm run tauri -- build` without `--bundles`), so the config is the single source of truth.
For a release tag CI passes a small `--config` override with the tag's version (and, with the update key,
`bundle.createUpdaterArtifacts`); see [The update signing key](#the-update-signing-key).

| Artifact | Contents | Today |
| --- | --- | --- |
| `nexum-installers-unsigned` | one installer per `bundle.targets` entry: NSIS `Nexum_<ver>_x64-setup.exe`, and `Nexum_<ver>_x64_en-US.msi` if `msi` is listed | `bundle.targets = ["nsis"]`: the NSIS installer only |
| `nexum-portable-unsigned` | `Nexum.exe`, `nexum-agent.exe`, any native `.dll` the agent publish leaves next to it, `presentmon/PresentMon-2.6.0-x64.exe` (Intel-signed, third-party), `LICENSE`, `licenses/` | |
| `nexum-sha256-unsigned` | `SHA256SUMS-unsigned.txt` for every file above | |
| `nexum-updater-signature-unsigned` | `Nexum_<ver>_x64-setup.exe.sig`: the updater signature of the **unsigned** installer | only for a release tag built with the update key |

MSI is the documented fallback (ROADMAP MF-8 item 2): it is removed by Microsoft-signed `msiexec`, so it has no unsigned
uninstaller and no plugin DLLs. Add `"msi"` to `bundle.targets` to build it alongside NSIS, or switch to it alone if the
NSIS checks below cannot be made to pass. Two things must be solved first, because the in-app updater (1.2) is built
around the NSIS installer: the bundler refuses a preview version such as `1.2.0-preview.1` for MSI (its pre-release
part must be a plain number), and the update manifests describe only the NSIS installer.

Native libraries: once the agent is published with `IncludeNativeLibrariesForSelfExtract=false` (MF-8 item 1), its native
DLLs (today `MonoPosixHelper.dll` and `libMonoPosixHelper.dll`, already signed by their vendor) sit next to
`nexum-agent.exe` instead of being extracted to the user-writable `%TEMP%\.net`. They must be installed with the agent.

### Intel PresentMon (third-party, shipped unmodified)

Since v1.1 the installer and the portable build contain `presentmon/PresentMon-2.6.0-x64.exe`, Intel's PresentMon
console application (MIT), used by the opt-in frame capture (ROADMAP §4, CONTRACT §1.6). It is **Intel's release asset
byte for byte**, already Authenticode-signed by Intel Corporation:

* CI downloads it at build time from the pinned GitHub release URL in [`.github/presentmon.json`](../.github/presentmon.json)
  (the only place the URL and hash live) with [`fetch-presentmon.ps1`](../.github/scripts/fetch-presentmon.ps1), and fails
  unless its SHA-256 is `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af`, `Get-AuthenticodeSignature`
  is `Valid` and the signer subject starts with `CN=Intel Corporation`. This happens before anything compiles
  `src-tauri`, because tauri-build checks that every `bundle.resources` file exists.
* It is shipped through `bundle.resources` (not `externalBin`, which the bundler may sign) and is never committed
  (`build/presentmon/` is gitignored).
* **It must never be re-signed.** A re-signed copy has a different SHA-256, so the agent's pinned-hash check refuses
  to start it at runtime (CONTRACT §1.6.1), and the CI checks below fail the build and the release.
* Nexum itself never downloads it: the app's only network code is the updater (MF-11, CONTRACT §2.15), which fetches
  nothing but Nexum's own update; only CI downloads PresentMon, at build time.
* Updating PresentMon is a deliberate pull request: change `.github/presentmon.json`, the agent's pinned hash, the
  resource name in `tauri.conf.json` and the saved CSV header together (ROADMAP §4.3 gate 4).

## How releases are signed

1. A maintainer adds a `## X.Y.Z` section to [`CHANGELOG.md`](CHANGELOG.md), makes sure `package.json`,
   `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` say `X.Y.Z`, and pushes a tag `vX.Y.Z`. (The build stops at
   once if the tag, the three versions and the changelog do not agree.)
2. The `build` job in [`.github/workflows/build.yml`](../.github/workflows/build.yml) compiles everything from source on
   a clean GitHub-hosted runner, runs the checks below, and uploads the unsigned artifacts. With the update key the app
   is compiled with its update channel (`stable`).
3. The `sign` job (needs `build` and `policy`) submits the installers and the portable files to SignPath. SignPath
   verifies they came from this repository's workflow (origin verification), a maintainer approves the request, and the
   signed files are returned.
4. The `sign` job unpacks and test-installs the signed installers and requires **every** PE to be Authenticode `Valid`
   (see below).
5. **Only now** is the updater signature made, over the Authenticode-signed installer (see
   [Order: Authenticode first, updater signature second](#order-authenticode-first-updater-signature-second)), and
   checked again without the key.
6. The signed installer, its `.sig`, the portable zip and `SHA256SUMS.txt` are attached to a **draft** GitHub release,
   which a maintainer reviews, tests (the release gate in [`SECURITY.md`](../SECURITY.md#known-limits)) and publishes.
7. Publishing fires the [`update-manifest.yml`](../.github/workflows/update-manifest.yml) workflow. It downloads the
   installer and the `.sig` from their public URLs, verifies them against the public key, and only then writes
   `stable.json` and `preview.json` on the `updates` release. From that moment installed copies are offered the version.

Unsigned CI artifacts from regular commits are for testing only. They have no update channel.

## Preview releases (unsigned)

SignPath Foundation signs only projects that are "already released in the form that should be signed" and executables
with "a certain verifiable reputation" ([terms](https://signpath.org/terms)). To build that history before the first
signed release:

* Push a tag of the form `vX.Y.Z-preview.N`, for example `v1.2.0-preview.1`. `X.Y.Z` must be the committed version;
  the app is built as version `X.Y.Z-preview.N`, which sorts below `X.Y.Z` (SemVer), so a later stable release
  replaces it. Other tag shapes (`-rc1`, `-beta`) are rejected by the build.
* The `preview` job publishes the unsigned CI build as a GitHub **pre-release** titled
  "Nexum vX.Y.Z-preview.N — Preview — unsigned — will not run with Smart App Control on". Every file name ends in
  `-UNSIGNED-PREVIEW`, the release notes repeat the warning, and `SHA256SUMS.txt` is attached. It is never marked latest.
* With the update key, the installer's updater signature is published next to it
  (`Nexum_<ver>_x64-setup-UNSIGNED-PREVIEW.exe.sig`; it was made by the build, under the name
  `Nexum_<ver>_x64-setup.exe`, and renaming the file does not affect it). After the pre-release is public, the
  `preview-manifest` job verifies the public files and writes `preview.json`, so installed previews are offered the
  new one. The updater signature does **not** make a preview pass Smart App Control.
* The `sign` job does not run for preview tags.
* Preview builds will not start on a PC with Smart App Control on (including the maintainer's). Test them in a VM or on a
  PC with SAC off.

If the SignPath application is delayed, the fallback is Microsoft Artifact Signing (formerly Trusted Signing), once
eligibility for individuals is confirmed (ROADMAP Q12).

## CI checks

| Check | Where | Fails the job when |
| --- | --- | --- |
| **No network code outside the updater** (MF-11, CONTRACT §7 item 12) — `.github/scripts/check-network.mjs` | `policy` job | `reqwest`, `ureq`, `hyper`, `HttpClient`, `WebClient`, `HttpWebRequest`, `TcpClient`, `TcpListener`, `TcpStream`, `UdpClient`, `UdpSocket`, `HttpListener`, `WebSocket`, `XMLHttpRequest`, `EventSource(`, `sendBeacon`, `fetch(`, `axios`, `tauri_plugin_updater` or `updater_builder` appears in `src-tauri/src/**`, `nexum-agent/**/*.cs` or `src-frontend/**` outside the two entries `.github/network-allowlist.txt` may hold (the whole file `src-tauri/src/updater.rs`, and the one line of `src-tauri/src/lib.rs` that registers the plugin); the allow-list holds anything else; a capability grants an `updater:` permission; `package.json` lists `@tauri-apps/plugin-updater`; the CSP `connect-src` is not exactly `'self' ipc: http://ipc.localhost`; or a string in `updater.rs` (outside its tests) or an endpoint in `tauri.conf.json` names an address outside `https://github.com/captainRapipo/nexum`; `plugins.updater` lacks `requireSignedVersion: true`, sets `allowDowngrades` or a `dangerous…` switch, or holds any other key; the plugin registration is anything but `.plugin(tauri_plugin_updater::Builder::new().build())`; or the code of `updater.rs` uses the plugin's own installer (`download_and_install`, `.install(`), `.pubkey(`, or switches certificate checks off |
| **UI copy rules** (CONTRACT §4.8) — `.github/scripts/check-copy.mjs` | `policy` job | a banned word (boost, optimize, speed up, free RAM, junk, trash, purge, deep purge, outdated, agent) is in user-visible text in `src-frontend/**/*.ts` or `*.tsx`, unless allow-listed in `.github/copy-allowlist.txt`; or the word "agent" is in a string literal of `src-tauri/src/**/*.rs` that can reach the screen (not in tests, log or assertion macros, comparisons or identifiers). "agent" cannot be allow-listed |
| **CI script self-test** — `.github/scripts/selftest.mjs` | `policy` job | one of the checks above, the release planner, the manifest rules or the signature verifier misbehaves on its fixtures (the verifier is tested against the published minisign test vectors) |
| **Design hygiene** (CONTRACT §4.9) — `.github/scripts/check-design.mjs` | `policy` job | enforcing (`--enforce`): hex colours outside the token files and retired dark-theme classes fail the job. The list of crimson primary buttons in the job summary is a report |
| **Release plan** (CONTRACT §7 item 14) — `updater-manifest.mjs plan` | `build`, before compiling | the tag is not `vX.Y.Z` / `vX.Y.Z-preview.N`; a pushed tag uses preview number 0, or a rehearsal uses anything but `vX.Y.Z-preview.0`; it does not match the version in `tauri.conf.json`, `package.json` and `Cargo.toml`; `CHANGELOG.md` has no section for it or the section breaks the UI copy rules; the update key is set but `tauri.conf.json` has no public key; or `@tauri-apps/cli` is older than 2.12.0 while the key is set |
| **Updater signature self-check** — `updater-manifest.mjs verify-sig` | `build`, `preview`, `sign` (only with the update key) | the `.sig` does not verify against `plugins.updater.pubkey`, was made with another key, or is not bound to `Nexum_<version>_x64-setup.exe` and to the version |
| **Update manifest** (CONTRACT §7 item 14 e) — `updater-manifest.mjs make`, `verify`, `gate` | `update-manifest.yml` | the release is a draft; a `-preview` tag is not marked pre-release (or the reverse); the installer or its `.sig` is missing; the public URL does not answer 200; the downloaded bytes do not verify; the manifest's version is not the tag's; the two platform entries differ; the URL is outside this repository's release. A published manifest is never replaced by an older version |
| **Forbidden kernel drivers** (MF-3) — `.github/scripts/check-forbidden-drivers.mjs` | `build` and `sign` | `WinRing0*.sys`, `inpout*.sys` or `OpenHardwareMonitorLib.sys` is anywhere in the agent publish output, the Tauri bundle output, the portable folder or the unpacked installers |
| **Tauri CLI ≥ 2.9.3** (MF-8 item 2) | `build` | the installed `@tauri-apps/cli` is older than 2.9.3 (older bundlers embed the NSIS plugin DLLs unsigned) |
| **Authenticode report** (MF-8) — `.github/scripts/check-authenticode.ps1` | `build` | report-only, unless the repository variable `NEXUM_SIGNING_ENABLED` is `true` (signing inside the build) |
| **Authenticode must be `Valid`** (MF-8) | `sign` | any PE in the signed installers, the signed portable files, the installers' unpacked contents or the test-install image is not `Valid`. The release is not published. |
| **Sidecar unit tests** | `build` | only runs when a `.csproj` references `Microsoft.NET.Test.Sdk` |
| **Read-only GPU tuning** (CONTRACT §7.9) — `.github/scripts/check-tuning-readonly.mjs` | `policy` job | an ADL entry point with a `_Set` segment appears in the agent, Rust or frontend sources; anything under `nexum-agent/Tuning/` has a `_Set` segment, a native import outside `AdlNative.cs`, `GetProcAddress`, `NativeLibrary.*`, a function pointer or reflection; or `AdlNative.cs` imports an entry point that is not on the CONTRACT §1.7.1 whitelist or is not restricted to System32. No allow-list. |
| **No injection or hooks** (CONTRACT §0) — `.github/scripts/check-no-injection.mjs` | `policy` job | `CreateRemoteThread`, `WriteProcessMemory`/`ReadProcessMemory`, `VirtualAllocEx`, `QueueUserAPC`, `SetThreadContext`, `SetWindowsHookEx`, `SetWinEventHook`, `PostMessage`/`SendMessage` and similar APIs appear in the agent, Rust or frontend sources. No allow-list. |
| **PresentMon download** (CONTRACT §7.7) — `.github/scripts/fetch-presentmon.ps1` | `build` (before any Rust compile) | the pinned file cannot be downloaded, or its SHA-256, Authenticode status or Intel signer does not match `.github/presentmon.json` |
| **Frame capture + tuning guard smoke test** — `.github/scripts/smoke-frames.ps1` | `build` | `tuningProbe write:true` is not rejected; the agent finds PresentMon without `--presentmon`; the trust check rejects the pinned Intel exe; PresentMon survives a hard kill of the agent (Job Object); or a `NexumFrames` ETW session is left after a clean stop (ROADMAP §4.3 gate 3) |
| **PresentMon shipped unmodified** (MF-8 item 7) — `.github/scripts/check-presentmon-shipped.ps1` | `build` and `sign`, always enforcing | a PresentMon copy in the portable build, the unpacked installer, the test-install image or the signed release is missing, has a different SHA-256 (modified or re-signed), is not `Valid` or is not signed by Intel Corporation |

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

Third-party binaries are **never re-signed** (MF-8 item 7). Every shipped third-party PE (the Xamarin-signed
`MonoPosixHelper.dll` and the Intel-signed `presentmon/PresentMon-2.6.0-x64.exe`) must already carry its vendor's valid
signature, and the SignPath artifact configurations must sign only Nexum's own files. With option 1, check that the
bundler's `signCommand` is not applied to `presentmon/PresentMon-2.6.0-x64.exe` (it ships as a resource, not as a
sidecar); the "PresentMon shipped unmodified" check fails the build if it is.

## The update signing key

The in-app updater (CONTRACT §2.15, [`SECURITY.md`](../SECURITY.md#in-app-updates)) trusts exactly one key.

* **What it is.** A [minisign](https://jedisct1.github.io/minisign/) (Ed25519) key pair made with
  `tauri signer generate`, with an empty password. Key ID `3D7778DED94C74A6`.
* **Public part:** `plugins.updater.pubkey` in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json), compiled
  into every build. Publishing it is harmless.
* **Private part:** the GitHub Actions secret **`TAURI_SIGNING_PRIVATE_KEY`** of this repository, plus the
  maintainer's offline backup (a password manager or an encrypted drive, not a cloud folder, not this repository).
  Nothing else holds it. It is never printed; no script in the repository reads it; the workflow hands it to the Tauri
  CLI as an environment variable of one step (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is set to an empty string next to
  it). Pull requests from forks never receive it.
* **It is not Authenticode.** It has no certificate, no publisher name and no expiry, Windows does not know it, and
  SignPath is not involved. It only lets an installed Nexum recognise the next Nexum.

### Who can use the key

A repository secret is available to every workflow run that starts from a branch or tag **of this repository**. So
anyone who can push here can write a workflow that signs with the key, whatever `build.yml` itself does. Pull requests
from forks cannot: they get no secrets. Treat push access to this repository as access to the update key, and keep
the list of people who have it as short as the list of people who may release.

To narrow it further (recommended once there is more than one person with push access): move the secret into a GitHub
**environment** (Settings → Environments, for example `release-signing`) with *required reviewers* and *deployment
tags* limited to `v*`, delete the repository-level secret, and add `environment: release-signing` to the `build` and
`sign` jobs. A run then gets the key only for a `v*` tag and only after a reviewer approves it. This is a repository
setting and is not done yet; a rehearsal would then have to be approved like a release.

### Pinned actions

Third-party actions in [`build.yml`](../.github/workflows/build.yml) are referenced by commit, with the version in a
comment, because the `build` job later holds the update key and the `sign` and `preview` jobs can write releases: a
tag or branch can be moved to different code, a commit cannot. To update one, look up the commit of the new version
(`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`), read what changed, and replace the commit and the comment
together. GitHub's own `actions/*` are referenced by major version.

| Action | Pinned to |
| --- | --- |
| `dtolnay/rust-toolchain` | `df2a88e9fe4098bad09cb42c3dec7187f15861fc` (master, 2026-11-15; `toolchain: stable`) |
| `Swatinem/rust-cache` | `d1527c8f67ef9af357290475d4af4b0fab8f12e0` (v2.9.3) |
| `signpath/github-action-submit-signing-request` | `c92b958760219087e01f8d67a1669ed57afe2627` (v2.3) |
| `softprops/action-gh-release` | `8a0cd651e5b2365bd640854a3fa5dfc70e4875f3` (v3.0.4) |

### What the build does with it

| Build | Update channel compiled in (`NEXUM_UPDATE_CHANNEL`) | Updater artifacts |
| --- | --- | --- |
| Branch push, pull request, fork, local build | none: the updater is disabled and never makes a request | none; `bundle.createUpdaterArtifacts` is not in the committed config |
| Tag, but the secret is not set | none | none (the build still succeeds, with a warning) |
| Tag `vX.Y.Z-preview.N` with the secret | `preview` | `.sig` from the bundler, over the unsigned installer |
| Tag `vX.Y.Z` with the secret | `stable` | the bundler's `.sig` is discarded; a new one is made after SignPath |
| Rehearsal (`Run workflow` with `rehearse_tag` = `vX.Y.Z-preview.0`) | `preview` | as for a preview tag, as run artifacts only; nothing is published |

The decision is made by one step (`Release plan`), which only learns *whether* the secret exists. It writes
`build/tauri.release.conf.json` (`{"version": "<tag version>"}` plus `"bundle": {"createUpdaterArtifacts": true}` with
the key), and `tauri build --config` merges it over the committed config.

### Rehearsal: try the release path without a tag

`Actions` → `Build` → `Run workflow` → `rehearse_tag` = `vX.Y.Z-preview.0` for the committed version, for example
`v1.2.0-preview.0`. **Preview number 0 belongs to rehearsals and to nothing else:** a rehearsal signs its installer
with the real update key, and that installer is not a release, so it must never carry a version a release can have.
The release plan enforces both halves: a rehearsal with any other tag (a stable `vX.Y.Z`, or a preview number above
0) is refused, a pushed tag `vX.Y.Z-preview.0` is refused, and `update-manifest.yml` refuses to describe a
`-preview.0` release. Number real previews from 1. The build job then plans, builds and signs exactly as it
would for that tag: tag version, update channel, updater `.sig`, the signature self-check. It also builds the manifest
that `update-manifest.yml` would write and runs the manifest checks on it, except "the URL answers 200" (the file is not
published, so the URL does not exist). The `sign`, `preview` and manifest jobs do not run. The installer, the `.sig`
and `manifest.json` are artifacts of the workflow run and expire with it. Only people who can push to the repository
can start it, and it fails when the secret is missing.

### Order: Authenticode first, updater signature second

The updater signature covers the installer's exact bytes. SignPath adds the Authenticode signature **into** the
installer, which changes those bytes. So for a signed release:

1. the build makes an installer and (as a by-product) a `.sig` for it; that `.sig` is never used;
2. SignPath signs the installer;
3. the `sign` job runs the Authenticode checks on the signed files;
4. the `sign` job runs `tauri signer sign --app-version <version> signed/installers/Nexum_<version>_x64-setup.exe`,
   which writes `Nexum_<version>_x64-setup.exe.sig` for the **signed** bytes;
5. `updater-manifest.mjs verify-sig`, which does not have the key, checks the new `.sig` against the public key.

The file must have the name `Nexum_<version>_x64-setup.exe` when it is signed. The Tauri CLI writes the file name and
the app version into the signature's *trusted comment* (`timestamp:…<TAB>file:Nexum_<version>_x64-setup.exe<TAB>version:<version>`),
which the signature itself covers. Nexum requires both and compares both with the version a manifest offers, so an
old signed installer cannot be served as a new version, and a signature made without `--app-version`, or for a file
of another name, is refused by the app (and by the CI checks before it is ever published). Renaming the published asset afterwards (previews get `-UNSIGNED-PREVIEW`) is fine.
This needs `@tauri-apps/cli` 2.12.0 or newer (the lockfile pins a newer one; the plan step checks it).

For a **preview** nothing changes the installer after the build, so the bundler's `.sig` is the one that is published.

### Manifests

`https://github.com/captainRapipo/nexum/releases/download/updates/stable.json` and `…/preview.json` are assets of one
permanent pre-release tagged `updates` (created by the workflow the first time; never "Latest"). `stable.json` describes
the newest stable release, `preview.json` the newest release of any kind. They are written by
[`update-manifest.yml`](../.github/workflows/update-manifest.yml), which runs when a release is **published** (or is
called by the `preview` release, or started by hand with a tag), never for a draft. That workflow has no access to the
key: it re-verifies what is publicly downloadable.

To withdraw a bad release: delete or un-publish it, then run *Update manifests* by hand (`Actions` → `Update manifests`
→ `Run workflow`) with the tag of the last good release and **force** ticked. Installed copies that already took the bad
version are not rolled back (Nexum never installs an older version); they need a newer fixed release.

### Rotating or replacing the key

There is no revocation: every installed copy trusts the public key it was built with. A rotation therefore needs one
**transition release** that carries the new public key but is still signed with the old private key:

1. `npx tauri signer generate --ci -w nexum-update.key` on a trusted PC (CLI 2.10.1 or newer; keys made with an empty
   password by 2.9.3 to 2.10.0 do not work). Store the private key in the offline backup.
2. Set the repository **variable** `NEXUM_UPDATE_VERIFY_PUBKEY` to the **old** public key (the current value of
   `plugins.updater.pubkey`). It tells the CI checks which key installed copies still trust; without it they verify
   against the key in the config and would reject the transition release.
3. Put the **new** public key in `plugins.updater.pubkey`, merge, and release. The secret is still the old private
   key, so existing installs accept this release; once they have installed it they trust the new key only. (The Tauri
   bundler prints a warning that the keys do not match; that is expected for this one release.)
4. Replace the secret `TAURI_SIGNING_PRIVATE_KEY` with the new private key, **delete the variable**, and make the next
   release as usual.

Leave some time between steps 3 and 4: a copy that never installed the transition release cannot verify later
releases and must be updated by hand from the releases page. If the old key is **lost**, step 3 is impossible and
every existing install must be updated by hand once. If it is **stolen**, skip the transition release (do 1, the
config change of 3, and 4), tell users in the release notes and a security advisory to install by hand, and remember
that the thief still needs write access to this repository's releases to reach anyone.

## One-time setup (maintainer)

1. Publish at least one preview release (above), then apply at <https://signpath.org/apply> with this repository URL.
2. After approval, in the SignPath project create:
   * signing policy slug **`release-signing`** (manual approval required);
   * artifact configuration **`installers`**: a zip containing the installers produced by `bundle.targets`
     (`*.exe`, plus `*.msi` if built) → sign each with Authenticode (for MSI, also Nexum's own PE files inside it:
     `Nexum.exe` and `nexum-agent.exe` only, **never** `PresentMon-*.exe` or the Mono DLLs);
   * artifact configuration **`portable`**: a zip containing `Nexum.exe`, `nexum-agent.exe`, third-party DLLs,
     `presentmon/PresentMon-2.6.0-x64.exe` and licence files → sign **only** `Nexum.exe` and `nexum-agent.exe` with
     Authenticode and pass everything else through unchanged, keeping the `presentmon/` folder (Nexum looks for the exe
     there).
3. Install the SignPath GitHub App on the repository (enables origin verification).
4. In GitHub → Settings → Secrets and variables → Actions:
   * secret `SIGNPATH_API_TOKEN` (a SignPath CI user token);
   * variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`;
   * variable `NEXUM_SIGNING_ENABLED` = `true` only once the build itself signs (option 1 above), so the `build` job's
     Authenticode report becomes enforcing.
5. Enable multi-factor authentication on both GitHub and SignPath accounts (SignPath Foundation requirement).
6. Enable **private vulnerability reporting** (Settings → Code security) so [`SECURITY.md`](../SECURITY.md) works.
7. For in-app updates: the secret `TAURI_SIGNING_PRIVATE_KEY` (done; see [The update signing key](#the-update-signing-key)).
   Nothing else is needed: the `updates` release is created by the workflow, with the workflow's own token.

## Verifying a download

```powershell
Get-FileHash -Algorithm SHA256 .\Nexum_1.2.0_x64-setup.exe   # compare with SHA256SUMS.txt on the release page
Get-AuthenticodeSignature .\Nexum_1.2.0_x64-setup.exe        # Status must be Valid

# Optional, after installing: the bundled PresentMon is Intel's unmodified file
Get-FileHash -Algorithm SHA256 "$env:ProgramFiles\Nexum\presentmon\PresentMon-2.6.0-x64.exe"   # b2a706bc...0188f1af
(Get-AuthenticodeSignature "$env:ProgramFiles\Nexum\presentmon\PresentMon-2.6.0-x64.exe").SignerCertificate.Subject   # starts with CN=Intel Corporation
```

The updater signature can be checked by hand as well; see the README, [Updates](../README.md#updates).

## Roles

| Role | People |
| --- | --- |
| Committers & reviewers | @captainRapipo |
| Approvers | @captainRapipo |
