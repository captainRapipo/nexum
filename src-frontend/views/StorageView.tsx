import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { DiskTelemetry, PhysicalDisk, Volume } from "../types";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSettings } from "../hooks/useSettings";
import { useTightMode } from "../hooks/useTightMode";
import { joinDisks } from "../lib/disks";
import { onFocusRequest, takePendingFocus } from "../lib/nav";
import { driveHealthView, spaceThresholds } from "../lib/status";
import { cn, fmtBytes, fmtClock } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import { Button, Segmented, StatusIcon, Unavailable, UNAVAILABLE_TEXT, type StatusTone } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import DriveTable, { type DriveEntry } from "../components/storage/PhysicalDiskCard";
import SmartDrawer from "../components/storage/SmartDrawer";
import VolumeList, { spaceTone } from "../components/storage/VolumeList";
import ThroughputChart, { fmtRate } from "../components/storage/ThroughputChart";
import { shortModel } from "../components/storage/diskMatch";
import { healthOf, lifePct, needsAttention, UNMATCHED_HEALTH } from "../components/storage/driveHealth";

const EMPTY_DISKS: PhysicalDisk[] = [];
const EMPTY_VOLUMES: Volume[] = [];
const EMPTY_TEL: DiskTelemetry[] = [];

const ATTENTION_RULE =
  "A drive needs attention when the drive classifier reports Worn (10–50% life), Check sectors, Overheating, Windows warning, Replace soon (≤ 10% life) or Failing. Drives with unknown health are never counted as good.";

const DESCRIPTION = "Physical drives with S.M.A.R.T. health, the volumes on each and live throughput.";

type IoRange = 60 | 120;
const IO_RANGES: ReadonlyArray<{ value: IoRange; label: string }> = [
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
];

/** Space figure for a meta line: "371 GB", "1.73 TB" (no decimals from 100 GB up, two for terabytes). */
function fmtSpace(bytes: number): string {
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  if (bytes >= TB) return fmtBytes(bytes, 2);
  return fmtBytes(bytes, bytes >= 100 * GB ? 0 : 1);
}

/** "2.1 TB" → ["2.1", "TB"], so the unit can be set smaller than the number. */
function splitUnit(text: string): [string, string] {
  const i = text.lastIndexOf(" ");
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ""];
}

