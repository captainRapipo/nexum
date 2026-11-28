//! User settings: JSON persistence under the app config dir, plus side effects
//! (Task Scheduler autostart, sidecar poll interval).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::util::{hidden_command, lock, system32_exe};

pub const MIN_POLL_MS: u64 = 250;
pub const MAX_POLL_MS: u64 = 10_000;
/// Poll interval used while the window is hidden in the tray.
pub const TRAY_POLL_MS: u64 = 5_000;

const TASK_NAME: &str = "Nexum";

/// Re-match data stored with each user label (CONTRACT §2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorLabelMeta {
    pub default_name: String,
    pub hardware_name: String,
}

pub const MAX_LABEL_CHARS: usize = 64;
pub const MAX_LABELS: usize = 2000;
pub const MAX_HIDDEN: usize = 2000;
pub const MAX_PINNED: usize = 12;
pub const MAX_DISMISSED: usize = 200;
/// Sensor ids are LHM identifiers ("/lpc/it8688e/0/temperature/4"); anything longer is junk.
const MAX_ID_CHARS: usize = 512;
const MAX_META_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub launch_on_startup: bool,
    pub minimize_to_tray: bool,
    #[serde(deserialize_with = "de_ms")]
    pub poll_interval_ms: u64,
    pub include_browser_caches: bool,
    pub confirm_before_purge: bool,
    // `flushStandbyOnPurge` (0.x) is gone: unknown fields in old files are ignored.
    pub temp_unit: String,
    pub start_minimized: bool,
    #[serde(deserialize_with = "de_labels")]
    pub sensor_labels: BTreeMap<String, String>,
    #[serde(deserialize_with = "de_label_meta")]
    pub sensor_label_meta: BTreeMap<String, SensorLabelMeta>,
    #[serde(deserialize_with = "de_string_list")]
    pub hidden_sensors: Vec<String>,
    #[serde(deserialize_with = "de_opt_string_list")]
    pub pinned_sensors: Option<Vec<String>>,
    pub hide_unused_sensors: bool,
    #[serde(deserialize_with = "de_string_list")]
    pub dismissed_alerts: Vec<String>,
    #[serde(deserialize_with = "de_choice")]
    pub sensor_driver_choice: String,
    /// Opt-in frame capture (CONTRACT §1.6, §2.13).
    pub fps_capture_enabled: bool,
    #[serde(deserialize_with = "de_fps_window")]
    pub fps_window_sec: u64,
    #[serde(deserialize_with = "de_string_list")]
    pub fps_excludes: Vec<String>,
    #[serde(deserialize_with = "de_log_interval")]
    pub sensor_log_interval_ms: u64,
    #[serde(deserialize_with = "de_alerts")]
    pub alerts: AlertSettings,
    /// `null` = every Recycle Bin item; else one of 1, 14, 30, 60 (CONTRACT §3.2).
    #[serde(deserialize_with = "de_recycle_age")]
    pub recycle_min_age_days: Option<u32>,
    /// Update-check consent (CONTRACT §2.15.3): `"ask"` (not answered: no network request at
    /// all), `"auto"` or `"manual"`.
    #[serde(deserialize_with = "de_update_check")]
    pub update_check: String,
    /// Unix ms of the last answered update check. Written by Rust only (`updater.rs`);
    /// `save_settings` keeps the stored value (CONTRACT §2.2).
    #[serde(deserialize_with = "de_opt_ts")]
    pub last_update_check_ts: Option<u64>,
    /// `"default"` (the channel this build was made for), `"stable"` or `"preview"`.
    #[serde(deserialize_with = "de_update_channel")]
    pub update_channel: String,
}

pub const UPDATE_CHECK_ASK: &str = "ask";
pub const UPDATE_CHECK_AUTO: &str = "auto";
pub const UPDATE_CHECK_MANUAL: &str = "manual";
pub const UPDATE_CHANNEL_DEFAULT: &str = "default";
pub const UPDATE_CHANNEL_STABLE: &str = "stable";
pub const UPDATE_CHANNEL_PREVIEW: &str = "preview";

/// `updateCheck`: one of `ask`, `auto`, `manual`; anything else → `ask` (so an unreadable
/// value can never switch the network on).
pub fn sanitize_update_check(v: &str) -> &'static str {
    match v {
        UPDATE_CHECK_AUTO => UPDATE_CHECK_AUTO,
        UPDATE_CHECK_MANUAL => UPDATE_CHECK_MANUAL,
        _ => UPDATE_CHECK_ASK,
    }
}

/// `updateChannel`: one of `default`, `stable`, `preview`; anything else → `default`.
pub fn sanitize_update_channel(v: &str) -> &'static str {
    match v {
        UPDATE_CHANNEL_STABLE => UPDATE_CHANNEL_STABLE,
        UPDATE_CHANNEL_PREVIEW => UPDATE_CHANNEL_PREVIEW,
        _ => UPDATE_CHANNEL_DEFAULT,
    }
}

/// What `save_settings` stores for the update members (CONTRACT §2.2, §2.15.4): the incoming
/// `lastUpdateCheckTs` is ignored and the stored one kept, except that a change of the
/// effective channel (`channel_changed`) clears it so the next check asks the new channel.
pub fn keep_stored_update_check_ts(stored: Option<u64>, channel_changed: bool) -> Option<u64> {
    if channel_changed {
        None
    } else {
        stored
    }
}

/// `Settings.alerts` (CONTRACT §2.2, §2.10). Each member is sanitized on its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertSettings {
    pub desktop_notifications: bool,
    /// CPU limit override °C (60..105); `None` = per-model table.
    pub cpu_temp_c: Option<u32>,
    /// GPU hot-spot crit override °C (70..115); `None` = 110.
    pub gpu_hotspot_c: Option<u32>,
    /// GPU memory-junction crit override °C (70..115); `None` = 105.
    pub gpu_mem_junction_c: Option<u32>,
    /// Low-space warn threshold % (1..50).
    pub free_space_pct: u32,
    /// Sustained window, seconds (10..600).
    pub sustain_sec: u32,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            desktop_notifications: false,
            cpu_temp_c: None,
            gpu_hotspot_c: None,
            gpu_mem_junction_c: None,
            free_space_pct: 10,
            sustain_sec: 60,
        }
    }
}

