//! Cache cleanup engine (CONTRACT §3). Internal names (`scan_trash`, `purge_trash`) are not UI
//! copy.
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
//! * `scan_trash` and `purge_trash` share the same enumerator (`plan_category`) and the same
//!   skip rules (running apps, pending Windows updates, dump retention), so numbers match.
//! * Crash dumps keep the 5 newest per folder and anything younger than 30 days; `MEMORY.DMP` is
//!   its own explicit opt-in. Prefetch is never touched.
//! * The Delivery Optimization cache is cleared only through Microsoft's cmdlet, never by
//!   deleting files under the NetworkService profile.
//! * Every purge writes a JSONL audit log; without it the purge does not start.

use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOLEAN, HANDLE, HWND};
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

use crate::purge_log::PurgeLog;
use crate::state::AppState;
use crate::system_info::{is_admin, query_soft, wmi_connection, NS_CIMV2};
use crate::util::{
    fmt_bytes, hklm_key_state, hklm_value_state, known_folder, now_ms, to_wide, unix_ms,
    win32_code, windows_dir, OwnedHandle,
};

const REPARSE_ATTR: u32 = FILE_ATTRIBUTE_REPARSE_POINT.0; // 0x400
const DIRECTORY_ATTR: u32 = FILE_ATTRIBUTE_DIRECTORY.0; // 0x10
const THIRTY_DAYS: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Temp / Windows Update files touched within this window are considered in use.
const RECENT_GUARD: Duration = Duration::from_secs(24 * 60 * 60);
/// A category root must be at least this many components below the drive root
/// (`C:\Windows\Temp` = 2).
const MIN_ROOT_DEPTH: usize = 2;
const MAX_DEPTH: usize = 64;
/// Crash dumps: the newest N per folder are always kept (CONTRACT §3 rule 7).
const KEEP_NEWEST_DUMPS: usize = 5;
/// `Delete-DeliveryOptimizationCache` time limit (CONTRACT §3 rule 10).
const DO_TIMEOUT: Duration = Duration::from_secs(120);
const DO_ACTION: &str = "Delete-DeliveryOptimizationCache";
const RECYCLE_ACTION: &str = "SHEmptyRecycleBinW";

pub const NOTE_NEEDS_ADMIN: &str = "Needs administrator rights.";
pub const NOTE_UPDATE_PENDING: &str =
    "Skipped the Windows Update download cache: an update is waiting to install or restart.";
const SHADER_DESCRIPTION: &str =
    "Only clear if a game shows corrupted graphics. Expect stutter while caches rebuild.";
const DUMPS_DESCRIPTION: &str = "Keeps the 5 newest dumps and anything less than 30 days old. Windows and support staff use dumps to diagnose crashes.";
const MEMORY_DUMP_TAIL: &str = "Delete it only if you do not need it for troubleshooting.";

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
    /// False when the category cannot run in this session (needs administrator rights).
    pub available: bool,
    pub unavailable_reason: Option<String>,
    /// Display-ready sentence about parts that will be skipped, or null.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashScan {
    pub categories: Vec<TrashCategory>,
    /// Bytes of available categories only.
    pub total_bytes: u64,
    pub duration_ms: u64,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeCategoryResult {
    pub id: String,
    pub label: String,
    pub freed_bytes: u64,
    pub deleted: u64,
    pub skipped: u64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub freed_bytes: u64,
    pub files_deleted: u64,
    pub files_skipped: u64,
    pub duration_ms: u64,
    pub per_category: Vec<PurgeCategoryResult>,
    /// Absolute path of this run's JSONL audit log.
    pub log_path: String,
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
    WuCache,
    Logs,
    Dumps,
    MemoryDump,
    Shader,
    Recycle,
    Browser,
}

impl CategoryId {
    /// Display / processing order (CONTRACT §3.1 table order).
    pub const ALL: [CategoryId; 8] = [
        CategoryId::Temp,
        CategoryId::WuCache,
        CategoryId::Logs,
        CategoryId::Dumps,
        CategoryId::MemoryDump,
        CategoryId::Shader,
        CategoryId::Recycle,
        CategoryId::Browser,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CategoryId::Temp => "temp",
            CategoryId::WuCache => "wu-cache",
            CategoryId::Logs => "logs",
            CategoryId::Dumps => "dumps",
            CategoryId::MemoryDump => "memory-dump",
            CategoryId::Shader => "shader",
            CategoryId::Recycle => "recycle",
            CategoryId::Browser => "browser",
        }
    }

    pub fn parse(s: &str) -> Option<CategoryId> {
        let s = s.trim();
        CategoryId::ALL
            .into_iter()
            .find(|c| c.as_str().eq_ignore_ascii_case(s))
    }

    /// Exact labels (CONTRACT §3.1).
    pub fn label(self) -> &'static str {
        match self {
            CategoryId::Temp => "Temporary files",
            CategoryId::WuCache => "Windows Update cache",
            CategoryId::Logs => "Error reports and old logs",
            CategoryId::Dumps => "Old crash dumps",
            CategoryId::MemoryDump => "Full memory dump (MEMORY.DMP)",
            CategoryId::Shader => "Shader caches",
            CategoryId::Recycle => "Recycle Bin",
            CategoryId::Browser => "Browser and Discord caches",
        }
    }

    /// Static descriptions; `shader` and `memory-dump` are completed by [`describe`].
    fn base_description(self) -> &'static str {
        match self {
            CategoryId::Temp => "Files in your temporary folder (and the Windows temporary folder when running as administrator) that have not changed for 24 hours. Files in use are skipped.",
            CategoryId::WuCache => "Windows Update downloads older than 24 hours, and the Delivery Optimization cache cleared through the Windows cmdlet.",
            CategoryId::Logs => "Windows Error Reporting queues and archives, and component servicing logs older than 30 days.",
            CategoryId::Dumps => DUMPS_DESCRIPTION,
            CategoryId::MemoryDump => "Written by Windows after a system crash. Delete it only if you do not need it for troubleshooting.",
            CategoryId::Shader => SHADER_DESCRIPTION,
            CategoryId::Recycle => "Permanently deletes everything in the Recycle Bin.",
            CategoryId::Browser => "Chrome, Edge, Firefox and Discord caches. Logins, cookies and history are never touched, and apps that are open are skipped.",
        }
    }

    /// Never run by the F9 quick path.
    pub fn optional(self) -> bool {
        matches!(
            self,
            CategoryId::Dumps
                | CategoryId::MemoryDump
                | CategoryId::Shader
                | CategoryId::Recycle
                | CategoryId::Browser
        )
    }

    pub fn requires_admin(self) -> bool {
        matches!(
            self,
            CategoryId::WuCache | CategoryId::Logs | CategoryId::Dumps | CategoryId::MemoryDump
        )
    }

    /// Default selection (CONTRACT §3.1): only temp, wu-cache and logs.
    pub fn default_enabled(self) -> bool {
        matches!(
            self,
            CategoryId::Temp | CategoryId::WuCache | CategoryId::Logs
        )
    }
}

/// Apps whose caches are skipped while they run (CONTRACT §3 rule 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum App {
    Chrome,
    Edge,
    Firefox,
    Discord,
}

impl App {
    pub const ALL: [App; 4] = [App::Chrome, App::Edge, App::Firefox, App::Discord];

    pub fn display_name(self) -> &'static str {
        match self {
            App::Chrome => "Chrome",
            App::Edge => "Edge",
            App::Firefox => "Firefox",
            App::Discord => "Discord",
        }
    }

    /// Process image name (`msedgewebview2.exe` deliberately does not count for Edge).
    pub fn process_name(self) -> &'static str {
        match self {
            App::Chrome => "chrome.exe",
            App::Edge => "msedge.exe",
            App::Firefox => "firefox.exe",
            App::Discord => "Discord.exe",
        }
    }
}

/// GPU vendors present in the machine (from `Win32_VideoController.PNPDeviceID`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GpuVendors {
    pub nvidia: bool,
    pub amd: bool,
    pub intel: bool,
}

impl GpuVendors {
    pub fn from_pnp_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> Self {
        let mut v = GpuVendors::default();
        for id in ids {
            let u = id.to_ascii_uppercase();
            if !u.starts_with(r"PCI\") {
                continue;
            }
            v.nvidia |= u.contains("VEN_10DE");
            v.amd |= u.contains("VEN_1002");
            v.intel |= u.contains("VEN_8086");
        }
        v
    }

    /// Shader-cache folders for the detected vendors, as (base, relative path). `D3DSCache` is
    /// always included.
    fn shader_folders(self) -> Vec<(ShaderBase, &'static str)> {
        let mut out = vec![(ShaderBase::LocalAppData, "D3DSCache")];
        if self.nvidia {
            out.push((ShaderBase::LocalAppData, r"NVIDIA\DXCache"));
            out.push((ShaderBase::LocalAppData, r"NVIDIA\GLCache"));
            out.push((ShaderBase::ProgramData, r"NVIDIA Corporation\NV_Cache"));
        }
        if self.amd {
            out.push((ShaderBase::LocalAppData, r"AMD\DxCache"));
            out.push((ShaderBase::LocalAppData, r"AMD\DxcCache"));
            out.push((ShaderBase::LocalAppData, r"AMD\VkCache"));
            out.push((ShaderBase::LocalAppData, r"AMD\GLCache"));
        }
        if self.intel {
            out.push((ShaderBase::LocalAppData, r"Intel\ShaderCache"));
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShaderBase {
    LocalAppData,
    ProgramData,
}

/// Why a file inside a root is left alone (logged as `result:"skipped"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldReason {
    TooNew,
    KeptNewest,
    DenyList,
}

impl HoldReason {
    fn as_str(self) -> &'static str {
        match self {
            HoldReason::TooNew => "tooNew",
            HoldReason::KeptNewest => "keptNewest",
            HoldReason::DenyList => "denyList",
        }
    }
}

/// Outcome of a filter for one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// A deletion candidate.
    Take,
    /// A file of this category that a rule keeps (logged at purge time).
    Hold(HoldReason),
    /// Not part of this category at all.
    Ignore,
}

