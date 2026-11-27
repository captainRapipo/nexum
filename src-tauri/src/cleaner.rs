//! Deep Purge engine (CONTRACT §3).
//!
//! Safety model:
//! * Only files *inside* enumerated category roots are candidates; a root itself is never
//!   deleted (the single exception is `MEMORY.DMP`, which the contract defines as a
//!   single-file root).
//! * Base folders come from `GetSystemWindowsDirectoryW` / `SHGetKnownFolderPath`, never from
//!   user-overridable environment variables. The one exception, `%TMP%`/`%TEMP%`, must be an
//!   absolute path (no fallback to the profile / Windows dir) and match a temp-folder pattern.
//! * Roots are canonicalized and must be local `X:\a\b...` paths at least two levels deep; a
//!   root that is (or resolves into) a deny-listed location, a drive root, a well-known parent
//!   folder (Windows dir, user profile, AppData, Users, ProgramData) or an *ancestor* of one is
//!   rejected outright. Roots reached through a reparse point anywhere in their ancestry too.
//! * Temp and Windows Update files created or modified in the last 24 h are left alone (they
//!   may belong to an installer or update that is running right now). Hard-linked files are
//!   skipped (deleting one name frees nothing).
//! * The walker uses `symlink_metadata` and never descends into, nor deletes, anything carrying
//!   `FILE_ATTRIBUTE_REPARSE_POINT` (symlinks, junctions, mount points, cloud placeholders).
//! * Deletion happens through a handle opened with `FILE_FLAG_OPEN_REPARSE_POINT`; before the
//!   delete-disposition is set, the handle's *final* path is re-verified to still be strictly
//!   inside the canonical root and outside the deny-list. This closes the TOCTOU window where
//!   a directory is swapped for a junction between scan and purge.
//! * Each file is handled individually; any failure increments `skipped`.
//! * `scan_trash` and `purge_trash` share the same enumerator (`plan_category`).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOLEAN, HANDLE, HWND};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileDispositionInfo, FileDispositionInfoEx, GetFileInformationByHandle,
    GetFinalPathNameByHandleW, SetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_FLAG_DELETE,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GETFINALPATHNAMEBYHANDLE_FLAGS, OPEN_EXISTING, VOLUME_NAME_DOS,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHQueryRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI,
    SHERB_NOSOUND, SHQUERYRBINFO,
};

use crate::state::AppState;
use crate::util::{known_folder, windows_dir};

const REPARSE_ATTR: u32 = FILE_ATTRIBUTE_REPARSE_POINT.0; // 0x400
const DIRECTORY_ATTR: u32 = FILE_ATTRIBUTE_DIRECTORY.0; // 0x10
const THIRTY_DAYS: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Temp / Windows Update files touched within this window are considered in use.
const RECENT_GUARD: Duration = Duration::from_secs(24 * 60 * 60);
/// A category root must be at least this many components below the drive root
/// (`C:\Windows\Temp` = 2).
const MIN_ROOT_DEPTH: usize = 2;
const MAX_DEPTH: usize = 64;
const STANDBY_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------------------------
// Public shapes (CONTRACT §2.1)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashCategory {
    pub id: String,
    pub label: String,
    pub description: String,
    pub bytes: u64,
    pub files: u64,
    pub enabled: bool,
    pub optional: bool,
    pub requires_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashScan {
    pub categories: Vec<TrashCategory>,
    pub total_bytes: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeCategoryResult {
    pub id: String,
    pub label: String,
    pub freed_bytes: u64,
    pub deleted: u64,
    pub skipped: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub freed_bytes: u64,
    pub files_deleted: u64,
    pub files_skipped: u64,
    pub duration_ms: u64,
    pub per_category: Vec<PurgeCategoryResult>,
    pub standby_flushed: Option<bool>,
    pub standby_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeProgress {
    pub category_id: String,
    pub label: String,
    pub step: u32,
    pub total_steps: u32,
    pub freed_bytes: u64,
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CategoryId {
    Temp,
    Recycle,
    WuCache,
    Shader,
    Browser,
    Logs,
    Standby,
}

impl CategoryId {
    pub const ALL: [CategoryId; 7] = [
        CategoryId::Temp,
        CategoryId::Recycle,
        CategoryId::WuCache,
        CategoryId::Shader,
        CategoryId::Browser,
        CategoryId::Logs,
        CategoryId::Standby,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CategoryId::Temp => "temp",
            CategoryId::Recycle => "recycle",
            CategoryId::WuCache => "wu-cache",
            CategoryId::Shader => "shader",
            CategoryId::Browser => "browser",
            CategoryId::Logs => "logs",
            CategoryId::Standby => "standby",
        }
    }

    pub fn parse(s: &str) -> Option<CategoryId> {
        let s = s.trim();
        CategoryId::ALL
            .into_iter()
            .find(|c| c.as_str().eq_ignore_ascii_case(s))
    }

    pub fn label(self) -> &'static str {
        match self {
            CategoryId::Temp => "Temporary Files",
            CategoryId::Recycle => "Recycle Bin",
            CategoryId::WuCache => "Windows Update Cache",
            CategoryId::Shader => "GPU Shader Caches",
            CategoryId::Browser => "Browser & App Caches",
            CategoryId::Logs => "Logs & Crash Dumps",
            CategoryId::Standby => "RAM Standby List",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            CategoryId::Temp => "User %TEMP% and C:\\Windows\\Temp files older than 24 hours. Locked and in-use files are skipped.",
            CategoryId::Recycle => "Empties the Recycle Bin on all mounted drives.",
            CategoryId::WuCache => "Windows Update download leftovers and the Delivery Optimization cache (files older than 24 hours).",
            CategoryId::Shader => "DirectX, NVIDIA, AMD and Intel shader caches. They are rebuilt automatically.",
            CategoryId::Browser => "Chrome, Edge, Firefox and Discord caches. Logins, cookies and history are never touched.",
            CategoryId::Logs => "Crash dumps, Windows Error Reporting files, Prefetch and CBS logs older than 30 days.",
            CategoryId::Standby => "Releases cached standby memory via the hardware agent. No files are deleted.",
        }
    }

    pub fn optional(self) -> bool {
        matches!(self, CategoryId::Browser | CategoryId::Standby)
    }

    pub fn requires_admin(self) -> bool {
        matches!(
            self,
            CategoryId::Temp | CategoryId::WuCache | CategoryId::Logs | CategoryId::Standby
        )
    }
}

/// Which files inside a root qualify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Filter {
    /// Every regular file.
    All,
    /// `*.dmp`, `*.mdmp`, `*.hdmp`.
    CrashDumps,
    /// `*.pf` older than 30 days.
    PrefetchOld,
    /// `*.log` older than 30 days, except `CBS.log`.
    CbsLogsOld,
    /// Browser cache content; `allow_sqlite` only inside Firefox `cache2`.
    BrowserCache { allow_sqlite: bool },
    /// Every regular file whose newest timestamp (created / modified) is older than the given
    /// age. Used for Temp and the Windows Update cache so files of an installer or update that
    /// is running right now (extracted minutes ago, often with old embedded mtimes, hence the
    /// creation time) are left alone.
    Stale(Duration),
}

/// Extra validation applied to a root after canonicalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RootGuard {
    /// Fixed sub-path of a trusted base folder (Windows dir, known folders).
    Fixed,
    /// The user's `%TMP%`/`%TEMP%`: user-controlled, so it must match a temp-folder pattern.
    UserTemp,
}

#[derive(Debug, Clone)]
struct RootSpec {
    path: PathBuf,
    single_file: bool,
    recursive: bool,
    filter: Filter,
    guard: RootGuard,
}

impl RootSpec {
    fn dir(path: PathBuf, recursive: bool, filter: Filter) -> Self {
        Self {
            path,
            single_file: false,
            recursive,
            filter,
            guard: RootGuard::Fixed,
        }
    }
    fn file(path: PathBuf, filter: Filter) -> Self {
        Self {
            path,
            single_file: true,
            recursive: false,
            filter,
            guard: RootGuard::Fixed,
        }
    }
    fn user_temp(path: PathBuf) -> Self {
        Self {
            path,
            single_file: false,
            recursive: true,
            filter: Filter::Stale(RECENT_GUARD),
            guard: RootGuard::UserTemp,
        }
    }
}

