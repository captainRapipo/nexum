//! Shared application state managed by Tauri.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use crate::agent::AgentManager;
use crate::drivers::DriverInfo;
use crate::settings::Settings;

pub struct AppState {
    /// Current (sanitized) settings.
    pub settings: Mutex<Settings>,
    /// Absolute path of `settings.json` (resolved in `setup`).
    pub settings_path: Mutex<Option<PathBuf>>,
    /// Sidecar lifecycle + stdin writer + status.
    pub agent: AgentManager,
    /// ISO-8601 timestamp of the last successful driver scan.
    pub last_driver_scan: Mutex<Option<String>>,
    /// Result of the last driver scan (used by `export_drivers`).
    pub driver_cache: Mutex<Option<Vec<DriverInfo>>>,
    /// True while the main window is hidden in the tray (telemetry is throttled).
    pub in_tray: AtomicBool,
    /// True once the user chose "Quit" (close must not be intercepted anymore).
    pub quitting: AtomicBool,
    /// Prevents two purges from running at the same time.
    pub purge_running: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            settings: Mutex::new(Settings::default()),
            settings_path: Mutex::new(None),
            agent: AgentManager::default(),
            last_driver_scan: Mutex::new(None),
            driver_cache: Mutex::new(None),
            in_tray: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            purge_running: AtomicBool::new(false),
        }
    }
}
