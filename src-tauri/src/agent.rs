//! `nexum-agent` sidecar lifecycle: spawn, NDJSON stdout parsing, stdin commands,
//! auto-restart with backoff, graceful shutdown.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::settings;
use crate::state::AppState;
use crate::util::lock;

const SIDECAR_NAME: &str = "nexum-agent";
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);
const MAX_LINE_BUFFER: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub is_admin: bool,
    pub message: String,
    pub last_packet_ts: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAck {
    pub cmd: String,
    pub ok: bool,
    pub message: String,
}

struct AckWaiter {
    id: u64,
    cmd: String,
    tx: mpsc::Sender<AgentAck>,
}

pub struct AgentManager {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<AgentStatus>,
    /// Incremented on every spawn; events from older processes are ignored.
    generation: AtomicU64,
    /// Set by the reader when the current process terminated.
    exited: AtomicBool,
    /// Set before an intentional stop so the exit is not treated as a crash.
    expected_exit: AtomicBool,
    /// Set when the app is exiting: no more restarts.
    shutting_down: AtomicBool,
    restart_times: Mutex<VecDeque<Instant>>,
    waiters: Mutex<Vec<AckWaiter>>,
    next_waiter_id: AtomicU64,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(AgentStatus {
                running: false,
                is_admin: false,
                message: "Hardware agent not started".to_string(),
                last_packet_ts: None,
            }),
            generation: AtomicU64::new(0),
            exited: AtomicBool::new(true),
            expected_exit: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            restart_times: Mutex::new(VecDeque::new()),
            waiters: Mutex::new(Vec::new()),
            next_waiter_id: AtomicU64::new(1),
        }
    }
}

impl AgentManager {
    pub fn status(&self) -> AgentStatus {
        lock(&self.status).clone()
    }

    pub fn is_running(&self) -> bool {
        lock(&self.child).is_some() && !self.exited.load(Ordering::SeqCst)
    }

    /// Writes one NDJSON command line to the sidecar's stdin.
    pub fn send(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut guard = lock(&self.child);
        match guard.as_mut() {
            Some(child) if !self.exited.load(Ordering::SeqCst) => child
                .write(&line)
                .map_err(|e| format!("Could not talk to the hardware agent: {e}")),
            _ => Err("Hardware agent is not running".to_string()),
        }
    }

