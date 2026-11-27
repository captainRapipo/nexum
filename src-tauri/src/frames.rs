//! Frame capture, Rust side (CONTRACT §2.13): resolves the bundled PresentMon exe for the
//! agent's `--presentmon` flag, applies the opt-in setting right after every `hello` (so the
//! ETW session starts with Nexum, not with a game), caches and forwards the agent's
//! `frameSession` / `frameTarget` / `frameStats` lines and serves the frame commands.
//!
//! Rust never spawns PresentMon and never verifies it: the elevated agent runs its own trust
//! check right before every spawn (CONTRACT §1.6.1). Nothing here touches other processes.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, Settings, FPS_WINDOW_MAX, FPS_WINDOW_MIN};
use crate::state::AppState;
use crate::util::lock;

/// Resource path of the bundled exe (CONTRACT §4.1, F's `bundle.resources`).
pub const PRESENTMON_RESOURCE: &str = "presentmon/PresentMon-2.6.0-x64.exe";
/// Excluded by the agent's fixed CLI arguments; never stored in `fpsExcludes`.
pub const FIXED_EXCLUDES: [&str; 4] = [
    "dwm.exe",
    "msedgewebview2.exe",
    "Nexum.exe",
    "nexum-agent.exe",
];
pub const MAX_EXCLUDES: usize = 50;
/// `set_frame_target` / `list_presenting_processes` wait limit.
const FRAME_WAIT: Duration = Duration::from_secs(3);

/// `FrameState` (`get_frame_state`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameState {
    pub session: Option<Value>,
    pub target: Option<Value>,
    pub stats: Option<Value>,
}

#[derive(Default)]
pub struct FrameBridge {
    cache: Mutex<FrameState>,
    /// One `frameTarget` request in flight.
    target_lock: Mutex<()>,
    /// One `presentingList` request in flight.
    list_lock: Mutex<()>,
}

/// The bundled PresentMon exe when it resolves to an existing file, as a plain path string.
pub fn presentmon_path(app: &AppHandle) -> Option<String> {
    let path = app
        .path()
        .resolve(PRESENTMON_RESOURCE, BaseDirectory::Resource)
        .ok()?;
    if !path.is_absolute() || !path.is_file() {
        return None;
    }
    Some(crate::purge_log::display_path(&path))
}

/// One user exclude entry: `^[A-Za-z0-9 _.()\-]{1,60}\.exe$` (case-insensitive).
pub fn valid_exclude(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    if chars.len() < 5 || chars.len() > 64 {
        return false;
    }
    let (stem, ext) = chars.split_at(chars.len() - 4);
    let ext: String = ext.iter().collect();
    ext.eq_ignore_ascii_case(".exe")
        && stem
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '(' | ')' | '-'))
}

/// CONTRACT §2.13: trim; keep valid entries; drop the fixed excludes; dedupe
/// case-insensitively keeping the first spelling; max 50.
pub fn sanitize_excludes(names: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let t = n.trim().to_string();
        if !valid_exclude(&t) {
            continue;
        }
        if FIXED_EXCLUDES.iter().any(|f| f.eq_ignore_ascii_case(&t)) {
            continue;
        }
        if out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            continue;
        }
        out.push(t);
        if out.len() >= MAX_EXCLUDES {
            break;
        }
    }
    out
}

/// `frameWindow` → `frameExclude` → `frames {enabled:true}` (the contract's order).
fn enable_commands(s: &Settings) -> [Value; 3] {
    [
        json!({ "cmd": "frameWindow", "sec": s.fps_window_sec }),
        json!({ "cmd": "frameExclude", "names": s.fps_excludes }),
        json!({ "cmd": "frames", "enabled": true }),
    ]
}

fn send_all(app: &AppHandle, cmds: &[Value]) {
    let state = app.state::<AppState>();
    if !state.agent.is_running() {
        return;
    }
    for c in cmds {
        if let Err(e) = state.agent.send(c) {
            eprintln!("[nexum] could not send a frame command: {e}");
            return;
        }
    }
}

/// After every `hello`: start capture when the user opted in.
pub fn on_hello(app: &AppHandle) {
    let settings = lock(&app.state::<AppState>().settings).clone();
    if settings.fps_capture_enabled {
        send_all(app, &enable_commands(&settings));
    }
}