/// Which files inside a root qualify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Filter {
    /// Every regular file.
    All,
    /// `*.dmp`, `*.mdmp`, `*.hdmp`; the newest 5 and anything < 30 days old are kept
    /// (applied per folder after enumeration).
    Dumps,
    /// The single file `MEMORY.DMP` (explicit opt-in, no age guard).
    MemoryDump,
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

/// A condition that skips a whole root while it holds (CONTRACT §3 rules 8–9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    None,
    /// Skipped while this app runs.
    App(App),
    /// `SoftwareDistribution\Download`: skipped while an update is pending or installing.
    WuDownload,
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
    gate: Gate,
}

impl RootSpec {
    fn dir(path: PathBuf, recursive: bool, filter: Filter) -> Self {
        Self {
            path,
            single_file: false,
            recursive,
            filter,
            guard: RootGuard::Fixed,
            gate: Gate::None,
        }
    }
    fn file(path: PathBuf, filter: Filter) -> Self {
        Self {
            path,
            single_file: true,
            recursive: false,
            filter,
            guard: RootGuard::Fixed,
            gate: Gate::None,
        }
    }
    fn user_temp(path: PathBuf) -> Self {
        Self {
            path,
            single_file: false,
            recursive: true,
            filter: Filter::Stale(RECENT_GUARD),
            guard: RootGuard::UserTemp,
            gate: Gate::None,
        }
    }
    fn gated(mut self, gate: Gate) -> Self {
        self.gate = gate;
        self
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
            FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_ProgramData,
            FOLDERID_RoamingAppData,
        };
        let profile = known_folder(&FOLDERID_Profile);
        Self {
            windir: windows_dir(),
            temp: pick_user_temp(std::env::var_os("TMP"), std::env::var_os("TEMP")),
            local_appdata: within_profile(
                known_folder(&FOLDERID_LocalAppData),
                profile.as_deref(),
            ),
            roaming_appdata: within_profile(
                known_folder(&FOLDERID_RoamingAppData),
                profile.as_deref(),
            ),
            programdata: known_folder(&FOLDERID_ProgramData),
        }
    }
}

/// `folder` if it lies strictly inside the user's profile folder, else `None`.
///
/// `LocalAppData` and `RoamingAppData` can be redirected per user (`HKCU\...\User Shell
/// Folders`) by any non-elevated process. Without this check such a redirect could point the
/// elevated cleaner (and the audit log) at another user's profile or a system folder. The
/// profile folder itself comes from the user's token and cannot be redirected that way.
pub(crate) fn within_profile(folder: Option<PathBuf>, profile: Option<&Path>) -> Option<PathBuf> {
    let folder = folder?;
    let f = norm_path(&folder);
    let p = norm_path(profile?);
    (folder.is_absolute()
        && !has_parent_components(&f)
        && local_depth(&p).is_some()
        && is_strictly_under(&f, &p))
    .then_some(folder)
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

/// Everything the category rules depend on besides the file system: base folders, the
/// deny-list, elevation and the skip conditions of CONTRACT §3 rules 8–9.
struct Context {
    env: Env,
    deny: DenyList,
    is_admin: bool,
    /// Apps (rule 8) currently running for this user.
    running: Vec<App>,
    /// A Windows update is pending a restart or installing (rule 9).
    wu_pending: bool,
    gpus: GpuVendors,
}

impl Context {
    /// Gathers only what the given categories need (process list, registry, WMI).
    fn current(ids: &[CategoryId]) -> Self {
        let has = |c: CategoryId| ids.contains(&c);
        Self {
            env: Env::current(),
            deny: DenyList::build(),
            is_admin: is_admin(),
            running: if has(CategoryId::Browser) {
                detect_running_apps()
            } else {
                Vec::new()
            },
            wu_pending: has(CategoryId::WuCache) && detect_wu_pending(),
            gpus: if has(CategoryId::Shader) {
                detect_gpu_vendors()
            } else {
                GpuVendors::default()
            },
        }
    }
}

fn category_roots(id: CategoryId, ctx: &Context) -> Vec<RootSpec> {
    use Filter::*;
    let env = &ctx.env;
    let mut roots = Vec::new();
    let w = &env.windir;
    match id {
        CategoryId::Temp => {
            if let Some(t) = &env.temp {
                roots.push(RootSpec::user_temp(t.clone()));
            }
            if ctx.is_admin {
                roots.push(RootSpec::dir(w.join("Temp"), true, Stale(RECENT_GUARD)));
            }
        }
        CategoryId::WuCache => {
            roots.push(
                RootSpec::dir(
                    w.join(r"SoftwareDistribution\Download"),
                    true,
                    Stale(RECENT_GUARD),
                )
                .gated(Gate::WuDownload),
            );
            // The Delivery Optimization cache is not a file root: it is cleared only through
            // the Windows cmdlet (rule 10, `clear_delivery_optimization`).
        }
        CategoryId::Logs => {
            if let Some(pd) = &env.programdata {
                for rel in [
                    r"Microsoft\Windows\WER\ReportArchive",
                    r"Microsoft\Windows\WER\ReportQueue",
                ] {
                    roots.push(RootSpec::dir(pd.join(rel), true, All));
                }
            }
            if let Some(l) = &env.local_appdata {
                for rel in [
                    r"Microsoft\Windows\WER\ReportArchive",
                    r"Microsoft\Windows\WER\ReportQueue",
                ] {
                    roots.push(RootSpec::dir(l.join(rel), true, All));
                }
            }
            roots.push(RootSpec::dir(w.join(r"Logs\CBS"), false, CbsLogsOld));
        }
        CategoryId::Dumps => {
            roots.push(RootSpec::dir(w.join("Minidump"), false, Dumps));
            if let Some(l) = &env.local_appdata {
                roots.push(RootSpec::dir(l.join("CrashDumps"), false, Dumps));
            }
        }
        CategoryId::MemoryDump => {
            roots.push(RootSpec::file(w.join("MEMORY.DMP"), MemoryDump));
        }
        CategoryId::Shader => {
            for (base, rel) in ctx.gpus.shader_folders() {
                let base = match base {
                    ShaderBase::LocalAppData => &env.local_appdata,
                    ShaderBase::ProgramData => &env.programdata,
                };
                if let Some(b) = base {
                    roots.push(RootSpec::dir(b.join(rel), true, All));
                }
            }
        }
        CategoryId::Browser => {
            let cache = BrowserCache {
                allow_sqlite: false,
            };
            if let Some(l) = &env.local_appdata {
                for (app, user_data) in [
                    (App::Chrome, l.join(r"Google\Chrome\User Data")),
                    (App::Edge, l.join(r"Microsoft\Edge\User Data")),
                ] {
                    for profile in chromium_profiles(&user_data) {
                        for rel in [r"Cache\Cache_Data", "Code Cache", "GPUCache"] {
                            roots.push(
                                RootSpec::dir(profile.join(rel), true, cache).gated(Gate::App(app)),
                            );
                        }
                    }
                    for rel in ["ShaderCache", "GrShaderCache"] {
                        roots.push(
                            RootSpec::dir(user_data.join(rel), true, cache).gated(Gate::App(app)),
                        );
                    }
                }
                for profile in list_plain_subdirs(&l.join(r"Mozilla\Firefox\Profiles")) {
                    roots.push(
                        RootSpec::dir(
                            profile.join("cache2"),
                            true,
                            BrowserCache { allow_sqlite: true },
                        )
                        .gated(Gate::App(App::Firefox)),
                    );
                }
            }
            if let Some(r) = &env.roaming_appdata {
                for rel in ["Cache", "Code Cache", "GPUCache"] {
                    roots.push(
                        RootSpec::dir(r.join("discord").join(rel), true, cache)
                            .gated(Gate::App(App::Discord)),
                    );
                }
            }
        }
        CategoryId::Recycle => {}
    }
    roots
}

/// `D3DSCache, NVIDIA\DXCache, …` for the shader description.
fn shader_folder_names(gpus: GpuVendors) -> String {
    gpus.shader_folders()
        .into_iter()
        .map(|(_, rel)| rel)
        .collect::<Vec<_>>()
        .join(", ")
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

        // Nexum's own state (the fan write-ahead flag) and install folder (Nexum.exe and the
        // agent next to it), wherever they are.
        if let Some(pd) = &programdata {
            prefixes.push(pd.join("Nexum"));
        }
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
        {
            prefixes.push(dir);
        }
        never_root.push(windir.clone());
        never_root.extend(local_appdata.clone());
        never_root.extend(roaming_appdata);
        never_root.extend(programdata.clone());
        for var in ["ProgramData", "LOCALAPPDATA", "APPDATA", "USERPROFILE"] {
            if let Some(v) = std::env::var_os(var) {
                never_root.push(PathBuf::from(v));
            }
        }

        // Only a LocalAppData inside the profile makes `<LocalAppData>\Temp` a standard temp
        // location (the never-root entries above may use the unchecked value: they only add
        // restrictions).
        let scoped_local = within_profile(local_appdata.clone(), profile.as_deref());
        let temp = TempPolicy::new(
            scoped_local.as_deref(),
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

fn is_dump_name(name: &str) -> bool {
    matches!(extension_lower(name).as_str(), "dmp" | "mdmp" | "hdmp")
}

impl Filter {
    /// `rel` = normalized path relative to the root (components separated by `\`).
    fn verdict(self, name: &str, rel: &str, md: &std::fs::Metadata, now: SystemTime) -> Verdict {
        match self {
            Filter::All => Verdict::Take,
            Filter::Stale(age) => {
                if stale(md, age, now) {
                    Verdict::Take
                } else {
                    Verdict::Hold(HoldReason::TooNew)
                }
            }
            // Age and keep-newest are applied per folder once all dumps are known.
            Filter::Dumps => {
                if is_dump_name(name) {
                    Verdict::Take
                } else {
                    Verdict::Ignore
                }
            }
            Filter::MemoryDump => {
                if name.eq_ignore_ascii_case("memory.dmp") {
                    Verdict::Take
                } else {
                    Verdict::Ignore
                }
            }
            Filter::CbsLogsOld => {
                if extension_lower(name) != "log" || name.eq_ignore_ascii_case("cbs.log") {
                    Verdict::Ignore
                } else if older_than(md, THIRTY_DAYS, now) {
                    Verdict::Take
                } else {
                    Verdict::Hold(HoldReason::TooNew)
                }
            }
            Filter::BrowserCache { allow_sqlite } => {
                if rel.split('\\').any(is_protected_browser_component) {
                    return Verdict::Ignore;
                }
                let ext = extension_lower(name);
                if !allow_sqlite && (ext == "sqlite" || ext == "sqlite-wal" || ext == "sqlite-shm")
                {
                    return Verdict::Ignore;
                }
                Verdict::Take
            }
        }
    }

    /// Whether an empty sub-directory may be removed after the purge. Under an age guard, a
    /// folder created or changed recently (timestamps taken at enumeration, before any file in
    /// it is deleted) is left alone: it may be the working folder of an installer or app that
    /// is running right now.
    fn dir_removable(self, md: &std::fs::Metadata, now: SystemTime) -> bool {
        match self {
            Filter::Stale(age) => stale(md, age, now),
            _ => true,
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
    /// Last-write time, unix ms (for the audit log and the dump rules).
    pub mtime: Option<u64>,
}

/// A file of the category that a rule keeps (too new, among the newest dumps, deny-listed).
#[derive(Debug, Clone)]
pub struct Held {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: Option<u64>,
    pub reason: HoldReason,
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
    /// Files kept by a rule; never deleted, only logged.
    pub held: Vec<Held>,
    /// Sub-directories (never the root), for bottom-up empty-dir removal.
    pub dirs: Vec<(usize, PathBuf)>,
}

impl RootPlan {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|c| c.size).sum()
    }
}

/// Crash-dump retention (CONTRACT §3 rule 7), per folder: the `KEEP_NEWEST_DUMPS` newest by
/// mtime are kept, and of the rest only files older than 30 days are deleted. An unknown mtime
/// counts as brand new (fail closed).
fn apply_dump_rules(files: Vec<Candidate>, now_ms: u64) -> (Vec<Candidate>, Vec<Held>) {
    let mut files = files;
    files.sort_by(|a, b| {
        b.mtime
            .unwrap_or(u64::MAX)
            .cmp(&a.mtime.unwrap_or(u64::MAX))
            .then_with(|| a.path.cmp(&b.path))
    });
    let cutoff = now_ms.saturating_sub(THIRTY_DAYS.as_millis() as u64);
    let mut take = Vec::new();
    let mut held = Vec::new();
    for (i, c) in files.into_iter().enumerate() {
        let reason = if i < KEEP_NEWEST_DUMPS {
            Some(HoldReason::KeptNewest)
        } else if c.mtime.map_or(true, |m| m >= cutoff) {
            Some(HoldReason::TooNew)
        } else {
            None
        };
        match reason {
            Some(reason) => held.push(Held {
                path: c.path,
                size: c.size,
                mtime: c.mtime,
                reason,
            }),
            None => take.push(c),
        }
    }
    (take, held)
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
        if spec.filter.verdict(&name, &name.to_lowercase(), &md, now) != Verdict::Take {
            return None;
        }
        let mtime = md.modified().ok().and_then(unix_ms);
        return Some(RootPlan {
            root: canon.clone(),
            root_norm: canon_norm,
            single_file: true,
            files: vec![Candidate {
                path: canon,
                size: md.len(),
                mtime,
            }],
            held: Vec::new(),
            dirs: Vec::new(),
        });
    }

    if !md.is_dir() || !deny.root_allowed(&canon_norm, spec.guard) {
        return None;
    }

    let mut files = Vec::new();
    let mut held = Vec::new();
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
            if !is_strictly_under(&pn, &canon_norm) {
                continue;
            }
            let mtime = emd.modified().ok().and_then(unix_ms);
            if deny.is_denied(&pn) {
                if emd.is_file() {
                    held.push(Held {
                        path,
                        size: emd.len(),
                        mtime,
                        reason: HoldReason::DenyList,
                    });
                }
                continue;
            }
            let rel = &pn[canon_norm.len() + 1..];
            if emd.is_dir() {
                if spec.recursive && depth < MAX_DEPTH && spec.filter.may_descend(rel) {
                    if spec.filter.dir_removable(&emd, now) {
                        dirs.push((depth + 1, path.clone()));
                    }
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !emd.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            match spec.filter.verdict(&name, rel, &emd, now) {
                Verdict::Take => files.push(Candidate {
                    path,
                    size: emd.len(),
                    mtime,
                }),
                Verdict::Hold(reason) => held.push(Held {
                    path,
                    size: emd.len(),
                    mtime,
                    reason,
                }),
                Verdict::Ignore => {}
            }
        }
    }

    if spec.filter == Filter::Dumps {
        // Dump roots are non-recursive, so one root is one folder.
        let now_ms = unix_ms(now).unwrap_or(0);
        let (take, keep) = apply_dump_rules(files, now_ms);
        files = take;
        held.extend(keep);
    }

    Some(RootPlan {
        root: canon,
        root_norm: canon_norm,
        single_file: false,
        files,
        held,
        dirs,
    })
}

/// Why a whole root is skipped this time (CONTRACT §3 rules 8–9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    AppRunning(App),
    UpdatePending,
}

impl BlockReason {
    fn as_str(self) -> &'static str {
        match self {
            BlockReason::AppRunning(_) => "appRunning",
            BlockReason::UpdatePending => "updatePending",
        }
    }
}

