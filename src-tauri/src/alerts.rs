//! Rust alert engine (CONTRACT §2.10): evaluates the hardware conditions on every telemetry
//! packet (so they work while the window is hidden), keeps the `HealthAlertsSnapshot`, sends
//! opt-in Windows notifications and maintains the tray tooltip.
//!
//! One source of truth per condition (§5.0): this module owns `drive:*`, `cpu-temp`,
//! `gpu-temp:*`, `gpu-mem-temp:*`, `drive-temp:*` and `space:*`. Drive-health thresholds stay in
//! the sidecar's classifier; Rust only maps `health.state` to a severity.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{AlertSettings, Settings};
use crate::state::AppState;
use crate::system_info::{PhysicalDisk, Volume};
use crate::util::{fmt_bytes, lock, now_ms};

const TICK: Duration = Duration::from_secs(1);
const VOLUME_REFRESH: Duration = Duration::from_secs(60);
const DISK_REFRESH: Duration = Duration::from_secs(600);
const TOOLTIP_EVERY: Duration = Duration::from_secs(5);
/// Tray values older than this show `—`.
const TRAY_VALUE_MAX_AGE: Duration = Duration::from_secs(15);
const TRAY_MAX_SENSORS: usize = 4;
/// Windows `NOTIFYICONDATAW.szTip` holds 128 UTF-16 units including the terminator.
const TOOLTIP_MAX_UNITS: usize = 127;
/// Per-alert and global notification throttles (CONTRACT §2.10.4).
const NOTIFY_SAME_ID_MS: u64 = 30 * 60 * 1000;
const NOTIFY_ANY_MS: u64 = 60 * 1000;
/// Hysteresis for clearing / de-escalating sustained alerts.
const HYSTERESIS_C: f64 = 3.0;

pub const GPU_HOTSPOT_CRIT_DEFAULT: f64 = 110.0;
pub const GPU_EDGE_WARN: f64 = 85.0;
pub const GPU_EDGE_CRIT: f64 = 95.0;
pub const GPU_MEM_CRIT_DEFAULT: f64 = 105.0;
pub const DRIVE_WARN_FALLBACK: f64 = 70.0;
pub const DRIVE_CRIT_FALLBACK: f64 = 80.0;
pub const CPU_DEFAULT_LIMIT: f64 = 90.0;

const RULE_DRIVE_CRIT: &str = "Critical when a drive reports a critical warning, spare below threshold, read-only, or ≤ 10% life left";
const RULE_DRIVE_WARN: &str = "Attention when a drive has ≤ 50% life left, reallocated, pending or uncorrectable sectors, a temperature warning, or a Windows health warning";

/// AMD "Max. Operating Temperature (Tjmax)" per model token (CONTRACT §2.10.2). F re-checks
/// every row on amd.com before release (ROADMAP Q9).
pub const CPU_TJMAX: [(&str, f64); 9] = [
    ("5600X", 95.0),
    ("5800X", 90.0),
    ("5900X", 90.0),
    ("5950X", 90.0),
    ("5800X3D", 90.0),
    ("5700X3D", 90.0),
    ("7800X3D", 89.0),
    ("7950X", 95.0),
    ("9800X3D", 95.0),
];

// ---------------------------------------------------------------------------------------------
// Shapes (CONTRACT §2.10.1)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Sev {
    Warn,
    Crit,
}

