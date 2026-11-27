// One function per domain produces label AND tone together (ROADMAP §6.1, CONTRACT §4.5 lib/status.ts),
// plus the frontend health derivation (MF-6, CONTRACT §5). v1.1 moves deriveHealth to Rust.

import { AlertTriangle, CheckCircle2, Lock, OctagonAlert, type LucideIcon } from "lucide-react";
import {
  HEALTH_THRESHOLDS as T,
  type AgentStatus,
  type DiskTelemetry,
  type DriveHealth,
  type FanFailsafeState,
  type FeatureNeed,
  type HealthAction,
  type HealthCondition,
  type HealthSeverity,
  type HealthSource,
  type PhysicalDisk,
  type SystemHealth,
  type SystemHealthLevel,
  type TelemetryPacket,
  type UnavailableReason,
  type Volume,
} from "../types";
import type { StatusTone } from "../components/ui/tones";
import { api, PAWNIO_URL } from "./api";
import { driveDisplayName, joinDisks } from "./disks";
import { requestNavigate } from "./nav";
import { fmtBytes, fmtCount } from "./format";

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

/** Pill tone for an overall health level (CONTRACT §5.3). */
export function healthLevelTone(level: SystemHealthLevel): StatusTone {
  return level === "critical" ? "crit" : level === "attention" ? "warn" : level === "partial" ? "unknown" : "ok";
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
/* deriveHealth (CONTRACT §5)                                          */
/* ------------------------------------------------------------------ */

export interface DeriveHealthInput {
  agent: AgentStatus | null;
  latest: TelemetryPacket | null;
  history: readonly TelemetryPacket[];
  volumes: readonly Volume[];
  physical: readonly PhysicalDisk[];
  failsafe: FanFailsafeState;
  pollIntervalMs: number;
  now: number;
}

/** Rule texts, in evaluation order (shown on the pill hover and in the empty Health alerts card). */
export const HEALTH_RULES = {
  failsafe: "Critical while Nexum's fan control was interrupted and fans may not be under BIOS control",
  offline: "Attention when the hardware agent sends no data for 5 seconds (or 3 poll intervals)",
  fanOverride: "Attention while fans are held at 100% because the CPU or GPU reached its limit or a temperature sensor stopped reporting",
  driveCrit: "Critical when a drive reports a critical warning, spare below threshold, read-only, or ≤ 10% life left",
  driveWarn: "Attention when a drive has ≤ 50% life left, reallocated, pending or uncorrectable sectors, a temperature warning, or a Windows health warning",
  cpuTemp: `Attention when the CPU stays at or above ${T.cpuWarnC} °C for 10 s; critical at ${T.cpuCritC} °C`,
  gpuTemp: `Attention when a GPU hot spot stays at or above ${T.gpuHotspotWarnC} °C (edge ${T.gpuEdgeWarnC} °C) for 10 s; critical at ${T.gpuHotspotCritC} °C (edge ${T.gpuEdgeCritC} °C)`,
  driveTemp: `Attention when a drive stays at or above its warning temperature (${T.driveWarnFallbackC} °C if not reported) for 10 s; critical at its critical temperature (${T.driveCritFallbackC} °C)`,
  space: `Attention when a fixed drive has less than ${T.freeSpaceWarnPct}% free space; critical below ${T.freeSpaceCritPct}%`,
  limited: "Partial sensors while Nexum runs without administrator rights or without the PawnIO driver",
  driveUnknown: "Partial sensors while a drive does not report wear data",
} as const;

export const HEALTH_RULE_LIST: readonly string[] = [
  HEALTH_RULES.failsafe,
  HEALTH_RULES.offline,
  HEALTH_RULES.fanOverride,
  HEALTH_RULES.driveCrit,
  HEALTH_RULES.driveWarn,
  HEALTH_RULES.cpuTemp,
  HEALTH_RULES.gpuTemp,
  HEALTH_RULES.driveTemp,
  HEALTH_RULES.space,
  HEALTH_RULES.limited,
  HEALTH_RULES.driveUnknown,
];

const DRIVE_SHORT: Record<string, string> = {
  Failing: "1 drive failing",
  "Replace soon": "1 drive: replace soon",
  Worn: "1 drive worn",
  "Check sectors": "1 drive: check sectors",
  Overheating: "1 drive overheating",
  "Windows warning": "1 drive: Windows warning",
};

const DRIVE_ADVICE: Record<string, string> = {
  Worn: "Copy important files and plan a replacement.",
  "Replace soon": "Copy important files and plan a replacement.",
  Failing: "Back up important files now and replace this drive.",
  "Check sectors": "Back up important files and run the drive maker's diagnostic.",
  Overheating: "Improve airflow around the drive.",
  "Windows warning": "Back up important files and check the drive in Windows Settings › Storage.",
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (v: number) => Math.round(v);

/** `<life>% life left (<percentageUsed>% of rated endurance used, <h> h). <advice>` (CONTRACT §5.2). */
export function driveDetailSentence(t: DiskTelemetry): string {
  const head = isNum(t.healthPct) ? `${round(t.healthPct)}% life left` : "";
  const paren: string[] = [];
  if (isNum(t.percentageUsed)) paren.push(`${round(t.percentageUsed)}% of rated endurance used`);
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

/**
 * Sustained rule: samples with ts ≥ now − 10 s number ≥ 3, all non-null, and their minimum ≥ threshold.
 * Returns that minimum (or null when not sustained).
 */
function sustainedMin(samples: ReadonlyArray<number | null>, threshold: number): number | null {
  if (samples.length < T.sustainMinSamples) return null;
  let min = Infinity;
  for (const v of samples) {
    if (!isNum(v)) return null;
    if (v < min) min = v;
  }
  return min >= threshold ? min : null;
}

function windowPackets(history: readonly TelemetryPacket[], now: number): TelemetryPacket[] {
  const from = now - T.sustainWindowMs;
  return history.filter((p) => p.ts >= from);
}

interface Draft extends HealthCondition {
  order: number;
}

const SEV_RANK: Record<HealthSeverity, number> = { crit: 0, warn: 1, info: 2 };

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
  const { agent, latest, history, volumes, physical, failsafe, pollIntervalMs, now } = input;
  const staleMs = Math.max(T.staleMinMs, 3 * (pollIntervalMs > 0 ? pollIntervalMs : 1000));
  // Freshness uses the newest of the status timestamp and the last packet seen by the UI
  // (agent-status is not re-emitted for every packet).
  const lastTs = Math.max(agent?.lastPacketTs ?? 0, latest?.ts ?? 0);
  const offline = !agent || !agent.running || latest == null || now - lastTs > staleMs;

  const out: Draft[] = [];
  const tele: DiskTelemetry[] = latest?.disks ?? [];
  const joined = joinDisks(physical, tele);
  const nameOf = (t: DiskTelemetry) => driveDisplayName(joined.find((j) => j.tele?.id === t.id)?.disk ?? null, t);
  const win = windowPackets(history, now);

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

  // 4. Drive health
  if (!offline) {
    for (const t of tele) {
      const st = t.health?.state;
      if (st !== "failing" && st !== "replace" && st !== "attention") continue;
      const crit = st === "failing" || st === "replace";
      const label = t.health.label;
      out.push(
        cond(4, {
          id: `drive:${t.id}`,
          severity: crit ? "crit" : "warn",
          source: "drive",
          group: `drive:${label}`,
          short: DRIVE_SHORT[label] ?? `1 drive: ${label.toLowerCase()}`,
          title: `${nameOf(t)} — ${label}`,
          detail: driveDetailSentence(t),
          rule: crit ? HEALTH_RULES.driveCrit : HEALTH_RULES.driveWarn,
          action: viewNav("View drive", "storage", t.id),
          stateKey: st,
        }),
      );
    }
  }

  // 5. CPU temperature (sustained)
  {
    const samples = win.map((p) => p.cpu?.packageTempC ?? null);
    const crit = sustainedMin(samples, T.cpuCritC);
    const warn = crit == null ? sustainedMin(samples, T.cpuWarnC) : null;
    if (crit != null || warn != null) {
      const threshold = crit != null ? T.cpuCritC : T.cpuWarnC;
      const cur = latest?.cpu?.packageTempC ?? crit ?? warn ?? threshold;
      out.push(
        cond(5, {
          id: "cpu-temp",
          severity: crit != null ? "crit" : "warn",
          source: "cpu",
          group: "cpu-temp",
          short: "CPU hot",
          title: `CPU at ${round(cur)} °C`,
          detail: `Above ${threshold} °C for 10 s.`,
          rule: HEALTH_RULES.cpuTemp,
          action: viewNav("View sensors", "sensors"),
          stateKey: crit != null ? "crit" : "warn",
        }),
      );
    }
  }

  // 6. GPU temperatures (hot spot, else edge)
  (latest?.gpus ?? []).forEach((g, i) => {
    const useHotspot = isNum(g.hotspotTempC);
    const samples = win.map((p) => {
      const pg = p.gpus?.[i];
      if (!pg) return null;
      return useHotspot ? pg.hotspotTempC : pg.tempC;
    });
    if (!useHotspot && !isNum(g.tempC)) return;
    const critAt = useHotspot ? T.gpuHotspotCritC : T.gpuEdgeCritC;
    const warnAt = useHotspot ? T.gpuHotspotWarnC : T.gpuEdgeWarnC;
    const crit = sustainedMin(samples, critAt);
    const warn = crit == null ? sustainedMin(samples, warnAt) : null;
    if (crit == null && warn == null) return;
    const threshold = crit != null ? critAt : warnAt;
    const cur = (useHotspot ? g.hotspotTempC : g.tempC) ?? threshold;
    out.push(
      cond(6, {
        id: `gpu-temp:${i}`,
        severity: crit != null ? "crit" : "warn",
        source: "gpu",
        group: "gpu-temp",
        short: "GPU hot",
        title: `${g.name} at ${round(cur)} °C`,
        detail: `Above ${threshold} °C for 10 s.`,
        rule: HEALTH_RULES.gpuTemp,
        action: viewNav("View sensors", "sensors"),
        stateKey: crit != null ? "crit" : "warn",
      }),
    );
  });

  // 7. Drive temperatures
  for (const t of tele) {
    if (!isNum(t.tempC)) continue;
    const samples = win.map((p) => p.disks?.find((d) => d.id === t.id)?.tempC ?? null);
    const critAt = t.criticalTempC ?? T.driveCritFallbackC;
    const warnAt = t.warningTempC ?? T.driveWarnFallbackC;
    const crit = sustainedMin(samples, critAt);
    const warn = crit == null ? sustainedMin(samples, warnAt) : null;
    if (crit == null && warn == null) continue;
    const threshold = crit != null ? critAt : warnAt;
    out.push(
      cond(7, {
        id: `drive-temp:${t.id}`,
        severity: crit != null ? "crit" : "warn",
        source: "drive",
        group: "drive-temp",
        short: "Drive hot",
        title: `${nameOf(t)} at ${round(t.tempC)} °C`,
        detail: `Above ${threshold} °C for 10 s.`,
        rule: HEALTH_RULES.driveTemp,
        action: viewNav("View drive", "storage", t.id),
        stateKey: crit != null ? "crit" : "warn",
      }),
    );
  }

  // 8. Free space
  for (const v of volumes) {
    if (v.driveType !== "Fixed" || !(v.totalBytes > 0)) continue;
    const pct = (v.freeBytes / v.totalBytes) * 100;
    if (!(pct < T.freeSpaceWarnPct)) continue;
    const crit = pct < T.freeSpaceCritPct;
    out.push(
      cond(8, {
        id: `space:${v.letter}`,
        severity: crit ? "crit" : "warn",
        source: "space",
        group: "space",
        short: "Low disk space",
        title: `${v.letter} has ${fmtBytes(v.freeBytes)} free (${pct.toFixed(1)}%)`,
        detail: `Below ${crit ? T.freeSpaceCritPct : T.freeSpaceWarnPct}% free.`,
        rule: HEALTH_RULES.space,
        action: viewNav("View storage", "storage"),
        stateKey: crit ? "crit" : "warn",
      }),
    );
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

  // Sort: severity, then rule order (stable within a rule).
  const conditions = out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => SEV_RANK[a.c.severity] - SEV_RANK[b.c.severity] || a.c.order - b.c.order || a.i - b.i)
    .map(({ c }) => {
      const { order: _order, ...rest } = c;
      return rest as HealthCondition;
    });

  const level: SystemHealthLevel = conditions.some((c) => c.severity === "crit")
    ? "critical"
    : conditions.some((c) => c.severity === "warn")
      ? "attention"
      : conditions.length > 0
        ? "partial"
        : "optimal";
  const label =
    level === "critical" ? "Critical" : level === "attention" ? "Attention" : level === "partial" ? "Partial sensors" : "Optimal";

  return { level, label, summary: summarize(level, label, conditions), conditions, rules: [...HEALTH_RULE_LIST] };
}

function summarize(level: SystemHealthLevel, label: string, conditions: HealthCondition[]): string | null {
  if (level === "optimal" || conditions.length === 0) return null;
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