pub const FPS_WINDOW_MIN: u64 = 5;
pub const FPS_WINDOW_MAX: u64 = 120;
pub const FPS_WINDOW_DEFAULT: u64 = 30;
pub const SENSOR_LOG_INTERVALS: [u64; 4] = [1000, 2000, 5000, 10000];
pub const RECYCLE_AGE_OPTIONS: [u32; 4] = [1, 14, 30, 60];
pub const RECYCLE_AGE_DEFAULT: u32 = 30;

/// Integer clamp of a finite number (rounded), `None` otherwise.
fn int_clamp(v: f64, min: u32, max: u32) -> Option<u32> {
    v.is_finite()
        .then(|| v.round().clamp(min as f64, max as f64) as u32)
}

impl AlertSettings {
    /// Parses each member on its own: a missing or malformed member gets its default.
    pub fn from_value(v: &serde_json::Value) -> Self {
        let d = Self::default();
        let num = |k: &str| v.get(k).and_then(serde_json::Value::as_f64);
        // `null` is a valid "use the default rule" value; anything else that is not a number
        // falls back to the default (also `None`).
        let opt = |k: &str, min: u32, max: u32| num(k).and_then(|n| int_clamp(n, min, max));
        Self {
            desktop_notifications: v
                .get("desktopNotifications")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(d.desktop_notifications),
            cpu_temp_c: opt("cpuTempC", 60, 105),
            gpu_hotspot_c: opt("gpuHotspotC", 70, 115),
            gpu_mem_junction_c: opt("gpuMemJunctionC", 70, 115),
            free_space_pct: num("freeSpacePct")
                .and_then(|n| int_clamp(n, 1, 50))
                .unwrap_or(d.free_space_pct),
            sustain_sec: num("sustainSec")
                .and_then(|n| int_clamp(n, 10, 600))
                .unwrap_or(d.sustain_sec),
        }
    }

    /// Clamps values that came in through the typed struct (e.g. built in code).
    pub fn sanitized(self) -> Self {
        Self {
            desktop_notifications: self.desktop_notifications,
            cpu_temp_c: self.cpu_temp_c.map(|c| c.clamp(60, 105)),
            gpu_hotspot_c: self.gpu_hotspot_c.map(|c| c.clamp(70, 115)),
            gpu_mem_junction_c: self.gpu_mem_junction_c.map(|c| c.clamp(70, 115)),
            free_space_pct: self.free_space_pct.clamp(1, 50),
            sustain_sec: self.sustain_sec.clamp(10, 600),
        }
    }

    /// Crit threshold of the low-space rule: `max(1, floor(freeSpacePct / 2))`.
    pub fn free_space_crit_pct(&self) -> u32 {
        (self.free_space_pct / 2).max(1)
    }
}

/// `sensorLogIntervalMs`: one of 1000, 2000, 5000, 10000; anything else → 1000.
pub fn sanitize_log_interval(ms: u64) -> u64 {
    if SENSOR_LOG_INTERVALS.contains(&ms) {
        ms
    } else {
        1000
    }
}

/// `recycleMinAgeDays`: `None` or one of 1, 14, 30, 60; anything else → 30.
pub fn sanitize_recycle_age(days: Option<u32>) -> Option<u32> {
    match days {
        None => None,
        Some(d) if RECYCLE_AGE_OPTIONS.contains(&d) => Some(d),
        Some(_) => Some(RECYCLE_AGE_DEFAULT),
    }
}

/// A `recycleMinAgeDays` JSON value: `null` → `None`, a whole number → sanitized, anything else
/// (strings, fractions, negatives) → the default.
pub fn recycle_age_from_value(v: &serde_json::Value) -> Option<u32> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::Number(n) => match n.as_f64() {
            Some(f) if f.is_finite() && f >= 0.0 && f.fract() == 0.0 && f <= u32::MAX as f64 => {
                sanitize_recycle_age(Some(f as u32))
            }
            _ => Some(RECYCLE_AGE_DEFAULT),
        },
        _ => Some(RECYCLE_AGE_DEFAULT),
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_on_startup: false,
            minimize_to_tray: true,
            poll_interval_ms: 1000,
            include_browser_caches: false,
            confirm_before_purge: true,
            temp_unit: "C".to_string(),
            start_minimized: false,
            sensor_labels: BTreeMap::new(),
            sensor_label_meta: BTreeMap::new(),
            hidden_sensors: Vec::new(),
            pinned_sensors: None,
            hide_unused_sensors: true,
            dismissed_alerts: Vec::new(),
            sensor_driver_choice: "undecided".to_string(),
            fps_capture_enabled: false,
            fps_window_sec: FPS_WINDOW_DEFAULT,
            fps_excludes: Vec::new(),
            sensor_log_interval_ms: 1000,
            alerts: AlertSettings::default(),
            recycle_min_age_days: Some(RECYCLE_AGE_DEFAULT),
            update_check: UPDATE_CHECK_ASK.to_string(),
            last_update_check_ts: None,
            update_channel: UPDATE_CHANNEL_DEFAULT.to_string(),
        }
    }
}

