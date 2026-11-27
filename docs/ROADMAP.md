# Nexum Roadmap

Status: product decision document, 2026-11-27. It supersedes the "Future V2 Enhancements" list in [`DESIGN-SPEC.md`](DESIGN-SPEC.md) §9, and also the parts of DESIGN-SPEC that mention WinRing0 or a localhost WebSocket.

It synthesizes six research and test reports:
- **press-hw**: Tom's Hardware and PCMag coverage of monitoring tools.
- **press-general**: trust and safety (cleaners, vendor utilities, driver updaters, vulnerable drivers).
- **fps**: feasibility of in-game FPS capture.
- **oc**: overclocking and tuning feasibility and risk.
- **reference**: a UX gap study against CPU-Z, HWMonitor, HWiNFO64 and GPU-Z.
- **design-test**: a UI test using a simulated profile of the reference test rig (Ryzen 7 5700X3D / RX 9070 XT / B550).

Effort: **S** is 2 dev-days or less, **M** is 3–7, **L** is more than 7. "Contract" means [`CONTRACT.md`](../CONTRACT.md). Unless a change says otherwise, every contract change is additive, and `src-frontend/types.ts` must be updated in the same PR.

## 0. Verification status (critic pass, 2026-11-27)

`[Verified]` below means the claim was re-checked against the primary source on 2026-11-27, not just copied from a report. `[Unverified]` means no primary source was found either way; the plan must treat it as a risk.