/// Base folders. Everything except the user temp folder comes from APIs that a
/// non-elevated process cannot redirect through environment variables.
#[derive(Debug, Clone)]
struct Env {
    windir: PathBuf,
    temp: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
    roaming_appdata: Option<PathBuf>,
    programdata: Option<PathBuf>,
}

impl Env {
    fn current() -> Self {
        use windows::Win32::UI::Shell::{
            FOLDERID_LocalAppData, FOLDERID_ProgramData, FOLDERID_RoamingAppData,
        };
        Self {
            windir: windows_dir(),
            temp: pick_user_temp(std::env::var_os("TMP"), std::env::var_os("TEMP")),
            local_appdata: known_folder(&FOLDERID_LocalAppData),
            roaming_appdata: known_folder(&FOLDERID_RoamingAppData),
            programdata: known_folder(&FOLDERID_ProgramData),
        }
    }
}

/// The user temp folder as `GetTempPath` would pick it (`%TMP%`, then `%TEMP%`), but with no
/// fallback to `%USERPROFILE%` or the Windows directory: if neither variable holds an absolute
/// path (`X:\...`), the user temp root is skipped entirely. A relative value would otherwise be
/// resolved against the current directory.
fn pick_user_temp(
    tmp: Option<std::ffi::OsString>,
    temp: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let raw = [tmp, temp]
        .into_iter()
        .flatten()
        .map(|v| v.to_string_lossy().trim().to_string())
        .find(|v| !v.is_empty())?;
    let p = PathBuf::from(raw);
    p.is_absolute().then_some(p)
}

fn category_roots(id: CategoryId, env: &Env) -> Vec<RootSpec> {
    use Filter::*;
    let mut roots = Vec::new();
    let w = &env.windir;
    match id {
        CategoryId::Temp => {
            if let Some(t) = &env.temp {
                roots.push(RootSpec::user_temp(t.clone()));
            }
            roots.push(RootSpec::dir(w.join("Temp"), true, Stale(RECENT_GUARD)));
        }
        CategoryId::WuCache => {
            roots.push(RootSpec::dir(
                w.join(r"SoftwareDistribution\Download"),
                true,
                Stale(RECENT_GUARD),
            ));
            roots.push(RootSpec::dir(
                w.join(r"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache"),
                true,
                Stale(RECENT_GUARD),
            ));
        }
        CategoryId::Shader => {
            if let Some(l) = &env.local_appdata {
                for rel in [
                    "D3DSCache",
                    r"NVIDIA\DXCache",
                    r"NVIDIA\GLCache",
                    r"AMD\DxCache",
                    r"AMD\DxcCache",
                    r"AMD\VkCache",
                    r"AMD\GLCache",
                    r"Intel\ShaderCache",
                ] {
                    roots.push(RootSpec::dir(l.join(rel), true, All));
                }
            }
            if let Some(pd) = &env.programdata {
                roots.push(RootSpec::dir(
                    pd.join(r"NVIDIA Corporation\NV_Cache"),
                    true,
                    All,
                ));
            }
        }
        CategoryId::Browser => {
            if let Some(l) = &env.local_appdata {
                for user_data in [
                    l.join(r"Google\Chrome\User Data"),
                    l.join(r"Microsoft\Edge\User Data"),
                ] {
                    for profile in chromium_profiles(&user_data) {
                        for rel in [r"Cache\Cache_Data", "Code Cache", "GPUCache"] {
                            roots.push(RootSpec::dir(
                                profile.join(rel),
                                true,
                                BrowserCache {
                                    allow_sqlite: false,
                                },
                            ));
                        }
                    }
                    for rel in ["ShaderCache", "GrShaderCache"] {
                        roots.push(RootSpec::dir(
                            user_data.join(rel),
                            true,
                            BrowserCache {
                                allow_sqlite: false,
                            },
                        ));
                    }
                }
                for profile in list_plain_subdirs(&l.join(r"Mozilla\Firefox\Profiles")) {
                    roots.push(RootSpec::dir(
                        profile.join("cache2"),
                        true,
                        BrowserCache { allow_sqlite: true },
                    ));
                }
            }
            if let Some(r) = &env.roaming_appdata {
                for rel in ["Cache", "Code Cache", "GPUCache"] {
                    roots.push(RootSpec::dir(
                        r.join("discord").join(rel),
                        true,
                        BrowserCache {
                            allow_sqlite: false,
                        },
                    ));
                }
            }
        }
        CategoryId::Logs => {
            roots.push(RootSpec::dir(w.join("Minidump"), false, CrashDumps));
            roots.push(RootSpec::file(w.join("MEMORY.DMP"), CrashDumps));
            if let Some(l) = &env.local_appdata {
                roots.push(RootSpec::dir(l.join("CrashDumps"), false, CrashDumps));
                roots.push(RootSpec::dir(l.join(r"Microsoft\Windows\WER"), true, All));
            }
            if let Some(pd) = &env.programdata {
                roots.push(RootSpec::dir(
                    pd.join(r"Microsoft\Windows\WER\ReportArchive"),
                    true,
                    All,
                ));
                roots.push(RootSpec::dir(
                    pd.join(r"Microsoft\Windows\WER\ReportQueue"),
                    true,
                    All,
                ));
            }
            roots.push(RootSpec::dir(w.join("Prefetch"), false, PrefetchOld));
            roots.push(RootSpec::dir(w.join(r"Logs\CBS"), false, CbsLogsOld));
        }
        CategoryId::Recycle | CategoryId::Standby => {}
    }
    roots
}

