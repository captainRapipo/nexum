//! CSV sensor logging (CONTRACT §2.9). Rust samples the `sensorValues` lines it already
//! forwards (never the WebView, never a second agent stream) and writes
//! `<Documents>\Nexum\Logs\nexum-YYYYMMDD-HHMMSS.csv` through [`crate::safe_fs::PinnedDir`].
//!
//! Format: UTF-8 with BOM, `\r\n`, RFC 4180 quoting; numbers in invariant culture (`.` decimal
//! separator, no thousands separator) with exactly the sensor's decimals; null → empty field.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, SENSOR_LOG_INTERVALS};
use crate::state::AppState;
use crate::util::{lock, now_ms};

/// Rows between flushes.
const FLUSH_EVERY: u32 = 10;
/// A file is rotated once it reaches this size (checked at each flush).
const ROTATE_BYTES: u64 = 100 * 1024 * 1024;
/// Max ids accepted from an explicit list.
const MAX_IDS: usize = 500;
/// A packet this close to the interval still writes a row (agent tick jitter).
const CADENCE_SLACK_MS: u64 = 250;

/// `SensorLogStatus`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorLogStatus {
    pub active: bool,
    pub path: Option<String>,
    pub folder: String,
    pub rows: u64,
    pub total_rows: u64,
    pub started_ts: Option<u64>,
    pub interval_ms: u64,
    pub sensor_count: u64,
    pub error: Option<String>,
}

/// One logged column: fixed at start (CONTRACT §2.9).
#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub id: String,
    pub header: String,
    pub decimals: u32,
}

struct ActiveLog {
    out: BufWriter<File>,
    columns: Vec<Column>,
    /// Column → `idx` in the current tree (`None` = the sensor vanished).
    map: Vec<Option<usize>>,
    rev: Option<u64>,
    last_row_ts: Option<u64>,
    unflushed: u32,
    bytes: u64,
    header_line: String,
}

#[derive(Default)]
struct Inner {
    status: Option<SensorLogStatus>,
    log: Option<ActiveLog>,
}

#[derive(Default)]
pub struct SensorLogger {
    inner: Mutex<Inner>,
    active: AtomicBool,
    interval_ms: AtomicU64,
}

impl SensorLogger {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// The log interval while a log runs (for the hidden poll interval).
    pub fn active_interval(&self) -> Option<u64> {
        self.is_active()
            .then(|| self.interval_ms.load(Ordering::SeqCst))
            .filter(|ms| *ms > 0)
    }
}

// ---------------------------------------------------------------------------------------------
// Pure formatting (unit-tested)
// ---------------------------------------------------------------------------------------------

/// RFC 4180: a field containing `,`, `"`, CR or LF is quoted, `"` doubled.
pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// A text cell that a spreadsheet app could read as a formula (OWASP "CSV injection": a cell
/// starting with `=`, `+`, `-`, `@`, tab or CR, also after leading spaces, or with their
/// full-width forms) gets a leading `'`, so it is shown as text. Header cells carry hardware
/// names (firmware strings) and user labels; data cells are numbers Nexum formats itself and
/// never go through this.
pub fn csv_text(s: &str) -> String {
    let first = s.trim_start_matches(' ').chars().next();
    if matches!(
        first,
        Some('=' | '+' | '-' | '@' | '\t' | '\r' | '\u{FF1D}' | '\u{FF0B}' | '\u{FF0D}' | '\u{FF20}')
    ) {
        format!("'{s}")
    } else {
        s.to_string()
    }
}

/// `<HardwareNode.name> | <label> [<unit>]` (` [<unit>]` omitted for an empty unit).
pub fn column_header(hardware: &str, label: &str, unit: &str) -> String {
    if unit.is_empty() {
        format!("{hardware} | {label}")
    } else {
        format!("{hardware} | {label} [{unit}]")
    }
}

/// Invariant-culture number with exactly `decimals` decimals; non-finite → empty.
pub fn fmt_value(v: Option<f64>, decimals: u32) -> String {
    match v {
        Some(x) if x.is_finite() => {
            let s = format!("{:.*}", decimals.min(9) as usize, x);
            // "-0.0" after rounding reads as a negative reading.
            if s.starts_with('-') && s[1..].chars().all(|c| c == '0' || c == '.') {
                s[1..].to_string()
            } else {
                s
            }
        }
        _ => String::new(),
    }
}

