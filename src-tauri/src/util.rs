//! Small shared helpers: hidden child processes, CIM datetime parsing, tolerant
//! numeric deserializers for WMI, well-known Windows folders and poison-safe locks.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, MutexGuard};

use chrono::NaiveDate;

/// `CREATE_NO_WINDOW` — prevents a console window from flashing for child processes.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Builds a [`Command`] that never shows a console window.
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Locks a mutex, recovering the data if a previous holder panicked.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The real Windows directory, from `GetSystemWindowsDirectoryW`.
///
/// Deliberately NOT `%WINDIR%` / `%SystemRoot%`: user environment variables (HKCU\Environment)
/// can override those from a non-elevated process, which would let anything running as the
/// user redirect this elevated app's `System32\*.exe` launches and the cleaner's deny-list.
/// The environment is only consulted if the API fails, and only when it agrees with the
/// expected `X:\Windows`-style shape.
pub fn windows_dir() -> PathBuf {
    let mut buf = [0u16; 512];
    // SAFETY: the buffer is valid for its full length; the API writes at most that many units.
    let n = unsafe {
        windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW(Some(&mut buf[..]))
    } as usize;
    if n > 0 && n < buf.len() {
        let p = PathBuf::from(String::from_utf16_lossy(&buf[..n]));
        if p.is_absolute() {
            return p;
        }
    }
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| {
            p.is_absolute()
                && p.components().count() == 3 // prefix, root, "Windows"
                && p.file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("windows"))
        })
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// Resolves a shell known folder (e.g. `FOLDERID_ProgramData`) via `SHGetKnownFolderPath`.
/// Returns `None` on failure or for a non-absolute result.
pub fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    // SAFETY: `id` points to a valid GUID; on success the returned buffer is a NUL-terminated
    // wide string owned by us and released with CoTaskMemFree exactly once.
    unsafe {
        let pwstr = SHGetKnownFolderPath(
            id,
            KF_FLAG_DEFAULT,
            windows::Win32::Foundation::HANDLE::default(),
        )
        .ok()?;
        let s = pwstr.to_string();
        CoTaskMemFree(Some(pwstr.0 as *const std::ffi::c_void));
        let p = PathBuf::from(s.ok()?);
        p.is_absolute().then_some(p)
    }
}

/// Absolute path of a binary inside `%WINDIR%\System32`.
pub fn system32_exe(name: &str) -> PathBuf {
    windows_dir().join("System32").join(name)
}

/// System drive as `"C:"` (upper-case, no trailing slash), derived from the real Windows
/// directory (not the user-overridable `%SystemDrive%`).
pub fn system_drive() -> String {
    let w = windows_dir();
    let s = w.to_string_lossy();
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        s[..2].to_ascii_uppercase()
    } else {
        "C:".to_string()
    }
}

/// Parses a CIM datetime (`yyyymmddHHMMSS.mmmmmmsUUU`) or an ISO-ish `yyyy-mm-dd...` string
/// into a calendar date. Returns `None` for anything malformed.
pub fn parse_cim_date(raw: &str) -> Option<NaiveDate> {
    let s = raw.trim();
    if s.len() >= 8 && s.as_bytes()[..8].iter().all(|b| b.is_ascii_digit()) {
        let y: i32 = s[0..4].parse().ok()?;
        let m: u32 = s[4..6].parse().ok()?;
        let d: u32 = s[6..8].parse().ok()?;
        if y < 1900 {
            return None;
        }
        return NaiveDate::from_ymd_opt(y, m, d);
    }
    if s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        let y: i32 = s[0..4].parse().ok()?;
        let m: u32 = s[5..7].parse().ok()?;
        let d: u32 = s[8..10].parse().ok()?;
        if y < 1900 {
            return None;
        }
        return NaiveDate::from_ymd_opt(y, m, d);
    }
    None
}

