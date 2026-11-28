//! In-app updates (CONTRACT §2.15).
//!
//! This is the only module of Nexum that talks to the network; CI allows no other file to.
//! What it guarantees:
//!
//! * **Consent first.** While `Settings.updateCheck` is `"ask"` nothing here builds a request:
//!   the scheduler does not run a check and both commands refuse ([`check_gate`]).
//! * **`"auto"` only checks**, at most once per 24 h ([`is_due`]). Downloading and installing
//!   happen only inside `install_update`, which only a click calls.
//! * **One source.** The two manifest URLs and the download prefix below are the only
//!   addresses in the code, all under this repository's GitHub Releases. Every request is
//!   HTTPS only, redirects included.
//! * **The manifest is not trusted.** It is not signed, so everything in it is treated as
//!   something an attacker may have written: it is read with a size limit
//!   ([`MAX_MANIFEST_BYTES`]), its notes are shown as plain text, its URL must match the fixed
//!   prefix, and its version counts only when the installer's signature says the same.
//! * **Never a downgrade.** A version must be strictly greater by SemVer precedence
//!   ([`is_newer`]), the stable channel never takes a preview version, and the version is
//!   bound to the signed file through the signature's trusted comment
//!   ([`check_signed_binding`]): a signature that does not name this file and this version is
//!   refused.
//! * **Nothing unverified runs, and nothing verified can be swapped.** Nexum runs elevated,
//!   so the plugin's own `install` (which writes to `%TEMP%`) is never used. The download is
//!   verified in memory and staged in `<Nexum folder>\updates`, a folder made new for every
//!   install with access for SYSTEM and Administrators only ([`PinnedDir::create_admin_only`]).
//!   The file is created with the same access list, reopened so that nobody can write to,
//!   delete or replace it, read back through that handle and compared byte for byte, and only
//!   then started.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::safe_fs::PinnedDir;
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::util::{lock, now_ms};

// ---------------------------------------------------------------------------------------------
// Fixed addresses and limits
// ---------------------------------------------------------------------------------------------

/// Every download URL in a manifest must start with this (CONTRACT §2.15.2).
pub const DOWNLOAD_PREFIX: &str = "https://github.com/captainRapipo/nexum/releases/download/";
/// The manifest of the newest stable release: an asset of the permanent `updates` release.
const MANIFEST_STABLE: &str =
    "https://github.com/captainRapipo/nexum/releases/download/updates/stable.json";
/// The manifest of the newest release of any kind.
const MANIFEST_PREVIEW: &str =
    "https://github.com/captainRapipo/nexum/releases/download/updates/preview.json";

/// `"auto"` checks at most once per this period, counted from `Settings.lastUpdateCheckTs`.
pub const CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
/// The due rule is first evaluated this long after app start …
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// … and then this often.
const RECHECK_EVERY: Duration = Duration::from_secs(60 * 60);
/// Failed automatic attempts per app run before the scheduler stops trying.
pub const MAX_AUTO_FAILURES: u32 = 3;
/// Timeout of the manifest request.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// A manifest that announces or sends more than this is refused before it is parsed (a real
/// one is about 2 kB: the notes are at most 4000 characters).
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
/// The client name sent with the manifest request. It says nothing about the version, the PC
/// or the user.
const USER_AGENT: &str = "nexum-updater";
/// Timeout of the whole installer download (the plugin sets none by itself).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// More than this announced or received aborts the download.
pub const MAX_DOWNLOAD_BYTES: u64 = 300 * 1024 * 1024;
/// Release notes are cut to this many characters (then `…`).
pub const NOTES_MAX_CHARS: usize = 4000;
/// `update-state` is emitted at most this often while downloading.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// Tauri's NSIS installer: passive UI, relaunch when done, update mode.
const INSTALLER_ARGS: [&str; 3] = ["/P", "/R", "/UPDATE"];
/// Staging folder inside the folder of the running `Nexum.exe`.
const STAGING_DIR: &str = "updates";
/// Present next to `Nexum.exe` in a copy that the installer put there.
const UNINSTALLER_NAME: &str = "uninstall.exe";
/// How long after start leftovers of an earlier update are removed (the installer that
/// relaunched Nexum has exited by then).
const CLEANUP_DELAY: Duration = Duration::from_secs(10);
/// Time the UI gets to show "Installing" before Nexum exits.
const EXIT_DELAY: Duration = Duration::from_millis(1500);

/// `check_for_update` / `install_update` while the first-run question is unanswered.
pub const ERR_NOT_ANSWERED: &str = "Choose how Nexum checks for updates first.";
/// `install_update` in a build or copy that does not update itself.
pub const ERR_DISABLED: &str = "This build does not update from inside the app.";
/// `install_update` without an offer in memory.
pub const ERR_NO_OFFER: &str = "Check for updates first.";

// ---------------------------------------------------------------------------------------------
// Wire types (mirror `types.ts`)
// ---------------------------------------------------------------------------------------------

/// Release channel (CONTRACT §2.15.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Stable,
    Preview,
}

impl Channel {
    /// The one manifest URL of this channel.
    pub fn manifest_url(self) -> &'static str {
        match self {
            Channel::Stable => MANIFEST_STABLE,
            Channel::Preview => MANIFEST_PREVIEW,
        }
    }
}

/// `UpdateState.state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
    Disabled,
}

/// `UpdateState.errorCode` (CONTRACT §2.15.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Offline,
    NotPublished,
    BadManifest,
    NotNewer,
    BadSignature,
    Blocked,
    Write,
    Launch,
    Busy,
    Unknown,
}

impl ErrorCode {
    /// The exact text shown for this error (`UPDATE_ERROR_TEXT` in `types.ts`). Technical
    /// detail (HTTP status, OS error) goes to stderr only.
    pub fn text(self) -> &'static str {
        match self {
            ErrorCode::Offline => {
                "Could not reach GitHub. Check your internet connection and try again."
            }
            ErrorCode::NotPublished => {
                "No update information has been published for this version line yet."
            }
            ErrorCode::BadManifest => "The update information from GitHub could not be read.",
            ErrorCode::NotNewer => {
                "The version on offer is not newer than this one, so nothing was installed."
            }
            ErrorCode::BadSignature => {
                "The download did not pass Nexum's signature check, so it was not installed."
            }
            ErrorCode::Blocked => "Windows security blocked the installer. Nothing was changed.",
            ErrorCode::Write => {
                "The update could not be saved in Nexum's folder. Nothing was changed."
            }
            ErrorCode::Launch => "The installer could not be started. Nothing was changed.",
            ErrorCode::Busy => "An update is already in progress.",
            ErrorCode::Unknown => "The update could not be completed. Nothing was changed.",
        }
    }
}

/// `UpdateState` (CONTRACT §2.15.6), field for field as in `types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub state: Status,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub progress: Option<u8>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub channel: Option<Channel>,
    pub build_channel: Option<Channel>,
    pub last_check_ts: Option<u64>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            state: Status::Idle,
            current_version: String::new(),
            latest_version: None,
            notes: None,
            published_at: None,
            progress: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            error_code: None,
            channel: None,
            build_channel: None,
            last_check_ts: None,
        }
    }
}

impl UpdateState {
    fn clear_error(&mut self) {
        self.error = None;
        self.error_code = None;
    }

    fn clear_progress(&mut self) {
        self.progress = None;
        self.downloaded_bytes = None;
        self.total_bytes = None;
    }

    fn clear_offer(&mut self) {
        self.latest_version = None;
        self.notes = None;
        self.published_at = None;
    }

    fn set_error(&mut self, code: ErrorCode) {
        self.state = Status::Error;
        self.error = Some(code.text().to_string());
        self.error_code = Some(code);
        self.clear_progress();
    }
}

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested)
// ---------------------------------------------------------------------------------------------

/// The channel a value of the compile-time variable `NEXUM_UPDATE_CHANNEL` names: `stable`,
/// `preview`, anything else or unset → none.
pub fn parse_build_channel(value: Option<&str>) -> Option<Channel> {
    match value.map(str::trim) {
        Some("stable") => Some(Channel::Stable),
        Some("preview") => Some(Channel::Preview),
        _ => None,
    }
}

/// The channel compiled into this build. CI sets the variable only for tag builds that have
/// the signing secret, and debug builds never have one, so a fork's or a developer's build
/// never replaces itself with an upstream release.
pub fn build_channel() -> Option<Channel> {
    if cfg!(debug_assertions) {
        return None;
    }
    parse_build_channel(option_env!("NEXUM_UPDATE_CHANNEL"))
}

/// The channel in effect: `Settings.updateChannel`, or the build channel when that is
/// `"default"` (or unreadable). `None` when the build has no channel at all.
pub fn effective_channel(setting: &str, build: Option<Channel>) -> Option<Channel> {
    let build = build?;
    Some(match settings::sanitize_update_channel(setting) {
        settings::UPDATE_CHANNEL_STABLE => Channel::Stable,
        settings::UPDATE_CHANNEL_PREVIEW => Channel::Preview,
        _ => build,
    })
}

/// True when two settings ask different channels in a build with the channel `build`.
pub fn effective_channel_changed(old: &str, new: &str, build: Option<Channel>) -> bool {
    effective_channel(old, build) != effective_channel(new, build)
}

/// [`effective_channel_changed`] for this build (used by `save_settings`).
pub fn channel_changed(old: &Settings, new: &Settings) -> bool {
    effective_channel_changed(&old.update_channel, &new.update_channel, build_channel())
}

/// Why a copy of Nexum does not update from inside the app, or `None` when it does: the build
/// has no channel, or this copy was not put in place by the installer (a portable copy would
/// not be the one the installer updates, so it would offer the same update for ever).
pub fn disabled_reason(build: Option<Channel>, installed: bool) -> Option<&'static str> {
    if build.is_none() {
        Some("this build has no update channel")
    } else if !installed {
        Some("this copy was not installed by the Nexum installer")
    } else {
        None
    }
}

/// Who asked for a check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckKind {
    /// `check_for_update`: a click on `Check now`.
    User,
    /// The scheduler.
    Automatic,
}

/// Whether a check may make a request (CONTRACT §2.15.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Allowed,
    /// This build or copy never updates from inside the app.
    Disabled,
    /// The first-run question has not been answered: no request at all.
    NotAnswered,
    /// The user chose "Only when I ask": no request without a click.
    NotAutomatic,
}

