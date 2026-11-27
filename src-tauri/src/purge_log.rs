//! Cleanup audit log (CONTRACT §3 rule 11): one JSONL file per purge under
//! `%LOCALAPPDATA%\Nexum\purge-logs\<YYYYMMDD-HHMMSS>.jsonl`.
//!
//! The folder lives in the user's profile, where any non-elevated process can plant links, so
//! it is created and opened through [`crate::safe_fs::PinnedDir`]: never through a junction,
//! mount point or symbolic link, and only inside the user's profile.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::safe_fs::PinnedDir;

/// `(user profile, %LOCALAPPDATA%\Nexum\purge-logs)`. LocalAppData must lie inside the
/// profile (it is per-user redirectable; see [`crate::cleaner::within_profile`]).
fn default_location() -> io::Result<(PathBuf, PathBuf)> {
    use windows::Win32::UI::Shell::FOLDERID_Profile;
    let profile = crate::util::known_folder(&FOLDERID_Profile).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "the user profile folder is unavailable",
        )
    })?;
    let local = crate::cleaner::within_profile(crate::util::local_appdata_dir(), Some(&profile))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the local application data folder is not inside the user profile",
            )
        })?;
    Ok((profile, local.join("Nexum").join("purge-logs")))
}

/// Strips the `\\?\` verbatim prefix for readability.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    }
}

pub struct PurgeLog {
    path: PathBuf,
    out: BufWriter<File>,
    write_failed: bool,
}

impl PurgeLog {
    /// Creates this purge's log in `%LOCALAPPDATA%\Nexum\purge-logs`.
    pub fn create_default(stamp: &str) -> io::Result<Self> {
        let (profile, dir) = default_location()?;
        Self::create(&profile, &dir, stamp)
    }

    /// Creates `<dir>\<stamp>.jsonl` (or `<stamp>-N.jsonl` if that name is taken). `dir` must
    /// lie strictly inside `base`; every folder below `base` is created/opened without
    /// following links and verified (see [`PinnedDir`]), and the new file's final path is
    /// verified too, so the elevated app never writes through a link a standard user planted.
    pub fn create(base: &Path, dir: &Path, stamp: &str) -> io::Result<Self> {
        let pinned = PinnedDir::open(base, dir, true)?;
        for n in 0..100u32 {
            let name = if n == 0 {
                format!("{stamp}.jsonl")
            } else {
                format!("{stamp}-{n}.jsonl")
            };
            match pinned.create_new_file(&name) {
                Ok((file, path)) => {
                    return Ok(Self {
                        path,
                        out: BufWriter::new(file),
                        write_failed: false,
                    })
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "too many logs with the same timestamp",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn line(&mut self, v: &Value) {
        if self.write_failed {
            return;
        }
        let r = serde_json::to_writer(&mut self.out, v)
            .map_err(std::io::Error::from)
            .and_then(|_| self.out.write_all(b"\n"));
        if let Err(e) = r {
            eprintln!("[nexum] cleanup log write failed: {e}");
            self.write_failed = true;
        }
    }

    pub fn header(&mut self, version: &str, started_ts: u64, is_admin: bool, categories: &[&str]) {
        self.line(&json!({
            "type": "header",
            "version": version,
            "startedTs": started_ts,
            "isAdmin": is_admin,
            "categories": categories,
        }));
    }

    #[allow(clippy::too_many_arguments)]
    pub fn file(
        &mut self,
        category_id: &str,
        path: &Path,
        bytes: u64,
        mtime: Option<u64>,
        result: &str,
        reason: Option<&str>,
    ) {
        self.line(&json!({
            "type": "file",
            "categoryId": category_id,
            "path": display_path(path),
            "bytes": bytes,
            "mtime": mtime,
            "result": result,
            "reason": reason,
        }));
    }

    pub fn action(
        &mut self,
        category_id: &str,
        action: &str,
        result: &str,
        freed_bytes: u64,
        message: &str,
    ) {
        self.line(&json!({
            "type": "action",
            "categoryId": category_id,
            "action": action,
            "result": result,
            "freedBytes": freed_bytes,
            "message": message,
        }));
    }

    /// Last line: the purge result without `logPath`.
    pub fn summary(&mut self, mut result: Value) {
        if let Value::Object(map) = &mut result {
            map.remove("logPath");
            map.insert("type".into(), Value::String("summary".into()));
        }
        self.line(&result);
    }

    pub fn finish(mut self) {
        if let Err(e) = self.out.flush() {
            eprintln!("[nexum] cleanup log flush failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_jsonl_lines() {
        let base = std::env::temp_dir().join(format!(
            "nexum-test-log-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join("Nexum").join("purge-logs");
        let mut log = PurgeLog::create(&base, &dir, "20261127-120000").unwrap();
        let second = PurgeLog::create(&base, &dir, "20261127-120000").unwrap();
        assert!(second.path().ends_with("20261127-120000-1.jsonl"));
        second.finish();
        log.header("1.0.0", 1, true, &["temp"]);
        log.file(
            "temp",
            Path::new(r"\\?\C:\Windows\Temp\a.tmp"),
            12,
            Some(5),
            "deleted",
            None,
        );
        log.action("wu-cache", "Delete-DeliveryOptimizationCache", "ok", 10, "done");
        log.summary(json!({ "freedBytes": 12, "logPath": "x" }));
        let path = log.path().to_path_buf();
        log.finish();
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["type"], "header");
        assert_eq!(lines[1]["path"], r"C:\Windows\Temp\a.tmp");
        assert!(lines[1]["reason"].is_null());
        assert_eq!(lines[2]["action"], "Delete-DeliveryOptimizationCache");
        assert_eq!(lines[3]["type"], "summary");
        assert!(lines[3].get("logPath").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn log_never_follows_a_planted_junction() {
        let stamp = crate::util::now_ms();
        let base = std::env::temp_dir().join(format!("nexum-test-logj-{}-{stamp}", std::process::id()));
        let target = std::env::temp_dir().join(format!("nexum-test-logt-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        // A standard user replaces %LOCALAPPDATA%\Nexum with a junction to a folder they
        // cannot write to themselves.
        let ok = crate::util::hidden_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(base.join("Nexum"))
            .arg(&target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "could not create junction");
        let dir = base.join("Nexum").join("purge-logs");
        assert!(PurgeLog::create(&base, &dir, "20261127-120000").is_err());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
        // A log folder outside the trusted base is refused.
        assert!(PurgeLog::create(&base, &target.join("logs"), "20261127-120000").is_err());
        assert!(!target.join("logs").exists());
        let _ = std::fs::remove_dir(base.join("Nexum"));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn default_location_is_inside_the_profile() {
        if let Ok((profile, dir)) = default_location() {
            let p = crate::cleaner::norm_path(&profile);
            let d = crate::cleaner::norm_path(&dir);
            assert!(d.starts_with(&format!("{p}\\")), "{d} not under {p}");
            assert!(d.ends_with(r"\nexum\purge-logs"), "{d}");
        }
    }
}
