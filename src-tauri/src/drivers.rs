//! Driver inventory (Win32_PnPSignedDriver), JSON/CSV export and pnputil backup.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::system_info::{query_soft, wmi_connection, NS_CIMV2};
use crate::util::{
    clean, documents_nexum_dir, file_timestamp, hidden_command, lock, parse_cim_date, system32_exe,
};

const OUTDATED_DAYS: i64 = 1095; // 3 years
const MAX_BACKUP_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    pub device_name: String,
    pub device_class: String,
    pub category: String,
    pub provider: String,
    pub manufacturer: String,
    pub version: String,
    pub date: String,
    pub signed: bool,
    pub signer: String,
    pub inf_name: String,
    pub device_id: String,
    pub age_days: Option<i64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverBackupResult {
    pub path: String,
    pub success: bool,
    pub output: String,
}

#[derive(Deserialize, Debug)]
struct PnpSignedDriverRow {
    #[serde(rename = "DeviceName", default)]
    device_name: Option<String>,
    #[serde(rename = "DeviceClass", default)]
    device_class: Option<String>,
    #[serde(rename = "DriverProviderName", default)]
    driver_provider_name: Option<String>,
    #[serde(rename = "Manufacturer", default)]
    manufacturer: Option<String>,
    #[serde(rename = "DriverVersion", default)]
    driver_version: Option<String>,
    #[serde(rename = "DriverDate", default)]
    driver_date: Option<String>,
    #[serde(rename = "IsSigned", default)]
    is_signed: Option<bool>,
    #[serde(rename = "Signer", default)]
    signer: Option<String>,
    #[serde(rename = "InfName", default)]
    inf_name: Option<String>,
    #[serde(rename = "DeviceID", default)]
    device_id: Option<String>,
}

const CATEGORY_ORDER: [&str; 11] = [
    "Display",
    "Chipset",
    "Network",
    "Audio",
    "Storage",
    "USB",
    "Bluetooth",
    "Firmware",
    "Input",
    "System",
    "Other",
];

fn category_rank(c: &str) -> usize {
    CATEGORY_ORDER
        .iter()
        .position(|x| *x == c)
        .unwrap_or(CATEGORY_ORDER.len())
}

const CHIPSET_VENDORS: [&str; 7] = [
    "intel",
    "amd",
    "advanced micro devices",
    "nvidia",
    "via technologies",
    "asmedia",
    "qualcomm",
];

const CHIPSET_KEYWORDS: [&str; 12] = [
    "chipset",
    "pci",
    "smbus",
    "lpc",
    "host bridge",
    "root complex",
    "root port",
    "management engine",
    "serial io",
    "gpio",
    "psp",
    "dynamic tuning",
];

/// Maps a PnP DeviceClass (plus name/vendor hints) to a contract category.
pub fn categorize(
    device_class: &str,
    device_name: &str,
    provider: &str,
    manufacturer: &str,
) -> &'static str {
    let class = device_class.trim().to_ascii_uppercase();
    match class.as_str() {
        "DISPLAY" => "Display",
        "SYSTEM" => {
            let name = device_name.to_lowercase();
            let vendor = format!(
                "{} {}",
                provider.to_lowercase(),
                manufacturer.to_lowercase()
            );
            let by_name = CHIPSET_KEYWORDS.iter().any(|k| contains_word(&name, k));
            let by_vendor = CHIPSET_VENDORS.iter().any(|v| contains_word(&vendor, v));
            if by_name || by_vendor {
                "Chipset"
            } else {
                "System"
            }
        }
        "NET" => "Network",
        "MEDIA" | "AUDIOENDPOINT" => "Audio",
        "SCSIADAPTER" | "HDC" | "DISKDRIVE" | "NVME" => "Storage",
        "USB" | "USBDEVICE" => "USB",
        "BLUETOOTH" => "Bluetooth",
        "FIRMWARE" => "Firmware",
        "HIDCLASS" | "KEYBOARD" | "MOUSE" => "Input",
        _ => "Other",
    }
}