/// Forgets the cached lines (agent exit or a new agent process).
pub fn clear(app: &AppHandle) {
    *lock(&app.state::<AppState>().frames.cache) = FrameState::default();
}

/// A cached copy of a `frameStats` line with `frametimes: []` (the batch belongs to the event).
pub fn stats_for_cache(v: &Value) -> Value {
    let mut c = v.clone();
    if let Value::Object(map) = &mut c {
        map.insert("frametimes".into(), Value::Array(Vec::new()));
    }
    c
}

/// Caches and forwards a `frameSession` / `frameTarget` / `frameStats` line verbatim.
pub fn on_line(app: &AppHandle, value: Value) {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = app.state::<AppState>();
    let event = {
        let mut cache = lock(&state.frames.cache);
        match kind.as_str() {
            "frameSession" => {
                cache.session = Some(value.clone());
                // A stopped or failed session has no target and no statistics any more.
                if value.get("state").and_then(Value::as_str) != Some("running")
                    && value.get("state").and_then(Value::as_str) != Some("starting")
                {
                    cache.stats = None;
                }
                "frame-session"
            }
            "frameTarget" => {
                if value.get("pid").map_or(true, Value::is_null) {
                    cache.stats = None;
                }
                cache.target = Some(value.clone());
                "frame-target"
            }
            "frameStats" => {
                cache.stats = Some(stats_for_cache(&value));
                "frame-stats"
            }
            _ => return,
        }
    };
    let _ = app.emit(event, value);
}

/// Applies changed frame settings exactly like the dedicated commands (CONTRACT §2.13).
pub fn apply_settings_change(app: &AppHandle, old: &Settings, new: &Settings) {
    let mut cmds: Vec<Value> = Vec::new();
    if new.fps_capture_enabled && !old.fps_capture_enabled {
        cmds.extend(enable_commands(new));
    } else if !new.fps_capture_enabled && old.fps_capture_enabled {
        cmds.push(json!({ "cmd": "frames", "enabled": false }));
    } else {
        // Window and excludes are forwarded whenever they change (harmless while off).
        if new.fps_window_sec != old.fps_window_sec {
            cmds.push(json!({ "cmd": "frameWindow", "sec": new.fps_window_sec }));
        }
        if new.fps_excludes != old.fps_excludes {
            cmds.push(json!({ "cmd": "frameExclude", "names": new.fps_excludes }));
        }
    }
    if !cmds.is_empty() {
        send_all(app, &cmds);
    }
}

