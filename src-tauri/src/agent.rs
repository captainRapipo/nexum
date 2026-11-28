//! `nexum-agent` sidecar lifecycle: spawn, NDJSON stdout parsing, stdin commands,
//! bounded automatic restart (CONTRACT §2.3.1), hang detection, the fan fail-safe watchdog
//! (§2.4), degraded-mode status (§2.3), the sensor-tree bridge (§1.3) and graceful shutdown.
//!
//! In anything a user can read this process is "sensor reading"; in logs and in the diagnostic
//! `AgentStatus.message` it is the "sensor service" (CONTRACT §4.8.1).

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
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
/// Automatic restart policy (CONTRACT §2.3.1; mirrored in `types.ts`): at most this many
/// automatic restarts since the last healthy run, …
pub const SENSOR_RESTART_MAX: usize = 5;
/// … with this delay before restart 1..5, …
pub const SENSOR_RESTART_DELAYS_MS: [u64; SENSOR_RESTART_MAX] =
    [1_000, 2_000, 4_000, 8_000, 15_000];
/// … and the count returns to 0 once a process has stayed up this long after its `hello`.
pub const SENSOR_HEALTHY_RUN_MS: u64 = 60_000;
// The sidecar restores BIOS fan control before closing hardware, but may first have to
// wait (up to 2 s, `ShutdownLockWaitMs` in Program.cs) for an in-flight sensor tick to release
// its lock, then up to 1.5 s per restore for the shared ISA-bus mutex. A hard kill before the
// restore leaves the fans at their manual duty, so the grace must exceed those waits.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(6000);
const MAX_LINE_BUFFER: usize = 8 * 1024 * 1024;
/// `hello.protocol` of an agent that implements CONTRACT 1.1.0 (was 2 in 1.0.0-gate).
pub const AGENT_PROTOCOL: u64 = 3;
/// Error texts of request/reply commands (CONTRACT §2.13, §2.14; wording §4.8.1). They reach
/// the UI, so they say what the user can do and never name the process.
pub const ERR_NOT_RUNNING: &str = "Not available right now. Try again in a moment.";
pub const ERR_NO_ANSWER: &str = "That took too long. Try again.";
/// A command was refused without a reason of its own.
const ERR_COMMAND_FAILED: &str = "Nexum could not do that. Try again.";
/// `reset_sensor_stats` was refused without a reason of its own.
const ERR_RESET_FAILED: &str = "The sensor statistics could not be reset. Try again.";
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

/// `AgentStatus.phase` (CONTRACT §2.3.1). The UI shows something only for `Failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Spawned by app start or by `restart_agent`; no `hello` yet.
    #[default]
    Starting,
    /// `hello` received.
    Running,
    /// It stopped or stopped answering; an automatic restart is pending or under way.
    Restarting,
    /// The restart policy gave up, or the start error cannot be fixed by retrying.
    Failed,
    /// Nexum stopped it on purpose (app exit, installing an update).
    Stopped,
}

/// `AgentStatus.failReason`: why the phase is `failed` (CONTRACT §2.3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailReason {
    /// Windows security (an Application Control policy, antivirus) refused to start it.
    Blocked,
    /// The program file is not there.
    Missing,
    /// It kept exiting.
    Crashed,
    /// It kept hanging.
    NotResponding,
    /// It could not be started (any other start error).
    StartFailed,
}

/// What made the sensor service need a restart (CONTRACT §2.3.1 rule 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// An abnormal exit.
    Exit,
    /// The hang watchdog killed it.
    Hang,
    /// The process could not be spawned.
    SpawnError,
}

/// What the restart policy does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Restart { delay_ms: u64 },
    Fail { reason: FailReason },
}