/// `Date,Time,<col>,…` + CRLF.
pub fn header_line(columns: &[Column]) -> String {
    let mut line = String::from("Date,Time");
    for c in columns {
        line.push(',');
        line.push_str(&csv_field(&csv_text(&c.header)));
    }
    line.push_str("\r\n");
    line
}

/// One data row + CRLF. `values` = the packet's `value` array; `map` = column → idx.
pub fn row_line(
    date: &str,
    time: &str,
    columns: &[Column],
    map: &[Option<usize>],
    values: &[Value],
) -> String {
    let mut line = format!("{date},{time}");
    for (i, c) in columns.iter().enumerate() {
        line.push(',');
        let v = map
            .get(i)
            .copied()
            .flatten()
            .and_then(|idx| values.get(idx))
            .and_then(Value::as_f64);
        line.push_str(&fmt_value(v, c.decimals));
    }
    line.push_str("\r\n");
    line
}

/// Local `YYYY-MM-DD` and `HH:MM:SS` of a unix-ms timestamp.
pub fn local_date_time(ts: u64) -> (String, String) {
    match chrono::DateTime::from_timestamp_millis(ts as i64) {
        Some(d) => {
            let l = d.with_timezone(&chrono::Local);
            (
                l.format("%Y-%m-%d").to_string(),
                l.format("%H:%M:%S").to_string(),
            )
        }
        None => (String::new(), String::new()),
    }
}

/// A sensor of the tree: `(id, idx, hardware name, sensor meta)`.
fn tree_sensors(tree: &Value) -> Vec<(String, usize, String, &Value)> {
    let mut out = Vec::new();
    for hw in tree
        .get("hardware")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let hw_name = hw
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        for s in hw
            .get("sensors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(id), Some(idx)) = (
                s.get("id").and_then(Value::as_str),
                s.get("idx").and_then(Value::as_u64),
            ) else {
                continue;
            };
            out.push((id.to_string(), idx as usize, hw_name.clone(), s));
        }
    }
    out
}

/// The column set for `ids` (CONTRACT §2.9): `None` → every non-static, non-default-hidden,
/// non-user-hidden sensor in tree order; a list → those ids in order (unknown dropped, ≤ 500).
pub fn select_columns(
    tree: &Value,
    ids: Option<&[String]>,
    hidden: &[String],
    labels: &std::collections::BTreeMap<String, String>,
) -> Vec<Column> {
    let sensors = tree_sensors(tree);
    let make = |(id, _, hw, meta): &(String, usize, String, &Value)| {
        let name = meta.get("name").and_then(Value::as_str).unwrap_or("");
        let label = labels.get(id).map(String::as_str).unwrap_or(name);
        let unit = meta.get("unit").and_then(Value::as_str).unwrap_or("");
        Column {
            id: id.clone(),
            header: column_header(hw, label, unit),
            decimals: meta.get("decimals").and_then(Value::as_u64).unwrap_or(1) as u32,
        }
    };
    match ids {
        None => {
            let mut list: Vec<&(String, usize, String, &Value)> = sensors
                .iter()
                .filter(|(id, _, _, m)| {
                    m.get("static").and_then(Value::as_bool) != Some(true)
                        && m.get("defaultHidden").and_then(Value::as_bool) != Some(true)
                        && !hidden.iter().any(|h| h == id)
                })
                .collect();
            list.sort_by_key(|s| s.1);
            list.into_iter().map(make).collect()
        }
        Some(wanted) => {
            let by_id: HashMap<&str, &(String, usize, String, &Value)> =
                sensors.iter().map(|s| (s.0.as_str(), s)).collect();
            let mut out: Vec<Column> = Vec::new();
            for id in wanted {
                if out.len() >= MAX_IDS {
                    break;
                }
                let id = id.trim();
                if out.iter().any(|c| c.id == id) {
                    continue;
                }
                if let Some(s) = by_id.get(id) {
                    out.push(make(*s));
                }
            }
            out
        }
    }
}

/// Column → `idx` in `tree` (re-mapped by id on every new tree).
pub fn map_columns(columns: &[Column], tree: &Value) -> Vec<Option<usize>> {
    let by_id: HashMap<String, usize> = tree_sensors(tree)
        .into_iter()
        .map(|(id, idx, _, _)| (id, idx))
        .collect();
    columns.iter().map(|c| by_id.get(&c.id).copied()).collect()
}

/// Row cadence: the first packet always writes; later ones once `interval − 250 ms` passed.
pub fn row_due(last_row_ts: Option<u64>, ts: u64, interval_ms: u64) -> bool {
    match last_row_ts {
        None => true,
        Some(last) => ts.saturating_sub(last) >= interval_ms.saturating_sub(CADENCE_SLACK_MS),
    }
}

