//! System / BIOS / OS / storage inventory via WMI, the registry and Win32.
//! Every query fails soft (empty / "Unknown" / null) and never panics.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use wmi::{COMLibrary, WMIConnection};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY,
    RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};
use windows::Win32::System::SystemInformation::{
    FirmwareTypeBios, FirmwareTypeUefi, GetFirmwareType, GetTickCount64, FIRMWARE_TYPE,
};
use windows::Win32::UI::Shell::IsUserAnAdmin;

use crate::state::AppState;
use crate::util::{cim_date_string, clean, clean_or, flex, lock, system_drive};

pub const NS_CIMV2: &str = "ROOT\\CIMV2";
const NS_TPM: &str = "ROOT\\CIMV2\\Security\\MicrosoftTpm";
const NS_STORAGE: &str = "ROOT\\Microsoft\\Windows\\Storage";

// ---------------------------------------------------------------------------------------------
// Shapes (CONTRACT §2.1)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Motherboard {
    pub manufacturer: String,
    pub product: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiosInfo {
    pub vendor: String,
    pub version: String,
    pub release_date: String,
    pub mode: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub caption: String,
    pub version: String,
    pub build: String,
    pub display_version: String,
    pub architecture: String,
    pub install_date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TpmInfo {
    pub present: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub hostname: String,
    pub cpu_name: String,
    pub gpu_names: Vec<String>,
    pub motherboard: Motherboard,
    pub bios: BiosInfo,
    pub os: OsInfo,
    pub secure_boot: Option<bool>,
    pub tpm: Option<TpmInfo>,
    pub uptime_secs: u64,
    pub is_admin: bool,
    pub ram_total_gb: f64,
    pub last_driver_scan: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub letter: String,
    pub label: String,
    pub file_system: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    pub drive_type: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalDisk {
    pub device_id: String,
    pub model: String,
    pub media_type: String,
    pub bus_type: String,
    pub size_bytes: u64,
    pub health_status: String,
    pub operational_status: String,
    pub serial: String,
}

// ---------------------------------------------------------------------------------------------
// WMI plumbing
// ---------------------------------------------------------------------------------------------

/// Opens a WMI connection on the *current* thread (call from a blocking worker thread).
pub fn wmi_connection(namespace: &str) -> Result<WMIConnection, String> {
    let com = match COMLibrary::new() {
        Ok(c) => c,
        Err(_) => match COMLibrary::without_security() {
            Ok(c) => c,
            Err(wmi::WMIError::HResultError { hres })
                if hres == windows::Win32::Foundation::RPC_E_CHANGED_MODE.0 =>
            {
                // COM is already initialized on this thread (as STA); reuse it.
                // SAFETY: CoInitializeEx just reported COM is initialized for this thread and
                // nothing here uninitializes it while the connection lives.
                unsafe { COMLibrary::assume_initialized() }
            }
            Err(e) => return Err(format!("COM initialization failed: {e}")),
        },
    };
    WMIConnection::with_namespace_path(namespace, com)
        .map_err(|e| format!("WMI connection to {namespace} failed: {e}"))
}

/// Runs a WQL query, returning an empty vector on any failure.
pub fn query_soft<T: DeserializeOwned>(conn: Option<&WMIConnection>, wql: &str) -> Vec<T> {
    match conn {
        Some(c) => match c.raw_query::<T>(wql) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[nexum] WMI query failed ({wql}): {e}");
                Vec::new()
            }
        },
        None => Vec::new(),
    }
}

// ---------------------------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------------------------

fn reg_string(subkey: &str, value: &str) -> Option<String> {
    let sk = HSTRING::from(subkey);
    let vn = HSTRING::from(value);
    let mut size: u32 = 0;
    let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;
    unsafe {
        let rc = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &sk,
            &vn,
            flags,
            None,
            None,
            Some(&mut size as *mut u32),
        );
        if rc != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size2 = (buf.len() * 2) as u32;
        let rc = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &sk,
            &vn,
            flags,
            None,
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            Some(&mut size2 as *mut u32),
        );
        if rc != ERROR_SUCCESS {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..len]).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn reg_dword(subkey: &str, value: &str) -> Option<u32> {
    let sk = HSTRING::from(subkey);
    let vn = HSTRING::from(value);
    let mut data: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &sk,
            &vn,
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(&mut data as *mut u32 as *mut std::ffi::c_void),
            Some(&mut size as *mut u32),
        )
    };
    if rc == ERROR_SUCCESS {
        Some(data)
    } else {
        None
    }
}