    /// Sends a command and blocks (up to `timeout`) for the matching `ack`.
    /// Must be called from a blocking context (never on the async runtime / main thread).
    pub fn request_ack(
        &self,
        value: &Value,
        cmd: &str,
        timeout: Duration,
    ) -> Result<AgentAck, String> {
        let (tx, rx) = mpsc::channel();
        let id = self.next_waiter_id.fetch_add(1, Ordering::SeqCst);
        lock(&self.waiters).push(AckWaiter {
            id,
            cmd: cmd.to_string(),
            tx,
        });
        if let Err(e) = self.send(value) {
            lock(&self.waiters).retain(|w| w.id != id);
            return Err(e);
        }
        let result = rx.recv_timeout(timeout);
        lock(&self.waiters).retain(|w| w.id != id);
        match result {
            Ok(ack) => Ok(ack),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(format!("Timed out waiting for the hardware agent ({cmd})"))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Hardware agent exited before answering".to_string())
            }
        }
    }

    fn resolve_waiters(&self, ack: &AgentAck) {
        let mut waiters = lock(&self.waiters);
        waiters.retain(|w| {
            if w.cmd.eq_ignore_ascii_case(&ack.cmd) {
                let _ = w.tx.send(ack.clone());
                false
            } else {
                true
            }
        });
    }

    fn fail_all_waiters(&self, message: &str) {
        let mut waiters = lock(&self.waiters);
        for w in waiters.drain(..) {
            let _ = w.tx.send(AgentAck {
                cmd: w.cmd.clone(),
                ok: false,
                message: message.to_string(),
            });
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Mutates the status and emits `agent-status`.
fn update_status(app: &AppHandle, f: impl FnOnce(&mut AgentStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut st = lock(&state.agent.status);
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("agent-status", snapshot);
}

/// Sends the effective poll interval (throttled while in the tray) to the sidecar.
pub fn apply_interval(app: &AppHandle) {
    let ms = settings::effective_poll_ms(app);
    let state = app.state::<AppState>();
    if state.agent.is_running() {
        if let Err(e) = state.agent.send(&json!({ "cmd": "interval", "ms": ms })) {
            eprintln!("[nexum] could not set agent interval: {e}");
        }
    }
}

/// Spawns (or respawns) the sidecar. Never panics: failures are reported via `agent-status`.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    if mgr.shutting_down.load(Ordering::SeqCst) {
        return;
    }

    // Stop a previous instance (if any) before spawning the new one.
    if lock(&mgr.child).is_some() {
        stop_current(app, SHUTDOWN_GRACE);
    }

    let gen = mgr.generation.fetch_add(1, Ordering::SeqCst) + 1;
    mgr.expected_exit.store(false, Ordering::SeqCst);

    let command = match app.shell().sidecar(SIDECAR_NAME) {
        Ok(c) => c,
        Err(e) => {
            update_status(app, |s| {
                s.running = false;
                s.message = format!("Hardware agent unavailable: {e}");
            });
            return;
        }
    };

    match command.set_raw_out(true).kill_on_drop(true).spawn() {
        Ok((rx, child)) => {
            mgr.exited.store(false, Ordering::SeqCst);
            *lock(&mgr.child) = Some(child);
            update_status(app, |s| {
                s.running = true;
                s.message = "Hardware agent starting…".to_string();
            });
            spawn_reader(app.clone(), rx, gen);
        }
        Err(e) => {
            mgr.exited.store(true, Ordering::SeqCst);
            update_status(app, |s| {
                s.running = false;
                s.message = format!("Could not start hardware agent: {e}");
            });
        }
    }
}

fn spawn_reader(app: AppHandle, mut rx: tauri::async_runtime::Receiver<CommandEvent>, gen: u64) {
    tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
        while let Some(event) = rx.recv().await {
            let is_current = app
                .state::<AppState>()
                .agent
                .generation
                .load(Ordering::SeqCst)
                == gen;
            match event {
                CommandEvent::Stdout(bytes) => {
                    if !is_current {
                        continue;
                    }
                    buffer.extend_from_slice(&bytes);
                    drain_lines(&app, &mut buffer);
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                        eprintln!("[nexum-agent] {line}");
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[nexum] agent pipe error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    if is_current {
                        // Flush a final unterminated line, if any.
                        if !buffer.is_empty() {
                            let rest = std::mem::take(&mut buffer);
                            handle_line(&app, &rest);
                        }
                        handle_exit(&app, gen, payload.code);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Splits complete `\n`-terminated lines out of `buffer` and handles them. A trailing
/// fragment stays buffered unless it already is a complete JSON document.
fn drain_lines(app: &AppHandle, buffer: &mut Vec<u8>) {
    let mut start = 0usize;
    while let Some(pos) = buffer[start..].iter().position(|&b| b == b'\n') {
        let end = start + pos;
        handle_line(app, &buffer[start..end]);
        start = end + 1;
    }
    if start > 0 {
        buffer.drain(..start);
    }
    if !buffer.is_empty() {
        let trimmed = trim_ascii(buffer);
        if trimmed.first() == Some(&b'{')
            && trimmed.last() == Some(&b'}')
            && serde_json::from_slice::<Value>(trimmed).is_ok()
        {
            let line = std::mem::take(buffer);
            handle_line(app, &line);
        } else if buffer.len() > MAX_LINE_BUFFER {
            eprintln!("[nexum] discarding oversized agent output fragment");
            buffer.clear();
        }
    }
}

fn trim_ascii(b: &[u8]) -> &[u8] {
    let start = b
        .iter()
        .position(|c| !c.is_ascii_whitespace())
        .unwrap_or(b.len());
    let end = b
        .iter()
        .rposition(|c| !c.is_ascii_whitespace())
        .map(|i| i + 1)
        .unwrap_or(start);
    &b[start..end.max(start)]
}

fn handle_line(app: &AppHandle, raw: &[u8]) {
    let mut line = trim_ascii(raw);
    if let Some(rest) = line.strip_prefix(b"\xEF\xBB\xBF") {
        line = trim_ascii(rest);
    }
    if line.is_empty() {
        return;
    }
    let value: Value = match serde_json::from_slice(line) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[nexum] unparseable agent line ({e}): {}",
                String::from_utf8_lossy(&line[..line.len().min(200)])
            );
            return;
        }
    };
    let state = app.state::<AppState>();
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "telemetry" => {
            let ts = value
                .get("ts")
                .and_then(Value::as_u64)
                .unwrap_or_else(now_ms);
            let became_running = {
                let mut st = lock(&state.agent.status);
                st.last_packet_ts = Some(ts);
                if !st.running {
                    st.running = true;
                    if st.message.is_empty() || st.message.starts_with("Hardware agent starting") {
                        st.message = "Hardware agent online".to_string();
                    }
                    true
                } else {
                    false
                }
            };
            if became_running {
                let _ = app.emit("agent-status", state.agent.status());
            }
            let _ = app.emit("telemetry", value);
        }
        "hello" => {
            let is_admin = value
                .get("isAdmin")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let version = value
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            let pid = value.get("pid").and_then(Value::as_u64);
            update_status(app, |s| {
                s.running = true;
                s.is_admin = is_admin;
                s.message = match pid {
                    Some(pid) => format!("Hardware agent v{version} online (pid {pid})"),
                    None => format!("Hardware agent v{version} online"),
                };
                if !is_admin {
                    s.message.push_str(" — limited sensors (not elevated)");
                }
            });
            // Sync the poll interval with the current settings / tray state.
            apply_interval(app);
        }
        "ack" => {
            let ack = AgentAck {
                cmd: value
                    .get("cmd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
                message: value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            };
            state.agent.resolve_waiters(&ack);
            let _ = app.emit("agent-ack", ack);
        }
        "error" => {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Unknown agent error")
                .to_string();
            eprintln!("[nexum-agent] error: {message}");
            update_status(app, |s| {
                s.message = format!("Agent: {message}");
            });
        }
        other => {
            eprintln!("[nexum] ignoring agent message type '{other}'");
        }
    }
}

fn handle_exit(app: &AppHandle, gen: u64, code: Option<i32>) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    mgr.exited.store(true, Ordering::SeqCst);
    // The process is gone; drop the handle (kill_on_drop on a dead process is harmless).
    let dead = lock(&mgr.child).take();
    drop(dead);
    mgr.fail_all_waiters("Hardware agent exited");

    let code_text = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());

    if mgr.shutting_down.load(Ordering::SeqCst) || mgr.expected_exit.load(Ordering::SeqCst) {
        update_status(app, |s| {
            s.running = false;
            s.message = "Hardware agent stopped".to_string();
        });
        return;
    }

    let attempt = {
        let mut times = lock(&mgr.restart_times);
        let now = Instant::now();
        while times
            .front()
            .is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW)
        {
            times.pop_front();
        }
        if times.len() >= MAX_RESTARTS {
            None
        } else {
            let n = times.len();
            times.push_back(now);
            Some(n)
        }
    };

    match attempt {
        None => update_status(app, |s| {
            s.running = false;
            s.message = format!(
                "Hardware agent crashed repeatedly (exit code {code_text}). Use Restart Agent to try again."
            );
        }),
        Some(n) => {
            let delay = Duration::from_millis((1000u64 << n.min(4)).min(15_000));
            update_status(app, |s| {
                s.running = false;
                s.message = format!(
                    "Hardware agent exited (code {code_text}); restarting in {}s",
                    delay.as_secs().max(1)
                );
            });
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(delay);
                let state = app.state::<AppState>();
                let mgr = &state.agent;
                if mgr.generation.load(Ordering::SeqCst) == gen
                    && !mgr.shutting_down.load(Ordering::SeqCst)
                    && lock(&mgr.child).is_none()
                {
                    start(&app);
                }
            });
        }
    }
}