impl Settings {
    /// Clamps/normalizes values coming from disk or the frontend (CONTRACT §2.2).
    pub fn sanitized(mut self) -> Self {
        self.poll_interval_ms = clamp_poll(self.poll_interval_ms);
        self.temp_unit = if self.temp_unit.trim().eq_ignore_ascii_case("F") {
            "F".to_string()
        } else {
            "C".to_string()
        };

        // Labels: trimmed, non-empty, at most 64 characters, at most 2000 entries.
        let mut labels = BTreeMap::new();
        for (id, label) in std::mem::take(&mut self.sensor_labels) {
            let id = id.trim().to_string();
            let label = truncate_chars(label.trim(), MAX_LABEL_CHARS);
            if id.is_empty() || id.chars().count() > MAX_ID_CHARS || label.is_empty() {
                continue;
            }
            if labels.len() >= MAX_LABELS && !labels.contains_key(&id) {
                continue;
            }
            labels.insert(id, label);
        }
        self.sensor_labels = labels;

        // Meta only for labelled ids.
        let meta = std::mem::take(&mut self.sensor_label_meta);
        let mut kept = BTreeMap::new();
        for (id, m) in meta {
            let id = id.trim().to_string();
            if self.sensor_labels.contains_key(&id) {
                kept.insert(
                    id,
                    SensorLabelMeta {
                        default_name: truncate_chars(&m.default_name, MAX_META_CHARS),
                        hardware_name: truncate_chars(&m.hardware_name, MAX_META_CHARS),
                    },
                );
            }
        }
        self.sensor_label_meta = kept;

        self.hidden_sensors =
            dedupe_ids(std::mem::take(&mut self.hidden_sensors), MAX_HIDDEN, false);
        self.pinned_sensors = self
            .pinned_sensors
            .take()
            .map(|p| dedupe_ids(p, MAX_PINNED, false));
        self.dismissed_alerts =
            dedupe_ids(std::mem::take(&mut self.dismissed_alerts), MAX_DISMISSED, true);

        if !matches!(
            self.sensor_driver_choice.as_str(),
            "undecided" | "pawnio" | "none"
        ) {
            self.sensor_driver_choice = "undecided".to_string();
        }

        self.fps_window_sec = self.fps_window_sec.clamp(FPS_WINDOW_MIN, FPS_WINDOW_MAX);
        self.fps_excludes = crate::frames::sanitize_excludes(std::mem::take(&mut self.fps_excludes));
        self.sensor_log_interval_ms = sanitize_log_interval(self.sensor_log_interval_ms);
        self.alerts = self.alerts.clone().sanitized();
        self.recycle_min_age_days = sanitize_recycle_age(self.recycle_min_age_days);
        self.update_check = sanitize_update_check(&self.update_check).to_string();
        self.update_channel = sanitize_update_channel(&self.update_channel).to_string();
        self
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Trims, drops empty/oversized entries and duplicates, then caps the list at `max` entries:
/// the first `max` (first occurrence wins), or the most recent `max` when `keep_last` (the
/// last occurrence of a duplicate counts as its position).
fn dedupe_ids(items: Vec<String>, max: usize, keep_last: bool) -> Vec<String> {
    let cleaned: Vec<String> = items
        .into_iter()
        .map(|i| i.trim().to_string())
        .filter(|t| !t.is_empty() && t.chars().count() <= MAX_ID_CHARS)
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    if keep_last {
        for t in cleaned.into_iter().rev() {
            if seen.insert(t.clone()) {
                out.push(t);
            }
        }
        out.truncate(max);
        out.reverse();
    } else {
        for t in cleaned {
            if seen.insert(t.clone()) {
                out.push(t);
            }
        }
        out.truncate(max);
    }
    out
}

pub fn clamp_poll(ms: u64) -> u64 {
    ms.clamp(MIN_POLL_MS, MAX_POLL_MS)
}

/// Accepts integers, floats (`1000.0`) and numeric strings for the poll interval.
fn de_ms<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let ms = match &v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f.round() as u64)
        }),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| f.max(0.0).round() as u64),
        _ => None,
    };
    Ok(ms.unwrap_or(1000))
}

/// `Record<string,string>`; non-string values and non-object input are dropped.
fn de_labels<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, String>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let mut out = BTreeMap::new();
    if let serde_json::Value::Object(map) = v {
        for (k, v) in map {
            if let serde_json::Value::String(s) = v {
                out.insert(k, s);
            }
        }
    }
    Ok(out)
}

/// `Record<string,{defaultName,hardwareName}>`; malformed entries are dropped.
fn de_label_meta<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, SensorLabelMeta>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let mut out = BTreeMap::new();
    if let serde_json::Value::Object(map) = v {
        for (k, v) in map {
            if let Ok(m) = serde_json::from_value::<SensorLabelMeta>(v) {
                out.insert(k, m);
            }
        }
    }
    Ok(out)
}

fn string_list(v: serde_json::Value) -> Option<Vec<String>> {
    match v {
        serde_json::Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|i| match i {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

/// `string[]`; anything else becomes `[]`.
fn de_string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(string_list(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// `string[] | null`; anything that is not an array becomes `null` (= default pin rule).
fn de_opt_string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    Ok(string_list(serde_json::Value::deserialize(d)?))
}

/// `"undecided" | "pawnio" | "none"`; anything else becomes `"undecided"` (via `sanitized`).
fn de_choice<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        _ => "undecided".to_string(),
    })
}

/// A finite, non-negative number (or numeric string) rounded to an integer.
fn tolerant_u64(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f.round() as u64)
        }),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f.round() as u64),
        _ => None,
    }
}

/// `fpsWindowSec`; malformed → 30 (clamped in `sanitized`).
fn de_fps_window<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    Ok(tolerant_u64(&serde_json::Value::deserialize(d)?).unwrap_or(FPS_WINDOW_DEFAULT))
}

/// `sensorLogIntervalMs`; malformed → 1000 (checked in `sanitized`).
fn de_log_interval<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    Ok(tolerant_u64(&serde_json::Value::deserialize(d)?).unwrap_or(1000))
}