fn reg_key_exists(subkey: &str) -> bool {
    let sk = HSTRING::from(subkey);
    let mut key = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sk.as_ptr()),
            0,
            KEY_READ | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if rc == ERROR_SUCCESS {
        unsafe {
            let _ = RegCloseKey(key);
        }
        true
    } else {
        false
    }
}

const SECURE_BOOT_KEY: &str = r"SYSTEM\CurrentControlSet\Control\SecureBoot\State";

fn bios_mode() -> &'static str {
    let mut ft = FIRMWARE_TYPE::default();
    if unsafe { GetFirmwareType(&mut ft) }.is_ok() {
        if ft == FirmwareTypeUefi {
            return "UEFI";
        }
        if ft == FirmwareTypeBios {
            return "Legacy";
        }
    }
    if reg_key_exists(SECURE_BOOT_KEY) {
        "UEFI"
    } else {
        "Unknown"
    }
}

fn secure_boot(mode: &str) -> Option<bool> {
    match reg_dword(SECURE_BOOT_KEY, "UEFISecureBootEnabled") {
        Some(v) => Some(v != 0),
        None if mode == "Legacy" => Some(false),
        None => None,
    }
}

pub fn is_admin() -> bool {
    unsafe { IsUserAnAdmin() }.as_bool()
}

fn uptime_secs() -> u64 {
    let ms = unsafe { GetTickCount64() };
    ms / 1000
}

