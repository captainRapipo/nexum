//! `self-usage` event (CONTRACT §2.5): CPU and memory used by Nexum itself — Nexum.exe, the
//! `nexum-agent` sidecar and the WebView2 processes started for Nexum's window.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::procs::{self, ProcEntry};
use crate::state::AppState;
use crate::util::now_ms;

const INTERVAL: Duration = Duration::from_secs(5);
/// Parent-chain walk limit (guards against cycles from reused process ids).
const MAX_CHAIN: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelfUsage {
    pub ts: u64,
    pub cpu_pct: f64,
    pub working_set_mb: u64,
    pub process_count: u32,
}

/// The process ids that make up Nexum: `root` (own pid), the agent, any `nexum-agent*.exe`
/// child, and every `msedgewebview2.exe` whose parent chain reaches `root`.
pub fn select_processes(entries: &[ProcEntry], root: u32, agent_pid: Option<u32>) -> Vec<u32> {
    let parent: HashMap<u32, u32> = entries.iter().map(|e| (e.pid, e.ppid)).collect();
    let leads_to_root = |start: u32| -> bool {
        let mut cur = start;
        for _ in 0..MAX_CHAIN {
            match parent.get(&cur) {
                Some(&p) if p == root => return true,
                Some(&p) if p != 0 && p != cur => cur = p,
                _ => return false,
            }
        }
        false
    };
    let mut out: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut push = |pid: u32, out: &mut Vec<u32>| {
        if seen.insert(pid) {
            out.push(pid);
        }
    };
    if entries.iter().any(|e| e.pid == root) {
        push(root, &mut out);
    }
    if let Some(a) = agent_pid.filter(|a| *a != 0) {
        if entries.iter().any(|e| e.pid == a) {
            push(a, &mut out);
        }
    }
    for e in entries {
        let name = e.name.to_ascii_lowercase();
        let wanted = name == "msedgewebview2.exe"
            || (name.starts_with("nexum-agent") && name.ends_with(".exe"));
        if wanted && e.pid != root && leads_to_root(e.pid) {
            push(e.pid, &mut out);
        }
    }
    out
}

/// One measurement: wall time (FILETIME units) and per-process counters keyed by
/// (pid, creation time) so a reused pid is never mistaken for the same process.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub wall: u64,
    pub cpu: HashMap<(u32, u64), u64>,
    pub working_set: u64,
    pub count: u32,
}

/// CPU share of the whole machine between two samples, in percent (0–100, 1 decimal).
pub fn cpu_pct(prev: &Sample, cur: &Sample, logical: u32) -> f64 {
    let dwall = cur.wall.saturating_sub(prev.wall);
    if dwall == 0 || logical == 0 {
        return 0.0;
    }
    let mut used: u64 = 0;
    for (key, &cpu) in &cur.cpu {
        match prev.cpu.get(key) {
            Some(&before) => used += cpu.saturating_sub(before),
            // Started after the previous sample: all of its CPU time is new.
            None if key.1 >= prev.wall => used += cpu,
            None => {}
        }
    }
    let pct = used as f64 / (dwall as f64 * logical as f64) * 100.0;
    ((pct.clamp(0.0, 100.0)) * 10.0).round() / 10.0
}

fn take_sample(agent_pid: Option<u32>) -> Sample {
    let entries = procs::snapshot();
    let pids = select_processes(&entries, std::process::id(), agent_pid);
    let mut s = Sample {
        wall: procs::now_filetime(),
        ..Default::default()
    };
    for pid in pids {
        if let Some(t) = procs::process_times(pid) {
            s.cpu.insert((pid, t.creation), t.cpu);
            s.working_set += t.working_set;
            s.count += 1;
        }
    }
    s
}

fn to_event(prev: &Sample, cur: &Sample, logical: u32) -> SelfUsage {
    SelfUsage {
        ts: now_ms(),
        cpu_pct: cpu_pct(prev, cur, logical),
        working_set_mb: ((cur.working_set as f64) / 1_048_576.0).round() as u64,
        process_count: cur.count,
    }
}