/// Saves a settings change on a blocking thread and applies it to the agent.
async fn save_and_apply(
    app: AppHandle,
    f: impl FnOnce(&mut Settings) + Send + 'static,
) -> Result<Settings, String> {
    let worker = app.clone();
    let (old, new) =
        tauri::async_runtime::spawn_blocking(move || settings::update_settings(&worker, f))
            .await
            .map_err(|e| format!("Settings worker failed: {e}"))??;
    apply_settings_change(&app, &old, &new);
    Ok(new)
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_frame_state(app: AppHandle) -> Result<FrameState, String> {
    Ok(lock(&app.state::<AppState>().frames.cache).clone())
}

/// Saves `fpsCaptureEnabled` and always forwards it, even when the value did not change: a
/// session that ended in an error stays off until the next `frames {enabled:true}`
/// (CONTRACT §1.6.1), so "turn it on" must reach the agent again.
#[tauri::command]
pub async fn set_frame_capture(app: AppHandle, enabled: bool) -> Result<Settings, String> {
    let worker = app.clone();
    let (_, new) = tauri::async_runtime::spawn_blocking(move || {
        settings::update_settings(&worker, |s| s.fps_capture_enabled = enabled)
    })
    .await
    .map_err(|e| format!("Settings worker failed: {e}"))??;
    if enabled {
        send_all(&app, &enable_commands(&new));
    } else {
        send_all(&app, &[json!({ "cmd": "frames", "enabled": false })]);
    }
    Ok(new)
}

/// Integer clamp 5..120 of a number from the UI.
pub fn clamp_window(sec: f64) -> Option<u64> {
    sec.is_finite().then(|| {
        sec.round()
            .clamp(FPS_WINDOW_MIN as f64, FPS_WINDOW_MAX as f64) as u64
    })
}

#[tauri::command]
pub async fn set_frame_window(app: AppHandle, sec: f64) -> Result<Settings, String> {
    let sec = clamp_window(sec).ok_or_else(|| "Invalid window".to_string())?;
    save_and_apply(app, move |s| s.fps_window_sec = sec).await
}

#[tauri::command]
pub async fn set_frame_excludes(app: AppHandle, names: Vec<String>) -> Result<Settings, String> {
    let names = sanitize_excludes(names);
    save_and_apply(app, move |s| s.fps_excludes = names).await
}

#[tauri::command]
pub async fn set_frame_target(app: AppHandle, pid: Option<f64>) -> Result<(), String> {
    let pid: Option<u32> = match pid {
        None => None,
        Some(p) if p.is_finite() && p > 0.0 && p.fract() == 0.0 && p <= u32::MAX as f64 => {
            Some(p as u32)
        }
        Some(_) => return Err("Invalid process id".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _one = lock(&state.frames.target_lock);
        state
            .agent
            .request_ack_checked(
                &json!({ "cmd": "frameTarget", "pid": pid }),
                "frameTarget",
                FRAME_WAIT,
                "That app is not presenting frames.",
            )
            .map(|_| ())
    })
    .await
    .map_err(|e| format!("Frame target failed: {e}"))?
}

#[tauri::command]
pub async fn list_presenting_processes(app: AppHandle) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _one = lock(&state.frames.list_lock);
        let reply = state.agent.request_reply(
            &json!({ "cmd": "presentingList" }),
            "presentingList",
            "presentingList",
            FRAME_WAIT,
        )?;
        Ok(reply
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    })
    .await
    .map_err(|e| format!("Presenting list failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_pattern() {
        for ok in [
            "obs64.exe",
            "Game (x64).exe",
            "my_app-2.0.EXE",
            "a.exe",
            "Some App.exe",
        ] {
            assert!(valid_exclude(ok), "{ok}");
        }
        let long = format!("{}.exe", "a".repeat(61));
        for bad in [
            ".exe",
            "obs64",
            "obs64.exe.bak",
            r"C:\x.exe",
            "a/b.exe",
            "x*.exe",
            long.as_str(),
            "naïve.exe",
        ] {
            assert!(!valid_exclude(bad), "{bad}");
        }
        assert!(valid_exclude(&format!("{}.exe", "a".repeat(60))));
    }

    #[test]
    fn excludes_are_sanitized() {
        let names = vec![
            " obs64.exe ".to_string(),
            "OBS64.EXE".to_string(),
            "DWM.exe".to_string(),
            "nexum.EXE".to_string(),
            "bad".to_string(),
            "discord.exe".to_string(),
        ];
        assert_eq!(sanitize_excludes(names), vec!["obs64.exe", "discord.exe"]);
        let many: Vec<String> = (0..80).map(|i| format!("app{i}.exe")).collect();
        let s = sanitize_excludes(many);
        assert_eq!(s.len(), MAX_EXCLUDES);
        assert_eq!(s[0], "app0.exe");
    }

    #[test]
    fn enable_order_and_cached_stats() {
        let s = Settings {
            fps_window_sec: 60,
            fps_excludes: vec!["obs64.exe".into()],
            ..Settings::default()
        };
        let cmds = enable_commands(&s);
        assert_eq!(cmds[0], json!({ "cmd": "frameWindow", "sec": 60 }));
        assert_eq!(
            cmds[1],
            json!({ "cmd": "frameExclude", "names": ["obs64.exe"] })
        );
        assert_eq!(cmds[2], json!({ "cmd": "frames", "enabled": true }));
        let stats = json!({ "type": "frameStats", "pid": 1, "frametimes": [6.9, 7.1] });
        let c = stats_for_cache(&stats);
        assert_eq!(c["frametimes"], json!([]));
        assert_eq!(c["pid"], 1);
        assert_eq!(clamp_window(2.0), Some(5));
        assert_eq!(clamp_window(30.4), Some(30));
        assert_eq!(clamp_window(999.0), Some(120));
        assert_eq!(clamp_window(f64::NAN), None);
    }
}
