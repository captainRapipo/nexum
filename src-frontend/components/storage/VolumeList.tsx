import { Disc3, HardDrive, Network, Usb } from "lucide-react";
import type { Volume } from "../../types";
import { SegmentedBar } from "../ui";
import { cn, fmtBytes } from "../../lib/format";

export const VOLUME_CRIT_PCT = 90;
export const VOLUME_WARN_PCT = 75;

function usedPct(v: Volume): number {
  if (!v.totalBytes || v.totalBytes <= 0) return 0;
  const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
  return Math.max(0, Math.min(100, (used / v.totalBytes) * 100));
}

function DriveIcon({ type }: { type: Volume["driveType"] }) {
  if (type === "Removable") return <Usb size={16} />;
  if (type === "Network") return <Network size={16} />;
  if (type === "CD-ROM") return <Disc3 size={16} />;
  return <HardDrive size={16} />;
}

/** Logical volumes (C:, D:, …) with LED usage bars; turns rose at ≥ 90 % full. */
export default function VolumeList({ volumes }: { volumes: Volume[] }) {
  const sorted = [...volumes].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
    return a.letter.localeCompare(b.letter);
  });

  if (sorted.length === 0) {
    return <div className="py-10 text-center text-[12.5px] text-muted">No mounted volumes reported.</div>;
  }

  return (
    <div className="flex flex-col divide-y divide-line">
      {sorted.map((v) => {
        const pct = usedPct(v);
        const crit = pct >= VOLUME_CRIT_PCT;
        const warn = !crit && pct >= VOLUME_WARN_PCT;
        const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
        return (
          <div key={`${v.letter}-${v.label}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 py-3.5 first:pt-1 last:pb-1">
            <div
              className={cn(
                "row-span-2 flex h-11 w-11 flex-col items-center justify-center rounded-lg border font-mono",
                crit ? "border-rose/45 bg-rose/10 text-rose" : "border-line bg-white/[0.03] text-silver",
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
                  <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-gold">
                    System
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-3 font-mono text-[11.5px]">
                <span className="text-silver">
                  {fmtBytes(used)} <span className="text-muted">used</span>
                </span>
                <span className={crit ? "text-rose" : "text-teal"}>
                  {fmtBytes(v.freeBytes)} <span className="text-muted">free</span>
                </span>
                <span className="text-muted">/ {fmtBytes(v.totalBytes)}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <SegmentedBar value={pct} segments={32} tone={crit ? "rose" : warn ? "gold" : "teal"} />
              </div>
              <span
                className={cn(
                  "w-14 text-right font-mono text-[14px] font-semibold",
                  crit ? "text-rose" : warn ? "text-gold" : "text-ink",
                )}
              >
                {pct.toFixed(0)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
