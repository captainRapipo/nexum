// One function per domain produces label AND tone together (ROADMAP §6.1, CONTRACT §4.5 lib/status.ts),
// plus the frontend health derivation (MF-6, CONTRACT §5). [CHANGED 1.1] Drive, temperature and
// free-space conditions are evaluated by Rust (alerts.rs) and arrive as a HealthAlertsSnapshot; this
// file keeps only the frontend-owned rules (fan fail-safe, agent offline, fan override, limited mode,
// drive health unknown) and merges the two (CONTRACT §5.0).

import { AlertTriangle, CheckCircle2, Lock, OctagonAlert, type LucideIcon } from "lucide-react";
import {
  DEFAULT_ALERT_SETTINGS,
  HEALTH_THRESHOLDS as T,
  type AgentStatus,
  type DiskTelemetry,
  type DriveHealth,
  type FanFailsafeState,
  type FeatureNeed,
  type HealthAction,
  type HealthAlertsSnapshot,
  type HealthCondition,
  type HealthSeverity,
  type HealthSource,
  type PhysicalDisk,
  type Settings,
  type SystemHealth,
  type SystemHealthLevel,
  type TelemetryPacket,
  type UnavailableReason,
  type Volume,
} from "../types";
import type { StatusTone } from "../components/ui/tones";
import { api, PAWNIO_URL } from "./api";
import { alertToCondition } from "./alerts";
import { driveDisplayName, joinDisks } from "./disks";
import { requestNavigate } from "./nav";
import { fmtCount } from "./format";

/* ------------------------------------------------------------------ */
/* Per-domain label + tone                                             */
/* ------------------------------------------------------------------ */

export interface DriveHealthView {
  tone: StatusTone;
  label: string;
  icon: LucideIcon;
}

export function driveHealthView(h: DriveHealth | null | undefined): DriveHealthView {
  const label = h?.label || "Health unknown";
  switch (h?.state) {
    case "good":
      return { tone: "ok", label, icon: CheckCircle2 };
    case "attention":
      return { tone: "warn", label, icon: AlertTriangle };
    case "replace":
    case "failing":
      return { tone: "crit", label, icon: OctagonAlert };
    default:
      return { tone: "unknown", label, icon: Lock };
  }
}

/** Threshold tone for a reading; null → unknown. */
export function sensorState(value: number | null | undefined, warnAt: number, critAt: number): StatusTone {
  if (value == null || !Number.isFinite(value)) return "unknown";
  if (value >= critAt) return "crit";
  if (value >= warnAt) return "warn";
  return "ok";
}

export function alertState(sev: HealthSeverity): StatusTone {
  return sev === "crit" ? "crit" : sev === "warn" ? "warn" : "info";
}

/** Pill tone for an overall health level (CONTRACT §5.3). [CHANGED 1.1] "checking" → unknown. */
export function healthLevelTone(level: SystemHealthLevel): StatusTone {
  switch (level) {
    case "critical":
      return "crit";
    case "attention":
      return "warn";
    case "partial":
    case "checking":
      return "unknown";
    case "optimal":
    default:
      return "ok";
  }
}

/** Why a value is null, for <Unavailable reason=…/> (CONTRACT §4.5). */
export function resolveUnavailable(agent: AgentStatus | null | undefined, need: FeatureNeed): UnavailableReason {
  if (!agent || !agent.running) return "agentOffline";
  if (need === "none") return "unsupported";
  const reasons = agent.limitedReasons ?? [];
  if (reasons.includes("notElevated")) return "notElevated";
  if (need === "pawnio" && reasons.includes("pawnIoMissing")) return "pawnIoMissing";
  if (need === "pawnio" && reasons.includes("pawnIoOutdated")) return "pawnIoOutdated";
  return "unsupported";
}

/** What each value needs to be readable. */
export const FEATURE_NEEDS = {
  cpuTemp: "pawnio",
  cpuPower: "pawnio",
  cpuClock: "pawnio",
  cpuVoltage: "pawnio",
  motherboardSensors: "pawnio",
  fanRpm: "pawnio",
  fanControl: "pawnio",
  spd: "pawnio",
  driveSmart: "admin",
  driveTemp: "admin",
  adminCleanup: "admin",
  gpuSensors: "none",
  cpuLoad: "none",
  ram: "none",
  network: "none",
} as const satisfies Record<string, FeatureNeed>;

export type FeatureKey = keyof typeof FEATURE_NEEDS;

/* ------------------------------------------------------------------ */
/* Free-space thresholds (CONTRACT §5.0) [NEW 1.1]                     */
/* ------------------------------------------------------------------ */

