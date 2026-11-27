//! Save report (CONTRACT §2.12): the System view as a `.txt` or a self-contained `.html` in
//! `<Documents>\Nexum\Reports\`, written through [`crate::safe_fs::PinnedDir`].
//!
//! No hostname, no user name, no serial numbers, no drive history: only the `SystemSpec`
//! (which carries none of those) and disk models. The HTML has no scripts, no external URLs
//! and no images, and every value is escaped.

use std::io::Write;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::spec::SystemSpec;
use crate::system_info::PhysicalDisk;

/// Column at which values start in the text report (dot leaders up to it).
const VALUE_COLUMN: usize = 32;

/// One `Label ........ value` row, or a sub-heading (`value == None`).
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub label: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub title: &'static str,
    pub rows: Vec<Row>,
}

fn row(label: &str, value: impl Into<String>) -> Row {
    Row {
        label: label.to_string(),
        value: Some(value.into()),
    }
}

fn sub(label: impl Into<String>) -> Row {
    Row {
        label: label.into(),
        value: None,
    }
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|x| !x.is_empty())
}

fn n(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// A number without a trailing `.0`.
fn fmt_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        let t = format!("{x:.2}");
        t.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

const NA: &str = "Not available";

fn or_na(x: Option<String>) -> String {
    x.unwrap_or_else(|| NA.to_string())
}

fn link_text(l: &Value) -> Option<String> {
    let cur = match (n(l, "gen"), n(l, "width")) {
        (Some(g), Some(w)) => Some(format!("PCIe {} x{}", fmt_num(g), fmt_num(w))),
        (Some(g), None) => Some(format!("PCIe {}", fmt_num(g))),
        (None, Some(w)) => Some(format!("PCIe x{}", fmt_num(w))),
        (None, None) => None,
    };
    let max = match (n(l, "maxGen"), n(l, "maxWidth")) {
        (Some(g), Some(w)) => Some(format!("PCIe {} x{}", fmt_num(g), fmt_num(w))),
        _ => None,
    };
    match (cur, max) {
        (Some(c), Some(m)) if c != m => Some(format!("{c} (max {m})")),
        (Some(c), _) => Some(c),
        (None, Some(m)) => Some(format!("max {m}")),
        (None, None) => None,
    }
}

fn timings_label(source: &str) -> &'static str {
    match source {
        "umc" => "Live (memory controller)",
        "spd" => "SPD JEDEC (not the running timings)",
        _ => "Not available",
    }
}

