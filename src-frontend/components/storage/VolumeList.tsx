import type { DiskTelemetry, PhysicalDisk, Volume } from "../../types";
import { Meter, StatusIcon, STATUS_CLASS } from "../ui";
import { driveHealthView, spaceThresholds } from "../../lib/status";
import { useSettings } from "../../hooks/useSettings";
import { cn, fmtBytes } from "../../lib/format";
import { shortModel } from "./diskMatch";
import { healthOf, lifeText } from "./driveHealth";

function usedPct(v: Volume): number {
  if (!v.totalBytes || v.totalBytes <= 0) return 0;
  const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
  return Math.max(0, Math.min(100, (used / v.totalBytes) * 100));
}

export interface SpaceThresholds {
  warnPct: number;
  critPct: number;
}

/**
 * Free-space state, the same rule Rust's space alert uses (CONTRACT §2.10.3 rule 6, §5.0): thresholds from
 * Settings.alerts.freeSpacePct via spaceThresholds(settings).
 */
export function spaceTone(v: Volume, th: SpaceThresholds): "ok" | "warn" | "crit" {
  if (v.driveType !== "Fixed" || !v.totalBytes) return "ok";
  const free = (v.freeBytes / v.totalBytes) * 100;
  if (free < th.critPct) return "crit";
  if (free < th.warnPct) return "warn";
  return "ok";
}

export function spaceRuleText(th: SpaceThresholds): string {
  return `Attention below ${th.warnPct}% free, critical below ${th.critPct}% free (fixed volumes).`;
}

/** "Local Disk (C:)", "Games (F:)"; a volume without a label is named after its kind. */
export function volumeTitle(v: Volume): string {
  const fallback =
    v.driveType === "Removable" ? "Removable drive" : v.driveType === "Network" ? "Network drive" : v.driveType === "CD-ROM" ? "Disc drive" : "Local Disk";
  const letter = v.letter?.trim();
  return `${v.label?.trim() || fallback}${letter ? ` (${letter})` : ""}`;
}

export interface VolumeListProps {
  volumes: Volume[];
  /** Physical disks joined to telemetry, used for the "on <model> (Life NN%)" part. */
  joined: { disk: PhysicalDisk; tele: DiskTelemetry | null }[];
  /** Opens the S.M.A.R.T. details of a telemetry disk. */
  onOpenDrive?: (teleId: string) => void;
}

/** Logical volumes (C:, D:, …), each linked to the physical disk it lives on (MF-1). */
export default function VolumeList({ volumes, joined, onOpenDrive }: VolumeListProps) {
  const { settings } = useSettings();
  const th = spaceThresholds(settings);
  const spaceRule = spaceRuleText(th);
  const sorted = [...volumes].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
    return a.letter.localeCompare(b.letter);
  });

  if (sorted.length === 0) {
    return <div className="py-6 text-center text-body text-ink-2">No mounted volumes reported.</div>;
  }

  const hostOf = (letter: string) => {
    const L = letter.trim().toUpperCase();
    return joined.find((j) => (j.disk.volumes ?? []).some((v) => v.trim().toUpperCase() === L)) ?? null;
  };

  return (
    <div className="grid grid-cols-3 gap-x-7 gap-y-5 tight:gap-x-4">
      {sorted.map((v) => {
        const pct = usedPct(v);
        const tone = spaceTone(v, th);
        const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
        const host = hostOf(v.letter);
        const hostHealth = host ? healthOf(host.tele) : null;
        const hostView = hostHealth ? driveHealthView(hostHealth) : null;
        const life = host ? lifeText(host.tele) : null;
        const hostText = host ? `on ${shortModel(host.disk.model)}${life ? ` (${life})` : ""}` : null;
        const hostTitle = host
          ? `${host.disk.model}${hostView ? `. ${hostView.label}: ${hostHealth!.reason}` : ""}${host.tele && onOpenDrive ? ". Open the S.M.A.R.T. details." : ""}`
          : "Windows did not report which physical disk holds this volume.";
        return (
          <div key={`${v.letter}-${v.label}`} className="min-w-0">
            <div className="mb-[7px] flex min-w-0 items-baseline justify-between gap-x-3 text-[13px] leading-[18px] tight:flex-col tight:gap-px">
              <span className="min-w-0 max-w-full truncate font-medium text-ink" title={`${volumeTitle(v)} · ${v.driveType}`}>
                {volumeTitle(v)}
              </span>
              <span className="flex min-w-0 max-w-full whitespace-nowrap text-ink-2">
                <span className="shrink-0">{v.fileSystem || "—"} ·&nbsp;</span>
                {host?.tele && onOpenDrive ? (
                  <button type="button" title={hostTitle} onClick={() => onOpenDrive(host.tele!.id)} className="min-w-0 truncate rounded-xs hover:underline">
                    {hostText}
                  </button>
                ) : (
                  <span title={hostTitle} className="min-w-0 truncate">
                    {hostText ?? "disk not identified"}
                  </span>
                )}
              </span>
            </div>
            <Meter value={pct} tone={tone === "ok" ? undefined : "warn"} height={6} label={`${volumeTitle(v)} used space`} />
            <div className="tnum mt-[7px] flex justify-between gap-3 text-callout text-ink-2">
              <span>{fmtBytes(used)} used</span>
              <span className={cn("inline-flex items-center gap-1", tone !== "ok" && STATUS_CLASS[tone].text)} title={spaceRule}>
                {tone !== "ok" && <StatusIcon tone={tone} size={13} />}
                {fmtBytes(v.freeBytes)} free{tone !== "ok" ? " · low" : ""}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