/// The restart policy (CONTRACT §2.3.1 rules 3 and 4). `n` = automatic restarts since the last
/// healthy run. Restart `n + 1` waits `SENSOR_RESTART_DELAYS_MS[n]`; after
/// `SENSOR_RESTART_MAX` of them the policy gives up with a reason that names the last trigger.
pub fn next_step(n: usize, trigger: Trigger) -> Step {
    match SENSOR_RESTART_DELAYS_MS.get(n) {
        Some(&delay_ms) => Step::Restart { delay_ms },
        None => Step::Fail {
            reason: match trigger {
                Trigger::Hang => FailReason::NotResponding,
                Trigger::SpawnError => FailReason::StartFailed,
                Trigger::Exit => FailReason::Crashed,
            },
        },
    }
}

/// Start errors that retrying cannot fix (CONTRACT §2.3.1 rule 5), by Win32 error code:
/// file or path not found → `Missing`; blocked by Windows security → `Blocked`. `None` for
/// everything else (and for an error without an OS code): those are retried.
pub fn classify_start_error(os_code: Option<i32>) -> Option<FailReason> {
    match os_code? {
        2 | 3 => Some(FailReason::Missing),
        code if crate::util::blocked_by_windows_security(code) => Some(FailReason::Blocked),
        _ => None,
    }
}

