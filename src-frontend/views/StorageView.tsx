import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Gauge, HardDrive, HeartPulse, Layers, RefreshCw } from "lucide-react";
import type { DiskTelemetry, PhysicalDisk, Volume } from "../types";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSettings } from "../hooks/useSettings";
import { joinDisks } from "../lib/disks";
import { onFocusRequest, takePendingFocus } from "../lib/nav";
import { fmtBytes } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { Button, Unavailable, type StatusTone } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import StatTile from "../components/drivers/StatTile";
import PhysicalDiskCard from "../components/storage/PhysicalDiskCard";
import SmartDrawer from "../components/storage/SmartDrawer";
import VolumeList, { spaceTone } from "../components/storage/VolumeList";
import { fmtRate } from "../components/storage/ThroughputChart";
import { healthOf, needsAttention, UNMATCHED_HEALTH } from "../components/storage/driveHealth";

const EMPTY_DISKS: PhysicalDisk[] = [];
const EMPTY_VOLUMES: Volume[] = [];
const EMPTY_TEL: DiskTelemetry[] = [];

const ATTENTION_RULE =
  "A drive needs attention when the drive classifier reports Worn (10–50% life), Check sectors, Overheating, Windows warning, Replace soon (≤ 10% life) or Failing. Drives with unknown health are never counted as good.";

interface DriveEntry {
  key: string;
  disk: PhysicalDisk | null;
  tele: DiskTelemetry | null;
}

