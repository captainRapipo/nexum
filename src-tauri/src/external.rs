//! `open_external`: opens http(s) URLs in the default browser and folders in Explorer.
//! Anything else is rejected. Files are revealed (selected) in Explorer, never executed.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use crate::util::{hidden_command, windows_dir};

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Url(String),
    Folder(PathBuf),
    File(PathBuf),
}

fn is_safe_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("https://") {
        r
    } else if let Some(r) = lower.strip_prefix("http://") {
        r
    } else {
        return false;
    };
    !rest.is_empty()
        && s.len() <= 2048
        && !s.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || c == '"'
                || c == '<'
                || c == '>'
                || c == '^'
                || c == '`'
        })
}

/// Validates and classifies a target string.
pub fn classify(target: &str) -> Result<Target, String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("Nothing to open".to_string());
    }
    if t.to_ascii_lowercase().starts_with("http://")
        || t.to_ascii_lowercase().starts_with("https://")
    {
        return if is_safe_url(t) {
            Ok(Target::Url(t.to_string()))
        } else {
            Err("Refusing to open a malformed URL".to_string())
        };
    }
    if t.contains('"') || t.chars().any(char::is_control) {
        return Err("Invalid path".to_string());
    }
    let p = Path::new(t);
    if !p.is_absolute() {
        return Err("Only http(s) URLs or absolute folder paths can be opened".to_string());
    }
    // Local drive paths only: no UNC shares (probing one from an elevated process leaks
    // credentials to the remote host) and no `\\?\` / `\\.\` device namespaces.
    let b = t.as_bytes();
    if !(b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/'))
    {
        return Err("Only local folder paths can be opened".to_string());
    }
    let md = std::fs::metadata(p).map_err(|_| format!("Path does not exist: {t}"))?;
    if md.is_dir() {
        Ok(Target::Folder(p.to_path_buf()))
    } else if md.is_file() {
        Ok(Target::File(p.to_path_buf()))
    } else {
        Err("Unsupported target".to_string())
    }
}

#[tauri::command]
pub async fn open_external(target: String) -> Result<(), String> {
    let explorer = windows_dir().join("explorer.exe");
    let mut cmd = hidden_command(&explorer);
    match classify(&target)? {
        Target::Url(url) => {
            cmd.arg(url);
        }
        Target::Folder(dir) => {
            cmd.arg(dir);
        }
        Target::File(file) => {
            // Reveal in Explorer instead of executing/opening the file with elevated rights.
            cmd.raw_arg(format!("/select,\"{}\"", file.display()));
        }
    }
    // explorer.exe returns non-zero exit codes even on success: only spawn failures matter.
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not launch Explorer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        assert!(matches!(
            classify("https://www.nvidia.com/drivers"),
            Ok(Target::Url(_))
        ));
        assert!(matches!(classify("HTTP://example.com"), Ok(Target::Url(_))));
        assert!(classify("https://").is_err());
        assert!(classify("https://x.com/\" & calc").is_err());
        assert!(classify("file:///C:/Windows").is_err());
        assert!(classify("javascript:alert(1)").is_err());
        assert!(classify("calc.exe").is_err());
        assert!(classify(r"relative\dir").is_err());
        assert!(classify(r"\\attacker\share").is_err());
        assert!(classify(r"\\?\C:\Windows").is_err());
        assert!(classify(r"\\.\PhysicalDrive0").is_err());
        let tmp = std::env::temp_dir();
        assert!(matches!(
            classify(&tmp.to_string_lossy()),
            Ok(Target::Folder(_))
        ));
        assert!(classify(r"C:\definitely\not\here\nexum").is_err());
    }
}