/// The consent rule. `enabled` = this copy can update itself; `update_check` =
/// `Settings.updateCheck` (an unreadable value counts as `"ask"`).
pub fn check_gate(enabled: bool, update_check: &str, kind: CheckKind) -> Gate {
    if !enabled {
        return Gate::Disabled;
    }
    match (settings::sanitize_update_check(update_check), kind) {
        (settings::UPDATE_CHECK_AUTO, _) => Gate::Allowed,
        (settings::UPDATE_CHECK_MANUAL, CheckKind::User) => Gate::Allowed,
        (settings::UPDATE_CHECK_MANUAL, CheckKind::Automatic) => Gate::NotAutomatic,
        _ => Gate::NotAnswered,
    }
}

/// The 24 h throttle: due when there was no answered check yet, when the last one is at least
/// [`CHECK_INTERVAL_MS`] old, or when it lies in the future (the clock was moved back).
pub fn is_due(last_check_ts: Option<u64>, now: u64) -> bool {
    match last_check_ts {
        None => true,
        Some(last) if last > now => true,
        Some(last) => now - last >= CHECK_INTERVAL_MS,
    }
}

/// Whether the scheduler runs an automatic check now: consent is `"auto"`, the copy can
/// update itself, fewer than [`MAX_AUTO_FAILURES`] automatic attempts failed in this run, and
/// the throttle says it is due.
pub fn auto_check_due(
    enabled: bool,
    update_check: &str,
    last_check_ts: Option<u64>,
    now: u64,
    auto_failures: u32,
) -> bool {
    check_gate(enabled, update_check, CheckKind::Automatic) == Gate::Allowed
        && auto_failures < MAX_AUTO_FAILURES
        && is_due(last_check_ts, now)
}

/// A SemVer version without a leading `v`.
pub fn parse_version(text: &str) -> Option<Version> {
    Version::parse(text.trim().trim_start_matches('v')).ok()
}

/// Never downgrade: `candidate` must be strictly greater than `current` by SemVer precedence
/// (build metadata does not make a version newer).
pub fn is_newer(candidate: &Version, current: &Version) -> bool {
    candidate.cmp_precedence(current) == std::cmp::Ordering::Greater
}

/// True when a download URL points into this repository's GitHub Releases. `url` must be the
/// normalized form (`Url::as_str`), in which dot segments are already resolved.
pub fn url_allowed(url: &str) -> bool {
    url.len() > DOWNLOAD_PREFIX.len()
        && url.starts_with(DOWNLOAD_PREFIX)
        && !url.contains(['\\', '#', '@'])
        && !url.split('/').any(|segment| segment == ".." || segment == ".")
}

/// Validates what a manifest offers on `channel`: the URL prefix, a readable version, strictly
/// newer, and no preview version on the stable channel (`stable.json` only ever describes a
/// stable release, so a pre-release there is somebody else's edit).
pub fn validate_offer(
    version: &str,
    url: &str,
    current: &Version,
    channel: Channel,
) -> Result<Version, ErrorCode> {
    if !url_allowed(url) {
        return Err(ErrorCode::BadManifest);
    }
    let offered = parse_version(version).ok_or(ErrorCode::BadManifest)?;
    if !is_newer(&offered, current) {
        return Err(ErrorCode::NotNewer);
    }
    if channel == Channel::Stable && !offered.pre.is_empty() {
        return Err(ErrorCode::BadManifest);
    }
    Ok(offered)
}

/// The error for an HTTP status of the manifest request, `None` for success (CONTRACT §2.15.4
/// step 4): 404 is the normal state of a channel before its first release.
pub fn manifest_status_error(status: u16) -> Option<ErrorCode> {
    match status {
        200..=299 => None,
        404 => Some(ErrorCode::NotPublished),
        _ => Some(ErrorCode::Offline),
    }
}

/// True when a manifest is over [`MAX_MANIFEST_BYTES`], by what the server announced or by
/// what has arrived so far.
pub fn manifest_too_big(received: usize, announced: Option<u64>) -> bool {
    received > MAX_MANIFEST_BYTES || announced.is_some_and(|n| n > MAX_MANIFEST_BYTES as u64)
}

/// The manifest as JSON. It must be an object; everything else about it is checked by the
/// plugin's parser and by [`validate_offer`].
pub fn parse_manifest(body: &[u8]) -> Result<serde_json::Value, ErrorCode> {
    if manifest_too_big(body.len(), None) {
        return Err(ErrorCode::BadManifest);
    }
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(value) if value.is_object() => Ok(value),
        _ => Err(ErrorCode::BadManifest),
    }
}