/// Case-insensitive (inputs already lower-cased) whole-word-ish containment, so that e.g.
/// "amd" does not match inside "camden" and "psp" does not match inside other words.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(needle) {
        let start = from + pos;
        let end = start + needle.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        // Advance by one whole character to stay on a UTF-8 boundary.
        from = start + haystack[start..].chars().next().map_or(1, char::len_utf8);
        if from >= haystack.len() {
            break;
        }
    }
    false
}

fn to_driver(row: PnpSignedDriverRow, today: chrono::NaiveDate) -> Option<DriverInfo> {
    let device_name = clean(&row.device_name);
    if device_name.is_empty() {
        return None;
    }
    let device_class = clean(&row.device_class);
    let provider = clean(&row.driver_provider_name);
    let manufacturer = clean(&row.manufacturer);
    let signer = clean(&row.signer);
    let date = row.driver_date.as_deref().and_then(parse_cim_date);
    let age_days = date.map(|d| (today - d).num_days().max(0));
    let signed = row.is_signed.unwrap_or(false);
    let status = if !signed {
        "unsigned"
    } else if age_days.is_some_and(|a| a > OUTDATED_DAYS) {
        "outdated"
    } else {
        "ok"
    };
    Some(DriverInfo {
        category: categorize(&device_class, &device_name, &provider, &manufacturer).to_string(),
        device_name,
        device_class,
        provider,
        manufacturer,
        version: clean(&row.driver_version),
        date: date
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default(),
        signed,
        signer,
        inf_name: clean(&row.inf_name),
        device_id: clean(&row.device_id),
        age_days,
        status: status.to_string(),
    })
}

pub fn scan_drivers() -> Result<Vec<DriverInfo>, String> {
    let conn = wmi_connection(NS_CIMV2)?;
    let rows: Vec<PnpSignedDriverRow> = query_soft(
        Some(&conn),
        "SELECT DeviceName, DeviceClass, DriverProviderName, Manufacturer, DriverVersion, DriverDate, IsSigned, Signer, InfName, DeviceID FROM Win32_PnPSignedDriver",
    );
    let today = chrono::Local::now().date_naive();
    let mut drivers: Vec<DriverInfo> = rows
        .into_iter()
        .filter_map(|r| to_driver(r, today))
        .collect();
    drivers.sort_by(|a, b| {
        category_rank(&a.category)
            .cmp(&category_rank(&b.category))
            .then_with(|| {
                a.device_name
                    .to_lowercase()
                    .cmp(&b.device_name.to_lowercase())
            })
            .then_with(|| a.device_id.cmp(&b.device_id))
    });
    Ok(drivers)
}

