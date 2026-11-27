//! Shared application state managed by Tauri.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use crate::agent::AgentManager;
use crate::alerts::AlertEngine;
use crate::drive_history::DriveLedger;
use crate::drivers::DriverInfo;
use crate::failsafe::Tracker;
use crate::frames::FrameBridge;
use crate::sensor_log::SensorLogger;
use crate::settings::Settings;
use crate::tuning::TuningBridge;

pub struct AppState {
    /// Current (sanitized) settings.
    pub settings: Mutex<Settings>,
    /// Serializes settings writers (`save_settings` and the 1.1 commands that save one member).
    pub settings_write: Mutex<()>,
    /// Absolute path of `settings.json` (resolved in `setup`).
    pub settings_path: Mutex<Option<PathBuf>>,
    /// Sidecar lifecycle + stdin writer + status + sensor/spec bridge.
    pub agent: AgentManager,
    /// Fan fail-safe banner state (CONTRACT §2.4).
    pub failsafe: Mutex<Tracker>,
    /// ISO-8601 timestamp of the last successful driver scan.
    pub last_driver_scan: Mutex<Option<String>>,
    /// Result of the last driver scan (used by `export_drivers`).
    pub driver_cache: Mutex<Option<Vec<DriverInfo>>>,
    /// True while the main window is hidden in the tray (telemetry is throttled, the sensor
    /// stream and the self-usage readout pause).
    pub in_tray: AtomicBool,
    /// True once the user chose "Quit" (close must not be intercepted anymore).
    pub quitting: AtomicBool,
    /// Prevents two cleanups from running at the same time.
    pub purge_running: AtomicBool,
    /// Frame capture caches and request locks (CONTRACT §2.13).
    pub frames: FrameBridge,
    /// CSV sensor log (CONTRACT §2.9).
    pub sensor_log: SensorLogger,
    /// Rust alert engine, notifications and tray tooltip (CONTRACT §2.10).
    pub alerts: AlertEngine,
    /// Drive wear ledger (CONTRACT §2.11).
    pub drive_history: DriveLedger,
    /// Read-only GPU tuning cache (CONTRACT §2.14).
    pub tuning: TuningBridge,
    /// Pinned sensor ids for the tray tooltip (`set_tray_sensors`, in memory only).
    pub tray_sensors: Mutex<Vec<String>>,
    /// Latest `sensorValues` line and when it arrived (tray tooltip).
    pub latest_values: Mutex<Option<(Instant, Value)>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            settings_write: Mutex::new(()),
            settings_path: Mutex::new(None),
            agent: AgentManager::default(),
            failsafe: Mutex::new(Tracker::default()),
            last_driver_scan: Mutex::new(None),
            driver_cache: Mutex::new(None),
            in_tray: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            purge_running: AtomicBool::new(false),
            frames: FrameBridge::default(),
            sensor_log: SensorLogger::default(),
            alerts: AlertEngine::default(),
            drive_history: DriveLedger::default(),
            tuning: TuningBridge::default(),
            tray_sensors: Mutex::new(Vec::new()),
            latest_values: Mutex::new(None),
        }
    }
}