// ---------------------------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------------------------

fn folder_display() -> String {
    crate::safe_fs::documents_path(&["Nexum", "Logs"])
        .map(|p| crate::purge_log::display_path(&p))
        .unwrap_or_default()
}

fn initial_status(app: &AppHandle) -> SensorLogStatus {
    SensorLogStatus {
        active: false,
        path: None,
        folder: folder_display(),
        rows: 0,
        total_rows: 0,
        started_ts: None,
        interval_ms: lock(&app.state::<AppState>().settings).sensor_log_interval_ms,
        sensor_count: 0,
        error: None,
    }
}

/// Opens a new CSV file (BOM + header). Returns the writer, its path and the bytes written.
fn open_file(header: &str) -> Result<(BufWriter<File>, PathBuf, u64), String> {
    let dir = crate::safe_fs::open_documents(&["Nexum", "Logs"])
        .map_err(|e| format!("Could not create the sensor log: {e}."))?;
    let stem = format!("nexum-{}", crate::util::file_timestamp());
    let (file, path) = dir
        .create_unique(&stem, "csv")
        .map_err(|e| format!("Could not create the sensor log: {e}."))?;
    drop(dir);
    let mut out = BufWriter::new(file);
    let mut bytes = 0u64;
    for chunk in [&b"\xEF\xBB\xBF"[..], header.as_bytes()] {
        out.write_all(chunk)
            .map_err(|e| format!("Could not write the sensor log: {e}."))?;
        bytes += chunk.len() as u64;
    }
    out.flush()
        .map_err(|e| format!("Could not write the sensor log: {e}."))?;
    Ok((out, path, bytes))
}

fn emit(app: &AppHandle, status: &SensorLogStatus) {
    let _ = app.emit("sensor-log", status.clone());
}

/// Side effects of a start/stop: stream, poll interval, tray label.
fn after_toggle(app: &AppHandle, active: bool) {
    crate::agent::sync_sensor_stream(app, false);
    crate::agent::apply_interval(app);
    crate::set_tray_log_label(app, active);
}

/// Current status (initial status before the first log).
pub fn status(app: &AppHandle) -> SensorLogStatus {
    let state = app.state::<AppState>();
    let mut inner = lock(&state.sensor_log.inner);
    if inner.status.is_none() {
        inner.status = Some(initial_status(app));
    }
    let mut s = inner.status.clone().unwrap_or_else(|| initial_status(app));
    if !s.active {
        s.interval_ms = lock(&state.settings).sensor_log_interval_ms;
    }
    s
}

pub fn start(
    app: &AppHandle,
    interval_ms: Option<u64>,
    ids: Option<Vec<String>>,
) -> Result<SensorLogStatus, String> {
    let state = app.state::<AppState>();
    let interval = match interval_ms {
        Some(ms) if SENSOR_LOG_INTERVALS.contains(&ms) => ms,
        Some(_) => return Err("Unsupported log interval".to_string()),
        None => lock(&state.settings).sensor_log_interval_ms,
    };
    if state.sensor_log.is_active() {
        return Err("A sensor log is already running".to_string());
    }
    let tree = state
        .agent
        .sensor_tree()
        .ok_or_else(|| "Sensor data is not available yet".to_string())?;
    let (hidden, labels) = {
        let s = lock(&state.settings);
        (s.hidden_sensors.clone(), s.sensor_labels.clone())
    };
    let columns = select_columns(&tree, ids.as_deref(), &hidden, &labels);
    if columns.is_empty() {
        return Err("No sensors to log".to_string());
    }
    if interval_ms.is_some() {
        if let Err(e) = settings::update_settings(app, |s| s.sensor_log_interval_ms = interval) {
            eprintln!("[nexum] could not save the log interval: {e}");
        }
    }
    let header = header_line(&columns);
    let (out, path, bytes) = open_file(&header)?;
    let map = map_columns(&columns, &tree);
    let rev = tree.get("rev").and_then(Value::as_u64);
    let status = SensorLogStatus {
        active: true,
        path: Some(crate::purge_log::display_path(&path)),
        folder: path
            .parent()
            .map(crate::purge_log::display_path)
            .unwrap_or_else(folder_display),
        rows: 0,
        total_rows: 0,
        started_ts: Some(now_ms()),
        interval_ms: interval,
        sensor_count: columns.len() as u64,
        error: None,
    };
    {
        let mut inner = lock(&state.sensor_log.inner);
        if inner.log.is_some() {
            return Err("A sensor log is already running".to_string());
        }
        inner.log = Some(ActiveLog {
            out,
            columns,
            map,
            rev,
            last_row_ts: None,
            unflushed: 0,
            bytes,
            header_line: header,
        });
        inner.status = Some(status.clone());
        state
            .sensor_log
            .interval_ms
            .store(interval, Ordering::SeqCst);
        state.sensor_log.active.store(true, Ordering::SeqCst);
    }
    emit(app, &status);
    after_toggle(app, true);
    Ok(status)
}