/// The enumerated roots of one category: `active` ones are cleaned, `blocked` ones are only
/// reported (and logged file by file at purge time).
#[derive(Debug, Default)]
struct CategoryPlan {
    active: Vec<RootPlan>,
    blocked: Vec<(RootPlan, BlockReason)>,
    notes: Vec<String>,
}

impl CategoryPlan {
    fn bytes(&self) -> u64 {
        self.active.iter().map(RootPlan::total_bytes).sum()
    }
    fn files(&self) -> u64 {
        self.active.iter().map(|p| p.files.len() as u64).sum()
    }
}

/// `Skipped: Chrome is open.` / `Skipped: Chrome and Edge are open.` /
/// `Skipped: Chrome, Edge and Firefox are open.`
pub fn running_apps_note(apps: &[App]) -> Option<String> {
    let names: Vec<&str> = apps.iter().map(|a| a.display_name()).collect();
    match names.as_slice() {
        [] => None,
        [one] => Some(format!("Skipped: {one} is open.")),
        [init @ .., last] => Some(format!("Skipped: {} and {last} are open.", init.join(", "))),
    }
}

fn gate_block(gate: Gate, ctx: &Context) -> Option<BlockReason> {
    match gate {
        Gate::None => None,
        Gate::App(app) if ctx.running.contains(&app) => Some(BlockReason::AppRunning(app)),
        Gate::App(_) => None,
        Gate::WuDownload if ctx.wu_pending => Some(BlockReason::UpdatePending),
        Gate::WuDownload => None,
    }
}

/// Enumerates the given roots, de-duplicating overlapping roots and splitting them into
/// active and blocked ones. Notes name only blocked roots that actually exist.
fn plan_specs(specs: Vec<RootSpec>, ctx: &Context) -> CategoryPlan {
    let now = SystemTime::now();
    let mut plans: Vec<(RootPlan, Option<BlockReason>)> = Vec::new();
    for spec in specs {
        let block = gate_block(spec.gate, ctx);
        if let Some(plan) = plan_root(&spec, &ctx.deny, now) {
            // Skip a root equal to / nested in an already planned root (e.g. %TEMP% = C:\Windows\Temp).
            if plans
                .iter()
                .any(|(p, _)| !p.single_file && is_same_or_under(&plan.root_norm, &p.root_norm))
            {
                continue;
            }
            // Drop previously planned roots that are nested inside this one.
            plans.retain(|(p, _)| {
                p.single_file || !is_strictly_under(&p.root_norm, &plan.root_norm)
            });
            plans.push((plan, block));
        }
    }

    let mut out = CategoryPlan::default();
    let mut apps: Vec<App> = Vec::new();
    let mut update_blocked = false;
    for (plan, block) in plans {
        match block {
            None => out.active.push(plan),
            Some(reason) => {
                match reason {
                    BlockReason::AppRunning(app) => {
                        if !apps.contains(&app) {
                            apps.push(app);
                        }
                    }
                    BlockReason::UpdatePending => update_blocked = true,
                }
                out.blocked.push((plan, reason));
            }
        }
    }
    apps.sort();
    if let Some(note) = running_apps_note(&apps) {
        out.notes.push(note);
    }
    if update_blocked {
        out.notes.push(NOTE_UPDATE_PENDING.to_string());
    }
    out
}

/// Enumerates every root of a file-based category.
fn plan_category(id: CategoryId, ctx: &Context) -> CategoryPlan {
    plan_specs(category_roots(id, ctx), ctx)
}