fn record_scan(app: &AppHandle, drivers: &[DriverInfo]) {
    let state = app.state::<AppState>();
    *lock(&state.last_driver_scan) = Some(chrono::Local::now().to_rfc3339());
    *lock(&state.driver_cache) = Some(drivers.to_vec());
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/// Quotes a CSV field. Text a spreadsheet would evaluate as a formula (`=`, `+`, `-`, `@`,
/// tab or CR first; driver strings come from third-party INF files) is prefixed with `'`.
fn csv_field(s: &str) -> String {
    let formula_like =
        s.starts_with(['=', '+', '-', '@', '\t', '\r']) && s.trim().parse::<f64>().is_err();
    let value = if formula_like {
        format!("'{s}")
    } else {
        s.to_string()
    };
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn to_csv(drivers: &[DriverInfo]) -> String {
    let mut out = String::from("\u{FEFF}"); // BOM so Excel detects UTF-8
    let header = [
        "Category",
        "Device Name",
        "Device Class",
        "Provider",
        "Manufacturer",
        "Version",
        "Date",
        "Signed",
        "Signer",
        "INF",
        "Device ID",
        "Age (days)",
        "Status",
    ];
    out.push_str(
        &header
            .iter()
            .map(|h| csv_field(h))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("\r\n");
    for d in drivers {
        let row = [
            d.category.clone(),
            d.device_name.clone(),
            d.device_class.clone(),
            d.provider.clone(),
            d.manufacturer.clone(),
            d.version.clone(),
            d.date.clone(),
            if d.signed { "Yes".into() } else { "No".into() },
            d.signer.clone(),
            d.inf_name.clone(),
            d.device_id.clone(),
            d.age_days.map(|a| a.to_string()).unwrap_or_default(),
            d.status.clone(),
        ];
        out.push_str(
            &row.iter()
                .map(|f| csv_field(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    }
    out
}

fn export_to(drivers: &[DriverInfo], format: &str) -> Result<String, String> {
    let dir = documents_nexum_dir()?;
    let (ext, content) = match format {
        "json" => (
            "json",
            serde_json::to_string_pretty(drivers).map_err(|e| e.to_string())?,
        ),
        "csv" => ("csv", to_csv(drivers)),
        other => return Err(format!("Unsupported export format '{other}'")),
    };
    let path = dir.join(format!("drivers-{}.{ext}", file_timestamp()));
    std::fs::write(&path, content)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------------------------
// Backup (pnputil)
// ---------------------------------------------------------------------------------------------

fn decode_console(bytes: &[u8]) -> String {
    // pnputil writes UTF-16LE when redirected on some builds, OEM/UTF-8 text on others.
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let zeros = bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        if zeros * 2 > bytes.len() / 2 {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            return String::from_utf16_lossy(&units)
                .trim_start_matches('\u{FEFF}')
                .to_string();
        }
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn truncate_output(s: String) -> String {
    if s.len() <= MAX_BACKUP_OUTPUT {
        return s;
    }
    let mut cut = s.len() - MAX_BACKUP_OUTPUT;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    format!("…(output truncated)…\n{}", &s[cut..])
}

pub fn backup() -> DriverBackupResult {
    let dir = match documents_nexum_dir() {
        Ok(d) => d.join(format!("DriverBackup-{}", file_timestamp())),
        Err(e) => {
            return DriverBackupResult {
                path: String::new(),
                success: false,
                output: e,
            }
        }
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return DriverBackupResult {
            path: dir.to_string_lossy().to_string(),
            success: false,
            output: format!("Could not create backup folder: {e}"),
        };
    }
    let path = dir.to_string_lossy().to_string();
    match hidden_command(system32_exe("pnputil.exe"))
        .arg("/export-driver")
        .arg("*")
        .arg(&dir)
        .output()
    {
        Ok(out) => {
            let mut text = decode_console(&out.stdout);
            let err = decode_console(&out.stderr);
            if !err.trim().is_empty() {
                text.push('\n');
                text.push_str(&err);
            }
            DriverBackupResult {
                path,
                success: out.status.success(),
                output: truncate_output(text.trim().to_string()),
            }
        }
        Err(e) => DriverBackupResult {
            path,
            success: false,
            output: format!("Could not run pnputil: {e}"),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_drivers(app: AppHandle) -> Result<Vec<DriverInfo>, String> {
    let drivers = tauri::async_runtime::spawn_blocking(scan_drivers)
        .await
        .map_err(|e| format!("Driver scan failed: {e}"))??;
    record_scan(&app, &drivers);
    Ok(drivers)
}

#[tauri::command]
pub async fn export_drivers(app: AppHandle, format: String) -> Result<String, String> {
    let format = format.trim().to_ascii_lowercase();
    if format != "json" && format != "csv" {
        return Err(format!("Unsupported export format '{format}'"));
    }
    let cached = lock(&app.state::<AppState>().driver_cache).clone();
    let drivers = match cached {
        Some(d) => d,
        None => {
            let d = tauri::async_runtime::spawn_blocking(scan_drivers)
                .await
                .map_err(|e| format!("Driver scan failed: {e}"))??;
            record_scan(&app, &d);
            d
        }
    };
    tauri::async_runtime::spawn_blocking(move || export_to(&drivers, &format))
        .await
        .map_err(|e| format!("Export failed: {e}"))?
}

#[tauri::command]
pub async fn backup_drivers() -> Result<DriverBackupResult, String> {
    tauri::async_runtime::spawn_blocking(backup)
        .await
        .map_err(|e| format!("Backup failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, class: &str, date: &str, signed: Option<bool>) -> PnpSignedDriverRow {
        PnpSignedDriverRow {
            device_name: Some(name.into()),
            device_class: Some(class.into()),
            driver_provider_name: Some("Microsoft".into()),
            manufacturer: Some("(Standard system devices)".into()),
            driver_version: Some("10.0.1".into()),
            driver_date: Some(date.into()),
            is_signed: signed,
            signer: Some("Microsoft Windows".into()),
            inf_name: Some("machine.inf".into()),
            device_id: Some("ROOT\\X".into()),
        }
    }

    #[test]
    fn categories() {
        assert_eq!(categorize("DISPLAY", "RTX", "", ""), "Display");
        assert_eq!(
            categorize(
                "System",
                "PCI Express Root Port",
                "Microsoft",
                "(Standard system devices)"
            ),
            "Chipset"
        );
        assert_eq!(categorize("SYSTEM", "SMBus Controller", "", ""), "Chipset");
        assert_eq!(
            categorize("SYSTEM", "Management Interface", "Intel", "Intel"),
            "Chipset"
        );
        assert_eq!(
            categorize(
                "SYSTEM",
                "System timer",
                "Microsoft",
                "(Standard system devices)"
            ),
            "System"
        );
        assert_eq!(
            categorize("SYSTEM", "Camden thing", "Microsoft", "x"),
            "System"
        );
        assert_eq!(categorize("NET", "", "", ""), "Network");
        assert_eq!(categorize("AudioEndpoint", "", "", ""), "Audio");
        assert_eq!(categorize("SCSIAdapter", "", "", ""), "Storage");
        assert_eq!(categorize("HIDClass", "", "", ""), "Input");
        assert_eq!(categorize("Firmware", "", "", ""), "Firmware");
        assert_eq!(categorize("Printer", "", "", ""), "Other");
    }

    #[test]
    fn status_rules() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let d = to_driver(
            row("A", "NET", "20250101000000.000000-000", Some(true)),
            today,
        )
        .unwrap();
        assert_eq!(d.status, "ok");
        assert_eq!(d.age_days, Some(365));
        assert_eq!(d.date, "2025-01-01");
        let d = to_driver(
            row("B", "NET", "20060621000000.******+000", Some(true)),
            today,
        )
        .unwrap();
        assert_eq!(d.status, "outdated");
        let d = to_driver(
            row("C", "NET", "20250101000000.000000-000", Some(false)),
            today,
        )
        .unwrap();
        assert_eq!(d.status, "unsigned");
        let d = to_driver(row("D", "NET", "", Some(true)), today).unwrap();
        assert_eq!(d.age_days, None);
        assert_eq!(d.date, "");
        assert!(to_driver(row("  ", "NET", "", Some(true)), today).is_none());
    }

    #[test]
    fn csv_quoting() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let mut d = to_driver(
            row(
                "Dev, \"Quoted\"\nLine",
                "NET",
                "20250101000000.000000-000",
                Some(true),
            ),
            today,
        )
        .unwrap();
        d.provider = "Prov".into();
        let csv = to_csv(&[d]);
        assert!(csv.starts_with('\u{FEFF}'));
        assert!(csv.contains("\"Dev, \"\"Quoted\"\"\nLine\""));
        assert_eq!(csv.matches("\r\n").count(), 2);
        assert_eq!(csv_field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_field("@SUM(A1)"), "\"'@SUM(A1)\"");
        assert_eq!(csv_field("-5"), "\"-5\"");
        assert_eq!(csv_field("10.0.1"), "\"10.0.1\"");
    }

    #[test]
    fn console_decoding() {
        let utf16: Vec<u8> = "Hello"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(decode_console(&utf16), "Hello");
        assert_eq!(decode_console(b"Hello"), "Hello");
    }
}