/// Stops the log (flush + close). `error` is set when a write failure stopped it.
fn stop_inner(app: &AppHandle, error: Option<String>) -> SensorLogStatus {
    let state = app.state::<AppState>();
    let (status, was_active) = {
        let mut inner = lock(&state.sensor_log.inner);
        let mut status = inner.status.clone().unwrap_or_else(|| initial_status(app));
        let was_active = inner.log.is_some();
        let mut error = error;
        if let Some(mut log) = inner.log.take() {
            if let Err(e) = log.out.flush() {
                error.get_or_insert(format!("Could not write the sensor log: {e}."));
            }
        }
        state.sensor_log.active.store(false, Ordering::SeqCst);
        status.active = false;
        if was_active {
            status.error = error;
        }
        inner.status = Some(status.clone());
        (status, was_active)
    };
    if was_active {
        emit(app, &status);
        after_toggle(app, false);
    }
    status
}

pub fn stop(app: &AppHandle) -> SensorLogStatus {
    stop_inner(app, None)
}

/// A new sensor tree: re-map the fixed columns by id (vanished sensors write empty cells).
pub fn on_tree(app: &AppHandle, tree: &Value) {
    let state = app.state::<AppState>();
    if !state.sensor_log.is_active() {
        return;
    }
    let mut inner = lock(&state.sensor_log.inner);
    if let Some(log) = inner.log.as_mut() {
        log.map = map_columns(&log.columns, tree);
        log.rev = tree.get("rev").and_then(Value::as_u64);
    }
}

enum Outcome {
    Nothing,
    Flushed(SensorLogStatus),
    Failed(String),
}

/// A `sensorValues` packet: write a row when one is due.
pub fn on_values(app: &AppHandle, values: &Value) {
    let state = app.state::<AppState>();
    if !state.sensor_log.is_active() {
        return;
    }
    let interval = state.sensor_log.interval_ms.load(Ordering::SeqCst);
    let outcome = {
        let mut inner = lock(&state.sensor_log.inner);
        let Inner { status, log } = &mut *inner;
        let (Some(log), Some(status)) = (log.as_mut(), status.as_mut()) else {
            return;
        };
        // Values of another tree revision cannot be mapped (the agent re-sends the tree first).
        if values.get("rev").and_then(Value::as_u64) != log.rev {
            return;
        }
        let ts = values
            .get("ts")
            .and_then(Value::as_u64)
            .unwrap_or_else(now_ms);
        if !row_due(log.last_row_ts, ts, interval) {
            return;
        }
        let empty = Vec::new();
        let arr = values
            .get("value")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let (date, time) = local_date_time(ts);
        let line = row_line(&date, &time, &log.columns, &log.map, arr);
        match log.out.write_all(line.as_bytes()) {
            Err(e) => Outcome::Failed(format!("Could not write the sensor log: {e}.")),
            Ok(()) => {
                log.bytes += line.len() as u64;
                log.last_row_ts = Some(ts);
                log.unflushed += 1;
                status.rows += 1;
                status.total_rows += 1;
                if log.unflushed < FLUSH_EVERY {
                    Outcome::Nothing
                } else {
                    log.unflushed = 0;
                    match log.out.flush() {
                        Err(e) => Outcome::Failed(format!("Could not write the sensor log: {e}.")),
                        Ok(()) if log.bytes >= ROTATE_BYTES => match open_file(&log.header_line) {
                            Ok((out, path, bytes)) => {
                                // The old writer is flushed; dropping it closes the file.
                                log.out = out;
                                log.bytes = bytes;
                                status.path = Some(crate::purge_log::display_path(&path));
                                status.rows = 0;
                                Outcome::Flushed(status.clone())
                            }
                            Err(e) => Outcome::Failed(e),
                        },
                        Ok(()) => Outcome::Flushed(status.clone()),
                    }
                }
            }
        }
    };
    match outcome {
        Outcome::Nothing => {}
        Outcome::Flushed(s) => emit(app, &s),
        Outcome::Failed(e) => {
            eprintln!("[nexum] {e}");
            stop_inner(app, Some(e));
        }
    }
}