/// Starts the sampler thread: one event every 5 s while the window is visible.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-self-usage".into())
        .spawn(move || {
            let logical = procs::logical_processors();
            let agent_pid = |app: &AppHandle| app.state::<AppState>().agent.agent_pid();
            let mut prev = Some(take_sample(agent_pid(&app)));
            loop {
                std::thread::sleep(INTERVAL);
                let state = app.state::<AppState>();
                if state.quitting.load(Ordering::SeqCst) {
                    break;
                }
                if state.in_tray.load(Ordering::SeqCst) {
                    // Paused while hidden; the next visible sample starts a new baseline.
                    prev = None;
                    continue;
                }
                let cur = take_sample(agent_pid(&app));
                if let Some(p) = &prev {
                    let _ = app.emit("self-usage", to_event(p, &cur, logical));
                }
                prev = Some(cur);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[nexum] self-usage sampler unavailable: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, name: &str) -> ProcEntry {
        ProcEntry {
            pid,
            ppid,
            name: name.into(),
        }
    }

    #[test]
    fn process_set_follows_the_parent_chain() {
        let entries = vec![
            e(4, 0, "System"),
            e(100, 4, "explorer.exe"),
            e(200, 100, "Nexum.exe"),
            e(300, 200, "nexum-agent.exe"),
            e(400, 200, "msedgewebview2.exe"),
            e(401, 400, "msedgewebview2.exe"),
            e(402, 401, "msedgewebview2.exe"),
            // Another app's WebView2 — must not be counted.
            e(500, 100, "Teams.exe"),
            e(501, 500, "msedgewebview2.exe"),
            // Not a WebView2 process, even though it is our child.
            e(600, 200, "conhost.exe"),
        ];
        let mut set = select_processes(&entries, 200, Some(300));
        set.sort_unstable();
        assert_eq!(set, vec![200, 300, 400, 401, 402]);
        // Agent pid unknown: still found as a nexum-agent child.
        let mut set = select_processes(&entries, 200, None);
        set.sort_unstable();
        assert_eq!(set, vec![200, 300, 400, 401, 402]);
    }

    #[test]
    fn parent_cycles_terminate() {
        let entries = vec![
            e(200, 0, "Nexum.exe"),
            e(10, 11, "msedgewebview2.exe"),
            e(11, 10, "msedgewebview2.exe"),
        ];
        assert_eq!(select_processes(&entries, 200, None), vec![200]);
    }

    #[test]
    fn cpu_percentage_formula() {
        let mut prev = Sample {
            wall: 1_000_000_000,
            ..Default::default()
        };
        prev.cpu.insert((1, 10), 1_000);
        prev.cpu.insert((2, 10), 5_000);
        let mut cur = Sample {
            wall: prev.wall + 50_000_000, // 5 s
            ..Default::default()
        };
        // pid 1 used 0.5 s, pid 2 used 1.5 s, pid 3 started after the baseline with 1 s.
        cur.cpu.insert((1, 10), 1_000 + 5_000_000);
        cur.cpu.insert((2, 10), 5_000 + 15_000_000);
        cur.cpu.insert((3, prev.wall + 1), 10_000_000);
        // A reused pid 2 with an older creation time than the baseline is ignored.
        cur.cpu.insert((4, 5), 99_000_000);
        // 3 s of CPU in 5 s on 8 logical processors = 7.5 %.
        assert_eq!(cpu_pct(&prev, &cur, 8), 7.5);
        assert_eq!(cpu_pct(&prev, &cur, 0), 0.0);
        assert_eq!(cpu_pct(&cur, &prev, 8), 0.0);
    }

    #[test]
    fn live_sample_counts_this_process() {
        let s = take_sample(None);
        assert!(s.count >= 1);
        assert!(s.working_set > 0);
    }
}