/// The report sections, in the System view's tab order.
pub fn sections(spec: &SystemSpec, disks: &[PhysicalDisk]) -> Vec<Section> {
    let mut out = Vec::new();

    // CPU
    let mut rows = Vec::new();
    if let Some(c) = spec.cpu.as_object().map(|_| &spec.cpu) {
        rows.push(row("Name", or_na(s(c, "name").map(str::to_string))));
        rows.push(row("Vendor", or_na(s(c, "vendor").map(str::to_string))));
        rows.push(row("Codename", or_na(s(c, "codename").map(str::to_string))));
        if let (Some(f), Some(m), Some(st)) = (n(c, "family"), n(c, "model"), n(c, "stepping")) {
            rows.push(row(
                "Family / model / stepping",
                format!("{:X}h / {:X}h / {}", f as u64, m as u64, st as u64),
            ));
        }
        rows.push(row("Socket", or_na(s(c, "socket").map(str::to_string))));
        if let (Some(co), Some(th)) = (n(c, "cores"), n(c, "threads")) {
            rows.push(row(
                "Cores / threads",
                format!("{} / {}", fmt_num(co), fmt_num(th)),
            ));
        }
        rows.push(row(
            "Base clock",
            or_na(n(c, "baseClockMhz").map(|x| format!("{} MHz", fmt_num(x)))),
        ));
        for cache in c
            .get("caches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let level = n(cache, "level").map(fmt_num).unwrap_or_default();
            let kind = s(cache, "type").unwrap_or("");
            let label = match kind {
                "data" => format!("L{level} data cache"),
                "instruction" => format!("L{level} instruction cache"),
                _ => format!("L{level} cache"),
            };
            let size = n(cache, "sizeKb").map(fmt_num).unwrap_or_default();
            let inst = n(cache, "instances")
                .map(fmt_num)
                .unwrap_or_else(|| "1".into());
            let ways = n(cache, "ways")
                .map(|w| format!(", {}-way", fmt_num(w)))
                .unwrap_or_default();
            rows.push(row(&label, format!("{inst} × {size} KB{ways}")));
        }
        let instr: Vec<&str> = c
            .get("instructions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if !instr.is_empty() {
            rows.push(row("Instructions", instr.join(", ")));
        }
    } else {
        rows.push(row("CPU", NA));
    }
    out.push(Section { title: "CPU", rows });

    // Mainboard
    let mut rows = Vec::new();
    if spec.board.is_object() {
        let b = &spec.board;
        rows.push(row(
            "Manufacturer",
            or_na(s(b, "manufacturer").map(str::to_string)),
        ));
        rows.push(row("Model", or_na(s(b, "product").map(str::to_string))));
        rows.push(row("Version", or_na(s(b, "version").map(str::to_string))));
        rows.push(row(
            "BIOS vendor",
            or_na(s(b, "biosVendor").map(str::to_string)),
        ));
        rows.push(row(
            "BIOS version",
            or_na(s(b, "biosVersion").map(str::to_string)),
        ));
        rows.push(row(
            "BIOS date",
            or_na(s(b, "biosDate").map(str::to_string)),
        ));
        rows.push(row("Super I/O", or_na(s(b, "superIo").map(str::to_string))));
    } else {
        rows.push(row("Mainboard", NA));
    }
    out.push(Section {
        title: "Mainboard",
        rows,
    });

    // Memory
    let mut rows = Vec::new();
    let mut spd_rows = Vec::new();
    if spec.memory.is_object() {
        let m = &spec.memory;
        rows.push(row("Type", or_na(s(m, "type").map(str::to_string))));
        rows.push(row(
            "Size",
            or_na(n(m, "totalGb").map(|x| format!("{} GB", fmt_num(x)))),
        ));
        rows.push(row("Channels", or_na(n(m, "channels").map(fmt_num))));
        let used = n(m, "slotsUsed").map(fmt_num);
        let total = n(m, "slotsTotal").map(fmt_num);
        rows.push(row(
            "Slots",
            match (used, total) {
                (Some(u), Some(t)) => format!("{u} of {t} used"),
                (Some(u), None) => format!("{u} used"),
                _ => NA.to_string(),
            },
        ));
        rows.push(row(
            "MEMCLK",
            or_na(n(m, "memclkMhz").map(|x| format!("{} MHz", fmt_num(x)))),
        ));
        rows.push(row(
            "FCLK",
            or_na(n(m, "fclkMhz").map(|x| format!("{} MHz", fmt_num(x)))),
        ));
        rows.push(row(
            "UCLK",
            or_na(n(m, "uclkMhz").map(|x| format!("{} MHz", fmt_num(x)))),
        ));
        let source = s(m, "timingsSource").unwrap_or("unavailable");
        rows.push(row("Timings source", timings_label(source)));
        if let Some(note) = s(m, "timingsNote") {
            rows.push(row("Timings note", note));
        }
        if let Some(t) = m.get("timings").filter(|t| t.is_object()) {
            let c = |k: &str| n(t, k).map(fmt_num).unwrap_or_else(|| "—".into());
            rows.push(row(
                "Primary timings",
                format!(
                    "{}-{}-{}-{} (CL-tRCD-tRP-tRAS)",
                    c("cl"),
                    c("rcdRd"),
                    c("rp"),
                    c("ras")
                ),
            ));
            for (label, key) in [
                ("tRCDWR", "rcdWr"),
                ("tRC", "rc"),
                ("tRFC", "rfc"),
                ("tRRDS", "rrds"),
                ("tRRDL", "rrdl"),
                ("tFAW", "faw"),
                ("tWTRS", "wtrs"),
                ("tWTRL", "wtrl"),
                ("tWR", "wr"),
                ("tRTP", "rtp"),
                ("tCWL", "cwl"),
            ] {
                if let Some(x) = n(t, key) {
                    rows.push(row(label, fmt_num(x)));
                }
            }
            if let Some(cr) = s(t, "commandRate") {
                rows.push(row("Command rate", cr));
            }
            if let Some(g) = t.get("gearDown").and_then(Value::as_bool) {
                rows.push(row("Gear-down mode", if g { "On" } else { "Off" }));
            }
        }
        // SPD (per DIMM)
        for d in m
            .get("dimms")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            spd_rows.push(sub(s(d, "slot").unwrap_or("Module").to_string()));
            spd_rows.push(row(
                "Manufacturer",
                or_na(s(d, "manufacturer").map(str::to_string)),
            ));
            spd_rows.push(row(
                "Part number",
                or_na(s(d, "partNumber").map(str::to_string)),
            ));
            spd_rows.push(row(
                "Size",
                or_na(n(d, "sizeGb").map(|x| format!("{} GB", fmt_num(x)))),
            ));
            spd_rows.push(row(
                "Rated speed",
                or_na(n(d, "speedMts").map(|x| format!("{} MT/s", fmt_num(x)))),
            ));
            spd_rows.push(row(
                "Configured speed",
                or_na(n(d, "configuredSpeedMts").map(|x| format!("{} MT/s", fmt_num(x)))),
            ));
            spd_rows.push(row("Ranks", or_na(n(d, "ranks").map(fmt_num))));
            spd_rows.push(row(
                "Voltage",
                or_na(n(d, "voltage").map(|x| format!("{} V", fmt_num(x)))),
            ));
            spd_rows.push(row(
                "Form factor",
                or_na(s(d, "formFactor").map(str::to_string)),
            ));
            match d.get("spd").filter(|x| x.is_object()) {
                Some(spd) => {
                    if let Some(cy) = spd.get("cycles").filter(|x| x.is_object()) {
                        let c = |k: &str| n(cy, k).map(fmt_num).unwrap_or_else(|| "—".into());
                        let at = n(spd, "jedecSpeedMts")
                            .map(|x| format!(" at {} MT/s", fmt_num(x)))
                            .unwrap_or_default();
                        spd_rows.push(row(
                            "SPD JEDEC timings",
                            format!("{}-{}-{}-{}{at}", c("cl"), c("rcd"), c("rp"), c("ras")),
                        ));
                    }
                    if let Some(t) = n(spd, "tempC") {
                        spd_rows.push(row("Module temperature", format!("{} °C", fmt_num(t))));
                    }
                }
                None => spd_rows.push(row("SPD", NA)),
            }
        }
    } else {
        rows.push(row("Memory", NA));
    }
    out.push(Section {
        title: "Memory",
        rows,
    });
    if spd_rows.is_empty() {
        spd_rows.push(row("SPD", NA));
    }
    out.push(Section {
        title: "SPD",
        rows: spd_rows,
    });

    // Graphics
    let mut rows = Vec::new();
    for g in spec.gpus.as_array().into_iter().flatten() {
        rows.push(sub(s(g, "name").unwrap_or("GPU").to_string()));
        rows.push(row("Vendor", or_na(s(g, "vendor").map(str::to_string))));
        rows.push(row(
            "Memory",
            or_na(n(g, "vramGb").map(|x| format!("{} GB", fmt_num(x)))),
        ));
        rows.push(row(
            "Driver version",
            or_na(s(g, "driverVersion").map(str::to_string)),
        ));
        rows.push(row(
            "Driver date",
            or_na(s(g, "driverDate").map(str::to_string)),
        ));
        let link = g.get("link").filter(|l| l.is_object());
        rows.push(row("PCIe link", or_na(link.and_then(link_text))));
        if let Some(note) = link.and_then(|l| s(l, "note")) {
            rows.push(row("Link note", note));
        }
    }
    if rows.is_empty() {
        rows.push(row("Graphics", NA));
    }
    out.push(Section {
        title: "Graphics",
        rows,
    });

    // Storage links
    let mut rows = Vec::new();
    for l in spec.disk_links.as_array().into_iter().flatten() {
        let num = n(l, "diskNumber");
        let model = num
            .and_then(|x| {
                disks
                    .iter()
                    .find(|d| d.device_id.trim().parse::<f64>().ok() == Some(x))
                    .map(|d| d.model.trim().to_string())
                    .filter(|m| !m.is_empty())
            })
            .or_else(|| s(l, "model").map(str::to_string))
            .unwrap_or_else(|| "Disk".to_string());
        let label = match num {
            Some(x) => format!("Disk {} ({model})", fmt_num(x)),
            None => model,
        };
        let bus = s(l, "bus").unwrap_or("other");
        let value = match bus {
            "nvme" => format!("NVMe, {}", or_na(link_text(l))),
            "sata" => match n(l, "sataGen") {
                Some(g) => format!("SATA {}", fmt_num(g)),
                None => "SATA".to_string(),
            },
            "usb" => "USB".to_string(),
            _ => "Other".to_string(),
        };
        rows.push(row(&label, value));
    }
    if rows.is_empty() {
        rows.push(row("Storage links", NA));
    }
    out.push(Section {
        title: "Storage links",
        rows,
    });

    // OS & Security
    let os = &spec.os;
    let sec = &spec.security;
    let boot = chrono::DateTime::from_timestamp_millis(os.boot_ts as i64).map(|d| {
        d.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    });
    let tpm = match &sec.tpm {
        Some(t) if t.present => match &t.version {
            Some(v) if !v.trim().is_empty() => format!("Present (version {})", v.trim()),
            _ => "Present".to_string(),
        },
        Some(_) => "Not present".to_string(),
        None => "Unknown".to_string(),
    };
    let rows = vec![
        row(
            "Windows",
            or_na(Some(os.caption.trim().to_string()).filter(|x| !x.is_empty())),
        ),
        row(
            "Version",
            or_na(Some(os.display_version.trim().to_string()).filter(|x| !x.is_empty())),
        ),
        row(
            "Build",
            or_na(Some(os.build.trim().to_string()).filter(|x| !x.is_empty())),
        ),
        row(
            "Architecture",
            or_na(Some(os.architecture.trim().to_string()).filter(|x| !x.is_empty())),
        ),
        row(
            "Installed",
            or_na(Some(os.install_date.trim().to_string()).filter(|x| !x.is_empty())),
        ),
        row("Last boot", or_na(boot.filter(|_| os.boot_ts > 0))),
        row("BIOS mode", sec.bios_mode.clone()),
        row(
            "Secure Boot",
            match sec.secure_boot {
                Some(true) => "On",
                Some(false) => "Off",
                None => "Unknown",
            },
        ),
        row("TPM", tpm),
    ];
    out.push(Section {
        title: "OS & Security",
        rows,
    });

    // Notes
    let rows: Vec<Row> = spec.errors.iter().map(|e| sub(e.clone())).collect();
    out.push(Section {
        title: "Notes",
        rows: if rows.is_empty() {
            vec![sub("None")]
        } else {
            rows
        },
    });
    out
}