/// CIM datetime → `"YYYY-MM-DD"`, or `""` when missing/invalid.
pub fn cim_date_string(raw: Option<&str>) -> String {
    raw.and_then(parse_cim_date)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Local timestamp suitable for file names: `YYYYMMDD-HHMMSS`.
pub fn file_timestamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// `Documents\Nexum` (created if missing).
pub fn documents_nexum_dir() -> Result<PathBuf, String> {
    let docs = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
        .ok_or_else(|| "Could not locate the Documents folder".to_string())?;
    let dir = docs.join("Nexum");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Trims a WMI string, mapping `None`/blank to `""`.
pub fn clean(s: &Option<String>) -> String {
    s.as_deref().map(str::trim).unwrap_or("").to_string()
}

/// Trims a WMI string, mapping blank/`None` to `fallback`.
pub fn clean_or(s: &Option<String>, fallback: &str) -> String {
    let c = clean(s);
    if c.is_empty() {
        fallback.to_string()
    } else {
        c
    }
}

/// Tolerant numeric deserializers. WMI returns `uint64` as strings in raw COM, and some
/// providers report numbers with unexpected widths; these accept any numeric/string form.
pub mod flex {
    use serde::de::{self, Deserializer, Visitor};
    use std::fmt;

    struct OptU64;

    impl<'de> Visitor<'de> for OptU64 {
        type Value = Option<u64>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an unsigned integer, numeric string or null")
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            d.deserialize_any(OptU64)
        }
        fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
            Ok(Some(v as u64))
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(u64::try_from(v).ok())
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v))
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            if v.is_finite() && v >= 0.0 {
                Ok(Some(v as u64))
            } else {
                Ok(None)
            }
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            let t = v.trim();
            if t.is_empty() {
                return Ok(None);
            }
            Ok(t.parse::<u64>().ok().or_else(|| {
                t.parse::<f64>()
                    .ok()
                    .filter(|f| *f >= 0.0)
                    .map(|f| f as u64)
            }))
        }
        fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
            self.visit_str(&v)
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            // Arrays are not expected for scalar fields: use the first numeric element.
            let mut first: Option<u64> = None;
            while let Some(v) = seq.next_element::<Flex>()? {
                if first.is_none() {
                    first = v.0;
                }
            }
            Ok(first)
        }
    }

    /// `Option<u64>` from any number / numeric string / null.
    pub fn opt_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
        d.deserialize_any(OptU64)
    }

    struct OptVecU64;

    impl<'de> Visitor<'de> for OptVecU64 {
        type Value = Option<Vec<u64>>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an array of unsigned integers or null")
        }
        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            d.deserialize_any(OptVecU64)
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(u64::try_from(v).ok().map(|x| vec![x]))
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(vec![v]))
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(v) = seq.next_element::<Flex>()? {
                if let Some(x) = v.0 {
                    out.push(x);
                }
            }
            Ok(Some(out))
        }
    }

    struct Flex(Option<u64>);

    impl<'de> serde::Deserialize<'de> for Flex {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            d.deserialize_any(OptU64).map(Flex)
        }
    }

    /// `Option<Vec<u64>>` from an array of numbers (or a single number).
    pub fn opt_vec_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u64>>, D::Error> {
        d.deserialize_any(OptVecU64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_dir_comes_from_the_api() {
        let w = windows_dir();
        assert!(w.is_absolute());
        assert!(w.join("System32").join("kernel32.dll").is_file());
        let d = system_drive();
        assert_eq!(d.len(), 2);
        assert!(w.to_string_lossy().to_ascii_uppercase().starts_with(&d));
        use windows::Win32::UI::Shell::FOLDERID_ProgramData;
        assert!(known_folder(&FOLDERID_ProgramData).is_some_and(|p| p.is_dir()));
    }

    #[test]
    fn cim_dates_parse() {
        assert_eq!(
            cim_date_string(Some("20230115000000.000000-000")),
            "2023-01-15"
        );
        assert_eq!(
            cim_date_string(Some("20060621000000.******+000")),
            "2006-06-21"
        );
        assert_eq!(cim_date_string(Some("2021-07-04")), "2021-07-04");
        assert_eq!(cim_date_string(Some("garbage")), "");
        assert_eq!(cim_date_string(Some("20231399000000.000000+000")), "");
        assert_eq!(cim_date_string(None), "");
    }

    #[test]
    fn flex_u64_accepts_strings_and_numbers() {
        #[derive(serde::Deserialize)]
        struct T {
            #[serde(default, deserialize_with = "flex::opt_u64")]
            a: Option<u64>,
            #[serde(default, deserialize_with = "flex::opt_u64")]
            b: Option<u64>,
            #[serde(default, deserialize_with = "flex::opt_u64")]
            c: Option<u64>,
            #[serde(default, deserialize_with = "flex::opt_vec_u64")]
            d: Option<Vec<u64>>,
        }
        let t: T = serde_json::from_str(r#"{"a":"1024","b":12,"c":null,"d":[2,"3"]}"#).unwrap();
        assert_eq!(t.a, Some(1024));
        assert_eq!(t.b, Some(12));
        assert_eq!(t.c, None);
        assert_eq!(t.d, Some(vec![2, 3]));
    }
}
