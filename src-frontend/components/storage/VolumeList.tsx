import { Disc3, HardDrive, Network, Usb } from "lucide-react";
import type { DiskTelemetry, PhysicalDisk, Volume } from "../../types";
import { SegmentedBar, STATUS_CLASS } from "../ui";
import { driveHealthView, spaceThresholds } from "../../lib/status";
import { useSettings } from "../../hooks/useSettings";
import { cn, fmtBytes } from "../../lib/format";
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

function DriveIcon({ type }: { type: Volume["driveType"] }) {
  if (type === "Removable") return <Usb size={16} />;
  if (type === "Network") return <Network size={16} />;
  if (type === "CD-ROM") return <Disc3 size={16} />;
  return <HardDrive size={16} />;
}

export interface VolumeListProps {
  volumes: Volume[];
  /** Physical disks joined to telemetry, used for the "on <model> (Life NN%)" line. */
  joined: { disk: PhysicalDisk; tele: DiskTelemetry | null }[];
  /** Opens the S.M.A.R.T. drawer of a telemetry disk. */
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
    return <div className="py-10 text-center text-[12.5px] text-muted">No mounted volumes reported.</div>;
  }

  const hostOf = (letter: string) => {
    const L = letter.trim().toUpperCase();
    return joined.find((j) => (j.disk.volumes ?? []).some((v) => v.trim().toUpperCase() === L)) ?? null;
  };

  return (
    <div className="flex flex-col divide-y divide-line">
      {sorted.map((v) => {
        const pct = usedPct(v);
        const tone = spaceTone(v, th);
        const cls = STATUS_CLASS[tone];
        const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
        const host = hostOf(v.letter);
        const hostHealth = host ? healthOf(host.tele) : null;
        const hostView = hostHealth ? driveHealthView(hostHealth) : null;
        const life = host ? lifeText(host.tele) : null;
        return (
          <div key={`${v.letter}-${v.label}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 py-3.5 first:pt-1 last:pb-1">
            <div
              className={cn(
                "row-span-3 flex h-11 w-11 flex-col items-center justify-center rounded-lg border font-mono",
                tone === "ok" ? "border-line bg-white/[0.03] text-silver" : cn(cls.border, cls.soft, cls.text),
              )}
            >
              <DriveIcon type={v.driveType} />
              <span className="mt-0.5 text-[10.5px] font-semibold leading-none">{v.letter}</span>
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[13.5px] font-semibold text-ink">{v.label || "Local Disk"}</span>
                <span className="font-mono text-[11px] text-muted">{v.fileSystem || "—"}</span>
                <span className="text-[11px] text-muted">{v.driveType}</span>
                {v.isSystem && (
                  <span className="rounded border border-line bg-white/[0.04] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-silver">
                    System
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-3 font-mono text-[11.5px]">
                <span className="text-silver">
                  {fmtBytes(used)} <span className="text-muted">used</span>
                </span>
                <span className={tone === "ok" ? "text-ink" : cls.text} title={spaceRule}>
                  {fmtBytes(v.freeBytes)} <span className="text-muted">free</span>
                </span>
                <span className="text-muted">/ {fmtBytes(v.totalBytes)}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <SegmentedBar value={pct} segments={32} tone="teal" />
              </div>
              <span className="w-14 text-right font-mono text-[14px] font-semibold text-ink">{pct.toFixed(0)}%</span>
            </div>

            <div className="min-w-0 truncate text-[11.5px] text-muted">
              {host ? (
                <>
                  on{" "}
                  {host.tele && onOpenDrive ? (
                    <button
                      type="button"
                      onClick={() => onOpenDrive(host.tele!.id)}
                      className="text-silver underline decoration-white/20 underline-offset-2 transition hover:text-ink"
                      title="Open the S.M.A.R.T. details of this drive"
                    >
                      {host.disk.model}
                    </button>
                  ) : (
                    <span className="text-silver">{host.disk.model}</span>
                  )}{" "}
                  {hostView && (
                    <span
                      className={hostHealth!.state === "good" ? "text-silver" : STATUS_CLASS[hostView.tone].text}
                      title={`${hostView.label}. ${hostHealth!.reason}`}
                    >
                      ({life ?? hostView.label})
                    </span>
                  )}
                </>
              ) : (
                <span>Physical disk not identified</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
