//! Fan fail-safe banner state (CONTRACT §2.4, MF-13).
//!
//! Rust only *reads* `%ProgramData%\Nexum\fan-manual.flag` (the agent owns it) and keeps one
//! `FanFailsafeState` for the UI. The state machine is pure and unit-tested; `agent.rs` feeds
//! it events (app start, agent hello, telemetry, abnormal agent exit).

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::util::{lock, now_ms, program_data_dir};

pub const MSG_INTERRUPTED: &str = "Fan control was interrupted. Fans are at 100% for safety. Restart the PC to return them to BIOS control.";
pub const MSG_AGENT_LOST: &str = "Fan control was interrupted and the hardware agent is not running. Fans may be stuck at their last manual speed. Restart the PC to return them to BIOS control.";
pub const MSG_PREVIOUS_BOOT: &str = "Nexum's fan control was interrupted before the last restart. If the fans behave unusually, shut down fully and power the PC on again.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Interrupted,
    AgentLost,
    PreviousBoot,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Interrupted => "interrupted",
            Kind::AgentLost => "agentLost",
            Kind::PreviousBoot => "previousBoot",
        }
    }
    fn severity(self) -> &'static str {
        match self {
            Kind::PreviousBoot => "warn",
            _ => "crit",
        }
    }
    fn message(self) -> &'static str {
        match self {
            Kind::Interrupted => MSG_INTERRUPTED,
            Kind::AgentLost => MSG_AGENT_LOST,
            Kind::PreviousBoot => MSG_PREVIOUS_BOOT,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FanFailsafeState {
    pub active: bool,
    pub kind: Option<String>,
    pub severity: Option<String>,
    #[serde(rename = "fansAt100")]
    pub fans_at_100: bool,
    pub message: String,
    pub since_ts: Option<u64>,
    pub dismissible: bool,
}

impl Default for FanFailsafeState {
    fn default() -> Self {
        Self {
            active: false,
            kind: None,
            severity: None,
            fans_at_100: false,
            message: String::new(),
            since_ts: None,
            dismissible: false,
        }
    }
}

/// The fail-safe state machine. Every method returns `true` when the visible state changed
/// (so the caller emits `fan-failsafe`).
#[derive(Debug, Default)]
pub struct Tracker {
    kind: Option<Kind>,
    fans_at_100: bool,
    since: Option<u64>,
    /// `agentLost` set at app start before any `hello` (cleared by `fanFlag:"none"`).
    provisional: bool,
    /// The user dismissed the previous-boot notice in this session.
    previous_boot_dismissed: bool,
}

impl Tracker {
    pub fn state(&self) -> FanFailsafeState {
        match self.kind {
            None => FanFailsafeState::default(),
            Some(k) => FanFailsafeState {
                active: true,
                kind: Some(k.as_str().to_string()),
                severity: Some(k.severity().to_string()),
                fans_at_100: k == Kind::Interrupted && self.fans_at_100,
                message: k.message().to_string(),
                since_ts: self.since,
                dismissible: k == Kind::PreviousBoot,
            },
        }
    }

    fn set(&mut self, kind: Kind, fans_at_100: bool, provisional: bool, now: u64) -> bool {
        let before = self.state();
        let was_active = self.kind.is_some();
        // A crit condition keeps its original start time across kind changes.
        let keep_since = was_active
            && self.kind != Some(Kind::PreviousBoot)
            && kind != Kind::PreviousBoot;
        if !keep_since || self.since.is_none() {
            self.since = Some(now);
        }
        self.kind = Some(kind);
        self.fans_at_100 = fans_at_100;
        self.provisional = provisional;
        self.state() != before
    }

    fn clear(&mut self) -> bool {
        let changed = self.kind.is_some();
        self.kind = None;
        self.fans_at_100 = false;
        self.since = None;
        self.provisional = false;
        changed
    }

    fn is_crit(&self) -> bool {
        matches!(self.kind, Some(Kind::Interrupted) | Some(Kind::AgentLost))
    }

    /// At app start, before the agent runs: the flag means fans may be stuck.
    pub fn on_app_start(&mut self, flag_exists: bool, now: u64) -> bool {
        if flag_exists && self.kind.is_none() {
            self.set(Kind::AgentLost, false, true, now)
        } else {
            false
        }
    }

    /// The agent exited abnormally (crash, kill, hang).
    pub fn on_abnormal_exit(&mut self, flag_exists: bool, now: u64) -> bool {
        if flag_exists {
            self.set(Kind::AgentLost, false, false, now)
        } else {
            false
        }
    }

    /// A `hello` line. `fan_flag` is `None` for agents that predate the field.
    pub fn on_hello(&mut self, fan_flag: Option<&str>, is_admin: bool, now: u64) -> bool {
        match fan_flag {
            Some("interrupted") => self.set(Kind::Interrupted, is_admin, false, now),
            Some("previousBoot") => {
                if self.previous_boot_dismissed || (self.is_crit() && !self.provisional) {
                    // Never downgrade a crit state; never re-show a dismissed notice.
                    if self.provisional {
                        // The provisional agentLost came from a stale flag: settle it.
                        return self.clear();
                    }
                    false
                } else {
                    self.set(Kind::PreviousBoot, false, false, now)
                }
            }
            Some("none") => {
                if self.provisional && self.kind == Some(Kind::AgentLost) {
                    self.clear()
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    /// A telemetry packet with `fanSafety.failsafe == true`.
    pub fn on_failsafe_telemetry(&mut self, is_admin: bool, now: u64) -> bool {
        if self.kind == Some(Kind::Interrupted) && self.fans_at_100 == is_admin {
            return false;
        }
        self.set(Kind::Interrupted, is_admin, false, now)
    }

    /// `dismiss_fan_failsafe`: only the previous-boot notice can be dismissed.
    pub fn dismiss(&mut self) -> Result<bool, String> {
        match self.kind {
            Some(Kind::PreviousBoot) => {
                self.previous_boot_dismissed = true;
                Ok(self.clear())
            }
            None => Err("There is no fan fail-safe notice to dismiss".to_string()),
            Some(_) => Err(
                "This fan fail-safe notice stays until the PC is restarted".to_string(),
            ),
        }
    }
}

/// `%ProgramData%\Nexum\fan-manual.flag`.
pub fn flag_path() -> Option<PathBuf> {
    program_data_dir().map(|d| d.join("Nexum").join("fan-manual.flag"))
}

/// True when the write-ahead flag exists (read-only check; Rust never writes or deletes it).
/// Any directory entry at that path counts, including a link: when in doubt, warn.
pub fn flag_exists() -> bool {
    flag_path().is_some_and(|p| std::fs::symlink_metadata(p).is_ok())
}

/// Applies a tracker transition and emits `fan-failsafe` when the state changed.
pub fn update(app: &AppHandle, f: impl FnOnce(&mut Tracker, u64) -> bool) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut t = lock(&state.failsafe);
        if !f(&mut t, now_ms()) {
            return;
        }
        t.state()
    };
    if snapshot.active {
        eprintln!("[nexum] fan fail-safe: {}", snapshot.kind.as_deref().unwrap_or("?"));
    }
    let _ = app.emit("fan-failsafe", snapshot);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_fan_failsafe_state(app: AppHandle) -> Result<FanFailsafeState, String> {
    Ok(lock(&app.state::<AppState>().failsafe).state())
}

#[tauri::command]
pub fn dismiss_fan_failsafe(app: AppHandle) -> Result<FanFailsafeState, String> {
    let state = app.state::<AppState>();
    let (changed, snapshot) = {
        let mut t = lock(&state.failsafe);
        let changed = t.dismiss()?;
        (changed, t.state())
    };
    if changed {
        let _ = app.emit("fan-failsafe", snapshot.clone());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_by_default() {
        let t = Tracker::default();
        let s = t.state();
        assert!(!s.active);
        assert_eq!(s.kind, None);
        assert_eq!(s.message, "");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["fansAt100"], false);
        assert!(v.get("sinceTs").is_some());
    }

    #[test]
    fn flag_at_start_is_settled_by_hello() {
        let mut t = Tracker::default();
        assert!(t.on_app_start(true, 10));
        assert_eq!(t.state().kind.as_deref(), Some("agentLost"));
        assert_eq!(t.state().severity.as_deref(), Some("crit"));
        // Agent deleted a stale flag and reports nothing: clear.
        assert!(t.on_hello(Some("none"), true, 20));
        assert!(!t.state().active);
    }

    #[test]
    fn provisional_becomes_interrupted() {
        let mut t = Tracker::default();
        t.on_app_start(true, 10);
        assert!(t.on_hello(Some("interrupted"), true, 20));
        let s = t.state();
        assert_eq!(s.kind.as_deref(), Some("interrupted"));
        assert!(s.fans_at_100);
        assert_eq!(s.message, MSG_INTERRUPTED);
        assert_eq!(s.since_ts, Some(10), "crit start time is kept");
        assert!(!s.dismissible);
        // A later "none" never clears a confirmed interruption.
        assert!(!t.on_hello(Some("none"), true, 30));
        assert!(t.state().active);
    }

    #[test]
    fn provisional_becomes_previous_boot_and_can_be_dismissed() {
        let mut t = Tracker::default();
        t.on_app_start(true, 10);
        assert!(t.on_hello(Some("previousBoot"), true, 20));
        let s = t.state();
        assert_eq!(s.kind.as_deref(), Some("previousBoot"));
        assert_eq!(s.severity.as_deref(), Some("warn"));
        assert!(s.dismissible);
        assert_eq!(t.dismiss(), Ok(true));
        assert!(!t.state().active);
        // A restarted (non-elevated) agent reports it again: stays dismissed.
        assert!(!t.on_hello(Some("previousBoot"), false, 40));
        assert!(!t.state().active);
    }

    #[test]
    fn crit_states_are_not_dismissible_or_downgraded() {
        let mut t = Tracker::default();
        assert!(t.on_hello(Some("interrupted"), false, 5));
        assert!(!t.state().fans_at_100, "non-elevated agent cannot force fans");
        assert!(t.dismiss().is_err());
        assert!(!t.on_hello(Some("previousBoot"), true, 6));
        assert_eq!(t.state().kind.as_deref(), Some("interrupted"));
    }

    #[test]
    fn abnormal_exit_with_flag_sets_agent_lost() {
        let mut t = Tracker::default();
        assert!(!t.on_abnormal_exit(false, 1));
        assert!(!t.state().active);
        assert!(t.on_abnormal_exit(true, 2));
        assert_eq!(t.state().kind.as_deref(), Some("agentLost"));
        assert!(!t.state().fans_at_100);
        // The restarted agent enters failsafe itself.
        assert!(t.on_hello(Some("interrupted"), true, 3));
        assert_eq!(t.state().kind.as_deref(), Some("interrupted"));
        // A confirmed agentLost is not cleared by "none".
        let mut t = Tracker::default();
        t.on_abnormal_exit(true, 2);
        assert!(!t.on_hello(Some("none"), true, 3));
        assert!(t.state().active);
    }

    #[test]
    fn failsafe_telemetry_sets_interrupted_once() {
        let mut t = Tracker::default();
        assert!(t.on_failsafe_telemetry(true, 1));
        assert!(!t.on_failsafe_telemetry(true, 2));
        assert_eq!(t.state().since_ts, Some(1));
        assert!(t.state().fans_at_100);
    }

    #[test]
    fn hello_without_flag_field_changes_nothing() {
        let mut t = Tracker::default();
        t.on_app_start(true, 1);
        assert!(!t.on_hello(None, true, 2));
        assert_eq!(t.state().kind.as_deref(), Some("agentLost"));
    }
}