/**
 * Low-space colours for StorageGauge / VolumeList, from the same setting Rust's `space` rule uses:
 * warn below `freeSpacePct`, critical below `max(1, floor(freeSpacePct / 2))`.
 */
export function spaceThresholds(s: Pick<Settings, "alerts"> | null | undefined): { warnPct: number; critPct: number } {
  const raw = s?.alerts?.freeSpacePct;
  const warnPct =
    typeof raw === "number" && Number.isFinite(raw) ? Math.round(Math.min(50, Math.max(1, raw))) : DEFAULT_ALERT_SETTINGS.freeSpacePct;
  return { warnPct, critPct: Math.max(1, Math.floor(warnPct / 2)) };
}

/* ------------------------------------------------------------------ */
/* deriveHealth (CONTRACT §5)                                          */
/* ------------------------------------------------------------------ */

export interface DeriveHealthInput {
  agent: AgentStatus | null;
  latest: TelemetryPacket | null;
  /** Kept for API stability; the frontend rules no longer need history (rules 5–8 moved to Rust). */
  history: readonly TelemetryPacket[];
  volumes: readonly Volume[];
  physical: readonly PhysicalDisk[];
  failsafe: FanFailsafeState;
  pollIntervalMs: number;
  now: number;
  /** [NEW 1.1] Rust alert engine snapshot (drive, cpu-temp, gpu-temp, gpu-mem-temp, drive-temp, space). */
  alerts: HealthAlertsSnapshot;
}

/** Frontend-owned rule texts (shown on the pill hover and in the empty Health alerts card). */
export const HEALTH_RULES = {
  failsafe: "Critical while Nexum's fan control was interrupted and fans may not be under BIOS control",
  offline: "Attention when the hardware agent sends no data for 5 seconds (or 3 poll intervals)",
  fanOverride: "Attention while fans are held at 100% because the CPU or GPU reached its limit or a temperature sensor stopped reporting",
  limited: "Partial sensors while Nexum runs without administrator rights or without the PawnIO driver",
  driveUnknown: "Partial sensors while a drive does not report wear data",
} as const;

/** Frontend rule texts in rule order (1, 2, 3, 9, 10). Rust's seven texts follow them (alerts.rules). */
export const HEALTH_RULE_LIST: readonly string[] = [
  HEALTH_RULES.failsafe,
  HEALTH_RULES.offline,
  HEALTH_RULES.fanOverride,
  HEALTH_RULES.limited,
  HEALTH_RULES.driveUnknown,
];