/// Gracefully stops the current sidecar: `{cmd:"shutdown"}`, wait up to `grace`, then kill.
/// Blocking; call from a blocking context or at exit.
fn stop_current(app: &AppHandle, grace: Duration) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    mgr.expected_exit.store(true, Ordering::SeqCst);

    if !mgr.exited.load(Ordering::SeqCst) {
        let mut guard = lock(&mgr.child);
        if let Some(child) = guard.as_mut() {
            let _ = child.write(b"{\"cmd\":\"shutdown\"}\n");
        }
    }

    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && !mgr.exited.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(20));
    }

    let child = lock(&mgr.child).take();
    if let Some(child) = child {
        if !mgr.exited.load(Ordering::SeqCst) {
            if let Err(e) = child.kill() {
                eprintln!("[nexum] could not kill agent: {e}");
            }
        }
    }
    mgr.exited.store(true, Ordering::SeqCst);
}

/// Called on application exit: no restarts, graceful stop, then kill.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.agent.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    // Bump the generation so late events from this process are ignored.
    stop_current(app, SHUTDOWN_GRACE);
    state.agent.generation.fetch_add(1, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_agent_status(app: AppHandle) -> Result<AgentStatus, String> {
    Ok(app.state::<AppState>().agent.status())
}

#[tauri::command]
pub async fn restart_agent(app: AppHandle) -> Result<(), String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        lock(&state.agent.restart_times).clear();
        start(&worker);
    })
    .await
    .map_err(|e| format!("Restart failed: {e}"))
}