/// `alerts`; a non-object becomes the defaults, each member is parsed on its own.
fn de_alerts<'de, D: Deserializer<'de>>(d: D) -> Result<AlertSettings, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(if v.is_object() {
        AlertSettings::from_value(&v)
    } else {
        AlertSettings::default()
    })
}

/// `recycleMinAgeDays`: `null` stays `null` (every item); malformed → 30.
fn de_recycle_age<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
    Ok(recycle_age_from_value(&serde_json::Value::deserialize(d)?))
}

/// `updateCheck`; anything that is not a string becomes `"ask"` (checked in `sanitized`).
fn de_update_check<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        _ => UPDATE_CHECK_ASK.to_string(),
    })
}

/// `updateChannel`; anything that is not a string becomes `"default"` (checked in `sanitized`).
fn de_update_channel<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        _ => UPDATE_CHANNEL_DEFAULT.to_string(),
    })
}

/// A unix-ms timestamp from a JSON value: a finite, non-negative number → rounded; anything
/// else (null, strings, NaN, negatives) → `None`.
pub fn opt_ts_from_value(v: &serde_json::Value) -> Option<u64> {
    match v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0 && *f <= u64::MAX as f64)
                .map(|f| f.round() as u64)
        }),
        _ => None,
    }
}

/// `lastUpdateCheckTs`; not a finite number → `null`.
fn de_opt_ts<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(opt_ts_from_value(&serde_json::Value::deserialize(d)?))
}

/// True when `p` exists and is a reparse point (junction, symbolic link, mount point).
fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & 0x400 != 0)
        .unwrap_or(false)
}

/// Reads settings from disk (defaults when missing or unreadable). The settings folder is
/// writable by non-elevated code, so neither the file nor its folder may be a link: the
/// elevated app would otherwise read (and, for an invalid file, rename) whatever it points at.
pub fn load_from(path: &Path) -> Settings {
    if is_reparse_point(path) || path.parent().is_some_and(is_reparse_point) {
        eprintln!("[nexum] settings.json or its folder is a link; using defaults");
        return Settings::default();
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            match serde_json::from_slice::<Settings>(bytes) {
                Ok(s) => s.sanitized(),
                Err(e) => {
                    eprintln!("[nexum] settings.json is invalid ({e}); using defaults");
                    // Keep the broken file for inspection instead of silently overwriting it.
                    let _ = std::fs::rename(path, path.with_extension("json.bad"));
                    Settings::default()
                }
            }
        }
        Err(_) => Settings::default(),
    }
}

/// Writes settings atomically (tmp file + rename).
///
/// The settings folder (`%APPDATA%\<app id>`) is writable by non-elevated code, which could
/// plant a junction or an object-manager symbolic link there to redirect this elevated write.
/// The folder is therefore opened without following links and held (see
/// [`crate::safe_fs::PinnedDir`]), the temporary file is created new and verified, and the final
/// rename replaces the `settings.json` name itself (a rename never follows a link at the
/// destination).
pub fn write_to(path: &Path, settings: &Settings) -> Result<(), String> {
    use std::io::Write;
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(d), Some(n)) => (d, n.to_string_lossy().to_string()),
        _ => return Err("Invalid settings path".to_string()),
    };
    let base = dir
        .parent()
        .ok_or_else(|| "Invalid settings path".to_string())?;
    std::fs::create_dir_all(base)
        .map_err(|e| format!("Could not create {}: {e}", base.display()))?;
    let pinned = crate::safe_fs::PinnedDir::open(base, dir, true)
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_name = format!("{name}.tmp");
    let tmp = pinned.path().join(&tmp_name);
    // A leftover from an interrupted save (or a planted link): removing a name never follows it.
    let _ = std::fs::remove_file(&tmp);
    let (mut file, tmp) = pinned
        .create_new_file(&tmp_name)
        .map_err(|e| format!("Could not write settings: {e}"))?;
    let written = file.write_all(&json).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Could not write settings: {e}"));
    }
    let result = std::fs::rename(&tmp, pinned.path().join(&name)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save settings: {e}")
    });
    drop(pinned);
    result
}

/// Resolves `<app_config_dir>/settings.json`.
pub fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// Loads settings into state during `setup`.
pub fn init(app: &AppHandle) -> Settings {
    let state = app.state::<AppState>();
    let path = settings_path(app);
    let settings = path.as_deref().map(load_from).unwrap_or_default();
    *lock(&state.settings_path) = path;
    *lock(&state.settings) = settings.clone();
    settings
}

/// Persists the current in-memory settings (best effort, used by `set_poll_interval`).
pub fn persist_current(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = lock(&state.settings_path).clone();
    let settings = lock(&state.settings).clone();
    match path {
        Some(p) => write_to(&p, &settings),
        None => Err("Settings location is unavailable".to_string()),
    }
}

/// Effective sidecar interval (CONTRACT §2 minimized to tray, §2.9): the user's poll interval;
/// while hidden `max(poll, 5000)`, or `min(that, log interval)` while a sensor log runs.
pub fn effective_poll(poll_ms: u64, in_tray: bool, log_interval_ms: Option<u64>) -> u64 {
    let poll = clamp_poll(poll_ms);
    if !in_tray {
        return poll;
    }
    let hidden = poll.max(TRAY_POLL_MS).min(MAX_POLL_MS);
    match log_interval_ms {
        Some(log) => clamp_poll(hidden.min(log)),
        None => hidden,
    }
}

/// [`effective_poll`] for the current settings, tray state and sensor log.
pub fn effective_poll_ms(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let poll = lock(&state.settings).poll_interval_ms;
    effective_poll(
        poll,
        state.in_tray.load(Ordering::SeqCst),
        state.sensor_log.active_interval(),
    )
}

