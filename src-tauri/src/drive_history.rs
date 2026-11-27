//! Drive wear ledger and forecast (CONTRACT §2.11): one JSON line per (drive serial, local
//! date) in `%LOCALAPPDATA%\Nexum\history\drives.jsonl`, written through
//! [`crate::safe_fs::PinnedDir`] (never through a link), and an OLS forecast per drive.
//!
//! The serial is stored in clear in this local file only; it never appears in exports or
//! reports.

use std::collections::{BTreeMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::util::{lock, now_ms};

const FILE_NAME: &str = "drives.jsonl";
const SNAPSHOT_EVERY: Duration = Duration::from_secs(600);
const DAYS_PER_MONTH: f64 = 30.4375;
/// Forecast minimums: points and span in days.
const MIN_POINTS: usize = 7;
const MIN_DAYS: i64 = 14;
const HORIZON_MONTHS: f64 = 600.0;
/// A slope at or above this (%/day) counts as "no measurable wear".
const NO_WEAR_SLOPE: f64 = -0.001;
/// At most this much of the ledger is read (its tail): ~70 KB per drive per year, so 16 MiB
/// covers decades of several drives.
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Default)]
pub struct DriveLedger {
    inner: Mutex<LedgerInner>,
    busy: AtomicBool,
}

#[derive(Default)]
struct LedgerInner {
    /// `(normSerial, date)` pairs already in the file (loaded once).
    seen: Option<HashSet<(String, String)>>,
    last_snapshot: Option<Instant>,
}

/// One ledger line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerLine {
    pub v: u32,
    pub date: String,
    pub ts: u64,
    pub serial: String,
    pub model: String,
    pub health_pct: Option<f64>,
    pub percentage_used: Option<f64>,
    pub data_written_tb: Option<f64>,
    pub data_read_tb: Option<f64>,
    pub power_on_hours: Option<f64>,
    pub available_spare_pct: Option<f64>,
    pub media_errors: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveHistoryPoint {
    pub date: String,
    pub health_pct: Option<f64>,
    pub data_written_tb: Option<f64>,
    pub power_on_hours: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveForecast {
    pub tb_per_month: Option<f64>,
    pub months_to10_pct: Option<f64>,
    pub basis_days: i64,
    pub points: usize,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveHistory {
    pub serial: String,
    pub points: Vec<DriveHistoryPoint>,
    pub forecast: DriveForecast,
}

/// CONTRACT §1.1.3: remove whitespace, `.`, `_`, `-`; uppercase; empty → `None`.
pub fn norm_serial(s: &str) -> Option<String> {
    let n: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '.' | '_' | '-'))
        .flat_map(char::to_uppercase)
        .collect();
    (!n.is_empty()).then_some(n)
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// Ledger lines for the disks of a telemetry packet that qualify (serial + some wear data).
pub fn lines_for_packet(packet: &Value, date: &str, ts: u64) -> Vec<LedgerLine> {
    let mut out = Vec::new();
    for d in packet
        .get("disks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(serial) = d
            .get("serial")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| norm_serial(s).is_some())
        else {
            continue;
        };
        let health = num(d, "healthPct");
        let tbw = num(d, "tbw");
        let hours = num(d, "powerOnHours");
        if health.is_none() && tbw.is_none() && hours.is_none() {
            continue;
        }
        out.push(LedgerLine {
            v: 1,
            date: date.to_string(),
            ts,
            serial: serial.to_string(),
            model: d
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
            health_pct: health,
            percentage_used: num(d, "percentageUsed"),
            data_written_tb: tbw,
            data_read_tb: num(d, "dataReadTb"),
            power_on_hours: hours,
            available_spare_pct: num(d, "availableSparePct"),
            media_errors: num(d, "mediaErrors"),
        });
    }
    out
}

/// Parses the ledger text; corrupt lines are skipped.
pub fn parse_lines(text: &str) -> Vec<LedgerLine> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<LedgerLine>(l.trim()).ok())
        .filter(|l| NaiveDate::parse_from_str(&l.date, "%Y-%m-%d").is_ok())
        .collect()
}