impl Sev {
    fn as_str(self) -> &'static str {
        match self {
            Sev::Warn => "warn",
            Sev::Crit => "crit",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthAlert {
    pub id: String,
    pub severity: &'static str,
    pub source: &'static str,
    pub title: String,
    pub detail: String,
    pub short: String,
    pub group: String,
    pub rule: String,
    pub dismiss_key: String,
    pub since_ts: u64,
    pub value: Option<f64>,
    pub threshold: Option<f64>,
    pub subject_id: Option<String>,
    pub sensor_id: Option<String>,
    /// Sort key: rule order of §2.10.3 (not serialized).
    #[serde(skip)]
    order: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuLimitInfo {
    pub model: Option<String>,
    pub limit_c: f64,
    pub warn_c: f64,
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthAlertsSnapshot {
    pub ready: bool,
    pub evaluated_ts: Option<u64>,
    pub alerts: Vec<HealthAlert>,
    pub rules: Vec<String>,
    pub cpu_limit: CpuLimitInfo,
}

impl HealthAlertsSnapshot {
    /// Equal for the `health-alerts` "changed" test (everything except `evaluatedTs`).
    fn same_as(&self, other: &HealthAlertsSnapshot) -> bool {
        self.ready == other.ready
            && self.alerts == other.alerts
            && self.rules == other.rules
            && self.cpu_limit == other.cpu_limit
    }
}

// ---------------------------------------------------------------------------------------------
// Per-model CPU limit (CONTRACT §2.10.2)
// ---------------------------------------------------------------------------------------------

/// The model token of `/Ryzen\s+\d\s+(PRO\s+)?(\d{4}[A-Z0-9]*)/i` (group 2, uppercased).
pub fn cpu_model_token(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let b = name.as_bytes();
    let mut search = 0usize;
    while let Some(pos) = lower[search..].find("ryzen") {
        let start = search + pos;
        search = start + 5;
        let mut i = start + 5;
        let ws = |i: &mut usize| {
            let s = *i;
            while *i < b.len() && b[*i].is_ascii_whitespace() {
                *i += 1;
            }
            *i > s
        };
        if !ws(&mut i) {
            continue;
        }
        if i >= b.len() || !b[i].is_ascii_digit() {
            continue;
        }
        i += 1;
        if !ws(&mut i) {
            continue;
        }
        // Optional "PRO" + whitespace.
        let mut j = i;
        if lower[j..].starts_with("pro") {
            let mut k = j + 3;
            if ws(&mut k) {
                j = k;
            }
        }
        for cand in [j, i] {
            let digits = b[cand..]
                .iter()
                .take(4)
                .filter(|c| c.is_ascii_digit())
                .count();
            if cand + 4 <= b.len() && digits == 4 {
                let mut end = cand + 4;
                while end < b.len() && b[end].is_ascii_alphanumeric() {
                    end += 1;
                }
                return Some(name[cand..end].to_ascii_uppercase());
            }
        }
    }
    None
}

/// `cpuLimit` for a CPU name and the user's override.
pub fn cpu_limit(cpu_name: Option<&str>, user: Option<u32>) -> CpuLimitInfo {
    let model = cpu_name.and_then(cpu_model_token);
    let table = model
        .as_deref()
        .and_then(|m| CPU_TJMAX.iter().find(|(t, _)| *t == m).map(|(_, l)| *l));
    let (limit, source) = match (user, table) {
        (Some(u), _) => (u as f64, "user"),
        (None, Some(t)) => (t, "table"),
        (None, None) => (CPU_DEFAULT_LIMIT, "default"),
    };
    CpuLimitInfo {
        model,
        limit_c: limit,
        warn_c: limit - 5.0,
        source,
    }
}

// ---------------------------------------------------------------------------------------------
// Sustained evaluation (CONTRACT §2.10.3)
// ---------------------------------------------------------------------------------------------

/// Samples of one signal over the last `S` seconds and its current level.
#[derive(Debug, Default, Clone)]
pub struct Sustain {
    samples: VecDeque<(u64, Option<f64>)>,
    pub level: Option<Sev>,
    pub since: u64,
}

impl Sustain {
    /// Adds a sample (packet ts, value) and drops samples older than the window.
    pub fn push(&mut self, ts: u64, value: Option<f64>, window_ms: u64) {
        if let Some(&(last, _)) = self.samples.back() {
            if ts < last {
                // The clock went backwards: start over (never fire on mixed timelines).
                self.samples.clear();
            } else if ts == last {
                self.samples.pop_back();
            }
        }
        self.samples
            .push_back((ts, value.filter(|v| v.is_finite())));
        self.trim(window_ms);
    }

    fn trim(&mut self, window_ms: u64) {
        let Some(&(newest, _)) = self.samples.back() else {
            return;
        };
        let from = newest.saturating_sub(window_ms);
        while self.samples.front().is_some_and(|(t, _)| *t < from) {
            self.samples.pop_front();
        }
    }

    /// ≥ 3 samples, the oldest ≥ 0.8 × S old, all non-null, minimum ≥ `threshold`.
    pub fn met(&self, threshold: f64, window_ms: u64) -> bool {
        if self.samples.len() < 3 {
            return false;
        }
        let (Some(&(oldest, _)), Some(&(newest, _))) = (self.samples.front(), self.samples.back())
        else {
            return false;
        };
        if ((newest - oldest) as f64) < 0.8 * window_ms as f64 {
            return false;
        }
        let mut min = f64::INFINITY;
        for (_, v) in &self.samples {
            match v {
                Some(x) => min = min.min(*x),
                None => return false,
            }
        }
        min >= threshold
    }

    /// The last 3 samples are all non-null and below `threshold`.
    pub fn last3_below(&self, threshold: f64) -> bool {
        self.samples.len() >= 3
            && self
                .samples
                .iter()
                .rev()
                .take(3)
                .all(|(_, v)| v.is_some_and(|x| x < threshold))
    }

    /// The newest non-null reading in the window.
    pub fn latest(&self) -> Option<f64> {
        self.samples.iter().rev().find_map(|(_, v)| *v)
    }

    /// Applies the transition rules; updates `level`/`since` and returns the new level.
    pub fn evaluate(&mut self, warn: f64, crit: f64, window_ms: u64, now_ts: u64) -> Option<Sev> {
        self.trim(window_ms);
        let next = match self.level {
            None => {
                if self.met(crit, window_ms) {
                    Some(Sev::Crit)
                } else if self.met(warn, window_ms) {
                    Some(Sev::Warn)
                } else {
                    None
                }
            }
            Some(Sev::Warn) => {
                if self.met(crit, window_ms) {
                    Some(Sev::Crit)
                } else if self.last3_below(warn - HYSTERESIS_C) {
                    None
                } else {
                    Some(Sev::Warn)
                }
            }
            Some(Sev::Crit) => {
                if self.last3_below(crit - HYSTERESIS_C) {
                    if self.last3_below(warn - HYSTERESIS_C) {
                        None
                    } else {
                        Some(Sev::Warn)
                    }
                } else {
                    Some(Sev::Crit)
                }
            }
        };
        if next != self.level {
            self.level = next;
            self.since = now_ts;
        }
        next
    }
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/// `85 °C` / `185 °F`, 0 decimals.
pub fn fmt_temp(c: f64, unit: &str) -> String {
    if unit == "F" {
        format!("{} °F", (c * 9.0 / 5.0 + 32.0).round() as i64)
    } else {
        format!("{} °C", c.round() as i64)
    }
}

/// en-US thousands separators (`20,188`).
pub fn fmt_count(n: f64) -> String {
    let v = n.round() as i64;
    let digits = v.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if v < 0 {
        format!("-{out}")
    } else {
        out
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|f| f.is_finite())
}

fn drive_short(label: &str) -> String {
    match label {
        "Failing" => "1 drive failing".into(),
        "Replace soon" => "1 drive: replace soon".into(),
        "Worn" => "1 drive worn".into(),
        "Check sectors" => "1 drive: check sectors".into(),
        "Overheating" => "1 drive overheating".into(),
        "Windows warning" => "1 drive: Windows warning".into(),
        other => format!("1 drive: {}", other.to_lowercase()),
    }
}

fn drive_advice(label: &str) -> &'static str {
    match label {
        "Worn" | "Replace soon" => "Copy important files and plan a replacement.",
        "Failing" => "Back up important files now and replace this drive.",
        "Check sectors" => "Back up important files and run the drive maker's diagnostic.",
        "Overheating" => "Improve airflow around the drive.",
        "Windows warning" => {
            "Back up important files and check the drive in Windows Settings › Storage."
        }
        _ => "",
    }
}

/// `<life>% life left (<percentageUsed>% of rated endurance used, <h> h). <advice>`.
pub fn drive_detail(disk: &Value, label: &str) -> String {
    let head = num(disk, "healthPct").map(|h| format!("{}% life left", h.round() as i64));
    let mut paren: Vec<String> = Vec::new();
    if let Some(p) = num(disk, "percentageUsed") {
        paren.push(format!("{}% of rated endurance used", p.round() as i64));
    }
    if let Some(h) = num(disk, "powerOnHours") {
        paren.push(format!("{} h", fmt_count(h)));
    }
    let first = match (head, paren.is_empty()) {
        (Some(h), false) => format!("{h} ({}). ", paren.join(", ")),
        (Some(h), true) => format!("{h}. "),
        (None, false) => {
            let p = paren.join(", ");
            let mut c = p.chars();
            match c.next() {
                Some(f) => format!("{}{}. ", f.to_uppercase(), c.as_str()),
                None => String::new(),
            }
        }
        (None, true) => String::new(),
    };
    format!("{first}{}", drive_advice(label)).trim().to_string()
}

/// CONTRACT §1.1.3 serial normalization.
fn norm_serial(s: &str) -> Option<String> {
    crate::drive_history::norm_serial(s)
}

/// Display names of telemetry disks (by `DiskTelemetry.id`), joined to `PhysicalDisk` by the
/// §1.1.3 rule: serial first, then disk number; `<volumes> (<model>)`, `<model>`, else the
/// telemetry name.
pub fn drive_names(physical: &[PhysicalDisk], tele: &[Value]) -> HashMap<String, String> {
    let mut used: HashSet<usize> = HashSet::new();
    let mut joined: Vec<Option<usize>> = vec![None; physical.len()];
    for (i, d) in physical.iter().enumerate() {
        let Some(ps) = norm_serial(&d.serial) else {
            continue;
        };
        if let Some(j) = tele.iter().enumerate().position(|(k, t)| {
            !used.contains(&k)
                && t.get("serial")
                    .and_then(Value::as_str)
                    .and_then(norm_serial)
                    .as_deref()
                    == Some(ps.as_str())
        }) {
            used.insert(j);
            joined[i] = Some(j);
        }
    }
    for (i, d) in physical.iter().enumerate() {
        if joined[i].is_some() || d.device_id.trim().is_empty() {
            continue;
        }
        let Ok(n) = d.device_id.trim().parse::<f64>() else {
            continue;
        };
        if let Some(j) = tele.iter().enumerate().position(|(k, t)| {
            !used.contains(&k) && t.get("diskNumber").and_then(Value::as_f64) == Some(n)
        }) {
            used.insert(j);
            joined[i] = Some(j);
        }
    }
    let mut out = HashMap::new();
    for t in tele {
        if let Some(id) = t.get("id").and_then(Value::as_str) {
            let name = t
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Drive")
                .to_string();
            out.insert(id.to_string(), name);
        }
    }
    for (i, d) in physical.iter().enumerate() {
        let Some(j) = joined[i] else { continue };
        let Some(id) = tele[j].get("id").and_then(Value::as_str) else {
            continue;
        };
        let model = if d.model.trim().is_empty() {
            tele[j]
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Drive")
                .to_string()
        } else {
            d.model.trim().to_string()
        };
        let vols: Vec<&str> = d
            .volumes
            .iter()
            .map(String::as_str)
            .filter(|v| !v.is_empty())
            .collect();
        let name = if vols.is_empty() {
            model
        } else {
            format!("{} ({model})", vols.join(", "))
        };
        out.insert(id.to_string(), name);
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Thresholds and rule texts
// ---------------------------------------------------------------------------------------------

/// Everything the rules need from the settings.
#[derive(Debug, Clone)]
pub struct Params {
    pub alerts: AlertSettings,
    pub unit: String,
    pub cpu: CpuLimitInfo,
}

impl Params {
    pub fn from_settings(s: &Settings, cpu_name: Option<&str>) -> Self {
        Self {
            alerts: s.alerts.clone(),
            unit: s.temp_unit.clone(),
            cpu: cpu_limit(cpu_name, s.alerts.cpu_temp_c),
        }
    }
    fn window_ms(&self) -> u64 {
        self.alerts.sustain_sec as u64 * 1000
    }
    fn hs_crit(&self) -> f64 {
        self.alerts
            .gpu_hotspot_c
            .map(f64::from)
            .unwrap_or(GPU_HOTSPOT_CRIT_DEFAULT)
    }
    fn mj_crit(&self) -> f64 {
        self.alerts
            .gpu_mem_junction_c
            .map(f64::from)
            .unwrap_or(GPU_MEM_CRIT_DEFAULT)
    }
    fn t(&self, c: f64) -> String {
        fmt_temp(c, &self.unit)
    }
    fn src_text(&self) -> &'static str {
        match self.cpu.source {
            "table" => "AMD specification",
            "user" => "your setting",
            _ => "default, this CPU model is not in Nexum's table",
        }
    }

    /// The seven rule texts (drive crit, drive warn, cpu, gpu, gpu-mem, drive-temp, space).
    pub fn rules(&self) -> Vec<String> {
        let s = self.alerts.sustain_sec;
        vec![
            RULE_DRIVE_CRIT.to_string(),
            RULE_DRIVE_WARN.to_string(),
            format!(
                "Attention when the CPU stays at or above {} for {s} s; critical at or above {}",
                self.t(self.cpu.warn_c),
                self.t(self.cpu.limit_c)
            ),
            format!(
                "Attention when a GPU hot spot stays at or above {} (edge {}) for {s} s; critical at or above {} (edge {})",
                self.t(self.hs_crit() - 10.0),
                self.t(GPU_EDGE_WARN),
                self.t(self.hs_crit()),
                self.t(GPU_EDGE_CRIT)
            ),
            format!(
                "Attention when GPU memory stays at or above {} for {s} s; critical at or above {}",
                self.t(self.mj_crit() - 10.0),
                self.t(self.mj_crit())
            ),
            format!(
                "Attention when a drive stays at or above its warning temperature ({} if not reported) for {s} s; critical at its critical temperature ({})",
                self.t(DRIVE_WARN_FALLBACK),
                self.t(DRIVE_CRIT_FALLBACK)
            ),
            format!(
                "Attention when a fixed drive has less than {}% free space; critical below {}%",
                self.alerts.free_space_pct,
                self.alerts.free_space_crit_pct()
            ),
        ]
    }
}

/// Kind of a sustained signal; decides thresholds and texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalKind {
    Cpu,
    GpuHotspot(usize),
    GpuEdge(usize),
    GpuMem(usize),
    DriveTemp,
}

/// One sustained signal of a packet.
#[derive(Debug, Clone)]
struct Signal {
    id: String,
    kind: SignalKind,
    value: Option<f64>,
    warn: f64,
    crit: f64,
    /// Display subject: GPU name / drive telemetry id.
    subject: Option<String>,
    name: String,
}

/// The sustained signals of a packet with their thresholds.
fn signals(packet: &Value, p: &Params) -> Vec<Signal> {
    let mut out = Vec::new();
    out.push(Signal {
        id: "cpu-temp".into(),
        kind: SignalKind::Cpu,
        value: packet.get("cpu").and_then(|c| num(c, "packageTempC")),
        warn: p.cpu.warn_c,
        crit: p.cpu.limit_c,
        subject: None,
        name: "CPU".into(),
    });
    for (i, g) in packet
        .get("gpus")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let name = g
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("GPU")
            .to_string();
        let hotspot = num(g, "hotspotTempC");
        let (kind, value, warn, crit) = match hotspot {
            Some(h) => (
                SignalKind::GpuHotspot(i),
                Some(h),
                p.hs_crit() - 10.0,
                p.hs_crit(),
            ),
            None => (
                SignalKind::GpuEdge(i),
                num(g, "tempC"),
                GPU_EDGE_WARN,
                GPU_EDGE_CRIT,
            ),
        };
        out.push(Signal {
            id: format!("gpu-temp:{i}"),
            kind,
            value,
            warn,
            crit,
            subject: Some(i.to_string()),
            name: name.clone(),
        });
        out.push(Signal {
            id: format!("gpu-mem-temp:{i}"),
            kind: SignalKind::GpuMem(i),
            value: num(g, "memJunctionTempC"),
            warn: p.mj_crit() - 10.0,
            crit: p.mj_crit(),
            subject: Some(i.to_string()),
            name,
        });
    }
    for d in packet
        .get("disks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = d.get("id").and_then(Value::as_str) else {
            continue;
        };
        out.push(Signal {
            id: format!("drive-temp:{id}"),
            kind: SignalKind::DriveTemp,
            value: num(d, "tempC"),
            warn: num(d, "warningTempC").unwrap_or(DRIVE_WARN_FALLBACK),
            crit: num(d, "criticalTempC").unwrap_or(DRIVE_CRIT_FALLBACK),
            subject: Some(id.to_string()),
            name: d
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Drive")
                .to_string(),
        });
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Sensor id resolution (lib/sensors.ts findSensor rules)
// ---------------------------------------------------------------------------------------------

const CPU_TEMP_NAMES: [&str; 6] = [
    "Core (Tctl/Tdie)",
    "CPU Package",
    "Core (Tctl)",
    "Core (Tdie)",
    "Tctl/Tdie",
    "Package",
];

fn find_in_nodes<'a>(nodes: &[&'a Value], names: &[&str]) -> Option<&'a str> {
    for name in names {
        for n in nodes {
            for s in n
                .get("sensors")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if s.get("kind").and_then(Value::as_str) == Some("temperature")
                    && s.get("name").and_then(Value::as_str) == Some(*name)
                {
                    return s.get("id").and_then(Value::as_str);
                }
            }
        }
    }
    None
}