/// The restart counter once a process has ended: back to 0 when that process had stayed up
/// for `SENSOR_HEALTHY_RUN_MS` after its `hello` (`healthy_ms` = time since that `hello`,
/// `None` when it never sent one), unchanged otherwise (CONTRACT §2.3.1 rule 2).
pub fn counter_after_run(n: usize, healthy_ms: Option<u64>) -> usize {
    match healthy_ms {
        Some(ms) if ms >= SENSOR_HEALTHY_RUN_MS => 0,
        _ => n,
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub is_admin: bool,
    /// Diagnostic text for logs only: no layer renders it (CONTRACT §2.3).
    pub message: String,
    pub last_packet_ts: Option<u64>,
    pub sensor_driver: Option<SensorDriverStatus>,
    pub limited_reasons: Vec<String>,
    pub missing_features: Vec<String>,
    pub protocol: Option<u64>,
    pub phase: Phase,
    /// Set only while `phase` is `Failed`.
    pub fail_reason: Option<FailReason>,
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
    s.phase = Phase::Running;
    s.fail_reason = None;
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
            "Sensor service version mismatch (protocol {})",
            h.protocol
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    } else {
        match h.pid {
            Some(pid) => format!("Sensor service v{} running (pid {pid})", h.version),
            None => format!("Sensor service v{} running", h.version),
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
    /// One spawn / stop at a time (app start, `restart_agent`, automatic restarts, the updater).
    start_lock: Mutex<()>,
    /// Automatic restarts since the last healthy run (CONTRACT §2.3.1, counter `n`).
    restart_count: AtomicUsize,
    /// `clock`-relative time of the current process's `hello` (0 = none yet).
    hello_ms: AtomicU64,
    /// Generation of the process the hang watchdog killed (0 = none): its exit is a
    /// "stopped answering" trigger, not a crash.
    hang_killed_gen: AtomicU64,
    /// `start` is replacing a running process: that expected exit is not the `stopped` phase.
    replacing: AtomicBool,
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
                message: "Sensor service not started".to_string(),
                ..Default::default()
            }),
            generation: AtomicU64::new(0),
            exited: AtomicBool::new(true),
            expected_exit: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            start_lock: Mutex::new(()),
            restart_count: AtomicUsize::new(0),
            hello_ms: AtomicU64::new(0),
            hang_killed_gen: AtomicU64::new(0),
            replacing: AtomicBool::new(false),
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
            Some(child) if !self.exited.load(Ordering::SeqCst) => {
                child.write(&line).map_err(|e| {
                    // The detail is for the log; the UI gets the plain text.
                    eprintln!("[nexum] could not write to the sensor service: {e}");
                    ERR_NOT_RUNNING.to_string()
                })
            }
            _ => Err(ERR_NOT_RUNNING.to_string()),
        }
    }

    /// Sends a command and blocks (up to `timeout`) for the matching `ack`. An `Err` is always
    /// [`ERR_NOT_RUNNING`] (not running, or it stopped before answering) or [`ERR_NO_ANSWER`]
    /// (timeout). Must be called from a blocking context (never on the async runtime / main
    /// thread).
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
                eprintln!("[nexum] no answer from the sensor service ({cmd})");
                Err(ERR_NO_ANSWER.to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ERR_NOT_RUNNING.to_string()),
        }
    }

    /// Sends `{cmd:"spec"}` and waits (up to `timeout`) for the `spec` line. Callers hold
    /// `spec_lock`, so only one request is in flight.
    pub fn request_spec(&self, timeout: Duration) -> Result<Value, String> {
        use crate::spec::{ERR_SPEC_TIMEOUT as NO_ANSWER, ERR_SPEC_UNAVAILABLE as NOT_RUNNING};
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
    /// not running → [`ERR_NOT_RUNNING`], timeout → [`ERR_NO_ANSWER`], `ok:false` → the
    /// sidecar's message (or `fallback` when it is empty).
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
            // Already one of the two contract texts.
            Err(e) => Err(e),
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
                        ERR_COMMAND_FAILED.to_string()
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

/// Mutates the status and emits `agent-status`, so every phase change is emitted
/// (CONTRACT §2.3.1 rule 7). A phase change also refreshes the tray tooltip (§2.10.5).
fn update_status(app: &AppHandle, f: impl FnOnce(&mut AgentStatus)) {
    let state = app.state::<AppState>();
    let (snapshot, phase_changed) = {
        let mut st = lock(&state.agent.status);
        let before = st.phase;
        f(&mut st);
        // `failReason` exists only in the failed phase.
        if st.phase != Phase::Failed {
            st.fail_reason = None;
        }
        (st.clone(), st.phase != before)
    };
    let _ = app.emit("agent-status", snapshot);
    if phase_changed {
        crate::alerts::request_tooltip(app);
    }
}

/// The status fields of a process that is not running (CONTRACT §2.3: down is not "limited").
fn mark_down(s: &mut AgentStatus, phase: Phase, message: String) {
    s.running = false;
    s.clear_agent_fields();
    s.phase = phase;
    s.message = message;
}

/// Sends the effective poll interval (throttled while in the tray) to the sidecar.
pub fn apply_interval(app: &AppHandle) {
    let ms = settings::effective_poll_ms(app);
    let state = app.state::<AppState>();
    if state.agent.is_running() {
        if let Err(e) = state.agent.send(&json!({ "cmd": "interval", "ms": ms })) {
            eprintln!("[nexum] could not set the poll interval: {e}");
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

/// Starts (or replaces) the sidecar on behalf of the app or the user: app start, `restart_agent`,
/// the update flow giving the sensors back. Phase `starting`. Never panics: failures are
/// reported via `agent-status`.
pub fn start(app: &AppHandle) {
    spawn_process(app, None);
}

/// Spawns the sidecar. `automatic` = `Some(gen)` for a restart the policy scheduled after the
/// process generation `gen` ended: it is dropped when anything else started or stopped the
/// sidecar in the meantime, and the phase stays `restarting` until the new `hello`.
fn spawn_process(app: &AppHandle, automatic: Option<u64>) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    let _one_at_a_time = lock(&mgr.start_lock);
    if mgr.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    if let Some(expected) = automatic {
        if mgr.generation.load(Ordering::SeqCst) != expected || lock(&mgr.child).is_some() {
            return;
        }
    }

    // Stop a previous instance (if any) before spawning the new one.
    if lock(&mgr.child).is_some() {
        mgr.replacing.store(true, Ordering::SeqCst);
        stop_current(app, SHUTDOWN_GRACE);
        mgr.replacing.store(false, Ordering::SeqCst);
    }

    let gen = mgr.generation.fetch_add(1, Ordering::SeqCst) + 1;
    mgr.expected_exit.store(false, Ordering::SeqCst);
    mgr.hello_ms.store(0, Ordering::SeqCst);
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
            // The sidecar path cannot be resolved at all: retrying cannot fix that.
            eprintln!("[nexum] the sensor service cannot be located: {e}");
            mgr.exited.store(true, Ordering::SeqCst);
            mgr.child_pid.store(0, Ordering::SeqCst);
            apply_step(
                app,
                gen,
                Step::Fail {
                    reason: FailReason::Missing,
                },
                "it cannot be located",
            );
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
            let phase = if automatic.is_some() {
                Phase::Restarting
            } else {
                Phase::Starting
            };
            update_status(app, |s| {
                s.running = true;
                s.clear_agent_fields();
                s.phase = phase;
                s.message = "Sensor service starting".to_string();
            });
            spawn_reader(app.clone(), rx, gen);
        }
        Err(e) => {
            mgr.exited.store(true, Ordering::SeqCst);
            mgr.child_pid.store(0, Ordering::SeqCst);
            let os_code = match &e {
                tauri_plugin_shell::Error::Io(io) => io.raw_os_error(),
                _ => None,
            };
            eprintln!("[nexum] could not start the sensor service: {e}");
            // CONTRACT §2.3.1 rule 5: "missing" and "blocked" go straight to failed and leave
            // the counter alone; any other start error is retried like a crash.
            let step = match classify_start_error(os_code) {
                Some(reason) => Step::Fail { reason },
                None => next_step(
                    mgr.restart_count.load(Ordering::SeqCst),
                    Trigger::SpawnError,
                ),
            };
            apply_step(app, gen, step, "it could not be started");
        }
    }
}

/// Carries out a policy step for the process generation `gen` that just ended or failed to
/// start: schedule the next automatic restart (counting it), or give up.
fn apply_step(app: &AppHandle, gen: u64, step: Step, detail: &str) {
    match step {
        Step::Fail { reason } => {
            update_status(app, |s| {
                mark_down(
                    s,
                    Phase::Failed,
                    format!("Sensor service gave up: {detail}"),
                );
                s.fail_reason = Some(reason);
            });
        }
        Step::Restart { delay_ms } => {
            app.state::<AppState>()
                .agent
                .restart_count
                .fetch_add(1, Ordering::SeqCst);
            update_status(app, |s| {
                mark_down(
                    s,
                    Phase::Restarting,
                    format!("Sensor service stopped ({detail}); restarting in {delay_ms} ms"),
                );
            });
            schedule_restart(app, gen, Duration::from_millis(delay_ms));
        }
    }
}

/// Starts the sidecar again after `delay`, unless something else started or stopped it first
/// (`gen` is the generation that ended).
fn schedule_restart(app: &AppHandle, gen: u64, delay: Duration) {
    let worker = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-sensor-restart".into())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            spawn_process(&worker, Some(gen));
        });
    if let Err(e) = spawned {
        eprintln!("[nexum] could not schedule the sensor service restart: {e}");
        update_status(app, |s| {
            mark_down(
                s,
                Phase::Failed,
                "Sensor service restart could not be scheduled".to_string(),
            );
            s.fail_reason = Some(FailReason::StartFailed);
        });
    }
}