/// Direct, non-reparse subdirectories of `dir`.
fn list_plain_subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if let Ok(md) = std::fs::symlink_metadata(&p) {
                if md.is_dir() && !is_reparse(&md) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Chromium profile folders: `Default`, `Profile N`, `Guest Profile`.
fn chromium_profiles(user_data: &Path) -> Vec<PathBuf> {
    list_plain_subdirs(user_data)
        .into_iter()
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            name == "default" || name.starts_with("profile ") || name == "guest profile"
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Path normalization & deny-list
// ---------------------------------------------------------------------------------------------

/// Normalizes a path for comparisons: strips `\\?\` / `\\?\UNC\` / `\\.\`, uses `\`,
/// lower-cases, removes trailing separators and collapses duplicate separators.
pub fn norm_path(p: &Path) -> String {
    let raw = p.as_os_str().to_string_lossy().replace('/', "\\");
    let (unc, rest) = if let Some(r) = raw.strip_prefix(r"\\?\UNC\") {
        (true, r.to_string())
    } else if let Some(r) = raw.strip_prefix(r"\\?\") {
        (false, r.to_string())
    } else if let Some(r) = raw.strip_prefix(r"\\.\") {
        (false, r.to_string())
    } else if let Some(r) = raw.strip_prefix(r"\\") {
        (true, r.to_string())
    } else {
        (false, raw)
    };
    let mut out = String::with_capacity(rest.len() + 2);
    if unc {
        out.push_str(r"\\");
    }
    let mut prev_sep = false;
    for ch in rest.chars() {
        if ch == '\\' {
            if !prev_sep {
                out.push('\\');
            }
            prev_sep = true;
        } else {
            out.extend(ch.to_lowercase());
            prev_sep = false;
        }
    }
    while out.ends_with('\\') && out.len() > 2 {
        out.pop();
    }
    if out.len() == 3 && out.ends_with('\\') {
        out.pop();
    }
    out
}

/// True when `p` (normalized) is strictly inside `root` (normalized).
fn is_strictly_under(p: &str, root: &str) -> bool {
    p.len() > root.len() + 1 && p.starts_with(root) && p.as_bytes()[root.len()] == b'\\'
}

fn is_same_or_under(p: &str, root: &str) -> bool {
    p == root || is_strictly_under(p, root)
}

/// Drive roots (`c:`), bare UNC shares (`\\server\share`) and empty paths.
fn is_drive_root(p: &str) -> bool {
    if p.is_empty() {
        return true;
    }
    let b = p.as_bytes();
    if b.len() == 2 && b[1] == b':' {
        return true;
    }
    if let Some(rest) = p.strip_prefix(r"\\") {
        return rest.split('\\').filter(|s| !s.is_empty()).count() <= 2;
    }
    if p.starts_with("volume{") {
        return !p.contains('\\');
    }
    false
}

fn has_parent_components(p: &str) -> bool {
    p.split('\\').any(|c| c == ".." || c == ".")
}

/// Registry hives, transaction logs and other files that must never be deleted.
pub fn is_protected_file_name(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("ntuser.dat")
        || n.starts_with("usrclass.dat")
        || n.ends_with(".regtrans-ms")
        || n.ends_with(".blf")
}

/// Browser data that must survive (CONTRACT §3 rule 6).
fn is_protected_browser_component(component: &str) -> bool {
    let c = component.to_lowercase();
    matches!(
        c.as_str(),
        "cookies"
            | "cookies-journal"
            | "login data"
            | "login data-journal"
            | "login data for account"
            | "web data"
            | "web data-journal"
            | "history"
            | "history-journal"
            | "local storage"
            | "indexeddb"
            | "session storage"
            | "sessions"
            | "network"
    ) || c.starts_with("login data")
        || c.starts_with("web data")
}

/// Number of components below the drive root of a normalized local path (`c:` = 0,
/// `c:\windows\temp` = 2). `None` for anything that is not a plain `x:\...` path (UNC shares,
/// `volume{guid}` paths, empty components).
fn local_depth(p: &str) -> Option<usize> {
    let b = p.as_bytes();
    if b.len() < 2 || !b[0].is_ascii_alphabetic() || b[1] != b':' {
        return None;
    }
    let rest = &p[2..];
    if rest.is_empty() {
        return Some(0);
    }
    let rest = rest.strip_prefix('\\')?;
    if rest.split('\\').any(str::is_empty) {
        return None;
    }
    Some(rest.split('\\').count())
}

/// A category root must be a local `x:\a\b...` path at least [`MIN_ROOT_DEPTH`] deep.
fn root_shape_ok(p: &str) -> bool {
    local_depth(p).is_some_and(|d| d >= MIN_ROOT_DEPTH) && !has_parent_components(p)
}

/// Rules for the user-controlled `%TMP%`/`%TEMP%` root.
struct TempPolicy {
    /// `<LocalAppData>\Temp` (normalized; raw and canonical forms).
    local_temp: Vec<String>,
    /// `<Windows>\Temp`.
    windir_temp: Vec<String>,
    /// Trees in which a custom temp folder is refused (Windows dir, ProgramData, Users).
    system_trees: Vec<String>,
    /// The current user's profile (a custom temp folder inside it is acceptable).
    homes: Vec<String>,
}

impl TempPolicy {
    fn new(
        local_appdata: Option<&Path>,
        home: Option<&Path>,
        users_root: Option<&Path>,
        windir: &Path,
        programdata: Option<&Path>,
    ) -> Self {
        let mut system_trees = vec![windir.to_path_buf()];
        system_trees.extend(programdata.map(Path::to_path_buf));
        system_trees.extend(users_root.map(Path::to_path_buf));
        Self {
            local_temp: expand_norm(local_appdata.map(|l| l.join("Temp")).into_iter().collect()),
            windir_temp: expand_norm(vec![windir.join("Temp")]),
            system_trees: expand_norm(system_trees),
            homes: expand_norm(home.map(Path::to_path_buf).into_iter().collect()),
        }
    }

    /// `p` = normalized canonical root.
    fn accepts(&self, p: &str) -> bool {
        if !root_shape_ok(p) {
            return false;
        }
        // The standard locations.
        if self.local_temp.iter().any(|t| is_same_or_under(p, t))
            || self.windir_temp.iter().any(|t| p == t)
        {
            return true;
        }
        // A custom location must look like a temp folder: `...\Temp` or `...\Tmp`, optionally
        // followed by a numeric per-session sub-folder (`...\Temp\2` under RDP).
        let comps: Vec<&str> = p.split('\\').collect();
        let last = comps.last().copied().unwrap_or("");
        let named = if !last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()) {
            comps.len().checked_sub(2).map(|i| comps[i]).unwrap_or("")
        } else {
            last
        };
        if named != "temp" && named != "tmp" {
            return false;
        }
        let in_home = self.homes.iter().any(|h| is_strictly_under(p, h));
        in_home || !self.system_trees.iter().any(|s| is_same_or_under(p, s))
    }
}

pub struct DenyList {
    /// Path prefixes (normalized) that are never touched.
    prefixes: Vec<String>,
    /// Folders (normalized) that may contain targets but can never be a root themselves
    /// (nor can any of their ancestors).
    never_root: Vec<String>,
    temp: TempPolicy,
}

impl DenyList {
    pub fn build() -> Self {
        use windows::Win32::UI::Shell::{
            FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_ProgramData, FOLDERID_ProgramFiles,
            FOLDERID_ProgramFilesX86, FOLDERID_RoamingAppData, FOLDERID_UserProfiles,
        };

        let mut prefixes: Vec<PathBuf> = Vec::new();
        let mut never_root: Vec<PathBuf> = Vec::new();

        let windir = windows_dir();
        prefixes.push(windir.join("System32"));
        prefixes.push(windir.join("SysWOW64"));
        prefixes.push(windir.join("WinSxS"));
        prefixes.push(windir.join(r"System32\config"));
        prefixes.push(windir.join("SystemApps"));
        prefixes.push(windir.join("servicing"));
        // Program Files from the known-folder API (authoritative) *and* the environment
        // (extra entries can only make the deny-list stricter).
        for id in [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86] {
            prefixes.extend(known_folder(id));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(v) = std::env::var_os(var) {
                prefixes.push(PathBuf::from(v));
            }
        }
        let sys_drive = crate::util::system_drive();
        prefixes.push(PathBuf::from(format!(r"{sys_drive}\Program Files")));
        prefixes.push(PathBuf::from(format!(r"{sys_drive}\Program Files (x86)")));

        // User libraries (known-folder locations and their default locations).
        for d in [
            dirs::document_dir(),
            dirs::desktop_dir(),
            dirs::picture_dir(),
            dirs::video_dir(),
            dirs::audio_dir(),
            dirs::download_dir(),
        ]
        .into_iter()
        .flatten()
        {
            prefixes.push(d);
        }
        let profile = known_folder(&FOLDERID_Profile).or_else(dirs::home_dir);
        let users_root = known_folder(&FOLDERID_UserProfiles).or_else(|| {
            profile
                .as_ref()
                .and_then(|h| h.parent().map(Path::to_path_buf))
        });
        if let Some(home) = &profile {
            for sub in [
                "Documents",
                "Desktop",
                "Pictures",
                "Videos",
                "Music",
                "Downloads",
                "OneDrive",
            ] {
                prefixes.push(home.join(sub));
            }
            // "OneDrive - Contoso" and friends.
            if let Ok(rd) = std::fs::read_dir(home) {
                for e in rd.flatten() {
                    if e.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .starts_with("onedrive")
                    {
                        prefixes.push(e.path());
                    }
                }
            }
            never_root.push(home.clone());
        }
        never_root.extend(users_root.clone());
        for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
            if let Some(v) = std::env::var_os(var) {
                prefixes.push(PathBuf::from(v));
            }
        }

        let local_appdata = known_folder(&FOLDERID_LocalAppData).or_else(dirs::data_local_dir);
        let roaming_appdata = known_folder(&FOLDERID_RoamingAppData).or_else(dirs::data_dir);
        let programdata = known_folder(&FOLDERID_ProgramData);
        never_root.push(windir.clone());
        never_root.extend(local_appdata.clone());
        never_root.extend(roaming_appdata);
        never_root.extend(programdata.clone());
        for var in ["ProgramData", "LOCALAPPDATA", "APPDATA", "USERPROFILE"] {
            if let Some(v) = std::env::var_os(var) {
                never_root.push(PathBuf::from(v));
            }
        }

        let temp = TempPolicy::new(
            local_appdata.as_deref(),
            profile.as_deref(),
            users_root.as_deref(),
            &windir,
            programdata.as_deref(),
        );

        Self {
            prefixes: expand_norm(prefixes),
            never_root: expand_norm(never_root),
            temp,
        }
    }

    /// True when a normalized path must never be deleted or descended into.
    pub fn is_denied(&self, p: &str) -> bool {
        if is_drive_root(p) || has_parent_components(p) {
            return true;
        }
        if self.prefixes.iter().any(|d| is_same_or_under(p, d)) {
            return true;
        }
        let name = p.rsplit('\\').next().unwrap_or("");
        is_protected_file_name(name)
    }

    /// True when a normalized path may not be used as a category root.
    fn is_forbidden_root(&self, p: &str) -> bool {
        !root_shape_ok(p)
            || self.is_denied(p)
            // Neither a protected parent folder (profile, AppData, Windows, ...) nor any of its
            // ancestors (e.g. %TEMP% = C:\Users\me\AppData).
            || self.never_root.iter().any(|d| is_same_or_under(d, p))
            // A root must never contain a deny-listed folder (e.g. a misconfigured %TEMP% = C:\).
            || self.prefixes.iter().any(|d| is_strictly_under(d, p))
    }

    /// Full root validation for a normalized canonical root path.
    fn root_allowed(&self, p: &str, guard: RootGuard) -> bool {
        if self.is_forbidden_root(p) {
            return false;
        }
        match guard {
            RootGuard::Fixed => true,
            RootGuard::UserTemp => self.temp.accepts(p),
        }
    }
}