/// Release notes as plain text: line breaks kept, every other control character and the
/// bidirectional override marks removed, cut at [`NOTES_MAX_CHARS`] characters plus `…`.
pub fn clean_notes(body: Option<&str>) -> Option<String> {
    let cleaned: String = body?
        .replace("\r\n", "\n")
        .chars()
        .map(|c| match c {
            '\r' => '\n',
            '\t' => ' ',
            c => c,
        })
        .filter(|c| {
            let c = *c;
            c == '\n'
                || !(c.is_control()
                    || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= NOTES_MAX_CHARS {
        return Some(trimmed.to_string());
    }
    let mut cut: String = trimmed.chars().take(NOTES_MAX_CHARS).collect();
    cut.push('…');
    Some(cut)
}

/// A unix time in seconds as RFC 3339 UTC (`2026-11-27T20:00:00Z`).
pub fn rfc3339_utc(unix_secs: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(unix_secs, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// The trusted comment of an updater signature. `signature` is the content of a `.sig` file:
/// base64 of a minisign signature, four lines of which the third is `trusted comment: …`.
/// minisign's global signature covers that line, so it may be relied on **after** the
/// signature was verified.
///
/// It is read exactly the way the verifier reads it (third line, exact prefix), never by
/// searching: the first line is the *untrusted* comment, which no signature covers, so a
/// search would let whoever wrote the manifest put a `trusted comment:` line of their own
/// there.
pub fn trusted_comment(signature: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    text.lines()
        .nth(2)?
        .strip_prefix("trusted comment: ")
        .map(str::to_string)
}

/// The version inside an installer file name. The name must be exactly
/// `Nexum_<semver>_x64-setup.exe`, the name the release pipeline signs under.
pub fn version_from_file_name(name: &str) -> Option<String> {
    let version = name.strip_prefix("Nexum_")?.strip_suffix("_x64-setup.exe")?;
    parse_version(version)
        .filter(|parsed| parsed.to_string() == version)
        .map(|_| version.to_string())
}

/// The `version:` and `file:` fields of a trusted comment (tab separated `key:value` pairs,
/// as the Tauri CLI writes them). The first occurrence of a key counts, as in the plugin.
pub fn signed_fields(trusted_comment: &str) -> (Option<&str>, Option<&str>) {
    let mut version = None;
    let mut file = None;
    for field in trusted_comment.split('\t') {
        if let Some(v) = field.strip_prefix("version:") {
            if version.is_none() {
                version = Some(v);
            }
        } else if let Some(name) = field.strip_prefix("file:") {
            if file.is_none() {
                file = Some(name);
            }
        }
    }
    (version, file)
}

/// Binds the version to the signed file (CONTRACT §2.15.5 step 2, anti-rollback). Call only
/// after the bytes were verified against `signature`. `Ok(())` only when the signature names
/// **both** the version and the installer file of that version, both equal the announced
/// version, and that version is newer than `current`.
///
/// * `Err(BadSignature)`: the signature names no version or no Nexum installer. Every
///   signature the release pipeline makes names both, so one that does not was not made for
///   an update and is never accepted.
/// * `Err(NotNewer)`: it names a different version, or one that is not newer — a manifest
///   that pairs a new number with an old installer.
pub fn check_signed_binding(
    signature: &str,
    announced: &str,
    current: &Version,
) -> Result<(), ErrorCode> {
    let comment = trusted_comment(signature).ok_or(ErrorCode::BadSignature)?;
    let (version, file) = signed_fields(&comment);
    let version = version.ok_or(ErrorCode::BadSignature)?;
    let named = file
        .and_then(version_from_file_name)
        .ok_or(ErrorCode::BadSignature)?;
    let signed = parse_version(version).ok_or(ErrorCode::NotNewer)?;
    let named = parse_version(&named).ok_or(ErrorCode::NotNewer)?;
    let announced = parse_version(announced).ok_or(ErrorCode::BadManifest)?;
    if signed != announced || named != announced || !is_newer(&signed, current) {
        return Err(ErrorCode::NotNewer);
    }
    Ok(())
}

/// Download progress as an integer percentage, `None` while the size is unknown.
pub fn progress_pct(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    Some((u128::from(received.min(total)) * 100 / u128::from(total)) as u8)
}

/// True when the announced or received size is over [`MAX_DOWNLOAD_BYTES`].
pub fn download_too_big(received: u64, total: Option<u64>) -> bool {
    received > MAX_DOWNLOAD_BYTES || total.is_some_and(|t| t > MAX_DOWNLOAD_BYTES)
}

/// Whether `install_update` may start (CONTRACT §2.15.5 step 0), in the order the contract
/// lists the refusals.
pub fn install_gate(
    enabled: bool,
    update_check: &str,
    status: Status,
    busy: bool,
    has_offer: bool,
) -> Result<(), &'static str> {
    if !enabled {
        return Err(ERR_DISABLED);
    }
    if settings::sanitize_update_check(update_check) == settings::UPDATE_CHECK_ASK {
        return Err(ERR_NOT_ANSWERED);
    }
    if busy || matches!(status, Status::Downloading | Status::Ready | Status::Installing) {
        return Err(ErrorCode::Busy.text());
    }
    if !has_offer {
        return Err(ERR_NO_OFFER);
    }
    Ok(())
}

/// The error a failed installer start maps to: blocked by Windows security, or anything else.
pub fn launch_error_code(os_code: Option<i32>) -> ErrorCode {
    match os_code {
        Some(code) if crate::util::blocked_by_windows_security(code) => ErrorCode::Blocked,
        _ => ErrorCode::Launch,
    }
}

/// The file name the installer is staged under (without the extension).
pub fn staged_stem(version: &str) -> String {
    let safe: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    format!("Nexum-update-{safe}")
}

/// True when `reader` yields exactly `expected` and then ends.
pub fn reader_matches(reader: &mut impl Read, expected: &[u8]) -> std::io::Result<bool> {
    let mut buf = vec![0u8; 64 * 1024];
    let mut offset = 0usize;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(offset == expected.len());
        }
        match expected.get(offset..offset + n) {
            Some(part) if part == &buf[..n] => offset += n,
            _ => return Ok(false),
        }
    }
}

/// The error code of a plugin error: a manifest the plugin's parser refuses, or a failed
/// download (CONTRACT §2.15.4 step 4, §2.15.5 step 1). The manifest request itself is made by
/// [`fetch_manifest`], which maps HTTP statuses with [`manifest_status_error`].
pub fn map_plugin_error(error: &tauri_plugin_updater::Error) -> ErrorCode {
    use tauri_plugin_updater::Error as E;
    match error {
        E::ReleaseNotFound => ErrorCode::NotPublished,
        E::Reqwest(e) => {
            if e.is_decode() && !e.is_timeout() && !e.is_connect() {
                ErrorCode::BadManifest
            } else {
                ErrorCode::Offline
            }
        }
        // The installer asset is missing although the manifest names it.
        E::Network(message) if message.contains("status: 404") => ErrorCode::BadManifest,
        E::Network(_) => ErrorCode::Offline,
        E::Serialization(_)
        | E::Semver(_)
        | E::UrlParse(_)
        | E::TargetNotFound(_)
        | E::TargetsNotFound(_) => ErrorCode::BadManifest,
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::MissingSignedVersion => {
            ErrorCode::BadSignature
        }
        E::SignedVersionMismatch { .. } => ErrorCode::NotNewer,
        _ => ErrorCode::Unknown,
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/// Updater state managed in [`AppState`].
#[derive(Default)]
pub struct UpdaterManager {
    inner: Mutex<Inner>,
    /// Wakes the scheduler for an evaluation at once.
    wake: Mutex<Option<mpsc::Sender<()>>>,
}

#[derive(Default)]
struct Inner {
    /// Version, build channel and the installed-copy check were resolved.
    initialized: bool,
    /// Why this copy does not update from inside the app (`None` = it does).
    disabled: Option<&'static str>,
    state: UpdateState,
    /// The plugin's offer for `install_update`.
    offer: Option<Update>,
    /// A check or an install is running: one network operation at a time.
    busy: bool,
    /// Failed automatic checks in this run.
    auto_failures: u32,
    /// Cancels the download task (set while one runs).
    abort_download: Option<Box<dyn Fn() + Send + Sync>>,
}

impl UpdaterManager {
    /// Cancels a running download (called when it turns out to be too big).
    fn abort_download(&self) {
        if let Some(abort) = lock(&self.inner).abort_download.as_ref() {
            abort();
        }
    }
}

/// The folder of the running `Nexum.exe`, in its plain form: the resolved path Tauri keeps is
/// a verbatim one (the `\\?\` prefix), which an installer should not be started under.
fn install_dir() -> std::io::Result<PathBuf> {
    let exe = tauri::utils::platform::current_exe()?;
    exe.parent()
        .map(|dir| settings::strip_verbatim(dir.to_path_buf()))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no program folder"))
}

/// True when this copy was put in place by the installer (its uninstaller sits next to it).
fn installed_copy() -> bool {
    install_dir()
        .map(|dir| dir.join(UNINSTALLER_NAME).is_file())
        .unwrap_or(false)
}

/// Resolves what never changes while Nexum runs. Makes no request.
fn ensure_init(app: &AppHandle, inner: &mut Inner) {
    if inner.initialized {
        return;
    }
    inner.initialized = true;
    let build = build_channel();
    inner.state.current_version = app.package_info().version.to_string();
    inner.state.build_channel = build;
    // The file check is only worth making for a build that could update at all.
    inner.disabled = disabled_reason(build, build.is_some() && installed_copy());
    if let Some(reason) = inner.disabled {
        inner.state.state = Status::Disabled;
        eprintln!("[nexum] in-app updates are off: {reason}");
    }
}

/// The members of `UpdateState` that mirror the settings.
fn derive_from_settings(inner: &mut Inner, channel_setting: &str, last_check_ts: Option<u64>) {
    inner.state.channel = if inner.disabled.is_some() {
        None
    } else {
        effective_channel(channel_setting, inner.state.build_channel)
    };
    inner.state.last_check_ts = last_check_ts;
}

fn update_settings_view(app: &AppHandle) -> (String, String, Option<u64>) {
    let state = app.state::<AppState>();
    let s = lock(&state.settings);
    (
        s.update_check.clone(),
        s.update_channel.clone(),
        s.last_update_check_ts,
    )
}

/// The current state. Never touches the network.
fn current_state(app: &AppHandle) -> UpdateState {
    let (_, channel_setting, last) = update_settings_view(app);
    let state = app.state::<AppState>();
    let mut inner = lock(&state.updater.inner);
    ensure_init(app, &mut inner);
    derive_from_settings(&mut inner, &channel_setting, last);
    inner.state.clone()
}

/// Changes the state and emits `update-state` when the result differs from what was there.
/// The settings lock is released before the updater lock is taken (never both at once).
fn set_state(app: &AppHandle, f: impl FnOnce(&mut Inner)) -> UpdateState {
    let (_, channel_setting, last) = update_settings_view(app);
    let state = app.state::<AppState>();
    let (snapshot, changed) = {
        let mut inner = lock(&state.updater.inner);
        ensure_init(app, &mut inner);
        let before = inner.state.clone();
        f(&mut inner);
        derive_from_settings(&mut inner, &channel_setting, last);
        (inner.state.clone(), inner.state != before)
    };
    if changed {
        let _ = app.emit("update-state", snapshot.clone());
    }
    snapshot
}

/// Asks the scheduler to evaluate the due rule now.
fn poke(app: &AppHandle) {
    if let Some(tx) = lock(&app.state::<AppState>().updater.wake).as_ref() {
        let _ = tx.send(());
    }
}

// ---------------------------------------------------------------------------------------------
// Checking (CONTRACT §2.15.4)
// ---------------------------------------------------------------------------------------------

/// TLS needs a crypto provider, and nothing installs one by default in this build. The plugin
/// does the same before its own requests.
fn ensure_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // Fails only when another thread installed one in the meantime, which is just as good.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// The one request of a check: the channel's manifest from its fixed URL, HTTPS only
/// (redirects included), with a timeout and never more than [`MAX_MANIFEST_BYTES`] of it.
async fn fetch_manifest(channel: Channel) -> Result<serde_json::Value, ErrorCode> {
    ensure_tls_provider();
    let offline = |e: reqwest::Error| {
        eprintln!("[nexum] update check failed: {e}");
        ErrorCode::Offline
    };
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(CHECK_TIMEOUT)
        .https_only(true)
        .build()
        .map_err(|e| {
            eprintln!("[nexum] update check could not start: {e}");
            ErrorCode::Unknown
        })?;
    let mut response = client
        .get(channel.manifest_url())
        .header("accept", "application/json")
        .send()
        .await
        .map_err(offline)?;
    let status = response.status().as_u16();
    if let Some(code) = manifest_status_error(status) {
        eprintln!("[nexum] update check failed: HTTP {status}");
        return Err(code);
    }
    if manifest_too_big(0, response.content_length()) {
        eprintln!("[nexum] update manifest refused: too big");
        return Err(ErrorCode::BadManifest);
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(offline)? {
        if manifest_too_big(body.len().saturating_add(chunk.len()), None) {
            eprintln!("[nexum] update manifest refused: too big");
            return Err(ErrorCode::BadManifest);
        }
        body.extend_from_slice(&chunk);
    }
    parse_manifest(&body).map_err(|code| {
        eprintln!("[nexum] update manifest refused: not a JSON object");
        code
    })
}

/// One check of `channel`: the manifest, then the plugin's own parser, target selection and
/// version rule on it, then Nexum's rules.
async fn fetch_offer(
    app: &AppHandle,
    channel: Channel,
    current: &Version,
) -> Result<Option<Update>, ErrorCode> {
    let url: tauri::Url = channel
        .manifest_url()
        .parse()
        .map_err(|_| ErrorCode::Unknown)?;
    let log = |e: tauri_plugin_updater::Error| {
        eprintln!("[nexum] update check failed: {e}");
        map_plugin_error(&e)
    };
    let manifest = fetch_manifest(channel).await?;
    let updater = app
        .updater_builder()
        // Never the endpoint list of the configuration file.
        .endpoints(vec![url])
        .map_err(log)?
        // Strictly greater. Stated explicitly although it is the plugin's default, so the
        // plugin's `allowDowngrades` switch can never apply.
        .version_comparator(|running, release| is_newer(&release.version, &running))
        // The download: HTTPS only, redirects included.
        .configure_client(|client| client.https_only(true))
        .build()
        .map_err(log)?;
    // `restore_update` makes no request. An update it returns always requires the signature
    // to carry the announced version (the plugin's `requireSignedVersion`), whatever the
    // configuration says.
    match updater.restore_update(manifest).map_err(log)? {
        None => Ok(None),
        Some(mut update) => {
            validate_offer(&update.version, update.download_url.as_str(), current, channel)
                .map_err(|code| {
                    eprintln!(
                        "[nexum] update manifest refused ({code:?}): version {} at {}",
                        update.version, update.download_url
                    );
                    code
                })?;
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            Ok(Some(update))
        }
    }
}

/// `check(kind)`: guards, one request, state. `Err` only for the consent refusal.
async fn run_check(app: &AppHandle, kind: CheckKind) -> Result<UpdateState, String> {
    let (update_check, channel_setting, _) = update_settings_view(app);

    // 1. Guards. Nothing below this block runs unless the user agreed to this kind of check.
    let (before, channel) = {
        let state = app.state::<AppState>();
        let mut inner = lock(&state.updater.inner);
        ensure_init(app, &mut inner);
        match check_gate(inner.disabled.is_none(), &update_check, kind) {
            Gate::Allowed => {}
            Gate::NotAnswered => return Err(ERR_NOT_ANSWERED.to_string()),
            Gate::Disabled | Gate::NotAutomatic => return Ok(inner.state.clone()),
        }
        let in_progress = matches!(
            inner.state.state,
            Status::Checking | Status::Downloading | Status::Ready | Status::Installing
        );
        let Some(channel) = effective_channel(&channel_setting, inner.state.build_channel)
        else {
            return Ok(inner.state.clone());
        };
        if inner.busy || in_progress {
            return Ok(inner.state.clone());
        }
        inner.busy = true;
        (inner.state.clone(), channel)
    };

    // 2. An automatic re-check of an offer that is already on screen stays invisible; every
    // other check shows `checking`.
    let silent = kind == CheckKind::Automatic && before.state == Status::Available;
    if !silent {
        set_state(app, |inner| {
            inner.state.state = Status::Checking;
            inner.state.clear_error();
            inner.state.clear_progress();
        });
    }

    let current = app.package_info().version.clone();
    let result = fetch_offer(app, channel, &current).await;

    // The channel may have been changed while the request was under way: its answer is then
    // about the wrong channel and is dropped.
    let build = before.build_channel;
    let still_wanted =
        |setting: &str| effective_channel(setting, build) == Some(channel);

    // 3. An answered check moves the 24 h throttle (saved to disk).
    if result.is_ok() {
        let now = now_ms();
        let saved = settings::update_settings(app, |s| {
            if still_wanted(&s.update_channel) {
                s.last_update_check_ts = Some(now);
            }
        });
        if let Err(e) = saved {
            eprintln!("[nexum] could not save the time of the update check: {e}");
        }
    }

    let (_, channel_now, _) = update_settings_view(app);
    let stale = !still_wanted(&channel_now);
    let snapshot = set_state(app, |inner| {
        inner.busy = false;
        if stale {
            inner.offer = None;
            inner.state.state = Status::Idle;
            inner.state.clear_offer();
            inner.state.clear_error();
            inner.state.clear_progress();
            return;
        }
        match result {
            Ok(Some(update)) => {
                inner.state.state = Status::Available;
                inner.state.latest_version = Some(update.version.clone());
                inner.state.notes = clean_notes(update.body.as_deref());
                inner.state.published_at = update
                    .date
                    .as_ref()
                    .and_then(|d| rfc3339_utc(d.unix_timestamp()));
                inner.state.clear_error();
                inner.state.clear_progress();
                inner.offer = Some(update);
            }
            Ok(None) => {
                inner.state.state = Status::Idle;
                inner.state.clear_offer();
                inner.state.clear_error();
                inner.state.clear_progress();
                inner.offer = None;
            }
            // 4. A failed automatic check is silent: back to what was there before.
            Err(_) if kind == CheckKind::Automatic => {
                inner.auto_failures = inner.auto_failures.saturating_add(1);
                inner.state = before.clone();
            }
            Err(code) => inner.state.set_error(code),
        }
    });
    if stale {
        // The new channel still wants its own check.
        poke(app);
    }
    Ok(snapshot)
}

// ---------------------------------------------------------------------------------------------
// Installing (CONTRACT §2.15.5)
// ---------------------------------------------------------------------------------------------

fn fail_install(app: &AppHandle, code: ErrorCode) {
    set_state(app, |inner| {
        inner.busy = false;
        inner.abort_download = None;
        // The offer is kept, so "Try again" can call `install_update` again.
        inner.state.set_error(code);
    });
}

/// Step 1: download into memory. The plugin verifies the minisign signature of the bytes
/// against the public key compiled into the app before it returns them, and checks that the
/// signed trusted comment carries the announced version.
async fn download_verified(app: &AppHandle, offer: &Update) -> Result<Vec<u8>, ErrorCode> {
    let too_big = Arc::new(AtomicBool::new(false));
    let flag = too_big.clone();
    let progress_app = app.clone();
    let task_offer = offer.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut received: u64 = 0;
        let mut last_emit: Option<Instant> = None;
        task_offer
            .download(
                move |chunk, total| {
                    received = received.saturating_add(chunk as u64);
                    if download_too_big(received, total) {
                        flag.store(true, Ordering::SeqCst);
                        progress_app.state::<AppState>().updater.abort_download();
                        return;
                    }
                    if last_emit.is_some_and(|at| at.elapsed() < PROGRESS_EVERY) {
                        return;
                    }
                    last_emit = Some(Instant::now());
                    set_state(&progress_app, |inner| {
                        if inner.state.state == Status::Downloading {
                            inner.state.downloaded_bytes = Some(received);
                            inner.state.total_bytes = total;
                            inner.state.progress = progress_pct(received, total);
                        }
                    });
                },
                || {},
            )
            .await
    });
    {
        let abort = task.inner().abort_handle();
        let state = app.state::<AppState>();
        lock(&state.updater.inner).abort_download = Some(Box::new(move || abort.abort()));
    }
    let joined = task.await;
    lock(&app.state::<AppState>().updater.inner).abort_download = None;
    match joined {
        Ok(Ok(bytes)) if bytes.len() as u64 > MAX_DOWNLOAD_BYTES => Err(ErrorCode::BadManifest),
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => {
            eprintln!("[nexum] update download failed: {e}");
            Err(if too_big.load(Ordering::SeqCst) {
                ErrorCode::BadManifest
            } else {
                map_plugin_error(&e)
            })
        }
        Err(e) => {
            // Cancelled because it was too big, or the task died.
            eprintln!("[nexum] update download stopped: {e}");
            Err(if too_big.load(Ordering::SeqCst) {
                ErrorCode::BadManifest
            } else {
                ErrorCode::Unknown
            })
        }
    }
}

/// A staged installer: the pinned folder, the handle that pins the file, and its path.
struct Staged {
    pinned: PinnedDir,
    held: File,
    path: PathBuf,
}

/// Opens the staged file so that nobody can write to, delete or replace it. A virus scanner
/// may hold the new file for a moment, so a refused open is retried briefly.
fn open_pinned(pinned: &PinnedDir, name: &str) -> std::io::Result<File> {
    let mut last = None;
    for attempt in 0..10 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        match pinned.open_read_exclusive(name) {
            Ok(file) => return Ok(file),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("the staged file could not be opened")))
}

/// Steps 3 and 4: write the verified bytes into `<dir>\updates`, pin the file, and prove that
/// what is on disk is what was verified.
fn stage(dir: &Path, version: &str, bytes: &[u8]) -> Result<Staged, ErrorCode> {
    let write_error = |what: &str, e: std::io::Error| {
        eprintln!("[nexum] update staging failed ({what}): {e}");
        ErrorCode::Write
    };
    // A folder made new for this install, for SYSTEM and Administrators only: whatever had
    // that name before (leftovers of an earlier attempt, or something planted) is removed and
    // never reused, the access list is set in the call that creates the folder, and it is
    // pinned and checked. Wherever Nexum was installed, nothing without administrator rights
    // can reach into it.
    let pinned = PinnedDir::create_admin_only(dir, STAGING_DIR)
        .map_err(|e| write_error("folder", e))?;
    // The file is created new with the same access list, so no other process can ever have
    // held a handle to it or a writable mapping of it.
    let (mut file, path) = pinned
        .create_new_file_admin_only(&format!("{}.exe", staged_stem(version)))
        .map_err(|e| write_error("create", e))?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&path);
        return Err(write_error("write", e));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut held = match open_pinned(&pinned, &name) {
        Ok(file) => file,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(write_error("pin", e));
        }
    };
    // Read back through the handle that now denies every write: from here on the file can
    // only be what these bytes are.
    let same = held
        .metadata()
        .map(|m| m.len() == bytes.len() as u64)
        .and_then(|same_len| Ok(same_len && reader_matches(&mut held, bytes)?));
    match same {
        Ok(true) => Ok(Staged { pinned, held, path }),
        Ok(false) => {
            eprintln!("[nexum] the staged update differs from the verified download");
            drop(held);
            let _ = std::fs::remove_file(&path);
            Err(ErrorCode::BadSignature)
        }
        Err(e) => {
            drop(held);
            let _ = std::fs::remove_file(&path);
            Err(write_error("read back", e))
        }
    }
}