/// App exit: a log never survives a restart of Nexum.
pub fn shutdown(app: &AppHandle) {
    if app.state::<AppState>().sensor_log.is_active() {
        stop(app);
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// Interval argument from the UI: a whole number of ms.
fn interval_arg(ms: Option<f64>) -> Result<Option<u64>, String> {
    match ms {
        None => Ok(None),
        Some(v) if v.is_finite() && v > 0.0 && v.fract() == 0.0 => Ok(Some(v as u64)),
        Some(_) => Err("Unsupported log interval".to_string()),
    }
}

#[tauri::command]
pub async fn start_sensor_log(
    app: AppHandle,
    interval_ms: Option<f64>,
    ids: Option<Vec<String>>,
) -> Result<SensorLogStatus, String> {
    let interval = interval_arg(interval_ms)?;
    tauri::async_runtime::spawn_blocking(move || start(&app, interval, ids))
        .await
        .map_err(|e| format!("Sensor log failed: {e}"))?
}

#[tauri::command]
pub async fn stop_sensor_log(app: AppHandle) -> Result<SensorLogStatus, String> {
    tauri::async_runtime::spawn_blocking(move || stop(&app))
        .await
        .map_err(|e| format!("Sensor log failed: {e}"))
}

#[tauri::command]
pub async fn get_sensor_log_status(app: AppHandle) -> Result<SensorLogStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|e| format!("Sensor log failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn tree() -> Value {
        json!({
            "type": "sensorTree", "rev": 2, "sessionStartTs": 1,
            "hardware": [
                { "id": "/amdcpu/0", "parentId": null, "kind": "cpu", "name": "AMD Ryzen 7 5700X3D",
                  "sensors": [
                    { "id": "/amdcpu/0/temperature/2", "idx": 0, "hwId": "/amdcpu/0", "name": "Core (Tctl/Tdie)",
                      "kind": "temperature", "unit": "°C", "decimals": 1, "static": false, "defaultHidden": false },
                    { "id": "/amdcpu/0/factor/0", "idx": 1, "hwId": "/amdcpu/0", "name": "Ratio, \"x\"",
                      "kind": "factor", "unit": "", "decimals": 2, "static": false, "defaultHidden": false },
                    { "id": "/amdcpu/0/timing/0", "idx": 2, "hwId": "/amdcpu/0", "name": "Bus",
                      "kind": "timing", "unit": "ns", "decimals": 2, "static": true, "defaultHidden": false }
                  ] },
                { "id": "/lpc/it8688e/0", "parentId": "/motherboard", "kind": "superio", "name": "ITE IT8688E",
                  "sensors": [
                    { "id": "/lpc/it8688e/0/fan/0", "idx": 3, "hwId": "/lpc/it8688e/0", "name": "Fan #1",
                      "kind": "fan", "unit": "RPM", "decimals": 0, "static": false, "defaultHidden": false },
                    { "id": "/lpc/it8688e/0/fan/4", "idx": 4, "hwId": "/lpc/it8688e/0", "name": "Fan #5",
                      "kind": "fan", "unit": "RPM", "decimals": 0, "static": false, "defaultHidden": true }
                  ] }
            ]
        })
    }

    #[test]
    fn csv_quoting() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
        assert_eq!(csv_field("cr\r"), "\"cr\r\"");
    }

    #[test]
    fn formula_like_headers_are_neutralised() {
        for bad in [
            "=HYPERLINK(\"x\")",
            "+1",
            "-2+3",
            "@SUM(A1)",
            "\tx",
            "\rx",
            "  =1+1",
            "\u{FF1D}1",
        ] {
            assert!(csv_text(bad).starts_with('\''), "{bad:?}");
        }
        assert_eq!(csv_text("AMD Ryzen 7"), "AMD Ryzen 7");
        assert_eq!(csv_text(""), "");
        let cols = vec![Column {
            id: "/x".into(),
            header: column_header("=cmd|' /C calc'!A0", "Fan, \"1\"", "RPM"),
            decimals: 0,
        }];
        assert_eq!(
            header_line(&cols),
            "Date,Time,\"'=cmd|' /C calc'!A0 | Fan, \"\"1\"\" [RPM]\"\r\n"
        );
        // Numbers are never prefixed: a negative reading stays a number.
        assert_eq!(fmt_value(Some(-3.0), 0), "-3");
    }

    #[test]
    fn explicit_ids_are_trimmed_before_dedupe() {
        let ids = vec![
            "/amdcpu/0/temperature/2".to_string(),
            " /amdcpu/0/temperature/2 ".to_string(),
        ];
        let cols = select_columns(&tree(), Some(&ids), &[], &BTreeMap::new());
        assert_eq!(cols.len(), 1);
    }

    #[test]
    fn header_uses_labels_units_and_quoting() {
        let mut labels = BTreeMap::new();
        labels.insert(
            "/lpc/it8688e/0/fan/0".to_string(),
            "CPU fan, front".to_string(),
        );
        let cols = select_columns(&tree(), None, &[], &labels);
        let ids: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
        // Static and default-hidden sensors are left out; tree order.
        assert_eq!(
            ids,
            vec![
                "/amdcpu/0/temperature/2",
                "/amdcpu/0/factor/0",
                "/lpc/it8688e/0/fan/0"
            ]
        );
        assert_eq!(
            header_line(&cols),
            "Date,Time,AMD Ryzen 7 5700X3D | Core (Tctl/Tdie) [°C],\"AMD Ryzen 7 5700X3D | Ratio, \"\"x\"\"\",\"ITE IT8688E | CPU fan, front [RPM]\"\r\n"
        );
        // User-hidden ids are left out too.
        let cols = select_columns(
            &tree(),
            None,
            &["/amdcpu/0/factor/0".to_string()],
            &BTreeMap::new(),
        );
        assert_eq!(cols.len(), 2);
    }

    #[test]
    fn explicit_ids_keep_order_and_drop_unknown() {
        let ids = vec![
            "/lpc/it8688e/0/fan/4".to_string(),
            "/nope".to_string(),
            "/amdcpu/0/timing/0".to_string(),
            "/lpc/it8688e/0/fan/4".to_string(),
        ];
        let cols = select_columns(&tree(), Some(&ids), &[], &BTreeMap::new());
        let got: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(got, vec!["/lpc/it8688e/0/fan/4", "/amdcpu/0/timing/0"]);
        let many: Vec<String> = (0..600)
            .map(|_| "/amdcpu/0/temperature/2".to_string())
            .collect();
        assert_eq!(
            select_columns(&tree(), Some(&many), &[], &BTreeMap::new()).len(),
            1
        );
    }

    #[test]
    fn rows_are_invariant_and_remapped() {
        let cols = select_columns(&tree(), None, &[], &BTreeMap::new());
        let map = map_columns(&cols, &tree());
        assert_eq!(map, vec![Some(0), Some(1), Some(3)]);
        let values = vec![json!(52.06), json!(-0.001), json!(null), json!(1234.6)];
        assert_eq!(
            row_line("2026-11-27", "12:00:01", &cols, &map, &values),
            "2026-11-27,12:00:01,52.1,0.00,1235\r\n"
        );
        // A new tree where the factor sensor vanished: its cell stays empty.
        let mut t2 = tree();
        t2["hardware"][0]["sensors"]
            .as_array_mut()
            .unwrap()
            .remove(1);
        let map2 = map_columns(&cols, &t2);
        assert_eq!(map2, vec![Some(0), None, Some(3)]);
        assert_eq!(
            row_line("d", "t", &cols, &map2, &values),
            "d,t,52.1,,1235\r\n"
        );
        assert_eq!(fmt_value(Some(1234567.891), 1), "1234567.9");
        assert_eq!(fmt_value(Some(f64::NAN), 1), "");
        assert_eq!(fmt_value(None, 0), "");
        assert_eq!(fmt_value(Some(-3.26), 1), "-3.3");
        assert_eq!(column_header("Disk", "Data Read", ""), "Disk | Data Read");
    }

    #[test]
    fn cadence() {
        assert!(row_due(None, 5, 1000));
        assert!(!row_due(Some(1000), 1500, 1000));
        assert!(row_due(Some(1000), 1750, 1000), "250 ms slack");
        assert!(!row_due(Some(1000), 5000, 5000));
        assert!(row_due(Some(1000), 5800, 5000));
    }

    #[test]
    fn interval_argument() {
        assert_eq!(interval_arg(None), Ok(None));
        assert_eq!(interval_arg(Some(2000.0)), Ok(Some(2000)));
        assert!(interval_arg(Some(1.5)).is_err());
        assert!(interval_arg(Some(-1.0)).is_err());
    }
}