/// Applies `f` to a copy of the current settings, sanitizes, saves and stores the result
/// (one writer at a time). Returns `(old, new)`.
pub fn update_settings(
    app: &AppHandle,
    f: impl FnOnce(&mut Settings),
) -> Result<(Settings, Settings), String> {
    let state = app.state::<AppState>();
    let _writer = lock(&state.settings_write);
    let old = lock(&state.settings).clone();
    let mut new = old.clone();
    f(&mut new);
    let new = new.sanitized();
    if new != old {
        let path = lock(&state.settings_path).clone();
        match path {
            Some(p) => write_to(&p, &new)?,
            None => return Err("Settings location is unavailable".to_string()),
        }
        *lock(&state.settings) = new.clone();
    }
    Ok((old, new))
}

// ---------------------------------------------------------------------------------------------
// Autostart (Task Scheduler, "Run with highest privileges" so no UAC prompt at logon)
// ---------------------------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn current_user_id() -> Option<String> {
    let user = std::env::var("USERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    match std::env::var("USERDOMAIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        Some(domain) => Some(format!("{domain}\\{user}")),
        None => Some(user),
    }
}

fn task_xml(exe: &Path) -> String {
    let user = current_user_id();
    let user_trigger = user
        .as_deref()
        .map(|u| format!("<UserId>{}</UserId>", xml_escape(u)))
        .unwrap_or_default();
    let user_principal = user_trigger.clone();
    let exe = xml_escape(&exe.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Nexum</Author>
    <Description>Starts Nexum minimized to the tray at logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      {user_trigger}
      <Delay>PT5S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      {user_principal}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--minimized</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn run_schtasks(args: &[&str]) -> Result<String, String> {
    let out = hidden_command(system32_exe("schtasks.exe"))
        .args(args)
        .output()
        .map_err(|e| format!("Could not run schtasks: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("schtasks failed ({})", out.status)
        } else {
            text
        })
    }
}

fn task_exists() -> bool {
    run_schtasks(&["/Query", "/TN", TASK_NAME]).is_ok()
}

/// Creates (or replaces) / deletes the logon task.
pub fn apply_autostart(enable: bool) -> Result<(), String> {
    if !enable {
        if !task_exists() {
            return Ok(());
        }
        return run_schtasks(&["/Delete", "/F", "/TN", TASK_NAME]).map(|_| ());
    }

    let exe = std::env::current_exe().map_err(|e| format!("Cannot resolve Nexum.exe path: {e}"))?;
    let exe = exe.canonicalize().map(strip_verbatim).unwrap_or(exe);
    if !is_in_program_files(&exe) {
        return Err(format!(
            "Launch on startup needs the installed copy of Nexum (Program Files). This copy runs from \
             {}, a folder other programs could modify, and the startup task runs with administrator rights.",
            exe.parent().map(|p| p.display().to_string()).unwrap_or_default()
        ));
    }

    // Preferred: XML definition (no 72h execution limit, runs on battery).
    //
    // The XML decides what runs with highest privileges at every logon, so it must not be
    // writable by non-elevated code between writing it and schtasks reading it. It therefore
    // goes to `<Windows>\Temp` (resolved via API, not %WINDIR%): files an elevated process
    // creates there are owned by Administrators and cannot be modified, deleted or renamed by
    // standard users. The name is unpredictable and `create_new` refuses pre-planted files/links.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let xml_path = crate::util::windows_dir()
        .join("Temp")
        .join(format!("nexum-task-{}-{nanos:x}.xml", std::process::id()));
    let mut created = false;
    let xml_result = (|| -> Result<(), String> {
        use std::io::Write;
        let xml = task_xml(&exe);
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&xml_path)
            .map_err(|e| e.to_string())?;
        created = true;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let xml_arg = xml_path.to_string_lossy().to_string();
        run_schtasks(&["/Create", "/F", "/TN", TASK_NAME, "/XML", &xml_arg]).map(|_| ())
    })();
    if created {
        let _ = std::fs::remove_file(&xml_path);
    }

    match xml_result {
        Ok(()) => Ok(()),
        Err(xml_err) => {
            // Fallback: classic one-liner.
            let tr = format!("\"{}\" --minimized", exe.to_string_lossy());
            run_schtasks(&[
                "/Create", "/F", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", &tr,
            ])
            .map(|_| ())
            .map_err(|e| format!("Could not register startup task: {e} (XML attempt: {xml_err})"))
        }
    }
}

/// True when `exe` lives under `Program Files` / `Program Files (x86)` (admin-only writable),
/// resolved through the known-folder API rather than environment variables.
fn is_in_program_files(exe: &Path) -> bool {
    use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86};
    let exe_l = exe.to_string_lossy().to_lowercase();
    [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86]
        .into_iter()
        .filter_map(crate::util::known_folder)
        .any(|pf| is_under_dir(&exe_l, &pf.to_string_lossy().to_lowercase()))
}

/// `path` and `dir` lower-cased, `\`-separated; true when `path` is strictly inside `dir`.
fn is_under_dir(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('\\');
    !dir.is_empty()
        && path.len() > dir.len() + 1
        && path.starts_with(dir)
        && path.as_bytes()[dir.len()] == b'\\'
        && !path.split('\\').any(|c| c == "..")
}

