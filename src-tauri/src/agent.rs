//! `nexum-agent` sidecar lifecycle: spawn, NDJSON stdout parsing, stdin commands,
//! auto-restart with backoff, hang detection, the fan fail-safe watchdog (CONTRACT §2.4),
//! degraded-mode status (§2.3), the sensor-tree bridge (§1.3) and graceful shutdown.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::failsafe;
use crate::settings;
use crate::spec::SystemSpec;
use crate::state::AppState;
use crate::util::{lock, now_ms};

const SIDECAR_NAME: &str = "nexum-agent";
const MAX_RESTARTS: usize = 5;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
// The sidecar restores BIOS fan control before closing hardware, but may first have to
// wait (up to 2 s, `ShutdownLockWaitMs` in Program.cs) for an in-flight sensor tick to release
// its lock, then up to 1.5 s per restore for the shared ISA-bus mutex. A hard kill before the
// restore leaves the fans at their manual duty, so the grace must exceed those waits.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(6000);
const MAX_LINE_BUFFER: usize = 8 * 1024 * 1024;
/// `hello.protocol` of an agent that implements CONTRACT 1.1.0 (was 2 in 1.0.0-gate).
pub const AGENT_PROTOCOL: u64 = 3;
/// Error texts of request/reply commands (CONTRACT §2.13, §2.14).
pub const ERR_NOT_RUNNING: &str = "Hardware agent is not running";
pub const ERR_NO_ANSWER: &str = "Hardware agent did not answer";
/// Hang detection (CONTRACT §2.4 item 2): no stdout line for max(15 s, 3 × interval).
const HANG_MIN_MS: u64 = 15_000;
/// Before the first line, LHM `Open()` (driver load, storage enumeration) may take a while.
/// No fan is under manual control before `hello`, so a longer start-up allowance is safe.
const STARTUP_GRACE_MS: u64 = 60_000;
const WATCHDOG_TICK: Duration = Duration::from_millis(1000);
/// `get_sensor_tree` / `reset_sensor_stats` wait limit.
pub const SENSOR_WAIT: Duration = Duration::from_secs(5);

/// The four PawnIO-dependent feature names, in contract order (CONTRACT §2.3).
const MISSING_PAWNIO: [&str; 4] = [
    "CPU temperature, power and clock",
    "Motherboard temperatures, voltages and fans",
    "Fan control",
    "Memory module details",
];
/// Everything a non-elevated agent cannot read, in contract order.
const MISSING_NOT_ELEVATED: [&str; 6] = [
    "CPU temperature, power and clock",
    "Motherboard temperatures, voltages and fans",
    "Fan control",
    "Drive S.M.A.R.T. health",
    "Memory module details",
    "Windows Update cache, error report and crash dump cleanup",
];

/// `hello.sensorDriver` (CONTRACT §1.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorDriverStatus {
    pub kind: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub min_version: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub is_admin: bool,
    pub message: String,
    pub last_packet_ts: Option<u64>,
    pub sensor_driver: Option<SensorDriverStatus>,
    pub limited_reasons: Vec<String>,
    pub missing_features: Vec<String>,
    pub protocol: Option<u64>,
}

impl AgentStatus {
    /// Agent down: no driver info, not "limited" (offline is reported by `running:false`).
    fn clear_agent_fields(&mut self) {
        self.sensor_driver = None;
        self.limited_reasons.clear();
        self.missing_features.clear();
        self.protocol = None;
    }
}

/// `limitedReasons` and `missingFeatures` for a hello (CONTRACT §2.3).
pub fn limited_mode(is_admin: bool, driver_reason: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut reasons: Vec<String> = Vec::new();
    if !is_admin {
        reasons.push("notElevated".to_string());
    }
    match driver_reason {
        Some("missing") => reasons.push("pawnIoMissing".to_string()),
        Some("outdated") => reasons.push("pawnIoOutdated".to_string()),
        _ => {}
    }
    let features: &[&str] = if !is_admin {
        &MISSING_NOT_ELEVATED
    } else if reasons.iter().any(|r| r.starts_with("pawnIo")) {
        &MISSING_PAWNIO
    } else {
        &[]
    };
    (
        reasons,
        features.iter().map(|s| (*s).to_string()).collect(),
    )
}