// ---------------------------------------------------------------------------------------------
// Handle-based verified deletion
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
pub enum DeleteError {
    /// The file could not be opened: Win32 error code (if known) and message.
    Open(Option<u32>, String),
    NotAllowed(&'static str),
    /// Setting the delete disposition failed: Win32 error code (if known) and message.
    Failed(Option<u32>, String),
}

const ERR_FILE_NOT_FOUND: u32 = 2;
const ERR_PATH_NOT_FOUND: u32 = 3;
const ERR_ACCESS_DENIED: u32 = 5;
const ERR_SHARING_VIOLATION: u32 = 32;
const ERR_LOCK_VIOLATION: u32 = 33;

fn win_err(e: &windows::core::Error) -> (Option<u32>, String) {
    (win32_code(e.code().0), e.message().trim().to_string())
}

/// Audit-log `(result, reason)` for a failed delete. Locked, in-use and permission-denied
/// files are "skipped" (rule 4); anything unexpected is "failed" with the OS error text.
fn delete_outcome(err: &DeleteError) -> (&'static str, String) {
    match err {
        DeleteError::Open(code, msg) | DeleteError::Failed(code, msg) => match code {
            Some(ERR_SHARING_VIOLATION) | Some(ERR_LOCK_VIOLATION) => {
                ("skipped", "locked".to_string())
            }
            Some(ERR_ACCESS_DENIED) => ("skipped", "accessDenied".to_string()),
            Some(ERR_FILE_NOT_FOUND) | Some(ERR_PATH_NOT_FOUND) => {
                ("skipped", "file no longer exists".to_string())
            }
            _ => (
                "failed",
                if msg.is_empty() {
                    "unknown error".to_string()
                } else {
                    msg.clone()
                },
            ),
        },
        DeleteError::NotAllowed("reparse point") => ("skipped", "reparsePoint".to_string()),
        DeleteError::NotAllowed("deny-listed") => ("skipped", "denyList".to_string()),
        DeleteError::NotAllowed(other) => ("skipped", (*other).to_string()),
    }
}

pub(crate) fn final_path(h: HANDLE) -> Option<String> {
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
    .map_err(|e| {
        let (code, msg) = win_err(&e);
        DeleteError::Open(code, msg)
    })?;
    let handle = OwnedHandle(handle);

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(handle.0, &mut info) }
        .map_err(|e| {
            let (code, msg) = win_err(&e);
            DeleteError::Failed(code, msg)
        })?;
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
        .map_err(|e| {
            let (code, msg) = win_err(&e);
            DeleteError::Failed(code, msg)
        })?;
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

/// What happened to one file, for the audit log.
pub struct FileOutcome<'a> {
    pub path: &'a Path,
    pub bytes: u64,
    pub mtime: Option<u64>,
    /// `"deleted" | "skipped" | "failed"`.
    pub result: &'static str,
    pub reason: Option<String>,
}

/// Deletes every candidate of a plan, then removes now-empty sub-directories bottom-up.
/// Test helper: the real purge path calls [`purge_plan_with`] so it can write the audit log.
#[cfg(test)]
pub fn purge_plan(plan: &RootPlan, deny: &DenyList) -> PurgeCounts {
    purge_plan_with(plan, deny, &mut |_: FileOutcome<'_>| {})
}

/// [`purge_plan`] reporting every candidate's outcome (and every held file) to `report`.
pub fn purge_plan_with(
    plan: &RootPlan,
    deny: &DenyList,
    report: &mut dyn FnMut(FileOutcome<'_>),
) -> PurgeCounts {
    let mut c = PurgeCounts::default();
    for h in &plan.held {
        report(FileOutcome {
            path: &h.path,
            bytes: h.size,
            mtime: h.mtime,
            result: "skipped",
            reason: Some(h.reason.as_str().to_string()),
        });
    }
    for cand in &plan.files {
        match verified_delete(&cand.path, false, plan, deny) {
            Ok(size) => {
                c.freed += size;
                c.deleted += 1;
                report(FileOutcome {
                    path: &cand.path,
                    bytes: size,
                    mtime: cand.mtime,
                    result: "deleted",
                    reason: None,
                });
            }
            Err(e) => {
                c.skipped += 1;
                let (result, reason) = delete_outcome(&e);
                report(FileOutcome {
                    path: &cand.path,
                    bytes: cand.size,
                    mtime: cand.mtime,
                    result,
                    reason: Some(reason),
                });
            }
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
// Skip conditions: running apps (rule 8), pending Windows updates (rule 9), GPU vendors
// ---------------------------------------------------------------------------------------------

/// Apps with at least one matching process. `owner` is `Some(true)` for the current user,
/// `Some(false)` for another user (ignored) and `None` when unknown (counts: fail closed).
pub fn apps_running<'a>(procs: impl IntoIterator<Item = (&'a str, Option<bool>)>) -> Vec<App> {
    let mut out: Vec<App> = Vec::new();
    for (name, owner) in procs {
        if owner == Some(false) {
            continue;
        }
        if let Some(app) = App::ALL
            .into_iter()
            .find(|a| a.process_name().eq_ignore_ascii_case(name.trim()))
        {
            if !out.contains(&app) {
                out.push(app);
            }
        }
    }
    out.sort();
    out
}

fn detect_running_apps() -> Vec<App> {
    let me = crate::procs::current_user_sid();
    let entries = crate::procs::snapshot();
    let matching: Vec<(&str, Option<bool>)> = entries
        .iter()
        .filter(|e| {
            App::ALL
                .iter()
                .any(|a| a.process_name().eq_ignore_ascii_case(&e.name))
        })
        .map(|e| {
            let owner = me
                .as_deref()
                .and_then(|sid| crate::procs::runs_as(e.pid, sid));
            (e.name.as_str(), owner)
        })
        .collect();
    apps_running(matching)
}

/// Signals that a Windows update is waiting for a restart or being installed. Each is
/// `Some(true)`, `Some(false)` or `None` (could not tell).
#[derive(Debug, Default, Clone, Copy)]
pub struct WuSignals {
    pub reboot_required: Option<bool>,
    pub reboot_pending: Option<bool>,
    pub pending_file_renames: Option<bool>,
    pub trusted_installer_running: Option<bool>,
    pub wuauserv_running: Option<bool>,
}

impl WuSignals {
    /// Conservative: anything other than a clear "no" counts as pending.
    pub fn update_pending(&self) -> bool {
        [
            self.reboot_required,
            self.reboot_pending,
            self.pending_file_renames,
            self.trusted_installer_running,
            self.wuauserv_running,
        ]
        .iter()
        .any(|s| *s != Some(false))
    }
}

const ERR_SERVICE_DOES_NOT_EXIST: u32 = 1060;

/// `Some(true)` unless the service is stopped; `Some(false)` when stopped or not installed;
/// `None` when the service manager cannot be asked. Nexum never starts or stops services.
fn service_running(name: &str) -> Option<bool> {
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT,
        SERVICE_QUERY_STATUS, SERVICE_STATUS, SERVICE_STOPPED,
    };
    let wname = to_wide(name);
    // SAFETY: null machine/database names = local SCM; handles are closed below; `wname` is
    // NUL-terminated and outlives the calls.
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).ok()?;
        let result = match OpenServiceW(scm, PCWSTR(wname.as_ptr()), SERVICE_QUERY_STATUS) {
            Ok(svc) => {
                let mut st = SERVICE_STATUS::default();
                let r = QueryServiceStatus(svc, &mut st)
                    .ok()
                    .map(|_| st.dwCurrentState != SERVICE_STOPPED);
                let _ = CloseServiceHandle(svc);
                r
            }
            Err(e) if win32_code(e.code().0) == Some(ERR_SERVICE_DOES_NOT_EXIST) => Some(false),
            Err(_) => None,
        };
        let _ = CloseServiceHandle(scm);
        result
    }
}

fn detect_wu_signals() -> WuSignals {
    WuSignals {
        reboot_required: hklm_key_state(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        ),
        reboot_pending: hklm_key_state(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        ),
        pending_file_renames: hklm_value_state(
            r"SYSTEM\CurrentControlSet\Control\Session Manager",
            "PendingFileRenameOperations",
        ),
        trusted_installer_running: service_running("TrustedInstaller"),
        wuauserv_running: service_running("wuauserv"),
    }
}

fn detect_wu_pending() -> bool {
    let s = detect_wu_signals();
    let pending = s.update_pending();
    if pending {
        eprintln!("[nexum] Windows Update download cache skipped: {s:?}");
    }
    pending
}

#[derive(Deserialize, Debug)]
struct VideoControllerRow {
    #[serde(rename = "PNPDeviceID", default)]
    pnp_device_id: Option<String>,
}

fn detect_gpu_vendors() -> GpuVendors {
    let conn = wmi_connection(NS_CIMV2).ok();
    let rows: Vec<VideoControllerRow> = query_soft(
        conn.as_ref(),
        "SELECT PNPDeviceID FROM Win32_VideoController",
    );
    GpuVendors::from_pnp_ids(rows.iter().filter_map(|r| r.pnp_device_id.as_deref()))
}

// ---------------------------------------------------------------------------------------------
// Delivery Optimization (rule 10): Microsoft's cmdlet only, never direct deletes
// ---------------------------------------------------------------------------------------------

fn do_cache_dir(env: &Env) -> PathBuf {
    env.windir.join(
        r"ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache",
    )
}

/// Read-only `(bytes, files)` of a folder tree; never follows links. `Some((0, 0))` when the
/// folder does not exist, `None` when it cannot be read.
fn folder_size(root: &Path) -> Option<(u64, u64)> {
    let md = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some((0, 0)),
        Err(_) => return None,
    };
    if is_reparse(&md) || !md.is_dir() {
        return None;
    }
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) if depth == 0 => return None,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let Ok(emd) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if is_reparse(&emd) {
                continue;
            }
            if emd.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), depth + 1));
                }
            } else if emd.is_file() {
                bytes += emd.len();
                files += 1;
            }
        }
    }
    Some((bytes, files))
}

/// Turns the cmdlet's error output into the `<reason>` of the DO note (no trailing period).
pub fn do_failure_reason(stderr: &str, exit_code: Option<i32>) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("is not recognized") || lower.contains("commandnotfoundexception") {
        return "the Delete-DeliveryOptimizationCache cmdlet is not available on this system"
            .to_string();
    }
    let first = stderr.lines().map(str::trim).find(|l| !l.is_empty());
    match first {
        Some(line) => {
            let line = line
                .strip_prefix("Delete-DeliveryOptimizationCache :")
                .unwrap_or(line)
                .trim();
            let short: String = line.chars().take(160).collect();
            let short = short.trim().trim_end_matches('.').trim().to_string();
            if short.is_empty() {
                "the cmdlet failed".to_string()
            } else {
                short
            }
        }
        None => match exit_code {
            Some(c) => format!("the cmdlet failed (exit code {c})"),
            None => "the cmdlet failed".to_string(),
        },
    }
}

