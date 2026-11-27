# Third-party notices

Nexum is licensed under the [GNU General Public License v3.0](../LICENSE). It includes the third-party components below,
each under its own licence. The full licence texts are in this folder, which is shipped with the portable build.

A plain-text list of every bundled component with its licence and upstream URL is in
[`THIRD_PARTY.txt`](THIRD_PARTY.txt).

## Intel PresentMon (`presentmon/PresentMon-2.6.0-x64.exe`)

| Component | Version | Licence | Source | Text |
| --- | --- | --- | --- | --- |
| PresentMon console application | 2.6.0 | MIT | <https://github.com/GameTechDev/PresentMon> (tag `v2.6.0`) | [PresentMon/LICENSE.txt](PresentMon/LICENSE.txt) |

Nexum ships Intel's release asset **byte for byte**, still carrying Intel's Authenticode signature (SHA-256
`b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af`). Nexum never modifies or re-signs it. It is used
only for the optional frame-rate capture, which is off by default; the hardware agent checks the hash and the Intel
signature before every start. PresentMon reads Windows performance events (ETW) and does not inject anything into
games or other processes.

## Hardware agent (`nexum-agent.exe`)

These libraries are compiled into the self-contained agent (some native helpers ship next to it).

| Component | Version | Licence | Source | Text |
| --- | --- | --- | --- | --- |
| LibreHardwareMonitorLib | 0.9.6 | MPL-2.0 | <https://github.com/LibreHardwareMonitor/LibreHardwareMonitor> | [MPL-2.0.txt](MPL-2.0.txt) |
| DiskInfoToolkit | 1.1.2 | MPL-2.0 | <https://github.com/Blacktempel/DiskInfoToolkit> | [MPL-2.0.txt](MPL-2.0.txt) |
| RAMSPDToolkit-NDD | 1.4.2 | MPL-2.0 | <https://github.com/Blacktempel/RAMSPDToolkit> | [MPL-2.0.txt](MPL-2.0.txt) |
| HidSharp | 2.6.4 | Apache-2.0 | <https://software.seekye.com/hidsharp> | [Apache-2.0-HidSharp.txt](Apache-2.0-HidSharp.txt) |
| Mono.Posix.NETStandard (`MonoPosixHelper.dll`, `libMonoPosixHelper.dll`) | 1.0.0 | MIT | <https://github.com/mono/mono> | MIT (in the package) |
| .NET 8 runtime, System.Management, System.IO.Ports, System.Threading.AccessControl | 8.x / 10.0.x | MIT | <https://github.com/dotnet/runtime> | MIT (in the packages) |

**MPL-2.0 source availability (MPL-2.0 §3.2):** Nexum uses LibreHardwareMonitorLib, DiskInfoToolkit and
RAMSPDToolkit-NDD **unmodified**, exactly as published on NuGet. Their complete Source Code Form is available from the
repositories linked above at the tags matching the versions listed. Nexum's own code is not a modification of these
files; it is a "Larger Work" under MPL-2.0 §3.3 and is licensed under GPL-3.0.

## User interface (`Nexum.exe`)

| Component | Version | Licence | Text |
| --- | --- | --- | --- |
| Apache ECharts | 5.6.x | Apache-2.0 (with BSD-3-Clause parts from d3) | [Apache-2.0-ECharts.txt](Apache-2.0-ECharts.txt), [NOTICE-ECharts.txt](NOTICE-ECharts.txt), [BSD-3-Clause-d3.txt](BSD-3-Clause-d3.txt) |
| ZRender | 5.6.x | BSD-3-Clause | [BSD-3-Clause-ZRender.txt](BSD-3-Clause-ZRender.txt) |
| React, React DOM | 18.3.x | MIT | [MIT-React.txt](MIT-React.txt) |
| Lucide icons (`lucide-react`) | 0.468.x | ISC (portions MIT, from Feather) | [ISC-Lucide.txt](ISC-Lucide.txt) |
| Inter typeface (`@fontsource/inter`) | 5.x | SIL Open Font License 1.1 | [OFL-1.1-Inter.txt](OFL-1.1-Inter.txt) |
| JetBrains Mono typeface (`@fontsource/jetbrains-mono`) | 5.x | SIL Open Font License 1.1 | [OFL-1.1-JetBrainsMono.txt](OFL-1.1-JetBrainsMono.txt) |
| Tauri (`tauri`, `@tauri-apps/api`, plugins: shell, single-instance, notification) and other Rust crates | 2.x | MIT or Apache-2.0 | see each crate in `src-tauri/Cargo.lock` |

The fonts are embedded unmodified. Under the OFL they may be bundled with software, but not sold on their own.

## Used as a reference or called on your system (not included)

| Component | Licence | Source | What Nexum uses | Text |
| --- | --- | --- | --- | --- |
| AMD Display Library (ADL) SDK | MIT | <https://github.com/GPUOpen-LibrariesAndSDKs/display-library> | 11 hand-written declarations (set-up, tear-down and read-only `Get`/`Caps` calls) for the `atiadlxx.dll` installed by the AMD graphics driver. No ADL file is shipped; no ADL `Set` function is ever called (CI enforces it). | [ADL/LICENSE.txt](ADL/LICENSE.txt) |
| ZenStates-Core | GPL-3.0 | <https://github.com/irusanov/ZenStates-Core> | The DDR4 memory-controller register map (`Dictionaries/DDR4Dictionary.cs`) followed by `nexum-agent/Spec/MemoryTimings.cs` to read live DDR4 timings. Read only. | [ZenStates-Core/NOTICE.txt](ZenStates-Core/NOTICE.txt), [GPL-3.0](../LICENSE) |

## PawnIO (not included)

[PawnIO](https://pawnio.eu/) is a kernel driver that LibreHardwareMonitorLib can use for low-level sensor and fan access.
**Nexum does not include, redistribute or install PawnIO.** If you want full sensor access you install it yourself from
the official site (Nexum shows a consent screen and a link). PawnIO is developed and signed by its own author
(namazso), under its own licence; see <https://github.com/namazso/PawnIO.Setup>. Nexum does not uninstall PawnIO because
other applications may rely on it.

Nexum never ships or loads the WinRing0, InpOut or OpenHardwareMonitor kernel drivers; CI fails the build if one appears
in the output.