export default function StorageView() {
  const { volumes, disks, refresh } = useSystemInfo();
  const { latest, history, agent } = useTelemetry();
  const { settings } = useSettings();
  const tempUnit = settings?.tempUnit ?? "C";
  const [refreshing, setRefreshing] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const physical = disks ?? EMPTY_DISKS;
  const vols = volumes ?? EMPTY_VOLUMES;
  const telDisks = latest?.disks ?? EMPTY_TEL;
  const hist = history ?? [];

  // NavRequest.focus = DiskTelemetry.id opens that drive's S.M.A.R.T. drawer (CONTRACT §4.10).
  useEffect(() => {
    const first = takePendingFocus("storage");
    if (first) setDrawerId(first);
    return onFocusRequest((req) => {
      if (req.view !== "storage") return;
      const id = takePendingFocus("storage") ?? req.focus ?? null;
      if (id) setDrawerId(id);
    });
  }, []);

  const joined = useMemo(() => joinDisks(physical, telDisks), [physical, telDisks]);

  /** Physical disks first (system disk first), then sensor-only drives that matched no Windows disk. */
  const entries = useMemo<DriveEntry[]>(() => {
    const out: DriveEntry[] = [...joined]
      .sort((a, b) => Number(b.disk.isSystemDisk) - Number(a.disk.isSystemDisk) || Number(a.disk.deviceId) - Number(b.disk.deviceId))
      .map((j) => ({ key: `pd:${j.disk.deviceId}:${j.disk.serial}`, disk: j.disk, tele: j.tele }));
    const used = new Set(joined.map((j) => j.tele?.id).filter(Boolean) as string[]);
    for (const t of telDisks) if (!used.has(t.id)) out.push({ key: `td:${t.id}`, disk: null, tele: t });
    return out;
  }, [joined, telDisks]);

  const summary = useMemo(() => {
    let total = 0;
    let free = 0;
    let low = 0;
    for (const v of vols) {
      if (v.driveType === "Network" || v.driveType === "CD-ROM") continue;
      total += v.totalBytes || 0;
      free += v.freeBytes || 0;
      if (spaceTone(v) !== "ok") low++;
    }
    const raw = physical.reduce((a, d) => a + (d.sizeBytes || 0), 0);
    return { total, free, used: Math.max(0, total - free), low, raw };
  }, [vols, physical]);

  const healthSummary = useMemo(() => {
    const states = entries.map((e) => (e.tele ? healthOf(e.tele) : UNMATCHED_HEALTH));
    const attention = states.filter(needsAttention).length;
    const unknown = states.filter((h) => h.state === "unknown").length;
    const severe = states.some((h) => h.state === "failing" || h.state === "replace");
    const tone: StatusTone = severe ? "crit" : attention > 0 ? "warn" : unknown > 0 ? "unknown" : "ok";
    return { attention, unknown, total: states.length, tone };
  }, [entries]);

  let ioR: number | null = null;
  let ioW: number | null = null;
  for (const d of telDisks) {
    if (d.readMBps != null) ioR = (ioR ?? 0) + d.readMBps;
    if (d.writeMBps != null) ioW = (ioW ?? 0) + d.writeMBps;
  }

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

  const closeDrawer = useCallback(() => setDrawerId(null), []);
  const drawerEntry = drawerId ? entries.find((e) => e.tele?.id === drawerId) ?? null : null;

  const usedPct = summary.total > 0 ? (summary.used / summary.total) * 100 : 0;
  const { attention, unknown, total } = healthSummary;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Storage</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Physical drives with S.M.A.R.T. health, live throughput and the volumes stored on each drive.
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
          label="Drive health"
          value={total > 0 ? `${attention} of ${total}` : "—"}
          accent="silver"
          valueTone={total > 0 ? healthSummary.tone : undefined}
          icon={<HeartPulse size={15} />}
          title={ATTENTION_RULE}
          sub={
            total > 0
              ? `${total === 1 ? "drive" : "drives"} ${attention === 1 ? "needs" : "need"} attention${unknown > 0 ? ` · ${unknown} unknown` : ""}`
              : "Waiting for drive data"
          }
        />
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
          accent="purple"
          icon={<Layers size={15} />}
          sub={
            summary.total > 0
              ? summary.low > 0
                ? `${summary.low} ${summary.low === 1 ? "volume is" : "volumes are"} low on space`
                : `${fmtBytes(summary.used)} used · ${fmtBytes(summary.free)} free`
              : "Waiting for volume data"
          }
        />
        <StatTile
          label="Live I/O"
          value={
            ioR === null && ioW === null ? (
              latest ? <Unavailable reason="unsupported" compact /> : "—"
            ) : (
              <span className="text-[20px]">{fmtRate((ioR ?? 0) + (ioW ?? 0))}</span>
            )
          }
          accent="cyan"
          icon={<Gauge size={15} />}
          sub={ioR === null && ioW === null ? "Not reported" : `R ${fmtRate(ioR ?? 0)} · W ${fmtRate(ioW ?? 0)}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <GlassCard
          title="Physical drives"
          icon={<HardDrive size={15} />}
          accent="teal"
          actions={<span className="font-mono text-[11px] text-muted">{entries.length} detected</span>}
        >
          {entries.length === 0 ? (
            <div className="py-12 text-center text-[12.5px] text-muted">
              No physical drives reported yet. The storage query may still be running.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-1">
              {entries.map((e) => (
                <PhysicalDiskCard
                  key={e.key}
                  physical={e.disk}
                  telemetry={e.tele}
                  health={e.tele ? healthOf(e.tele) : UNMATCHED_HEALTH}
                  history={hist}
                  tempUnit={tempUnit}
                  agent={agent}
                  onDetails={e.tele ? () => setDrawerId(e.tele!.id) : undefined}
                />
              ))}
            </div>
          )}
        </GlassCard>

        <GlassCard
          title="Volumes"
          icon={<Layers size={15} />}
          accent="purple"
          actions={
            summary.raw > 0 ? <span className="font-mono text-[11px] text-muted">{fmtBytes(summary.raw)} raw</span> : undefined
          }
        >
          <VolumeList volumes={vols} joined={joined} onOpenDrive={setDrawerId} />
        </GlassCard>
      </div>

      {drawerEntry && (
        <SmartDrawer
          tele={drawerEntry.tele}
          disk={drawerEntry.disk}
          health={drawerEntry.tele ? healthOf(drawerEntry.tele) : UNMATCHED_HEALTH}
          tempUnit={tempUnit}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}