const DRIVE_ADVICE: Record<string, string> = {
  Worn: "Copy important files and plan a replacement.",
  "Replace soon": "Copy important files and plan a replacement.",
  Failing: "Back up important files now and replace this drive.",
  "Check sectors": "Back up important files and run the drive maker's diagnostic.",
  Overheating: "Improve airflow around the drive.",
  "Windows warning": "Back up important files and check the drive in Windows Settings › Storage.",
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * `<life>% life left (<percentageUsed>% of rated endurance used, <h> h). <advice>` (CONTRACT §5.2).
 * Rust produces the alert detail now; kept for the mock and for views that describe a drive.
 */
export function driveDetailSentence(t: DiskTelemetry): string {
  const head = isNum(t.healthPct) ? `${Math.round(t.healthPct)}% life left` : "";
  const paren: string[] = [];
  if (isNum(t.percentageUsed)) paren.push(`${Math.round(t.percentageUsed)}% of rated endurance used`);
  if (isNum(t.powerOnHours)) paren.push(`${fmtCount(t.powerOnHours)} h`);
  let first = "";
  if (head && paren.length) first = `${head} (${paren.join(", ")}). `;
  else if (head) first = `${head}. `;
  else if (paren.length) {
    const p = paren.join(", ");
    first = `${p.charAt(0).toUpperCase()}${p.slice(1)}. `;
  }
  const advice = DRIVE_ADVICE[t.health?.label ?? ""] ?? "";
  return `${first}${advice}`.trim();
}

interface Draft extends HealthCondition {
  /** v1.0 rule number (CONTRACT §5.0); gpu-mem-temp sorts right after gpu-temp. */
  order: number;
}

const SEV_RANK: Record<HealthSeverity, number> = { crit: 0, warn: 1, info: 2 };

/** v1.0 rule number of a Rust alert id (display order within a severity). */
function rustRuleOrder(id: string): number {
  if (id.startsWith("drive-temp:")) return 7;
  if (id.startsWith("drive:")) return 4;
  if (id === "cpu-temp") return 5;
  if (id.startsWith("gpu-mem-temp:")) return 6.5;
  if (id.startsWith("gpu-temp:")) return 6;
  if (id.startsWith("space:")) return 8;
  return 8.5;
}

function cond(
  order: number,
  c: Omit<HealthCondition, "dismissKey"> & { stateKey: string },
): Draft {
  const { stateKey, ...rest } = c;
  return { ...rest, dismissKey: `${c.id}:${stateKey}`, order };
}

const viewNav = (label: string, view: "cooling" | "sensors" | "storage", focus?: string): HealthAction => ({
  label,
  nav: focus ? { view, focus } : { view },
});

export function deriveHealth(input: DeriveHealthInput): SystemHealth {
  const { agent, latest, physical, failsafe, pollIntervalMs, now, alerts } = input;
  const staleMs = Math.max(T.staleMinMs, 3 * (pollIntervalMs > 0 ? pollIntervalMs : 1000));
  // Freshness uses the newest of the status timestamp and the last packet seen by the UI
  // (agent-status is not re-emitted for every packet).
  const lastTs = Math.max(agent?.lastPacketTs ?? 0, latest?.ts ?? 0);
  const offline = !agent || !agent.running || latest == null || now - lastTs > staleMs;

  const out: Draft[] = [];
  const tele: DiskTelemetry[] = latest?.disks ?? [];
  const joined = joinDisks(physical, tele);

  // 1. Fan fail-safe
  if (failsafe?.active) {
    const sev: HealthSeverity = failsafe.kind === "previousBoot" ? "warn" : "crit";
    out.push(
      cond(1, {
        id: "fan-failsafe",
        severity: sev,
        source: "fan",
        group: "fan-failsafe",
        short: "Fan fail-safe",
        title: "Fan control interrupted",
        detail: failsafe.message,
        rule: HEALTH_RULES.failsafe,
        action: null,
        stateKey: failsafe.kind ?? sev,
      }),
    );
  }

  // 2. Agent offline
  if (offline) {
    out.push(
      cond(2, {
        id: "agent-offline",
        severity: "warn",
        source: "agent",
        group: "agent-offline",
        short: "Agent offline",
        title: "Hardware agent offline",
        detail: "Sensor values are not updating. Use Restart agent in Settings.",
        rule: HEALTH_RULES.offline,
        action: null,
        stateKey: "warn",
      }),
    );
  }

  // 3. Fan override
  const fs = latest?.fanSafety;
  if (!offline && fs?.overrideActive && !fs.failsafe) {
    const detail =
      fs.reason === "gpuTemp"
        ? "GPU temperature limit reached."
        : fs.reason === "sensorMissing"
          ? "A temperature sensor stopped reporting."
          : `CPU reached ${fs.triggerC ?? 85} °C.`;
    out.push(
      cond(3, {
        id: "fan-override",
        severity: "warn",
        source: "fan",
        group: "fan-override",
        short: "Fans at 100%",
        title: "Fans held at 100%",
        detail,
        rule: HEALTH_RULES.fanOverride,
        action: viewNav("View cooling", "cooling"),
        stateKey: fs.reason ?? "warn",
      }),
    );
  }

  // 4–8. Rust-evaluated alerts (CONTRACT §5.0). While offline only `space:*` stays (Rust clears the
  // rest too; this covers the gap before its snapshot arrives).
  for (const a of alerts?.alerts ?? []) {
    if (offline && a.source !== "space") continue;
    out.push({ ...alertToCondition(a), order: rustRuleOrder(a.id) });
  }

  // 9. Limited mode. ROADMAP MF-6: Optimal needs an *elevated* agent, so a non-elevated agent counts as
  // limited even if a core that predates protocol 2 sent no limitedReasons.
  const reasons = agent?.limitedReasons ?? [];
  if (!offline && agent && (reasons.length > 0 || !agent.isAdmin)) {
    const notElevated = reasons.includes("notElevated") || !agent.isAdmin;
    const missing = agent.missingFeatures ?? [];
    out.push(
      cond(9, {
        id: "limited-mode",
        severity: "info",
        source: "agent",
        group: "limited-mode",
        short: "Partial sensors",
        title: "Partial sensors",
        detail: missing.length > 0 ? `Unavailable: ${missing.join(", ")}.` : "Some sensors are unavailable.",
        rule: HEALTH_RULES.limited,
        action: notElevated
          ? { label: "Restart as administrator", command: "restartAsAdmin" }
          : { label: "Get PawnIO", command: "getPawnIo" },
        stateKey: (reasons.length > 0 ? reasons : ["notElevated"]).join("+"),
      }),
    );
  }

  // 10. Drive health unknown
  if (!offline) {
    for (const j of joined) {
      const t = j.tele;
      if (t && t.health?.state !== "unknown") continue;
      const label = t?.health?.label || "Health unknown — no S.M.A.R.T. data";
      const reason = t?.health?.reason || "The drive or its USB bridge does not report S.M.A.R.T. data";
      const key = t ? t.id : j.disk.deviceId;
      out.push(
        cond(10, {
          id: `drive-unknown:${key}`,
          severity: "info",
          source: "drive",
          group: "drive-unknown",
          short: "Drive health unknown",
          title: `${driveDisplayName(j.disk, t)} — ${label}`,
          detail: reason,
          rule: HEALTH_RULES.driveUnknown,
          action: null,
          stateKey: "info",
        }),
      );
    }
    // Telemetry disks with unknown health that no PhysicalDisk joined to.
    for (const t of tele) {
      if (t.health?.state !== "unknown" || joined.some((j) => j.tele?.id === t.id)) continue;
      out.push(
        cond(10, {
          id: `drive-unknown:${t.id}`,
          severity: "info",
          source: "drive",
          group: "drive-unknown",
          short: "Drive health unknown",
          title: `${t.name} — ${t.health.label}`,
          detail: t.health.reason,
          rule: HEALTH_RULES.driveUnknown,
          action: null,
          stateKey: "info",
        }),
      );
    }
  }

  // Sort: severity, then v1.0 rule number, then insertion order (= the order Rust sent).
  const conditions = out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => SEV_RANK[a.c.severity] - SEV_RANK[b.c.severity] || a.c.order - b.c.order || a.i - b.i)
    .map(({ c }) => {
      const { order: _order, ...rest } = c;
      return rest as HealthCondition;
    });

  const rules = [...HEALTH_RULE_LIST, ...(alerts?.rules ?? [])];

  // Checking (CONTRACT §5.0): never "Optimal" before Rust has evaluated once.
  if (conditions.length === 0 && !offline && !alerts?.ready) {
    return { level: "checking", label: "Checking", summary: null, conditions, rules };
  }

  const level: SystemHealthLevel = conditions.some((c) => c.severity === "crit")
    ? "critical"
    : conditions.some((c) => c.severity === "warn")
      ? "attention"
      : conditions.length > 0
        ? "partial"
        : "optimal";
  const label =
    level === "critical" ? "Critical" : level === "attention" ? "Attention" : level === "partial" ? "Partial sensors" : "Optimal";

  return { level, label, summary: summarize(level, label, conditions), conditions, rules };
}