// ---------------------------------------------------------------------------------------------
// WMI row types
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct ComputerSystemRow {
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(
        rename = "TotalPhysicalMemory",
        default,
        deserialize_with = "flex::opt_u64"
    )]
    total_physical_memory: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct PhysicalMemoryRow {
    #[serde(rename = "Capacity", default, deserialize_with = "flex::opt_u64")]
    capacity: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct ProcessorRow {
    #[serde(rename = "Name", default)]
    name: Option<String>,
}

#[derive(Deserialize, Debug)]
struct VideoControllerRow {
    #[serde(rename = "Name", default)]
    name: Option<String>,
}

#[derive(Deserialize, Debug)]
struct BaseBoardRow {
    #[serde(rename = "Manufacturer", default)]
    manufacturer: Option<String>,
    #[serde(rename = "Product", default)]
    product: Option<String>,
    #[serde(rename = "Version", default)]
    version: Option<String>,
}

#[derive(Deserialize, Debug)]
struct BiosRow {
    #[serde(rename = "Manufacturer", default)]
    manufacturer: Option<String>,
    #[serde(rename = "SMBIOSBIOSVersion", default)]
    smbios_bios_version: Option<String>,
    #[serde(rename = "ReleaseDate", default)]
    release_date: Option<String>,
}

#[derive(Deserialize, Debug)]
struct OperatingSystemRow {
    #[serde(rename = "Caption", default)]
    caption: Option<String>,
    #[serde(rename = "Version", default)]
    version: Option<String>,
    #[serde(rename = "BuildNumber", default)]
    build_number: Option<String>,
    #[serde(rename = "OSArchitecture", default)]
    os_architecture: Option<String>,
    #[serde(rename = "InstallDate", default)]
    install_date: Option<String>,
    #[serde(rename = "LastBootUpTime", default)]
    #[allow(dead_code)]
    last_boot_up_time: Option<String>,
}

#[derive(Deserialize, Debug)]
struct TpmRow {
    #[serde(rename = "IsEnabled_InitialValue", default)]
    is_enabled_initial_value: Option<bool>,
    #[serde(rename = "SpecVersion", default)]
    spec_version: Option<String>,
}

#[derive(Deserialize, Debug)]
struct LogicalDiskRow {
    #[serde(rename = "DeviceID", default)]
    device_id: Option<String>,
    #[serde(rename = "VolumeName", default)]
    volume_name: Option<String>,
    #[serde(rename = "FileSystem", default)]
    file_system: Option<String>,
    #[serde(rename = "Size", default, deserialize_with = "flex::opt_u64")]
    size: Option<u64>,
    #[serde(rename = "FreeSpace", default, deserialize_with = "flex::opt_u64")]
    free_space: Option<u64>,
    #[serde(rename = "DriveType", default, deserialize_with = "flex::opt_u64")]
    drive_type: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct MsftPhysicalDiskRow {
    #[serde(rename = "DeviceId", default)]
    device_id: Option<String>,
    #[serde(rename = "FriendlyName", default)]
    friendly_name: Option<String>,
    #[serde(rename = "Model", default)]
    model: Option<String>,
    #[serde(rename = "MediaType", default, deserialize_with = "flex::opt_u64")]
    media_type: Option<u64>,
    #[serde(rename = "BusType", default, deserialize_with = "flex::opt_u64")]
    bus_type: Option<u64>,
    #[serde(rename = "Size", default, deserialize_with = "flex::opt_u64")]
    size: Option<u64>,
    #[serde(rename = "HealthStatus", default, deserialize_with = "flex::opt_u64")]
    health_status: Option<u64>,
    #[serde(
        rename = "OperationalStatus",
        default,
        deserialize_with = "flex::opt_vec_u64"
    )]
    operational_status: Option<Vec<u64>>,
    #[serde(rename = "SerialNumber", default)]
    serial_number: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------------------------

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn tpm_info() -> Option<TpmInfo> {
    let conn = wmi_connection(NS_TPM).ok()?;
    let rows: Vec<TpmRow> = conn
        .raw_query("SELECT IsEnabled_InitialValue, SpecVersion FROM Win32_Tpm")
        .ok()?;
    match rows.into_iter().next() {
        None => Some(TpmInfo {
            present: false,
            version: None,
        }),
        Some(row) => {
            let version = row
                .spec_version
                .as_deref()
                .and_then(|s| s.split(',').next())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            // Present = a TPM is exposed *and* enabled (a TPM disabled in firmware is unusable).
            let present = row.is_enabled_initial_value.unwrap_or(true);
            Some(TpmInfo { present, version })
        }
    }
}

pub fn collect_system_info(last_driver_scan: Option<String>) -> SystemInfo {
    let conn = wmi_connection(NS_CIMV2).ok();
    let c = conn.as_ref();

    let cs: Vec<ComputerSystemRow> = query_soft(
        c,
        "SELECT Name, TotalPhysicalMemory FROM Win32_ComputerSystem",
    );
    let mem: Vec<PhysicalMemoryRow> = query_soft(c, "SELECT Capacity FROM Win32_PhysicalMemory");
    let cpus: Vec<ProcessorRow> = query_soft(c, "SELECT Name FROM Win32_Processor");
    let gpus: Vec<VideoControllerRow> = query_soft(c, "SELECT Name FROM Win32_VideoController");
    let boards: Vec<BaseBoardRow> = query_soft(
        c,
        "SELECT Manufacturer, Product, Version FROM Win32_BaseBoard",
    );
    let bioses: Vec<BiosRow> = query_soft(
        c,
        "SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS",
    );
    let oses: Vec<OperatingSystemRow> = query_soft(
        c,
        "SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate, LastBootUpTime FROM Win32_OperatingSystem",
    );

    let hostname = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| cs.first().map(|r| clean(&r.name)).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Unknown".to_string());

    let installed: u64 = mem.iter().filter_map(|m| m.capacity).sum();
    let ram_bytes = if installed > 0 {
        installed
    } else {
        cs.first()
            .and_then(|r| r.total_physical_memory)
            .unwrap_or(0)
    };
    let ram_total_gb = round2(ram_bytes as f64 / 1024f64.powi(3));

    let cpu_name = cpus
        .first()
        .map(|r| clean_or(&r.name, "Unknown CPU"))
        .unwrap_or_else(|| "Unknown CPU".to_string());
    // Collapse repeated spaces some vendors pad the name with.
    let cpu_name = cpu_name.split_whitespace().collect::<Vec<_>>().join(" ");

    let mut gpu_names: Vec<String> = Vec::new();
    for g in &gpus {
        let n = clean(&g.name);
        if !n.is_empty() && !gpu_names.iter().any(|x| x.eq_ignore_ascii_case(&n)) {
            gpu_names.push(n);
        }
    }

    let motherboard = boards
        .first()
        .map(|b| Motherboard {
            manufacturer: clean_or(&b.manufacturer, "Unknown"),
            product: clean_or(&b.product, "Unknown"),
            version: clean(&b.version),
        })
        .unwrap_or_else(|| Motherboard {
            manufacturer: "Unknown".into(),
            product: "Unknown".into(),
            version: String::new(),
        });

    let mode = bios_mode();
    let bios = bioses
        .first()
        .map(|b| BiosInfo {
            vendor: clean_or(&b.manufacturer, "Unknown"),
            version: clean_or(&b.smbios_bios_version, "Unknown"),
            release_date: cim_date_string(b.release_date.as_deref()),
            mode: mode.to_string(),
        })
        .unwrap_or_else(|| BiosInfo {
            vendor: "Unknown".into(),
            version: "Unknown".into(),
            release_date: String::new(),
            mode: mode.to_string(),
        });

    const CV: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let display_version = reg_string(CV, "DisplayVersion")
        .or_else(|| reg_string(CV, "ReleaseId"))
        .unwrap_or_default();
    let os = oses
        .first()
        .map(|o| OsInfo {
            caption: clean_or(&o.caption, "Windows"),
            version: clean(&o.version),
            build: clean(&o.build_number),
            display_version: display_version.clone(),
            architecture: clean(&o.os_architecture),
            install_date: cim_date_string(o.install_date.as_deref()),
        })
        .unwrap_or_else(|| OsInfo {
            caption: reg_string(CV, "ProductName").unwrap_or_else(|| "Windows".into()),
            version: String::new(),
            build: reg_string(CV, "CurrentBuildNumber").unwrap_or_default(),
            display_version: display_version.clone(),
            architecture: if cfg!(target_arch = "x86_64") {
                "64-bit".into()
            } else {
                String::new()
            },
            install_date: String::new(),
        });

    SystemInfo {
        hostname,
        cpu_name,
        gpu_names,
        motherboard,
        bios,
        os,
        secure_boot: secure_boot(mode),
        tpm: tpm_info(),
        uptime_secs: uptime_secs(),
        is_admin: is_admin(),
        ram_total_gb,
        last_driver_scan,
    }
}

fn drive_type_name(t: Option<u64>) -> &'static str {
    match t {
        Some(2) => "Removable",
        Some(3) => "Fixed",
        Some(4) => "Network",
        Some(5) => "CD-ROM",
        _ => "Unknown",
    }
}

