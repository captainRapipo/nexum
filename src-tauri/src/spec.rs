//! `get_system_spec` (CONTRACT §2.6): the sidecar's `cpu`/`board`/`memory`/`gpus` sections
//! merged with the Rust-owned `os` and `security` sections.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::system_info::{collect_os_security, OsSpec, SecuritySpec};
use crate::util::{lock, now_ms};

/// How long to wait for the agent's `spec` line.
const SPEC_TIMEOUT: Duration = Duration::from_secs(15);

/// `SystemSpec.errors` entries for a missing sidecar answer (CONTRACT §2.6; wording §4.8.1).
/// The System view shows them, so they never name the process.
pub const ERR_SPEC_UNAVAILABLE: &str = "Hardware details are not available right now.";
pub const ERR_SPEC_TIMEOUT: &str =
    "Hardware details took too long to read. Press F5 to try again.";

/// `SystemSpec`. The agent sections are passed through as JSON (their shape is owned by the
/// sidecar and mirrored in `types.ts`); only their top-level kind is validated.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSpec {
    pub captured_ts: u64,
    pub cpu: Value,
    pub board: Value,
    pub memory: Value,
    pub gpus: Value,
    pub os: OsSpec,
    pub security: SecuritySpec,
    /// Copied from `AgentSpec.diskLinks` (`[]` when the agent is down; CONTRACT §2.6).
    pub disk_links: Value,
    pub errors: Vec<String>,
}

fn object_or_null(v: Option<&Value>) -> Value {
    match v {
        Some(v @ Value::Object(_)) => v.clone(),
        _ => Value::Null,
    }
}

/// Merges the agent reply (or the reason it is missing) with the Rust sections.
/// `errors` = agent errors, then Rust section errors.
pub fn merge(
    agent: Result<Value, String>,
    os: OsSpec,
    security: SecuritySpec,
    rust_errors: Vec<String>,
    now: u64,
) -> SystemSpec {
    let mut errors: Vec<String> = Vec::new();
    let (captured_ts, cpu, board, memory, gpus, disk_links) = match &agent {
        Ok(v) => {
            if let Some(list) = v.get("errors").and_then(Value::as_array) {
                errors.extend(
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string),
                );
            }
            let gpus = match v.get("gpus") {
                Some(g @ Value::Array(_)) => g.clone(),
                _ => Value::Array(Vec::new()),
            };
            let disk_links = match v.get("diskLinks") {
                Some(d @ Value::Array(_)) => d.clone(),
                _ => Value::Array(Vec::new()),
            };
            (
                v.get("capturedTs").and_then(Value::as_u64).unwrap_or(now),
                object_or_null(v.get("cpu")),
                object_or_null(v.get("board")),
                object_or_null(v.get("memory")),
                gpus,
                disk_links,
            )
        }
        Err(reason) => {
            errors.push(reason.clone());
            (
                now,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Array(Vec::new()),
                Value::Array(Vec::new()),
            )
        }
    };
    errors.extend(rust_errors);
    SystemSpec {
        captured_ts,
        cpu,
        board,
        memory,
        gpus,
        os,
        security,
        disk_links,
        errors,
    }
}

/// The cached spec, or a fresh one (`refresh`, nothing cached). Blocking (waits up to 15 s).
pub fn load(app: &AppHandle, refresh: bool) -> SystemSpec {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    let _one_in_flight = lock(&mgr.spec_lock);
    if !refresh {
        if let Some(cached) = lock(&mgr.spec_cache).clone() {
            return cached;
        }
    }
    let agent = mgr.request_spec(SPEC_TIMEOUT);
    let answered = agent.is_ok();
    let (os, security, rust_errors) = collect_os_security();
    let spec = merge(agent, os, security, rust_errors, now_ms());
    // Only a real agent answer is cached; a missing agent is retried next time.
    if answered {
        *lock(&mgr.spec_cache) = Some(spec.clone());
    }
    spec
}

#[tauri::command]
pub async fn get_system_spec(app: AppHandle, refresh: Option<bool>) -> Result<SystemSpec, String> {
    let refresh = refresh.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || load(&app, refresh))
        .await
        .map_err(|e| format!("System spec failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn os() -> OsSpec {
        OsSpec {
            caption: "Windows 11 Pro".into(),
            display_version: "24H2".into(),
            build: "26100".into(),
            architecture: "64-bit".into(),
            install_date: "2025-01-01".into(),
            boot_ts: 1_700_000_000_000,
        }
    }

    fn security() -> SecuritySpec {
        SecuritySpec {
            secure_boot: Some(true),
            tpm: None,
            bios_mode: "UEFI".into(),
        }
    }

    #[test]
    fn merges_agent_sections_and_errors() {
        let agent = json!({
            "type": "spec", "capturedTs": 123,
            "cpu": { "name": "CPU", "vendor": "AMD" },
            "board": null,
            "memory": "garbage",
            "gpus": [{ "name": "GPU" }],
            "diskLinks": [{ "diskNumber": 0, "model": "SSD", "bus": "nvme", "gen": 4, "width": 4, "maxGen": 4, "maxWidth": 4, "sataGen": null }],
            "errors": ["Board query failed: x"]
        });
        let s = merge(Ok(agent), os(), security(), vec!["OS query failed: y".into()], 999);
        assert_eq!(s.captured_ts, 123);
        assert_eq!(s.cpu["vendor"], "AMD");
        assert!(s.board.is_null());
        assert!(s.memory.is_null(), "a non-object section becomes null");
        assert_eq!(s.gpus.as_array().unwrap().len(), 1);
        assert_eq!(s.disk_links[0]["bus"], "nvme");
        assert_eq!(
            s.errors,
            vec!["Board query failed: x".to_string(), "OS query failed: y".to_string()]
        );
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["os"]["displayVersion"], "24H2");
        assert_eq!(v["os"]["bootTs"], 1_700_000_000_000u64);
        assert_eq!(v["security"]["biosMode"], "UEFI");
        assert!(v["security"]["tpm"].is_null());
        assert!(v.get("capturedTs").is_some());
    }

    #[test]
    fn agent_down_or_silent() {
        let s = merge(
            Err(ERR_SPEC_UNAVAILABLE.into()),
            os(),
            security(),
            vec![],
            999,
        );
        assert_eq!(s.captured_ts, 999);
        assert!(s.cpu.is_null() && s.board.is_null() && s.memory.is_null());
        assert_eq!(s.gpus, json!([]));
        assert_eq!(serde_json::to_value(&s).unwrap()["diskLinks"], json!([]));
        assert_eq!(
            s.errors,
            vec!["Hardware details are not available right now.".to_string()]
        );
        let s = merge(Err(ERR_SPEC_TIMEOUT.into()), os(), security(), vec![], 1);
        assert_eq!(
            s.errors,
            vec!["Hardware details took too long to read. Press F5 to try again.".to_string()]
        );
    }
}