| # | Load-bearing claim | Result |
|---|---|---|
| V1 | PresentMon console exe is Intel-signed and MIT | **[Verified]** `PresentMon-2.6.0-x64.exe` (released 2026-09-21) downloaded from the [v2.6.0 release](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0): SHA-256 `b2a706bc…88f1af` matches the GitHub asset digest and §4.1; `Get-AuthenticodeSignature` = `Valid`, subject `CN=Intel Corporation, O=Intel Corporation, S=California, C=US`, issuer `CN=Sectigo Public Code Signing CA R36`. Licence MIT ([LICENSE.txt](https://github.com/GameTechDev/PresentMon/blob/main/LICENSE.txt)). Every console flag in §4.1 exists in [README-ConsoleApplication.md](https://github.com/GameTechDev/PresentMon/blob/main/README-ConsoleApplication.md). |
| V2 | ADLX licence is incompatible with GPL-3.0; ADL is MIT | **[Verified]** [ADLX SDK License Agreement](https://github.com/GPUOpen-LibrariesAndSDKs/ADLX/blob/main/ADLX%20SDK%20License%20Agreement.pdf): §2(c) allows distribution "solely in Object Code form", §3 requires an EULA banning reverse engineering and naming AMD as third-party beneficiary, §4(f) forbids use "in way that requires that the Licensed Materials … be licensed under a Free Software License". ADL: the repo has **no LICENSE file**; the MIT grant is in each header (`include/adl_sdk.h`, `include/adl_defines.h`, "Copyright (c) 2016 - 2022 … MIT LICENSE", [display-library](https://github.com/GPUOpen-LibrariesAndSDKs/display-library/tree/master/include)). Ship a copy of that header text in `licenses/ADL/`. |
| V3 | ADL Overdrive8 *writes* work on RDNA4 (RX 9070 XT) | **[Unverified]** No AMD document, issue or review was found that confirms or refutes OD8 writes on Navi 48. AMD's ADLX docs do carry Navi 4-specific tuning semantics ("Starting from Navi 4+, the GPU voltage is an offset from the base voltage", [ADLX SetGPUVoltage](https://gpuopen.com/manuals/adlx/adlx-sdk-references/adlx-interfaces/gpu-tuning/iadlxmanualgraphicstuning2/setgpuvoltage/)), while the ADL headers were last touched in 2022, so AMD's RDNA4 tuning work is visibly in ADLX, not ADL. The v1.1 probe (§5.3) is therefore a hard gate, not a formality. |
| V4 | LHM 0.9.6 provides SPD timings and a public SMN read | **[Verified, with limits]** LHM v0.9.6 (2026-02-14, [release](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/tag/v0.9.6)) has `Hardware/Memory/DimmMemory.cs`, which exposes DDR4 **JEDEC SPD minimum timings in nanoseconds** as `SensorType.Timing` (tAA, tRCD, tRP, tRAS, tRC, tRFC1/2/4, tFAW, tRRD_S/L, tCCD_L, tWR, tWTR_S/L) through RAMSPDToolkit, plus a DIMM temperature only when the module has a thermal sensor ([DimmMemory.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Memory/DimmMemory.cs)). These are **not** XMP values and **not** the live timings; they need SMBus access through PawnIO. `public class AmdFamily17` with `public uint ReadSmn(uint offset)` exists ([AmdFamily17.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/PawnIo/AmdFamily17.cs)), and the PawnIO module does not restrict SMN offsets ([AMDFamily17.p](https://github.com/namazso/PawnIO.Modules/blob/main/AMDFamily17.p)). |
| V5 | SignPath Foundation requirements | **[Verified, with new constraints]** [SignPath terms](https://signpath.org/terms): OSI licence "for all components" and no "proprietary, non open-source component" (System Libraries excepted); "only sign software artifacts built from their own source code"; unsigned upstream OSS binaries may be *included*; a modified upstream may be signed only from a visible fork of an upstream that publishes signed builds; "The project must already be released in the form that should be signed" and executables need "a certain verifiable reputation"; MFA for all team members; a "Code signing policy" page; no "features designed to identify or exploit security vulnerabilities"; no system-configuration changes "without proper warnings". See MF-8 items 5–7 and the v1.1 security-audit row. |
| V6 | PawnIO installer is vendor-signed; ≥ 2.1.0 fixes FACEIT | **[Verified]** Latest is **2.2.0** (2026-03-15, [releases](https://github.com/namazso/PawnIO.Setup/releases)). `PawnIO_setup.exe` 2.2.0: SHA-256 `1f519a22…ba3032`, signature `Valid`, subject `CN=namazso.eu, O=namazso, C=HU`, issuer `CN=GLOBALTRUST 2015 CODESIGNING 1` (cert valid to 2027-08-05). It is therefore a CA-signed third-party helper as Smart App Control requires. The FACEIT fix is the maintainer's statement only ("This should be fixed as of 2.1.0", [#1](https://github.com/namazso/PawnIO.Setup/issues/1)); FACEIT has not confirmed it publicly, so the §4.3 FACEIT row stays a real test. |
| V7 | Tauri does not document NSIS uninstaller signing (old MF-8 text) | **Wrong, corrected in MF-8.** The uninstaller has been signed since tauri-bundler 1.4.0 ("Sign NSIS uninstaller as well", [changelog](https://v2.tauri.app/release/tauri-bundler/v1.4.0/)); the NSIS *plugin DLLs* that the installer extracts to `%TEMP%` were embedded **unsigned** until tauri-bundler 2.9.3 ([changelog](https://v2.tauri.app/release/tauri-bundler/v2.9.3/)). |

**Coverage gap:** the owner asked for Ars Technica, The Verge, Wired, CNET and ZDNet coverage as well as Tom's Hardware and PCMag. None of the five is cited in this roadmap, and the research tooling could not reach those sites on 2026-11-27. Treat the press basis as Tom's Hardware, PCMag and How-To Geek only until someone checks the other five by hand (Q11).

---

## 1. Executive summary

1. Nexum's architecture is already more trustworthy than CCleaner, PC Manager or the vendor suites: stdio-only IPC, PawnIO instead of WinRing0, cleaner deletes that are safe against time-of-check/time-of-use races, and no telemetry. Its UI is not there yet: several defaults and labels are the kind Microsoft's PUA criteria name.
2. **Release blocker #1:** the reference rig's system drive is at 44% life and shows up nowhere on the Dashboard. The Storage view labels it "HEALTHY", in red with admin rights and in green without.
3. **Release blocker #2:** the cleaner's defaults and wording. Shader caches and the Recycle Bin are on by default, Prefetch is cleaned, crash dumps are deleted unconditionally, the standby flush reports "Freed X MB" of RAM, and the button says "PURGE TRASH".
4. **Release blocker #3:** drivers older than 3 years are shown as red "OUTDATED", the same tactic driver-updater scareware uses. Show age as neutral information and mark only real problems red.
5. **Release blocker #4:** signing must cover every file that runs, including the NSIS uninstaller, the NSIS plugin DLLs the installer extracts to `%TEMP%`, and the .NET native libraries. The agent's native libraries currently self-extract into user-writable `%TEMP%\.net`. SignPath Foundation also requires an existing release and a "verifiable reputation" before it signs an executable (V5), so the owner's Smart App Control machine needs a signing plan for the first build (MF-8 item 5).
   - **Release blocker #5 (added by the critic pass):** fan control has no fail-safe. Fixed-duty presets ignore temperature, and if the agent is killed the IT8688E stays in manual mode with Gigabyte's fan controller disabled (MF-13).
6. v1.0 also adds a HWMonitor/HWiNFO-style **Sensors** view (Value/Min/Max/Avg, reset, rename) and a lite CPU-Z-style **System** view. LibreHardwareMonitor (LHM) 0.9.6 already provides nearly all of the data.
7. **FPS (v1.1):** run Intel's signed, unmodified PresentMon console app from the elevated agent (signature and licence `[Verified]`, V1). It works over ETW with no injection. The feature is opt-in. The overlay ships in v1.2 as a separate click-through window. RTSS-style hooks will never be added.
8. **GPU tuning (v1.1 read-only, v1.2 writes, if the probe passes):** use AMD's **MIT-licensed ADL Overdrive8**, not ADLX. The ADLX licence is incompatible with GPL-3.0 and with SignPath Foundation (`[Verified]`, V2). Whether OD8 writes work on RDNA4 at all is `[Unverified]` (V3): a failed probe means GPU tuning stays read-only. Writes use a 15 s auto-revert and a crash journal, and allow only within-spec changes by default.
9. **CPU and RAM tuning: read-only, permanently.** The 5700X3D is locked, and Curve Optimizer through undocumented SMU commands is too risky.
10. Every feature must stay under the 1.5% CPU budget. Nexum will show its own CPU and RAM use in the status bar so users can check that claim.

### 1.1 Conflicts between the reports, and how they are resolved

| # | Conflict | Decision |
|---|---|---|
| C1 | **Health threshold for the 44% drive.** press-hw: "should render as Caution (CrystalDiskInfo)". design-test: CrystalDiskInfo's Caution is ≤ 10%. | design-test is right. CrystalDiskInfo defines SSD Caution as "Remaining Life <= 10%" ([crystalmark.info](https://crystalmark.info/en/software/crystaldiskinfo/crystaldiskinfo-health-status/), `[Verified]` 2026-11-27; the page sets no NVMe critical-warning or spare rules, so those rows in MF-1 rest on the Microsoft source alone). Nexum uses its **own** documented scale (§2, MF-1): 11–50% is amber "Worn", ≤ 10% is rose "Replace soon". 44% is amber, not green and not red. |
| C2 | **F-key for the new view.** fps: F6 Gaming. oc: F6 Tuning. reference: F6 Cooling plus a full renumbering. | One keymap from v1.0: **F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F8 Gaming (v1.1) · F9 Clean caches**, plus `Ctrl+1..8` aliases. GPU tuning is a tab inside Cooling, because the GPU fan curve belongs with the fans. F10 stays unbound because Windows reserves it for menu activation. |
| C3 | **Whole-app elevation.** press-general wants the UI to run asInvoker with only the agent elevated, and no named pipes. fps needs an elevated ETW consumer. The current design is stdio from Rust to the agent. | An unelevated parent cannot launch an elevated child (`runas`) and keep redirected stdio. "asInvoker UI" and "stdio only" cannot both hold. **v1.0 keeps `requireAdministrator`** and hardens the WebView (already done: strict CSP, no shell permission for the WebView, `open_external` limited to http(s) and existing folders). **v1.2 splits privilege:** the elevated agent starts through a Program Files scheduled task and talks over one named pipe. The pipe's DACL allows only the interactive user's SID, and the server checks the client's PID and that its image is the signed `Nexum.exe` in Program Files. This is not the DriverHub bug class, which was an *unauthenticated web origin* ([mrbruh.com](https://mrbruh.com/asusdriverhub/)). No TCP, no HTTP, no COM. |
| C4 | **ADLX vs ADL.** The owner's plan named ADLX. oc found the ADLX licence (§2(c), §3, §4(f)) incompatible with GPL-3.0 and with [SignPath's terms](https://signpath.org/terms) (`[Verified]` V2: §4(f) bars use that requires a Free Software License, and SignPath bars "any proprietary, non open-source component"). fps proposed ADLX `GetCurrentFPS` for AFMF. | **No ADLX code in Nexum**: not for tuning and not for "driver FPS". Use ADL OD8 (MIT, [display-library](https://github.com/GPUOpen-LibrariesAndSDKs/display-library)). Ask AMD for a licence exception (open question Q7) and revisit only with a written grant. |
| C5 | **Standby-list flush.** The original spec sells it as "free up RAM before gaming". press-general calls it snake oil and suggests demoting it to an Advanced panel. | **Remove it entirely** (command, Tauri command, setting and category). An "advanced" version still invites the misleading "Freed X MB" framing, and RAMMap already exists for diagnostics. |
| C6 | **Local data API.** press-hw wants a free, unlimited named pipe or shared-memory feed (versus HWiNFO's 12-hour limit). press-general says no listeners. | **v1.3+, opt-in, read-only** memory-mapped section with no inbound commands, off by default. Until then, CSV logging (v1.1) covers the use case. |
| C7 | **Mock "owner" profile hostname.** reference suggested naming the mock profile after the real machine. | **Rejected.** The repo is public. design-test already uses `WORKSTATION-02`. Keep generic names everywhere (see MF-12). |
| C8 | **Drivers "Outdated" tile.** design-test wanted it to filter the table when clicked. press-general wants it removed. | **Remove it** (MF-5). design-test's grouping and sort-by-problems suggestions are kept. |
| C9 | **Overlay timing.** fps: overlay in v1.1, after the MVP. The original spec: "In-Game HUD Overlay". | **Overlay in v1.2.** v1.1 ships capture and the Gaming view only, so overhead and anti-cheat behaviour can be measured before anything draws over a game. |

---

## 2. Must-fix before the first public release (v1.0 gate)

Each item names its evidence. The **release gate** is all of MF-1 to MF-13 merged, plus the CI checks in MF-8 and MF-11 passing, plus one install-and-run pass on a clean Windows 11 machine with Smart App Control **On** (the owner's configuration), because SAC's cloud verdict cannot be reproduced by `Get-AuthenticodeSignature` alone ([Microsoft](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/smart-app-control): SAC "only allows processes to run if they're predicted to be safe").

### MF-1 Surface drive wear everywhere, with one consistent health model (M)
- **Defect** (design-test #1, #2, #11, #12; pre-1.0 owner screenshots of the Storage and Dashboard views, since replaced by the v1.0 set in `docs/screenshots/`):
  - No Dashboard card mentions the 44% drive, and the header still says "SYNCED / OPTIMAL".
  - In `PhysicalDiskCard.tsx` the label comes from Windows `healthStatus` but the colour comes from `healthPct`. The result is a red "HEALTHY" with admin rights and a green one without.
  - Volumes are not linked to their physical disk, so the user can't see that C: sits on the worn drive.
- **Rule:** classify once, in the sidecar (`DriveHealth.Classify`). Rust, the UI and v1.1 notifications then agree.

  | State | Tone | Trigger |
  |---|---|---|
  | `failing` | rose | NVMe critical warning: spare below threshold, reliability degraded or read-only ([Microsoft](https://support.microsoft.com/en-us/topic/what-to-do-about-a-critical-warning-for-a-storage-device-258e0042-e091-277d-5fa6-3c710fba70d7)); or Windows `Unhealthy` |
  | `replace` | rose | remaining life ≤ 10% (CrystalDiskInfo's Caution line, [source](https://crystalmark.info/en/software/crystaldiskinfo/crystaldiskinfo-health-status/)) |
  | `attention` | amber | life 11–50% (label "Worn"), or HDD attributes 05/C5/C6 > 0 (label "Check sectors") |
  | `good` | teal | life > 50% and none of the above |
  | `unknown` | slate | no SMART data. The label says "Health unknown — run as admin" or "— PawnIO missing". **Never green.** |
- **UI:**
  - Header pill: amber "Attention · 1 drive worn".
  - A dismissible Dashboard banner: "C: (addlink NVMe) — 44% life left (56% of rated endurance used, 20,188 h). Copy important files and plan a replacement." with a "View drive" button.
  - A "Life 44%" chip on Primary Drive.
  - "on <model> (Life 44%)" under each volume.
  - A "1 of 3 drives needs attention" KPI replaces "Hottest drive · All volumes have headroom".
- **Contract (additive):**
  - `telemetry.disks[]` gains:
    - `serial: string|null`
    - `health: { state: "good"|"attention"|"replace"|"failing"|"unknown", label: string, reason: string, source: "nvme"|"smart"|"none" }`
    - `criticalWarning: number|null`
    - `availableSparePct`, `availableSpareThresholdPct`, `percentageUsed`, `mediaErrors`, `unsafeShutdowns`, `powerCycles`, `errorLogEntries`, `warningTempC`, `criticalTempC`, `reallocatedSectors`, `pendingSectors`, `uncorrectableSectors`, `dataReadTb` (all `number|null`, from LHM `StorageDevice.Attributes`, [SmartAttributeTranslator.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Storage/SmartAttributeTranslator.cs))
  - `PhysicalDisk` gains `volumes: string[]` (from `MSFT_Partition.DriveLetter` by disk number) and `isSystemDisk: boolean`.
  - Telemetry disks and WMI disks are joined on `serial`.

### MF-2 Unavailable is not zero: degraded-mode states and banner (M)
- **Defect** (design-test #3, #4, #18):
  - Without elevation the Fan KPI falls back to the GPU fan and shows "0 RPM", I/O reads "0.00 MB/s", sparklines are drawn for null values, and the "Thermal & Load Index" shows "11% NOMINAL" with no CPU temperature.
  - The sidecar knows when "PawnIO driver is not installed" (`Program.cs` ~line 599), but that message reaches no screen.
- **Fix:**
  - One `<Unavailable reason="notElevated"|"pawnIoMissing"|"pawnIoOutdated"|"unsupported" />` state: an em dash, a lock icon and a one-line cause. Used by every KPI, tile and card.
  - Never substitute a different sensor (no GPU fan for a motherboard-fan KPI).
  - Hide sparklines and chart series that have no data.
  - A persistent banner names the missing features (for example "CPU temp/power/clock, 3 fan headers, drive SMART, fan control, WU-cache/log cleanup") and offers **Restart as administrator** and **Get PawnIO** (opens [pawnio.eu](https://pawnio.eu/)).
  - In limited mode the header pill reads "Partial sensors", never "Optimal".
- **Contract:**
  - `hello` gains `sensorDriver: { kind: "pawnio"|"none", version: string|null, minVersion: "2.1.0", ok: boolean, reason: "missing"|"outdated"|"notElevated"|null }`.
  - `AgentStatus` gains `sensorDriver` (copied from `hello`), `limitedReasons: ("notElevated"|"pawnIoMissing"|"pawnIoOutdated")[]` and `missingFeatures: string[]`.

### MF-3 PawnIO: consent, minimum version, never bundled, never WinRing0 (S)
- **Why:**
  - FACEIT blocked PawnIO.sys builds signed with a certificate that cheat software also used. The maintainer says this is fixed as of PawnIO 2.1.0 ([PawnIO.Setup#1](https://github.com/namazso/PawnIO.Setup/issues/1); [FACEIT](https://support.faceit.com/hc/en-us/articles/360014237259--Forbidden-driver-error-message-and-blocked-drivers)).
  - WinRing0 is CVE-2020-14979 ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2020-14979)) and Defender flags it ([Microsoft](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/microsoft-defender-antivirus-alert-vulnerabledriver-winnt-winring0)).
- **Fix:**
  - A first-run consent screen explains that PawnIO is a vendor-signed kernel driver installed from the official site, requires ≥ 2.1.0, and is not uninstalled by Nexum because other apps may use it. `[Verified]` (V6): the 2.2.0 `PawnIO_setup.exe` is Authenticode-signed by `namazso.eu` through GLOBALTRUST, so it runs under Smart App Control. Test against 2.2.0, the current release, because LHM 0.9.6 ships PawnIO modules updated "to 2.2" ([LHM #2174](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/pull/2174)); keep 2.1.0 as the floor only if the 2.2 modules load on a 2.1.0 driver in that test.
  - "No kernel driver" mode is a first-class choice (vendor GPU APIs, WMI, SMART where available), not an error banner.
  - The agent compares `PawnIo.Version` (already logged) with 2.1.0.
  - A CI step fails if `WinRing0*.sys`, `inpout*.sys` or `OpenHardwareMonitorLib.sys` appears anywhere in the publish output.
  - Fix DESIGN-SPEC §6.3, which still says "WinRing0".

### MF-4 Cleaner: honest defaults, honest words (M)
- **Evidence:**
  - Microsoft's PUA criteria name "exaggerated claims about your device's health" and "misleading or inaccurate claims about files" ([Microsoft Learn](https://learn.microsoft.com/en-us/defender-xdr/criteria)).
  - Smart App Control blocks apps the cloud considers potentially unwanted even when they are signed ([Microsoft](https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003)).
  - Memory optimizers are "useless at best and harmful at worst" ([How-To Geek](https://www.howtogeek.com/171424/why-memory-optimizers-and-ram-boosters-are-worse-than-useless)).
  - Defender flagged CCleaner as a PUA ([BleepingComputer](https://www.bleepingcomputer.com/news/microsoft/microsoft-now-detects-ccleaner-as-a-potentially-unwanted-application/)).
  - Deleting shader caches brings back compile stutter (community and vendor-forum evidence: [NVIDIA forum](https://forums.developer.nvidia.com/t/pre-compiled-shader-cache-cleaned-by-nvidia-driver-causing-stutter-when-launching-vulkan-apps/336196.md)).
- **Defaults** in `make_category()` (`src-tauri/src/cleaner.rs` ~line 1330, which today enables everything except Browser and Standby):

  | Category | Default | Change |
  |---|---|---|
  | `temp` | ON | keep the 24 h age guard |
  | `wu-cache` | ON (admin only) | keep the 24 h guard. **Add:** skip `SoftwareDistribution\Download` entirely while an update is pending a reboot or being installed. Microsoft's own forum guidance is to delete it only "after you have installed all the pending updates" and with `wuauserv`/BITS stopped (forum-level evidence: [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/785704/c-windowssoftwaredistributiondownload-taking-up-to)); Nexum must not stop services itself. **Change:** clear the Delivery Optimization cache through Microsoft's documented `Delete-DeliveryOptimizationCache` cmdlet (keeps pinned files by default, [Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/deliveryoptimization/delete-deliveryoptimizationcache)) instead of deleting files under the NetworkService profile directly, which `cleaner.rs` does today (~line 336). |
  | `logs` | ON (admin only) | now only the WER queue and archive, plus CBS logs older than 30 days. **Prefetch removed entirely.** |
  | `dumps` (new id, split out of `logs`) | **OFF** | Minidump keeps the newest 5 and anything under 30 days old. `MEMORY.DMP` is listed separately with its own toggle. Link: "Open Reliability Monitor" (`perfmon /rel`). |
  | `shader` | **OFF** | Description: "Only clear if a game shows corrupted graphics. Expect stutter while caches rebuild." Name only the detected GPU vendor's folders (design-test #17). |
  | `recycle` | **OFF** | v1.1 adds "only items deleted more than N days ago", following Storage Sense ([Microsoft](https://support.microsoft.com/en-us/help/5000679)) |
  | `browser` | OFF | **Add:** skip a browser's (or Discord's) cache while that app is running, and report it as "skipped: <app> is open" rather than silently skipping locked files (engineering rule; the current cleaner has reparse-point and locked-file guards but no running-process check). |
  | `standby` | **removed** | see C5 |
- **Behaviour:**
  - Without admin, admin-only categories get `available:false`, are switched off, and are **excluded from the headline**: "3.5 GB now · 1.35 GB more as administrator" (design-test #5). This keeps the README's "dry run = real run" promise.
  - With `confirmBeforePurge=false`, F9 runs only the default-ON set, never Recycle Bin, Browser or Dumps.
  - Each purge writes an audit log, `%LOCALAPPDATA%\Nexum\purge-logs\<ts>.jsonl` (path, bytes, mtime, result, reason), with a "View log" link in the summary.
- **Words:**
  - The top-bar button becomes "Clean caches (F9)" in a ghost style, not a permanent gold CTA.
  - "Trash" and "junk" become "Reclaimable caches"; "Deep Purge" becomes "Cache cleanup".
  - "Freed" is used only for disk bytes.
  - Banned in UI copy: *boost, optimize, free RAM, junk, trash, speed up*.
- **Contract (breaking, pre-1.0):**
  - Remove sidecar `{ "cmd": "flushStandby" }`, Tauri `flush_standby`, the `purge_trash` arg `flushStandby`, `Settings.flushStandbyOnPurge`, `PurgeResult.standbyFlushed` and `PurgeResult.standbyMessage`, and the category id `standby`.
  - Add the category id `dumps`.
  - `TrashCategory` gains `available: boolean` and `unavailableReason: "needsAdmin"|null`.
  - `PurgeResult` gains `logPath: string`.
  - CONTRACT §3 rule 7 becomes: "Crash dumps: keep newest 5 and < 30 days; no Prefetch."

### MF-5 Drivers: age is information; only real problems are red (S)
- **Evidence:** driver updaters "almost universally function as deceptive scareware" ([How-To Geek 2026](https://www.howtogeek.com/stop-installing-driver-updaters-on-your-windows-pc/)), and one reported 14 "ancient" drivers on a fresh OS ([How-To Geek](https://www.howtogeek.com/198758/never-download-a-driver-updating-utility-theyre-worse-than-useless/)). Nexum's `OUTDATED_DAYS = 1095` rule (`drivers.rs:12`) drives a red "OUTDATED 5" tile.
- **Fix:**
  - Status becomes `ok | unsigned | problem`. `problem` means `Win32_PnPEntity.ConfigManagerErrorCode ≠ 0`.
  - Age becomes a neutral grey column.
  - Microsoft in-box drivers are flagged `isInbox`.
  - Sort problems first, group identical rows ("Processor × 16"), and hide the Category column below 1440 px (design-test #6, #15).
  - Add a Gigabyte entry to `PORTALS` (`driverUtils.ts`) and the text "Nexum never installs drivers."
- **Contract (breaking):** `DriverInfo.status: "ok"|"unsigned"|"problem"` (v1.1 adds `"vulnerable"`), plus `problemCode: number|null` and `isInbox: boolean`. Remove the comment "outdated = date older than 3 years".

### MF-6 Remove invented metrics and stop the status pill claiming "Optimal" (S)
- **Evidence:** "Thermal & Load Index 46%" has no definition, and "SYNCED / OPTIMAL" ignores drive health (press-general S6, design-test #1, reference §3). Both match the "exaggerated claims" criterion ([Microsoft Learn](https://learn.microsoft.com/en-us/defender-xdr/criteria)).
- **Fix:**
  - The header pill follows documented rules, shown on hover:
    - **Optimal:** agent connected and elevated, no sensor above its threshold, every drive `good`.
    - **Attention:** any amber condition.
    - **Critical:** any rose condition.
    - **Partial sensors:** limited mode.
  - Replace the Thermal & Load Index card with a **Health alerts** card listing each active condition, or "No active alerts" with the rule text.

### MF-7 Fix the LHM history memory growth (S)
- **Defect** (reference §0.5): LHM `Sensor` keeps one day of history by default (`_valuesTimeWindow = TimeSpan.FromDays(1.0)`, trimmed with `List.RemoveAt(0)`) ([Sensor.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Sensor.cs)). Nexum never sets `ValuesTimeWindow`.
- **Fix:** after `Open()` and on `HardwareAdded`, set `sensor.ValuesTimeWindow = TimeSpan.Zero` for every sensor. Min/Max still work. Add a 24 h soak test that records the agent's working set (pass if growth < 10 MB).

### MF-8 Sign everything that runs; no user-writable code paths (M)
- **Evidence:** Microsoft says to sign "all binaries, such as exe, dll, temp installer files, scripts, and uninstallers" ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/smart-app-control)).
- **Native library extraction:**
  - `NexumAgent.csproj` sets `IncludeNativeLibrariesForSelfExtract=true`. On Windows, files are then extracted under `%TEMP%/.net`.
  - Microsoft warns: "To prevent tampering, these directories shouldn't be writable by users or services with different privileges" ([.NET single-file docs](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview)).
  - The elevated agent therefore loads DLLs from a user-writable folder, and Nexum's own Temp cleanup can delete them.
- **Fix:**
  1. Set `IncludeNativeLibrariesForSelfExtract=false`. The runtime's native DLLs (Microsoft-signed) then ship next to `nexum-agent.exe` in Program Files.
  2. Sign the NSIS **uninstaller and plugin DLLs**. Tauri supports a custom `signCommand` ([Tauri docs](https://v2.tauri.app/distribute/sign/windows/)), and tauri-bundler has signed the uninstaller since 1.4.0 ([changelog](https://v2.tauri.app/release/tauri-bundler/v1.4.0/)). The real gap is the stock NSIS plugins (`System.dll`, `nsDialogs.dll`, `StartMenu.dll`, `NSISdl.dll`), which the installer extracts to `%TEMP%` at install time and which were embedded **unsigned** until tauri-bundler 2.9.3 ([changelog](https://v2.tauri.app/release/tauri-bundler/v2.9.3/)). Microsoft lists "temp installer files" among what must be signed for SAC ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/smart-app-control)). `package.json` pins `@tauri-apps/cli` only to `^2.1.0`: raise the floor to `>=2.9.3` and commit the lockfile. CI runs `Get-AuthenticodeSignature` on every PE under the bundler's `Plugins/x86-unicode/` output and on every installed PE, including `uninstall.exe`, and fails on anything not `Valid`. Switch `bundle.targets` to `msi` (uninstalled by Microsoft-signed `msiexec`) only if that check cannot be made to pass.
  3. Update `docs/SIGNING.md`: it lists `.msi` while `tauri.conf.json` builds only `nsis`.
  4. Publish SHA-256 hashes with every release. The CPUID breach is the example: trojanized downloads were served while "CPUID's signed original files were not compromised" ([Tom's Hardware](https://www.tomshardware.com/tech-industry/cyber-security/hwmonitor-and-cpu-z-developer-cpuid-breached-by-unknown-attackers-cyberattack-forced-users-to-download-malware-instead-of-valid-apps-for-approximately-six-hours)).
  5. **SignPath eligibility comes before v1.0, not after.** SignPath Foundation requires that "the project must already be released in the form that should be signed" and, for executables, "a certain verifiable reputation" ([SignPath terms](https://signpath.org/terms)). A first-ever release cannot assume it will be signed. Plan: publish tagged source and unsigned preview builds (clearly labelled "preview, unsigned, will not run with Smart App Control on") to earn the release history, then apply. The owner cannot run unsigned builds on a SAC-on machine, so test those builds in a VM. If the application is delayed, the fallback is Microsoft's Artifact Signing (formerly Trusted Signing; Basic tier, 5,000 signatures/month, [pricing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)), but identity-validation eligibility for individuals must be confirmed first (Q12).
  6. **SignPath project hygiene** (same terms): MFA on GitHub and SignPath for every team member; a page titled "Code signing policy" on the project home page and the releases page, listing the signing provider, the team roles and a privacy statement (the default "This program will not transfer any information to other networked systems" fits MF-11); no proprietary component in the package. PresentMon (MIT) and LHM (MPL-2.0, per its source headers) are OSI-licensed. AMD's ADL runtime `atiadlxx.dll` is loaded from the installed driver and never shipped; Nexum ships only the MIT ADL headers' definitions. Treating the driver DLL as a GPL-3.0 §1 "System Library" is our reading, so state it in the SignPath application.
  7. **Never re-sign third-party binaries.** SignPath allows *including* unsigned upstream OSS binaries, but the owner's SAC setting does not tolerate unsigned code, so every shipped third-party PE must already carry its vendor's signature (PresentMon: Intel, V1). The single-file agent bundle embeds LHM and its managed dependencies inside the signed `nexum-agent.exe`; after item 1, CI lists every loose file in the install folder and fails on any PE that is not `Valid`.

### MF-9 Wrong labels and the misleading chart (S)
- **Defects** (reference §0.8, design-test #9, #10, #13, #14):
  - "Per-thread load · 8 logical" is really per physical core.
  - "Avg Fan" averages CPU, pump and case fans.
  - The live chart is a *stacked* area that reaches "200%".
  - GPU "CORE 36 °C" is easy to confuse with the core clock.
  - The BIOS vendor shows as "AMERICAN MEGATRENDS , LLC", and the board model is missing.
  - Uptime appears twice with different values.
- **Fixes:**
  - "Per-core load (8C/16T)".
  - Remove the averaged fan RPM; the KPI says "CPU fan".
  - Unstacked lines on a labelled 0–100% axis, with no-data series hidden.
  - "Edge temp" plus a "Zero-RPM idle" badge.
  - Strip `,? LLC` and alias to "AMI", and show "Gigabyte B550 GAMING X".
  - Show uptime once.
  - Show "2 of 4 DIMMs" without invented slot positions.
  - CPU clock uses LHM "Cores (Average Effective)".
  - Document in CONTRACT §1.1 that `cpu.loadPerCore` is per *physical* core.

### MF-10 Layout at 1280×800, three fans, clipped columns (S)
- From design-test #6, #7, #8, #16, #17:
  - Drivers table: nowrap date column, INF moved to the detail panel, Category hidden below 1440 px.
  - Fans grid: `min(fanCount, 4)` columns.
  - Dashboard columns: a bottom fade mask plus a visible thin scrollbar, with space reclaimed by removing the Hardware Snapshot grid.
  - Shorter KPI sub-labels below 1440 px.
  - Sticky "Ready to clean" footer in the Cleaner.

### MF-11 Make "no telemetry, no network" verifiable; publish what Nexum will never do (S)
- **Evidence:**
  - CCleaner's monitoring re-enabled itself after a restart ([ghacks](https://www.ghacks.net/?p=146239)).
  - Avast was fined $16.5M over browsing data sales ([FTC](https://www.ftc.gov/news-events/news/press-releases/2024/06/ftc-finalizes-order-avast-banning-it-selling-or-licensing-web-browsing-data-advertising-requiring-it)).
  - Microsoft does not support registry cleaners ([KB2563254](https://support.microsoft.com/kb/2563254)).
- **Fix:**
  - A CI test greps the Rust, C# and frontend sources for HTTP clients, `fetch(`, `reqwest` and `HttpClient`, and fails on any unapproved use.
  - Add `SECURITY.md` with: a reporting address; supported versions; the privileged surface (the elevated agent and the stdio protocol); and the list of things Nexum will never do (registry cleaning, driver downloads or installs, process injection, telemetry, bundled offers, auto-updaters that run downloaded installers, localhost web APIs).
  - Copy the "never" list into the README.

### MF-12 Public-repo hygiene (S)
- `docs/target-hardware.md` contains the real machine's hostname. It is listed in `.gitignore` and has **never been committed** (verified 2026-11-27: `git log -p --all` has 0 matches), so nothing is exposed. Keep it local-only.
- Keep generic hostnames and fake serials in `lib/mock.ts` profiles. Mask serials by default in any export or report.
- Re-render the README screenshots with `?rig=owner` (3 fans, worn drive) after MF-1 to MF-10, so they show the realistic case instead of a 6-fan workstation.
- Q2 is resolved: no history rewrite is needed because the file was never pushed.

### MF-13 Fan control fail-safe (M) — added by the critic pass
- **Defect** (shipped v1.0 code, missed by all six reports):
  - CONTRACT §2 presets are fixed duty cycles ("silent 30%, balanced 50%, turbo 100%"), applied to every controllable header including the CPU fan, with no temperature input. A gaming load under "Silent" keeps the CPU fan at 30%.
  - CONTRACT says the sidecar restores BIOS control "on stdin EOF / process exit". A hard kill, a crash or a hang runs no exit handler. In LHM 0.9.6 the IT87 driver keeps the original PWM registers only in process memory (`_initialFanPwmControl`, `_restoreDefaultFanPwmControlRequired`), and on Gigabyte boards it calls `_gigabyteController.Enable(false)` before writing and only restores that controller once every fan has been restored in the same process ([IT87XX.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Motherboard/Lpc/IT87XX.cs)). On the reference rig (Gigabyte B550, IT8688E) a killed agent can therefore leave the fans at the last manual duty with the board's own fan controller off. A new agent cannot restore them, because it would read the manual values as the "defaults".
- **Fix:**
  - **Thermal override in the agent**, evaluated every poll whatever the preset: if CPU Tctl/Tdie ≥ 85 °C, or a sensor is missing while manual control is active, drive every controlled header to 100% until 10 °C below the trigger. The 85 °C trigger comes from the per-model table of the v1.1 alert engine (Q9).
  - **Write-ahead flag:** before the first manual write, the agent writes `%ProgramData%\Nexum\fan-manual.flag` (ACL as in §5.2.3) and deletes it after `SetDefault()` succeeds.
  - **Watchdog in Rust:** if the agent exits abnormally while the flag exists, restart it once and set every controllable header to 100%, then show a rose banner: "Fan control was interrupted. Fans are at 100% for safety. Restart the PC to return them to BIOS control." On the next Nexum start, if the flag exists, show the same banner.
  - `fanPreset:"auto"` stays the default, and the presets get a "Fixed speed, ignores temperature" subtitle until v1.2 curves replace them.
  - **Test:** on the reference rig, `taskkill /F` the agent under each preset and record what the headers do, and whether a warm reboot or only a cold power cycle restores BIOS control. Write the result into CONTRACT §2.

---

## 3. Feature roadmap

### v1.0: ship now (MF-1 to MF-12, plus the items below)

| Item | What | Why (evidence) | Effort | Depends on | Contract changes |
|---|---|---|---|---|---|
| **Sensors view (F2)** | Full LHM tree (Motherboard → ITE IT8688E, CPU, DIMMs, GPU, drives). Columns: Value / Min / Max / Avg / 60 s sparkline. Reset all or selected rows; search; "Hide unused" (0-RPM headers, 0 V rails); inline rename (F2 or double-click), hide, pin to Dashboard. Virtualized rows with rAF-batched updates. | Session min/max/avg with reset is the #2 reviewer-cited feature ([TH GPU temp](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature), [TH CPU temp](https://www.tomshardware.com/how-to/how-to-check-cpu-temp-temperature)). LHM already provides `Min/Max/ResetMin/ResetMax` and B550 GAMING X labels ([SuperIOHardware.cs](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/blob/v0.9.6/LibreHardwareMonitorLib/Hardware/Motherboard/SuperIOHardware.cs)). Today Nexum only has a 2-minute peak. | M | MF-7 | NDJSON out: `sensorTree {rev, sessionStartTs, hardware: HardwareNode[]}`, `sensorValues {ts, rev, value[], min[], max[], avg[]}` (arrays indexed by `SensorMeta.idx`, `null` = n/a). NDJSON in: `{cmd:"sensorTree"}`, `{cmd:"sensorStream", on}`, `{cmd:"sensorReset", ids: string[]\|null}`. Tauri: `get_sensor_tree`, `set_sensor_stream {on}`, `reset_sensor_stats {ids}`. Events: `sensor-tree`, `sensor-values`. TS shapes `SensorMeta {id, idx, hwId, name, kind, unit, decimals, static, defaultHidden}`, `HardwareNode {id, parentId, kind, name, sensors}` exactly as in the reference study. Values stream only while the view is visible. |
| **Labels and pins** | User labels keyed by the LHM identifier, applied everywhere (FanCard, FanList, Sensors, later CSV and the tray). Do **not** use `ISensor.Name`, because the sidecar's mappers look sensors up by name. | The reference rig shows "FANIN2/FANIN3". HWiNFO allows renaming any label ([forum](https://www.hwinfo.com/forum/threads/rename-labels.1178)). | S | Sensors view | `Settings` gains `sensorLabels: Record<string,string>`, `sensorLabelMeta: Record<string,{defaultName:string, hardwareName:string}>`, `hiddenSensors: string[]`, `pinnedSensors: string[]` (default: CPU Tctl/Tdie, GPU Hot Spot, VRM MOS, system-drive temperature), `hideUnusedSensors: true` |
| **Dashboard slim-down** | Keep the KPI strip and the live chart. Replace the Hardware Snapshot grid with **Pinned sensors**, the Thermal & Load Index with **Health alerts**, and remove `DriverStatusList`. System & BIOS shrinks to 3 lines with a "System →" link. | design-test #10 (the same reading appears in up to 3 places and disagrees); reference §3 | S | MF-1, MF-6 | none |
| **System view, lite (F3)** | Tabs CPU / Mainboard / Memory / SPD / Graphics / OS & Security. v1.0 contents: CPU name, socket, family/model/stepping, cache table (`GetLogicalProcessorInformationEx(RelationCache)`); board, BIOS and Super I/O name; memory type (`SMBIOSMemoryType` 26 = DDR4), size, channels, per-DIMM manufacturer/part/ranks/configured speed/voltage (`Win32_PhysicalMemory`); OS & Security (moved from Drivers). "Copy as text". | CPU-Z parity ([cpuid.com](https://www.cpuid.com/softwares/cpu-z.html)). Sources need no driver: [CACHE_RELATIONSHIP](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-cache_relationship), [Win32_PhysicalMemory](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-physicalmemory) | M | – | NDJSON `{cmd:"spec"}` → `{type:"spec", ...SystemSpec}`. Tauri `get_system_spec` (cached, re-queried on F5). `SystemSpec` as in the reference study §4.3; in v1.0, `memory.timings` is `null` with `timingsSource:"unavailable"`, and `xmp` is `null`. |
| **S.M.A.R.T. details drawer** | A per-drive drawer: spare vs threshold, % used, media errors, unsafe shutdowns, power cycles, warning/critical temperature time, and HDD 05/C5/C6. Drive temperature Min/Max. | The 44% drive. Windows only monitors NVMe ([Microsoft](https://support.microsoft.com/en-us/topic/what-to-do-about-a-critical-warning-for-a-storage-device-258e0042-e091-277d-5fa6-3c710fba70d7)). PCMag: a bare OK/Fail status "can be misleading" ([PCMag](https://www.pcmag.com/how-to/check-your-hard-drives-health)). | S | MF-1 fields | none beyond MF-1 |
| **Self-usage readout** | Status-bar text such as "Nexum 0.6% CPU · 142 MB", summing Nexum.exe, nexum-agent and its WebView2 children. | The <1.5% claim should be checkable. The anti-iCUE/Armoury Crate positioning ([TH ranking](https://www.tomshardware.com/peripherals/gaming-peripheral-apps-ranked-from-worst-to-worst)). | S | – | Event `self-usage {ts, cpuPct, workingSetMb, processCount}` every 5 s (Rust, `sysinfo`-style process query) |
| **Keymap** | F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F9 Clean caches; `Ctrl+1..7`. Update the README, the footer hints and the tray menu. | C2 | S | – | `ViewId = "dashboard"\|"sensors"\|"system"\|"storage"\|"cooling"\|"drivers"` (`"fans"` → `"cooling"`; `"cleaner"` stays as a modal plus a page; `"gaming"` added in v1.1) |

### v1.1

| Item | What | Why (evidence) | Effort | Depends on | Contract changes |
|---|---|---|---|---|---|
| **FPS capture + Gaming view (F8)** | See §4. Opt-in. Hero FPS, P1/P0.1, frametime chart, CPU-busy vs GPU-busy, present-mode badge, target picker. A 6th KPI card appears only while a game is detected. | Frame-time capture is the press standard (built on PresentMon: [TH](https://www.tomshardware.com/features/gpu-tests)). HWiNFO does it without injection ([v7.64](https://www.hwinfo.com/forum/threads/hwinfo-v7-64-released.9219)). | L (8–11 d) | MF-8 CI pattern | §4.2 |
| **CSV sensor logging** | Start/stop, 1/2/5/10 s interval, row counter, "Open folder". Writes to `Documents\Nexum\Logs\nexum-YYYYMMDD-HHMMSS.csv`; header `Date,Time,<Hardware> \| <label> [unit]`; flush every 10 rows. | #3 reviewer feature ([TH](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature)). HWMonitor added it in 1.62 ([cpuid](https://www.cpuid.com/softwares/hwmonitor.html)). | S | Sensors view | Tauri `start_sensor_log {intervalMs, ids: string[]\|null}` → `SensorLogStatus {active, path, rows, startedTs, intervalMs, sensorCount}`; `stop_sensor_log`; event `sensor-log`. `Settings.sensorLogIntervalMs: 1000` |
| **Alert engine + notifications + tray** | Move rule evaluation to Rust (`alerts.rs`) so the tray and Windows notifications work while minimized. Alerts fire on *sustained* readings (default 60 s), never on spikes. CPU limits come from a per-model table, not a global 85 °C (Ryzen limits differ by model: [TH 5800X3D](https://www.tomshardware.com/reviews/amd-ryzen-7-5800x3d-review/3)). Defaults for drive life (50%) and free space (10%). The tray tooltip shows the pinned sensors; optionally the tray icon shows the hottest temperature (Core Temp-style, [PCMag](https://www.pcmag.com/how-to/how-to-monitor-your-cpu-temperature)). | Threshold alerts are an under-served gap (press-hw §A12, §E10). DESIGN-SPEC §9 already lists alert rules. | M | MF-1, MF-6 | Event `health-alerts` → `HealthAlert[] {id, severity:"warn"\|"crit", source:"drive"\|"cpu"\|"gpu"\|"agent"\|"space"\|"security", title, detail, sinceTs, sensorId:string\|null}`. Tauri `get_health_alerts`, `dismiss_alert {id}`. `Settings.alerts {enabled:true, desktopNotifications:false, cpuTempC:number\|null /* null = model default */, gpuHotspotC:number\|null, gpuMemJunctionC:number\|null, driveLifePct:50, freeSpacePct:10, sustainSec:60}`, `Settings.dismissedAlerts: string[]`. Uses `tauri-plugin-notification`. |
| **Drive wear ledger + forecast** | A daily snapshot per drive serial in `%LOCALAPPDATA%\Nexum\history\drives.jsonl`. Projects TB written per month and the months until 10% life remains. | Turns % life into a decision ([TH SSD health](https://www.tomshardware.com/how-to/check-ssd-health-windows-10-11)). | S | MF-1 | Tauri `get_drive_history {serial}` → `{points: {date, healthPct, dataWrittenTb, powerOnHours}[], forecast: {tbPerMonth:number\|null, monthsTo10Pct:number\|null}}` |
| **Kernel-driver and platform security audit** | On the Drivers page: flag known-abused drivers (WinRing0/OpenHardwareMonitorLib.sys, gdrv.sys, NTIOLib_X64.sys, AsIO*, RTCore64.sys), matched by hash against Microsoft's blocklist ([recommended block rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/microsoft-recommended-driver-block-rules)) **bundled as release data, not downloaded**. Read-only platform status: vulnerable-driver blocklist, Memory Integrity, Smart App Control, Secure Boot, each with a `windowsdefender://` link. Nexum never changes them. Gigabyte check: WPBT ACPI table present, or `System32\GigabyteUpdateService.exe` present → advise disabling "APP Center Download & Install" ([Eclypsium](https://eclypsium.com/blog/supply-chain-risk-from-gigabyte-app-center-backdoor/)). Vendor utilities below their fixed versions: GIGABYTE Control Center < 25.12.10.01 ([GIGABYTE](https://www.gigabyte.com/Support/Security/2377)), MSI Center < 2.0.69.0 ([ZDI](https://zerodayinitiative.com/advisories/ZDI-26-430)). | A useful security feature in place of a fake "outdated" count. RobbinHood used signed gdrv.sys ([Sophos](https://www.sophos.com/en-us/blog/living-off-another-land-ransomware-borrows-vulnerable-driver-to-remove-security-software)). **Critic caveats:** (1) SignPath does not sign software with "features designed to identify or exploit security vulnerabilities" ([terms](https://signpath.org/terms)), and flagging CVE-bearing drivers and vendor utilities may fall under that clause. Get SignPath's written OK before building this (Q13); if they decline, ship only the read-only platform-status part. (2) Microsoft's blocklist is "enforced when either memory integrity … Smart App Control, or S mode is active" and is updated quarterly ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/microsoft-recommended-driver-block-rules)). On the reference rig (SAC on), listed drivers already cannot load, so report "installed but blocked" rather than raise an alarm. A list bundled at release time goes stale within a quarter, so show its date. (3) "Matched by hash" is too narrow: parse the rule types that the downloaded policy XML actually contains, and verify them against that XML before claiming coverage. | M | MF-5 | `DriverInfo.status` adds `"vulnerable"`. Tauri `get_security_audit` → `SecurityAudit {platform: {vulnerableDriverBlocklist:boolean\|null, memoryIntegrity:boolean\|null, smartAppControl:"on"\|"evaluation"\|"off"\|null, secureBoot:boolean\|null}, flaggedDrivers: {file, path, loaded:boolean, reason, cve:string\|null}[], firmware: {wpbtPresent:boolean, gigabyteUpdateService:boolean}, vendorUtilities: {name, version, fixedIn, cve}[], blocklistVersion:string}` |
| **System view, full** | Live DDR4 timings from the AMD UMC registers through LHM's public `PawnIo.AmdFamily17.ReadSmn` (`[Verified]` V4; read once at startup, admin only). The SMN index/data pair at PCI 0:0.0 offsets 0x60/0x64 is shared with every other tool that reads SMN (the PawnIO module has no lock of its own, [AMDFamily17.p](https://github.com/namazso/PawnIO.Modules/blob/main/AMDFamily17.p)), so take the same global PCI mutex that LHM's own AMD code takes, after confirming its name in LHM source, not an object-local `SyncRoot`. SPD timings from LHM `/memory/dimm/n` (`[Verified]` V4): these are JEDEC base minimums **in ns**, so convert them to cycles at the JEDEC speed and label them "SPD JEDEC", never as the running or XMP timings. A DIMM temperature appears only if the module has a thermal sensor; FCLK/UCLK; codename; GPU link through the LHM ADL report (the endpoint DEVPKEY wrongly reports Gen5 on RDNA cards, which sit behind an on-board switch); NVMe link speed; Save report (.txt/.html). | CPU-Z Memory/SPD parity. Register map: [ZenStates-Core DDR4Dictionary.cs](https://github.com/irusanov/ZenStates-Core/blob/master/Dictionaries/DDR4Dictionary.cs) (GPL-3.0). ZenTimings itself moved to PawnIO ([release](https://newreleases.io/project/github/irusanov/ZenTimings/release/v1.36-beta-2)). | M | v1.0 System lite, MF-3 | `SystemSpec.memory.timings {cl, rcdRd, rcdWr, rp, ras, rc, rfc, rrds, rrdl, faw, commandRate, gearDown}`, `timingsSource:"umc"`, `dimms[].spd {...}`, `gpus[].link {gen, width, maxGen, maxWidth, source:"adl"\|"devpkey"\|"unknown"}`, `diskLinks[]`. Tauri `save_report {format:"txt"\|"html"}` → path |
| **GPU tuning step 0: probe + read-only panel** | See §5. Cooling → "GPU tuning" tab shows ranges, current values, factory/custom state, power mode and the VPU-recovery count. | Proves whether ADL OD8 works on RDNA4 before any write code is written. | S–M | – | NDJSON in `{cmd:"tuningGet"}`, `{cmd:"tuningProbe", write:false\|true}`; out `tuningState` (§5.3). Tauri `get_tuning_state`, `run_tuning_probe {write}` |
| **Cleaner extras** | Drill-down showing the top 50 files per category (path, size, age, "Open folder"); a Recycle Bin age filter. | Visible proof that the dry run matches the real run; follows the Storage Sense model ([Microsoft](https://support.microsoft.com/en-us/help/5000679)) | S | MF-4 | Tauri `scan_trash_details {categoryId, limit}` → `{path, bytes, modifiedTs}[]`. `scan_trash {includeBrowser, recycleMinAgeDays: number\|null}` |

**v1.1 status (CONTRACT 1.1.0, 2026-11-27).** One line per row above; the decisions in the table are unchanged.
"In v1.1" means implemented in the 1.1.0 round and checked by CI; the release still waits for the §4.3 on-rig gates.

- **FPS capture + Gaming view (F8):** in v1.1. Opt-in, Intel-signed PresentMon 2.6.0 pinned in `.github/presentmon.json` (SHA-256 re-verified against the GitHub asset digest and a local download on 2026-11-27: `b2a706bc…88f1af`, Authenticode Valid, `CN=Intel Corporation`), shipped via `bundle.resources`, never re-signed. The 6th Dashboard KPI is in. §4.3 gates 1 (overhead), 2 (anti-cheat matrix: every title "not tested yet" in the README) and 3 on the reference rig are still open; CI covers gate 3 on a runner and gate 4 by design. Overlay and benchmarks stay in v1.2.
- **CSV sensor logging:** in v1.1 (CONTRACT §2.9; adds 100 MiB rotation and a tray menu item).
- **Alert engine + notifications + tray:** in v1.1 (sustained evaluation, per-model CPU limits re-checked on amd.com 2026-11-27, see [`TJMAX-CHECK.md`](TJMAX-CHECK.md); opt-in notifications; tray tooltip with up to 4 pinned sensors). Deferred: the optional tray-icon temperature digits (not in v1.1). Not added on purpose: `alerts.enabled` and `alerts.driveLifePct` (CONTRACT §2.2 explains why).
- **Drive wear ledger + forecast:** in v1.1 (CONTRACT §2.11).
- **Kernel-driver and platform security audit:** deferred, blocked on Q13 (whether SignPath counts it as a vulnerability-identification feature). Not started.
- **System view, full:** in v1.1. Live DDR4 timings under the `Global\Access_PCI` mutex that LHM 0.9.6 itself uses (confirmed in the 0.9.6 binary), SPD JEDEC fallback labelled as such, MEMCLK/FCLK/UCLK, codename, GPU PCIe and drive links, Save report (.txt/.html). Still to confirm on the reference rig: the LHM ADL link lines and the "Fabric Clock"/"Uncore Clock" sensor names (`nexum-agent --dump`).
- **GPU tuning step 0: probe + read-only panel:** in v1.1, read-only only (`tuningGet`, `tuningProbe write:false`, Cooling → GPU tuning tab; CI blocks any ADL `_Set` entry point). Deferred: the probe's `write:true` path, waiting for the owner's consent (Q5); both the agent and Rust reject it.
- **Cleaner extras:** in v1.1 (top-50 drill-down per category; Recycle Bin age filter 1/14/30/60 days, default 30, current user's bin only).

### v1.2+

| Item | What | Why | Effort | Depends on | Contract changes |
|---|---|---|---|---|---|
| **GPU tuning writes (AMD)** | Power-limit slider (driver minimum to 0%, with the positive range behind an "outside spec" toggle), AMD one-click Auto Undervolt, a 5-point GPU fan curve plus zero-RPM, Reset to AMD defaults, and a validation session. Full safety layer in §5. | Tom's Hardware's best RX 9070 XT tune was lower voltage plus a 110% power target ([TH](https://www.tomshardware.com/pc-components/gpus/undervolted-rx-9070-xt-beats-rtx-5080-rx-9070-and-9070-xt-models-with-heavy-coolers-have-massive-oc-headroom)) | L | v1.1 probe passes | §5.3 |
| **Overlay window** | A transparent, click-through, top-most Tauri window showing FPS, P1 and frametime (optionally temperatures) at ≤ 4 Hz. Hotkey toggle and per-exe deny-list. Self-diagnosis: hide under exclusive fullscreen, and warn if a game drops from Independent Flip to Composed. | press-hw §E4. Out-of-process overlays avoid the anti-cheat and DRM failures of injected ones ([TH](https://www.tomshardware.com/features/gpu-tests); [Microsoft DirectX blog](https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/)) | M | FPS capture | §4.2 `set_overlay` |
| **Benchmarks** | Record N seconds of raw frametimes to `Documents\Nexum\Benchmarks\*.csv` plus a summary JSON; compare runs; mark PSO-compile stutter (PresentMon 2.6.0 metric, [release notes](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0)). **Caveat:** the release notes describe it as **D3D12-only** ("Track D3D12 pipeline state object compilation via ETW"), and the console README lists no flag or column for it, so check that the 2.6.0 console CSV has these columns before promising the feature. Vulkan and DX11 titles get no PSO marks. | NZXT CAM's per-game history is singled out ([PC Gamer](https://pcgamer.com/nzxt-cam-31-review)) | M | FPS capture | §4.2 `benchmark`, `start_benchmark`/`stop_benchmark` |
| **Long-term history** | A low-rate store (1-minute buckets for 7 days, then daily min/max/avg for 1 year) in `%LOCALAPPDATA%\Nexum\history\` with an idle-temperature trend ("clean or repaste?") and before/after comparisons. | "Most utilities do not support long-term temperature logging" ([TH](https://www.tomshardware.com/how-to/how-to-check-cpu-temp-temperature)) | M | Sensors view | Tauri `get_history {sensorIds: string[], fromTs, toTs, bucket:"1m"\|"1h"\|"1d"}` → `{sensorId, points:{ts, min, max, avg}[]}[]`. `Settings.historyEnabled: true`, `historyRetentionDays: 365` |
| **Session throttle verdict** | After a game session, a card such as "GPU averaged 2.95 GHz, no thermal limit; CPU at its thermal limit for 4 min". This automates Tom's Hardware's manual method ([TH](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature)). | press-hw §E2 | M | FPS capture, history | Event `session-summary {pid, process, startTs, endTs, fpsAvg, fpsLow1, cpuAvgClockMhz, gpuAvgClockMhz, cpuSecondsAtLimit, gpuHotspotMaxC, verdict:string[]}` |
| **Motherboard fan curves, including GPU-temperature sources** | A per-header curve driven by any sensor (CPU Tctl, GPU Hot Spot or Memory Junction, max-of), with hysteresis and response time. Handles 3-pin DC headers. BIOS control is restored on exit, as today. | Fan Control is the only tool that does this today ([How-To Geek via Yahoo](https://tech.yahoo.com/computing/articles/control-pcs-fans-open-source-220018325.html)). Some boards control only 4-pin fans ([PCMag](https://www.pcmag.com/how-to/fix-a-noisy-computer-fan)). | L | Sensors view, labels | NDJSON in `{cmd:"fanCurve", id, sourceIds: string[], mode:"max"\|"avg", points:{tempC, pct}[], hysteresisC, responseSec}` (only after the guards pass: monotone curve, ≥ 50% at 80 °C, 100% at 90 °C). `fanPreset` gains `"curve"`. |
| **Split privilege** | The UI runs asInvoker; the agent runs elevated through a scheduled task in Program Files; IPC uses an ACL'd named pipe (C3). | Least privilege. Elevated vendor-utility bugs: [MSI Center CVE-2024-37726](https://nvd.nist.gov/vuln/detail/CVE-2024-37726), [Armoury Crate CVE-2025-3464](https://www.securityweek.com/asus-armoury-crate-vulnerability-leads-to-full-system-compromise/) | L | – | No message changes; transport only. `AgentStatus.transport: "stdio"\|"pipe"` |
| **v1.3+ (unscheduled)** | Manual GPU voltage offset (floor −100 mV); NVIDIA power limit and fan through NVML (admin, not persistent across reboots: [NVML docs](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceCommands.html)); read-only CPU PBO/CO state; opt-in tuning re-apply at logon with a boot counter; opt-in read-only shared-memory feed (C6); XMP profile parsing; Nexum's own SignPath-signed ETW helper built from PresentData (MIT) to drop the third-party exe. SignPath requires that "your team must be the maintainers of all source code files", so the helper must be a visible GitHub fork of PresentMon, not vendored files ([terms](https://signpath.org/terms)). | – | M–L each | – | defined when scheduled |

### Not doing

| Item | Reason |
|---|---|
| Registry cleaning | Microsoft does not support it, and the damage "may not be repairable" ([KB2563254](https://support.microsoft.com/kb/2563254)) |
| Driver downloads, installs or an "update all" button | Driver updaters are scareware ([How-To Geek](https://www.howtogeek.com/stop-installing-driver-updaters-on-your-windows-pc/)), and ASUS DriverHub became a one-click RCE ([TH](https://www.tomshardware.com/tech-industry/cyber-security/flaw-in-asus-driverhub-makes-utility-vulnerable-to-remote-code-execution)). Links only. |
| RAM booster / standby-list flush | Snake oil ([How-To Geek](https://www.howtogeek.com/171424/why-memory-optimizers-and-ram-boosters-are-worse-than-useless)); see C5 |
| Prefetch cleaning | No benefit; Windows manages Prefetch itself (engineering judgment, no reviewer source) |
| "Game booster", process killing, priority tweaks | Snake oil, and it would touch game processes (anti-cheat risk) |
| RTSS integration, DLL injection or Present hooks for the overlay | Anti-cheat and DRM breakage ([Guru3D RTSS](https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download); [CapFrameX #423](https://github.com/CXWorld/CapFrameX/issues/423)) |
| uiAccess / `CreateWindowInBand` overlay over exclusive fullscreen | Undocumented API that needs an elevated uiAccess process ([PresentMon Capture App README](https://github.com/GameTechDev/PresentMon/blob/main/README-CaptureApplication.md)). The security cost is too high for an overlay. |
| Game Bar widget | Needs a separate UWP codebase, MSIX packaging and Store publication ([Microsoft](https://learn.microsoft.com/en-us/gaming/game-bar/guide/distribution)) |
| Any ADLX-based code | Licence incompatible with GPL-3.0 and SignPath (C4) |
| CPU Curve Optimizer / PBO / PPT writes over SMU | Undocumented SMU commands, idle instability ([CoreCycler](https://github.com/sp00n/corecycler)), not supported by AMD on X3D ([TH](https://www.tomshardware.com/news/curve-optimizer-heads-to-ryzen-master-for-zen-3-cpus)) |
| CPU multiplier OC on X3D, RAM OC, XMP toggles | Locked or BIOS-only ([TH 5700X3D review](https://www.tomshardware.com/pc-components/cpus/amd-ryzen-7-5700x3d-cpu-review)) |
| GPU VRAM OC / memory timings | Can *lower* FPS through error retries ([TechSpot](https://www.techspot.com/news/107110-undervolted-radeon-rx-9070-xt-beats-rtx-5080.html)) |
| AMD TDC limit | ADLX itself says "not currently implemented in a production application" (oc report, ADLX header; `[Unsourced]`: no URL was given, so cite the header line or drop the quote. The decision stands regardless, since Nexum uses no ADLX code) |
| WinRing0 or any bundled kernel driver other than the user-installed PawnIO | CVE-2020-14979 ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2020-14979)); see MF-3 |
| Localhost HTTP/WebSocket API (DESIGN-SPEC §4) | DriverHub bug class ([mrbruh.com](https://mrbruh.com/asusdriverhub/)) |
| Auto-updater that downloads and runs installers | Same; users update from GitHub Releases using published hashes |
| Telemetry, accounts, cloud sync, bundled offers | [Microsoft PUA criteria](https://learn.microsoft.com/en-us/defender-xdr/criteria); the CCleaner history above |
| Startup App Manager (DESIGN-SPEC §9) | Duplicates Task Manager → Startup apps and drifts toward "speed up your PC" framing |
| Silently installing PawnIO | Kernel drivers require explicit consent (MF-3) |

---

## 4. FPS tracking: decision and architecture

**Decision:** build it, in v1.1, as an opt-in feature (`fpsCaptureEnabled: false` by default).

**Backend:** Intel's **unmodified, Intel-signed PresentMon console exe** (MIT), run by the elevated agent.
- No injection and no hooking. Intel says: "we are not doing any injection/detouring" ([PresentMon #144](https://github.com/GameTechDev/PresentMon/issues/144)).
- Rejected alternatives:
  - The PresentMon Service/SDK requires a user-installed service, and its MSI contains unsigned CEF files.
  - A forked PresentMon (CapFrameX style) would have to be re-signed. [SignPath terms](https://signpath.org/terms) allow signing a modified upstream only from a *visible fork* of an upstream that publishes signed builds. PresentMon qualifies, so a fork is permitted, not forbidden (corrected by the critic pass). It is still rejected: Nexum would then own the security fixes for an elevated ETW consumer and spend its own SmartScreen/SAC reputation on it. Shipping Intel's signed binary (`[Verified]` V1) avoids both.
  - ADLX FPS (C4).
  - RTSS (Not doing).

### 4.1 Architecture

```
Nexum.exe (Tauri, elevated in v1.0–1.1)
 └─ nexum-agent.exe (elevated)
     ├─ FrameMonitor.cs ── spawns resources\presentmon\PresentMon-2.6.0-x64.exe
     │     --output_stdout --no_console_stats --session_name NexumFrames --stop_existing_session
     │     --qpc_time_ms --no_track_input --exclude dwm.exe --exclude msedgewebview2.exe
     │     --exclude Nexum.exe --exclude nexum-agent.exe [+ user excludes]
     │     child in a Job Object (KILL_ON_JOB_CLOSE); CSV parsed BY HEADER NAME
     ├─ ForegroundTracker: GetForegroundWindow → PID every 500 ms (+ SHQueryUserNotificationState hint)
     └─ per-PID ring buffers → frameStats at 1 Hz (aggregated in C#; the UI never receives raw rows
        except a ≤1000-sample frametime batch)
```

- **Session lifetime:** the ETW session starts when Nexum launches with the feature enabled, **not** when a game starts. EA Javelin blocks *new* `StartTraceW` calls once the game is running ([PresentMon #573](https://github.com/GameTechDev/PresentMon/issues/573), [#740](https://github.com/GameTechDev/PresentMon/issues/740)).
- **Shutdown and orphans:** on shutdown the agent runs `--terminate_existing_session --session_name NexumFrames`. The fixed session name lets `--stop_existing_session` clean up orphans, as [StartTrace guidance](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-starttracew) recommends.
- **Packaging:**
  - Ship the exe through `bundle.resources` (not `externalBin`) with `licenses/PresentMon/LICENSE.txt` and `THIRD_PARTY.txt`.
  - CI downloads the pinned release, checks SHA-256 `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af`, and requires `Get-AuthenticodeSignature` Status `Valid` with a Subject starting `CN=Intel Corporation`.
  - The SignPath artifact configurations must never re-sign it.
  - At runtime the agent checks WinVerifyTrust and the signer before spawning it. If the check fails, the feature is disabled and `frameSession.state:"error"` is sent.
- **Elevation:** works today because the agent is elevated. The README says PresentMon "needs to be run by a user who is a member of the 'Performance Log Users' user group" and that without administrator rights "it will not have complete process information" ([PresentMon README](https://github.com/GameTechDev/PresentMon), `[Verified]`). After the v1.2 split, PresentMon stays inside the elevated agent. Nexum never edits group membership or `EtwMaxLoggers`.
- **Labelling:**
  - The headline number is "Rendered FPS (game)". The tooltip says AMD driver frame generation (AFMF) frames may not be counted (forum-level evidence only: [DSOGaming](https://www.dsogaming.com/articles/amd-driver-based-fluid-motion-frames-tech-completely-useless/)).
  - 1% lows are labelled "P1 / P0.1" with the definition in a tooltip, because tools define "1% low" differently ([CapFrameX](https://www.capframex.com/blog/post/Explanation%20of%20different%20performance%20metrics)).
  - Known limits shown in the tooltip, `[Verified]` against the [PresentMon README](https://github.com/GameTechDev/PresentMon): "GPU execution metrics are less accurate when running on a system that uses Hardware-Accelerated GPU Scheduling", with GPU-active about 0.5 ms high in its GPU-bound example. Runtime "Other" apps "have less instrumentation", so `CPUFramePacingStall` always reads 0 and CPU frame time is less accurate. Driver-generated frames are distinguished only with `--track_frame_type`, which "requires application and/or driver instrumentation using Intel-PresentMon provider" ([console README](https://github.com/GameTechDev/PresentMon/blob/main/README-ConsoleApplication.md)). Nothing shows that AMD's AFMF emits it, so keep the "may not be counted" wording.

### 4.2 Contract additions

Sidecar → Rust:
```jsonc
{ "type":"frameSession", "state":"starting"|"running"|"stopped"|"error", "backend":"presentmon-console",
  "backendVersion":"2.6.0", "signer":"Intel Corporation", "sessionName":"NexumFrames", "message":"..." }
{ "type":"frameTarget", "pid":18320, "process":"Game.exe", "windowTitle":"...", "reason":"foreground"|"manual"|"none",
  "runtime":"DXGI"|"D3D9"|"Other", "presentMode":"Hardware: Independent Flip", "fullscreenExclusive":false }
{ "type":"frameStats", "ts":0, "pid":0, "process":"", "windowSec":30, "fpsAvg":0, "fpsDisplayedAvg":null,
  "fpsLow1":0, "fpsLow01":null, "frametimeAvgMs":0, "frametimeP99Ms":0, "frametimeMaxMs":0,
  "cpuBusyMs":0, "gpuBusyMs":0, "boundBy":"gpu"|"cpu"|"balanced"|null, "displayLatencyMs":null,
  "droppedPct":0, "presentMode":"", "allowsTearing":true, "syncInterval":0, "frametimes":[] }
{ "type":"presentingList", "items":[{ "pid":0, "process":"", "windowTitle":"", "fps":0, "runtime":"", "presentMode":"" }] }
{ "type":"benchmark", "id":"", "pid":0, "process":"", "durationMs":0, "frames":0, "fpsAvg":0, "fpsLow1":0,
  "fpsLow01":null, "frametimeP99Ms":0, "csvPath":"" }                       // v1.2
```

Rust → sidecar:
- v1.1: `{cmd:"frames", enabled}`, `{cmd:"frameTarget", pid:number|null}`, `{cmd:"frameWindow", sec}` (clamped 5..120), `{cmd:"frameExclude", names:string[]}`, `{cmd:"presentingList"}`.
- v1.2: `{cmd:"benchmarkStart", durationSec:number|null}`, `{cmd:"benchmarkStop"}`.
- Existing `ack`/`error` messages are reused.

Tauri commands:
- `set_frame_capture {enabled}`
- `set_frame_target {pid}`
- `list_presenting_processes` → `PresentingProcess[]`
- v1.2: `start_benchmark {durationSec?}`, `stop_benchmark`, `set_overlay {enabled, corner:"tl"|"tr"|"bl"|"br", opacity, metrics:("fps"|"low1"|"low01"|"frametime"|"cpuTemp"|"gpuTemp"|"gpuLoad")[]}`

Events: `frame-session`, `frame-target`, `frame-stats`, and (v1.2) `benchmark-complete`.

Settings:
- `fpsCaptureEnabled:false`, `fpsWindowSec:30`, `fpsExcludes:string[]`
- v1.2: `overlayEnabled:false`, `overlayCorner:"tr"`, `overlayOpacity:0.85`, `overlayHotkey:"Alt+Shift+F"`, `overlayMetrics:["fps","low1","frametime"]`, `overlayDenyList:string[]`

`ViewId` adds `"gaming"` (F8).

### 4.3 Ship gates for v1.1
1. **Overhead:** on the reference test rig at 144 fps, PresentMon plus the agent's parsing must use ≤ 0.5% total CPU, measured over 10 minutes. Nexum's whole background budget stays < 1.5%. If the gate fails, add a "lite" mode with `--no_track_gpu`.
2. **Anti-cheat matrix**, each title marked pass, fail or not tested in the release notes:
   - Valorant (Vanguard)
   - Fortnite or Apex (EAC)
   - PUBG or R6 (BattlEye)
   - Battlefield 6 (Javelin, which needs the session already running before launch)
   - CS2 (VAC)
   - FACEIT client (PawnIO ≥ 2.1.0)

   There is no vendor statement for Vanguard, EAC or BattlEye ([Riot](https://support.riotgames.com/en-us/riot/performance/what-is-vanguard)).
3. **Robustness:** no orphaned `NexumFrames` session after the agent is killed (`logman query -ets` is clean after restart).
4. **Upstream drift:** CSV columns are parsed by header name, and the CI pin is updated deliberately, never floating.

---

## 5. Overclocking and tuning: decision matrix and safety design

### 5.1 Decision matrix

| Capability | Decision | Release | Basis |
|---|---|---|---|
| GPU tuning state, read-only (ranges, current, factory/custom, power mode, VPU-recovery count) | **Yes**, if OD8 reports caps on Navi 48 | v1.1 | ADL OD8 `ADL2_Overdrive8_Init_SettingX2_Get` / `Current_SettingX2_Get` (MIT per header text, `[Verified]` V2, [include/](https://github.com/GPUOpen-LibrariesAndSDKs/display-library/tree/master/include)). RDNA4 support is `[Unverified]` (V3). |
| AMD power limit: decrease | **Yes** ("within spec") | v1.2 | `OD8_POWER_PERCENTAGE`. Driver range observed at about −30% to +10% ([HWCooling](https://www.hwcooling.net/en/tuning-gigabyte-radeon-rx-9070-xt-performance-in-amd-software/)) |
| AMD power limit: increase | **Yes, behind an "Outside spec — may affect warranty" toggle** | v1.2 | AMD warranty wording ([TH](https://www.tomshardware.com/pc-components/cpus/amd-says-overclocking-blows-hidden-fuses-on-ryzen-threadripper-7000-to-show-if-youve-overclocked-but-it-wont-automatically-void-your-cpus-warranty)) |
| AMD one-click Auto Undervolt | **Yes**, if the `ADL_OD8_AUTO_UV_ENGINE` capability is set | v1.2 | AMD's own algorithm. Never combined with manual offsets. |
| AMD GPU fan curve (5 points) and zero-RPM | **Yes**, with guards | v1.2 | `OD8_FAN_CURVE_*`, `OD8_FAN_ZERORPM_CONTROL` |
| AMD presets (Quiet/Balanced/Rage) | Later | v1.3+ | The `OD8_OPTIMZED_POWER_MODE` values are undocumented, so probe them first |
| AMD manual voltage offset | Later, with a −100 mV floor and never positive | v1.3+ | Offsets from base on Navi4+ ("Starting from Navi 4+, the GPU voltage is an offset from the base voltage", [ADLX docs](https://gpuopen.com/manuals/adlx/adlx-sdk-references/adlx-interfaces/gpu-tuning/iadlxmanualgraphicstuning2/setgpuvoltage/), `[Verified]`; whether ADL OD8 uses the same semantics on Navi 48 is for the probe to find out). −170 mV worked and −200 mV crashed for der8auer ([TH](https://www.tomshardware.com/pc-components/gpus/undervolted-rx-9070-xt-beats-rtx-5080-rx-9070-and-9070-xt-models-with-heavy-coolers-have-massive-oc-headroom)) |
| AMD clock offset, auto-OC GPU/VRAM | Later or maybe | – | The power limit caps clocks; a frequency offset "only raises the ceiling" (HWCooling, above) |
| AMD VRAM clock / timings, TDC | **No** | – | See Not doing |
| NVIDIA power limit and fan (NVML) | Later | v1.3+ | Admin only; resets on reboot ([NVML](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceCommands.html)) |
| NVIDIA clock offsets | Maybe | – | Public NVAPI has no `SetPstates20`; NVML `SetClockOffsets` on R555+ (`[Unsourced]`: from the oc report, with no URL; check it against the [NVML device-commands docs](https://docs.nvidia.com/deploy/nvml-api/api/group__nvmlDeviceCommands.html) before this row is scheduled) |
| CPU: multiplier, CO, PBO, PPT | **No** (read-only state in v1.3+) | – | Not doing |
| RAM: any write | **No** (read-only timings in v1.1) | – | BIOS only |
| Any ADLX-based path | **No**, unless AMD grants a written licence exception | – | C4 |

### 5.2 Safety design (needed before any write ships)

1. **Single writer in the sidecar.**
   - All writes go through the agent.
   - The revert timer lives **in the agent**, so a driver reset that blanks the WebView still reverts.
   - The UI only proposes changes.
2. **Bounds are enforced in the sidecar**, not only in the UI.
   - Effective range = the driver's min/max intersected with Nexum's envelope, snapped to the driver's step.

   | Setting | Envelope |
   |---|---|
   | Power | driver minimum to 0%; the positive range unlocks only through the "outside spec" toggle |
   | Voltage offset (v1.3+) | −100 to 0 mV |
   | Frequency offset | locked at 0 |
   | VRAM | locked |
   | Fan curve | non-decreasing; ≥ 50% at ≥ 80 °C; 100% at ≥ 90 °C |
   | Zero-RPM | only below 50 °C, **if** OD8 exposes a zero-RPM stop temperature. If the probe shows only an on/off switch (`OD8_FAN_ZERORPM_CONTROL`), Nexum offers on/off only, keeps the driver's own stop temperature, and drops this envelope rule rather than pretend to enforce it. |
3. **Transaction with a 15 s auto-revert.**
   - Before touching hardware, write `%ProgramData%\Nexum\tuning\tx.json` (`txId`, previous OD8 table, proposed values, `bootId`, VPU-recovery count, `ts`, `state:"pending"`). The ProgramData folder gets an explicit ACL at install, after the [Razer CVE-2021-44226](https://nvd.nist.gov/vuln/detail/CVE-2021-44226) lesson.
   - Then apply and show "Keep these settings? Reverting in 15…".
   - Timeout, Esc, window close or agent exit → restore the previous values. If that fails, set `reset=1` on every changed feature.
   - Also auto-revert during the window and for 10 minutes after confirming if any of these happen:
     - the VPU-recovery counter increments (`ADL2_OverdriveN_CountOfEvents_Get`, [ADL docs](https://gpuopen-librariesandsdks.github.io/adl/group__OVERDRIVENAPI.html));
     - Event 4101 (TDR) appears ([Microsoft](https://learn.microsoft.com/windows-hardware/drivers/display/timeout-detection-and-recovery));
     - the GPU fan reads 0 RPM above 60 °C.
4. **Crash recovery at startup.** If the journal is `pending`, or a Kernel-Power 41, BugCheck 1001, Event 4101 or WHEA 18/19 is newer than the last confirmed transaction, reset to factory and show a banner. Never assume the driver reset itself (AMD users report inconsistent WattMan resets: [AMD community](https://community.amd.com/t5/pc-drivers-software/default-radeon-wattman-settings-have-been-restored-due-to-an/m-p/282916/highlight/true)). After reboot, read the current values and compare them with the journal.
5. **No apply at boot by default.** Opt-in re-apply at logon comes in v1.3+, behind a boot counter: if the counter is ≥ 2, skip and reset to factory.
   - **Gap found by the critic pass:** "no apply at boot" only helps if the *driver* does not persist OD8 writes across a reboot. If it does, a bad setting comes back at every boot, and step 4 only runs if the user starts Nexum. The v1.1 probe must therefore reboot once after a `write:true` and record whether the −10% power value survived. If it persists, Nexum may apply tuning only while the "Launch at startup" task is registered, so crash recovery runs at every logon, and the UI says so before the first apply.
6. **Coexistence with Adrenalin.** Settings are shared driver state and the last writer wins.
   - If the current values differ from Nexum's last write, show "Overridden by AMD Software" and never re-apply in a loop.
   - Before a manual write, reset auto-tuning or optimized-power mode, and set the OD8 power mode to manual as the ADL sample does. Restore that mode on revert.
7. **Validation session.**
   - The user clicks Validate, then runs 3DMark Stress Test, OCCT or a game for 10–20 minutes.
   - Nexum records clocks, power, temperatures, fans, 4101 events, VPU recoveries and WHEA.
   - **Pass** requires none of those events, plus ≥ 97% frame stability if the user enters a 3DMark result ([UL](https://benchmarks.ul.com/news/check-your-pcs-stability-with-new-3dmark-stress-tests)).
   - Profiles show "Unvalidated" or "Validated on <date>".
   - Nexum never launches third-party stress tools.
8. **Overhead and anti-cheat.** Tuning reads happen only while the tab is open, plus one `EventLogWatcher` on System/4101. Calls go through the vendor driver API from Nexum's own process. No game process is touched.
9. **Labels.** Within spec: power decrease, Auto Undervolt, fan curve. Outside spec, with an AMD warranty link: power increase, plus frequency or VRAM increases if they are ever added.

### 5.3 Contract additions

- **Probe** (v1.1, run once on the reference test rig):
  - `{cmd:"tuningProbe", write:boolean}` dumps caps, the Init/Current tables and the VPU count to `%LOCALAPPDATA%\Nexum\tuning-probe.json`.
  - With `write:true` it applies −10% power, reads it back and resets with `reset=1`.
  - It also records: whether `ADL2_Overdrive8_Init_SettingX2_Get` reports caps on Navi 48 at all; which temperature the OD8 fan curve follows (edge or hotspot, compared with Adrenalin's Tuning page); whether a zero-RPM stop temperature is exposed; and whether a write survives a reboot (§5.2 item 5).
  - **Gate:** if OD8 writes have no effect on RDNA4 (`[Unverified]`, V3: no public source either way), v1.2 ships read-only and the owner pursues Q7.
- **Sidecar → Rust:**
  ```jsonc
  { "type":"tuningState", "gpuIndex":0, "backend":"adl-od8", "odVersion":8,
    "caps":{ "powerLimit":true, "autoUndervolt":true, "fanCurve":true, "zeroRpm":true, "voltageOffset":true },
    "ranges":{ "powerPct":{ "min":-30, "max":10, "step":1, "default":0 },
               "fanCurve":{ "tempMinC":25, "tempMaxC":100, "pctMin":0, "pctMax":100 } },
    "current":{ "powerPct":0, "autoUndervolt":false, "fanCurve":[{ "tempC":40, "pct":20 }], "zeroRpm":true },
    "mode":"factory"|"custom"|"autoUndervolt"|"external", "vpuRecoveries":0,
    "envelope":{ "powerPctMax":0, "outsideSpecUnlocked":false }, "lastValidatedTs":null }
  { "type":"tuningTx", "txId":"...", "state":"pending"|"confirmed"|"reverted"|"failed",
    "revertDeadlineTs":0, "reason":"timeout"|"user"|"vpuRecovery"|"tdr4101"|"fanStall"|"agentExit"|null }
  { "type":"validationResult", "txId":"...", "passed":true, "durationSec":900,
    "events":{ "tdr4101":0, "vpuRecoveries":0, "whea":0 }, "frameStabilityPct":null }
  ```
- **Rust → sidecar:**
  - `{cmd:"tuningGet"}`
  - `{cmd:"tuningApply", txId, profile:{ powerPct?:number, autoUndervolt?:boolean, fanCurve?:{tempC:number,pct:number}[5], zeroRpm?:boolean }}`
  - `{cmd:"tuningConfirm", txId}`, `{cmd:"tuningRevert", txId}`, `{cmd:"tuningReset"}`
  - `{cmd:"tuningUnlockOutsideSpec", enabled}`
  - `{cmd:"validationStart"}`, `{cmd:"validationStop", frameStabilityPct:number|null}`
- **Tauri commands:** `get_tuning_state`, `run_tuning_probe {write}`, `apply_tuning {profile}` (returns `txId`), `confirm_tuning {txId}`, `revert_tuning {txId}`, `reset_tuning`, `set_outside_spec {enabled}`, `start_validation`, `stop_validation {frameStabilityPct}`.
- **Events:** `tuning-state`, `tuning-tx`, `validation-result`.

---

## 6. Design system changes

### 6.1 Semantic status tokens, separate from series colours

Today gold is used for the primary CTA, the GPU series and warnings, and rose is used for "outdated" drivers. Add to `styles/nexum.css` `@theme`:

```
--color-ok:      #2DD4BF;   /* = teal */
--color-warn:    #F59E0B;   /* new amber, distinct from brand gold #D4A359 */
--color-crit:    #E11D48;   /* = rose */
--color-unknown: #64748B;   /* = muted; used for "unavailable" and "health unknown" */
```

- `StatusPill` tones map to these tokens only.
- **Gold** is reserved for brand accents and the GPU data series. It is never used for state.
- State is never conveyed by colour alone. Every state pill has an icon (check, triangle, octagon, lock) and a text label.
- One function per domain produces label and tone together: `driveHealth()`, `sensorState()`, `alertState()`. This prevents the red "HEALTHY" class of bug.

### 6.2 New primitives (`components/ui/`)
- `Unavailable({ reason: "notElevated"|"pawnIoMissing"|"pawnIoOutdated"|"unsupported", compact? })`: an em dash, a lock icon and the cause. Used in place of any null value. Sparklines are hidden when their data is null.
- `HealthBanner({ alert, onAction, onDismiss })`: a dismissible bar at the top of a view, with amber or rose variants.
- `StatCells({ value, min, max, avg, unit })`: tabular-number cells for the Sensors view and drive temperatures.
- `SensorRow`: a virtualized row with an inline-rename input. Empty input restores the default name.
- `ScrollFade`: a bottom fade mask plus a thin visible scrollbar for any independently scrolling column.

### 6.3 Charts
- **Live telemetry:** unstacked lines on a labelled 0–100% y-axis, with a "small multiples" toggle (one panel per metric with its max printed, like Afterburner: [TH](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature)). Series with no data are hidden from the legend.
- **Frametime chart** (v1.1): reference bands at 16.7, 8.3 and 6.9 ms (60, 120 and 144 Hz).
- **Throttle strip** (v1.2): a GPU-Z "PerfCap"-style coloured timeline under the clock graphs ([TH](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature)).

### 6.4 Layout rules
- Grids derive their column count from the item count (`min(n, 4)`) or use `auto-fit, minmax()`. Nothing assumes 6 fans or 4 drives.
- At 1280–1439 px: shorter KPI sub-labels; the Drivers table drops Category and INF; dates never wrap.
- Long actions (Clean, Apply tuning) live in a sticky footer and are never below the fold.
- Buttons and icon-only controls always carry text labels. HWiNFO's unlabelled log and reset icons are a documented complaint ([TH](https://www.tomshardware.com/how-to/check-graphics-card-temp-temperature)).

### 6.5 Information architecture
- **Navigation:** F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F6 Cooling (tabs: Case fans | GPU tuning) · F7 Drivers · F8 Gaming; F5 Rescan; F9 Clean caches.
- **Dashboard:**
  - KPI strip (CPU, GPU, VRAM, RAM, CPU fan, plus FPS while a game is active)
  - live chart
  - Health alerts
  - Pinned sensors
  - Storage (with life chips)
  - 3-line System summary
- **Cooling:** fans with user labels and RPM Min/Max, plus the temperatures that drive fan decisions (CPU Tctl/Tdie, VRM MOS, Chipset, System #1/#2, GPU Hot Spot). Unused headers are hidden by default. The duplicated CPU, GPU and RAM panels are removed.
- **Drivers:** the table gets the full width, and BIOS & OS moves to System → OS & Security.

### 6.6 Copy rules (added to CONTRACT §4)
- Banned: *boost, optimize, speed up, free RAM, junk, trash, purge* (as a CTA), *optimal* (unless it is rule-backed).
- Every status claim has a hover showing the rule that produced it.
- Units: one unit per list (GB, or MB below 1 GB), and buttons repeat the headline number exactly.

### 6.7 Preview data
`lib/mock.ts` keeps `DEFAULT_RIG` and the `?rig=owner` / `?admin=0` profiles from the design test, with generic hostnames only. The CI screenshot job renders both admin and non-admin modes at 1280 and 1600 px so layout regressions show up in review.

### 6.8 Spec and owner-request coverage check (critic pass)

| Source item | Where it lands | Status |
|---|---|---|
| DESIGN-SPEC §3 C: driver JSON/CSV export and `pnputil` backup | Already in `drivers.rs` (`export_drivers`, pnputil backup) | Covered by current code. The roadmap was silent; keep it, and make the backup's output folder use the same "Open folder" pattern as the CSV log. |
| DESIGN-SPEC §3 D.3: Delivery Optimization cache | MF-4 `wu-cache` | Now uses `Delete-DeliveryOptimizationCache` (MF-4). |
| DESIGN-SPEC §7.4: throttle polling when minimized to tray | Not in any report | **Added as a v1.0 gate:** with the window hidden, the agent drops to the 5 s tray/alert sensor set (or stops if alerts are off), and the Sensors stream and WebView rendering stop. Measure Nexum's total CPU over 10 min, minimized and idle, on the reference rig: it must be < 0.5%, leaving headroom inside the 1.5% budget for v1.1 FPS capture (§4.3). |
| Overhead: HDD spin-down | Not in any report | **Added as a v1.0 test:** check that polling the Seagate HDD's SMART data does not keep it from spinning down (Windows power-plan disk timeout). If it does, read SMART for rotational drives every 10 min, not every tick (engineering judgement, unsourced). |
| DESIGN-SPEC §2.2/§3 A: RAM "form factor", speed, slots | v1.0 System lite, MF-9 | Covered. |
| DESIGN-SPEC §9: Startup App Manager | Not doing | Rejected, with reason. |
| Owner: "best-in-class vs CPU-Z/HWMonitor" | v1.0 Sensors + System lite; v1.1 full System, CSV | Covered for HWMonitor (tree, Value/Min/Max, logging). CPU-Z parity has a gap: CPU-Z shows **XMP** profiles and live timings; Nexum has live timings in v1.1 but XMP only in v1.3+. Since LHM already exposes JEDEC SPD timings (V4), consider moving the SPD tab with JEDEC timings into v1.0 lite. |
| Owner: FPS tracking with 1% lows, frametime graph, optional borderless overlay | §4 (v1.1), overlay v1.2 | Covered. Note the overlay is *click-through top-most*, which does not draw over exclusive fullscreen (Not doing: uiAccess). |
| Owner: overclocking evaluation, "GPU tuning via ADLX … VRAM clock … auto-revert" | §5 | Evaluated and partly refuted: ADLX rejected on licence (V2), VRAM clock rejected, auto-revert designed. RDNA4 write support depends on the probe (V3). |
| Owner: tech-press research (Ars, Verge, Wired, CNET, ZDNet) | §0 coverage gap | **Not covered.** See Q11. |

---

## 7. Open questions for the owner

1. **Drive at 44%:** have the important files on the reference rig's C: drive been copied elsewhere? This is outside Nexum's scope, but it is the most urgent finding.
2. **Repo hygiene:** OK to remove the machine hostname from `docs/target-hardware.md` (MF-12)? If it was already pushed, should git history be rewritten, or is the exposure acceptable?
3. **Elevation:** do you accept whole-app `requireAdministrator` for v1.0 and v1.1, with the split-privilege work in v1.2 (C3)?
4. **Installer format:** if CI shows the NSIS uninstaller can't be signed through SignPath, is switching to MSI acceptable (MF-8)?
5. **Probe consent:** will you run the v1.1 tuning probe with `write:true` (one −10% power write, read back, then factory reset) on the RX 9070 XT? Please also record Adrenalin's Tuning page ranges for comparison.
6. **Which anti-cheat games do you actually play?** The §4.3 matrix will prioritize them. Also: is AFMF enabled in Adrenalin, which affects FPS labelling?
7. **AMD licence:** should we email AMD GPUOpen asking for a GPL-3.0 and SignPath-compatible exception for ADLX? Until there is a written answer, Nexum stays on ADL OD8.
8. **BIOS F19c:** does PBO → Curve Optimizer appear for the 5700X3D? This is for the read-only System view note only; Nexum will not write it.
9. **CPU thermal threshold:** confirm the 5700X3D maximum operating temperature on AMD's spec page (the page timed out during research). The v1.1 alert default is model-based, and the same Zen 3 X3D design held "a steady-state temperature of 90C" before throttling in Tom's 5800X3D test ([TH](https://www.tomshardware.com/reviews/amd-ryzen-7-5800x3d-review/3)).
10. **Recycle Bin:** keep it as an opt-in, age-based category (v1.1), or drop it entirely as "your undo, not a cache"?
11. **Press coverage gap:** the requested Ars Technica, The Verge, Wired, CNET and ZDNet coverage is not in this roadmap (§0). Should someone review those five by hand before v1.0 copy is frozen, or is the Tom's Hardware / PCMag / How-To Geek basis enough?
12. **Signing the first build (MF-8 item 5):** SignPath Foundation requires a prior release and a "verifiable reputation". Do you accept unsigned, clearly labelled preview releases (which your own SAC-on PC will block) to build that history? Or should we check whether you are eligible for Microsoft Artifact Signing as a paid bridge?
13. **Security audit vs SignPath:** before any work on the v1.1 kernel-driver/vendor-utility audit, may we ask SignPath in writing whether it counts as "features designed to identify … security vulnerabilities"? If it does, only the read-only platform status ships.