/// A verbatim path (the `\\?\` form that `canonicalize` returns) in its plain form.
pub(crate) fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Re-registers the logon task at startup when enabled, so the task follows the current
/// executable path after an update/reinstall. Runs on a background thread.
pub fn refresh_autostart_in_background(app: &AppHandle) {
    let enabled = lock(&app.state::<AppState>().settings).launch_on_startup;
    if enabled {
        std::thread::spawn(|| {
            if let Err(e) = apply_autostart(true) {
                eprintln!("[nexum] autostart refresh failed: {e}");
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(lock(&app.state::<AppState>().settings).clone())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let worker = app.clone();
    let (old, saved) = tauri::async_runtime::spawn_blocking(move || -> Result<(Settings, Settings), String> {
        let app = worker;
        let state = app.state::<AppState>();
        let _writer = lock(&state.settings_write);
        let mut new = settings.sanitized();
        let old = lock(&state.settings).clone();
        // CONTRACT §2.2: `lastUpdateCheckTs` is written by Rust only. The UI's copy may be
        // stale, so the stored value is kept (cleared when the update channel changes).
        new.last_update_check_ts = keep_stored_update_check_ts(
            old.last_update_check_ts,
            crate::updater::channel_changed(&old, &new),
        );

        if new.launch_on_startup != old.launch_on_startup {
            apply_autostart(new.launch_on_startup)?;
        }

        let path = lock(&state.settings_path).clone();
        if let Some(p) = path {
            if let Err(e) = write_to(&p, &new) {
                // Roll back the autostart side effect so state stays consistent.
                if new.launch_on_startup != old.launch_on_startup {
                    let _ = apply_autostart(old.launch_on_startup);
                }
                return Err(e);
            }
        }
        *lock(&state.settings) = new.clone();
        Ok((old, new))
    })
    .await
    .map_err(|e| format!("Settings worker failed: {e}"))??;

    crate::agent::apply_interval(&app);
    // CONTRACT §2.13: the same effects as the dedicated frame commands, so both paths agree.
    crate::frames::apply_settings_change(&app, &old, &saved);
    // New thresholds / unit / dismissals: re-evaluate the alerts at once.
    if old.alerts != saved.alerts
        || old.temp_unit != saved.temp_unit
        || old.dismissed_alerts != saved.dismissed_alerts
    {
        crate::alerts::on_settings_changed(&app);
    }
    if old.sensor_labels != saved.sensor_labels {
        crate::alerts::request_tooltip(&app);
    }
    // CONTRACT §2.15.4: a new consent answer or channel re-arms the update schedule.
    crate::updater::on_settings_changed(&app, &old, &saved);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_contract() {
        let s = Settings::default();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["launchOnStartup"], false);
        assert_eq!(v["minimizeToTray"], true);
        assert_eq!(v["pollIntervalMs"], 1000);
        assert_eq!(v["includeBrowserCaches"], false);
        assert_eq!(v["confirmBeforePurge"], true);
        assert!(v.get("flushStandbyOnPurge").is_none());
        assert_eq!(v["tempUnit"], "C");
        assert_eq!(v["startMinimized"], false);
        assert_eq!(v["sensorLabels"], serde_json::json!({}));
        assert_eq!(v["sensorLabelMeta"], serde_json::json!({}));
        assert_eq!(v["hiddenSensors"], serde_json::json!([]));
        assert!(v["pinnedSensors"].is_null());
        assert_eq!(v["hideUnusedSensors"], true);
        assert_eq!(v["dismissedAlerts"], serde_json::json!([]));
        assert_eq!(v["sensorDriverChoice"], "undecided");
    }

    #[test]
    fn old_settings_files_migrate() {
        // A 0.x file: has flushStandbyOnPurge, lacks every new field.
        let old = r#"{"launchOnStartup":true,"minimizeToTray":false,"pollIntervalMs":2000,
            "includeBrowserCaches":true,"confirmBeforePurge":false,"flushStandbyOnPurge":true,
            "tempUnit":"F","startMinimized":true}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        let s = s.sanitized();
        assert!(s.launch_on_startup);
        assert!(!s.minimize_to_tray);
        assert_eq!(s.poll_interval_ms, 2000);
        assert_eq!(s.temp_unit, "F");
        assert!(s.sensor_labels.is_empty());
        assert_eq!(s.pinned_sensors, None);
        assert!(s.hide_unused_sensors);
        assert_eq!(s.sensor_driver_choice, "undecided");
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("flushStandbyOnPurge").is_none(), "removed field is not written back");
    }

    #[test]
    fn wrongly_typed_new_fields_do_not_reset_the_file() {
        let s: Settings = serde_json::from_str(
            r#"{"pollIntervalMs":500,"sensorLabels":["x"],"hiddenSensors":"a",
                "pinnedSensors":5,"dismissedAlerts":{"a":1},"sensorDriverChoice":7,
                "sensorLabelMeta":{"/a":{"defaultName":1}}}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.poll_interval_ms, 500);
        assert!(s.sensor_labels.is_empty());
        assert!(s.hidden_sensors.is_empty());
        assert_eq!(s.pinned_sensors, None);
        assert!(s.dismissed_alerts.is_empty());
        assert_eq!(s.sensor_driver_choice, "undecided");
        assert!(s.sensor_label_meta.is_empty());
    }

    #[test]
    fn sensor_settings_are_sanitized() {
        let long = "x".repeat(100);
        let json = serde_json::json!({
            "sensorLabels": {
                "/lpc/it8688e/0/fan/1": "  CPU cooler  ",
                "/lpc/it8688e/0/fan/2": "   ",
                "": "nameless",
                "/lpc/it8688e/0/fan/3": long,
            },
            "sensorLabelMeta": {
                "/lpc/it8688e/0/fan/1": { "defaultName": "Fan #2", "hardwareName": "ITE IT8688E" },
                "/lpc/it8688e/0/fan/9": { "defaultName": "Fan #9", "hardwareName": "ITE IT8688E" },
            },
            "hiddenSensors": ["/a", " /a ", "", "/b"],
            "pinnedSensors": ["/1","/2","/3","/4","/5","/6","/7","/8","/9","/10","/11","/12","/13","/1"],
            "dismissedAlerts": ["k1", "k2", "k1"],
            "sensorDriverChoice": "pawnio",
            "hideUnusedSensors": false,
        });
        let s: Settings = serde_json::from_value(json).unwrap();
        let s = s.sanitized();
        assert_eq!(s.sensor_labels.len(), 2);
        assert_eq!(s.sensor_labels["/lpc/it8688e/0/fan/1"], "CPU cooler");
        assert_eq!(s.sensor_labels["/lpc/it8688e/0/fan/3"].chars().count(), MAX_LABEL_CHARS);
        assert_eq!(s.sensor_label_meta.len(), 1, "meta without a label is dropped");
        assert_eq!(s.hidden_sensors, vec!["/a", "/b"]);
        let pinned = s.pinned_sensors.clone().unwrap();
        assert_eq!(pinned.len(), MAX_PINNED);
        assert_eq!(pinned[0], "/1");
        assert_eq!(s.dismissed_alerts, vec!["k2", "k1"], "most recent occurrence wins");
        assert_eq!(s.sensor_driver_choice, "pawnio");
        assert!(!s.hide_unused_sensors);

        let mut many = Vec::new();
        for i in 0..250 {
            many.push(format!("alert-{i}"));
        }
        let s = Settings {
            dismissed_alerts: many,
            sensor_driver_choice: "bogus".into(),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(s.dismissed_alerts.len(), MAX_DISMISSED);
        assert_eq!(s.dismissed_alerts[0], "alert-50");
        assert_eq!(s.dismissed_alerts[199], "alert-249");
        assert_eq!(s.sensor_driver_choice, "undecided");
    }

    #[test]
    fn v11_defaults_match_contract() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["fpsCaptureEnabled"], false);
        assert_eq!(v["fpsWindowSec"], 30);
        assert_eq!(v["fpsExcludes"], serde_json::json!([]));
        assert_eq!(v["sensorLogIntervalMs"], 1000);
        assert_eq!(v["recycleMinAgeDays"], 30);
        assert_eq!(
            v["alerts"],
            serde_json::json!({
                "desktopNotifications": false, "cpuTempC": null, "gpuHotspotC": null,
                "gpuMemJunctionC": null, "freeSpacePct": 10, "sustainSec": 60
            })
        );
        // A v1.0 file (no 1.1 members) gets every default.
        let s: Settings = serde_json::from_str(r#"{"pollIntervalMs":1000}"#).unwrap();
        let s = s.sanitized();
        assert_eq!(s.recycle_min_age_days, Some(30));
        assert_eq!(s.alerts, AlertSettings::default());
    }

    #[test]
    fn v12_update_members_default_and_sanitize() {
        // CONTRACT §2.2 / §2.15.3: the default is "not answered", which keeps the network off.
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["updateCheck"], "ask");
        assert!(v["lastUpdateCheckTs"].is_null());
        assert_eq!(v["updateChannel"], "default");

        // A 1.1 file has none of the three members.
        let s: Settings = serde_json::from_str(r#"{"pollIntervalMs":1000}"#).unwrap();
        let s = s.sanitized();
        assert_eq!(s.update_check, "ask");
        assert_eq!(s.last_update_check_ts, None);
        assert_eq!(s.update_channel, "default");

        // Valid values survive a round trip.
        let s: Settings = serde_json::from_value(serde_json::json!({
            "updateCheck": "auto", "lastUpdateCheckTs": 1_800_000_000_000u64, "updateChannel": "preview"
        }))
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.update_check, "auto");
        assert_eq!(s.last_update_check_ts, Some(1_800_000_000_000));
        assert_eq!(s.update_channel, "preview");
        let back: Settings =
            serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back.sanitized(), s);

        // Unknown or wrongly typed values fall back to the safe side: never to "auto".
        for bad in [
            serde_json::json!("AUTO"),
            serde_json::json!("always"),
            serde_json::json!(""),
            serde_json::json!(true),
            serde_json::json!(1),
            serde_json::Value::Null,
        ] {
            let s: Settings =
                serde_json::from_value(serde_json::json!({ "updateCheck": bad })).unwrap();
            assert_eq!(s.sanitized().update_check, "ask");
        }
        for bad in [
            serde_json::json!("beta"),
            serde_json::json!("Preview"),
            serde_json::json!(7),
            serde_json::Value::Null,
        ] {
            let s: Settings =
                serde_json::from_value(serde_json::json!({ "updateChannel": bad })).unwrap();
            assert_eq!(s.sanitized().update_channel, "default");
        }
        assert_eq!(sanitize_update_check("manual"), "manual");
        assert_eq!(sanitize_update_channel("stable"), "stable");

        // lastUpdateCheckTs: not a finite, non-negative number → null.
        assert_eq!(opt_ts_from_value(&serde_json::json!(12.6)), Some(13));
        assert_eq!(opt_ts_from_value(&serde_json::json!(0)), Some(0));
        assert_eq!(opt_ts_from_value(&serde_json::json!(-5)), None);
        assert_eq!(opt_ts_from_value(&serde_json::json!("1700000000000")), None);
        assert_eq!(opt_ts_from_value(&serde_json::Value::Null), None);
        assert_eq!(opt_ts_from_value(&serde_json::json!([1])), None);
        let s: Settings =
            serde_json::from_value(serde_json::json!({ "lastUpdateCheckTs": "soon" })).unwrap();
        assert_eq!(s.last_update_check_ts, None);
    }

    #[test]
    fn save_settings_keeps_the_stored_update_check_time() {
        // The UI's copy of the timestamp never wins; a channel change clears it.
        assert_eq!(keep_stored_update_check_ts(Some(5), false), Some(5));
        assert_eq!(keep_stored_update_check_ts(None, false), None);
        assert_eq!(keep_stored_update_check_ts(Some(5), true), None);
        assert_eq!(keep_stored_update_check_ts(None, true), None);
    }

    #[test]
    fn v11_members_are_sanitized() {
        let s: Settings = serde_json::from_value(serde_json::json!({
            "fpsCaptureEnabled": true,
            "fpsWindowSec": 500,
            "fpsExcludes": ["obs64.exe", "OBS64.EXE", "dwm.exe", "bad name", " game.exe "],
            "sensorLogIntervalMs": 3000,
            "recycleMinAgeDays": null,
            "alerts": { "desktopNotifications": true, "cpuTempC": 200, "gpuHotspotC": "x",
                        "gpuMemJunctionC": 60.4, "freeSpacePct": 0, "sustainSec": 30.6 }
        }))
        .unwrap();
        let s = s.sanitized();
        assert!(s.fps_capture_enabled);
        assert_eq!(s.fps_window_sec, 120);
        assert_eq!(s.fps_excludes, vec!["obs64.exe", "game.exe"]);
        assert_eq!(s.sensor_log_interval_ms, 1000);
        assert_eq!(s.recycle_min_age_days, None, "null means every item");
        assert!(s.alerts.desktop_notifications);
        assert_eq!(s.alerts.cpu_temp_c, Some(105));
        assert_eq!(s.alerts.gpu_hotspot_c, None, "malformed member → default");
        assert_eq!(s.alerts.gpu_mem_junction_c, Some(70));
        assert_eq!(s.alerts.free_space_pct, 1);
        assert_eq!(s.alerts.sustain_sec, 31);
        assert_eq!(s.alerts.free_space_crit_pct(), 1);

        let s: Settings = serde_json::from_value(serde_json::json!({
            "fpsWindowSec": 1, "recycleMinAgeDays": 7, "alerts": "nope", "sensorLogIntervalMs": 5000
        }))
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.fps_window_sec, 5);
        assert_eq!(s.recycle_min_age_days, Some(30));
        assert_eq!(s.alerts, AlertSettings::default());
        assert_eq!(s.sensor_log_interval_ms, 5000);
        assert_eq!(recycle_age_from_value(&serde_json::json!(14)), Some(14));
        assert_eq!(recycle_age_from_value(&serde_json::json!(1.5)), Some(30));
        assert_eq!(recycle_age_from_value(&serde_json::json!("14")), Some(30));
        assert_eq!(AlertSettings { free_space_pct: 15, ..AlertSettings::default() }.free_space_crit_pct(), 7);
    }

    #[test]
    fn hidden_poll_interval_follows_the_log() {
        assert_eq!(effective_poll(1000, false, Some(10_000)), 1000);
        assert_eq!(effective_poll(1000, true, None), 5000);
        assert_eq!(effective_poll(1000, true, Some(1000)), 1000);
        assert_eq!(effective_poll(1000, true, Some(10_000)), 5000);
        assert_eq!(effective_poll(8000, true, Some(2000)), 2000);
        assert_eq!(effective_poll(8000, true, None), 8000);
    }

    #[test]
    fn partial_and_odd_input_is_sanitized() {
        let s: Settings =
            serde_json::from_str(r#"{"pollIntervalMs": 50.4, "tempUnit": "f"}"#).unwrap();
        let s = s.sanitized();
        assert_eq!(s.poll_interval_ms, MIN_POLL_MS);
        assert_eq!(s.temp_unit, "F");
        assert!(s.minimize_to_tray);
        let s: Settings = serde_json::from_str(r#"{"pollIntervalMs": 999999}"#).unwrap();
        assert_eq!(s.sanitized().poll_interval_ms, MAX_POLL_MS);
    }

    #[test]
    fn program_files_check() {
        assert!(is_under_dir(
            r"c:\program files\nexum\nexum.exe",
            r"c:\program files"
        ));
        assert!(is_under_dir(
            r"c:\program files\nexum\nexum.exe",
            r"c:\program files\"
        ));
        assert!(!is_under_dir(
            r"c:\program files evil\nexum.exe",
            r"c:\program files"
        ));
        assert!(!is_under_dir(
            r"c:\program files\..\users\me\nexum.exe",
            r"c:\program files"
        ));
        assert!(!is_under_dir(r"c:\users\me\nexum.exe", r"c:\program files"));
        assert!(!is_under_dir(r"c:\program files", r"c:\program files"));
        assert!(!is_in_program_files(Path::new(
            r"C:\Users\me\Downloads\Nexum.exe"
        )));
    }

    #[test]
    fn xml_is_escaped() {
        let xml = task_xml(Path::new(r"C:\Apps & Tools\Nexum.exe"));
        assert!(xml.contains(r"C:\Apps &amp; Tools\Nexum.exe"));
        assert!(xml.contains("<Arguments>--minimized</Arguments>"));
    }

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "nexum-test-settings-{tag}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn junction(link: &Path, target: &Path) -> bool {
        hidden_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn settings_round_trip_and_overwrite() {
        let base = scratch("rt");
        let path = base.join("com.nexum.app").join("settings.json");
        let mut s = Settings::default();
        s.poll_interval_ms = 2000;
        write_to(&path, &s).unwrap();
        // Saving again replaces the file (and tolerates a stale temp file).
        std::fs::write(path.with_extension("json.tmp"), b"stale").unwrap();
        s.poll_interval_ms = 3000;
        write_to(&path, &s).unwrap();
        assert_eq!(load_from(&path).poll_interval_ms, 3000);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn settings_never_follow_a_planted_junction() {
        let base = scratch("junction");
        let target = scratch("junction-target");
        std::fs::write(target.join("settings.json"), br#"{"pollIntervalMs":4000}"#).unwrap();
        assert!(junction(&base.join("com.nexum.app"), &target));
        let path = base.join("com.nexum.app").join("settings.json");
        assert!(write_to(&path, &Settings::default()).is_err());
        // Neither written nor read (nor renamed to .bad) through the junction.
        assert_eq!(
            std::fs::read(target.join("settings.json")).unwrap(),
            br#"{"pollIntervalMs":4000}"#
        );
        assert!(!target.join("settings.json.tmp").exists());
        assert_eq!(load_from(&path).poll_interval_ms, Settings::default().poll_interval_ms);
        let _ = std::fs::remove_dir(base.join("com.nexum.app"));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&target);
    }
}