/// The `-Command` text for rule 10.
///
/// The cmdlet runs in an elevated Windows PowerShell whose module search a standard user could
/// otherwise steer (`PSModulePath` in `HKCU\Environment`, the personal
/// `Documents\WindowsPowerShell\Modules` folder, the module analysis cache). Module
/// auto-loading is therefore switched off, and the three modules the cmdlet needs (its own and
/// the two whose commands it calls: `Invoke-CimMethod`, `Write-Host`) are imported by absolute
/// path from the real Windows directory. The call itself is module-qualified.
pub fn do_script(windir: &Path) -> String {
    let modules = windir
        .join(r"System32\WindowsPowerShell\v1.0\Modules")
        .to_string_lossy()
        .replace('\'', "''");
    let import =
        |rel: &str| format!("Import-Module -Name '{modules}\\{rel}' -DisableNameChecking; ");
    let mut script = String::from(
        "$ErrorActionPreference = 'Stop'; $PSModuleAutoloadingPreference = 'None'; ",
    );
    script.push_str(&import(
        r"Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1",
    ));
    script.push_str(&import(r"CimCmdlets\CimCmdlets.psd1"));
    script.push_str(&import(r"DeliveryOptimization\DeliveryOptimization.psd1"));
    script.push_str(r"DeliveryOptimization\Delete-DeliveryOptimizationCache -Force");
    script
}

/// The complete environment of the elevated PowerShell child; nothing is inherited. The app's
/// own environment is built from the user's (`HKCU\Environment`), which a standard-user process
/// can set: `PSModulePath`, `COR_PROFILER`, `COMPlus_*`, `APPDOMAIN_MANAGER_*` and the like
/// would otherwise load code into the elevated child.
pub fn do_child_env(windir: &Path) -> Vec<(&'static str, String)> {
    let w = windir.to_string_lossy().to_string();
    vec![
        ("SystemRoot", w.clone()),
        ("windir", w.clone()),
        ("SystemDrive", crate::util::system_drive()),
        (
            "PATH",
            format!(r"{w}\System32;{w};{w}\System32\Wbem;{w}\System32\WindowsPowerShell\v1.0"),
        ),
        ("PATHEXT", ".COM;.EXE;.BAT;.CMD".to_string()),
        (
            "PSModulePath",
            format!(r"{w}\System32\WindowsPowerShell\v1.0\Modules"),
        ),
        // The documented way to switch off the (user-writable) module analysis cache file.
        ("PSModuleAnalysisCachePath", "NUL".to_string()),
        ("TEMP", format!(r"{w}\Temp")),
        ("TMP", format!(r"{w}\Temp")),
    ]
}

/// Runs `Delete-DeliveryOptimizationCache -Force` through Windows PowerShell (System32 path,
/// no window, 120 s limit, clean environment: see [`do_script`] and [`do_child_env`]).
fn run_do_cmdlet() -> Result<(), String> {
    use std::io::Read;
    use std::process::Stdio;
    let windir = windows_dir();
    let ps = windir.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let script = do_script(&windir);
    let mut child = crate::util::hidden_command(&ps)
        .env_clear()
        .envs(do_child_env(&windir))
        .current_dir(windir.join("System32"))
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "RemoteSigned",
            "-Command",
            script.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Windows PowerShell could not be started ({e})"))?;
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + DO_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                return if status.success() {
                    Ok(())
                } else {
                    Err(do_failure_reason(&text, status.code()))
                };
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                // The reader thread ends when the pipe closes; it is not joined here.
                return Err("the cmdlet did not finish within 120 seconds".to_string());
            }
            Err(e) => {
                let _ = child.kill();
                return Err(format!("the cmdlet could not be monitored ({e})"));
            }
        }
    }
}

