# Nexum: BIOS-Style PC Telemetry, Driver & Optimization System

> **Historical document.** This is the original design spec, kept for reference. The current plan and the v1.0 release gate are in [`ROADMAP.md`](ROADMAP.md), and the authoritative interfaces are in [`CONTRACT.md`](../CONTRACT.md). Where this spec disagrees with either of them, they win. In particular:
>
> * Nexum never uses or ships the WinRing0 driver. Sensor access goes through the separately installed, vendor-signed [PawnIO](https://pawnio.eu/) driver (ROADMAP MF-3).
> * The RAM standby-list flush has been removed (ROADMAP C5).
> * The cleaner is "Clean caches" with conservative defaults and no "trash"/"purge" wording (ROADMAP MF-4).
> * IPC is stdio only: no localhost port and no WebSocket (ROADMAP C3, C6).
> * The keymap is F1 Dashboard · F2 Sensors · F3 System · F4 Storage · F5 Rescan · F6 Cooling · F7 Drivers · F9 Clean caches (ROADMAP C2).
> * §9 "Future V2 Enhancements" is superseded by ROADMAP §3.

**Project Name:** Nexum (`Nexum.exe`)
**Project Type:** Native Windows Desktop System Monitoring & Maintenance Suite (Windows 10/11)
**Design Language:** Dark Glassmorphic Telemetry HUD (Inspired by Modern UEFI/BIOS, Animus-Style Precision & Executive Analytics Dashboards)

## 1. Project Vision & Scope

**Nexum** (Latin for *"connection"* or *"link"*) is a lightweight, ultra-responsive, all-in-one Windows `.exe` application that links every hardware sensor, driver, and storage volume on your PC into a single command center.

Unlike bloated commercial utilities, Nexum runs natively with minimal CPU and RAM overhead while delivering real-time sensor telemetry, full A-to-Z driver and BIOS metadata, storage analytics, and a safe **1-Click Deep Clean** engine—all wrapped in a high-contrast, dark-teal and gold BIOS-inspired interface.

## 2. UI/UX Design Blueprint (Mapped to Reference Aesthetic)

To achieve the exact look and feel of your reference design with a sleek BIOS hardware-precision vibe, Nexum uses a **3-Column Modular Grid** on a deep obsidian-teal canvas with subtle glowing borders and crisp data visualization.

### 2.1 Color Palette & Visual Tokens

| Role | Color / Hex | Usage |
| :--- | :--- | :--- |
| **Canvas Background** | `#070B0E` to `#0D1B1E` | Deep radial gradient background |
| **Card Surface** | `rgba(16, 26, 30, 0.72)` | Translucent dark cards with `1px solid rgba(255,255,255,0.08)` |
| **Primary Accent (Teal)** | `#2DD4BF` | Active status, CPU/RAM healthy bars, segmented gauges |
| **Secondary Accent (Gold)** | `#D4A359` | GPU telemetry, primary CTA highlights, top-tier metrics |
| **Tertiary Accent (Purple)** | `#9333EA` | VRAM / Network / Cache layers in stacked charts |
| **Alert / Critical (Rose)** | `#E11D48` | Thermal throttling, outdated drivers, critical drive space |
| **Text Primary / Muted** | `#F8FAFC` / `#64748B` | Crisp white values with slate-gray labels & dotted leaders |

### 2.2 Layout Mapping (Widget-by-Widget)

* **Top Command Bar:**
  * **Left:** **NEXUM** geometric emblem + Quick View Switcher (Dashboard, Drivers, Storage, Fan Control, Cleaner).
  * **Right:** Highlighted **`[⚡ 1-Click Purge Trash]`** CTA button (styled like the outlined gold button in your reference), Refresh Sensors button, and Settings/Profile icon.
* **Header Strip:**
  * Displays your PC Hostname & CPU/GPU summary (e.g., *WORKSTATION-01 — Ryzen 9 / RTX 4080*), a glowing **`Synced / Optimal`** status pill, and the live uptime / last driver scan timestamp.
* **Left Column (Health & Quick KPIs):**
  * **Thermal & Load Index Card:** Large percentage readout with a dot-matrix mini-visualizer (matching the top-left widget).
  * **Storage & Junk Gauge:** Semi-circular radial arc showing total Used Space vs. Free Space vs. Reclaimable Trash (in GB).
  * **2x2 Hardware Snapshot Grid:** Quick-glance mini cards with trend arrows for **CPU Temp**, **GPU Temp**, **RAM Used (GB)**, and **Avg Fan RPM**.
* **Center Column (Live Telemetry Command):**
  * **5-Card Top Telemetry Strip** (each with a vertical colored accent line):
    1. **CPU Load (%)** *(Teal)*
    2. **GPU Load (%)** *(Gold)*
    3. **VRAM Used (GB)** *(White/Silver)*
    4. **RAM Used (GB)** *(Purple)*
    5. **Fan Speed (RPM)** *(Cyan)*
  * **Main Interactive Stacked Telemetry Graph:** Real-time multi-layer bar/area chart tracking CPU, GPU, RAM, and Disk/Fan activity over time with rich dark hover tooltips displaying exact values.
* **Right Column (BIOS Metadata, Storage & Drivers):**
  * **System & BIOS Details Card (Dotted-Leader List):**
    * Motherboard Model, BIOS Version & Date, OS Build, Graphics Card Name (GPU), Architecture.
  * **Storage Utilization Bar (Segmented LED Style):** Displays primary drive usage percentage (e.g., `72% Used — 280 GB Free`) with an LED-segment progress bar.
  * **Active Cooling & Sensors List:** Clickable list of individual fans (CPU Fan, AIO Pump, Case Fans 1–4) with live RPM.
  * **Driver & System Status List:** Scrollable quick-view of installed critical drivers (GPU, Chipset, Audio, LAN/Wi-Fi, NVMe) showing version numbers and update status.

## 3. Core Functional Modules (A to Z)

### Module A: Real-Time Hardware Telemetry
* **Graphics Card (GPU):** Exact model name (e.g., *NVIDIA GeForce RTX 4080*), core load (%), VRAM used vs. total (GB), core/memory clock (MHz), temperature ($^\circ\text{C}$), power draw ($\text{W}$), and GPU fan RPM.
* **Processor (CPU):** Model name, per-core & total utilization (%), base/boost clock speeds ($\text{GHz}$), package temperature, voltage, and thread count.
* **Memory (RAM):** Used GB, Available GB, Total GB, speed ($\text{MT/s}$), form factor, and active slot configuration (e.g., 2 of 4 DIMMs used).
* **Fan Speed & Thermal Control:** Reads all motherboard PWM/DC headers via Super I/O sensors; displays live RPM and allows switching presets (*Silent / Balanced / Turbo / Custom Curve*).

### Module B: Storage & Drive Diagnostics
* Lists all physical drives (NVMe, SATA SSD, HDD) and logical partitions (`C:\`, `D:\`, etc.).
* Displays **Used Storage (GB/TB)**, **Available Storage (GB/TB)**, and percentage filled.
* Reads **S.M.A.R.T. Health Data:** Drive temperature, TBW (Terabytes Written), Power-On Hours, and overall health percentage.
* Live Read/Write throughput ($\text{MB/s}$).

### Module C: A-to-Z Driver & System Inventory
* **Full Driver Audit:** Scans every device class (Display, Chipset, Network, Audio, Storage Controllers, USB, Bluetooth, Firmware).
* **Metadata Captured:** Driver Provider, Version Number, Release Date, Digital Signature Status (WHQL signed vs. unsigned), and `.inf` file name.
* **BIOS & OS Details:** UEFI/BIOS manufacturer, version, release date, Secure Boot status, TPM 2.0 status, Windows version/build, and system uptime.
* **Driver Actions:** One-click export of full driver list (JSON/CSV), driver backup utility (`pnputil` / DISM wrapper), and quick links to official vendor update portals.

### Module D: 1-Click "Remove All Trash" (Deep Purge Engine)
Designed for maximum safety and instant space recovery. Clicking the button executes a verified cleanup sequence and shows a live summary of MB/GB reclaimed:
1. **User & System Temp Files:** `%TEMP%` and `C:\Windows\Temp` (skipping locked/in-use files).
2. **Recycle Bin:** Empties across all mounted drives.
3. **Windows Update & Delivery Optimization Cache:** Clears old installation leftovers (`SoftwareDistribution\Download`).
4. **GPU Shader Caches:** Clears stale DirectX, NVIDIA (`DXCache` / `GLCache`), and AMD shader caches.
5. **Browser & App Caches (Optional Toggle):** Clears temporary web caches for Chrome, Edge, Firefox, and Discord without deleting logins/cookies.
6. **System Logs & Crash Dumps:** Removes old `.dmp` files, Windows Error Reporting logs, and Prefetch leftovers.
7. **RAM Standby List Flush:** Optionally clears cached standby memory to free up RAM before gaming or heavy workloads.

## 4. Recommended Tech Stack & Architecture

To compile **Nexum** into a fast, native `.exe` (~15–30 MB) while keeping the exact modern web-dashboard aesthetic from your reference image, use a **Tauri + C# Hardware Sidecar** architecture:

| Layer | Technology | Why It Fits |
| :--- | :--- | :--- |
| **Desktop Shell & `.exe` Packager** | **Tauri v2 (Rust)** | Compiles directly to a native Windows `Nexum.exe` and NSIS `.exe` installer. Uses only ~30–50 MB RAM. |
| **Frontend UI** | **React + TypeScript + Tailwind CSS** | Ideal for glassmorphic cards, dark-mode theming, and responsive BIOS grid layouts. |
| **Data Visualization** | **Apache ECharts** or **Recharts** | Handles smooth 60 FPS stacked bar/area telemetry charts, radial gauges, and custom dark tooltips. |
| **Hardware Telemetry Engine** | **LibreHardwareMonitorLib (C# .NET 8 Sidecar)** | The gold standard open-source library for reading Windows CPU/GPU loads, VRAM, motherboard Super I/O fan RPMs, and temps. |
| **OS & Driver Queries** | **Windows WMI / CIM, PowerShell / Win32 API** | Native, zero-dependency access to all drivers (`Win32_PnPSignedDriver`), BIOS (`Win32_BIOS`), and disk space (`Win32_LogicalDisk`). |
| **IPC / Live Stream** | **NDJSON over stdio** (no localhost port, no WebSocket) | Streams telemetry packets from the bundled hardware sidecar to the Rust core every $1000\text{ ms}$ (configurable); the UI receives them as Tauri events. See [`CONTRACT.md`](../CONTRACT.md). |

### High-Level System Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                  NEXUM FRONTEND (Tauri + React)                   │
│  [Header & 1-Click Purge]  [Live ECharts]  [BIOS/Driver Tables]   │
└───────────────────────────────▲───────────────────────────────────┘
                                │ Local IPC / JSON Stream (@ 1Hz)
┌───────────────────────────────▼───────────────────────────────────┐
│              NEXUM CORE BACKEND (Rust + C# Sidecar)               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │ Telemetry Engine │  │  WMI & Driver    │  │  Deep Cleaner   │  │
│  │ (LibreHardware   │  │  Scanner         │  │  (Safe Purge &  │  │
│  │  Monitor + NVML) │  │  (BIOS/INF/SMART)│  │   RAM Flush)    │  │
│  └──────────────────┘  └──────────────────┘  └─────────────────┘  │
└───────────────────────────────▲───────────────────────────────────┘
                                │ Ring-0 / Kernel Drivers & Win32 API
┌───────────────────────────────▼───────────────────────────────────┐
│         WINDOWS OS & PC HARDWARE (CPU, GPU, Fans, NVMe)           │
└───────────────────────────────────────────────────────────────────┘
```

## 5. Proposed Project Directory Structure

```
nexum-monitor/
├── src-frontend/                   # React + TypeScript + Tailwind UI
│   ├── components/
│   │   ├── layout/                 # TopBar, Sidebar, GlassCard
│   │   ├── telemetry/              # KpiStrip, StackedLiveChart, FanList
│   │   ├── storage/                # StorageGauge, SegmentedDriveBar
│   │   ├── drivers/                # DriverTable, BiosDetailsCard
│   │   └── cleaner/                # OneClickPurgeModal, CleanupSummary
│   ├── hooks/                      # useTelemetryStream, useDriverScan
│   ├── styles/                     # Nexum dark-teal/gold BIOS tokens
│   └── App.tsx
├── src-tauri/                      # Rust core app, UAC manifest & .exe builder
│   ├── binaries/                   # Compiled C# sidecar (nexum-agent-x86_64-pc-windows-msvc.exe)
│   ├── icons/                      # Nexum app icon (.ico, .png)
│   ├── src/
│   │   ├── main.rs                 # App entry, tray icon, sidecar lifecycle
│   │   ├── cleaner.rs              # Safe file deletion & trash scanner
│   │   └── system_info.rs          # Storage & WMI driver queries
│   ├── build.rs                    # Embeds Windows UAC Administrator manifest
│   └── tauri.conf.json             # NSIS .exe installer & bundle settings
└── nexum-agent/                    # C# .NET 8 Hardware Telemetry Sidecar
    ├── TelemetryService.cs         # LibreHardwareMonitor wrapper
    ├── GpuMonitor.cs               # Dedicated GPU/VRAM polling
    └── Program.cs                  # JSON telemetry streamer
```

## 6. `.exe` Build, Packaging & PC Installation Plan

This section covers the exact pipeline to turn the **Nexum** codebase into a real, installable Windows `.exe` on your PC.

### 6.1 Build Environment Prerequisites (Windows 10/11)
Before compiling `Nexum.exe`, install the following free developer tools on your build PC:
1. **Node.js (LTS):** For building the React/Tailwind frontend.
2. **Rust Toolchain (`rustup`):** For compiling the Tauri native core.
3. **Visual Studio Build Tools 2022:** Select the *"Desktop development with C++"* workload.
4. **.NET 8 SDK:** For compiling the C# `nexum-agent` hardware sensor sidecar.
5. **Microsoft Edge WebView2 Runtime:** Already pre-installed on Windows 11 and modern Windows 10.

### 6.2 Step-by-Step `.exe` Compilation Pipeline

* **Step 1 — Compile the Hardware Sensor Sidecar:**
  Publish the C# `nexum-agent` as a self-contained, single-file Windows binary so users don't need .NET installed on their PC:
  ```powershell
  dotnet publish nexum-agent/NexumAgent.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
  ```
  Copy the resulting executable into `src-tauri/binaries/nexum-agent-x86_64-pc-windows-msvc.exe` and register it under `externalBin` in `tauri.conf.json`.

* **Step 2 — Embed the Administrator (UAC) Manifest:**
  Reading motherboard fan RPMs and cleaning `C:\Windows\Temp` requires elevated privileges. In `src-tauri/build.rs`, embed a Windows application manifest setting `requestedExecutionLevel` to `requireAdministrator` so `Nexum.exe` automatically requests Admin rights on launch.

* **Step 3 — Build the Standalone `.exe` & Installer:**
  Run the production Tauri build command:
  ```powershell
  npm run tauri build
  ```
  This automatically compiles the frontend, links the Rust backend, bundles the `nexum-agent` sidecar, and outputs two ready-to-use files:
  * **Portable Executable:** `src-tauri/target/release/Nexum.exe` (Run directly from any folder).
  * **Windows Installer:** `src-tauri/target/release/bundle/nsis/Nexum_1.0.0_x64-setup.exe` (Full installer with Start Menu & Desktop shortcuts).

### 6.3 Installing & Deploying Nexum on Your PC

1. **Run the Installer:** Double-click `Nexum_1.0.0_x64-setup.exe`.
   * *Note on Windows Defender SmartScreen:* Because a personal build is not signed with a paid EV Code Signing Certificate, Windows SmartScreen may show *"Windows protected your PC"* on the first run. Click **More info → Run anyway** (or create a local self-signed certificate and trust it on your own machine).
2. **Choose Install Directory:** Installs cleanly to `C:\Program Files\Nexum\` along with an automatic uninstaller in Windows **Installed Apps**.
3. **First Launch & UAC Prompt:** Accept the Administrator UAC prompt so Nexum can read hardware sensors through `LibreHardwareMonitorLib` and scan your BIOS/drivers. Full sensor access (CPU temperature and power, Super I/O fan headers, fan control) also needs the vendor-signed **PawnIO** driver ≥ 2.1.0, installed separately from [pawnio.eu](https://pawnio.eu/) after a consent screen. Nexum never bundles or installs a kernel driver itself and never uses WinRing0 (CVE-2020-14979; ROADMAP MF-3).
4. **Enable Background & Startup Mode:**
   * Inside Nexum Settings, toggle **"Launch Nexum on Windows Startup"** (implemented via Windows Task Scheduler with *"Run with highest privileges"* so it starts silently without a UAC popup every time you reboot).
   * Toggle **"Minimize to System Tray"** so Nexum monitors temperatures and fan speeds quietly in the background.

## 7. Safety, Permissions & Engineering Guardrails

1. **Hardcoded Protected Paths:** The 1-Click Cleaner enforces an immutable **Deny-List** (never touches `System32`, `SysWOW64`, `Program Files`, `Users\Documents`, or active registry hives).
2. **Locked File Handling:** All file deletions are wrapped in error-handling blocks so active OS/app temp files are silently skipped rather than crashing the cleaner.
3. **Dry-Run Pre-Scan:** Automatically calculates total reclaimable space (e.g., *"4.82 GB Ready to Purge"*) before executing deletion, with an optional confirmation toggle.
4. **Low Overhead Budget:** Keeps background CPU usage $< 1.5\%$ by throttling sensor polling when the app window is minimized to the system tray.

## 8. Step-by-Step Development Roadmap

### Phase 1: Foundation & Hardware Agent (Week 1)
* Initialize the **Tauri + React + Tailwind** workspace (`nexum-monitor`).
* Build the C# **Nexum Agent** using `LibreHardwareMonitorLib` to stream CPU, GPU (name, load, VRAM GB), RAM, Fan RPMs, and Drive temperatures as JSON.

### Phase 2: BIOS-Style Dashboard UI (Week 2)
* Implement the dark-teal and gold glassmorphic theme and 3-column layout matching your reference image.
* Build the 5-card top KPI strip, segmented LED storage bar, semi-circle gauge, dotted-leader BIOS details card, and live **ECharts** stacked telemetry graph.

### Phase 3: Storage & A-to-Z Driver Inventory (Week 3)
* Implement WMI queries to fetch full BIOS metadata, Windows version, and all installed device drivers (Name, Version, Date, Provider, Status).
* Add S.M.A.R.T. health indicators, per-drive Used/Available GB breakdowns, and JSON/CSV report export.

### Phase 4: 1-Click Deep Purge Engine (Week 4)
* Build the background trash scanner to calculate reclaimable GB across Temp folders, Recycle Bin, Update Cache, and Shader Caches.
* Wire up the **`1-Click Purge`** button with a sleek progress overlay and post-clean summary (e.g., *"Freed 6.4 GB in 2.3s"*).

### Phase 5: `.exe` Packaging & PC Installation (Week 5)
* Embed the UAC Administrator manifest, configure the System Tray & Windows Task Scheduler auto-start, and add BIOS keyboard shortcuts (`F1` Dashboard, `F2` Drivers, `F5` Rescan, `F9` Quick Clean).
* Compile `Nexum_1.0.0_x64-setup.exe` and install it on your PC.

## 9. Future V2 Enhancements (Optional Ideas)
* **Custom Fan Curve Editor:** Drag-and-drop temperature-to-RPM curve graphs per fan header.
* **Startup App Manager:** Toggle Windows startup programs to speed up boot times.
* **In-Game HUD Overlay:** Minimalist corner overlay showing FPS, GPU/CPU temps, and VRAM usage.
* **Alert Rules:** Desktop notifications if CPU/GPU exceeds $85^\circ\text{C}$ or drive free space drops below $10\%$.