pub fn collect_volumes() -> Vec<Volume> {
    let conn = wmi_connection(NS_CIMV2).ok();
    let rows: Vec<LogicalDiskRow> = query_soft(
        conn.as_ref(),
        "SELECT DeviceID, VolumeName, FileSystem, Size, FreeSpace, DriveType FROM Win32_LogicalDisk",
    );
    let sys = system_drive();
    let mut out: Vec<Volume> = rows
        .into_iter()
        .filter_map(|r| {
            let letter = clean(&r.device_id).to_ascii_uppercase();
            if letter.is_empty() {
                return None;
            }
            let total = r.size.unwrap_or(0);
            let free = r.free_space.unwrap_or(0).min(total);
            Some(Volume {
                is_system: letter.eq_ignore_ascii_case(&sys),
                letter,
                label: clean(&r.volume_name),
                file_system: clean(&r.file_system),
                total_bytes: total,
                free_bytes: free,
                used_bytes: total.saturating_sub(free),
                drive_type: drive_type_name(r.drive_type).to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.letter.cmp(&b.letter));
    out
}

fn bus_type_name(b: Option<u64>) -> String {
    match b {
        Some(1) => "SCSI",
        Some(2) => "ATAPI",
        Some(3) => "ATA",
        Some(4) => "1394",
        Some(5) => "SSA",
        Some(6) => "Fibre Channel",
        Some(7) => "USB",
        Some(8) => "RAID",
        Some(9) => "iSCSI",
        Some(10) => "SAS",
        Some(11) => "SATA",
        Some(12) => "SD",
        Some(13) => "MMC",
        Some(14) => "Virtual",
        Some(15) => "File Backed Virtual",
        Some(16) => "Storage Spaces",
        Some(17) => "NVMe",
        Some(18) => "SCM",
        Some(19) => "UFS",
        _ => "Unknown",
    }
    .to_string()
}

fn media_type_name(m: Option<u64>, bus: Option<u64>) -> String {
    match m {
        Some(3) => "HDD",
        Some(4) => "SSD",
        // NVMe / SCM devices are solid state even when MediaType is unspecified.
        _ if matches!(bus, Some(17) | Some(18)) => "SSD",
        _ => "Unspecified",
    }
    .to_string()
}

fn health_name(h: Option<u64>) -> String {
    match h {
        Some(0) => "Healthy",
        Some(1) => "Warning",
        Some(2) => "Unhealthy",
        _ => "Unknown",
    }
    .to_string()
}

fn operational_status_name(codes: &Option<Vec<u64>>) -> String {
    let names: Vec<String> = codes
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| {
            match c {
                0 => "Unknown",
                1 => "Other",
                2 => "OK",
                3 => "Degraded",
                4 => "Stressed",
                5 => "Predictive Failure",
                6 => "Error",
                7 => "Non-Recoverable Error",
                8 => "Starting",
                9 => "Stopping",
                10 => "Stopped",
                11 => "In Service",
                12 => "No Contact",
                13 => "Lost Communication",
                14 => "Aborted",
                15 => "Dormant",
                16 => "Supporting Entity in Error",
                17 => "Completed",
                18 => "Power Mode",
                0xD010 => "In Maintenance",
                0xD011 => "Not Usable",
                0xD012 => "Transient Error",
                0xD013 => "Failed Media",
                _ => "",
            }
            .to_string()
        })
        .map(|s| {
            if s.is_empty() {
                "Unknown".to_string()
            } else {
                s
            }
        })
        .collect();
    if names.is_empty() {
        "Unknown".to_string()
    } else {
        names.join(", ")
    }
}

pub fn collect_physical_disks() -> Vec<PhysicalDisk> {
    let conn = wmi_connection(NS_STORAGE).ok();
    let rows: Vec<MsftPhysicalDiskRow> = query_soft(
        conn.as_ref(),
        "SELECT DeviceId, FriendlyName, Model, MediaType, BusType, Size, HealthStatus, OperationalStatus, SerialNumber FROM MSFT_PhysicalDisk",
    );
    let mut out: Vec<PhysicalDisk> = rows
        .into_iter()
        .map(|r| PhysicalDisk {
            device_id: clean(&r.device_id),
            model: {
                let f = clean(&r.friendly_name);
                if f.is_empty() {
                    clean_or(&r.model, "Unknown disk")
                } else {
                    f
                }
            },
            media_type: media_type_name(r.media_type, r.bus_type),
            bus_type: bus_type_name(r.bus_type),
            size_bytes: r.size.unwrap_or(0),
            health_status: health_name(r.health_status),
            operational_status: operational_status_name(&r.operational_status),
            serial: clean(&r.serial_number),
        })
        .collect();
    out.sort_by(|a, b| {
        let ka = a.device_id.parse::<u64>().unwrap_or(u64::MAX);
        let kb = b.device_id.parse::<u64>().unwrap_or(u64::MAX);
        ka.cmp(&kb).then_with(|| a.device_id.cmp(&b.device_id))
    });
    out
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_system_info(app: AppHandle) -> Result<SystemInfo, String> {
    let last = lock(&app.state::<AppState>().last_driver_scan).clone();
    tauri::async_runtime::spawn_blocking(move || collect_system_info(last))
        .await
        .map_err(|e| format!("System info failed: {e}"))
}

#[tauri::command]
pub async fn get_volumes() -> Result<Vec<Volume>, String> {
    tauri::async_runtime::spawn_blocking(collect_volumes)
        .await
        .map_err(|e| format!("Volume query failed: {e}"))
}

#[tauri::command]
pub async fn get_physical_disks() -> Result<Vec<PhysicalDisk>, String> {
    tauri::async_runtime::spawn_blocking(collect_physical_disks)
        .await
        .map_err(|e| format!("Disk query failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mappings() {
        assert_eq!(drive_type_name(Some(3)), "Fixed");
        assert_eq!(drive_type_name(Some(5)), "CD-ROM");
        assert_eq!(drive_type_name(Some(6)), "Unknown");
        assert_eq!(bus_type_name(Some(17)), "NVMe");
        assert_eq!(bus_type_name(Some(11)), "SATA");
        assert_eq!(media_type_name(Some(4), Some(11)), "SSD");
        assert_eq!(media_type_name(Some(0), Some(17)), "SSD");
        assert_eq!(media_type_name(Some(3), Some(11)), "HDD");
        assert_eq!(media_type_name(None, Some(7)), "Unspecified");
        assert_eq!(health_name(Some(1)), "Warning");
        assert_eq!(health_name(Some(5)), "Unknown");
        assert_eq!(operational_status_name(&Some(vec![2])), "OK");
        assert_eq!(operational_status_name(&None), "Unknown");
    }

    #[test]
    fn live_queries_fail_soft() {
        // Runs against the real machine; must never panic, whatever the environment.
        let info = collect_system_info(None);
        assert!(!info.hostname.is_empty());
        let _ = collect_volumes();
        let _ = collect_physical_disks();
    }
}