/// What every end of a sidecar process clears, whether it exited by itself or was stopped.
fn cleanup_after_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    mgr.fail_all_waiters(ERR_NOT_RUNNING);
    *lock(&mgr.sensor_tree) = None;
    *lock(&mgr.stream_sent) = None;
    *lock(&state.latest_values) = None;
    crate::frames::clear(app);
    crate::tuning::clear(app);
    crate::alerts::on_agent_down(app);
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
                    eprintln!("[nexum] sensor service pipe error: {err}");
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
            eprintln!("[nexum] discarding an oversized sensor service output fragment");
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
                "[nexum] unparseable sensor service line ({e}): {}",
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
                    if st.message.is_empty() || st.message.starts_with("Sensor service starting") {
                        st.message = "Sensor service running".to_string();
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
                    "[nexum] warning: the sensor service speaks protocol {:?}, expected {AGENT_PROTOCOL}",
                    hello.protocol
                );
            }
            // The healthy-run clock of CONTRACT §2.3.1 rule 2 starts at the `hello`.
            state
                .agent
                .hello_ms
                .store(state.agent.elapsed_ms().max(1), Ordering::SeqCst);
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
                .unwrap_or("Unknown error")
                .to_string();
            eprintln!("[nexum-agent] error: {message}");
            update_status(app, |s| {
                s.message = format!("Sensor service reported: {message}");
            });
        }
        other => {
            eprintln!("[nexum] ignoring sensor service message type '{other}'");
        }
    }
}