/// Fields of a `hello` line Rust acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct Hello {
    pub version: String,
    pub protocol: Option<u64>,
    pub is_admin: bool,
    pub pid: Option<u64>,
    pub sensor_driver: Option<SensorDriverStatus>,
    pub fan_flag: Option<String>,
}

pub fn parse_hello(v: &Value) -> Hello {
    Hello {
        version: v
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string(),
        protocol: v.get("protocol").and_then(Value::as_u64),
        is_admin: v.get("isAdmin").and_then(Value::as_bool).unwrap_or(false),
        pid: v.get("pid").and_then(Value::as_u64),
        sensor_driver: v
            .get("sensorDriver")
            .filter(|d| d.is_object())
            .and_then(|d| serde_json::from_value(d.clone()).ok()),
        fan_flag: v
            .get("fanFlag")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Applies a hello to the status (CONTRACT §2.3).
pub fn apply_hello(s: &mut AgentStatus, h: &Hello) {
    s.running = true;
    s.is_admin = h.is_admin;
    let (reasons, features) = limited_mode(
        h.is_admin,
        h.sensor_driver.as_ref().and_then(|d| d.reason.as_deref()),
    );
    s.limited_reasons = reasons;
    s.missing_features = features;
    s.sensor_driver = h.sensor_driver.clone();
    s.protocol = h.protocol;
    s.message = if h.protocol != Some(AGENT_PROTOCOL) {
        format!(
            "Hardware agent version mismatch (protocol {})",
            h.protocol
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    } else {
        match h.pid {
            Some(pid) => format!("Hardware agent v{} online (pid {pid})", h.version),
            None => format!("Hardware agent v{} online", h.version),
        }
    };
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

/// Waits for a reply line of type `reply_type` (e.g. `presentingList`); an `ack` with
/// `cmd == ack_cmd` and `ok:false` answers it with an error instead.
struct ReplyWaiter {
    id: u64,
    reply_type: &'static str,
    ack_cmd: &'static str,
    tx: mpsc::Sender<Result<Value, String>>,
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
    reply_waiters: Mutex<Vec<ReplyWaiter>>,
    next_waiter_id: AtomicU64,
    /// Monotonic base for `last_line_ms`.
    clock: Instant,
    /// `clock`-relative time of the last complete stdout line (or of the spawn).
    last_line_ms: AtomicU64,
    /// At least one line arrived from the current process.
    got_line: AtomicBool,
    /// Pid of the spawned sidecar (0 when none).
    child_pid: AtomicU32,
    /// Latest `sensorTree` line (verbatim); cleared when the agent exits.
    sensor_tree: Mutex<Option<Value>>,
    /// The UI wants `sensorValues` (`set_sensor_stream`).
    stream_wish: AtomicBool,
    /// Last `sensorStream` value sent to the current process (`None` = not sent yet).
    stream_sent: Mutex<Option<bool>>,
    /// Serializes `get_system_spec` requests (one in flight).
    pub(crate) spec_lock: Mutex<()>,
    spec_waiter: Mutex<Option<mpsc::Sender<Value>>>,
    /// Merged `SystemSpec`, cached until `refresh:true` or an agent restart.
    pub(crate) spec_cache: Mutex<Option<SystemSpec>>,
    /// The fail-safe's immediate (no back-off) restart was used.
    immediate_restart_used: AtomicBool,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(AgentStatus {
                running: false,
                is_admin: false,
                message: "Hardware agent not started".to_string(),
                ..Default::default()
            }),
            generation: AtomicU64::new(0),
            exited: AtomicBool::new(true),
            expected_exit: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            restart_times: Mutex::new(VecDeque::new()),
            waiters: Mutex::new(Vec::new()),
            reply_waiters: Mutex::new(Vec::new()),
            next_waiter_id: AtomicU64::new(1),
            clock: Instant::now(),
            last_line_ms: AtomicU64::new(0),
            got_line: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            sensor_tree: Mutex::new(None),
            stream_wish: AtomicBool::new(false),
            stream_sent: Mutex::new(None),
            spec_lock: Mutex::new(()),
            spec_waiter: Mutex::new(None),
            spec_cache: Mutex::new(None),
            immediate_restart_used: AtomicBool::new(false),
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

    /// Pid of the running sidecar, if any (for the self-usage readout).
    pub fn agent_pid(&self) -> Option<u32> {
        match self.child_pid.load(Ordering::SeqCst) {
            0 => None,
            pid => Some(pid),
        }
    }

    /// The cached sensor tree (verbatim `sensorTree` line).
    pub fn sensor_tree(&self) -> Option<Value> {
        lock(&self.sensor_tree).clone()
    }

    /// Runs `f` on the cached sensor tree without cloning it (keep `f` short: the reader
    /// waits for this lock).
    pub fn with_sensor_tree<R>(&self, f: impl FnOnce(Option<&Value>) -> R) -> R {
        let guard = lock(&self.sensor_tree);
        f(guard.as_ref())
    }

    fn elapsed_ms(&self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }

    fn touch(&self) {
        self.last_line_ms.store(self.elapsed_ms(), Ordering::SeqCst);
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

    /// Sends `{cmd:"spec"}` and waits (up to `timeout`) for the `spec` line. Callers hold
    /// `spec_lock`, so only one request is in flight.
    pub fn request_spec(&self, timeout: Duration) -> Result<Value, String> {
        const NOT_RUNNING: &str = "Hardware agent is not running";
        const NO_ANSWER: &str = "Hardware agent did not answer";
        if !self.is_running() {
            return Err(NOT_RUNNING.to_string());
        }
        let (tx, rx) = mpsc::channel();
        *lock(&self.spec_waiter) = Some(tx);
        if self.send(&json!({ "cmd": "spec" })).is_err() {
            *lock(&self.spec_waiter) = None;
            return Err(NOT_RUNNING.to_string());
        }
        let result = rx.recv_timeout(timeout);
        *lock(&self.spec_waiter) = None;
        result.map_err(|_| NO_ANSWER.to_string())
    }

    /// Sends a command and waits (up to `timeout`) for its ack with the contract's error texts:
    /// agent down → `Hardware agent is not running`, timeout → `Hardware agent did not answer`,
    /// `ok:false` → the agent's message (or `fallback` when it is empty).
    pub fn request_ack_checked(
        &self,
        value: &Value,
        cmd: &str,
        timeout: Duration,
        fallback: &str,
    ) -> Result<AgentAck, String> {
        if !self.is_running() {
            return Err(ERR_NOT_RUNNING.to_string());
        }
        match self.request_ack(value, cmd, timeout) {
            Ok(ack) if ack.ok => Ok(ack),
            Ok(ack) if ack.message.is_empty() => Err(fallback.to_string()),
            Ok(ack) => Err(ack.message),
            Err(e) if e.starts_with("Timed out") => Err(ERR_NO_ANSWER.to_string()),
            Err(_) => Err(ERR_NOT_RUNNING.to_string()),
        }
    }

    /// Sends a command and waits (up to `timeout`) for the next line of type `reply_type`.
    /// An `ack` for `ack_cmd` with `ok:false` ends the wait with its message. Blocking.
    pub fn request_reply(
        &self,
        value: &Value,
        reply_type: &'static str,
        ack_cmd: &'static str,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_running() {
            return Err(ERR_NOT_RUNNING.to_string());
        }
        let (tx, rx) = mpsc::channel();
        let id = self.next_waiter_id.fetch_add(1, Ordering::SeqCst);
        lock(&self.reply_waiters).push(ReplyWaiter {
            id,
            reply_type,
            ack_cmd,
            tx,
        });
        if self.send(value).is_err() {
            lock(&self.reply_waiters).retain(|w| w.id != id);
            return Err(ERR_NOT_RUNNING.to_string());
        }
        let result = rx.recv_timeout(timeout);
        lock(&self.reply_waiters).retain(|w| w.id != id);
        match result {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ERR_NO_ANSWER.to_string()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ERR_NOT_RUNNING.to_string()),
        }
    }

    /// Hands a reply line to every waiter for its type.
    fn resolve_replies(&self, reply_type: &str, value: &Value) {
        lock(&self.reply_waiters).retain(|w| {
            if w.reply_type == reply_type {
                let _ = w.tx.send(Ok(value.clone()));
                false
            } else {
                true
            }
        });
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
        drop(waiters);
        if !ack.ok {
            lock(&self.reply_waiters).retain(|w| {
                if w.ack_cmd.eq_ignore_ascii_case(&ack.cmd) {
                    let message = if ack.message.is_empty() {
                        "The hardware agent could not run this command".to_string()
                    } else {
                        ack.message.clone()
                    };
                    let _ = w.tx.send(Err(message));
                    false
                } else {
                    true
                }
            });
        }
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
        drop(waiters);
        for w in lock(&self.reply_waiters).drain(..) {
            let _ = w.tx.send(Err(ERR_NOT_RUNNING.to_string()));
        }
        // Dropping the sender wakes a pending spec request.
        lock(&self.spec_waiter).take();
    }
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

/// Effective sensor stream (CONTRACT §2.9, §2.10.5):
/// `((wish ∧ visible) ∨ logActive ∨ (hidden ∧ traySensors ≠ ∅)) ∧ running`.
pub fn stream_effective(
    wish: bool,
    hidden: bool,
    log_active: bool,
    tray_sensors: bool,
    running: bool,
) -> bool {
    running && ((wish && !hidden) || log_active || (hidden && tray_sensors))
}

/// Sends `sensorStream` when the effective value ([`stream_effective`]) differs from what the
/// current process last received, or always when `force`.
pub fn sync_sensor_stream(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    let running = mgr.is_running();
    let effective = stream_effective(
        mgr.stream_wish.load(Ordering::SeqCst),
        state.in_tray.load(Ordering::SeqCst),
        state.sensor_log.is_active(),
        !lock(&state.tray_sensors).is_empty(),
        running,
    );
    let mut sent = lock(&mgr.stream_sent);
    if !running {
        *sent = None;
        return;
    }
    if !force && *sent == Some(effective) {
        return;
    }
    match mgr.send(&json!({ "cmd": "sensorStream", "on": effective })) {
        Ok(()) => *sent = Some(effective),
        Err(e) => eprintln!("[nexum] could not set the sensor stream: {e}"),
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
    // A new process: forget everything cached from the previous one.
    *lock(&mgr.sensor_tree) = None;
    *lock(&mgr.spec_cache) = None;
    *lock(&mgr.stream_sent) = None;
    crate::frames::clear(app);
    crate::tuning::clear(app);

    // CONTRACT §1.1 / §2.13: `--presentmon "<abs path>"` only when the bundled exe exists.
    let command = match app.shell().sidecar(SIDECAR_NAME) {
        Ok(c) => match crate::frames::presentmon_path(app) {
            Some(path) => c.args(["--presentmon".to_string(), path]),
            None => c,
        },
        Err(e) => {
            update_status(app, |s| {
                s.running = false;
                s.clear_agent_fields();
                s.message = format!("Hardware agent unavailable: {e}");
            });
            return;
        }
    };

    match command.set_raw_out(true).kill_on_drop(true).spawn() {
        Ok((rx, child)) => {
            mgr.child_pid.store(child.pid(), Ordering::SeqCst);
            mgr.got_line.store(false, Ordering::SeqCst);
            mgr.touch();
            mgr.exited.store(false, Ordering::SeqCst);
            *lock(&mgr.child) = Some(child);
            update_status(app, |s| {
                s.running = true;
                s.clear_agent_fields();
                s.message = "Hardware agent starting…".to_string();
            });
            spawn_reader(app.clone(), rx, gen);
        }
        Err(e) => {
            mgr.exited.store(true, Ordering::SeqCst);
            mgr.child_pid.store(0, Ordering::SeqCst);
            update_status(app, |s| {
                s.running = false;
                s.clear_agent_fields();
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
    let state = app.state::<AppState>();
    // Any line proves the agent is alive (hang detection).
    state.agent.touch();
    state.agent.got_line.store(true, Ordering::SeqCst);

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
    match value.get("type").and_then(Value::as_str).unwrap_or("") {
        "telemetry" => {
            let ts = value
                .get("ts")
                .and_then(Value::as_u64)
                .unwrap_or_else(now_ms);
            let (became_running, is_admin) = {
                let mut st = lock(&state.agent.status);
                st.last_packet_ts = Some(ts);
                let became = if !st.running {
                    st.running = true;
                    if st.message.is_empty() || st.message.starts_with("Hardware agent starting") {
                        st.message = "Hardware agent online".to_string();
                    }
                    true
                } else {
                    false
                };
                (became, st.is_admin)
            };
            if became_running {
                let _ = app.emit("agent-status", state.agent.status());
            }
            if value.pointer("/fanSafety/failsafe").and_then(Value::as_bool) == Some(true) {
                failsafe::update(app, |t, now| t.on_failsafe_telemetry(is_admin, now));
            }
            crate::alerts::on_telemetry(app, &value);
            crate::drive_history::on_telemetry(app, &value);
            let _ = app.emit("telemetry", value);
        }
        "sensorValues" => {
            crate::sensor_log::on_values(app, &value);
            *lock(&state.latest_values) = Some((Instant::now(), value.clone()));
            let _ = app.emit("sensor-values", value);
        }
        "sensorTree" => {
            *lock(&state.agent.sensor_tree) = Some(value.clone());
            crate::sensor_log::on_tree(app, &value);
            let _ = app.emit("sensor-tree", value);
        }
        "frameSession" | "frameTarget" | "frameStats" => {
            crate::frames::on_line(app, value);
        }
        "presentingList" => {
            state.agent.resolve_replies("presentingList", &value);
        }
        "tuningState" => {
            crate::tuning::on_state(app, &value);
            state.agent.resolve_replies("tuningState", &value);
        }
        "tuningProbe" => {
            state.agent.resolve_replies("tuningProbe", &value);
        }
        "spec" => {
            if let Some(tx) = lock(&state.agent.spec_waiter).take() {
                let _ = tx.send(value);
            }
        }
        "hello" => {
            let hello = parse_hello(&value);
            if hello.protocol != Some(AGENT_PROTOCOL) {
                eprintln!(
                    "[nexum] warning: hardware agent speaks protocol {:?}, expected {AGENT_PROTOCOL}",
                    hello.protocol
                );
            }
            update_status(app, |s| apply_hello(s, &hello));
            failsafe::update(app, |t, now| {
                t.on_hello(hello.fan_flag.as_deref(), hello.is_admin, now)
            });
            // A new process: its spec may differ (e.g. elevation changed).
            *lock(&state.agent.spec_cache) = None;
            // The new process starts with the stream off: always re-send the wish.
            sync_sensor_stream(app, true);
            // Sync the poll interval with the current settings / tray state.
            apply_interval(app);
            // CONTRACT §2.13: frame capture starts with the agent (not with a game).
            crate::frames::on_hello(app);
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
    mgr.child_pid.store(0, Ordering::SeqCst);
    // The process is gone; drop the handle (kill_on_drop on a dead process is harmless).
    let dead = lock(&mgr.child).take();
    drop(dead);
    mgr.fail_all_waiters("Hardware agent exited");
    *lock(&mgr.sensor_tree) = None;
    *lock(&mgr.stream_sent) = None;
    *lock(&state.latest_values) = None;
    crate::frames::clear(app);
    crate::tuning::clear(app);
    crate::alerts::on_agent_down(app);

    let code_text = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());

    if mgr.shutting_down.load(Ordering::SeqCst) || mgr.expected_exit.load(Ordering::SeqCst) {
        update_status(app, |s| {
            s.running = false;
            s.clear_agent_fields();
            s.message = "Hardware agent stopped".to_string();
        });
        return;
    }

    // Abnormal exit (crash, kill, hang). With the fan write-ahead flag present, fans may be
    // stuck at a manual duty: warn, and restart at once so the new agent latches them at 100%.
    let flag = failsafe::flag_exists();
    failsafe::update(app, |t, now| t.on_abnormal_exit(flag, now));
    let immediate = flag && !mgr.immediate_restart_used.swap(true, Ordering::SeqCst);

    let attempt = {
        let mut times = lock(&mgr.restart_times);
        let now = Instant::now();
        while times
            .front()
            .is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW)
        {
            times.pop_front();
        }
        if times.len() >= MAX_RESTARTS && !immediate {
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
            s.clear_agent_fields();
            s.message = format!(
                "Hardware agent crashed repeatedly (exit code {code_text}). Use Restart Agent to try again."
            );
        }),
        Some(n) => {
            let delay = if immediate {
                Duration::ZERO
            } else {
                Duration::from_millis((1000u64 << n.min(4)).min(15_000))
            };
            update_status(app, |s| {
                s.running = false;
                s.clear_agent_fields();
                s.message = if immediate {
                    format!("Hardware agent exited (code {code_text}); restarting now")
                } else {
                    format!(
                        "Hardware agent exited (code {code_text}); restarting in {}s",
                        delay.as_secs().max(1)
                    )
                };
            });
            let app = app.clone();
            std::thread::spawn(move || {
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
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

/// Hang threshold in ms: max(15 s, 3 × effective interval) once the agent has spoken,
/// a start-up allowance before that.
pub fn hang_limit_ms(got_line: bool, interval_ms: u64) -> u64 {
    if got_line {
        HANG_MIN_MS.max(interval_ms.saturating_mul(3))
    } else {
        STARTUP_GRACE_MS
    }
}

/// Starts the hang watchdog (CONTRACT §2.4 item 2): an agent that stops writing lines is
/// killed, which the reader then handles as an abnormal exit (restart + fail-safe check).
pub fn start_watchdog(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-agent-watchdog".into())
        .spawn(move || {
            let mut last_tick = Instant::now();
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                let state = app.state::<AppState>();
                let mgr = &state.agent;
                if mgr.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                // A tick that took far longer than it should means the whole system was
                // suspended (sleep/hibernate): the agent was frozen too, not hung. Start over.
                let gap = last_tick.elapsed();
                last_tick = Instant::now();
                if gap > WATCHDOG_TICK * 5 {
                    mgr.touch();
                    continue;
                }
                if !mgr.is_running() || mgr.expected_exit.load(Ordering::SeqCst) {
                    continue;
                }
                let idle = mgr
                    .elapsed_ms()
                    .saturating_sub(mgr.last_line_ms.load(Ordering::SeqCst));
                let limit = hang_limit_ms(
                    mgr.got_line.load(Ordering::SeqCst),
                    settings::effective_poll_ms(&app),
                );
                if idle <= limit {
                    continue;
                }
                eprintln!("[nexum] hardware agent sent nothing for {idle} ms; restarting it");
                // Taking the child stops further writes; the reader sees `Terminated` and runs
                // the abnormal-exit path (expected_exit stays false).
                let child = lock(&mgr.child).take();
                if let Some(child) = child {
                    if let Err(e) = child.kill() {
                        eprintln!("[nexum] could not kill the hung agent: {e}");
                    }
                }
                mgr.touch();
            }
        });
    if let Err(e) = spawned {
        eprintln!("[nexum] agent watchdog unavailable: {e}");
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

/// `get_sensor_tree`: the cached tree; if none and the agent runs, asks for it and waits ≤ 5 s.
#[tauri::command]
pub async fn get_sensor_tree(app: AppHandle) -> Result<Option<Value>, String> {
    {
        let state = app.state::<AppState>();
        if let Some(tree) = state.agent.sensor_tree() {
            return Ok(Some(tree));
        }
        if !state.agent.is_running() {
            return Ok(None);
        }
    }
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        let mgr = &state.agent;
        if mgr.send(&json!({ "cmd": "sensorTree" })).is_err() {
            return None;
        }
        let deadline = Instant::now() + SENSOR_WAIT;
        while Instant::now() < deadline {
            if let Some(tree) = mgr.sensor_tree() {
                return Some(tree);
            }
            if !mgr.is_running() {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    })
    .await
    .map_err(|e| format!("Sensor tree request failed: {e}"))
}

/// `set_sensor_stream`: stores the UI's wish; the effective state also needs a visible window
/// and a running agent.
#[tauri::command]
pub fn set_sensor_stream(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<AppState>()
        .agent
        .stream_wish
        .store(on, Ordering::SeqCst);
    sync_sensor_stream(&app, false);
    Ok(())
}

/// Cleans the `ids` argument of `reset_sensor_stats` (`None` = reset all).
pub fn clean_sensor_ids(ids: Option<Vec<String>>) -> Option<Vec<String>> {
    ids.map(|list| {
        let mut out: Vec<String> = Vec::new();
        for id in list {
            let t = id.trim().to_string();
            if !t.is_empty() && t.len() <= 512 && !out.contains(&t) {
                out.push(t);
            }
            if out.len() >= 5000 {
                break;
            }
        }
        out
    })
}

/// `reset_sensor_stats`: forwards `sensorReset` and waits for its ack (≤ 5 s).
#[tauri::command]
pub async fn reset_sensor_stats(app: AppHandle, ids: Option<Vec<String>>) -> Result<(), String> {
    let ids = clean_sensor_ids(ids);
    let worker = app.clone();
    let ack = tauri::async_runtime::spawn_blocking(move || {
        worker.state::<AppState>().agent.request_ack(
            &json!({ "cmd": "sensorReset", "ids": ids }),
            "sensorReset",
            SENSOR_WAIT,
        )
    })
    .await
    .map_err(|e| format!("Sensor reset failed: {e}"))??;
    if ack.ok {
        Ok(())
    } else if ack.message.is_empty() {
        Err("The hardware agent could not reset the sensors".to_string())
    } else {
        Err(ack.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn driver(reason: Option<&str>) -> SensorDriverStatus {
        SensorDriverStatus {
            kind: if reason == Some("missing") {
                "none".into()
            } else {
                "pawnio".into()
            },
            version: Some("2.2.0".into()),
            min_version: "2.1.0".into(),
            ok: reason.is_none(),
            reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn limited_mode_reasons_and_features() {
        let (r, f) = limited_mode(true, None);
        assert!(r.is_empty() && f.is_empty());

        let (r, f) = limited_mode(true, Some("missing"));
        assert_eq!(r, vec!["pawnIoMissing"]);
        assert_eq!(f, MISSING_PAWNIO.to_vec());

        let (r, f) = limited_mode(true, Some("outdated"));
        assert_eq!(r, vec!["pawnIoOutdated"]);
        assert_eq!(f.len(), 4);

        // notElevated first; its feature list wins (superset).
        let (r, f) = limited_mode(false, Some("missing"));
        assert_eq!(r, vec!["notElevated", "pawnIoMissing"]);
        assert_eq!(f, MISSING_NOT_ELEVATED.to_vec());

        // reason "notElevated" from the driver adds nothing beyond !isAdmin.
        let (r, _) = limited_mode(false, Some("notElevated"));
        assert_eq!(r, vec!["notElevated"]);
    }

    #[test]
    fn hello_parsing_and_status() {
        let v = json!({
            "type": "hello", "version": "1.1.0", "protocol": 3, "isAdmin": true, "pid": 42,
            "sensorDriver": { "kind": "none", "version": null, "minVersion": "2.1.0", "ok": false, "reason": "missing" },
            "fanFlag": "none"
        });
        let h = parse_hello(&v);
        assert_eq!(h.protocol, Some(3));
        assert_eq!(h.fan_flag.as_deref(), Some("none"));
        assert_eq!(h.sensor_driver, Some(SensorDriverStatus {
            kind: "none".into(),
            version: None,
            min_version: "2.1.0".into(),
            ok: false,
            reason: Some("missing".into()),
        }));
        let mut s = AgentStatus::default();
        apply_hello(&mut s, &h);
        assert!(s.running && s.is_admin);
        assert_eq!(s.limited_reasons, vec!["pawnIoMissing"]);
        assert_eq!(s.protocol, Some(3));
        assert_eq!(s.message, "Hardware agent v1.1.0 online (pid 42)");
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["sensorDriver"]["minVersion"], "2.1.0");
        assert_eq!(j["limitedReasons"][0], "pawnIoMissing");
        assert_eq!(j["missingFeatures"].as_array().unwrap().len(), 4);

        // Old agent: no protocol, no driver block.
        let h = parse_hello(&json!({ "type": "hello", "version": "0.9", "isAdmin": false }));
        let mut s = AgentStatus::default();
        apply_hello(&mut s, &h);
        assert_eq!(s.protocol, None);
        assert_eq!(s.sensor_driver, None);
        assert_eq!(s.limited_reasons, vec!["notElevated"]);
        assert_eq!(s.message, "Hardware agent version mismatch (protocol unknown)");
        let h = parse_hello(&json!({ "type": "hello", "version": "1.0.0", "protocol": 2, "isAdmin": true, "sensorDriver": driver(None) }));
        apply_hello(&mut s, &h);
        assert_eq!(s.message, "Hardware agent version mismatch (protocol 2)");
        assert!(s.limited_reasons.is_empty());

        s.clear_agent_fields();
        let j = serde_json::to_value(&s).unwrap();
        assert!(j["sensorDriver"].is_null());
        assert_eq!(j["limitedReasons"], json!([]));
        assert_eq!(j["missingFeatures"], json!([]));
        assert!(j["protocol"].is_null());
    }

    #[test]
    fn hang_limits() {
        assert_eq!(hang_limit_ms(true, 1000), 15_000);
        assert_eq!(hang_limit_ms(true, 5000), 15_000);
        assert_eq!(hang_limit_ms(true, 10_000), 30_000);
        assert_eq!(hang_limit_ms(false, 1000), STARTUP_GRACE_MS);
    }

    #[test]
    fn sensor_reset_ids_are_cleaned() {
        assert_eq!(clean_sensor_ids(None), None);
        assert_eq!(
            clean_sensor_ids(Some(vec![" /a ".into(), "".into(), "/a".into(), "/b".into()])),
            Some(vec!["/a".to_string(), "/b".to_string()])
        );
    }
}

#[cfg(test)]
mod stream_tests {
    use super::stream_effective;

    #[test]
    fn effective_stream_formula() {
        // (wish ∧ visible) ∨ logActive ∨ (hidden ∧ traySensors), and only while running.
        assert!(stream_effective(true, false, false, false, true));
        assert!(!stream_effective(true, true, false, false, true), "hidden pauses the UI wish");
        assert!(stream_effective(false, true, true, false, true), "a log forces it on");
        assert!(stream_effective(false, false, true, false, true));
        assert!(stream_effective(false, true, false, true, true), "tray sensors while hidden");
        assert!(!stream_effective(false, false, false, true, true), "tray sensors only while hidden");
        assert!(!stream_effective(true, false, true, true, false), "never while the agent is down");
    }
}