/// Step 6: `CreateProcessW` on the absolute path, no shell, nothing inherited but null stdio.
/// The installer starts in System32, not in whatever folder Nexum happened to be started
/// from (which a non-elevated process may be able to write to).
fn launch_installer(path: &Path) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    Command::new(path)
        .args(INSTALLER_ARGS)
        .current_dir(crate::util::windows_dir().join("System32"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_child| ())
}

/// Steps 3 to 7 on a blocking thread. On success this does not return to a running app.
fn stage_and_launch(app: &AppHandle, version: &str, bytes: Vec<u8>) -> Result<(), ErrorCode> {
    let dir = install_dir().map_err(|e| {
        eprintln!("[nexum] the program folder is unavailable: {e}");
        ErrorCode::Write
    })?;
    let staged = stage(&dir, version, &bytes)?;
    drop(bytes);

    // 5. Verified and pinned. Stop what Quit stops, in the same order: the sensor log, then
    // the sensor service (fans go back to BIOS control, frame capture stops).
    set_state(app, |inner| {
        inner.state.state = Status::Ready;
        inner.state.progress = Some(100);
    });
    crate::sensor_log::shutdown(app);
    crate::agent::stop(app);

    // 6. Start the installer.
    if let Err(e) = launch_installer(&staged.path) {
        eprintln!("[nexum] the update installer could not be started: {e}");
        let code = launch_error_code(e.raw_os_error());
        let Staged { pinned, held, path } = staged;
        drop(held);
        let _ = std::fs::remove_file(&path);
        let _ = pinned.remove_entries();
        drop(pinned);
        let _ = std::fs::remove_dir(dir.join(STAGING_DIR));
        crate::agent::start(app);
        return Err(code);
    }

    // 7. The installer runs. Its file stays pinned until this process is gone.
    set_state(app, |inner| inner.state.state = Status::Installing);
    std::thread::sleep(EXIT_DELAY);
    let Staged { pinned, held, .. } = staged;
    std::mem::forget(held);
    std::mem::forget(pinned);
    crate::quit(app);
    Ok(())
}

async fn run_install(app: AppHandle, offer: Update) {
    let bytes = match download_verified(&app, &offer).await {
        Ok(bytes) => bytes,
        Err(code) => return fail_install(&app, code),
    };

    // 2. The manifest is not signed, only the installer is: bind the version to the file.
    let current = app.package_info().version.clone();
    if let Err(code) = check_signed_binding(&offer.signature, &offer.version, &current) {
        eprintln!("[nexum] the update signature is not for this version ({code:?})");
        return fail_install(&app, code);
    }

    let worker = app.clone();
    let version = offer.version.clone();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || stage_and_launch(&worker, &version, bytes))
            .await;
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(code)) => fail_install(&app, code),
        Err(e) => {
            eprintln!("[nexum] the update worker failed: {e}");
            fail_install(&app, ErrorCode::Unknown);
        }
    }
}