/// Points of one drive: matched by normalized serial, sorted by date, last line per date wins.
pub fn points_for(lines: &[LedgerLine], serial: &str) -> Vec<DriveHistoryPoint> {
    let Some(want) = norm_serial(serial) else {
        return Vec::new();
    };
    let mut by_date: BTreeMap<String, DriveHistoryPoint> = BTreeMap::new();
    for l in lines {
        if norm_serial(&l.serial).as_deref() != Some(want.as_str()) {
            continue;
        }
        by_date.insert(
            l.date.clone(),
            DriveHistoryPoint {
                date: l.date.clone(),
                health_pct: l.health_pct,
                data_written_tb: l.data_written_tb,
                power_on_hours: l.power_on_hours,
            },
        );
    }
    by_date.into_values().collect()
}

/// Ordinary-least-squares slope of `y` over `x` (`None` for fewer than two distinct x).
pub fn ols_slope(pts: &[(f64, f64)]) -> Option<f64> {
    let n = pts.len() as f64;
    if pts.len() < 2 {
        return None;
    }
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
    if sxx <= 0.0 {
        return None;
    }
    let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    Some(sxy / sxx)
}

fn round_to(v: f64, decimals: i32) -> f64 {
    let f = 10f64.powi(decimals);
    (v * f).round() / f
}