fn resolve_sensor_id(
    tree: &Value,
    kind: SignalKind,
    gpu_name: &str,
    subject: Option<&str>,
) -> Option<String> {
    let hw: Vec<&Value> = tree
        .get("hardware")
        .and_then(Value::as_array)?
        .iter()
        .collect();
    let of_kinds = |kinds: &[&str]| -> Vec<&Value> {
        hw.iter()
            .copied()
            .filter(|n| {
                n.get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|k| kinds.contains(&k))
            })
            .collect()
    };
    let gpu_node = |i: usize| -> Vec<&Value> {
        let gpus = of_kinds(&["gpuAmd", "gpuNvidia", "gpuIntel"]);
        let named: Vec<&Value> = gpus
            .iter()
            .copied()
            .filter(|n| n.get("name").and_then(Value::as_str) == Some(gpu_name))
            .collect();
        match named.len() {
            1 => named,
            _ => gpus.get(i).copied().into_iter().collect(),
        }
    };
    let found = match kind {
        SignalKind::Cpu => find_in_nodes(&of_kinds(&["cpu"]), &CPU_TEMP_NAMES),
        SignalKind::GpuHotspot(i) => find_in_nodes(&gpu_node(i), &["GPU Hot Spot"]),
        SignalKind::GpuEdge(i) => find_in_nodes(&gpu_node(i), &["GPU Core"]),
        SignalKind::GpuMem(i) => {
            find_in_nodes(&gpu_node(i), &["GPU Memory Junction", "GPU Memory"])
        }
        SignalKind::DriveTemp => {
            let node: Option<&Value> = hw
                .iter()
                .copied()
                .find(|n| n.get("id").and_then(Value::as_str) == subject);
            node.and_then(|n| {
                n.get("sensors")
                    .and_then(Value::as_array)?
                    .iter()
                    .find(|s| s.get("kind").and_then(Value::as_str) == Some("temperature"))
                    .and_then(|s| s.get("id").and_then(Value::as_str))
            })
        }
    };
    found.map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Engine {
    sustain: HashMap<String, Sustain>,
    /// Severity and since-ts of drive and space alerts (no sustain).
    instant: HashMap<String, (Sev, u64)>,
    telemetry_seen: bool,
    volumes_seen: bool,
    agent_up: bool,
    last_packet: Option<Value>,
    last_packet_at: Option<Instant>,
    volumes: Vec<Volume>,
    physical: Vec<PhysicalDisk>,
    snapshot: Option<HealthAlertsSnapshot>,
    notifier: Notifier,
}

#[derive(Default)]
struct TooltipState {
    last_text: Option<String>,
    last_built: Option<Instant>,
    /// Rebuild at the next tick even if 5 s have not passed (agent down, settings).
    force: bool,
}

#[derive(Default)]
pub struct AlertEngine {
    inner: Mutex<Engine>,
    tooltip: Mutex<TooltipState>,
}

