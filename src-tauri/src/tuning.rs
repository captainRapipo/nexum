//! GPU tuning, Rust side, read-only (CONTRACT §2.14): a pass-through for the agent's
//! `tuningGet` / `tuningProbe {write:false}`. Nothing in Nexum 1.1 changes GPU settings: a
//! probe with `write:true` is rejected here before anything reaches the agent (the agent
//! rejects it too — defence in depth), and no tuning call runs at app start or on a timer.

use std::io::Write;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::util::{lock, now_ms};

const STATE_WAIT: Duration = Duration::from_secs(12);
const PROBE_WAIT: Duration = Duration::from_secs(15);
pub const WRITE_REJECTED: &str = "The write probe is not available in this version.";

#[derive(Default)]
pub struct TuningBridge {
    /// Latest `tuningState` line (verbatim); cleared when the agent exits.
    cache: Mutex<Option<Value>>,
    get_lock: Mutex<()>,
    probe_lock: Mutex<()>,
}

/// `TuningProbeSummary`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningProbeSummary {
    pub ran_ts: u64,
    /// Always false in 1.1.
    pub write: bool,
    pub ok: bool,
    pub message: String,
    pub path: Option<String>,
}

pub fn clear(app: &AppHandle) {
    *lock(&app.state::<AppState>().tuning.cache) = None;
}

/// A `tuningState` line from the agent: cache it and forward it.
pub fn on_state(app: &AppHandle, value: &Value) {
    *lock(&app.state::<AppState>().tuning.cache) = Some(value.clone());
    let _ = app.emit("tuning-state", value.clone());
}

/// The probe file content: the agent's `report` plus top-level `nexumVersion` and `capturedTs`.
pub fn probe_file_json(report: &Value, captured_ts: u64) -> Value {
    let mut out = Map::new();
    out.insert("nexumVersion".into(), json!(env!("CARGO_PKG_VERSION")));
    out.insert("capturedTs".into(), json!(captured_ts));
    match report {
        Value::Object(m) => {
            for (k, v) in m {
                if k != "nexumVersion" && k != "capturedTs" {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        other => {
            out.insert("report".into(), other.clone());
        }
    }
    Value::Object(out)
}

/// Writes the probe report to `%LOCALAPPDATA%\Nexum\tuning-probe-<stamp>.json` through
/// [`crate::safe_fs::PinnedDir`] (never through a link).
fn write_probe_file(report: &Value, captured_ts: u64) -> Result<String, String> {
    let dir = crate::safe_fs::open_local_appdata(&["Nexum"])
        .map_err(|e| format!("Could not save the probe report: {e}"))?;
    let stem = format!("tuning-probe-{}", crate::util::file_timestamp());
    let (mut file, path) = dir
        .create_unique(&stem, "json")
        .map_err(|e| format!("Could not save the probe report: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&probe_file_json(report, captured_ts))
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Could not save the probe report: {e}"))?;
    Ok(crate::purge_log::display_path(&path))
}

#[tauri::command]
pub async fn get_tuning_state(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Option<Value>, String> {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if !state.agent.is_running() {
            return None;
        }
        let cached = lock(&state.tuning.cache).clone();
        if !refresh && cached.is_some() {
            return cached;
        }
        let _one = lock(&state.tuning.get_lock);
        match state.agent.request_reply(
            &json!({ "cmd": "tuningGet" }),
            "tuningState",
            "tuningGet",
            STATE_WAIT,
        ) {
            // `on_state` already cached and emitted it.
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("[nexum] tuning state: {e}");
                lock(&state.tuning.cache).clone()
            }
        }
    })
    .await
    .map_err(|e| format!("Tuning state failed: {e}"))
}

#[tauri::command]
pub async fn run_tuning_probe(app: AppHandle, write: bool) -> Result<TuningProbeSummary, String> {
    // Read-only by construction: the write path is never forwarded (CONTRACT §1.7, §2.14).
    if write {
        return Err(WRITE_REJECTED.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _one = lock(&state.tuning.probe_lock);
        let reply = state.agent.request_reply(
            &json!({ "cmd": "tuningProbe", "write": false }),
            "tuningProbe",
            "tuningProbe",
            PROBE_WAIT,
        )?;
        let ran_ts = reply
            .get("ts")
            .and_then(Value::as_u64)
            .unwrap_or_else(now_ms);
        let ok = reply.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let mut message = reply
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut path = None;
        if let Some(report) = reply.get("report").filter(|r| r.is_object()) {
            match write_probe_file(report, ran_ts) {
                Ok(p) => path = Some(p),
                Err(e) => {
                    eprintln!("[nexum] {e}");
                    message = if message.is_empty() {
                        e
                    } else {
                        format!("{message} {e}")
                    };
                }
            }
            if let Some(st) = report.get("state").filter(|s| s.is_object()) {
                on_state(&app, st);
            }
        }
        Ok(TuningProbeSummary {
            ran_ts,
            write: false,
            ok,
            message,
            path,
        })
    })
    .await
    .map_err(|e| format!("Tuning probe failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_file_adds_version_and_time_at_the_top_level() {
        let report = json!({ "agentVersion": "1.1.0", "capturedTs": 5, "adapters": [] });
        let v = probe_file_json(&report, 42);
        assert_eq!(v["nexumVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["capturedTs"], 42, "Rust's capture time wins");
        assert_eq!(v["agentVersion"], "1.1.0");
        assert!(v["adapters"].is_array());
    }

    #[test]
    fn write_message_is_exact() {
        assert_eq!(
            WRITE_REJECTED,
            "The write probe is not available in this version."
        );
    }
}