/// CONTRACT §2.11 forecast over the points of the last 365 days before `today`.
pub fn forecast(points: &[DriveHistoryPoint], today: NaiveDate) -> DriveForecast {
    let from = today - chrono::Duration::days(365);
    let basis: Vec<(NaiveDate, &DriveHistoryPoint)> = points
        .iter()
        .filter_map(|p| {
            NaiveDate::parse_from_str(&p.date, "%Y-%m-%d")
                .ok()
                .filter(|d| *d >= from && *d <= today)
                .map(|d| (d, p))
        })
        .collect();
    let first = basis.iter().map(|b| b.0).min();
    let last = basis.iter().map(|b| b.0).max();
    let basis_days = match (first, last) {
        (Some(f), Some(l)) => (l - f).num_days(),
        _ => 0,
    };
    let count = basis.len();
    let mut out = DriveForecast {
        tb_per_month: None,
        months_to10_pct: None,
        basis_days,
        points: count,
        status: "ok",
    };
    if count < MIN_POINTS || basis_days < MIN_DAYS {
        out.status = "notEnoughData";
        return out;
    }
    let first = first.unwrap_or(today);
    let x = |d: NaiveDate| (d - first).num_days() as f64;

    let written: Vec<(f64, f64)> = basis
        .iter()
        .filter_map(|(d, p)| p.data_written_tb.map(|v| (x(*d), v)))
        .collect();
    if written.len() >= MIN_POINTS {
        out.tb_per_month = ols_slope(&written).map(|m| round_to((m * DAYS_PER_MONTH).max(0.0), 2));
    }

    let mut life: Vec<(NaiveDate, f64)> = basis
        .iter()
        .filter_map(|(d, p)| p.health_pct.map(|v| (*d, v)))
        .collect();
    life.sort_by_key(|l| l.0);
    if life.len() < MIN_POINTS {
        out.status = "noLifeData";
        return out;
    }
    let pts: Vec<(f64, f64)> = life.iter().map(|(d, v)| (x(*d), *v)).collect();
    let Some(m) = ols_slope(&pts) else {
        out.status = "noLifeData";
        return out;
    };
    let h = life.last().map(|l| l.1).unwrap_or(100.0);
    if h <= 10.0 {
        out.months_to10_pct = Some(0.0);
    } else if m >= NO_WEAR_SLOPE {
        out.status = "noWear";
    } else {
        let months = (h - 10.0) / (-m) / DAYS_PER_MONTH;
        if months > HORIZON_MONTHS {
            out.status = "beyondHorizon";
        } else {
            out.months_to10_pct = Some(round_to(months, 1));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------------------------

fn open_dir() -> io::Result<crate::safe_fs::PinnedDir> {
    crate::safe_fs::open_local_appdata(&["Nexum", "history"])
}

/// Reads ledger text from `r` (`len` bytes long): only the last `max` bytes, starting at the
/// first whole line of that tail when it is cut; non-UTF-8 lines are skipped as corrupt.
fn read_tail<R: Read + Seek>(mut r: R, len: u64, max: u64) -> io::Result<String> {
    let cut = len > max;
    if cut {
        r.seek(SeekFrom::Start(len - max))?;
    }
    let mut reader = BufReader::new(r.take(max));
    if cut {
        let mut partial = Vec::new();
        reader.read_until(b'\n', &mut partial)?;
    }
    let mut text = String::new();
    for line in reader.lines() {
        match line {
            Ok(l) => {
                text.push_str(&l);
                text.push('\n');
            }
            // A non-UTF-8 line is corrupt: skip it.
            Err(e) if e.kind() == io::ErrorKind::InvalidData => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(text)
}

/// The ledger text (empty when the file does not exist yet). The file sits in a folder the
/// standard user can write to, so a planted or runaway file is read only up to its last
/// [`MAX_READ_BYTES`].
fn read_all() -> io::Result<String> {
    let dir = open_dir()?;
    match dir.open_read(FILE_NAME) {
        Ok(f) => {
            let len = f.metadata()?.len();
            read_tail(f, len, MAX_READ_BYTES)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}

fn append_lines(lines: &[LedgerLine]) -> io::Result<()> {
    let dir = open_dir()?;
    let mut file = match dir.open_append(FILE_NAME) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => match dir.create_new_file(FILE_NAME) {
            Ok((f, _)) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => dir.open_append(FILE_NAME)?,
            Err(e) => return Err(e),
        },
        Err(e) => return Err(e),
    };
    let mut buf = Vec::new();
    for l in lines {
        serde_json::to_writer(&mut buf, l).map_err(io::Error::from)?;
        buf.push(b'\n');
    }
    file.write_all(&buf)?;
    file.flush()
}

fn seen_pairs(text: &str) -> HashSet<(String, String)> {
    parse_lines(text)
        .into_iter()
        .filter_map(|l| norm_serial(&l.serial).map(|s| (s, l.date)))
        .collect()
}

fn snapshot(app: &AppHandle, packet: &Value) {
    let state = app.state::<AppState>();
    let ledger = &state.drive_history;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut inner = lock(&ledger.inner);
    if inner.seen.is_none() {
        match read_all() {
            Ok(text) => inner.seen = Some(seen_pairs(&text)),
            Err(e) => {
                eprintln!("[nexum] drive history unavailable: {e}");
                return;
            }
        }
    }
    let seen = inner.seen.get_or_insert_with(HashSet::new);
    let lines: Vec<LedgerLine> = lines_for_packet(packet, &today, now_ms())
        .into_iter()
        .filter(|l| norm_serial(&l.serial).is_some_and(|s| !seen.contains(&(s, l.date.clone()))))
        .collect();
    if lines.is_empty() {
        return;
    }
    match append_lines(&lines) {
        Ok(()) => {
            for l in &lines {
                if let Some(s) = norm_serial(&l.serial) {
                    seen.insert((s, l.date.clone()));
                }
            }
        }
        Err(e) => eprintln!("[nexum] could not write the drive history: {e}"),
    }
}

/// On the first telemetry packet and every 10 minutes: append today's line for each drive
/// that has none yet (on a worker thread; the reader never waits for disk I/O).
pub fn on_telemetry(app: &AppHandle, packet: &Value) {
    let state = app.state::<AppState>();
    let ledger = &state.drive_history;
    // The worker holds `inner` during file I/O: never wait for it on the reader thread.
    if ledger.busy.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut inner = lock(&ledger.inner);
        if inner
            .last_snapshot
            .is_some_and(|t| t.elapsed() < SNAPSHOT_EVERY)
        {
            return;
        }
        if ledger.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        inner.last_snapshot = Some(Instant::now());
    }
    let app = app.clone();
    let packet = packet.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-drive-history".into())
        .spawn(move || {
            snapshot(&app, &packet);
            app.state::<AppState>()
                .drive_history
                .busy
                .store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        ledger.busy.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn get_drive_history(serial: String) -> Result<DriveHistory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let text = read_all().map_err(|e| format!("Could not read the drive history: {e}"))?;
        let points = points_for(&parse_lines(&text), &serial);
        let today = chrono::Local::now().date_naive();
        let forecast = forecast(&points, today);
        Ok(DriveHistory {
            serial,
            points,
            forecast,
        })
    })
    .await
    .map_err(|e| format!("Drive history failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn day(n: i64) -> String {
        (NaiveDate::from_ymd_opt(2026, 1, 1).unwrap() + chrono::Duration::days(n))
            .format("%Y-%m-%d")
            .to_string()
    }

    fn pt(n: i64, health: Option<f64>, tb: Option<f64>) -> DriveHistoryPoint {
        DriveHistoryPoint {
            date: day(n),
            health_pct: health,
            data_written_tb: tb,
            power_on_hours: Some(1000.0 + n as f64 * 8.0),
        }
    }

    fn today(n: i64) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 1, 1).unwrap() + chrono::Duration::days(n)
    }

    #[test]
    fn only_the_tail_of_a_huge_ledger_is_read() {
        let data = b"{\"a\":1}\n\xFF\xFEbad\n{\"b\":2}\n{\"c\":3}\n".to_vec();
        let len = data.len() as u64;
        assert_eq!(len, 30);
        // Whole file: the non-UTF-8 line is skipped.
        let all = read_tail(std::io::Cursor::new(data.clone()), len, 1024).unwrap();
        assert_eq!(all, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");
        // The last 12 bytes start inside the `b` line: that partial line is dropped.
        let tail = read_tail(std::io::Cursor::new(data), len, 12).unwrap();
        assert_eq!(tail, "{\"c\":3}\n");
    }

    #[test]
    fn serials_normalize_like_the_ui() {
        assert_eq!(
            norm_serial(" s6z2-nf0w.123_456 a ").as_deref(),
            Some("S6Z2NF0W123456A")
        );
        assert_eq!(norm_serial(" -_. "), None);
    }

    #[test]
    fn ols_is_exact_on_a_line() {
        let pts: Vec<(f64, f64)> = (0..10).map(|i| (i as f64, 3.0 - 0.5 * i as f64)).collect();
        assert!((ols_slope(&pts).unwrap() + 0.5).abs() < 1e-12);
        assert_eq!(ols_slope(&[(1.0, 1.0), (1.0, 2.0)]), None);
        assert_eq!(ols_slope(&[(1.0, 1.0)]), None);
    }

    #[test]
    fn forecast_ok_case() {
        // 60 days: life falls 0.05 %/day from 47 %, 0.03 TB/day written.
        let points: Vec<DriveHistoryPoint> = (0..60)
            .map(|i| {
                pt(
                    i,
                    Some(47.0 - 0.05 * i as f64),
                    Some(10.0 + 0.03 * i as f64),
                )
            })
            .collect();
        let f = forecast(&points, today(59));
        assert_eq!(f.status, "ok");
        assert_eq!(f.points, 60);
        assert_eq!(f.basis_days, 59);
        assert_eq!(f.tb_per_month, Some(0.91)); // 0.03 × 30.4375 = 0.913125
                                                // h = 47 − 2.95 = 44.05; (44.05 − 10) / 0.05 / 30.4375 = 22.37 → 22.4
        assert_eq!(f.months_to10_pct, Some(22.4));
    }

    #[test]
    fn forecast_minimums_and_statuses() {
        // 6 points over 20 days → not enough.
        let few: Vec<DriveHistoryPoint> =
            (0..6).map(|i| pt(i * 4, Some(90.0), Some(1.0))).collect();
        let f = forecast(&few, today(30));
        assert_eq!(f.status, "notEnoughData");
        assert_eq!((f.tb_per_month, f.months_to10_pct), (None, None));
        // 10 points over 9 days → span too short.
        let short: Vec<DriveHistoryPoint> = (0..10).map(|i| pt(i, Some(90.0), Some(1.0))).collect();
        assert_eq!(forecast(&short, today(9)).status, "notEnoughData");
        // No life data (e.g. a SATA SSD without the attribute).
        let nolife: Vec<DriveHistoryPoint> = (0..20).map(|i| pt(i, None, Some(i as f64))).collect();
        let f = forecast(&nolife, today(19));
        assert_eq!(f.status, "noLifeData");
        assert_eq!(f.tb_per_month, Some(30.44));
        // Flat life → no wear.
        let flat: Vec<DriveHistoryPoint> = (0..20).map(|i| pt(i, Some(99.0), Some(5.0))).collect();
        let f = forecast(&flat, today(19));
        assert_eq!(f.status, "noWear");
        assert_eq!(f.tb_per_month, Some(0.0));
        // Very slow wear → beyond 600 months.
        let slow: Vec<DriveHistoryPoint> = (0..20)
            .map(|i| pt(i, Some(99.0 - 0.002 * i as f64), None))
            .collect();
        let f = forecast(&slow, today(19));
        assert_eq!(f.status, "beyondHorizon");
        assert_eq!(f.months_to10_pct, None);
        assert_eq!(f.tb_per_month, None, "no written data");
        // Already at or below 10 % → 0 months.
        let worn: Vec<DriveHistoryPoint> = (0..20)
            .map(|i| pt(i, Some(12.0 - 0.2 * i as f64), None))
            .collect();
        let f = forecast(&worn, today(19));
        assert_eq!(f.months_to10_pct, Some(0.0));
        assert_eq!(f.status, "ok");
        // Points older than a year are not in the basis.
        let old: Vec<DriveHistoryPoint> = (0..20).map(|i| pt(i, Some(80.0), None)).collect();
        let f = forecast(&old, today(500));
        assert_eq!(f.points, 0);
        assert_eq!(f.status, "notEnoughData");
        // Negative writing slope (counter reset) is floored at 0.
        let reset: Vec<DriveHistoryPoint> = (0..20)
            .map(|i| pt(i, Some(90.0 - 0.1 * i as f64), Some(100.0 - i as f64)))
            .collect();
        assert_eq!(forecast(&reset, today(19)).tb_per_month, Some(0.0));
    }

    #[test]
    fn ledger_lines_and_points() {
        let packet = json!({ "disks": [
            { "name": "Samsung SSD 990 PRO 2TB ", "serial": "S6Z2 NF0W", "healthPct": 44.0, "tbw": 12.3,
              "powerOnHours": 20188, "percentageUsed": 56, "dataReadTb": 20.4, "availableSparePct": 100, "mediaErrors": 0 },
            { "name": "USB stick", "serial": null, "healthPct": 99.0 },
            { "name": "HDD", "serial": "WD-1", "healthPct": null, "tbw": null, "powerOnHours": null }
        ]});
        let lines = lines_for_packet(&packet, "2026-11-27", 5);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].model, "Samsung SSD 990 PRO 2TB");
        let text = serde_json::to_string(&lines[0]).unwrap();
        assert!(
            text.starts_with(r#"{"v":1,"date":"2026-11-27","ts":5,"serial":"S6Z2 NF0W""#),
            "{text}"
        );
        assert!(text.contains(r#""dataWrittenTb":12.3"#));
        // Parse back, skip corrupt lines, last line per date wins.
        let mut later = lines[0].clone();
        later.health_pct = Some(43.0);
        let file = format!(
            "{}\nnot json\n{}\n{}\n",
            text,
            serde_json::to_string(&later).unwrap(),
            r#"{"v":1,"date":"bad","ts":1,"serial":"S6Z2NF0W","model":"x"}"#
        );
        let parsed = parse_lines(&file);
        assert_eq!(parsed.len(), 2);
        let pts = points_for(&parsed, "s6z2-nf0w");
        assert_eq!(pts.len(), 1);
        assert_eq!(pts[0].health_pct, Some(43.0));
        assert!(points_for(&parsed, "OTHER").is_empty());
        assert_eq!(seen_pairs(&file).len(), 1);
    }
}