/// Builds every alert from the engine state (pure apart from `now`).
fn build_alerts(e: &mut Engine, p: &Params, tree: Option<&Value>, now: u64) -> Vec<HealthAlert> {
    let mut out: Vec<HealthAlert> = Vec::new();
    let rules = p.rules();
    let s = p.alerts.sustain_sec;

    // Rules 1 and 2–5 need a live agent and a packet.
    if e.agent_up {
        if let Some(packet) = e.last_packet.clone() {
            let disks: Vec<Value> = packet
                .get("disks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let names = drive_names(&e.physical, &disks);

            // 1. Drive health (no sustain).
            let mut live_drive_ids: HashSet<String> = HashSet::new();
            for d in &disks {
                let Some(id) = d.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let state = d
                    .pointer("/health/state")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let sev = match state {
                    "failing" | "replace" => Sev::Crit,
                    "attention" => Sev::Warn,
                    _ => continue,
                };
                let label = d
                    .pointer("/health/label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let key = format!("drive:{id}");
                live_drive_ids.insert(key.clone());
                let since = match e.instant.get(&key) {
                    Some((prev, since)) if *prev == sev => *since,
                    _ => now,
                };
                e.instant.insert(key.clone(), (sev, since));
                let name = names.get(id).cloned().unwrap_or_else(|| id.to_string());
                out.push(HealthAlert {
                    id: key.clone(),
                    severity: sev.as_str(),
                    source: "drive",
                    title: format!("{name} — {label}"),
                    detail: drive_detail(d, &label),
                    short: drive_short(&label),
                    group: format!("drive:{label}"),
                    rule: if sev == Sev::Crit {
                        rules[0].clone()
                    } else {
                        rules[1].clone()
                    },
                    dismiss_key: format!("{key}:{state}"),
                    since_ts: since,
                    value: num(d, "healthPct"),
                    threshold: None,
                    subject_id: Some(id.to_string()),
                    sensor_id: None,
                    order: 1,
                });
            }
            e.instant
                .retain(|k, _| !k.starts_with("drive:") || live_drive_ids.contains(k));

            // 2–5. Sustained temperatures.
            for sig in signals(&packet, p) {
                let Some(st) = e.sustain.get(&sig.id) else {
                    continue;
                };
                let Some(level) = st.level else { continue };
                let thr = if level == Sev::Crit {
                    sig.crit
                } else {
                    sig.warn
                };
                let reading = st.latest().unwrap_or(thr);
                let (source, order, short, group, title, detail, rule) = match sig.kind {
                    SignalKind::Cpu => (
                        "cpu",
                        2,
                        "CPU hot",
                        "cpu-temp",
                        format!("CPU at {}", p.t(reading)),
                        format!(
                            "Above {} for {s} s. Limit for this CPU: {} ({}).",
                            p.t(thr),
                            p.t(p.cpu.limit_c),
                            p.src_text()
                        ),
                        rules[2].clone(),
                    ),
                    SignalKind::GpuHotspot(_) | SignalKind::GpuEdge(_) => (
                        "gpu",
                        3,
                        "GPU hot",
                        "gpu-temp",
                        format!("{} at {}", sig.name, p.t(reading)),
                        if matches!(sig.kind, SignalKind::GpuHotspot(_)) {
                            format!("Hot spot above {} for {s} s.", p.t(thr))
                        } else {
                            format!("Edge temperature above {} for {s} s.", p.t(thr))
                        },
                        rules[3].clone(),
                    ),
                    SignalKind::GpuMem(_) => (
                        "gpu",
                        4,
                        "GPU memory hot",
                        "gpu-mem-temp",
                        format!("{} memory at {}", sig.name, p.t(reading)),
                        format!("Memory junction above {} for {s} s.", p.t(thr)),
                        rules[4].clone(),
                    ),
                    SignalKind::DriveTemp => {
                        let id = sig.subject.clone().unwrap_or_default();
                        let name = names.get(&id).cloned().unwrap_or_else(|| sig.name.clone());
                        (
                            "drive",
                            5,
                            "Drive hot",
                            "drive-temp",
                            format!("{name} at {}", p.t(reading)),
                            format!("Above {} for {s} s.", p.t(thr)),
                            rules[5].clone(),
                        )
                    }
                };
                let sensor_id = tree.and_then(|t| {
                    resolve_sensor_id(t, sig.kind, &sig.name, sig.subject.as_deref())
                });
                out.push(HealthAlert {
                    id: sig.id.clone(),
                    severity: level.as_str(),
                    source,
                    title,
                    detail,
                    short: short.to_string(),
                    group: group.to_string(),
                    rule,
                    dismiss_key: format!("{}:{}", sig.id, level.as_str()),
                    since_ts: st.since,
                    value: st.latest(),
                    threshold: Some(thr),
                    subject_id: sig.subject.clone(),
                    sensor_id,
                    order,
                });
            }
        }
    }

    // 6. Free space (stays while the agent is down).
    let warn_pct = p.alerts.free_space_pct as f64;
    let crit_pct = p.alerts.free_space_crit_pct() as f64;
    let mut live_space: HashSet<String> = HashSet::new();
    for v in &e.volumes {
        if v.drive_type != "Fixed" || v.total_bytes == 0 {
            continue;
        }
        let pct = v.free_bytes as f64 / v.total_bytes as f64 * 100.0;
        let sev = if pct < crit_pct {
            Sev::Crit
        } else if pct < warn_pct {
            Sev::Warn
        } else {
            continue;
        };
        let key = format!("space:{}", v.letter);
        live_space.insert(key.clone());
        let since = match e.instant.get(&key) {
            Some((prev, since)) if *prev == sev => *since,
            _ => now,
        };
        e.instant.insert(key.clone(), (sev, since));
        let thr = if sev == Sev::Crit { crit_pct } else { warn_pct };
        out.push(HealthAlert {
            id: key.clone(),
            severity: sev.as_str(),
            source: "space",
            title: format!(
                "{} has {} free ({}%)",
                v.letter,
                fmt_bytes(v.free_bytes),
                pct.floor() as i64
            ),
            detail: format!("Below {}% free.", thr as i64),
            short: "Low disk space".into(),
            group: "space".into(),
            rule: rules[6].clone(),
            dismiss_key: format!("{key}:{}", sev.as_str()),
            since_ts: since,
            value: Some((pct * 10.0).round() / 10.0),
            threshold: Some(thr),
            subject_id: Some(v.letter.clone()),
            sensor_id: None,
            order: 6,
        });
    }
    e.instant
        .retain(|k, _| !k.starts_with("space:") || live_space.contains(k));

    sort_alerts(&mut out);
    out
}

/// Crit first, then rule order, then subject id.
pub fn sort_alerts(a: &mut [HealthAlert]) {
    a.sort_by(|x, y| {
        let sx = if x.severity == "crit" { 0 } else { 1 };
        let sy = if y.severity == "crit" { 0 } else { 1 };
        sx.cmp(&sy)
            .then(x.order.cmp(&y.order))
            .then(x.subject_id.cmp(&y.subject_id))
    });
}

/// Pushes the packet's samples into the sustained buffers and evaluates them.
fn ingest(e: &mut Engine, packet: &Value, p: &Params) {
    let ts = packet
        .get("ts")
        .and_then(Value::as_u64)
        .unwrap_or_else(now_ms);
    let window = p.window_ms();
    let sigs = signals(packet, p);
    let live: HashSet<&str> = sigs.iter().map(|s| s.id.as_str()).collect();
    e.sustain.retain(|k, _| live.contains(k.as_str()));
    for sig in &sigs {
        let st = e.sustain.entry(sig.id.clone()).or_default();
        st.push(ts, sig.value, window);
        st.evaluate(sig.warn, sig.crit, window, ts);
    }
}

/// Re-evaluates the buffered samples with the current thresholds (settings changed).
fn reevaluate(e: &mut Engine, p: &Params) {
    let Some(packet) = e.last_packet.clone() else {
        return;
    };
    let ts = packet
        .get("ts")
        .and_then(Value::as_u64)
        .unwrap_or_else(now_ms);
    let window = p.window_ms();
    for sig in signals(&packet, p) {
        if let Some(st) = e.sustain.get_mut(&sig.id) {
            st.evaluate(sig.warn, sig.crit, window, ts);
        }
    }
}

fn params_for(app: &AppHandle, e: &Engine) -> (Params, Vec<String>) {
    let s = lock(&app.state::<AppState>().settings).clone();
    let cpu_name = e
        .last_packet
        .as_ref()
        .and_then(|p| p.pointer("/cpu/name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (
        Params::from_settings(&s, cpu_name.as_deref()),
        s.dismissed_alerts,
    )
}

/// Rebuilds the snapshot; emits `health-alerts` and sends notifications when it changed.
fn publish(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (snapshot, changed, offers) = {
        let mut e = lock(&state.alerts.inner);
        let (p, dismissed) = params_for(app, &e);
        let now = now_ms();
        let has_temp = e.sustain.values().any(|s| s.level.is_some());
        let alerts = if has_temp {
            state
                .agent
                .with_sensor_tree(|tree| build_alerts(&mut e, &p, tree, now))
        } else {
            build_alerts(&mut e, &p, None, now)
        };
        let snapshot = HealthAlertsSnapshot {
            ready: e.agent_up && e.telemetry_seen && e.volumes_seen,
            evaluated_ts: Some(now),
            alerts,
            rules: p.rules(),
            cpu_limit: p.cpu.clone(),
        };
        let prev = e.snapshot.clone();
        let changed = prev.as_ref().map_or(true, |old| !old.same_as(&snapshot));
        // New or escalated alerts are notification candidates.
        let prev_sev: HashMap<&str, &str> = prev
            .as_ref()
            .map(|o| {
                o.alerts
                    .iter()
                    .map(|a| (a.id.as_str(), a.severity))
                    .collect()
            })
            .unwrap_or_default();
        let mut offers: Vec<(String, String, String, bool)> = Vec::new();
        for a in &snapshot.alerts {
            let escalation = match prev_sev.get(a.id.as_str()) {
                None => false,
                Some(&"warn") if a.severity == "crit" => true,
                Some(_) => continue,
            };
            if dismissed.iter().any(|d| d == &a.dismiss_key) {
                continue;
            }
            offers.push((a.id.clone(), a.title.clone(), a.detail.clone(), escalation));
        }
        e.snapshot = Some(snapshot.clone());
        (snapshot, changed, offers)
    };
    if changed {
        let _ = app.emit("health-alerts", snapshot);
    }
    if !offers.is_empty() {
        // Window queries run on the main thread; never block the agent reader on them.
        let app = app.clone();
        std::thread::spawn(move || notify_offers(&app, offers));
    }
}

// ---------------------------------------------------------------------------------------------
// Notifications (CONTRACT §2.10.4)
// ---------------------------------------------------------------------------------------------

/// What to show.
#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    Single { title: String, body: String },
    Summary { count: usize },
}

#[derive(Debug, Clone)]
struct Pending {
    id: String,
    title: String,
    body: String,
}

/// Throttling state: 30 min per alert id (escalation to crit may bypass it once), 60 s between
/// any two notifications (later ones are held and summarized).
#[derive(Debug, Default)]
pub struct Notifier {
    last_by_id: HashMap<String, u64>,
    bypass_by_id: HashMap<String, u64>,
    last_any: Option<u64>,
    pending: Vec<Pending>,
}

impl Notifier {
    /// An alert became active or escalated (already checked: opted in, not dismissed, window
    /// not in front). Returns what to show now, if anything.
    pub fn offer(
        &mut self,
        id: &str,
        title: &str,
        body: &str,
        escalation: bool,
        now: u64,
    ) -> Option<Outgoing> {
        if let Some(&last) = self.last_by_id.get(id) {
            if now.saturating_sub(last) < NOTIFY_SAME_ID_MS {
                let bypass_used = self
                    .bypass_by_id
                    .get(id)
                    .is_some_and(|&b| now.saturating_sub(b) < NOTIFY_SAME_ID_MS);
                if !escalation || bypass_used {
                    return None;
                }
                self.bypass_by_id.insert(id.to_string(), now);
            }
        }
        let item = Pending {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        };
        if self
            .last_any
            .is_some_and(|l| now.saturating_sub(l) < NOTIFY_ANY_MS)
        {
            self.pending.retain(|p| p.id != id);
            self.pending.push(item);
            return None;
        }
        self.last_any = Some(now);
        self.last_by_id.insert(id.to_string(), now);
        Some(Outgoing::Single {
            title: format!("Nexum: {}", item.title),
            body: item.body,
        })
    }

    /// Once 60 s passed since the last notification: one summary of the held alerts that are
    /// still active (a single one is shown as itself).
    pub fn tick(&mut self, active: &HashSet<String>, now: u64) -> Option<Outgoing> {
        self.pending.retain(|p| active.contains(&p.id));
        if self.pending.is_empty()
            || self
                .last_any
                .is_some_and(|l| now.saturating_sub(l) < NOTIFY_ANY_MS)
        {
            return None;
        }
        let pending = std::mem::take(&mut self.pending);
        self.last_any = Some(now);
        for p in &pending {
            self.last_by_id.insert(p.id.clone(), now);
        }
        Some(if pending.len() == 1 {
            Outgoing::Single {
                title: format!("Nexum: {}", pending[0].title),
                body: pending[0].body.clone(),
            }
        } else {
            Outgoing::Summary {
                count: pending.len(),
            }
        })
    }
}

/// Ids of the snapshot's alerts whose current `dismissKey` is not dismissed: the held
/// notifications that may still be sent.
pub fn notifiable_ids(
    snapshot: Option<&HealthAlertsSnapshot>,
    dismissed: &[String],
) -> HashSet<String> {
    snapshot
        .map(|s| {
            s.alerts
                .iter()
                .filter(|a| !dismissed.iter().any(|d| d == &a.dismiss_key))
                .map(|a| a.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Hidden, minimized or not focused.
fn window_in_background(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    if state.in_tray.load(Ordering::SeqCst) {
        return true;
    }
    match app.get_webview_window(crate::MAIN_WINDOW) {
        Some(w) => {
            !w.is_visible().unwrap_or(false)
                || w.is_minimized().unwrap_or(false)
                || !w.is_focused().unwrap_or(false)
        }
        None => true,
    }
}

fn show(app: &AppHandle, out: Outgoing) {
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = match out {
        Outgoing::Single { title, body } => (title, body),
        Outgoing::Summary { count } => (
            format!("Nexum: {count} new alerts"),
            "Open Nexum to see them.".to_string(),
        ),
    };
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[nexum] notification failed: {e}");
    }
}

fn notify_offers(app: &AppHandle, offers: Vec<(String, String, String, bool)>) {
    let enabled = lock(&app.state::<AppState>().settings)
        .alerts
        .desktop_notifications;
    if !enabled || !window_in_background(app) {
        return;
    }
    let now = now_ms();
    let mut outs = Vec::new();
    {
        let state = app.state::<AppState>();
        let mut e = lock(&state.alerts.inner);
        for (id, title, body, esc) in offers {
            if let Some(o) = e.notifier.offer(&id, &title, &body, esc, now) {
                outs.push(o);
            }
        }
    }
    for o in outs {
        show(app, o);
    }
}

// ---------------------------------------------------------------------------------------------
// Tray tooltip (CONTRACT §2.10.5)
// ---------------------------------------------------------------------------------------------

/// Joins lines and cuts at a line boundary so the text fits in `max_units` UTF-16 units.
pub fn fit_tooltip(lines: &[String], max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for (i, l) in lines.iter().enumerate() {
        let add = l.encode_utf16().count() + usize::from(i > 0);
        if units + add > max_units {
            if i == 0 {
                // A first line that alone is too long: cut it by characters.
                for ch in l.chars() {
                    let n = ch.len_utf16();
                    if units + n > max_units {
                        break;
                    }
                    out.push(ch);
                    units += n;
                }
            }
            break;
        }
        if i > 0 {
            out.push('\n');
        }
        out.push_str(l);
        units += add;
    }
    out
}

/// `Nexum · No alerts` / `Nexum · 1 alert` / `Nexum · N alerts` / `Nexum · Agent offline`.
pub fn tooltip_head(agent_up: bool, alerts: usize) -> String {
    match (agent_up, alerts) {
        (false, _) => "Nexum · Agent offline".into(),
        (true, 0) => "Nexum · No alerts".into(),
        (true, 1) => "Nexum · 1 alert".into(),
        (true, n) => format!("Nexum · {n} alerts"),
    }
}

/// A sensor value with its decimals and unit; °C → °F when asked; `—` for null.
pub fn fmt_sensor(v: Option<f64>, decimals: u32, unit: &str, temp_unit: &str) -> String {
    let Some(mut x) = v.filter(|x| x.is_finite()) else {
        return "—".into();
    };
    let mut unit = unit.to_string();
    if unit == "°C" && temp_unit == "F" {
        x = x * 9.0 / 5.0 + 32.0;
        unit = "°F".into();
    }
    let n = format!("{:.*}", decimals.min(6) as usize, x);
    if unit.is_empty() {
        n
    } else if unit == "%" {
        format!("{n}%")
    } else {
        format!("{n} {unit}")
    }
}

/// A user label or sensor name as one tooltip line: control characters become spaces (a label
/// must not add lines of its own), bidirectional override/isolate marks are dropped.
fn tooltip_text(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// Tray sensor lines (`<label>: <value>`), at most four; ids not in the tree are skipped.
pub fn tray_sensor_lines(
    ids: &[String],
    tree: &Value,
    values: Option<&Value>,
    labels: &std::collections::BTreeMap<String, String>,
    temp_unit: &str,
) -> Vec<String> {
    let rev = tree.get("rev").and_then(Value::as_u64);
    let vals = values
        .filter(|v| v.get("rev").and_then(Value::as_u64) == rev)
        .and_then(|v| v.get("value"))
        .and_then(Value::as_array);
    let mut metas: HashMap<&str, &Value> = HashMap::new();
    for hw in tree
        .get("hardware")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for s in hw
            .get("sensors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = s.get("id").and_then(Value::as_str) {
                metas.insert(id, s);
            }
        }
    }
    let mut out = Vec::new();
    for id in ids {
        if out.len() >= TRAY_MAX_SENSORS {
            break;
        }
        let Some(meta) = metas.get(id.as_str()) else {
            continue;
        };
        let name = meta.get("name").and_then(Value::as_str).unwrap_or(id);
        let label = labels.get(id).map(String::as_str).unwrap_or(name);
        let v = meta
            .get("idx")
            .and_then(Value::as_u64)
            .and_then(|i| vals.and_then(|a| a.get(i as usize)))
            .and_then(Value::as_f64);
        let decimals = meta.get("decimals").and_then(Value::as_u64).unwrap_or(1) as u32;
        let unit = meta.get("unit").and_then(Value::as_str).unwrap_or("");
        out.push(format!(
            "{}: {}",
            tooltip_text(label),
            fmt_sensor(v, decimals, unit, temp_unit)
        ));
    }
    out
}

fn build_tooltip(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let (agent_up, count, packet) = {
        let e = lock(&state.alerts.inner);
        (
            e.agent_up,
            e.snapshot.as_ref().map_or(0, |s| s.alerts.len()),
            e.last_packet.clone(),
        )
    };
    let mut lines = vec![tooltip_head(agent_up, count)];
    let (labels, unit) = {
        let s = lock(&state.settings);
        (s.sensor_labels.clone(), s.temp_unit.clone())
    };
    let ids = lock(&state.tray_sensors).clone();
    let values = lock(&state.latest_values)
        .as_ref()
        .filter(|(at, _)| at.elapsed() <= TRAY_VALUE_MAX_AGE)
        .map(|(_, v)| v.clone());
    let sensor_lines = if ids.is_empty() || !agent_up {
        Vec::new()
    } else {
        state.agent.with_sensor_tree(|tree| match tree {
            Some(t) => tray_sensor_lines(&ids, t, values.as_ref(), &labels, &unit),
            None => Vec::new(),
        })
    };
    if sensor_lines.is_empty() {
        if let Some(p) = packet.filter(|_| agent_up) {
            if let Some(c) = p.get("cpu").and_then(|c| num(c, "packageTempC")) {
                lines.push(format!("CPU: {}", fmt_temp(c, &unit)));
            }
            let g = p
                .get("gpu")
                .and_then(|g| num(g, "hotspotTempC").or_else(|| num(g, "tempC")));
            if let Some(g) = g {
                lines.push(format!("GPU: {}", fmt_temp(g, &unit)));
            }
        }
    } else {
        lines.extend(sensor_lines);
    }
    fit_tooltip(&lines, TOOLTIP_MAX_UNITS)
}

/// Asks the alerts thread to rebuild the tooltip at its next tick.
pub(crate) fn request_tooltip(app: &AppHandle) {
    lock(&app.state::<AppState>().alerts.tooltip).force = true;
}

/// Rebuilds the tooltip (at most every 5 s unless requested) and sets it when it changed.
/// Only the alerts thread calls this: `set_tooltip` waits for the main thread.
fn update_tooltip(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let t = lock(&state.alerts.tooltip);
        if !t.force && t.last_built.is_some_and(|b| b.elapsed() < TOOLTIP_EVERY) {
            return;
        }
    }
    let text = build_tooltip(app);
    {
        let mut t = lock(&state.alerts.tooltip);
        t.last_built = Some(Instant::now());
        t.force = false;
        if t.last_text.as_deref() == Some(text.as_str()) {
            return;
        }
    }
    // No lock is held while the main thread applies the tooltip.
    if let Some(tray) = app.tray_by_id(crate::TRAY_ID) {
        match tray.set_tooltip(Some(text.as_str())) {
            Ok(()) => lock(&state.alerts.tooltip).last_text = Some(text),
            Err(e) => eprintln!("[nexum] tray tooltip: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/// Every telemetry packet.
pub fn on_telemetry(app: &AppHandle, packet: &Value) {
    let state = app.state::<AppState>();
    {
        let mut e = lock(&state.alerts.inner);
        // Thresholds use this packet's CPU name.
        let p = {
            let s = lock(&state.settings);
            Params::from_settings(&s, packet.pointer("/cpu/name").and_then(Value::as_str))
        };
        e.agent_up = true;
        e.telemetry_seen = true;
        e.last_packet = Some(packet.clone());
        e.last_packet_at = Some(Instant::now());
        ingest(&mut e, packet, &p);
    }
    publish(app);
}

/// Agent exited: clear everything but `space:*`; not ready.
pub fn on_agent_down(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut e = lock(&state.alerts.inner);
        e.agent_up = false;
        e.sustain.clear();
        e.instant.retain(|k, _| k.starts_with("space:"));
        e.last_packet = None;
        e.last_packet_at = None;
    }
    publish(app);
    request_tooltip(app);
}

/// Fresh volume data (the 60 s refresh or a frontend `get_volumes`).
pub fn on_volumes(app: &AppHandle, volumes: Vec<Volume>) {
    {
        let state = app.state::<AppState>();
        let mut e = lock(&state.alerts.inner);
        e.volumes = volumes;
        e.volumes_seen = true;
    }
    publish(app);
}

/// Fresh physical disks (drive names).
pub fn on_physical(app: &AppHandle, disks: Vec<PhysicalDisk>) {
    {
        let state = app.state::<AppState>();
        let mut e = lock(&state.alerts.inner);
        e.physical = disks;
    }
    publish(app);
}

/// Thresholds, unit or dismissals changed: re-evaluate and emit at once.
pub fn on_settings_changed(app: &AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut e = lock(&state.alerts.inner);
        let (p, _) = params_for(app, &e);
        reevaluate(&mut e, &p);
    }
    publish(app);
    request_tooltip(app);
}

/// Current snapshot (an evaluated empty one before the first evaluation).
pub fn snapshot(app: &AppHandle) -> HealthAlertsSnapshot {
    let state = app.state::<AppState>();
    let e = lock(&state.alerts.inner);
    if let Some(s) = e.snapshot.clone() {
        return s;
    }
    let (p, _) = params_for(app, &e);
    HealthAlertsSnapshot {
        ready: false,
        evaluated_ts: None,
        alerts: Vec::new(),
        rules: p.rules(),
        cpu_limit: p.cpu,
    }
}

/// Background work: volume/disk refresh, stale-telemetry check, held notifications, tooltip.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-alerts".into())
        .spawn(move || {
            let mut last_volumes: Option<Instant> = None;
            let mut last_disks: Option<Instant> = None;
            loop {
                let state = app.state::<AppState>();
                if state.quitting.load(Ordering::SeqCst) {
                    break;
                }
                if last_disks.map_or(true, |t| t.elapsed() >= DISK_REFRESH) {
                    last_disks = Some(Instant::now());
                    on_physical(&app, crate::system_info::collect_physical_disks());
                }
                if last_volumes.map_or(true, |t| t.elapsed() >= VOLUME_REFRESH) {
                    last_volumes = Some(Instant::now());
                    on_volumes(&app, crate::system_info::collect_volumes());
                }
                // Stale telemetry: clear every non-space alert and its samples.
                let stale_ms = 5000u64.max(3 * crate::settings::effective_poll_ms(&app));
                let stale = {
                    let mut e = lock(&state.alerts.inner);
                    let stale = e
                        .last_packet_at
                        .is_some_and(|t| t.elapsed().as_millis() as u64 > stale_ms);
                    if stale {
                        e.sustain.clear();
                        e.instant.retain(|k, _| k.starts_with("space:"));
                        e.last_packet = None;
                        e.last_packet_at = None;
                    }
                    stale
                };
                if stale {
                    publish(&app);
                }
                // Held notifications: only alerts that are still active and not dismissed in
                // the meantime, and only while every send condition still holds (§2.10.4).
                let dismissed = lock(&state.settings).dismissed_alerts.clone();
                let out = {
                    let mut e = lock(&state.alerts.inner);
                    let active = notifiable_ids(e.snapshot.as_ref(), &dismissed);
                    e.notifier.tick(&active, now_ms())
                };
                if let Some(o) = out {
                    let enabled = lock(&state.settings).alerts.desktop_notifications;
                    if enabled && window_in_background(&app) {
                        show(&app, o);
                    }
                }
                update_tooltip(&app);
                std::thread::sleep(TICK);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[nexum] alert engine thread unavailable: {e}");
    }
}

/// Registers the notification click handler: a click shows Nexum on the Dashboard.
pub fn register_notification_click(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    let _ = app.notification().on_action(move |action| {
        if action.action_id() == "tap" {
            crate::navigate(&handle, "dashboard");
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_health_alerts(app: AppHandle) -> Result<HealthAlertsSnapshot, String> {
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn dismiss_alert(app: AppHandle, dismiss_key: String) -> Result<Settings, String> {
    let key = dismiss_key.trim().to_string();
    if key.is_empty() {
        return Err("Missing alert key".to_string());
    }
    let worker = app.clone();
    let (_, new) = tauri::async_runtime::spawn_blocking(move || {
        crate::settings::update_settings(&worker, |s| {
            s.dismissed_alerts.retain(|d| d != &key);
            s.dismissed_alerts.push(key);
        })
    })
    .await
    .map_err(|e| format!("Settings worker failed: {e}"))??;
    Ok(new)
}

/// Cleans the tray id list: trimmed, non-empty, deduplicated, at most 12.
pub fn clean_tray_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let t = id.trim().to_string();
        if !t.is_empty() && t.len() <= 512 && !out.contains(&t) {
            out.push(t);
        }
        if out.len() >= crate::settings::MAX_PINNED {
            break;
        }
    }
    out
}

#[tauri::command]
pub fn set_tray_sensors(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let ids = clean_tray_ids(ids);
    *lock(&app.state::<AppState>().tray_sensors) = ids;
    crate::agent::sync_sensor_stream(&app, false);
    request_tooltip(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn win(s: &mut Sustain, start: u64, values: &[Option<f64>], step: u64, window: u64) {
        for (i, v) in values.iter().enumerate() {
            s.push(start + i as u64 * step, *v, window);
        }
    }

    #[test]
    fn model_tokens() {
        assert_eq!(
            cpu_model_token("AMD Ryzen 7 5700X3D 8-Core Processor").as_deref(),
            Some("5700X3D")
        );
        assert_eq!(
            cpu_model_token("AMD Ryzen 9 7950X 16-Core Processor").as_deref(),
            Some("7950X")
        );
        assert_eq!(
            cpu_model_token("AMD Ryzen 7 PRO 5750G with Radeon Graphics").as_deref(),
            Some("5750G")
        );
        assert_eq!(
            cpu_model_token("amd ryzen 5 5600x").as_deref(),
            Some("5600X")
        );
        assert_eq!(
            cpu_model_token("AMD Ryzen 7 9800X3D").as_deref(),
            Some("9800X3D")
        );
        assert_eq!(cpu_model_token("Intel(R) Core(TM) i9-13900K"), None);
        assert_eq!(cpu_model_token("AMD Ryzen Threadripper 3990X"), None);
        assert_eq!(cpu_model_token("AMD Ryzen 7"), None);
    }

    #[test]
    fn per_model_limits() {
        let l = cpu_limit(Some("AMD Ryzen 7 5700X3D 8-Core Processor"), None);
        assert_eq!(
            (l.model.as_deref(), l.limit_c, l.warn_c, l.source),
            (Some("5700X3D"), 90.0, 85.0, "table")
        );
        let l = cpu_limit(Some("AMD Ryzen 7 7800X3D"), None);
        assert_eq!((l.limit_c, l.warn_c), (89.0, 84.0));
        let l = cpu_limit(Some("AMD Ryzen 5 5600X"), None);
        assert_eq!(l.limit_c, 95.0);
        // Unknown model → conservative default, and it says so.
        let l = cpu_limit(Some("AMD Ryzen 5 3600"), None);
        assert_eq!(
            (l.model.as_deref(), l.limit_c, l.source),
            (Some("3600"), 90.0, "default")
        );
        let l = cpu_limit(None, None);
        assert_eq!((l.model, l.source), (None, "default"));
        // The user's override wins.
        let l = cpu_limit(Some("AMD Ryzen 7 5700X3D"), Some(80));
        assert_eq!((l.limit_c, l.warn_c, l.source), (80.0, 75.0, "user"));
        let p = Params {
            alerts: AlertSettings::default(),
            unit: "C".into(),
            cpu: cpu_limit(Some("AMD Ryzen 5 3600"), None),
        };
        assert_eq!(
            p.src_text(),
            "default, this CPU model is not in Nexum's table"
        );
    }

    #[test]
    fn sustain_needs_coverage_and_three_samples() {
        let w = 60_000;
        let mut s = Sustain::default();
        // 40 s of 95 °C: not yet 0.8 × 60 s old.
        win(&mut s, 0, &[Some(95.0); 41], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 40_000), None);
        // At 48 s coverage is reached → crit directly.
        win(&mut s, 41_000, &[Some(95.0); 8], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 48_000), Some(Sev::Crit));
        assert_eq!(s.since, 48_000);
        // Fewer than 3 samples never count, whatever the span.
        let mut s = Sustain::default();
        win(&mut s, 0, &[Some(99.0), Some(99.0)], 50_000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 50_000), None);
    }

    #[test]
    fn sustain_minimum_and_nulls() {
        let w = 10_000;
        let mut s = Sustain::default();
        // One dip below crit in the window → only warn.
        win(
            &mut s,
            0,
            &[
                Some(92.0),
                Some(92.0),
                Some(89.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
                Some(92.0),
            ],
            1000,
            w,
        );
        assert_eq!(s.evaluate(85.0, 90.0, w, 10_000), Some(Sev::Warn));
        // A null sample never clears an active alert...
        s.push(11_000, None, w);
        s.push(12_000, None, w);
        s.push(13_000, None, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 13_000), Some(Sev::Warn));
        // ...and prevents a new one.
        let mut s2 = Sustain::default();
        win(
            &mut s2,
            0,
            &[
                Some(99.0),
                Some(99.0),
                None,
                Some(99.0),
                Some(99.0),
                Some(99.0),
                Some(99.0),
                Some(99.0),
                Some(99.0),
                Some(99.0),
                Some(99.0),
            ],
            1000,
            w,
        );
        assert_eq!(s2.evaluate(85.0, 90.0, w, 10_000), None);
    }

    #[test]
    fn hysteresis_and_escalation() {
        let w = 10_000;
        let mut s = Sustain::default();
        win(&mut s, 0, &[Some(87.0); 11], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 10_000), Some(Sev::Warn));
        // Just below warn (84) is not enough: needs < warn − 3 = 82 on the last 3 samples.
        win(&mut s, 11_000, &[Some(84.0); 3], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 13_000), Some(Sev::Warn));
        win(&mut s, 14_000, &[Some(81.0), Some(81.0)], 1000, w);
        assert_eq!(
            s.evaluate(85.0, 90.0, w, 15_000),
            Some(Sev::Warn),
            "only 2 low samples"
        );
        s.push(16_000, Some(81.0), w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 16_000), None);
        assert_eq!(s.since, 16_000);

        // Warn → crit when crit is sustained; crit → warn below crit − 3 but not warn − 3.
        let mut s = Sustain::default();
        win(&mut s, 0, &[Some(88.0); 11], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 10_000), Some(Sev::Warn));
        win(&mut s, 11_000, &[Some(93.0); 11], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 21_000), Some(Sev::Crit));
        win(&mut s, 22_000, &[Some(86.0); 3], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 24_000), Some(Sev::Warn));
        // Crit straight to clear when the last 3 are also below warn − 3.
        let mut s = Sustain::default();
        win(&mut s, 0, &[Some(95.0); 11], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 10_000), Some(Sev::Crit));
        win(&mut s, 11_000, &[Some(70.0); 3], 1000, w);
        assert_eq!(s.evaluate(85.0, 90.0, w, 13_000), None);
        // A clock jump backwards starts a new buffer.
        s.push(5_000, Some(99.0), w);
        assert!(!s.met(90.0, w));
    }

    #[test]
    fn temperatures_and_counts_format() {
        assert_eq!(fmt_temp(89.5, "C"), "90 °C");
        assert_eq!(fmt_temp(85.0, "F"), "185 °F");
        assert_eq!(fmt_count(20188.0), "20,188");
        assert_eq!(fmt_count(999.0), "999");
        assert_eq!(fmt_count(1_234_567.0), "1,234,567");
        assert_eq!(fmt_sensor(Some(52.06), 1, "°C", "F"), "125.7 °F");
        assert_eq!(fmt_sensor(Some(45.0), 1, "%", "C"), "45.0%");
        assert_eq!(fmt_sensor(None, 1, "°C", "C"), "—");
        assert_eq!(fmt_sensor(Some(1150.4), 0, "RPM", "C"), "1150 RPM");
    }

    #[test]
    fn rule_texts_fill_numbers() {
        let p = Params {
            alerts: AlertSettings::default(),
            unit: "C".into(),
            cpu: cpu_limit(Some("AMD Ryzen 7 5700X3D"), None),
        };
        let r = p.rules();
        assert_eq!(r.len(), 7);
        assert_eq!(
            r[2],
            "Attention when the CPU stays at or above 85 °C for 60 s; critical at or above 90 °C"
        );
        assert_eq!(r[3], "Attention when a GPU hot spot stays at or above 100 °C (edge 85 °C) for 60 s; critical at or above 110 °C (edge 95 °C)");
        assert_eq!(r[4], "Attention when GPU memory stays at or above 95 °C for 60 s; critical at or above 105 °C");
        assert_eq!(r[5], "Attention when a drive stays at or above its warning temperature (70 °C if not reported) for 60 s; critical at its critical temperature (80 °C)");
        assert_eq!(
            r[6],
            "Attention when a fixed drive has less than 10% free space; critical below 5%"
        );
        let pf = Params {
            unit: "F".into(),
            ..p
        };
        assert!(pf.rules()[3].contains("(edge 185 °F)"));
    }

    #[test]
    fn drive_detail_sentences() {
        let d = json!({ "healthPct": 44.0, "percentageUsed": 56.0, "powerOnHours": 20188.0 });
        assert_eq!(
            drive_detail(&d, "Worn"),
            "44% life left (56% of rated endurance used, 20,188 h). Copy important files and plan a replacement."
        );
        let d = json!({ "healthPct": null, "percentageUsed": null, "powerOnHours": 12.0 });
        assert_eq!(
            drive_detail(&d, "Check sectors"),
            "12 h. Back up important files and run the drive maker's diagnostic."
        );
        assert_eq!(drive_short("Worn"), "1 drive worn");
        assert_eq!(drive_short("Something New"), "1 drive: something new");
    }

    fn vol(letter: &str, free: u64, total: u64) -> Volume {
        Volume {
            letter: letter.into(),
            label: String::new(),
            file_system: "NTFS".into(),
            total_bytes: total,
            free_bytes: free,
            used_bytes: total - free,
            drive_type: "Fixed".into(),
            is_system: letter == "C:",
        }
    }

    fn disk(id: &str, serial: &str, model: &str, vols: &[&str]) -> PhysicalDisk {
        PhysicalDisk {
            device_id: id.into(),
            model: model.into(),
            media_type: "SSD".into(),
            bus_type: "NVMe".into(),
            size_bytes: 1,
            health_status: "Healthy".into(),
            operational_status: "OK".into(),
            serial: serial.into(),
            volumes: vols.iter().map(|s| s.to_string()).collect(),
            is_system_disk: false,
        }
    }

    #[test]
    fn engine_builds_sorted_alerts() {
        let mut e = Engine {
            agent_up: true,
            telemetry_seen: true,
            volumes_seen: true,
            ..Engine::default()
        };
        e.volumes = vec![vol("D:", 4, 100), vol("C:", 8, 100), vol("E:", 50, 100)];
        e.physical = vec![disk("0", "S6Z2-NF0W", "Samsung SSD 990 PRO 2TB", &["C:"])];
        let p = Params {
            alerts: AlertSettings::default(),
            unit: "C".into(),
            cpu: cpu_limit(Some("AMD Ryzen 7 5700X3D"), None),
        };
        let packet = |ts: u64, cpu: f64| {
            json!({
                "ts": ts,
                "cpu": { "name": "AMD Ryzen 7 5700X3D", "packageTempC": cpu },
                "gpus": [{ "name": "Radeon", "tempC": 60.0, "hotspotTempC": 70.0, "memJunctionTempC": 70.0 }],
                "disks": [{ "id": "/nvme/0", "name": "Samsung SSD 990 PRO 2TB", "serial": "S6Z2NF0W", "diskNumber": 0,
                            "tempC": 40.0, "healthPct": 44.0, "percentageUsed": 56.0, "powerOnHours": 20188.0,
                            "health": { "state": "attention", "label": "Worn" } }]
            })
        };
        let mut ts = 0;
        for _ in 0..61 {
            let pk = packet(ts, 91.0);
            e.last_packet = Some(pk.clone());
            ingest(&mut e, &pk, &p);
            ts += 1000;
        }
        let a = build_alerts(&mut e, &p, None, 99);
        let ids: Vec<&str> = a.iter().map(|x| x.id.as_str()).collect();
        // crit first (cpu, then space D: 4% < 5%), then warn (drive, space C:).
        assert_eq!(
            ids,
            vec!["cpu-temp", "space:D:", "drive:/nvme/0", "space:C:"]
        );
        let cpu = &a[0];
        assert_eq!(cpu.title, "CPU at 91 °C");
        assert_eq!(
            cpu.detail,
            "Above 90 °C for 60 s. Limit for this CPU: 90 °C (AMD specification)."
        );
        assert_eq!(cpu.dismiss_key, "cpu-temp:crit");
        assert_eq!(cpu.threshold, Some(90.0));
        let drive = &a[2];
        assert_eq!(drive.title, "C: (Samsung SSD 990 PRO 2TB) — Worn");
        assert_eq!(drive.dismiss_key, "drive:/nvme/0:attention");
        assert_eq!(drive.group, "drive:Worn");
        assert_eq!(a[3].title, "C: has 8 B free (8%)");
        assert_eq!(a[3].detail, "Below 10% free.");
        let v = serde_json::to_value(&a[0]).unwrap();
        assert!(v.get("order").is_none());
        assert_eq!(v["dismissKey"], "cpu-temp:crit");
        assert!(v["subjectId"].is_null());
        // Agent down: only space alerts remain.
        e.agent_up = false;
        let a = build_alerts(&mut e, &p, None, 100);
        assert!(a.iter().all(|x| x.source == "space"));
    }

    #[test]
    fn sensor_ids_resolve_from_the_tree() {
        let tree = json!({ "rev": 1, "hardware": [
            { "id": "/amdcpu/0", "kind": "cpu", "name": "CPU", "sensors": [
                { "id": "/amdcpu/0/temperature/3", "idx": 0, "kind": "temperature", "name": "Package" },
                { "id": "/amdcpu/0/temperature/2", "idx": 1, "kind": "temperature", "name": "Core (Tctl/Tdie)" } ] },
            { "id": "/gpu-amd/0", "kind": "gpuAmd", "name": "Radeon", "sensors": [
                { "id": "/gpu-amd/0/temperature/2", "idx": 2, "kind": "temperature", "name": "GPU Hot Spot" },
                { "id": "/gpu-amd/0/temperature/3", "idx": 3, "kind": "temperature", "name": "GPU Memory" } ] },
            { "id": "/nvme/0", "kind": "storage", "name": "SSD", "sensors": [
                { "id": "/nvme/0/load/0", "idx": 4, "kind": "load", "name": "Used Space" },
                { "id": "/nvme/0/temperature/0", "idx": 5, "kind": "temperature", "name": "Temperature" } ] }
        ]});
        assert_eq!(
            resolve_sensor_id(&tree, SignalKind::Cpu, "", None).as_deref(),
            Some("/amdcpu/0/temperature/2")
        );
        assert_eq!(
            resolve_sensor_id(&tree, SignalKind::GpuHotspot(0), "Radeon", Some("0")).as_deref(),
            Some("/gpu-amd/0/temperature/2")
        );
        assert_eq!(
            resolve_sensor_id(&tree, SignalKind::GpuMem(0), "Other", Some("0")).as_deref(),
            Some("/gpu-amd/0/temperature/3")
        );
        assert_eq!(
            resolve_sensor_id(&tree, SignalKind::GpuEdge(0), "Radeon", Some("0")),
            None
        );
        assert_eq!(
            resolve_sensor_id(&tree, SignalKind::DriveTemp, "", Some("/nvme/0")).as_deref(),
            Some("/nvme/0/temperature/0")
        );
        // Tray lines: label, unit, °F, stale/missing values and unknown ids.
        let values = json!({ "rev": 1, "value": [50.0, 52.04, 70.0, 66.0, 10.0, 41.0] });
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("/nvme/0/temperature/0".to_string(), "Boot SSD".to_string());
        let ids = vec![
            "/nope".to_string(),
            "/amdcpu/0/temperature/2".to_string(),
            "/nvme/0/temperature/0".to_string(),
        ];
        let tree2 = {
            let mut t = tree.clone();
            for hw in t["hardware"].as_array_mut().unwrap() {
                for s in hw["sensors"].as_array_mut().unwrap() {
                    s["unit"] = json!("°C");
                    s["decimals"] = json!(1);
                }
            }
            t
        };
        assert_eq!(
            tray_sensor_lines(&ids, &tree2, Some(&values), &labels, "C"),
            vec![
                "Core (Tctl/Tdie): 52.0 °C".to_string(),
                "Boot SSD: 41.0 °C".to_string()
            ]
        );
        let stale = json!({ "rev": 2, "value": [] });
        assert_eq!(
            tray_sensor_lines(&ids, &tree2, Some(&stale), &labels, "C")[0],
            "Core (Tctl/Tdie): —"
        );
    }

    #[test]
    fn tooltip_fits_at_line_boundaries() {
        assert_eq!(tooltip_head(false, 3), "Nexum · Agent offline");
        assert_eq!(tooltip_head(true, 0), "Nexum · No alerts");
        assert_eq!(tooltip_head(true, 1), "Nexum · 1 alert");
        assert_eq!(tooltip_head(true, 2), "Nexum · 2 alerts");
        let lines: Vec<String> = vec![
            "Nexum · No alerts".into(),
            "a".repeat(50),
            "b".repeat(50),
            "c".repeat(50),
        ];
        let t = fit_tooltip(&lines, 127);
        assert_eq!(
            t,
            format!("Nexum · No alerts\n{}\n{}", "a".repeat(50), "b".repeat(50))
        );
        assert!(t.encode_utf16().count() <= 127);
        assert_eq!(fit_tooltip(&["x".repeat(200)], 127).len(), 127);
    }

    #[test]
    fn notification_throttling() {
        let mut n = Notifier::default();
        let t0 = 1_000_000;
        // First alert shows at once.
        assert!(matches!(
            n.offer("cpu-temp", "CPU at 91 °C", "d", false, t0),
            Some(Outgoing::Single { .. })
        ));
        // A second alert within 60 s is held...
        assert_eq!(n.offer("gpu-temp:0", "GPU", "d", false, t0 + 10_000), None);
        assert_eq!(n.offer("space:C:", "C:", "d", false, t0 + 20_000), None);
        let active: HashSet<String> = ["gpu-temp:0", "space:C:"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(n.tick(&active, t0 + 30_000), None, "60 s not over");
        // ...and summarized once 60 s passed.
        assert_eq!(
            n.tick(&active, t0 + 60_000),
            Some(Outgoing::Summary { count: 2 })
        );
        // A held alert that cleared meanwhile is dropped; one left → shown as itself.
        assert_eq!(
            n.offer("drive-temp:/nvme/0", "SSD", "d", false, t0 + 70_000),
            None
        );
        assert_eq!(
            n.offer("gpu-mem-temp:0", "MEM", "d", false, t0 + 80_000),
            None
        );
        let only: HashSet<String> = ["gpu-mem-temp:0"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            n.tick(&only, t0 + 121_000),
            Some(Outgoing::Single {
                title: "Nexum: MEM".into(),
                body: "d".into()
            })
        );
        // Re-activation of the same id within 30 min is silent; escalation bypasses once.
        let t1 = t0 + 200_000;
        assert_eq!(n.offer("cpu-temp", "CPU", "d", false, t1), None);
        assert!(n.offer("cpu-temp", "CPU", "d", true, t1 + 1).is_some());
        assert_eq!(
            n.offer("cpu-temp", "CPU", "d", true, t1 + 70_000),
            None,
            "bypass used"
        );
        // After 30 min it notifies again.
        assert!(n
            .offer("cpu-temp", "CPU", "d", false, t0 + 31 * 60_000 + 200_000)
            .is_some());
    }

    #[test]
    fn held_notifications_skip_dismissed_and_cleared_alerts() {
        let mut e = Engine {
            volumes_seen: true,
            ..Engine::default()
        };
        e.volumes = vec![vol("D:", 4, 100), vol("C:", 8, 100)];
        let p = Params {
            alerts: AlertSettings::default(),
            unit: "C".into(),
            cpu: cpu_limit(None, None),
        };
        let alerts = build_alerts(&mut e, &p, None, 1);
        let snap = HealthAlertsSnapshot {
            ready: false,
            evaluated_ts: Some(1),
            alerts,
            rules: p.rules(),
            cpu_limit: p.cpu.clone(),
        };
        let all = notifiable_ids(Some(&snap), &[]);
        assert_eq!(all.len(), 2);
        // D: is dismissed at its current severity after being held: it is never sent.
        let ids = notifiable_ids(Some(&snap), &["space:D:crit".to_string()]);
        assert!(ids.contains("space:C:") && !ids.contains("space:D:"));
        // A dismissal of the other severity does not apply.
        assert_eq!(
            notifiable_ids(Some(&snap), &["space:D:warn".to_string()]).len(),
            2
        );
        assert!(notifiable_ids(None, &[]).is_empty());
        let mut n = Notifier::default();
        assert!(n.offer("space:C:", "C:", "d", false, 0).is_some());
        assert_eq!(n.offer("space:D:", "D:", "d", false, 1_000), None);
        assert_eq!(n.tick(&ids, 61_000), None, "the held D: alert was dismissed");
    }

    #[test]
    fn tray_labels_cannot_break_lines() {
        let tree = json!({ "rev": 1, "hardware": [{ "name": "CPU", "sensors": [
            { "id": "/a", "idx": 0, "name": "Core", "unit": "°C", "decimals": 0 }
        ] }] });
        let mut labels = std::collections::BTreeMap::new();
        labels.insert("/a".to_string(), "two\nlines\tand\u{202E}rtl".to_string());
        let values = json!({ "rev": 1, "value": [50.0] });
        let lines = tray_sensor_lines(&["/a".to_string()], &tree, Some(&values), &labels, "C");
        assert_eq!(lines, vec!["two lines andrtl: 50 °C".to_string()]);
    }

    #[test]
    fn drive_names_join_by_serial_then_number() {
        let physical = vec![
            disk("1", "", "WD Blue", &["D:", "E:"]),
            disk("0", "s6z2 nf0w", "Samsung 990", &[]),
        ];
        let tele = vec![
            json!({ "id": "/nvme/0", "name": "Samsung SSD", "serial": "S6Z2NF0W", "diskNumber": 1 }),
            json!({ "id": "/hdd/1", "name": "WDC", "serial": null, "diskNumber": 1 }),
            json!({ "id": "/usb/2", "name": "USB Bridge", "serial": null, "diskNumber": null }),
        ];
        let n = drive_names(&physical, &tele);
        assert_eq!(n["/nvme/0"], "Samsung 990");
        assert_eq!(n["/hdd/1"], "D:, E: (WD Blue)");
        assert_eq!(n["/usb/2"], "USB Bridge");
    }

    #[test]
    fn tray_ids_are_cleaned() {
        let ids: Vec<String> = vec![" /a ".into(), "/a".into(), "".into(), "/b".into()];
        assert_eq!(clean_tray_ids(ids), vec!["/a", "/b"]);
    }
}
