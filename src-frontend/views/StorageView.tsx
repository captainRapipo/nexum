import { useMemo, useState } from "react";
import { Database, Gauge, HardDrive, Layers, RefreshCw, Thermometer } from "lucide-react";
import type { DiskTelemetry, PhysicalDisk, Volume } from "../types";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSettings } from "../hooks/useSettings";
import { fmtBytes, fmtTemp } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { Button } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import StatTile from "../components/drivers/StatTile";
import PhysicalDiskCard from "../components/storage/PhysicalDiskCard";
import VolumeList, { VOLUME_CRIT_PCT } from "../components/storage/VolumeList";
import { pairDisks } from "../components/storage/diskMatch";
import { fmtRate } from "../components/storage/ThroughputChart";

const EMPTY_DISKS: PhysicalDisk[] = [];
const EMPTY_VOLUMES: Volume[] = [];
const EMPTY_TEL: DiskTelemetry[] = [];

export default function StorageView() {
  const { volumes, disks, refresh } = useSystemInfo();
  const { latest, history } = useTelemetry();
  const { settings } = useSettings();
  const tempUnit = settings?.tempUnit ?? "C";
  const [refreshing, setRefreshing] = useState(false);

  const physical = disks ?? EMPTY_DISKS;
  const vols = volumes ?? EMPTY_VOLUMES;
  const telDisks = latest?.disks ?? EMPTY_TEL;
  const hist = history ?? [];

  // Pair once per change in the set of drives/sensors (not on every telemetry tick).
  const telKey = telDisks.map((d) => `${d.id}|${d.name}`).join(";");
  const pairs = useMemo(() => pairDisks(physical, telDisks), [physical, telKey]);

  // Resolve the live telemetry object for each pair on every tick.
  const live = pairs.map((p) => ({
    ...p,
    telemetry: p.telemetry ? (telDisks.find((d) => d.id === p.telemetry!.id) ?? p.telemetry) : null,
  }));

  const summary = useMemo(() => {
    let total = 0;
    let free = 0;
    let crit = 0;
    for (const v of vols) {
      if (v.driveType === "Network" || v.driveType === "CD-ROM") continue;
      total += v.totalBytes || 0;
      free += v.freeBytes || 0;
      const used = v.usedBytes > 0 ? v.usedBytes : Math.max(0, v.totalBytes - v.freeBytes);
      if (v.totalBytes > 0 && (used / v.totalBytes) * 100 >= VOLUME_CRIT_PCT) crit++;
    }
    const raw = physical.reduce((a, d) => a + (d.sizeBytes || 0), 0);
    return { total, free, used: Math.max(0, total - free), crit, raw };
  }, [vols, physical]);

  const io = telDisks.reduce(
    (a, d) => ({ r: a.r + (d.readMBps ?? 0), w: a.w + (d.writeMBps ?? 0) }),
    { r: 0, w: 0 },
  );
  const hottest = telDisks.reduce<number | null>((m, d) => (d.tempC != null && (m == null || d.tempC > m) ? d.tempC : m), null);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.resolve(refresh());
    } catch (e) {
      toast(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, "crit");
    } finally {
      setRefreshing(false);
    }
  };

  const usedPct = summary.total > 0 ? (summary.used / summary.total) * 100 : 0;

  return (
    <div className="flex flex-col gap-5">

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-gold/80">Module B · Drive Diagnostics</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">Storage</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Physical drives with S.M.A.R.T. health, live throughput and every mounted volume.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />}
          onClick={() => void onRefresh()}
          disabled={refreshing}
        >
          Refresh drives
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Capacity"
          value={summary.total > 0 ? fmtBytes(summary.total) : "—"}
          accent="teal"
          icon={<Database size={15} />}
          sub={`${physical.length} physical · ${vols.length} volumes`}
        />
        <StatTile
          label="Used"
          value={summary.total > 0 ? `${usedPct.toFixed(0)}%` : "—"}
          accent={summary.crit > 0 ? "rose" : "purple"}
          tintValue={summary.crit > 0}
          icon={<Layers size={15} />}
          sub={
            summary.total > 0
              ? `${fmtBytes(summary.used)} used · ${fmtBytes(summary.free)} free`
              : "Waiting for volume data"
          }
        />
        <StatTile
          label="Live I/O"
          value={<span className="text-[20px]">{fmtRate(io.r + io.w)}</span>}
          accent="gold"
          icon={<Gauge size={15} />}
          sub={`R ${fmtRate(io.r)} · W ${fmtRate(io.w)}`}
        />
        <StatTile
          label="Hottest drive"
          value={hottest == null ? "—" : fmtTemp(hottest, tempUnit)}
          accent={hottest != null && hottest >= 70 ? "rose" : "cyan"}
          tintValue={hottest != null && hottest >= 70}
          icon={<Thermometer size={15} />}
          sub={summary.crit > 0 ? `${summary.crit} volume(s) ≥ ${VOLUME_CRIT_PCT}% full` : "All volumes have headroom"}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <GlassCard
          title="Physical Drives"
          icon={<HardDrive size={15} />}
          accent="teal"
          actions={<span className="font-mono text-[11px] text-muted">{live.length} detected</span>}
        >
          {live.length === 0 ? (
            <div className="py-12 text-center text-[12.5px] text-muted">
              No physical drives reported yet. The storage query may still be running.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-1">
              {live.map((p) => (
                <PhysicalDiskCard
                  key={p.key}
                  physical={p.physical}
                  telemetry={p.telemetry}
                  history={hist}
                  tempUnit={tempUnit}
                />
              ))}
            </div>
          )}
        </GlassCard>

        <GlassCard
          title="Logical Volumes"
          icon={<Layers size={15} />}
          accent="purple"
          actions={
            summary.raw > 0 ? (
              <span className="font-mono text-[11px] text-muted">{fmtBytes(summary.raw)} raw</span>
            ) : undefined
          }
        >
          <VolumeList volumes={vols} />
        </GlassCard>
      </div>
    </div>
  );
}
