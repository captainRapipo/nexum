import { useMemo } from "react";
import { ArrowUpRight, Database } from "lucide-react";
import { SegmentedBar, StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { driveDisplayName, joinDisks } from "../../lib/disks";
import { driveHealthView } from "../../lib/status";
import { requestNavigate } from "../../lib/nav";
import { fmtBytes } from "../../lib/format";
import type { DiskTelemetry, PhysicalDisk } from "../../types";
import { pickSystemVolume, usedPctOf } from "./StorageGauge";
import { attentionText, healthOf, lifeText, needsAttention } from "./driveHealth";

const EMPTY_TEL: DiskTelemetry[] = [];

const ATTENTION_RULE =
  "Counts drives whose health is Worn, Check sectors, Overheating, Windows warning, Replace soon or Failing (drive classifier, CONTRACT §1.1.3).";

/**
 * Dashboard "Drives" card (MF-1): one row per physical drive with a `Life NN%` chip whose tone comes
 * from the drive classifier, the "N of M drives need attention" summary, and the system volume's fill.
 */
export default function DrivesCard() {
  const { volumes, disks } = useSystemInfo();
  const { latest } = useTelemetry();
  const tele = latest?.disks ?? EMPTY_TEL;
  const vol = useMemo(() => pickSystemVolume(volumes), [volumes]);

  const rows = useMemo(() => {
    const joined = joinDisks(disks ?? [], tele);
    return joined
      .map(({ disk, tele: t }) => ({ disk, tele: t, health: healthOf(t) }))
      .sort((a, b) => Number(b.disk.isSystemDisk) - Number(a.disk.isSystemDisk) || Number(a.disk.deviceId) - Number(b.disk.deviceId));
  }, [disks, tele]);

  const attention = rows.filter((r) => needsAttention(r.health)).length;
  const unknown = rows.filter((r) => r.health.state === "unknown").length;
  const pct = vol ? usedPctOf(vol) : null;

  return (
    <GlassCard
      title="Drives"
      icon={<Database size={14} />}
      accent="teal"
      actions={
        <button
          type="button"
          onClick={() => requestNavigate("storage")}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-teal"
          title="Open Storage (F4)"
        >
          Storage
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </button>
      }
    >
      {rows.length === 0 ? (
        <div className="py-2 text-[11px] text-muted">Reading drives…</div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[11.5px] text-silver" title={ATTENTION_RULE}>
              {attentionText(attention, rows.length, unknown)}
            </span>
            {unknown > 0 && unknown < rows.length && (
              <span className="shrink-0 text-[10.5px] text-muted" title="Drives whose health cannot be read are never shown as good.">
                {unknown} unknown
              </span>
            )}
          </div>
          <ul className="flex flex-col gap-1" aria-label="Physical drives">
            {rows.map(({ disk, tele: t, health }) => (
              <DriveRow key={`${disk.deviceId}:${disk.serial}`} disk={disk} tele={t} health={health} />
            ))}
          </ul>
        </>
      )}

      {vol && pct !== null && (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="mb-1.5 flex items-baseline justify-between gap-2 font-mono text-[10.5px] text-muted">
            <span className="truncate">
              {vol.letter} {vol.label ? vol.label : ""} · {pct.toFixed(0)}% used
            </span>
            <span className="shrink-0 tabular-nums">{fmtBytes(vol.freeBytes)} free</span>
          </div>
          <SegmentedBar value={pct} segments={28} tone="teal" />
        </div>
      )}
    </GlassCard>
  );
}

function DriveRow({
  disk,
  tele,
  health,
}: {
  disk: PhysicalDisk;
  tele: DiskTelemetry | null;
  health: ReturnType<typeof healthOf>;
}) {
  const view = driveHealthView(health);
  const life = lifeText(tele);
  const chipText = life ?? (health.state === "unknown" ? "Unknown" : view.label);
  const name = driveDisplayName(disk, tele);
  const open = () => requestNavigate(tele ? { view: "storage", focus: tele.id } : { view: "storage" });
  return (
    <li>
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
        title={`${name}\n${view.label}${health.reason ? ` — ${health.reason}` : ""}`}
      >
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{name}</span>
        <StatusPill tone={view.tone} icon={view.icon} title={`${view.label}. ${health.reason}`}>
          {chipText}
        </StatusPill>
      </button>
    </li>
  );
}