/// Normalizes each path, adding its canonical form too (resolves redirected folders/junctions).
fn expand_norm(paths: Vec<PathBuf>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        if !p.is_absolute() {
            continue;
        }
        let n = norm_path(&p);
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
        if let Ok(c) = std::fs::canonicalize(&p) {
            let cn = norm_path(&c);
            if !cn.is_empty() && !out.contains(&cn) {
                out.push(cn);
            }
        }
    }
    out
}

fn is_reparse(md: &std::fs::Metadata) -> bool {
    md.file_attributes() & REPARSE_ATTR != 0
}

/// True when `path` or any of its ancestors (below the drive root) is a reparse point, or
/// when an ancestor cannot be inspected (fail closed).
fn has_reparse_ancestor(path: &Path) -> bool {
    if !path.is_absolute() {
        return true;
    }
    for ancestor in path.ancestors() {
        // Stop at the drive / share root.
        if ancestor.parent().is_none() {
            break;
        }
        match std::fs::symlink_metadata(ancestor) {
            Ok(md) if is_reparse(&md) => return true,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    false
}

/// Case-insensitive comparison of the last path component of `requested` and `resolved`.
fn same_final_name(requested: &Path, resolved: &Path) -> bool {
    match (requested.file_name(), resolved.file_name()) {
        (Some(a), Some(b)) => {
            a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        }
        _ => false,
    }
}

fn older_than(md: &std::fs::Metadata, age: Duration, now: SystemTime) -> bool {
    match md.modified() {
        Ok(m) => now.duration_since(m).map(|d| d > age).unwrap_or(false),
        Err(_) => false,
    }
}

/// True when both the creation and the last-write time are older than `age` (fails closed:
/// an unreadable or future timestamp counts as recent).
fn stale(md: &std::fs::Metadata, age: Duration, now: SystemTime) -> bool {
    let old = |t: std::io::Result<SystemTime>| {
        t.ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|d| d > age)
    };
    old(md.created()) && old(md.modified())
}

fn extension_lower(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default()
}

impl Filter {
    /// `rel` = normalized path relative to the root (components separated by `\`).
    fn accepts(self, name: &str, rel: &str, md: &std::fs::Metadata, now: SystemTime) -> bool {
        match self {
            Filter::All => true,
            Filter::Stale(age) => stale(md, age, now),
            Filter::CrashDumps => matches!(extension_lower(name).as_str(), "dmp" | "mdmp" | "hdmp"),
            Filter::PrefetchOld => {
                extension_lower(name) == "pf" && older_than(md, THIRTY_DAYS, now)
            }
            Filter::CbsLogsOld => {
                extension_lower(name) == "log"
                    && !name.eq_ignore_ascii_case("cbs.log")
                    && older_than(md, THIRTY_DAYS, now)
            }
            Filter::BrowserCache { allow_sqlite } => {
                if rel.split('\\').any(is_protected_browser_component) {
                    return false;
                }
                let ext = extension_lower(name);
                if !allow_sqlite && (ext == "sqlite" || ext == "sqlite-wal" || ext == "sqlite-shm")
                {
                    return false;
                }
                true
            }
        }
    }

    /// Whether the walker may descend into a sub-directory named `name` (relative path `rel`).
    fn may_descend(self, rel: &str) -> bool {
        match self {
            Filter::BrowserCache { .. } => !rel.split('\\').any(is_protected_browser_component),
            _ => true,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Enumerator (shared by scan and purge)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct RootPlan {
    /// Canonical root path (verbatim form).
    #[allow(dead_code)] // used by tests and diagnostics
    pub root: PathBuf,
    /// Normalized canonical root (or, for a single-file root, the normalized file path).
    root_norm: String,
    single_file: bool,
    pub files: Vec<Candidate>,
    /// Sub-directories (never the root), for bottom-up empty-dir removal.
    pub dirs: Vec<(usize, PathBuf)>,
}

impl RootPlan {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|c| c.size).sum()
    }
}

fn plan_root(spec: &RootSpec, deny: &DenyList, now: SystemTime) -> Option<RootPlan> {
    let md = std::fs::symlink_metadata(&spec.path).ok()?;
    if is_reparse(&md) {
        return None;
    }
    // A root reached through a junction/symlink anywhere in its ancestry is refused: a
    // user-writable parent swapped for a link could otherwise redirect an elevated purge.
    if has_reparse_ancestor(&spec.path) {
        return None;
    }
    let canon = std::fs::canonicalize(&spec.path).ok()?;
    // Re-validate what canonicalization resolved to, closing the race where the root (or a
    // parent) is swapped for a link between the checks above and `canonicalize`: the resolved
    // path must still be link-free and end in the folder/file name that was asked for.
    if !same_final_name(&spec.path, &canon) || has_reparse_ancestor(&canon) {
        return None;
    }
    let canon_norm = norm_path(&canon);

    if spec.single_file {
        if !md.is_file() || !root_shape_ok(&canon_norm) || deny.is_denied(&canon_norm) {
            return None;
        }
        let name = canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !spec.filter.accepts(&name, &name.to_lowercase(), &md, now) {
            return None;
        }
        return Some(RootPlan {
            root: canon.clone(),
            root_norm: canon_norm,
            single_file: true,
            files: vec![Candidate {
                path: canon,
                size: md.len(),
            }],
            dirs: Vec::new(),
        });
    }

    if !md.is_dir() || !deny.root_allowed(&canon_norm, spec.guard) {
        return None;
    }

    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(canon.clone(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let emd = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Rule 3: never follow or delete reparse points.
            if is_reparse(&emd) {
                continue;
            }
            let pn = norm_path(&path);
            if !is_strictly_under(&pn, &canon_norm) || deny.is_denied(&pn) {
                continue;
            }
            let rel = &pn[canon_norm.len() + 1..];
            if emd.is_dir() {
                if spec.recursive && depth < MAX_DEPTH && spec.filter.may_descend(rel) {
                    dirs.push((depth + 1, path.clone()));
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !emd.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !spec.filter.accepts(&name, rel, &emd, now) {
                continue;
            }
            files.push(Candidate {
                path,
                size: emd.len(),
            });
        }
    }

    Some(RootPlan {
        root: canon,
        root_norm: canon_norm,
        single_file: false,
        files,
        dirs,
    })
}

/// Enumerates every root of a file-based category, de-duplicating overlapping roots.
fn plan_category(id: CategoryId, env: &Env, deny: &DenyList) -> Vec<RootPlan> {
    let now = SystemTime::now();
    let mut plans: Vec<RootPlan> = Vec::new();
    for spec in category_roots(id, env) {
        if let Some(plan) = plan_root(&spec, deny, now) {
            // Skip a root equal to / nested in an already planned root (e.g. %TEMP% = C:\Windows\Temp).
            if plans
                .iter()
                .any(|p| !p.single_file && is_same_or_under(&plan.root_norm, &p.root_norm))
            {
                continue;
            }
            // Drop previously planned roots that are nested inside this one.
            plans.retain(|p| p.single_file || !is_strictly_under(&p.root_norm, &plan.root_norm));
            plans.push(plan);
        }
    }
    plans
}

// ---------------------------------------------------------------------------------------------
// Handle-based verified deletion
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
#[allow(dead_code)] // payloads are diagnostic (Debug output in tests/logs)
pub enum DeleteError {
    Open(String),
    NotAllowed(&'static str),
    Failed(String),
}

fn to_wide(p: &Path) -> Vec<u16> {
    OsStr::new(p.as_os_str())
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn final_path(h: HANDLE) -> Option<String> {
    let flags = GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0);
    let mut buf = vec![0u16; 1024];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(h, &mut buf, flags) } as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            let s = String::from_utf16_lossy(&buf[..n]);
            return Some(norm_path(Path::new(&s)));
        }
        if n > 32 * 1024 + 16 {
            return None;
        }
        buf = vec![0u16; n + 1];
    }
}

/// Deletes `path` through a handle opened *without* following reparse points, after
/// verifying the handle's final path is still inside `plan`'s root and not deny-listed.
/// Returns the size of the deleted file (0 for directories).
fn verified_delete(
    path: &Path,
    expect_dir: bool,
    plan: &RootPlan,
    deny: &DenyList,
) -> Result<u64, DeleteError> {
    let wide = to_wide(path);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            DELETE.0 | FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            HANDLE::default(),
        )
    }
    .map_err(|e| DeleteError::Open(e.message().to_string()))?;
    let handle = OwnedHandle(handle);

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle.0, &mut info) }
        .map_err(|e| DeleteError::Failed(e.message().to_string()))?;
    if info.dwFileAttributes & REPARSE_ATTR != 0 {
        return Err(DeleteError::NotAllowed("reparse point"));
    }
    let is_dir = info.dwFileAttributes & DIRECTORY_ATTR != 0;
    if is_dir != expect_dir {
        return Err(DeleteError::NotAllowed("type changed"));
    }
    // A file with several hard links: removing this name frees nothing and the final path
    // may report a different (outside) name. Leave it alone.
    if !is_dir && info.nNumberOfLinks > 1 {
        return Err(DeleteError::NotAllowed("hard-linked file"));
    }

    let fp = final_path(handle.0).ok_or(DeleteError::NotAllowed("unresolvable path"))?;
    let inside = if plan.single_file {
        fp == plan.root_norm
    } else {
        is_strictly_under(&fp, &plan.root_norm)
    };
    if !inside {
        return Err(DeleteError::NotAllowed("outside root"));
    }
    if deny.is_denied(&fp) {
        return Err(DeleteError::NotAllowed("deny-listed"));
    }

    let size = if is_dir {
        0
    } else {
        ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64
    };

    // Prefer POSIX semantics (works with open share-delete handles) + ignore read-only.
    let ex = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
            FILE_DISPOSITION_FLAG_DELETE.0
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS.0
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE.0,
        ),
    };
    let ex_result = unsafe {
        SetFileInformationByHandle(
            handle.0,
            FileDispositionInfoEx,
            &ex as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if ex_result.is_err() {
        let basic = FILE_DISPOSITION_INFO {
            DeleteFile: BOOLEAN(1),
        };
        unsafe {
            SetFileInformationByHandle(
                handle.0,
                FileDispositionInfo,
                &basic as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
        .map_err(|e| DeleteError::Failed(e.message().to_string()))?;
    }
    drop(handle); // closing the handle performs the delete
    Ok(size)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct PurgeCounts {
    pub freed: u64,
    pub deleted: u64,
    pub skipped: u64,
}

/// Deletes every candidate of a plan, then removes now-empty sub-directories bottom-up.
pub fn purge_plan(plan: &RootPlan, deny: &DenyList) -> PurgeCounts {
    let mut c = PurgeCounts::default();
    for cand in &plan.files {
        match verified_delete(&cand.path, false, plan, deny) {
            Ok(size) => {
                c.freed += size;
                c.deleted += 1;
            }
            Err(_) => c.skipped += 1,
        }
    }
    if !plan.single_file {
        let mut dirs: Vec<&(usize, PathBuf)> = plan.dirs.iter().collect();
        dirs.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, dir) in dirs {
            // Only succeeds if empty; failures (non-empty, locked) are expected and ignored.
            let _ = verified_delete(dir, true, plan, deny);
        }
    }
    c
}

// ---------------------------------------------------------------------------------------------
// Recycle bin
// ---------------------------------------------------------------------------------------------

/// Runs `f` on a fresh thread inside a single-threaded COM apartment (what the shell's
/// recycle-bin APIs expect). A dedicated thread avoids inheriting whatever apartment a reused
/// blocking-pool thread already has (WMI initializes those as MTA).
fn on_sta_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    std::thread::Builder::new()
        .name("nexum-recycle-bin".into())
        .spawn(move || {
            // SAFETY: balanced with CoUninitialize below when initialization succeeded.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            let out = f();
            if hr.is_ok() {
                unsafe { CoUninitialize() };
            }
            out
        })
        .ok()?
        .join()
        .ok()
}

/// (bytes, items) in the Recycle Bins of all drives. Call on an STA thread.
fn query_recycle_bin_sta() -> Option<(u64, u64)> {
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is a properly sized, writable SHQUERYRBINFO; a null root = all drives.
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.ok()?;
    Some((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
}

fn query_recycle_bin() -> Option<(u64, u64)> {
    on_sta_thread(query_recycle_bin_sta).flatten()
}

fn empty_recycle_bin() -> PurgeCounts {
    on_sta_thread(|| {
        let before = query_recycle_bin_sta();
        let (bytes, items) = before.unwrap_or((0, 0));
        if before.is_some() && items == 0 {
            return PurgeCounts::default();
        }
        let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
        // SAFETY: no owner window, null root = every drive's bin, no UI flags.
        let result = unsafe { SHEmptyRecycleBinW(HWND::default(), PCWSTR::null(), flags) };
        if let Err(e) = &result {
            // E_UNEXPECTED is returned for an already-empty bin; anything else is logged.
            eprintln!("[nexum] SHEmptyRecycleBinW: {e}");
        }
        // Measure the real outcome instead of trusting the return code.
        match query_recycle_bin_sta() {
            Some(after) => PurgeCounts {
                freed: bytes.saturating_sub(after.0),
                deleted: items.saturating_sub(after.1),
                skipped: after.1,
            },
            None if result.is_ok() => PurgeCounts {
                freed: bytes,
                deleted: items,
                skipped: 0,
            },
            None => PurgeCounts {
                freed: 0,
                deleted: 0,
                skipped: items,
            },
        }
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Scan & purge orchestration
// ---------------------------------------------------------------------------------------------

fn make_category(id: CategoryId, bytes: u64, files: u64, include_browser: bool) -> TrashCategory {
    let enabled = match id {
        CategoryId::Browser => include_browser,
        CategoryId::Standby => false,
        _ => true,
    };
    TrashCategory {
        id: id.as_str().to_string(),
        label: id.label().to_string(),
        description: id.description().to_string(),
        bytes,
        files,
        enabled,
        optional: id.optional(),
        requires_admin: id.requires_admin(),
    }
}

pub fn scan(include_browser: bool) -> TrashScan {
    let started = Instant::now();
    let env = Env::current();
    let deny = DenyList::build();
    let mut categories = Vec::new();
    for id in CategoryId::ALL {
        let (bytes, files) = match id {
            CategoryId::Recycle => query_recycle_bin().unwrap_or((0, 0)),
            CategoryId::Standby => (0, 0),
            _ => {
                let plans = plan_category(id, &env, &deny);
                (
                    plans.iter().map(RootPlan::total_bytes).sum(),
                    plans.iter().map(|p| p.files.len() as u64).sum(),
                )
            }
        };
        categories.push(make_category(id, bytes, files, include_browser));
    }
    let total_bytes = categories.iter().map(|c| c.bytes).sum();
    TrashScan {
        categories,
        total_bytes,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

fn emit_progress(app: &AppHandle, id: CategoryId, step: u32, total: u32, freed: u64) {
    let _ = app.emit(
        "purge-progress",
        PurgeProgress {
            category_id: id.as_str().to_string(),
            label: id.label().to_string(),
            step,
            total_steps: total,
            freed_bytes: freed,
        },
    );
}

pub fn purge(app: &AppHandle, categories: &[String], flush_standby: bool) -> PurgeResult {
    let started = Instant::now();
    let env = Env::current();
    let deny = DenyList::build();

    let requested: Vec<CategoryId> = CategoryId::ALL
        .into_iter()
        .filter(|id| categories.iter().any(|c| CategoryId::parse(c) == Some(*id)))
        .collect();
    let do_standby = flush_standby || requested.contains(&CategoryId::Standby);
    let file_steps: Vec<CategoryId> = requested
        .iter()
        .copied()
        .filter(|c| *c != CategoryId::Standby)
        .collect();
    let total_steps = (file_steps.len() + usize::from(do_standby)) as u32;

    let mut per_category = Vec::new();
    let mut total = PurgeCounts::default();
    let mut step = 0u32;

    for id in file_steps {
        step += 1;
        // Start-of-category event: freedBytes = running total so far.
        emit_progress(app, id, step, total_steps, total.freed);
        let counts = match id {
            CategoryId::Recycle => empty_recycle_bin(),
            _ => {
                let mut c = PurgeCounts::default();
                for plan in plan_category(id, &env, &deny) {
                    let r = purge_plan(&plan, &deny);
                    c.freed += r.freed;
                    c.deleted += r.deleted;
                    c.skipped += r.skipped;
                }
                c
            }
        };
        total.freed += counts.freed;
        total.deleted += counts.deleted;
        total.skipped += counts.skipped;
        per_category.push(PurgeCategoryResult {
            id: id.as_str().to_string(),
            label: id.label().to_string(),
            freed_bytes: counts.freed,
            deleted: counts.deleted,
            skipped: counts.skipped,
        });
        // End-of-category event: freedBytes = running total including this category.
        emit_progress(app, id, step, total_steps, total.freed);
    }

    let (standby_flushed, standby_message) = if do_standby {
        step += 1;
        emit_progress(app, CategoryId::Standby, step, total_steps, total.freed);
        let state = app.state::<AppState>();
        let outcome = state.agent.request_ack(
            &json!({ "cmd": "flushStandby" }),
            "flushStandby",
            STANDBY_TIMEOUT,
        );
        let (ok, msg) = match outcome {
            Ok(ack) => (ack.ok, ack.message),
            Err(e) => (false, e),
        };
        per_category.push(PurgeCategoryResult {
            id: CategoryId::Standby.as_str().to_string(),
            label: CategoryId::Standby.label().to_string(),
            freed_bytes: 0,
            deleted: 0,
            skipped: 0,
        });
        emit_progress(app, CategoryId::Standby, step, total_steps, total.freed);
        (Some(ok), Some(msg))
    } else {
        (None, None)
    };

    PurgeResult {
        freed_bytes: total.freed,
        files_deleted: total.deleted,
        files_skipped: total.skipped,
        duration_ms: started.elapsed().as_millis() as u64,
        per_category,
        standby_flushed,
        standby_message,
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn scan_trash(include_browser: bool) -> Result<TrashScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan(include_browser))
        .await
        .map_err(|e| format!("Scan failed: {e}"))
}

#[tauri::command]
pub async fn purge_trash(
    app: AppHandle,
    categories: Vec<String>,
    flush_standby: bool,
) -> Result<PurgeResult, String> {
    {
        let state = app.state::<AppState>();
        if state.purge_running.swap(true, Ordering::SeqCst) {
            return Err("A purge is already running".to_string());
        }
    }
    let worker = app.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || purge(&worker, &categories, flush_standby))
            .await
            .map_err(|e| format!("Purge failed: {e}"));
    app.state::<AppState>()
        .purge_running
        .store(false, Ordering::SeqCst);
    result
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempTree {
        base: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let base = std::env::temp_dir()
                .join(format!("nexum-test-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&base).unwrap();
            Self { base }
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            // Remove links first (remove_dir on a junction removes only the link).
            let _ = remove_links(&self.base);
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn remove_links(dir: &Path) -> std::io::Result<()> {
        for e in fs::read_dir(dir)? {
            let p = e?.path();
            let md = fs::symlink_metadata(&p)?;
            if is_reparse(&md) {
                let _ = fs::remove_dir(&p).or_else(|_| fs::remove_file(&p));
            } else if md.is_dir() {
                remove_links(&p)?;
            }
        }
        Ok(())
    }

    fn make_junction(link: &Path, target: &Path) -> bool {
        crate::util::hidden_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn all_filter_spec(root: &Path) -> RootSpec {
        RootSpec::dir(root.to_path_buf(), true, Filter::All)
    }

    #[test]
    fn junction_is_not_followed_by_scan_or_purge() {
        let t = TempTree::new("junction");
        let root = t.base.join("root");
        let outside = t.base.join("outside");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("a.tmp"), b"aaaa").unwrap();
        fs::write(root.join("sub").join("b.tmp"), b"bb").unwrap();
        fs::write(outside.join("secret.txt"), b"do not delete").unwrap();
        assert!(
            make_junction(&root.join("link"), &outside),
            "could not create junction"
        );

        // Optional symlink (needs Developer Mode or admin) — test it when possible.
        let symlink_ok = std::os::windows::fs::symlink_dir(&outside, root.join("symlink")).is_ok();
        let file_symlink_ok = std::os::windows::fs::symlink_file(
            outside.join("secret.txt"),
            root.join("secret-link.txt"),
        )
        .is_ok();

        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).expect("root plan");
        let names: Vec<String> = plan.files.iter().map(|c| norm_path(&c.path)).collect();
        assert_eq!(plan.files.len(), 2, "unexpected candidates: {names:?}");
        assert!(names.iter().all(|n| !n.contains("secret")));
        assert!(plan
            .dirs
            .iter()
            .all(|(_, d)| !norm_path(d).ends_with("link")));

        let counts = purge_plan(&plan, &deny);
        assert_eq!(counts.deleted, 2);
        assert_eq!(counts.freed, 6);

        // Outside content and the links themselves are untouched; the root survives.
        assert!(outside.join("secret.txt").exists());
        assert!(root.exists(), "root must never be deleted");
        assert!(
            fs::symlink_metadata(root.join("link")).is_ok(),
            "junction must not be deleted"
        );
        if symlink_ok {
            assert!(fs::symlink_metadata(root.join("symlink")).is_ok());
        }
        if file_symlink_ok {
            assert!(fs::symlink_metadata(root.join("secret-link.txt")).is_ok());
        }
        // Empty sub-directory was removed bottom-up.
        assert!(!root.join("sub").exists());
    }

    #[test]
    fn verified_delete_rejects_paths_through_a_junction() {
        let t = TempTree::new("toctou");
        let root = t.base.join("root");
        let outside = t.base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("victim.txt"), b"keep me").unwrap();
        assert!(make_junction(&root.join("swapped"), &outside));

        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).expect("root plan");
        // Simulate a candidate captured before the directory was swapped for a junction.
        let victim = plan.root.join("swapped").join("victim.txt");
        let r = verified_delete(&victim, false, &plan, &deny);
        assert!(matches!(r, Err(DeleteError::NotAllowed(_))), "got {r:?}");
        assert!(outside.join("victim.txt").exists());

        // And the junction itself is refused as a directory delete.
        let r = verified_delete(&plan.root.join("swapped"), true, &plan, &deny);
        assert!(r.is_err());
        assert!(fs::symlink_metadata(root.join("swapped")).is_ok());
    }

    #[test]
    fn junction_root_is_rejected() {
        let t = TempTree::new("rootlink");
        let target = t.base.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("x.tmp"), b"x").unwrap();
        let link = t.base.join("rootlink");
        assert!(make_junction(&link, &target));
        fs::create_dir_all(target.join("sub")).unwrap();
        fs::write(target.join("sub").join("y.tmp"), b"y").unwrap();
        let deny = DenyList::build();
        assert!(plan_root(&all_filter_spec(&link), &deny, SystemTime::now()).is_none());
        // A root whose *parent* is a junction is rejected as well.
        assert!(plan_root(
            &all_filter_spec(&link.join("sub")),
            &deny,
            SystemTime::now()
        )
        .is_none());
        // The real target is fine.
        assert!(plan_root(&all_filter_spec(&target), &deny, SystemTime::now()).is_some());
    }

    #[test]
    fn deny_list_rejects_protected_locations() {
        let deny = DenyList::build();
        let windir = windows_dir();
        let sys32 = norm_path(&windir.join("System32"));
        assert!(deny.is_denied(&sys32));
        assert!(deny.is_denied(&norm_path(&windir.join(r"System32\drivers\etc\hosts"))));
        assert!(deny.is_denied(&norm_path(&windir.join(r"SysWOW64\foo.dll"))));
        assert!(deny.is_denied(&norm_path(&windir.join(r"WinSxS\x"))));
        assert!(deny.is_denied(&norm_path(&windir.join(r"System32\config\SAM"))));
        // Verbatim + mixed case forms normalize to the same thing.
        let verbatim = format!(r"\\?\{}\SYSTEM32\Kernel32.DLL", windir.display());
        assert!(deny.is_denied(&norm_path(Path::new(&verbatim))));
        // Program Files.
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        assert!(deny.is_denied(&norm_path(&Path::new(&pf).join("App").join("app.exe"))));
        // Drive roots.
        assert!(deny.is_denied("c:"));
        assert!(deny.is_denied(&norm_path(Path::new(r"C:\"))));
        assert!(deny.is_denied(&norm_path(Path::new(r"\\?\D:\"))));
        assert!(deny.is_denied(r"\\server\share"));
        // User libraries.
        if let Some(docs) = dirs::document_dir() {
            assert!(deny.is_denied(&norm_path(&docs.join("report.docx"))));
        }
        if let Some(dl) = dirs::download_dir() {
            assert!(deny.is_denied(&norm_path(&dl.join("setup.exe"))));
        }
        // Protected file names anywhere.
        assert!(deny.is_denied(r"c:\windows\temp\ntuser.dat"));
        assert!(deny.is_denied(r"c:\windows\temp\NTUSER.DAT.LOG1"));
        assert!(deny.is_denied(r"c:\windows\temp\usrclass.dat"));
        assert!(deny.is_denied(r"c:\windows\temp\x.regtrans-ms"));
        assert!(deny.is_denied(r"c:\windows\temp\tm.blf"));
        // Parent traversal.
        assert!(deny.is_denied(r"c:\windows\temp\..\system32"));
        // Regular temp file is fine.
        assert!(!deny.is_denied(&norm_path(&windir.join(r"Temp\setup.log"))));
    }

    #[test]
    fn denied_and_parent_roots_are_rejected() {
        let deny = DenyList::build();
        let now = SystemTime::now();
        let windir = windows_dir();
        for root in [
            windir.join("System32"),
            windir.clone(),
            PathBuf::from(format!(r"{}\", crate::util::system_drive())),
        ] {
            assert!(
                plan_root(&all_filter_spec(&root), &deny, now).is_none(),
                "root {} must be rejected",
                root.display()
            );
        }
        if let Some(home) = dirs::home_dir() {
            assert!(plan_root(&all_filter_spec(&home), &deny, now).is_none());
        }
        if let Some(docs) = dirs::document_dir() {
            assert!(plan_root(&all_filter_spec(&docs), &deny, now).is_none());
        }
    }

    #[test]
    fn protected_file_names_are_never_candidates() {
        let t = TempTree::new("names");
        let root = t.base.join("root");
        fs::create_dir_all(&root).unwrap();
        for n in [
            "NTUSER.DAT",
            "ntuser.dat.LOG2",
            "UsrClass.dat",
            "a.regtrans-ms",
            "b.blf",
            "ok.tmp",
        ] {
            fs::write(root.join(n), b"1").unwrap();
        }
        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert!(norm_path(&plan.files[0].path).ends_with("ok.tmp"));
    }

    #[test]
    fn browser_filter_protects_profile_data() {
        let t = TempTree::new("browser");
        let root = t.base.join("Cache_Data");
        fs::create_dir_all(root.join("IndexedDB")).unwrap();
        fs::write(root.join("data_0"), b"12").unwrap();
        fs::write(root.join("Cookies"), b"c").unwrap();
        fs::write(root.join("places.sqlite"), b"s").unwrap();
        fs::write(root.join("IndexedDB").join("x"), b"i").unwrap();
        let deny = DenyList::build();
        let spec = RootSpec::dir(
            root.clone(),
            true,
            Filter::BrowserCache {
                allow_sqlite: false,
            },
        );
        let plan = plan_root(&spec, &deny, SystemTime::now()).unwrap();
        let names: Vec<String> = plan.files.iter().map(|c| norm_path(&c.path)).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(names[0].ends_with("data_0"));

        let spec = RootSpec::dir(root, true, Filter::BrowserCache { allow_sqlite: true });
        let plan = plan_root(&spec, &deny, SystemTime::now()).unwrap();
        assert_eq!(plan.files.len(), 2);
    }

    #[test]
    fn crash_dump_filter_and_single_file_root() {
        let t = TempTree::new("dumps");
        let root = t.base.join("Minidump");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.dmp"), b"1").unwrap();
        fs::write(root.join("b.mdmp"), b"1").unwrap();
        fs::write(root.join("c.HDMP"), b"1").unwrap();
        fs::write(root.join("keep.txt"), b"1").unwrap();
        let deny = DenyList::build();
        let plan = plan_root(
            &RootSpec::dir(root.clone(), false, Filter::CrashDumps),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(plan.files.len(), 3);

        let single = root.join("a.dmp");
        let plan = plan_root(
            &RootSpec::file(single.clone(), Filter::CrashDumps),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 1);
        assert!(!single.exists());
        assert!(root.join("keep.txt").exists());
    }

    #[test]
    fn scan_and_purge_use_same_numbers() {
        let t = TempTree::new("same");
        let root = t.base.join("root");
        fs::create_dir_all(root.join("deep").join("er")).unwrap();
        fs::write(root.join("1.tmp"), vec![0u8; 100]).unwrap();
        fs::write(root.join("deep").join("er").join("2.tmp"), vec![0u8; 50]).unwrap();
        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).unwrap();
        assert_eq!(plan.total_bytes(), 150);
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.freed, 150);
        assert_eq!(c.deleted, 2);
        assert_eq!(c.skipped, 0);
        assert!(root.exists());
        assert!(!root.join("deep").exists());
    }

    #[test]
    fn normalization() {
        assert_eq!(
            norm_path(Path::new(r"\\?\C:\Windows\Temp\")),
            r"c:\windows\temp"
        );
        assert_eq!(
            norm_path(Path::new(r"C:/Windows//Temp")),
            r"c:\windows\temp"
        );
        assert_eq!(
            norm_path(Path::new(r"\\?\UNC\srv\share\x")),
            r"\\srv\share\x"
        );
        assert_eq!(norm_path(Path::new(r"C:\")), "c:");
        assert!(is_strictly_under(r"c:\a\b", r"c:\a"));
        assert!(!is_strictly_under(r"c:\ab", r"c:\a"));
        assert!(!is_strictly_under(r"c:\a", r"c:\a"));
    }

    #[test]
    fn category_ids_round_trip() {
        for id in CategoryId::ALL {
            assert_eq!(CategoryId::parse(id.as_str()), Some(id));
        }
        assert_eq!(CategoryId::parse("bogus"), None);
    }

    #[test]
    fn root_shape_requires_local_depth() {
        assert_eq!(local_depth("c:"), Some(0));
        assert_eq!(local_depth(r"c:\windows"), Some(1));
        assert_eq!(local_depth(r"c:\windows\temp"), Some(2));
        assert_eq!(local_depth(r"\\server\share\temp\x"), None);
        assert_eq!(local_depth(r"volume{abc}\temp\x"), None);
        assert_eq!(local_depth(""), None);
        assert_eq!(local_depth("temp"), None);
        assert!(!root_shape_ok("c:"));
        assert!(!root_shape_ok(r"c:\temp"));
        assert!(!root_shape_ok(r"c:\windows\..\x"));
        assert!(root_shape_ok(r"c:\windows\temp"));
        assert!(!root_shape_ok(r"\\server\share\a\b\temp"));
    }

    #[test]
    fn pick_user_temp_never_falls_back() {
        use std::ffi::OsString;
        let abs = OsString::from(r"C:\Users\me\AppData\Local\Temp");
        assert_eq!(
            pick_user_temp(Some(abs.clone()), None),
            Some(PathBuf::from(r"C:\Users\me\AppData\Local\Temp"))
        );
        // TMP wins over TEMP; blank TMP is ignored like GetTempPath does.
        assert_eq!(
            pick_user_temp(Some(OsString::from("  ")), Some(abs.clone())),
            Some(PathBuf::from(r"C:\Users\me\AppData\Local\Temp"))
        );
        // Unset / empty -> no user temp root at all (never USERPROFILE, never C:\Windows).
        assert_eq!(pick_user_temp(None, None), None);
        assert_eq!(
            pick_user_temp(Some(OsString::new()), Some(OsString::new())),
            None
        );
        // Relative / drive-relative / rooted-without-drive values would resolve against the CWD.
        assert_eq!(pick_user_temp(Some(OsString::from(r"Temp")), None), None);
        assert_eq!(pick_user_temp(Some(OsString::from(r"C:Temp")), None), None);
        assert_eq!(pick_user_temp(Some(OsString::from(r"\Temp")), None), None);
    }

    #[test]
    fn temp_policy_accepts_only_temp_shaped_roots() {
        let policy = TempPolicy::new(
            Some(Path::new(r"C:\Users\me\AppData\Local")),
            Some(Path::new(r"C:\Users\me")),
            Some(Path::new(r"C:\Users")),
            Path::new(r"C:\Windows"),
            Some(Path::new(r"C:\ProgramData")),
        );
        for ok in [
            r"c:\users\me\appdata\local\temp",
            r"c:\users\me\appdata\local\temp\2",
            r"c:\windows\temp",
            r"d:\scratch\temp",
            r"d:\scratch\tmp",
            r"d:\scratch\temp\3",
            r"c:\users\me\work\temp",
        ] {
            assert!(policy.accepts(ok), "{ok} should be accepted");
        }
        for bad in [
            "",
            "c:",
            r"c:\temp", // too shallow
            r"d:\temp",
            r"c:\windows",
            r"c:\windows\system32\temp",
            r"c:\windows\systemtemp",
            r"c:\users\me",
            r"c:\users\me\appdata",
            r"c:\users\me\appdata\local",
            r"c:\users\other\appdata\local\temp", // another user's profile
            r"c:\users\public\temp",
            r"c:\programdata\vendor\temp",
            r"d:\data\games",
            r"d:\data\12",
            r"\\server\share\x\temp",
            r"c:\users\me\appdata\local\temp\..\..",
        ] {
            assert!(!policy.accepts(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn user_temp_guard_refuses_system_and_profile_folders() {
        let deny = DenyList::build();
        let now = SystemTime::now();
        let mut bad: Vec<PathBuf> = vec![
            windows_dir(),
            windows_dir().join("System32"),
            PathBuf::from(format!(r"{}\", crate::util::system_drive())),
        ];
        bad.extend(dirs::home_dir());
        bad.extend(dirs::data_local_dir());
        bad.extend(dirs::data_dir());
        bad.extend(dirs::document_dir());
        bad.extend(dirs::home_dir().and_then(|h| h.parent().map(Path::to_path_buf)));
        bad.extend(dirs::data_local_dir().and_then(|l| l.parent().map(Path::to_path_buf)));
        for p in bad {
            assert!(
                plan_root(&RootSpec::user_temp(p.clone()), &deny, now).is_none(),
                "%TEMP% = {} must be refused",
                p.display()
            );
        }
        // A temp-shaped folder inside this run's temp directory is accepted.
        let t = TempTree::new("usertemp");
        let custom = t.base.join("Temp");
        fs::create_dir_all(&custom).unwrap();
        assert!(plan_root(&RootSpec::user_temp(custom), &deny, now).is_some());
    }

    #[test]
    fn ancestors_of_protected_folders_are_never_roots() {
        let deny = DenyList::build();
        let now = SystemTime::now();
        // `AppData` (parent of Local/Roaming) and `Users` would previously have passed as roots.
        for p in [
            dirs::data_local_dir().and_then(|l| l.parent().map(Path::to_path_buf)),
            dirs::home_dir().and_then(|h| h.parent().map(Path::to_path_buf)),
            Some(windows_dir()),
        ]
        .into_iter()
        .flatten()
        {
            assert!(
                plan_root(&all_filter_spec(&p), &deny, now).is_none(),
                "{} must be rejected",
                p.display()
            );
        }
    }

    #[test]
    fn stale_filter_skips_recent_files() {
        use std::os::windows::fs::FileTimesExt;
        let t = TempTree::new("stale");
        let root = t.base.join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("fresh.tmp"), b"new").unwrap();
        let old_path = root.join("old.tmp");
        fs::write(&old_path, b"old!").unwrap();
        let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 3600);
        let f = fs::OpenOptions::new().write(true).open(&old_path).unwrap();
        f.set_times(
            fs::FileTimes::new()
                .set_modified(two_days_ago)
                .set_created(two_days_ago),
        )
        .unwrap();
        drop(f);
        // Old mtime but fresh creation time (freshly extracted installer payload).
        let extracted = root.join("extracted.dll");
        fs::write(&extracted, b"x").unwrap();
        let f = fs::OpenOptions::new().write(true).open(&extracted).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(two_days_ago))
            .unwrap();
        drop(f);

        let deny = DenyList::build();
        let spec = RootSpec::dir(root.clone(), true, Filter::Stale(RECENT_GUARD));
        let plan = plan_root(&spec, &deny, SystemTime::now()).unwrap();
        let names: Vec<String> = plan.files.iter().map(|c| norm_path(&c.path)).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(names[0].ends_with("old.tmp"));
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 1);
        assert!(root.join("fresh.tmp").exists());
        assert!(extracted.exists());
        assert!(!old_path.exists());
    }

    #[test]
    fn hard_linked_files_are_not_deleted() {
        let t = TempTree::new("hardlink");
        let root = t.base.join("root");
        let outside = t.base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.bin"), b"keep").unwrap();
        fs::hard_link(outside.join("precious.bin"), root.join("alias.bin")).unwrap();
        fs::write(root.join("junk.tmp"), b"j").unwrap();
        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).unwrap();
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 1);
        assert_eq!(c.skipped, 1);
        assert!(root.join("alias.bin").exists());
        assert_eq!(fs::read(outside.join("precious.bin")).unwrap(), b"keep");
    }

    #[test]
    fn junction_parent_swap_after_planning_is_refused() {
        // Plan a root, then replace one of its sub-directories with a junction to an outside
        // folder holding a file of the same name: the stale candidate must not be deleted.
        let t = TempTree::new("swap");
        let root = t.base.join("root");
        let outside = t.base.join("outside");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("sub").join("same.tmp"), b"1").unwrap();
        fs::write(outside.join("same.tmp"), b"victim").unwrap();
        let deny = DenyList::build();
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).unwrap();
        assert_eq!(plan.files.len(), 1);
        fs::remove_file(root.join("sub").join("same.tmp")).unwrap();
        fs::remove_dir(root.join("sub")).unwrap();
        assert!(make_junction(&root.join("sub"), &outside));
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 0);
        assert_eq!(c.skipped, 1);
        assert_eq!(fs::read(outside.join("same.tmp")).unwrap(), b"victim");
        assert!(fs::symlink_metadata(root.join("sub")).is_ok());
    }

    #[test]
    fn env_roots_come_from_known_folders() {
        let env = Env::current();
        assert!(env.windir.is_absolute());
        for p in [&env.local_appdata, &env.roaming_appdata, &env.programdata]
            .into_iter()
            .flatten()
        {
            assert!(p.is_absolute(), "{}", p.display());
        }
        // Every planned root of every file category passes the shape check.
        let deny = DenyList::build();
        for id in CategoryId::ALL {
            for plan in plan_category(id, &env, &deny) {
                assert!(root_shape_ok(&plan.root_norm), "{}", plan.root_norm);
                assert!(!deny.is_denied(&plan.root_norm), "{}", plan.root_norm);
            }
        }
    }
}