/// Clears the Delivery Optimization cache via the cmdlet and measures what it freed.
fn clear_delivery_optimization(ctx: &Context, log: &mut PurgeLog) -> (PurgeCounts, Option<String>) {
    let category = CategoryId::WuCache.as_str();
    let dir = do_cache_dir(&ctx.env);
    let before = folder_size(&dir);
    if before == Some((0, 0)) {
        log.action(category, DO_ACTION, "skipped", 0, "The cache is empty.");
        return (PurgeCounts::default(), None);
    }
    match run_do_cmdlet() {
        Ok(()) => {
            let after = folder_size(&dir);
            let counts = match (before, after) {
                (Some((b0, f0)), Some((b1, f1))) => PurgeCounts {
                    freed: b0.saturating_sub(b1),
                    deleted: f0.saturating_sub(f1),
                    skipped: 0,
                },
                _ => PurgeCounts::default(),
            };
            log.action(
                category,
                DO_ACTION,
                "ok",
                counts.freed,
                &format!("Freed {}.", fmt_bytes(counts.freed)),
            );
            (counts, None)
        }
        Err(reason) => {
            log.action(category, DO_ACTION, "failed", 0, &reason);
            (
                PurgeCounts::default(),
                Some(format!("Delivery Optimization cache was not cleared: {reason}.")),
            )
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Scan & purge orchestration
// ---------------------------------------------------------------------------------------------

fn join_notes(notes: Vec<String>) -> Option<String> {
    let notes: Vec<String> = notes.into_iter().filter(|n| !n.is_empty()).collect();
    (!notes.is_empty()).then(|| notes.join(" "))
}

/// `Written by Windows after a system crash (<YYYY-MM-DD>, <size>). …`
fn memory_dump_description(plan: &CategoryPlan) -> String {
    let file = plan
        .active
        .iter()
        .chain(plan.blocked.iter().map(|(p, _)| p))
        .flat_map(|p| p.files.iter())
        .next();
    match file {
        Some(f) => {
            let date = f
                .mtime
                .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64))
                .map(|d| {
                    d.with_timezone(&chrono::Local)
                        .format("%Y-%m-%d")
                        .to_string()
                });
            match date {
                Some(date) => format!(
                    "Written by Windows after a system crash ({date}, {}). {MEMORY_DUMP_TAIL}",
                    fmt_bytes(f.size)
                ),
                None => format!(
                    "Written by Windows after a system crash ({}). {MEMORY_DUMP_TAIL}",
                    fmt_bytes(f.size)
                ),
            }
        }
        None => CategoryId::MemoryDump.base_description().to_string(),
    }
}

/// Builds one scan row from what was measured.
fn make_category(
    id: CategoryId,
    is_admin: bool,
    bytes: u64,
    files: u64,
    description: String,
    notes: Vec<String>,
) -> TrashCategory {
    let available = is_admin || !id.requires_admin();
    TrashCategory {
        id: id.as_str().to_string(),
        label: id.label().to_string(),
        description,
        bytes,
        files,
        enabled: available && id.default_enabled(),
        optional: id.optional(),
        requires_admin: id.requires_admin(),
        available,
        unavailable_reason: (!available).then(|| "needsAdmin".to_string()),
        note: if available {
            join_notes(notes)
        } else {
            Some(NOTE_NEEDS_ADMIN.to_string())
        },
    }
}

pub fn scan(include_browser: bool) -> TrashScan {
    let started = Instant::now();
    let ids: Vec<CategoryId> = CategoryId::ALL
        .into_iter()
        .filter(|c| *c != CategoryId::Browser || include_browser)
        .collect();
    let ctx = Context::current(&ids);
    let mut categories = Vec::new();
    for id in ids {
        let mut description = id.base_description().to_string();
        let mut notes = Vec::new();
        let (bytes, files) = match id {
            CategoryId::Recycle => query_recycle_bin().unwrap_or((0, 0)),
            _ => {
                let plan = plan_category(id, &ctx);
                let (mut bytes, mut files) = (plan.bytes(), plan.files());
                if id == CategoryId::WuCache {
                    if let Some((b, f)) = folder_size(&do_cache_dir(&ctx.env)) {
                        bytes += b;
                        files += f;
                    }
                }
                if id == CategoryId::MemoryDump {
                    description = memory_dump_description(&plan);
                }
                notes.extend(plan.notes);
                (bytes, files)
            }
        };
        if id == CategoryId::Shader {
            description = format!(
                "{SHADER_DESCRIPTION} Folders: {}.",
                shader_folder_names(ctx.gpus)
            );
        }
        categories.push(make_category(
            id,
            ctx.is_admin,
            bytes,
            files,
            description,
            notes,
        ));
    }
    let total_bytes = categories
        .iter()
        .filter(|c| c.available)
        .map(|c| c.bytes)
        .sum();
    TrashScan {
        categories,
        total_bytes,
        duration_ms: started.elapsed().as_millis() as u64,
        is_admin: ctx.is_admin,
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

/// Parses requested ids: unknown ids are an error; duplicates collapse; order follows
/// [`CategoryId::ALL`].
pub fn parse_categories(categories: &[String]) -> Result<Vec<CategoryId>, String> {
    let mut requested: Vec<CategoryId> = Vec::new();
    for c in categories {
        match CategoryId::parse(c) {
            Some(id) => {
                if !requested.contains(&id) {
                    requested.push(id);
                }
            }
            None => return Err(format!("Unknown cleanup category '{}'", c.trim())),
        }
    }
    requested.sort_by_key(|id| CategoryId::ALL.iter().position(|x| x == id));
    Ok(requested)
}

/// Logs every file of a blocked root as skipped with the block reason.
fn log_blocked(log: &mut PurgeLog, id: CategoryId, plan: &RootPlan, reason: BlockReason) {
    for c in &plan.files {
        log.file(
            id.as_str(),
            &c.path,
            c.size,
            c.mtime,
            "skipped",
            Some(reason.as_str()),
        );
    }
    for h in &plan.held {
        log.file(
            id.as_str(),
            &h.path,
            h.size,
            h.mtime,
            "skipped",
            Some(reason.as_str()),
        );
    }
}

pub fn purge(app: &AppHandle, categories: &[String]) -> Result<PurgeResult, String> {
    let started = Instant::now();
    let started_ts = now_ms();
    let requested = parse_categories(categories)?;

    // Rule 11: no log, no purge. The log folder is user-writable; `create_default` never
    // writes through a link planted there.
    let mut log = PurgeLog::create_default(&crate::util::file_timestamp())
        .map_err(|e| format!("Could not create the cleanup log: {e}"))?;

    let ctx = Context::current(&requested);
    let ids: Vec<&str> = requested.iter().map(|c| c.as_str()).collect();
    log.header(env!("CARGO_PKG_VERSION"), started_ts, ctx.is_admin, &ids);

    let total_steps = requested.len() as u32;
    let mut per_category = Vec::new();
    let mut total = PurgeCounts::default();

    for (i, id) in requested.into_iter().enumerate() {
        let step = i as u32 + 1;
        // Start-of-category event: freedBytes = running total so far.
        emit_progress(app, id, step, total_steps, total.freed);
        let mut notes: Vec<String> = Vec::new();
        let counts = if id.requires_admin() && !ctx.is_admin {
            // Rule 12: an unavailable category is skipped, not an error.
            notes.push(NOTE_NEEDS_ADMIN.to_string());
            PurgeCounts::default()
        } else if id == CategoryId::Recycle {
            let c = empty_recycle_bin();
            let (result, message) = if c.skipped > 0 {
                ("failed", format!("{} items could not be removed.", c.skipped))
            } else if c.deleted == 0 {
                ("skipped", "The Recycle Bin is empty.".to_string())
            } else {
                ("ok", format!("Removed {} items.", c.deleted))
            };
            log.action(id.as_str(), RECYCLE_ACTION, result, c.freed, &message);
            c
        } else {
            let plan = plan_category(id, &ctx);
            let mut c = PurgeCounts::default();
            for root in &plan.active {
                let r = purge_plan_with(root, &ctx.deny, &mut |o: FileOutcome<'_>| {
                    log.file(
                        id.as_str(),
                        o.path,
                        o.bytes,
                        o.mtime,
                        o.result,
                        o.reason.as_deref(),
                    )
                });
                c.freed += r.freed;
                c.deleted += r.deleted;
                c.skipped += r.skipped;
            }
            for (root, reason) in &plan.blocked {
                log_blocked(&mut log, id, root, *reason);
            }
            notes.extend(plan.notes.iter().cloned());
            if id == CategoryId::WuCache {
                let (d, note) = clear_delivery_optimization(&ctx, &mut log);
                c.freed += d.freed;
                c.deleted += d.deleted;
                c.skipped += d.skipped;
                notes.extend(note);
            }
            c
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
            note: join_notes(notes),
        });
        // End-of-category event: freedBytes = running total including this category.
        emit_progress(app, id, step, total_steps, total.freed);
    }

    let result = PurgeResult {
        freed_bytes: total.freed,
        files_deleted: total.deleted,
        files_skipped: total.skipped,
        duration_ms: started.elapsed().as_millis() as u64,
        per_category,
        log_path: crate::purge_log::display_path(log.path()),
    };
    log.summary(serde_json::to_value(&result).unwrap_or(serde_json::Value::Null));
    log.finish();
    Ok(result)
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
pub async fn purge_trash(app: AppHandle, categories: Vec<String>) -> Result<PurgeResult, String> {
    {
        let state = app.state::<AppState>();
        if state.purge_running.swap(true, Ordering::SeqCst) {
            return Err("A cleanup is already running".to_string());
        }
    }
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || purge(&worker, &categories))
        .await
        .map_err(|e| format!("Cleanup failed: {e}"))
        .and_then(|r| r);
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

    fn set_mtime(path: &Path, age: Duration) {
        use std::os::windows::fs::FileTimesExt;
        let when = SystemTime::now() - age;
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(when).set_created(when))
            .unwrap();
    }

    const DAY: Duration = Duration::from_secs(24 * 3600);

    #[test]
    fn recent_dumps_are_kept() {
        let t = TempTree::new("dumps");
        let root = t.base.join("Minidump");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.dmp"), b"1").unwrap();
        fs::write(root.join("b.mdmp"), b"1").unwrap();
        fs::write(root.join("c.HDMP"), b"1").unwrap();
        fs::write(root.join("keep.txt"), b"1").unwrap();
        let deny = DenyList::build();
        let plan = plan_root(
            &RootSpec::dir(root.clone(), false, Filter::Dumps),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        // Fresh dumps: all among the newest 5 and under 30 days. keep.txt is not a dump.
        assert!(plan.files.is_empty());
        assert_eq!(plan.held.len(), 3);
        assert!(plan
            .held
            .iter()
            .all(|h| h.reason == HoldReason::KeptNewest));
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 0);
        assert!(root.join("a.dmp").exists());
    }

    #[test]
    fn dumps_keep_newest_five_and_anything_under_30_days() {
        let t = TempTree::new("dumps-rule");
        let root = t.base.join("Minidump");
        fs::create_dir_all(&root).unwrap();
        // 9 dumps: 2 recent (5 and 10 days), 7 old (40..100 days).
        let ages = [5u64, 10, 40, 50, 60, 70, 80, 90, 100];
        for (i, days) in ages.iter().enumerate() {
            let p = root.join(format!("d{i}.dmp"));
            fs::write(&p, vec![0u8; 10]).unwrap();
            set_mtime(&p, DAY * (*days as u32));
        }
        let deny = DenyList::build();
        let plan = plan_root(
            &RootSpec::dir(root.clone(), false, Filter::Dumps),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        // Newest 5 (5, 10, 40, 50, 60 days) are kept; 70, 80, 90, 100 days are deleted.
        let mut doomed: Vec<String> = plan
            .files
            .iter()
            .map(|c| c.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        doomed.sort();
        assert_eq!(doomed, vec!["d5.dmp", "d6.dmp", "d7.dmp", "d8.dmp"]);
        assert_eq!(
            plan.held
                .iter()
                .filter(|h| h.reason == HoldReason::KeptNewest)
                .count(),
            5
        );
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 4);
        assert!(root.join("d0.dmp").exists());
        assert!(root.join("d4.dmp").exists());
        assert!(!root.join("d8.dmp").exists());

        // Only 7 dumps, 3 of them recent: the newest 5 are kept, the 2 oldest (old) go,
        // a recent one outside the newest 5 cannot exist, but a recent one is never deleted.
        let now_ms = unix_ms(SystemTime::now()).unwrap();
        let mk = |name: &str, days: u64| Candidate {
            path: PathBuf::from(name),
            size: 1,
            mtime: Some(now_ms - days * 86_400_000),
        };
        let files: Vec<Candidate> = (0..8).map(|i| mk(&format!("r{i}"), i)).collect();
        // 8 dumps all younger than 30 days: nothing is deleted.
        let (take, held) = apply_dump_rules(files, now_ms);
        assert!(take.is_empty());
        assert_eq!(held.iter().filter(|h| h.reason == HoldReason::TooNew).count(), 3);
        // Unknown mtime counts as newest and is kept.
        let mut files: Vec<Candidate> = (0..6).map(|i| mk(&format!("o{i}"), 100 + i)).collect();
        files.push(Candidate {
            path: PathBuf::from("unknown"),
            size: 1,
            mtime: None,
        });
        let (take, _) = apply_dump_rules(files, now_ms);
        assert_eq!(take.len(), 2);
        assert!(take.iter().all(|c| c.path != Path::new("unknown")));
    }

    #[test]
    fn memory_dump_is_a_single_file_opt_in() {
        let t = TempTree::new("memdump");
        let root = t.base.join("Win");
        fs::create_dir_all(&root).unwrap();
        let single = root.join("MEMORY.DMP");
        fs::write(&single, b"1234").unwrap();
        fs::write(root.join("other.dmp"), b"1").unwrap();
        let deny = DenyList::build();
        // No age guard: a brand-new MEMORY.DMP is a candidate.
        let plan = plan_root(
            &RootSpec::file(single.clone(), Filter::MemoryDump),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(plan.files.len(), 1);
        // Any other file name is refused as a MEMORY.DMP root.
        assert!(plan_root(
            &RootSpec::file(root.join("other.dmp"), Filter::MemoryDump),
            &deny,
            SystemTime::now()
        )
        .is_none());
        let c = purge_plan(&plan, &deny);
        assert_eq!(c.deleted, 1);
        assert_eq!(c.freed, 4);
        assert!(!single.exists());
        assert!(root.join("other.dmp").exists());
        assert!(root.exists());
    }

    #[test]
    fn cbs_logs_only_old_and_never_cbs_log() {
        let t = TempTree::new("cbs");
        let root = t.base.join("CBS");
        fs::create_dir_all(&root).unwrap();
        for (name, days) in [("CBS.log", 90u32), ("CbsPersist_1.log", 90), ("new.log", 1), ("x.cab", 90)] {
            let p = root.join(name);
            fs::write(&p, b"1").unwrap();
            set_mtime(&p, DAY * days);
        }
        let deny = DenyList::build();
        let plan = plan_root(
            &RootSpec::dir(root.clone(), false, Filter::CbsLogsOld),
            &deny,
            SystemTime::now(),
        )
        .unwrap();
        assert_eq!(plan.files.len(), 1);
        assert!(norm_path(&plan.files[0].path).ends_with("cbspersist_1.log"));
        assert_eq!(plan.held.len(), 1, "new.log is held as tooNew");
        assert_eq!(plan.held[0].reason, HoldReason::TooNew);
    }

    fn test_context(running: Vec<App>, wu_pending: bool) -> Context {
        Context {
            env: Env::current(),
            deny: DenyList::build(),
            is_admin: false,
            running,
            wu_pending,
            gpus: GpuVendors::default(),
        }
    }

    #[test]
    fn running_apps_and_pending_updates_block_their_roots() {
        let t = TempTree::new("gates");
        let chrome = t.base.join("chrome-cache");
        let discord = t.base.join("discord-cache");
        let wu = t.base.join("Download");
        let plain = t.base.join("plain");
        for d in [&chrome, &discord, &wu, &plain] {
            fs::create_dir_all(d).unwrap();
            let f = d.join("f.bin");
            fs::write(&f, b"12345").unwrap();
            set_mtime(&f, DAY * 3);
        }
        let browser = Filter::BrowserCache {
            allow_sqlite: false,
        };
        let specs = || {
            vec![
                RootSpec::dir(chrome.clone(), true, browser).gated(Gate::App(App::Chrome)),
                RootSpec::dir(discord.clone(), true, browser).gated(Gate::App(App::Discord)),
                RootSpec::dir(wu.clone(), true, Filter::Stale(RECENT_GUARD)).gated(Gate::WuDownload),
                RootSpec::dir(plain.clone(), true, Filter::All),
                // A gated root that does not exist never produces a note.
                RootSpec::dir(t.base.join("missing"), true, browser).gated(Gate::App(App::Edge)),
            ]
        };

        let ctx = test_context(vec![App::Discord, App::Chrome, App::Edge], true);
        let plan = plan_specs(specs(), &ctx);
        assert_eq!(plan.active.len(), 1);
        assert_eq!(plan.blocked.len(), 3);
        assert_eq!(plan.bytes(), 5, "blocked roots are not counted");
        assert_eq!(
            plan.notes,
            vec![
                "Skipped: Chrome and Discord are open.".to_string(),
                NOTE_UPDATE_PENDING.to_string()
            ]
        );
        assert!(plan
            .blocked
            .iter()
            .any(|(_, r)| *r == BlockReason::UpdatePending));

        // Purging the active part leaves the blocked roots untouched.
        for p in &plan.active {
            purge_plan(p, &ctx.deny);
        }
        assert!(chrome.join("f.bin").exists());
        assert!(discord.join("f.bin").exists());
        assert!(wu.join("f.bin").exists());
        assert!(!plain.join("f.bin").exists());

        // Nothing running, no update pending: everything is active, no notes.
        let ctx = test_context(Vec::new(), false);
        let plan = plan_specs(specs(), &ctx);
        assert_eq!(plan.active.len(), 4, "chrome, discord, wu and the (now empty) plain root");
        assert_eq!(plan.bytes(), 15);
        assert!(plan.blocked.is_empty());
        assert!(plan.notes.is_empty());
    }

    #[test]
    fn running_app_detection_and_notes() {
        assert_eq!(
            apps_running([
                ("chrome.exe", Some(true)),
                ("msedgewebview2.exe", Some(true)),
                ("firefox.exe", Some(false)),
                ("Discord.exe", None),
                ("CHROME.EXE", Some(true)),
            ]),
            vec![App::Chrome, App::Discord]
        );
        assert!(apps_running([("msedgewebview2.exe", None)]).is_empty());
        assert_eq!(apps_running([("msedge.exe", None)]), vec![App::Edge]);
        assert_eq!(running_apps_note(&[]), None);
        assert_eq!(
            running_apps_note(&[App::Firefox]).unwrap(),
            "Skipped: Firefox is open."
        );
        assert_eq!(
            running_apps_note(&[App::Chrome, App::Edge]).unwrap(),
            "Skipped: Chrome and Edge are open."
        );
        assert_eq!(
            running_apps_note(&[App::Chrome, App::Edge, App::Discord]).unwrap(),
            "Skipped: Chrome, Edge and Discord are open."
        );
        // Live detection never panics.
        let _ = detect_running_apps();
    }

    #[test]
    fn update_pending_is_conservative() {
        let clear = WuSignals {
            reboot_required: Some(false),
            reboot_pending: Some(false),
            pending_file_renames: Some(false),
            trusted_installer_running: Some(false),
            wuauserv_running: Some(false),
        };
        assert!(!clear.update_pending());
        assert!(WuSignals {
            reboot_required: Some(true),
            ..clear
        }
        .update_pending());
        assert!(WuSignals {
            trusted_installer_running: Some(true),
            ..clear
        }
        .update_pending());
        assert!(WuSignals {
            pending_file_renames: None,
            ..clear
        }
        .update_pending(), "unknown counts as pending");
        assert!(WuSignals::default().update_pending());
        // Live probes never panic (read-only).
        let _ = detect_wu_signals();
    }

    #[test]
    fn gpu_vendor_detection_and_shader_folders() {
        let v = GpuVendors::from_pnp_ids([
            r"PCI\VEN_1002&DEV_73BF&SUBSYS_23181458&REV_C1\6&1",
            r"ROOT\BASICDISPLAY\0000",
        ]);
        assert_eq!(
            v,
            GpuVendors {
                nvidia: false,
                amd: true,
                intel: false
            }
        );
        assert_eq!(
            shader_folder_names(v),
            r"D3DSCache, AMD\DxCache, AMD\DxcCache, AMD\VkCache, AMD\GLCache"
        );
        assert_eq!(shader_folder_names(GpuVendors::default()), "D3DSCache");
        let n = GpuVendors::from_pnp_ids([r"pci\ven_10de&dev_2704"]);
        assert!(n.nvidia);
        assert!(shader_folder_names(n).contains(r"NVIDIA Corporation\NV_Cache"));
    }

    #[test]
    fn delivery_optimization_failure_reasons() {
        assert_eq!(
            do_failure_reason(
                "Delete-DeliveryOptimizationCache : The term 'Delete-DeliveryOptimizationCache' is not recognized as the name of a cmdlet",
                Some(1)
            ),
            "the Delete-DeliveryOptimizationCache cmdlet is not available on this system"
        );
        assert_eq!(
            do_failure_reason(
                "\r\nDelete-DeliveryOptimizationCache : Access is denied.\r\nAt line:1 char:1",
                Some(1)
            ),
            "Access is denied"
        );
        assert_eq!(do_failure_reason("", Some(5)), "the cmdlet failed (exit code 5)");
        let note = format!(
            "Delivery Optimization cache was not cleared: {}.",
            do_failure_reason("", None)
        );
        assert_eq!(note, "Delivery Optimization cache was not cleared: the cmdlet failed.");
    }

    #[test]
    fn folder_size_is_read_only_and_skips_links() {
        let t = TempTree::new("size");
        let root = t.base.join("root");
        let outside = t.base.join("outside");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("a"), vec![0u8; 100]).unwrap();
        fs::write(root.join("sub").join("b"), vec![0u8; 20]).unwrap();
        fs::write(outside.join("big"), vec![0u8; 1000]).unwrap();
        let _ = make_junction(&root.join("link"), &outside);
        assert_eq!(folder_size(&root), Some((120, 2)));
        assert!(root.join("a").exists());
        assert_eq!(folder_size(&t.base.join("nope")), Some((0, 0)));
    }

    #[test]
    fn delete_errors_map_to_log_reasons() {
        assert_eq!(
            delete_outcome(&DeleteError::Open(Some(32), "in use".into())),
            ("skipped", "locked".to_string())
        );
        assert_eq!(
            delete_outcome(&DeleteError::Failed(Some(5), "denied".into())),
            ("skipped", "accessDenied".to_string())
        );
        assert_eq!(
            delete_outcome(&DeleteError::NotAllowed("reparse point")),
            ("skipped", "reparsePoint".to_string())
        );
        assert_eq!(
            delete_outcome(&DeleteError::Failed(Some(1117), "I/O device error".into())),
            ("failed", "I/O device error".to_string())
        );
    }

    #[test]
    fn categories_defaults_and_availability() {
        let ids: Vec<&str> = CategoryId::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(
            ids,
            vec!["temp", "wu-cache", "logs", "dumps", "memory-dump", "shader", "recycle", "browser"]
        );
        assert_eq!(CategoryId::parse("standby"), None, "standby is removed");
        for id in CategoryId::ALL {
            let on = matches!(id, CategoryId::Temp | CategoryId::WuCache | CategoryId::Logs);
            assert_eq!(id.default_enabled(), on, "{}", id.as_str());
            assert_eq!(id.optional(), !on, "{}", id.as_str());
        }
        // Not elevated: admin-only categories are unavailable, switched off, noted.
        let c = make_category(CategoryId::Logs, false, 500, 3, "d".into(), vec![]);
        assert!(!c.available);
        assert!(!c.enabled);
        assert_eq!(c.unavailable_reason.as_deref(), Some("needsAdmin"));
        assert_eq!(c.note.as_deref(), Some(NOTE_NEEDS_ADMIN));
        assert_eq!(c.bytes, 500, "best-effort estimate is still reported");
        let c = make_category(CategoryId::Temp, false, 1, 1, "d".into(), vec![]);
        assert!(c.available && c.enabled && c.note.is_none());
        let c = make_category(
            CategoryId::Shader,
            true,
            1,
            1,
            "d".into(),
            vec!["a.".into(), "b.".into()],
        );
        assert!(c.available && !c.enabled);
        assert_eq!(c.note.as_deref(), Some("a. b."));
        let v = serde_json::to_value(&c).unwrap();
        assert!(v["unavailableReason"].is_null());
        assert_eq!(v["requiresAdmin"], false);
    }

    #[test]
    fn purge_rejects_unknown_ids() {
        assert!(parse_categories(&["temp".into(), "standby".into()]).is_err());
        assert_eq!(
            parse_categories(&["browser".into(), "temp".into(), "TEMP".into()]).unwrap(),
            vec![CategoryId::Temp, CategoryId::Browser]
        );
    }

    #[test]
    fn scan_never_counts_unavailable_bytes() {
        let scan = scan(false);
        assert!(scan.categories.iter().all(|c| c.id != "browser"));
        let available: u64 = scan
            .categories
            .iter()
            .filter(|c| c.available)
            .map(|c| c.bytes)
            .sum();
        assert_eq!(scan.total_bytes, available);
        let shader = scan.categories.iter().find(|c| c.id == "shader").unwrap();
        assert!(shader
            .description
            .starts_with("Only clear if a game shows corrupted graphics."));
        assert!(shader.description.contains("Folders: D3DSCache"));
        let ids: Vec<&str> = scan.categories.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["temp", "wu-cache", "logs", "dumps", "memory-dump", "shader", "recycle"]
        );
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
        // Every planned root of every file category passes the shape check (as admin and not,
        // with every vendor's shader folders and every gate both open and closed).
        for is_admin in [false, true] {
            for gated in [false, true] {
                let ctx = Context {
                    env: Env::current(),
                    deny: DenyList::build(),
                    is_admin,
                    running: if gated { App::ALL.to_vec() } else { Vec::new() },
                    wu_pending: gated,
                    gpus: GpuVendors {
                        nvidia: true,
                        amd: true,
                        intel: true,
                    },
                };
                for id in CategoryId::ALL {
                    let plan = plan_category(id, &ctx);
                    let roots = plan
                        .active
                        .iter()
                        .chain(plan.blocked.iter().map(|(p, _)| p));
                    for p in roots {
                        assert!(root_shape_ok(&p.root_norm), "{}", p.root_norm);
                        assert!(!ctx.deny.is_denied(&p.root_norm), "{}", p.root_norm);
                        // Prefetch is never a root.
                        assert!(!p.root_norm.ends_with(r"\prefetch"), "{}", p.root_norm);
                        // Delivery Optimization files are never a file root (cmdlet only).
                        assert!(!p.root_norm.contains("deliveryoptimization"), "{}", p.root_norm);
                    }
                    if gated && id == CategoryId::Browser {
                        assert!(plan.active.is_empty(), "browsers are open: nothing active");
                    }
                }
                // Not elevated: Windows\Temp is not a temp root.
                if !is_admin {
                    let wtemp = norm_path(&windows_dir().join("Temp"));
                    let plan = plan_category(CategoryId::Temp, &ctx);
                    assert!(plan.active.iter().all(|p| p.root_norm != wtemp));
                }
            }
        }
    }

    #[test]
    fn delivery_optimization_runs_in_a_locked_down_powershell() {
        let w = Path::new(r"C:\Windows");
        let script = do_script(w);
        assert!(script.starts_with(
            "$ErrorActionPreference = 'Stop'; $PSModuleAutoloadingPreference = 'None'; "
        ));
        for m in [
            r"Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1",
            r"CimCmdlets\CimCmdlets.psd1",
            r"DeliveryOptimization\DeliveryOptimization.psd1",
        ] {
            assert!(
                script.contains(&format!(
                    r"Import-Module -Name 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\{m}' -DisableNameChecking; "
                )),
                "{script}"
            );
        }
        assert!(script.ends_with(r"DeliveryOptimization\Delete-DeliveryOptimizationCache -Force"));
        assert!(!script.contains("IncludePinnedFiles"));
        // Quotes in the Windows path cannot break out of the PowerShell string.
        assert!(do_script(Path::new(r"C:\Win'dows")).contains(r"'C:\Win''dows\System32"));

        let env = do_child_env(w);
        let get = |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("PSModulePath").as_deref(),
            Some(r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules")
        );
        assert_eq!(get("PSModuleAnalysisCachePath").as_deref(), Some("NUL"));
        assert_eq!(get("SystemRoot").as_deref(), Some(r"C:\Windows"));
        assert!(get("PATH").unwrap().split(';').all(|p| p.starts_with(r"C:\Windows")));
        // Nothing user-controlled is passed on.
        for k in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "COR_PROFILER", "COMPlus_X"] {
            assert!(get(k).is_none(), "{k}");
        }

        // The real invocation resolves the module-qualified cmdlet from System32 with this
        // environment (read-only check: Get-Command, nothing is deleted).
        let windir = windows_dir();
        let modules = windir.join(r"System32\WindowsPowerShell\v1.0\Modules\DeliveryOptimization");
        if modules.is_dir() {
            let probe = do_script(&windir).replace(
                r"DeliveryOptimization\Delete-DeliveryOptimizationCache -Force",
                r"(Get-Command DeliveryOptimization\Delete-DeliveryOptimizationCache).Module.ModuleBase; (Get-Command Invoke-CimMethod).Source",
            );
            let out = crate::util::hidden_command(
                windir.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            )
            .env_clear()
            .envs(do_child_env(&windir))
            .current_dir(windir.join("System32"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "RemoteSigned",
                "-Command",
                probe.as_str(),
            ])
            .output()
            .expect("powershell runs");
            let stdout = String::from_utf8_lossy(&out.stdout).to_lowercase();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert!(stdout.contains(&norm_path(&modules)), "{stdout}");
            assert!(stdout.contains("cimcmdlets"), "{stdout}");
        }
    }

    #[test]
    fn per_user_folders_must_stay_inside_the_profile() {
        let profile = Path::new(r"C:\Users\me");
        let ok = |p: &str| within_profile(Some(PathBuf::from(p)), Some(profile)).is_some();
        assert!(ok(r"C:\Users\me\AppData\Local"));
        assert!(ok(r"c:\users\ME\AppData\Roaming"));
        assert!(!ok(r"C:\Users\me"));
        assert!(!ok(r"C:\Users\me2\AppData\Local"));
        assert!(!ok(r"C:\Users\victim\AppData\Local"));
        assert!(!ok(r"C:\Windows\System32\config\systemprofile\AppData\Local"));
        assert!(!ok(r"C:\Users\me\..\victim\AppData\Local"));
        assert!(!ok(r"\\server\share\me\AppData"));
        assert!(!ok(r"AppData\Local"));
        assert!(within_profile(Some(PathBuf::from(r"C:\Users\me\x")), None).is_none());
        // The real known folders satisfy it.
        let env = Env::current();
        assert!(env.local_appdata.is_some());
    }

    #[test]
    fn fresh_empty_folders_survive_an_age_guarded_purge() {
        use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
        let t = TempTree::new("freshdir");
        let root = t.base.join("root");
        fs::create_dir_all(root.join("fresh-empty")).unwrap();
        fs::create_dir_all(root.join("old-empty")).unwrap();
        let old = SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        let set_dir_times = |p: &Path| {
            // FILE_WRITE_ATTRIBUTES on the folder itself (backup semantics opens a folder).
            let f = fs::OpenOptions::new()
                .access_mode(0x0100)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
                .open(p)
                .unwrap();
            f.set_times(fs::FileTimes::new().set_modified(old).set_created(old))
                .unwrap();
        };
        set_dir_times(&root.join("old-empty"));
        let deny = DenyList::build();
        let spec = RootSpec::dir(root.clone(), true, Filter::Stale(RECENT_GUARD));
        let plan = plan_root(&spec, &deny, SystemTime::now()).unwrap();
        purge_plan(&plan, &deny);
        assert!(root.join("fresh-empty").is_dir(), "a fresh folder may be in use");
        assert!(!root.join("old-empty").exists());
        // Without an age guard empty folders go as before.
        let plan = plan_root(&all_filter_spec(&root), &deny, SystemTime::now()).unwrap();
        purge_plan(&plan, &deny);
        assert!(!root.join("fresh-empty").exists());
        assert!(root.is_dir(), "the root itself is never removed");
    }

    #[test]
    fn dump_ties_and_future_timestamps_are_deterministic() {
        let now_ms = 1_800_000_000_000u64;
        let day = 86_400_000u64;
        // Seven dumps with the same old mtime: exactly the 5 first by path are kept, every
        // time, so scan and purge agree.
        let files: Vec<Candidate> = ["g", "c", "a", "f", "b", "e", "d"]
            .iter()
            .map(|n| Candidate {
                path: PathBuf::from(format!("{n}.dmp")),
                size: 1,
                mtime: Some(now_ms - 60 * day),
            })
            .collect();
        let (take, held) = apply_dump_rules(files.clone(), now_ms);
        let mut gone: Vec<String> = take.iter().map(|c| c.path.display().to_string()).collect();
        gone.sort();
        assert_eq!(gone, vec!["f.dmp", "g.dmp"]);
        assert_eq!(held.len(), 5);
        let mut reversed = files;
        reversed.reverse();
        let (take2, _) = apply_dump_rules(reversed, now_ms);
        let mut gone2: Vec<String> = take2.iter().map(|c| c.path.display().to_string()).collect();
        gone2.sort();
        assert_eq!(gone, gone2);
        // A dump stamped in the future (clock skew) is kept (newest and not older than 30
        // days), and an old dump is still deleted only when 5 newer ones exist.
        let mut files: Vec<Candidate> = (0..5)
            .map(|i| Candidate {
                path: PathBuf::from(format!("old{i}.dmp")),
                size: 1,
                mtime: Some(now_ms - (40 + i) * day),
            })
            .collect();
        files.push(Candidate {
            path: PathBuf::from("future.dmp"),
            size: 1,
            mtime: Some(now_ms + 365 * day),
        });
        let (take, held) = apply_dump_rules(files, now_ms);
        assert!(held.iter().any(|h| h.path == Path::new("future.dmp")));
        assert_eq!(take.len(), 1);
        assert_eq!(take[0].path, Path::new("old4.dmp"));
    }

    #[test]
    fn nexum_folders_are_deny_listed() {
        let deny = DenyList::build();
        if let Some(pd) = crate::util::program_data_dir() {
            assert!(deny.is_denied(&norm_path(&pd.join(r"Nexum\fan-manual.flag"))));
        }
        let exe_dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        assert!(deny.is_denied(&norm_path(&exe_dir.join("nexum-agent.exe"))));
    }
}