export default function StorageView() {
  const { volumes, disks, refresh } = useSystemInfo();
  const { latest, history, agent } = useTelemetry();
  const { settings } = useSettings();
  const tight = useTightMode();
  const tempUnit = settings?.tempUnit ?? "C";
  const freeSpacePct = settings?.alerts?.freeSpacePct;
  const th = useMemo(() => spaceThresholds(settings), [freeSpacePct]); // eslint-disable-line react-hooks/exhaustive-deps
  const [refreshing, setRefreshing] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  /** Drive charted in "Live I/O": the last drive whose details were opened, else the system drive. */
  const [chartId, setChartId] = useState<string | null>(null);
  const [ioRange, setIoRange] = useState<IoRange>(120);

  const physical = disks ?? EMPTY_DISKS;
  const vols = volumes ?? EMPTY_VOLUMES;
  const telDisks = latest?.disks ?? EMPTY_TEL;
  const hist = history ?? [];

  const openDrawer = useCallback((id: string) => {
    setDrawerId(id);
    setChartId(id);
  }, []);

  // NavRequest.focus = DiskTelemetry.id opens that drive's S.M.A.R.T. details (CONTRACT §4.10).
  useEffect(() => {
    const first = takePendingFocus("storage");
    if (first) openDrawer(first);
    return onFocusRequest((req) => {
      if (req.view !== "storage") return;
      const id = takePendingFocus("storage") ?? req.focus ?? null;
      if (id) openDrawer(id);
    });
  }, [openDrawer]);

  const joined = useMemo(() => joinDisks(physical, telDisks), [physical, telDisks]);

  /** Physical disks first (system disk first), then sensor-only drives that matched no Windows disk. */
  const entries = useMemo<DriveEntry[]>(() => {
    const out: DriveEntry[] = [...joined]
      .sort((a, b) => Number(b.disk.isSystemDisk) - Number(a.disk.isSystemDisk) || Number(a.disk.deviceId) - Number(b.disk.deviceId))
      .map((j) => ({ key: `pd:${j.disk.deviceId}:${j.disk.serial}`, disk: j.disk, tele: j.tele, health: j.tele ? healthOf(j.tele) : UNMATCHED_HEALTH }));
    const used = new Set(joined.map((j) => j.tele?.id).filter(Boolean) as string[]);
    for (const t of telDisks) if (!used.has(t.id)) out.push({ key: `td:${t.id}`, disk: null, tele: t, health: healthOf(t) });
    return out;
  }, [joined, telDisks]);

  const volumeLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vols) if (v.letter && v.label) m.set(v.letter.trim().toUpperCase(), v.label.trim());
    return m;
  }, [vols]);

  const summary = useMemo(() => {
    let total = 0;
    let free = 0;
    let low = 0;
    for (const v of vols) {
      if (v.driveType === "Network" || v.driveType === "CD-ROM") continue;
      total += v.totalBytes || 0;
      free += v.freeBytes || 0;
      if (spaceTone(v, th) !== "ok") low++;
    }
    const raw = physical.reduce((a, d) => a + (d.sizeBytes || 0), 0);
    return { total, free, used: Math.max(0, total - free), low, raw };
  }, [vols, physical, th]);

  const healthSummary = useMemo(() => {
    const attentionEntries = entries.filter((e) => needsAttention(e.health));
    const unknown = entries.filter((e) => e.health.state === "unknown").length;
    const severe = entries.some((e) => e.health.state === "failing" || e.health.state === "replace");
    const tone: StatusTone = severe ? "crit" : attentionEntries.length > 0 ? "warn" : unknown > 0 ? "unknown" : "ok";
    return { attention: attentionEntries.length, first: attentionEntries[0] ?? null, unknown, total: entries.length, tone };
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

  // Drive behind the Live I/O chart.
  const chartEntry =
    (chartId ? entries.find((e) => e.tele?.id === chartId) : null) ??
    entries.find((e) => e.tele && e.disk?.isSystemDisk) ??
    entries.find((e) => e.tele) ??
    null;
  const chartTeleId = chartEntry?.tele?.id ?? null;
  const series = useMemo(() => {
    const ts: number[] = [];
    const read: (number | null)[] = [];
    const write: (number | null)[] = [];
    if (!chartTeleId) return { ts, read, write };
    for (const p of hist) {
      const d = p.disks?.find((x) => x.id === chartTeleId);
      ts.push(p.ts);
      read.push(d?.readMBps ?? null);
      write.push(d?.writeMBps ?? null);
    }
    return { ts, read, write };
  }, [hist, chartTeleId]);
  const chartHasIo = series.read.some((v) => v != null) || series.write.some((v) => v != null);
  const chartName = chartEntry
    ? `${shortModel(chartEntry.disk?.model ?? chartEntry.tele?.name)}${chartEntry.disk && chartEntry.disk.volumes.length > 0 ? ` (${chartEntry.disk.volumes.join(", ")})` : ""}`
    : null;

  usePageChrome({
    subtitle: `${entries.length} ${entries.length === 1 ? "drive" : "drives"} · ${vols.length} ${vols.length === 1 ? "volume" : "volumes"}`,
  });

  const usedPct = summary.total > 0 ? (summary.used / summary.total) * 100 : 0;
  const { attention, unknown, total, first } = healthSummary;
  const allUnknown = total > 0 && attention === 0 && unknown >= total;
  const [capNum, capUnit] = splitUnit(fmtBytes(summary.total));
  const ioTotal = ioR === null && ioW === null ? null : (ioR ?? 0) + (ioW ?? 0);
  const [ioNum, ioUnit] = splitUnit(ioTotal == null ? "—" : fmtRate(ioTotal));

  let healthMeta: ReactNode;
  if (total === 0) healthMeta = "Waiting for drive data";
  else if (allUnknown) healthMeta = `No S.M.A.R.T. data for ${total === 1 ? "this drive" : `any of ${total} drives`}`;
  else if (first) {
    const view = driveHealthView(first.health);
    const letters = first.disk?.volumes?.join(" ") || shortModel(first.disk?.model ?? first.tele?.name);
    const life = lifePct(first.tele);
    healthMeta = (
      <>
        <StatusIcon tone={view.tone} size={13} />
        <span className="truncate">
          {letters} {first.health.label.toLowerCase()}
          {life != null ? ` · ${life}% life left` : ""}
          {attention > 1 ? ` · +${attention - 1} more` : ""}
        </span>
      </>
    );
  } else healthMeta = unknown > 0 ? `${unknown} with unknown health` : "Every drive reports good health";

  const smartRead = latest ? `S.M.A.R.T. read ${fmtClock(latest.ts, false)}` : null;

  const narrow = !!drawerEntry && tight;
  return (
    <div className={cn("flex min-h-full flex-1 flex-col", narrow && "pr-(--inspector-w)")}>
      <PageHeader view="storage" description={DESCRIPTION} />

      <div className="flex flex-1 flex-col gap-(--grid-gap)">
        <GlassCard padded={false} aria-label="Storage summary" className="shrink-0">
          <div className="grid grid-cols-4">
            <SummaryCell
              label="Drive health"
              title={ATTENTION_RULE}
              value={total > 0 ? (allUnknown ? "Unknown" : attention) : "—"}
              unit={total > 0 && !allUnknown ? `of ${total} need attention` : undefined}
              meta={healthMeta}
            />
            <SummaryCell
              label="Capacity"
              value={summary.total > 0 ? capNum : "—"}
              unit={summary.total > 0 ? capUnit : undefined}
              meta={`${physical.length} physical · ${vols.length} ${vols.length === 1 ? "volume" : "volumes"}`}
            />
            <SummaryCell
              label="Used"
              value={summary.total > 0 ? usedPct.toFixed(0) : "—"}
              unit={summary.total > 0 ? "%" : undefined}
              meta={
                summary.total > 0 ? (
                  summary.low > 0 ? (
                    <>
                      <StatusIcon tone="warn" size={13} />
                      <span className="truncate">
                        {summary.low} {summary.low === 1 ? "volume is" : "volumes are"} low on space
                      </span>
                    </>
                  ) : (
                    // Beside the docked inspector the cell is about 160 px wide: the free space alone fits.
                    narrow ? `${fmtSpace(summary.free)} free` : `${fmtSpace(summary.used)} used · ${fmtSpace(summary.free)} free`
                  )
                ) : (
                  "Waiting for volume data"
                )
              }
            />
            <SummaryCell
              label="Live I/O"
              value={ioTotal == null ? "—" : ioNum}
              unit={ioTotal == null ? undefined : ioUnit}
              meta={
                ioTotal == null ? (
                  latest ? <Unavailable reason="unsupported" /> : UNAVAILABLE_TEXT.agentOffline
                ) : (
                  // Each figure keeps its own unit: read and write are often a thousand times apart.
                  `Read ${fmtRate(ioR ?? 0)} · Write ${fmtRate(ioW ?? 0)}`
                )
              }
              title="Read and write throughput of all drives together."
            />
          </div>
        </GlassCard>

        <GlassCard
          title="Physical drives"
          padded={false}
          className="shrink-0"
          actions={
            <>
              {smartRead && <span className="tnum whitespace-nowrap">{smartRead}</span>}
              <Button
                size="sm"
                icon={<RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />}
                onClick={() => void onRefresh()}
                disabled={refreshing}
                title="Read the drive list and volumes again"
              >
                Refresh
              </Button>
            </>
          }
        >
          {entries.length === 0 ? (
            <div className="px-(--card-pad-x) pb-6 pt-2 text-body text-ink-2">
              No physical drives reported yet. The storage query may still be running.
            </div>
          ) : (
            <div className="px-2 pb-1.5">
              <DriveTable
                entries={entries}
                volumeLabels={volumeLabels}
                tempUnit={tempUnit}
                agent={agent}
                selectedId={drawerEntry?.tele?.id ?? null}
                onOpen={openDrawer}
                tight={tight}
              />
            </div>
          )}
        </GlassCard>

        <GlassCard title="Volumes" className="shrink-0" actions={summary.raw > 0 ? <span className="tnum">{fmtBytes(summary.raw)} raw</span> : undefined}>
          <VolumeList volumes={vols} joined={joined} onOpenDrive={openDrawer} />
        </GlassCard>

        <GlassCard
          title={chartName ? `Live I/O · ${chartName}` : "Live I/O"}
          className="min-h-[190px] flex-1 shrink-0"
          bodyClassName="flex min-h-0 flex-col"
          actions={<Segmented value={ioRange} options={IO_RANGES} onChange={setIoRange} ariaLabel="Time range" size="sm" />}
        >
          {chartEntry && chartHasIo ? (
            <div className="relative min-h-[120px] flex-1">
              <div className="absolute inset-0">
                <ThroughputChart ts={series.ts} read={series.read} write={series.write} rangeSec={ioRange} />
              </div>
            </div>
          ) : (
            <div className="flex min-h-[120px] flex-1 items-center justify-center text-body text-ink-2">
              {!latest ? (
                UNAVAILABLE_TEXT.agentOffline
              ) : chartEntry ? (
                <Unavailable reason="unsupported" />
              ) : (
                "No drive reports live throughput."
              )}
            </div>
          )}
        </GlassCard>
      </div>

      {drawerEntry && (
        <SmartDrawer
          tele={drawerEntry.tele}
          disk={drawerEntry.disk}
          health={drawerEntry.health}
          tempUnit={tempUnit}
          readTs={latest?.ts ?? null}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

/** One cell of the summary card: label, a large number with a small unit, one meta line. */
function SummaryCell({ label, value, unit, meta, title }: { label: string; value: ReactNode; unit?: string; meta: ReactNode; title?: string }) {
  return (
    <div className="min-w-0 border-l border-divider px-5 py-3.5 first:border-l-0 tight:px-3 tight:py-3" title={title}>
      <div className="text-[12.5px] font-medium leading-[17px] text-ink-2">{label}</div>
      <div className={cn("tnum mt-[5px] truncate whitespace-nowrap text-large-num font-semibold tight:text-[22px]", value === "—" ? "text-ink-3" : "text-ink")}>
        {value}
        {unit && <small className="ml-[3px] text-[14px] font-medium leading-none tracking-normal text-ink-2 tight:text-[13px]">{unit}</small>}
      </div>
      <div className="tnum mt-0.5 flex min-w-0 items-center gap-1 whitespace-nowrap text-callout text-ink-2">
        {typeof meta === "string" ? <span className="truncate">{meta}</span> : meta}
      </div>
    </div>
  );
}
