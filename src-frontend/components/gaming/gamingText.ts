// Gaming view copy and small pure helpers (CONTRACT §1.6, §2.13, §4.8, §4.10.1).
// Copy rules: never "boost", "game mode", "game booster" or "FPS boost"; never claim
// "safe with anti-cheat" — say what capture does (ETW, no injection) and that the
// anti-cheat matrix is untested until the README says otherwise.

import { FPS_EXCLUDES_MAX, type FrameSession, type FrameSessionCode, type FrameStats } from "../../types";
import {
  EXCLUDE_NAME_HINT,
  P01_NEEDS_FRAMES,
  P1_NEEDS_FRAMES,
  PERCENTILE_LOW_DEFINITION,
  isFixedExclude,
  isValidExcludeName,
} from "../../lib/frames";

// Shared contract strings live in lib/frames (C); re-exported here for the gaming components.
export { BOUND_BY_RULE, HAGS_NOTE, targetReasonText } from "../../lib/frames";
export const LOWS_TOOLTIP = PERCENTILE_LOW_DEFINITION;
export const NEEDS_100 = P1_NEEDS_FRAMES;
export const NEEDS_1000 = P01_NEEDS_FRAMES;
export const EXCLUDE_INVALID = EXCLUDE_NAME_HINT;

/* ------------------------------------------------------------------ */
/* Exact contract strings (§4.10.1, §1.6.5)                             */
/* ------------------------------------------------------------------ */

export const OPT_IN_TITLE = "Frame capture is off";
export const OPT_IN_BODY =
  "Nexum can measure frame rate and frame times with Intel PresentMon, which reads Windows performance events (ETW). Nothing is injected into games and no game files or processes are touched.";
export const OPT_IN_JAVELIN =
  "Start Nexum before launching games that use EA Javelin anti-cheat: frame capture must already be running when they start.";
export const OPT_IN_BUTTON = "Turn on frame capture";

export const NO_TARGET_TEXT = "No game detected. Start a game, or pick an app below.";

export const HERO_LABEL = "Rendered FPS (game)";
export const HERO_TOOLTIP =
  "Frames the game rendered. Frames added by AMD driver frame generation (AFMF) may not be counted.";

export const NEEDS_2 = "Needs at least 2 frames in the window.";
export const NO_FRAMES = "No frames in the window.";
export const NO_DISPLAY_DATA = "PresentMon reported no display data for this app.";

export const KNOWN_LIMITS =
  'Known limits: some apps (runtime "Other") report less detail; frames from driver frame generation may not be counted.';

export const ANTI_CHEAT_SUMMARY =
  "Works without touching the game. Some anti-cheat systems are untested; this list is updated when a test is done.";

/**
 * Anti-cheat test matrix placeholder (ROADMAP §4.3). Every row stays "Not tested yet" until the
 * owner runs the on-rig gate and the README lists the result. Names are anti-cheat systems, not games.
 */
export const ANTI_CHEAT_MATRIX: readonly { system: string; status: string }[] = [
  { system: "Easy Anti-Cheat", status: "Not tested yet" },
  { system: "BattlEye", status: "Not tested yet" },
  { system: "Riot Vanguard", status: "Not tested yet" },
  { system: "EA Javelin", status: "Not tested yet" },
  { system: "FACEIT", status: "Not tested yet" },
];

/* ------------------------------------------------------------------ */
/* Session                                                              */
/* ------------------------------------------------------------------ */

/** What the user can do about each error code (shown under `session.message`). */
export const SESSION_ERROR_HINT: Record<FrameSessionCode, string> = {
  notElevated: "Restart Nexum as administrator to capture frames.",
  exeMissing: "Reinstall Nexum to restore the bundled PresentMon file.",
  signatureInvalid:
    "The file on disk is not the Intel-signed PresentMon 2.6.0 that ships with Nexum. Reinstall Nexum to restore it.",
  spawnFailed: "Try again. If it keeps failing, restart the PC and try once more.",
  unsupportedOutput: "This PresentMon build writes a format Nexum cannot read. Reinstall Nexum.",
  exited: "Try again. If it keeps stopping, another frame-capture tool may be using the same Windows event session.",
};

/** One-line hover describing the executable trust check result. */
export function signatureTitle(s: FrameSession | null): string {
  if (!s) return "Signature not checked yet.";
  const sig = s.signature;
  const parts: string[] = [];
  switch (sig.status) {
    case "valid":
      parts.push("Signature valid");
      break;
    case "invalid":
      parts.push("Signature invalid");
      break;
    case "untrusted":
      parts.push("Signed by an unexpected publisher");
      break;
    default:
      parts.push("Signature not checked yet");
  }
  if (sig.signer) parts.push(`signer ${sig.signer}`);
  if (sig.sha256Match === true) parts.push("SHA-256 matches the pinned PresentMon 2.6.0 file");
  if (sig.sha256Match === false) parts.push("SHA-256 does not match the pinned PresentMon 2.6.0 file");
  return `${parts.join(" · ")}. Checked before every start.`;
}

/* ------------------------------------------------------------------ */
/* Excludes (validation identical to Rust §2.13)                         */
/* ------------------------------------------------------------------ */

export type ExcludeCheck = { ok: true; name: string } | { ok: false; error: string };

/** Validate one exclude entry against the current list. */
export function checkExclude(raw: string, current: readonly string[]): ExcludeCheck {
  const name = raw.trim();
  if (!isValidExcludeName(name)) return { ok: false, error: EXCLUDE_NAME_HINT };
  if (isFixedExclude(name)) return { ok: false, error: `Nexum always excludes ${name}.` };
  const lower = name.toLowerCase();
  if (current.some((c) => c.toLowerCase() === lower)) return { ok: false, error: `${name} is already in the list.` };
  if (current.length >= FPS_EXCLUDES_MAX) return { ok: false, error: `You can exclude up to ${FPS_EXCLUDES_MAX} apps.` };
  return { ok: true, name };
}

/* ------------------------------------------------------------------ */
/* Stats helpers                                                        */
/* ------------------------------------------------------------------ */

/** `Last 30 s · 4,212 frames` */
export function windowSummary(stats: FrameStats): string {
  return `Last ${stats.windowSec} s · ${stats.frames.toLocaleString("en-US")} frames`;
}