fn handle_exit(app: &AppHandle, gen: u64, code: Option<i32>) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    // The pid first: `stop` reads it after it has seen `exited`.
    mgr.child_pid.store(0, Ordering::SeqCst);
    mgr.exited.store(true, Ordering::SeqCst);
    // The process is gone; drop the handle (kill_on_drop on a dead process is harmless).
    let dead = lock(&mgr.child).take();
    drop(dead);
    // How long this process had been healthy (time since its `hello`), if it ever said hello.
    let healthy_ms = match mgr.hello_ms.swap(0, Ordering::SeqCst) {
        0 => None,
        at => Some(mgr.elapsed_ms().saturating_sub(at)),
    };
    cleanup_after_exit(app);

    let code_text = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());

    if mgr.shutting_down.load(Ordering::SeqCst) || mgr.expected_exit.load(Ordering::SeqCst) {
        // Stopped on purpose. While `start` is replacing the process the phase is left alone
        // (it is `starting`, and the UI's "Try again" waits for it to change).
        let replacing = mgr.replacing.load(Ordering::SeqCst);
        update_status(app, |s| {
            let phase = if replacing { s.phase } else { Phase::Stopped };
            mark_down(s, phase, "Sensor service stopped".to_string());
        });
        return;
    }

    // Abnormal exit (crash, kill, hang). With the fan write-ahead flag present, fans may be
    // stuck at a manual duty: warn, and restart at once so the new process latches them at 100%.
    let flag = failsafe::flag_exists();
    failsafe::update(app, |t, now| t.on_abnormal_exit(flag, now));
    let immediate = flag && !mgr.immediate_restart_used.swap(true, Ordering::SeqCst);

    let trigger = if mgr.hang_killed_gen.load(Ordering::SeqCst) == gen {
        Trigger::Hang
    } else {
        Trigger::Exit
    };
    // CONTRACT §2.3.1 rule 2: a process that stayed up long enough starts a fresh count.
    let n = counter_after_run(mgr.restart_count.load(Ordering::SeqCst), healthy_ms);
    mgr.restart_count.store(n, Ordering::SeqCst);

    if immediate {
        // MF-13 (CONTRACT §2.4 item 1): one restart without delay, not counted (§2.3.1 rule 6).
        update_status(app, |s| {
            mark_down(
                s,
                Phase::Restarting,
                format!("Sensor service stopped (exit code {code_text}); restarting now"),
            );
        });
        schedule_restart(app, gen, Duration::ZERO);
        return;
    }

    let detail = match trigger {
        Trigger::Hang => "it stopped answering".to_string(),
        _ => format!("exit code {code_text}"),
    };
    apply_step(app, gen, next_step(n, trigger), &detail);
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