#[tauri::command]
pub async fn set_poll_interval(app: AppHandle, ms: f64) -> Result<(), String> {
    if !ms.is_finite() || ms <= 0.0 {
        return Err("Invalid poll interval".to_string());
    }
    let ms = settings::clamp_poll(ms.round() as u64);
    {
        let state = app.state::<AppState>();
        lock(&state.settings).poll_interval_ms = ms;
    }
    if let Err(e) = settings::persist_current(&app) {
        eprintln!("[nexum] could not persist poll interval: {e}");
    }
    apply_interval(&app);
    Ok(())
}

#[tauri::command]
pub async fn set_fan_preset(app: AppHandle, preset: String) -> Result<(), String> {
    let preset = preset.trim().to_ascii_lowercase();
    if !matches!(
        preset.as_str(),
        "auto" | "silent" | "balanced" | "turbo" | "custom"
    ) {
        return Err(format!("Unknown fan preset '{preset}'"));
    }
    app.state::<AppState>()
        .agent
        .send(&json!({ "cmd": "fanPreset", "preset": preset }))
}

#[tauri::command]
pub async fn set_fan_control(app: AppHandle, id: String, pct: f64) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("Missing fan id".to_string());
    }
    if !pct.is_finite() {
        return Err("Invalid fan duty".to_string());
    }
    let pct = pct.round().clamp(0.0, 100.0) as i64;
    app.state::<AppState>()
        .agent
        .send(&json!({ "cmd": "fanSet", "id": id, "pct": pct }))
}

#[tauri::command]
pub async fn flush_standby(app: AppHandle) -> Result<(), String> {
    app.state::<AppState>()
        .agent
        .send(&json!({ "cmd": "flushStandby" }))
}
