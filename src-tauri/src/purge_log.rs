//! Cleanup audit log (CONTRACT §3 rule 11): one JSONL file per purge under
//! `%LOCALAPPDATA%\Nexum\purge-logs\<YYYYMMDD-HHMMSS>.jsonl`.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// `%LOCALAPPDATA%\Nexum\purge-logs`.
pub fn log_dir() -> Option<PathBuf> {
    crate::util::local_appdata_dir().map(|d| d.join("Nexum").join("purge-logs"))
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

fn is_link(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & 0x400 != 0)
        .unwrap_or(false)
}

pub struct PurgeLog {
    path: PathBuf,
    out: BufWriter<File>,
    write_failed: bool,
}

impl PurgeLog {
    /// Creates `<dir>\<stamp>.jsonl` (or `<stamp>-N.jsonl` if that name is taken). Refuses a log
    /// folder that is (or sits under) a link, so the elevated app never writes through a
    /// junction a standard user planted in their own profile.
    pub fn create(dir: &Path, stamp: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let parent_link = dir.parent().is_some_and(is_link);
        if is_link(dir) || parent_link {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "the log folder is a link",
            ));
        }
        for n in 0..100u32 {
            let name = if n == 0 {
                format!("{stamp}.jsonl")
            } else {
                format!("{stamp}-{n}.jsonl")
            };
            let path = dir.join(name);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        out: BufWriter::new(file),
                        write_failed: false,
                    })
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
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
        let dir = std::env::temp_dir().join(format!(
            "nexum-test-log-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        let mut log = PurgeLog::create(&dir, "20261127-120000").unwrap();
        let second = PurgeLog::create(&dir, "20261127-120000").unwrap();
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
        let _ = std::fs::remove_dir_all(&dir);
    }
}