/// `Label ........ value` with dot leaders to [`VALUE_COLUMN`].
pub fn leader_row(label: &str, value: &str) -> String {
    let len = label.chars().count();
    let dots = VALUE_COLUMN.saturating_sub(len + 2).max(2);
    format!("{label} {} {value}", ".".repeat(dots))
}

/// The text report: UTF-8 with BOM, CRLF line ends.
pub fn render_txt(first_line: &str, sections: &[Section]) -> Vec<u8> {
    let mut t = String::new();
    t.push_str(first_line);
    t.push_str("\r\n");
    for sec in sections {
        t.push_str("\r\n");
        t.push_str(sec.title);
        t.push_str("\r\n");
        t.push_str(&"=".repeat(sec.title.chars().count()));
        t.push_str("\r\n");
        for r in &sec.rows {
            let line = match &r.value {
                Some(v) => leader_row(&r.label, &one_line(v)),
                None => one_line(&r.label),
            };
            t.push_str(&line);
            t.push_str("\r\n");
        }
    }
    let mut out = b"\xEF\xBB\xBF".to_vec();
    out.extend_from_slice(t.as_bytes());
    out
}

/// Collapses control characters so a value can never break the layout.
fn one_line(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// HTML-escapes text (`& < > " '`).
pub fn html_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in one_line(s).chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// One self-contained HTML document: inline style only, no scripts, URLs or images.
pub fn render_html(first_line: &str, sections: &[Section]) -> Vec<u8> {
    let mut h = String::from(
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"color-scheme\" content=\"light\">",
    );
    h.push_str(&format!("<title>{}</title>", html_escape(first_line)));
    h.push_str(
        "<style>body{background:#fff;color:#111;font:14px/1.45 'Segoe UI',Arial,sans-serif;\
         margin:24px;max-width:960px}h1{font-size:18px;margin:0 0 16px}\
         h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}\
         table{border-collapse:collapse;width:100%}td{padding:3px 8px;vertical-align:top;\
         border-bottom:1px solid #eee}td.l{width:32%;color:#444}tr.s td{font-weight:600;\
         padding-top:10px;color:#111}</style></head><body>",
    );
    h.push_str(&format!("<h1>{}</h1>", html_escape(first_line)));
    for sec in sections {
        h.push_str(&format!("<h2>{}</h2><table>", html_escape(sec.title)));
        for r in &sec.rows {
            match &r.value {
                Some(v) => h.push_str(&format!(
                    "<tr><td class=\"l\">{}</td><td>{}</td></tr>",
                    html_escape(&r.label),
                    html_escape(v)
                )),
                None => h.push_str(&format!(
                    "<tr class=\"s\"><td colspan=\"2\">{}</td></tr>",
                    html_escape(&r.label)
                )),
            }
        }
        h.push_str("</table>");
    }
    h.push_str("</body></html>\n");
    h.into_bytes()
}

pub fn first_line(version: &str, now: chrono::DateTime<chrono::Local>) -> String {
    format!(
        "Nexum {version} system report — {}",
        now.format("%Y-%m-%d %H:%M")
    )
}

#[tauri::command]
pub async fn save_report(app: AppHandle, format: String) -> Result<String, String> {
    let html = match format.trim().to_ascii_lowercase().as_str() {
        "txt" => false,
        "html" => true,
        _ => return Err("Unsupported report format".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let spec = crate::spec::load(&app, false);
        let disks = crate::system_info::collect_physical_disks();
        let version = app.package_info().version.to_string();
        let head = first_line(&version, chrono::Local::now());
        let secs = sections(&spec, &disks);
        let bytes = if html {
            render_html(&head, &secs)
        } else {
            render_txt(&head, &secs)
        };
        let dir = crate::safe_fs::open_documents(&["Nexum", "Reports"])
            .map_err(|e| format!("Could not save the report: {e}"))?;
        let stem = format!("nexum-report-{}", crate::util::file_timestamp());
        let (mut file, path) = dir
            .create_unique(&stem, if html { "html" } else { "txt" })
            .map_err(|e| format!("Could not save the report: {e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Could not save the report: {e}"))?;
        Ok(crate::purge_log::display_path(&path))
    })
    .await
    .map_err(|e| format!("Report failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_info::{OsSpec, SecuritySpec};
    use serde_json::json;

    fn spec() -> SystemSpec {
        SystemSpec {
            captured_ts: 1,
            cpu: json!({ "name": "AMD Ryzen 7 5700X3D <8-Core>", "vendor": "AMD", "codename": "Vermeer",
                         "socket": "AM4", "family": 25, "model": 33, "stepping": 2, "cores": 8, "threads": 16,
                         "baseClockMhz": 3000, "caches": [{ "level": 3, "type": "unified", "sizeKb": 98304, "ways": 16, "instances": 1 }],
                         "instructions": ["SSE4.2", "AVX2"] }),
            board: json!(null),
            memory: json!({ "type": "DDR4", "totalGb": 32.0, "channels": 2, "slotsUsed": 2, "slotsTotal": 4,
                            "timingsSource": "spd", "timingsNote": "Live timings need the PawnIO driver.",
                            "timings": { "cl": 19, "rcdRd": 19, "rp": 19, "ras": 43, "commandRate": null, "gearDown": null },
                            "memclkMhz": 1600, "fclkMhz": null, "uclkMhz": null,
                            "dimms": [{ "slot": "DIMM 1", "manufacturer": "Kingston", "partNumber": "KF432", "sizeGb": 16,
                                        "speedMts": 2666, "configuredSpeedMts": 3200, "ranks": 1, "voltage": 1.35, "formFactor": "DIMM",
                                        "spd": { "jedecSpeedMts": 2666, "cycles": { "cl": 19, "rcd": 19, "rp": 19, "ras": 43 }, "tempC": null } }] }),
            gpus: json!([{ "name": "AMD Radeon RX 9070 XT", "vendor": "amd", "vramGb": 16, "driverVersion": "32.0", "driverDate": "2026-10-01",
                           "link": { "gen": 4, "width": 16, "maxGen": 5, "maxWidth": 16, "source": "devpkey",
                                     "note": "Radeon cards sit behind an on-board PCIe switch; Windows may report the switch link, not the GPU link." } }]),
            os: OsSpec {
                caption: "Windows 11 Pro".into(),
                display_version: "25H2".into(),
                build: "26300".into(),
                architecture: "64-bit".into(),
                install_date: "2026-01-01".into(),
                boot_ts: 0,
            },
            security: SecuritySpec {
                secure_boot: Some(true),
                tpm: None,
                bios_mode: "UEFI".into(),
            },
            disk_links: json!([{ "diskNumber": 0, "model": "Samsung", "bus": "nvme", "gen": 3, "width": 4, "maxGen": 4, "maxWidth": 4, "sataGen": null }]),
            errors: vec!["Board query failed: <x>".into()],
        }
    }

    #[test]
    fn sections_follow_the_system_view() {
        let secs = sections(&spec(), &[]);
        let titles: Vec<&str> = secs.iter().map(|s| s.title).collect();
        assert_eq!(
            titles,
            vec![
                "CPU",
                "Mainboard",
                "Memory",
                "SPD",
                "Graphics",
                "Storage links",
                "OS & Security",
                "Notes"
            ]
        );
        let mem = &secs[2].rows;
        assert!(mem.contains(&row(
            "Timings source",
            "SPD JEDEC (not the running timings)"
        )));
        assert!(mem.contains(&row("Timings note", "Live timings need the PawnIO driver.")));
        assert!(mem.contains(&row("Primary timings", "19-19-19-43 (CL-tRCD-tRP-tRAS)")));
        assert!(mem.contains(&row("MEMCLK", "1600 MHz")));
        assert!(mem.contains(&row("FCLK", NA)));
        assert!(secs[3]
            .rows
            .contains(&row("SPD JEDEC timings", "19-19-19-43 at 2666 MT/s")));
        assert!(secs[4]
            .rows
            .contains(&row("PCIe link", "PCIe 4 x16 (max PCIe 5 x16)")));
        assert!(secs[5]
            .rows
            .contains(&row("Disk 0 (Samsung)", "NVMe, PCIe 3 x4 (max PCIe 4 x4)")));
        assert!(secs[0]
            .rows
            .contains(&row("Family / model / stepping", "19h / 21h / 2")));
        assert!(secs[0]
            .rows
            .contains(&row("L3 cache", "1 × 98304 KB, 16-way")));
        assert_eq!(secs[1].rows, vec![row("Mainboard", NA)]);
    }

    #[test]
    fn txt_has_bom_crlf_and_dot_leaders() {
        let bytes = render_txt(
            "Nexum 1.1.0 system report — 2026-11-27 12:00",
            &sections(&spec(), &[]),
        );
        assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.contains("\r\nCPU\r\n===\r\n"));
        assert!(
            !text.replace("\r\n", "").contains('\n'),
            "only CRLF line ends"
        );
        let line = leader_row("Name", "x");
        assert_eq!(
            line.find('x'),
            Some(VALUE_COLUMN),
            "values start at column 33 (after the leaders to column 32)"
        );
        assert!(line.starts_with("Name ....."));
        assert!(leader_row(&"L".repeat(40), "v").contains(" .. v"));
    }

    #[test]
    fn html_is_escaped_and_self_contained() {
        let html = String::from_utf8(render_html("Nexum <1.1>", &sections(&spec(), &[]))).unwrap();
        assert!(html.contains("AMD Ryzen 7 5700X3D &lt;8-Core&gt;"));
        assert!(html.contains("Board query failed: &lt;x&gt;"));
        assert!(html.contains("<title>Nexum &lt;1.1&gt;</title>"));
        let lower = html.to_ascii_lowercase();
        for banned in [
            "<script", "http:", "https:", "<img", "src=", "url(", "<link", "@import",
        ] {
            assert!(!lower.contains(banned), "{banned}");
        }
        assert_eq!(html_escape(r#"a&"b'"#), "a&amp;&quot;b&#39;");
    }

    #[test]
    fn report_has_no_serials() {
        let mut sp = spec();
        sp.memory["dimms"][0]["serial"] = json!("SERIAL-123");
        let text = String::from_utf8(render_txt("x", &sections(&sp, &[]))).unwrap();
        assert!(!text.contains("SERIAL-123"));
    }
}