function summarize(level: SystemHealthLevel, label: string, conditions: HealthCondition[]): string | null {
  if (level === "optimal" || level === "checking" || conditions.length === 0) return null;
  const topSev = conditions[0].severity;
  const top = conditions.filter((c) => c.severity === topSev);
  const groups = new Map<string, HealthCondition[]>();
  for (const c of top) {
    const g = groups.get(c.group);
    if (g) g.push(c);
    else groups.set(c.group, [c]);
  }
  let text: string;
  if (groups.size === 1) {
    const [members] = [...groups.values()];
    const short = members[0].short;
    text = members.length > 1 && short.startsWith("1 drive") ? short.replace(/^1 drive/, `${members.length} drives`) : short;
  } else {
    text = `${top.length} alerts`;
  }
  // "Partial sensors · Partial sensors" carries no information.
  return text === label ? null : text;
}

/** Pill text: `Attention · 1 drive worn`. */
export function healthPillText(h: SystemHealth): string {
  return h.summary ? `${h.label} · ${h.summary}` : h.label;
}

/** Hover text: active condition titles, then the rules. */
export function healthPillTitle(h: SystemHealth): string {
  const active = h.conditions.map((c) => `• ${c.title}`);
  const rules = h.rules.map((r) => `– ${r}`);
  return [...(active.length ? ["Active:", ...active, ""] : ["No active alerts.", ""]), "Rules:", ...rules].join("\n");
}

export type { HealthSource };

/* ------------------------------------------------------------------ */
/* Running a condition's action (CONTRACT §5.3)                        */
/* ------------------------------------------------------------------ */

/**
 * `{label, nav}` → requestNavigate(nav); `restartAsAdmin` → api.restartAsAdmin();
 * `getPawnIo` → api.openExternal("https://pawnio.eu/"). Rejects with the backend error.
 */
export async function runHealthAction(action: HealthAction | null | undefined): Promise<void> {
  if (!action) return;
  if ("nav" in action) {
    requestNavigate(action.nav);
    return;
  }
  if (action.command === "restartAsAdmin") await api.restartAsAdmin();
  else if (action.command === "getPawnIo") await api.openExternal(PAWNIO_URL);
}