/// Step 8 (next start): removes what an earlier update left in `<Nexum folder>\updates`.
fn cleanup_staging() {
    let Ok(dir) = install_dir() else {
        return;
    };
    let staging = dir.join(STAGING_DIR);
    if !staging.exists() {
        return;
    }
    match PinnedDir::open(&dir, &staging, false) {
        Ok(pinned) => {
            let left = pinned.remove_entries().unwrap_or(1);
            drop(pinned);
            if left == 0 {
                let _ = std::fs::remove_dir(&staging);
            }
        }
        Err(e) => eprintln!("[nexum] could not clean the update folder: {e}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Scheduler and entry points
// ---------------------------------------------------------------------------------------------

/// Runs an automatic check when the due rule says so.
fn evaluate(app: &AppHandle) {
    let (update_check, _, last) = update_settings_view(app);
    let (enabled, failures) = {
        let state = app.state::<AppState>();
        let mut inner = lock(&state.updater.inner);
        ensure_init(app, &mut inner);
        (inner.disabled.is_none(), inner.auto_failures)
    };
    if !auto_check_due(enabled, &update_check, last, now_ms(), failures) {
        return;
    }
    if let Err(e) = tauri::async_runtime::block_on(run_check(app, CheckKind::Automatic)) {
        eprintln!("[nexum] automatic update check skipped: {e}");
    }
}

fn scheduler(app: AppHandle, wake: mpsc::Receiver<()>) {
    let started = Instant::now();
    std::thread::sleep(CLEANUP_DELAY);
    let (enabled, busy) = {
        let state = app.state::<AppState>();
        let mut inner = lock(&state.updater.inner);
        ensure_init(&app, &mut inner);
        (inner.disabled.is_none(), inner.busy)
    };
    if !busy {
        cleanup_staging();
    }
    if !enabled {
        // No channel, or not an installed copy: this thread never makes a request.
        return;
    }
    let mut wait = FIRST_CHECK_DELAY.saturating_sub(started.elapsed());
    loop {
        match wake.recv_timeout(wait) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        while wake.try_recv().is_ok() {}
        evaluate(&app);
        wait = RECHECK_EVERY;
    }
}

/// Starts the update scheduler (called once from `setup`). It makes no request unless
/// `Settings.updateCheck` is `"auto"`.
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    *lock(&app.state::<AppState>().updater.wake) = Some(tx);
    let worker = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nexum-updater".into())
        .spawn(move || scheduler(worker, rx));
    if let Err(e) = spawned {
        eprintln!("[nexum] update scheduler unavailable: {e}");
    }
}

/// `save_settings` changed something (CONTRACT §2.15.4): a new channel discards a pending
/// offer; a new channel or a switch to `"auto"` evaluates the due rule at once.
pub fn on_settings_changed(app: &AppHandle, old: &Settings, new: &Settings) {
    let new_channel = channel_changed(old, new);
    let became_auto = new.update_check == settings::UPDATE_CHECK_AUTO
        && old.update_check != settings::UPDATE_CHECK_AUTO;
    if new_channel {
        set_state(app, |inner| {
            inner.offer = None;
            inner.auto_failures = 0;
            // A check under way notices the change itself; an install keeps what it started.
            if matches!(
                inner.state.state,
                Status::Idle | Status::Available | Status::Error
            ) && !inner.busy
            {
                inner.state.state = Status::Idle;
                inner.state.clear_offer();
                inner.state.clear_error();
                inner.state.clear_progress();
            }
        });
    } else if old.update_check != new.update_check {
        // Nothing to discard; listeners still get the current state.
        set_state(app, |_| {});
    }
    if new_channel || became_auto {
        poke(app);
    }
}

/// `get_update_state`: the current state. Never touches the network.
#[tauri::command]
pub fn get_update_state(app: AppHandle) -> Result<UpdateState, String> {
    Ok(current_state(&app))
}

/// `check_for_update`: a check the user asked for. Resolves with the final state; `Err` while
/// the first-run question is unanswered.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateState, String> {
    run_check(&app, CheckKind::User).await
}

/// `install_update`: download → verify → stage → start the installer → exit. Returns once the
/// work has started; progress and failures arrive through `update-state`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let (update_check, _, _) = update_settings_view(&app);
    let mut refused: Option<&'static str> = None;
    let mut offer: Option<Update> = None;
    set_state(&app, |inner| {
        let gate = install_gate(
            inner.disabled.is_none(),
            &update_check,
            inner.state.state,
            inner.busy,
            inner.offer.is_some(),
        );
        if let Err(text) = gate {
            refused = Some(text);
            return;
        }
        offer = inner.offer.clone();
        inner.busy = true;
        inner.state.state = Status::Downloading;
        inner.state.clear_error();
        inner.state.progress = None;
        inner.state.downloaded_bytes = Some(0);
        inner.state.total_bytes = None;
    });
    if let Some(text) = refused {
        return Err(text.to_string());
    }
    let Some(offer) = offer else {
        return Err(ERR_NO_OFFER.to_string());
    };
    tauri::async_runtime::spawn(run_install(app, offer));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        parse_version(s).unwrap()
    }

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    /// A `.sig` file's content for a trusted comment (the two signature lines are dummies:
    /// these tests exercise the parser, the plugin verifies real signatures).
    fn sig(trusted: &str) -> String {
        b64(&format!(
            "untrusted comment: signature from tauri secret key\nRUTdummy\ntrusted comment: {trusted}\nGLOBALdummy\n"
        ))
    }

    /// The trusted comment the release pipeline writes for the installer of `version`.
    fn signed_for(version: &str) -> String {
        sig(&format!(
            "timestamp:1795800000\tfile:Nexum_{version}_x64-setup.exe\tversion:{version}"
        ))
    }

    #[test]
    fn never_downgrades_and_never_reinstalls() {
        let cur = v("1.2.0");
        assert!(is_newer(&v("1.2.1"), &cur));
        assert!(is_newer(&v("1.3.0"), &cur));
        assert!(is_newer(&v("2.0.0"), &cur));
        // The same version is not an update.
        assert!(!is_newer(&v("1.2.0"), &cur));
        // Older versions are refused, however they are spelled.
        assert!(!is_newer(&v("1.1.9"), &cur));
        assert!(!is_newer(&v("1.1.0"), &cur));
        assert!(!is_newer(&v("0.9.0"), &cur));
        assert!(!is_newer(&v("v1.1.0"), &cur));
        // Build metadata does not make a version newer (SemVer precedence).
        assert!(!is_newer(&v("1.2.0+build.7"), &cur));
        assert!(!is_newer(&v("1.2.0"), &v("1.2.0+build.7")));
        // A pre-release is older than its release.
        assert!(!is_newer(&v("1.2.0-preview.9"), &cur));
        assert!(is_newer(&cur, &v("1.2.0-preview.9")));
    }

    #[test]
    fn preview_versions_upgrade_in_the_wanted_order() {
        // CONTRACT §2.15.2: 1.2.0-preview.1 < 1.2.0-preview.2 < 1.2.0 < 1.3.0-preview.1.
        let order = ["1.2.0-preview.1", "1.2.0-preview.2", "1.2.0-preview.10", "1.2.0", "1.3.0-preview.1", "1.3.0"];
        for (i, a) in order.iter().enumerate() {
            for (j, b) in order.iter().enumerate() {
                assert_eq!(is_newer(&v(b), &v(a)), j > i, "{a} -> {b}");
            }
        }
    }

    #[test]
    fn versions_parse_without_a_leading_v() {
        assert_eq!(v("v1.2.3"), v("1.2.3"));
        assert_eq!(v(" 1.2.3-preview.1 ").to_string(), "1.2.3-preview.1");
        for bad in ["", "1.2", "latest", "1.2.3.4", "01.2.3", "1.2.x"] {
            assert!(parse_version(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn manifest_offers_are_validated() {
        let cur = v("1.2.0");
        let url = "https://github.com/captainRapipo/nexum/releases/download/v1.3.0/Nexum_1.3.0_x64-setup.exe";
        for channel in [Channel::Stable, Channel::Preview] {
            assert_eq!(validate_offer("1.3.0", url, &cur, channel), Ok(v("1.3.0")));
            assert_eq!(validate_offer("v1.3.0", url, &cur, channel), Ok(v("1.3.0")));
            // Not newer: a downgrade or the same version is never an offer.
            assert_eq!(validate_offer("1.2.0", url, &cur, channel), Err(ErrorCode::NotNewer));
            assert_eq!(validate_offer("1.1.0", url, &cur, channel), Err(ErrorCode::NotNewer));
            // Unreadable version.
            assert_eq!(validate_offer("newest", url, &cur, channel), Err(ErrorCode::BadManifest));
            // Any other host or repository.
            for bad in [
                "https://example.com/Nexum_1.3.0_x64-setup.exe",
                "https://github.com/someone-else/nexum/releases/download/v1.3.0/Nexum_1.3.0_x64-setup.exe",
                "https://github.com/captainRapipo/nexum-fork/releases/download/v1.3.0/x.exe",
                "https://github.com.evil.example/captainRapipo/nexum/releases/download/v1.3.0/x.exe",
                "https://github.com@evil.example/captainRapipo/nexum/releases/download/v1.3.0/x.exe",
                "http://github.com/captainRapipo/nexum/releases/download/v1.3.0/x.exe",
                "https://github.com/captainRapipo/nexum/releases/download/",
                "https://github.com/captainRapipo/nexum/releases/download/../../../../evil/x.exe",
                "https://github.com/captainRapipo/nexum/releases/download/v1.3.0/x.exe#@evil.example",
                "https://objects.githubusercontent.com/x.exe",
                "",
            ] {
                assert_eq!(
                    validate_offer("1.3.0", bad, &cur, channel),
                    Err(ErrorCode::BadManifest),
                    "{bad}"
                );
            }
        }
        assert!(url_allowed(url));
    }

    #[test]
    fn the_stable_channel_never_takes_a_preview_version() {
        let url = "https://github.com/captainRapipo/nexum/releases/download/v1.3.0-preview.1/Nexum_1.3.0-preview.1_x64-setup-UNSIGNED-PREVIEW.exe";
        // A stable install, and a preview install whose user switched back to stable.
        for cur in [v("1.2.0"), v("1.2.0-preview.4")] {
            assert_eq!(
                validate_offer("1.3.0-preview.1", url, &cur, Channel::Stable),
                Err(ErrorCode::BadManifest)
            );
            assert_eq!(
                validate_offer("1.3.0-preview.1", url, &cur, Channel::Preview),
                Ok(v("1.3.0-preview.1"))
            );
            // The stable release that follows is taken on both.
            assert_eq!(validate_offer("1.3.0", url, &cur, Channel::Stable), Ok(v("1.3.0")));
            assert_eq!(validate_offer("1.3.0", url, &cur, Channel::Preview), Ok(v("1.3.0")));
        }
        // Build metadata is not a pre-release.
        assert_eq!(
            validate_offer("1.3.0+7", url, &v("1.2.0"), Channel::Stable),
            Ok(v("1.3.0+7"))
        );
    }

    #[test]
    fn manifest_request_rules() {
        // HTTP statuses (CONTRACT §2.15.4 step 4).
        for ok in [200u16, 204, 206, 299] {
            assert_eq!(manifest_status_error(ok), None);
        }
        assert_eq!(manifest_status_error(404), Some(ErrorCode::NotPublished));
        for other in [100u16, 301, 302, 304, 400, 401, 403, 410, 429, 500, 502, 503] {
            assert_eq!(manifest_status_error(other), Some(ErrorCode::Offline), "{other}");
        }

        // The size limit, announced or received.
        assert_eq!(MAX_MANIFEST_BYTES, 256 * 1024);
        assert!(!manifest_too_big(0, None));
        assert!(!manifest_too_big(MAX_MANIFEST_BYTES, Some(MAX_MANIFEST_BYTES as u64)));
        assert!(manifest_too_big(MAX_MANIFEST_BYTES + 1, None));
        assert!(manifest_too_big(0, Some(MAX_MANIFEST_BYTES as u64 + 1)));
        assert!(manifest_too_big(0, Some(u64::MAX)));
        assert!(manifest_too_big(usize::MAX, None));

        // A JSON object, nothing else.
        let good = br#"{"version":"1.3.0","platforms":{}}"#;
        assert_eq!(parse_manifest(good).unwrap()["version"], "1.3.0");
        let not_manifests: [&[u8]; 7] = [
            b"",
            b"{",
            b"[]",
            b"\"1.3.0\"",
            b"null",
            b"<html>Not found</html>",
            b"{\"version\":\"1.3.0\"} trailing",
        ];
        for bad in not_manifests {
            assert_eq!(parse_manifest(bad), Err(ErrorCode::BadManifest));
        }
        // Too big is refused without being parsed, valid JSON or not.
        let mut huge = b"{\"notes\":\"".to_vec();
        huge.resize(MAX_MANIFEST_BYTES, b'x');
        huge.extend_from_slice(b"\"}");
        assert_eq!(parse_manifest(&huge), Err(ErrorCode::BadManifest));
    }

    #[test]
    fn channels_map_to_their_fixed_urls() {
        assert_eq!(
            Channel::Stable.manifest_url(),
            "https://github.com/captainRapipo/nexum/releases/download/updates/stable.json"
        );
        assert_eq!(
            Channel::Preview.manifest_url(),
            "https://github.com/captainRapipo/nexum/releases/download/updates/preview.json"
        );
        // Both live in this repository's releases, over https, with nothing to substitute.
        for c in [Channel::Stable, Channel::Preview] {
            let url = c.manifest_url();
            assert!(url.starts_with(DOWNLOAD_PREFIX));
            assert!(url.starts_with("https://github.com/captainRapipo/nexum/"));
            assert!(!url.contains("{{"));
            assert!(url.parse::<tauri::Url>().is_ok());
        }
        assert_eq!(serde_json::to_value(Channel::Stable).unwrap(), "stable");
        assert_eq!(serde_json::to_value(Channel::Preview).unwrap(), "preview");
    }

    #[test]
    fn build_and_effective_channel() {
        assert_eq!(parse_build_channel(Some("stable")), Some(Channel::Stable));
        assert_eq!(parse_build_channel(Some(" preview ")), Some(Channel::Preview));
        for none in [None, Some(""), Some("beta"), Some("Stable"), Some("1")] {
            assert_eq!(parse_build_channel(none), None);
        }
        // Tests are debug builds: never a channel, so never a request.
        assert_eq!(build_channel(), None);

        let s = Some(Channel::Stable);
        let p = Some(Channel::Preview);
        // "default" follows the build.
        assert_eq!(effective_channel("default", s), s);
        assert_eq!(effective_channel("default", p), p);
        // The setting wins in both directions (a preview user can go back to stable).
        assert_eq!(effective_channel("preview", s), p);
        assert_eq!(effective_channel("stable", p), s);
        // Unknown values behave like "default".
        assert_eq!(effective_channel("nightly", p), p);
        assert_eq!(effective_channel("", s), s);
        // No build channel: disabled whatever the setting says.
        for setting in ["default", "stable", "preview", "x"] {
            assert_eq!(effective_channel(setting, None), None);
        }

        assert!(effective_channel_changed("default", "preview", s));
        assert!(!effective_channel_changed("default", "stable", s));
        assert!(!effective_channel_changed("default", "preview", p));
        assert!(effective_channel_changed("preview", "stable", p));
        assert!(!effective_channel_changed("preview", "stable", None));
    }

    #[test]
    fn consent_gates_every_request() {
        use CheckKind::{Automatic, User};
        // Not answered yet: no request of any kind.
        assert_eq!(check_gate(true, "ask", User), Gate::NotAnswered);
        assert_eq!(check_gate(true, "ask", Automatic), Gate::NotAnswered);
        // An unreadable value is "not answered", never "auto".
        for odd in ["", "AUTO", "yes", "always", "Auto "] {
            assert_eq!(check_gate(true, odd, User), Gate::NotAnswered, "{odd:?}");
            assert_eq!(check_gate(true, odd, Automatic), Gate::NotAnswered, "{odd:?}");
        }
        // "manual": only a click.
        assert_eq!(check_gate(true, "manual", User), Gate::Allowed);
        assert_eq!(check_gate(true, "manual", Automatic), Gate::NotAutomatic);
        // "auto": both.
        assert_eq!(check_gate(true, "auto", User), Gate::Allowed);
        assert_eq!(check_gate(true, "auto", Automatic), Gate::Allowed);
        // A build or copy that cannot update never asks, whatever the setting.
        for mode in ["ask", "auto", "manual"] {
            assert_eq!(check_gate(false, mode, User), Gate::Disabled);
            assert_eq!(check_gate(false, mode, Automatic), Gate::Disabled);
        }
        // The default settings keep the network off.
        let d = Settings::default();
        assert_eq!(check_gate(true, &d.update_check, User), Gate::NotAnswered);
        assert!(!auto_check_due(true, &d.update_check, None, 1_800_000_000_000, 0));
    }

    #[test]
    fn automatic_checks_are_throttled_to_one_a_day() {
        let now = 1_800_000_000_000u64;
        let h = 60 * 60 * 1000u64;
        assert_eq!(CHECK_INTERVAL_MS, 24 * h);
        // Never checked: due.
        assert!(is_due(None, now));
        // Checked less than 24 h ago: not due.
        assert!(!is_due(Some(now), now));
        assert!(!is_due(Some(now - 1), now));
        assert!(!is_due(Some(now - 23 * h), now));
        assert!(!is_due(Some(now - (24 * h - 1)), now));
        // 24 h or more: due.
        assert!(is_due(Some(now - 24 * h), now));
        assert!(is_due(Some(now - 30 * 24 * h), now));
        // The clock moved back: due (otherwise a wrong clock could switch checks off for years).
        assert!(is_due(Some(now + 1), now));
        assert!(is_due(Some(u64::MAX), now));

        // The whole rule the scheduler evaluates.
        assert!(auto_check_due(true, "auto", None, now, 0));
        assert!(!auto_check_due(true, "auto", Some(now - h), now, 0), "throttled");
        assert!(auto_check_due(true, "auto", Some(now - 25 * h), now, 0));
        assert!(!auto_check_due(true, "manual", None, now, 0), "only on a click");
        assert!(!auto_check_due(true, "ask", None, now, 0), "not answered");
        assert!(!auto_check_due(false, "auto", None, now, 0), "disabled build");
        // At most three failed automatic attempts per run.
        assert!(auto_check_due(true, "auto", None, now, MAX_AUTO_FAILURES - 1));
        assert!(!auto_check_due(true, "auto", None, now, MAX_AUTO_FAILURES));
        assert!(!auto_check_due(true, "auto", None, now, u32::MAX));

        // An hourly evaluation over three days asks exactly once per 24 h when every check
        // is answered.
        let mut last = None;
        let mut checks = 0;
        for hour in 0..72u64 {
            let t = now + hour * h;
            if auto_check_due(true, "auto", last, t, 0) {
                checks += 1;
                last = Some(t);
            }
        }
        assert_eq!(checks, 3);
    }

    #[test]
    fn disabled_builds_and_portable_copies() {
        assert!(disabled_reason(None, true).is_some());
        assert!(disabled_reason(None, false).is_some());
        assert!(disabled_reason(Some(Channel::Stable), false).is_some());
        assert_eq!(disabled_reason(Some(Channel::Stable), true), None);
        assert_eq!(disabled_reason(Some(Channel::Preview), true), None);

        // A debug build (every test run) is disabled: the state says so and nothing installs.
        let mut inner = Inner::default();
        inner.initialized = true;
        inner.disabled = disabled_reason(build_channel(), false);
        inner.state.state = Status::Disabled;
        derive_from_settings(&mut inner, "preview", Some(5));
        assert_eq!(inner.state.channel, None);
        assert_eq!(inner.state.last_check_ts, Some(5));
        assert_eq!(
            install_gate(false, "auto", Status::Disabled, false, false),
            Err("This build does not update from inside the app.")
        );
    }

    #[test]
    fn install_preconditions() {
        let busy = "An update is already in progress.";
        assert_eq!(install_gate(true, "auto", Status::Available, false, true), Ok(()));
        assert_eq!(install_gate(true, "manual", Status::Available, false, true), Ok(()));
        // After a failed install of the same offer: "Try again".
        assert_eq!(install_gate(true, "manual", Status::Error, false, true), Ok(()));
        // Never before the first-run question is answered.
        assert_eq!(
            install_gate(true, "ask", Status::Available, false, true),
            Err("Choose how Nexum checks for updates first.")
        );
        for status in [Status::Downloading, Status::Ready, Status::Installing] {
            assert_eq!(install_gate(true, "auto", status, false, true), Err(busy));
        }
        assert_eq!(install_gate(true, "auto", Status::Checking, true, true), Err(busy));
        assert_eq!(
            install_gate(true, "auto", Status::Idle, false, false),
            Err("Check for updates first.")
        );
        assert_eq!(
            install_gate(true, "auto", Status::Error, false, false),
            Err("Check for updates first.")
        );
    }

    #[test]
    fn trusted_comment_is_read_the_way_the_verifier_reads_it() {
        // What `tauri signer sign --app-version` and the bundler write.
        let plain = "timestamp:1795800000\tfile:Nexum_1.3.0_x64-setup.exe\tversion:1.3.0";
        assert_eq!(trusted_comment(&sig(plain)).as_deref(), Some(plain));
        // CRLF line ends, and no line end after the last line.
        let crlf = b64(&format!(
            "untrusted comment: x\r\nRUTdummy\r\ntrusted comment: {plain}\r\nGLOBALdummy"
        ));
        assert_eq!(trusted_comment(&crlf).as_deref(), Some(plain));

        // The FIRST line is the untrusted comment: no signature covers it, so whoever writes
        // the manifest can put anything there, including a line that looks like a trusted
        // comment. Only the third line counts.
        let forged_line = "trusted comment: timestamp:1\tfile:Nexum_9.9.9_x64-setup.exe\tversion:9.9.9";
        let forged = b64(&format!(
            "{forged_line}\nRUTdummy\ntrusted comment: {plain}\nGLOBALdummy\n"
        ));
        assert_eq!(trusted_comment(&forged).as_deref(), Some(plain));
        // A forged line anywhere else does not count either.
        let appended = b64(&format!(
            "untrusted comment: x\nRUTdummy\ntrusted comment: {plain}\nGLOBALdummy\n{forged_line}\n"
        ));
        assert_eq!(trusted_comment(&appended).as_deref(), Some(plain));
        // No trusted comment on the third line: nothing, however many there are elsewhere.
        let shifted = b64(&format!(
            "untrusted comment: x\n{forged_line}\nRUTdummy\ntrusted comment: {plain}\nGLOBALdummy\n"
        ));
        assert_eq!(trusted_comment(&shifted), None);
        let wrong_prefix = b64("untrusted comment: x\nRUT\nTrusted comment: a\nG\n");
        assert_eq!(trusted_comment(&wrong_prefix), None);

        // Not base64, not text, too few lines.
        assert_eq!(trusted_comment("not base64 !!"), None);
        assert_eq!(
            trusted_comment(&base64::engine::general_purpose::STANDARD.encode([0xFFu8, 0xFE, 0xFD])),
            None
        );
        assert_eq!(trusted_comment(&b64("untrusted comment: x\nRUT\n")), None);
        assert_eq!(trusted_comment(""), None);
        // The plugin decodes the signature as it is; so does this (no trimming).
        assert_eq!(trusted_comment(&format!(" {}", sig(plain))), None);
    }

    #[test]
    fn signed_fields_and_installer_names() {
        assert_eq!(
            signed_fields("timestamp:1795800000\tfile:Nexum_1.3.0_x64-setup.exe\tversion:1.3.0"),
            (Some("1.3.0"), Some("Nexum_1.3.0_x64-setup.exe"))
        );
        // The first occurrence of a key counts.
        assert_eq!(
            signed_fields("version:1.3.0\tversion:9.9.9\tfile:a.exe\tfile:b.exe"),
            (Some("1.3.0"), Some("a.exe"))
        );
        assert_eq!(signed_fields("timestamp:1795800000\tfile:payload"), (None, Some("payload")));
        assert_eq!(signed_fields("timestamp:1795800000"), (None, None));
        assert_eq!(signed_fields(""), (None, None));
        // A key is a whole field, from its first character.
        assert_eq!(signed_fields("xversion:1.3.0\t file:a.exe"), (None, None));

        assert_eq!(
            version_from_file_name("Nexum_1.2.0-preview.1_x64-setup.exe").as_deref(),
            Some("1.2.0-preview.1")
        );
        assert_eq!(version_from_file_name("Nexum_1.2.0_x64-setup.exe").as_deref(), Some("1.2.0"));
        for other in [
            "Nexum_x64-setup.exe",
            "Nexum_latest_x64-setup.exe",
            "Nexum_v1.2.0_x64-setup.exe",
            "Nexum_ 1.2.0_x64-setup.exe",
            "Other_1.2.0_x64-setup.exe",
            "Nexum_1.2.0_x64-setup.exe.zip",
            "Nexum_1.2.0_x64-setup-UNSIGNED-PREVIEW.exe",
            "Nexum_1.2.0_x64-setup.EXE",
            "Nexum_1.2.0_arm64-setup.exe",
            r"D:\a\out\Nexum_1.2.0_x64-setup.exe",
            "out/Nexum_1.2.0_x64-setup.exe",
            "setup.exe",
            "",
        ] {
            assert_eq!(version_from_file_name(other), None, "{other}");
        }
    }

    #[test]
    fn version_is_bound_to_the_signed_file() {
        let cur = v("1.2.0");
        let s = |fields: &str| sig(&format!("timestamp:1795800000\t{fields}"));
        // The signature names the announced version and its installer, and it is newer: bound.
        assert_eq!(check_signed_binding(&signed_for("1.3.0"), "1.3.0", &cur), Ok(()));
        assert_eq!(check_signed_binding(&signed_for("1.3.0"), "v1.3.0", &cur), Ok(()));
        assert_eq!(
            check_signed_binding(&signed_for("1.3.0-preview.2"), "1.3.0-preview.2", &cur),
            Ok(())
        );
        // Rollback: the manifest says 1.3.0 but serves the validly signed 1.1.0 installer.
        assert_eq!(
            check_signed_binding(&signed_for("1.1.0"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // The same trick with the installer of the running version.
        assert_eq!(
            check_signed_binding(&signed_for("1.2.0"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // A manifest that honestly names an old installer is refused as well.
        assert_eq!(
            check_signed_binding(&signed_for("1.1.0"), "1.1.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // A newer file under a different announced number.
        assert_eq!(
            check_signed_binding(&signed_for("1.4.0"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // The version field and the file name must agree with each other too.
        assert_eq!(
            check_signed_binding(&s("file:Nexum_1.1.0_x64-setup.exe\tversion:1.3.0"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        assert_eq!(
            check_signed_binding(&s("file:Nexum_1.3.0_x64-setup.exe\tversion:1.1.0"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // An unreadable version field.
        assert_eq!(
            check_signed_binding(&s("file:Nexum_1.3.0_x64-setup.exe\tversion:newest"), "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
        // A signature that names no version, or no Nexum installer, was not made for an
        // update: never accepted (it used to be let through with a log line).
        for unbound in [
            "file:Nexum_1.3.0_x64-setup.exe",
            "version:1.3.0",
            "file:payload\tversion:1.3.0",
            "file:Nexum_1.3.0_x64-portable.zip\tversion:1.3.0",
            "file:Nexum_1.3.0_x64-setup-UNSIGNED-PREVIEW.exe\tversion:1.3.0",
            "file:payload",
            "",
        ] {
            assert_eq!(
                check_signed_binding(&s(unbound), "1.3.0", &cur),
                Err(ErrorCode::BadSignature),
                "{unbound:?}"
            );
        }
        // A signature that cannot be read at all.
        assert_eq!(
            check_signed_binding("%%%", "1.3.0", &cur),
            Err(ErrorCode::BadSignature)
        );

        // The attack the strict reader exists for: a genuine signature of the OLD installer
        // whose unsigned first line was rewritten to claim the new version. The signed line
        // still says 1.1.0, and that is the one that counts.
        let genuine_old = "timestamp:1795800000\tfile:Nexum_1.1.0_x64-setup.exe\tversion:1.1.0";
        let forged = b64(&format!(
            "trusted comment: timestamp:1\tfile:Nexum_1.3.0_x64-setup.exe\tversion:1.3.0\nRUTdummy\ntrusted comment: {genuine_old}\nGLOBALdummy\n"
        ));
        assert_eq!(
            check_signed_binding(&forged, "1.3.0", &cur),
            Err(ErrorCode::NotNewer)
        );
    }

    #[test]
    fn release_notes_are_plain_text() {
        assert_eq!(clean_notes(None), None);
        assert_eq!(clean_notes(Some("")), None);
        assert_eq!(clean_notes(Some(" \r\n\t ")), None);
        assert_eq!(
            clean_notes(Some("Line one\r\nLine two\rLine three\n")).as_deref(),
            Some("Line one\nLine two\nLine three")
        );
        // Control characters and bidirectional overrides are removed; tabs become spaces.
        assert_eq!(
            clean_notes(Some("a\u{0}b\u{1B}[31mc\u{7}\u{202E}d\te")).as_deref(),
            Some("ab[31mcd e")
        );
        // Cut at 4000 characters (not bytes) plus an ellipsis.
        let long = "é".repeat(NOTES_MAX_CHARS + 50);
        let cut = clean_notes(Some(&long)).unwrap();
        assert_eq!(cut.chars().count(), NOTES_MAX_CHARS + 1);
        assert!(cut.ends_with('…'));
        let exact = "x".repeat(NOTES_MAX_CHARS);
        assert_eq!(clean_notes(Some(&exact)).as_deref(), Some(exact.as_str()));
    }

    #[test]
    fn published_date_is_rfc3339_utc() {
        assert_eq!(rfc3339_utc(0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(rfc3339_utc(1_795_809_600).as_deref(), Some("2026-11-27T20:00:00Z"));
        assert_eq!(rfc3339_utc(i64::MAX), None);
    }

    #[test]
    fn error_codes_and_texts_match_the_contract() {
        let all = [
            (ErrorCode::Offline, "offline", "Could not reach GitHub. Check your internet connection and try again."),
            (ErrorCode::NotPublished, "notPublished", "No update information has been published for this version line yet."),
            (ErrorCode::BadManifest, "badManifest", "The update information from GitHub could not be read."),
            (ErrorCode::NotNewer, "notNewer", "The version on offer is not newer than this one, so nothing was installed."),
            (ErrorCode::BadSignature, "badSignature", "The download did not pass Nexum's signature check, so it was not installed."),
            (ErrorCode::Blocked, "blocked", "Windows security blocked the installer. Nothing was changed."),
            (ErrorCode::Write, "write", "The update could not be saved in Nexum's folder. Nothing was changed."),
            (ErrorCode::Launch, "launch", "The installer could not be started. Nothing was changed."),
            (ErrorCode::Busy, "busy", "An update is already in progress."),
            (ErrorCode::Unknown, "unknown", "The update could not be completed. Nothing was changed."),
        ];
        for (code, id, text) in all {
            assert_eq!(serde_json::to_value(code).unwrap(), id);
            assert_eq!(code.text(), text);
        }
    }

    #[test]
    fn plugin_errors_map_to_plain_codes() {
        use tauri_plugin_updater::Error as E;
        // Any non-success answer for the manifest (404 before the first release).
        assert_eq!(map_plugin_error(&E::ReleaseNotFound), ErrorCode::NotPublished);
        // Unreadable manifest.
        let json_error = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(map_plugin_error(&E::Serialization(json_error)), ErrorCode::BadManifest);
        assert_eq!(
            map_plugin_error(&E::TargetNotFound("windows-x86_64".into())),
            ErrorCode::BadManifest
        );
        assert_eq!(
            map_plugin_error(&E::TargetsNotFound(vec!["windows-x86_64-nsis".into()])),
            ErrorCode::BadManifest
        );
        // Download answers.
        assert_eq!(
            map_plugin_error(&E::Network("Download request failed with status: 503 Service Unavailable".into())),
            ErrorCode::Offline
        );
        assert_eq!(
            map_plugin_error(&E::Network("Download request failed with status: 404 Not Found".into())),
            ErrorCode::BadManifest
        );
        // Signature problems.
        assert_eq!(map_plugin_error(&E::MissingSignedVersion), ErrorCode::BadSignature);
        assert_eq!(
            map_plugin_error(&E::SignatureUtf8("x".into())),
            ErrorCode::BadSignature
        );
        assert_eq!(
            map_plugin_error(&E::SignedVersionMismatch {
                signed: "1.1.0".into(),
                announced: "1.3.0".into()
            }),
            ErrorCode::NotNewer
        );
        // Everything else.
        assert_eq!(map_plugin_error(&E::EmptyEndpoints), ErrorCode::Unknown);
        assert_eq!(map_plugin_error(&E::UnsupportedArch), ErrorCode::Unknown);
    }

    #[test]
    fn launch_errors() {
        for code in [4551, 1260, 225, 226] {
            assert_eq!(launch_error_code(Some(code)), ErrorCode::Blocked);
        }
        assert_eq!(launch_error_code(Some(2)), ErrorCode::Launch);
        assert_eq!(launch_error_code(Some(5)), ErrorCode::Launch);
        assert_eq!(launch_error_code(Some(740)), ErrorCode::Launch);
        assert_eq!(launch_error_code(None), ErrorCode::Launch);
        assert_eq!(INSTALLER_ARGS, ["/P", "/R", "/UPDATE"]);
        // The installer is started in a folder only administrators can write to.
        let start_dir = crate::util::windows_dir().join("System32");
        assert!(start_dir.is_absolute() && start_dir.is_dir(), "{}", start_dir.display());
    }

    #[test]
    fn progress_and_size_limit() {
        assert_eq!(progress_pct(0, None), None);
        assert_eq!(progress_pct(10, Some(0)), None);
        assert_eq!(progress_pct(0, Some(200)), Some(0));
        assert_eq!(progress_pct(50, Some(200)), Some(25));
        assert_eq!(progress_pct(199, Some(200)), Some(99));
        assert_eq!(progress_pct(200, Some(200)), Some(100));
        assert_eq!(progress_pct(500, Some(200)), Some(100), "never above 100");
        assert_eq!(progress_pct(u64::MAX, Some(u64::MAX)), Some(100));

        assert!(!download_too_big(0, None));
        assert!(!download_too_big(MAX_DOWNLOAD_BYTES, Some(MAX_DOWNLOAD_BYTES)));
        assert!(download_too_big(MAX_DOWNLOAD_BYTES + 1, None));
        assert!(download_too_big(1, Some(MAX_DOWNLOAD_BYTES + 1)));
    }

    #[test]
    fn read_back_comparison() {
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        assert!(reader_matches(&mut std::io::Cursor::new(data.clone()), &data).unwrap());
        // One byte changed, at the start, in the middle and at the very end.
        for at in [0usize, 100_000, data.len() - 1] {
            let mut other = data.clone();
            other[at] ^= 0x01;
            assert!(!reader_matches(&mut std::io::Cursor::new(other), &data).unwrap(), "{at}");
        }
        // Shorter or longer than what was verified.
        assert!(!reader_matches(&mut std::io::Cursor::new(data[..data.len() - 1].to_vec()), &data).unwrap());
        let mut longer = data.clone();
        longer.push(0);
        assert!(!reader_matches(&mut std::io::Cursor::new(longer), &data).unwrap());
        assert!(reader_matches(&mut std::io::Cursor::new(Vec::<u8>::new()), &[]).unwrap());
        assert!(!reader_matches(&mut std::io::Cursor::new(vec![1u8]), &[]).unwrap());
    }

    #[test]
    fn staged_file_names_are_plain() {
        assert_eq!(staged_stem("1.3.0"), "Nexum-update-1.3.0");
        assert_eq!(staged_stem("1.3.0-preview.2+7"), "Nexum-update-1.3.0-preview.2+7");
        assert_eq!(staged_stem(r"..\..\evil:x"), "Nexum-update-.._.._evil_x");
        assert!(staged_stem(&"9".repeat(500)).len() < 100);
    }

    #[test]
    fn staging_writes_pins_and_verifies() {
        let base = std::env::temp_dir().join(format!(
            "nexum-test-updater-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let bytes: Vec<u8> = (0..70_000u32).map(|i| (i % 253) as u8).collect();

        // The staging folder is made for administrators only, which needs an elevated run
        // (CI has one; the app always runs elevated). Without it there is nothing to test.
        match PinnedDir::create_admin_only(&base, "probe") {
            Ok(probe) => {
                drop(probe);
                std::fs::remove_dir(base.join("probe")).unwrap();
            }
            Err(e) if crate::safe_fs::tests::skip_without_elevation(&e) => {
                let _ = std::fs::remove_dir_all(&base);
                return;
            }
            Err(e) => panic!("could not make an admin-only folder: {e}"),
        }

        // What an earlier attempt left behind, or what somebody planted: an ordinary folder
        // with an ordinary access list. It is never reused.
        std::fs::create_dir_all(base.join(STAGING_DIR)).unwrap();
        std::fs::write(base.join(STAGING_DIR).join("old-leftover.bin"), b"old").unwrap();
        let before = crate::safe_fs::security_sddl(&base.join(STAGING_DIR)).unwrap();
        assert!(!crate::safe_fs::sddl_admin_only(&before), "{before}");

        let staged = match stage(&base, "1.3.0", &bytes) {
            Ok(s) => s,
            Err(code) => panic!("staging failed: {code:?}"),
        };
        assert_eq!(staged.path, base.join(STAGING_DIR).join("Nexum-update-1.3.0.exe"));
        assert!(!base.join(STAGING_DIR).join("old-leftover.bin").exists());
        assert_eq!(std::fs::read(&staged.path).unwrap(), bytes);
        // Folder and file: owner Administrators, SYSTEM and Administrators only, nothing
        // inherited from the folder Nexum is installed in.
        for path in [base.join(STAGING_DIR), staged.path.clone()] {
            let sddl = crate::safe_fs::security_sddl(&path).unwrap();
            assert!(crate::safe_fs::sddl_admin_only(&sddl), "{}: {sddl}", path.display());
        }
        // While it is held nobody can change, delete or replace it, or move its folder.
        assert!(std::fs::write(&staged.path, b"swapped").is_err());
        assert!(std::fs::remove_file(&staged.path).is_err());
        assert!(std::fs::rename(&staged.path, base.join("moved.exe")).is_err());
        assert!(std::fs::rename(base.join(STAGING_DIR), base.join("moved")).is_err());
        assert_eq!(std::fs::read(&staged.path).unwrap(), bytes);

        // The failed-launch path: release, delete, remove the folder.
        let Staged { pinned, held, path } = staged;
        drop(held);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(pinned.remove_entries().unwrap(), 0);
        drop(pinned);
        std::fs::remove_dir(base.join(STAGING_DIR)).unwrap();

        // A staging folder that cannot be emptied is refused: nothing is written into it.
        std::fs::create_dir_all(base.join(STAGING_DIR).join("sub")).unwrap();
        std::fs::write(base.join(STAGING_DIR).join("sub").join("x"), b"x").unwrap();
        assert!(matches!(stage(&base, "1.3.0", &bytes), Err(ErrorCode::Write)));
        assert!(!base.join(STAGING_DIR).join("Nexum-update-1.3.0.exe").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn update_state_wire_shape() {
        let mut s = UpdateState {
            current_version: "1.2.0".into(),
            build_channel: Some(Channel::Preview),
            channel: Some(Channel::Preview),
            ..UpdateState::default()
        };
        let j = serde_json::to_value(&s).unwrap();
        let keys: Vec<&str> = j.as_object().unwrap().keys().map(String::as_str).collect();
        let mut expected = vec![
            "state", "currentVersion", "latestVersion", "notes", "publishedAt", "progress",
            "downloadedBytes", "totalBytes", "error", "errorCode", "channel", "buildChannel",
            "lastCheckTs",
        ];
        let mut got = keys.clone();
        got.sort_unstable();
        expected.sort_unstable();
        assert_eq!(got, expected);
        assert_eq!(j["state"], "idle");
        assert_eq!(j["buildChannel"], "preview");
        assert!(j["latestVersion"].is_null() && j["error"].is_null() && j["progress"].is_null());

        for (status, name) in [
            (Status::Idle, "idle"),
            (Status::Checking, "checking"),
            (Status::Available, "available"),
            (Status::Downloading, "downloading"),
            (Status::Ready, "ready"),
            (Status::Installing, "installing"),
            (Status::Error, "error"),
            (Status::Disabled, "disabled"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), name);
        }

        s.progress = Some(40);
        s.downloaded_bytes = Some(4);
        s.total_bytes = Some(10);
        s.set_error(ErrorCode::Offline);
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["state"], "error");
        assert_eq!(j["errorCode"], "offline");
        assert_eq!(j["error"], ErrorCode::Offline.text());
        assert!(j["progress"].is_null() && j["downloadedBytes"].is_null());
    }

    #[test]
    fn only_this_repository_is_named() {
        // CONTRACT §2.15.1 rule 1: no other host appears in the updater.
        let source = include_str!("updater.rs");
        let marker = ["https", "://"].concat();
        for (i, _) in source.match_indices(marker.as_str()) {
            let rest = &source[i..];
            let end = rest
                .find(|c: char| c == '"' || c.is_whitespace() || c == ')')
                .unwrap_or(rest.len());
            let url = &rest[..end];
            assert!(
                url.starts_with("https://github.com/captainRapipo/nexum/")
                    || url == "https://github.com/"
                    || url.starts_with("https://example.com/")
                    || url.starts_with("https://github.com/someone-else/")
                    || url.starts_with("https://github.com/captainRapipo/nexum-fork/")
                    || url.starts_with("https://github.com.evil.example/")
                    || url.starts_with("https://github.com@evil.example/")
                    || url.starts_with("https://objects.githubusercontent.com/"),
                "unexpected address in updater.rs: {url}"
            );
        }
    }
}