/// Starts the hang watchdog (CONTRACT §2.4 item 2): a sidecar that stops writing lines is
/// killed, which the reader then handles as an abnormal exit (restart policy + fail-safe
/// check). The same tick resets the restart counter after a healthy run (§2.3.1 rule 2).
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
                // suspended (sleep/hibernate): the sidecar was frozen too, not hung. Start over.
                let gap = last_tick.elapsed();
                last_tick = Instant::now();
                if gap > WATCHDOG_TICK * 5 {
                    mgr.touch();
                    continue;
                }
                if !mgr.is_running() || mgr.expected_exit.load(Ordering::SeqCst) {
                    continue;
                }
                // Up for long enough after its `hello`: the next failure starts a fresh count.
                let hello_at = mgr.hello_ms.load(Ordering::SeqCst);
                if hello_at != 0
                    && mgr.elapsed_ms().saturating_sub(hello_at) >= SENSOR_HEALTHY_RUN_MS
                    && mgr.restart_count.load(Ordering::SeqCst) != 0
                {
                    mgr.restart_count.store(0, Ordering::SeqCst);
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
                eprintln!("[nexum] the sensor service sent nothing for {idle} ms; restarting it");
                // The exit that follows is a "stopped answering" trigger (§2.3.1 rule 4).
                mgr.hang_killed_gen
                    .store(mgr.generation.load(Ordering::SeqCst), Ordering::SeqCst);
                // Taking the child stops further writes; the reader sees `Terminated` and runs
                // the abnormal-exit path (expected_exit stays false).
                let child = lock(&mgr.child).take();
                if let Some(child) = child {
                    if let Err(e) = child.kill() {
                        eprintln!("[nexum] could not kill the hung sensor service: {e}");
                    }
                }
                mgr.touch();
            }
        });
    if let Err(e) = spawned {
        eprintln!("[nexum] sensor service watchdog unavailable: {e}");
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
                eprintln!("[nexum] could not kill the sensor service: {e}");
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

/// Stops the sidecar on purpose while Nexum keeps running (CONTRACT §2.15.5 step 5: before
/// the update installer starts). Same graceful `shutdown` as on Quit (fans go back to BIOS
/// control, frame capture stops), phase `stopped`, and any pending automatic restart is
/// cancelled. [`start`] brings it back. Blocking (up to the shutdown grace).
pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mgr = &state.agent;
    let _one_at_a_time = lock(&mgr.start_lock);
    if mgr.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    stop_current(app, SHUTDOWN_GRACE);
    // Late events of this process and a scheduled automatic restart are for an old generation.
    mgr.generation.fetch_add(1, Ordering::SeqCst);
    mgr.hello_ms.store(0, Ordering::SeqCst);
    if mgr.child_pid.swap(0, Ordering::SeqCst) != 0 {
        // It had to be killed, so the reader's exit path will be ignored: clean up here.
        cleanup_after_exit(app);
    }
    update_status(app, |s| {
        mark_down(s, Phase::Stopped, "Sensor service stopped".to_string());
    });
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_agent_status(app: AppHandle) -> Result<AgentStatus, String> {
    Ok(app.state::<AppState>().agent.status())
}

/// `restart_agent` (the banner's "Try again" and Settings › Sensors): the restart counter goes
/// back to 0 and the phase to `starting` (CONTRACT §2.3.1 rule 8), then a normal start.
#[tauri::command]
pub async fn restart_agent(app: AppHandle) -> Result<(), String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        if state.agent.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        state.agent.restart_count.store(0, Ordering::SeqCst);
        update_status(&worker, |s| {
            s.phase = Phase::Starting;
            s.message = "Sensor service restart requested".to_string();
        });
        start(&worker);
    })
    .await
    .map_err(|e| {
        eprintln!("[nexum] restart worker failed: {e}");
        ERR_NOT_RUNNING.to_string()
    })
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
        Err(ERR_RESET_FAILED.to_string())
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
        assert_eq!(s.message, "Sensor service v1.1.0 running (pid 42)");
        assert_eq!(s.phase, Phase::Running);
        assert_eq!(s.fail_reason, None);
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["phase"], "running");
        assert!(j["failReason"].is_null());
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
        assert_eq!(s.message, "Sensor service version mismatch (protocol unknown)");
        let h = parse_hello(&json!({ "type": "hello", "version": "1.0.0", "protocol": 2, "isAdmin": true, "sensorDriver": driver(None) }));
        apply_hello(&mut s, &h);
        assert_eq!(s.message, "Sensor service version mismatch (protocol 2)");
        assert!(s.limited_reasons.is_empty());

        s.clear_agent_fields();
        let j = serde_json::to_value(&s).unwrap();
        assert!(j["sensorDriver"].is_null());
        assert_eq!(j["limitedReasons"], json!([]));
        assert_eq!(j["missingFeatures"], json!([]));
        assert!(j["protocol"].is_null());
    }

    #[test]
    fn restart_backoff_schedule() {
        // CONTRACT §2.3.1 rule 3: restarts 1..5 wait 1, 2, 4, 8 and 15 s, whatever the trigger.
        assert_eq!(SENSOR_RESTART_DELAYS_MS, [1_000, 2_000, 4_000, 8_000, 15_000]);
        assert_eq!(SENSOR_RESTART_DELAYS_MS.len(), SENSOR_RESTART_MAX);
        for trigger in [Trigger::Exit, Trigger::Hang, Trigger::SpawnError] {
            for (n, delay_ms) in SENSOR_RESTART_DELAYS_MS.iter().copied().enumerate() {
                assert_eq!(next_step(n, trigger), Step::Restart { delay_ms });
            }
        }
        // 30 s of delays in total before the policy gives up.
        assert_eq!(SENSOR_RESTART_DELAYS_MS.iter().sum::<u64>(), 30_000);

        // Rule 4: the sixth trigger gives up, and the reason names that trigger.
        let fail = |t| match next_step(SENSOR_RESTART_MAX, t) {
            Step::Fail { reason } => reason,
            other => panic!("expected the policy to give up, got {other:?}"),
        };
        assert_eq!(fail(Trigger::Exit), FailReason::Crashed);
        assert_eq!(fail(Trigger::Hang), FailReason::NotResponding);
        assert_eq!(fail(Trigger::SpawnError), FailReason::StartFailed);
        // A counter beyond the maximum never restarts either (the policy is bounded).
        assert!(matches!(
            next_step(SENSOR_RESTART_MAX + 7, Trigger::Exit),
            Step::Fail { .. }
        ));
        assert!(matches!(next_step(usize::MAX, Trigger::Hang), Step::Fail { .. }));
    }

    #[test]
    fn a_process_that_dies_at_once_ends_in_failed_after_five_restarts() {
        // Simulates the loop the 1.1 rolling window could not end: every start crashes.
        let mut n = 0usize;
        let mut restarts = 0;
        let reason = loop {
            match next_step(n, Trigger::Exit) {
                Step::Restart { .. } => {
                    restarts += 1;
                    n += 1;
                    // The new process dies before a healthy run: the count is kept.
                    n = counter_after_run(n, Some(9_000));
                }
                Step::Fail { reason } => break reason,
            }
            assert!(restarts <= SENSOR_RESTART_MAX, "the policy must be bounded");
        };
        assert_eq!(restarts, SENSOR_RESTART_MAX);
        assert_eq!(reason, FailReason::Crashed);
    }

    #[test]
    fn healthy_run_resets_the_restart_counter() {
        assert_eq!(counter_after_run(4, None), 4, "it never said hello");
        assert_eq!(counter_after_run(4, Some(0)), 4);
        assert_eq!(counter_after_run(4, Some(SENSOR_HEALTHY_RUN_MS - 1)), 4);
        assert_eq!(counter_after_run(4, Some(SENSOR_HEALTHY_RUN_MS)), 0);
        assert_eq!(counter_after_run(5, Some(3_600_000)), 0);
        assert_eq!(counter_after_run(0, Some(1)), 0);
        // After the reset the schedule starts again at 1 s.
        assert_eq!(
            next_step(counter_after_run(5, Some(SENSOR_HEALTHY_RUN_MS)), Trigger::Exit),
            Step::Restart { delay_ms: 1_000 }
        );
    }

    #[test]
    fn start_errors_that_retrying_cannot_fix() {
        // File or path not found.
        assert_eq!(classify_start_error(Some(2)), Some(FailReason::Missing));
        assert_eq!(classify_start_error(Some(3)), Some(FailReason::Missing));
        // Blocked by an Application Control policy (Smart App Control), by policy, by antivirus.
        for code in [4551, 1260, 225, 226] {
            assert_eq!(classify_start_error(Some(code)), Some(FailReason::Blocked));
        }
        // Everything else is retried like any other trigger.
        assert_eq!(classify_start_error(Some(5)), None, "access denied");
        assert_eq!(classify_start_error(Some(8)), None, "out of memory");
        assert_eq!(classify_start_error(Some(740)), None, "elevation required");
        assert_eq!(classify_start_error(Some(0)), None);
        assert_eq!(classify_start_error(None), None, "no OS code");
    }

    #[test]
    fn phase_and_fail_reason_wire_names() {
        let phases = [
            (Phase::Starting, "starting"),
            (Phase::Running, "running"),
            (Phase::Restarting, "restarting"),
            (Phase::Failed, "failed"),
            (Phase::Stopped, "stopped"),
        ];
        for (p, name) in phases {
            assert_eq!(serde_json::to_value(p).unwrap(), json!(name));
        }
        let reasons = [
            (FailReason::Blocked, "blocked"),
            (FailReason::Missing, "missing"),
            (FailReason::Crashed, "crashed"),
            (FailReason::NotResponding, "notResponding"),
            (FailReason::StartFailed, "startFailed"),
        ];
        for (r, name) in reasons {
            assert_eq!(serde_json::to_value(r).unwrap(), json!(name));
        }
        // Before anything started: `starting`, not running, no reason.
        let j = serde_json::to_value(AgentManager::default().status()).unwrap();
        assert_eq!(j["phase"], "starting");
        assert_eq!(j["running"], false);
        assert!(j["failReason"].is_null());

        let mut s = AgentStatus::default();
        mark_down(&mut s, Phase::Failed, "x".into());
        s.fail_reason = Some(FailReason::Blocked);
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["phase"], "failed");
        assert_eq!(j["failReason"], "blocked");
        assert_eq!(j["running"], false);
        assert_eq!(j["limitedReasons"], json!([]));
    }

    #[test]
    fn user_visible_texts_never_name_the_process() {
        // CONTRACT §4.8.1: these reach toasts and inline errors.
        let texts = [
            ERR_NOT_RUNNING,
            ERR_NO_ANSWER,
            ERR_COMMAND_FAILED,
            ERR_RESET_FAILED,
            crate::spec::ERR_SPEC_UNAVAILABLE,
            crate::spec::ERR_SPEC_TIMEOUT,
            failsafe::MSG_AGENT_LOST,
        ];
        for t in texts {
            let lower = t.to_lowercase();
            assert!(
                !lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == "agent" || w == "agents"),
                "{t}"
            );
        }
        assert_eq!(ERR_NOT_RUNNING, "Not available right now. Try again in a moment.");
        assert_eq!(ERR_NO_ANSWER, "That took too long. Try again.");
        assert_eq!(ERR_COMMAND_FAILED, "Nexum could not do that. Try again.");
        assert_eq!(
            ERR_RESET_FAILED,
            "The sensor statistics could not be reset. Try again."
        );
        // A caller that was waiting when the process ended gets the same plain text.
        let mgr = AgentManager::default();
        let (tx, rx) = mpsc::channel();
        lock(&mgr.waiters).push(AckWaiter {
            id: 1,
            cmd: "fanPreset".into(),
            tx,
        });
        mgr.fail_all_waiters(ERR_NOT_RUNNING);
        let ack = rx.try_recv().unwrap();
        assert!(!ack.ok);
        assert_eq!(ack.message, ERR_NOT_RUNNING);
        // Nothing is running in a fresh manager: every request path says so in plain words.
        assert_eq!(mgr.send(&json!({ "cmd": "interval", "ms": 1000 })), Err(ERR_NOT_RUNNING.to_string()));
        assert_eq!(
            mgr.request_ack_checked(&json!({}), "x", Duration::from_millis(1), "fallback")
                .unwrap_err(),
            ERR_NOT_RUNNING
        );
        assert_eq!(
            mgr.request_reply(&json!({}), "tuningState", "tuningGet", Duration::from_millis(1))
                .unwrap_err(),
            ERR_NOT_RUNNING
        );
        assert_eq!(
            mgr.request_spec(Duration::from_millis(1)).unwrap_err(),
            crate::spec::ERR_SPEC_UNAVAILABLE
        );
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
