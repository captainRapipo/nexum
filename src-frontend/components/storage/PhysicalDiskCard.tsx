import { useMemo, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, HardDrive, ListTree, Thermometer } from "lucide-react";
import type { AgentStatus, DiskTelemetry, DriveHealth, PhysicalDisk, TelemetryPacket } from "../../types";
import { STATUS_CLASS, StatusPill, Unavailable } from "../ui";
import { driveHealthView, resolveUnavailable } from "../../lib/status";
import { cn, fmtBytes, fmtCount, fmtTemp, maskSerial } from "../../lib/format";
import ThroughputChart, { fmtRate } from "./ThroughputChart";
import { mediaChips, type MediaChip } from "./diskMatch";

const CHIP_STYLE: Record<MediaChip["tone"], string> = {
  teal: "border-teal/40 bg-teal/10 text-teal",
  purple: "border-purple/45 bg-purple/15 text-[#c084fc]",
  cyan: "border-cyan/40 bg-cyan/10 text-cyan",
  silver: "border-white/15 bg-white/5 text-silver",
};

function fmtTb(tb: number | null | undefined): string {
  if (tb == null || !Number.isFinite(tb)) return "—";
  return tb >= 100 ? tb.toFixed(0) : tb.toFixed(1);
}

export interface PhysicalDiskCardProps {
  /** Windows physical disk; null for a sensor-only drive that matched no PhysicalDisk. */
  physical: PhysicalDisk | null;
  telemetry: DiskTelemetry | null;
  /** Classifier result (DiskTelemetry.health, or the unmatched "unknown" health). */
  health: DriveHealth;
  history: TelemetryPacket[];
  tempUnit: "C" | "F";
  agent: AgentStatus | null;
  onDetails?: () => void;
}

/**
 * One physical drive (MF-1). The health chip, its colour and the life bar all come from the sidecar
 * classifier (`DiskTelemetry.health`) through `driveHealthView`; Windows' own status is display-only.
 */
export default function PhysicalDiskCard({
  physical,
  telemetry,
  health,
  history,
  tempUnit,
  agent,
  onDetails,
}: PhysicalDiskCardProps) {
  const name = physical?.model || telemetry?.name || "Unknown drive";
  const chips = mediaChips(physical, telemetry?.name);
  const view = driveHealthView(health);
  const toneCls = STATUS_CLASS[view.tone];
  const life = telemetry?.healthPct ?? null;
  const tempC = telemetry?.tempC ?? null;
  const smartReason = resolveUnavailable(agent, "admin");

  const series = useMemo(() => {
    const ts: number[] = [];
    const read: (number | null)[] = [];
    const write: (number | null)[] = [];
    if (!telemetry) return { ts, read, write };
    for (const p of history) {
      const d = p.disks?.find((x) => x.id === telemetry.id);
      ts.push(p.ts);
      read.push(d?.readMBps ?? null);
      write.push(d?.writeMBps ?? null);
    }
    return { ts, read, write };
  }, [history, telemetry?.id]);

  const readNow = telemetry?.readMBps ?? null;
  const writeNow = telemetry?.writeMBps ?? null;
  const ioKnown = readNow !== null || writeNow !== null;
  const volumes = physical?.volumes ?? [];

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-white/[0.02] p-4 transition hover:border-white/15">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.03] text-silver">
          <HardDrive size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink" title={name}>
            {name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <span
                key={c.label}
                className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider", CHIP_STYLE[c.tone])}
              >
                {c.label}
              </span>
            ))}
            {physical && <span className="font-mono text-[11.5px] text-silver">{fmtBytes(physical.sizeBytes, 0)}</span>}
            {volumes.length > 0 && (
              <span className="font-mono text-[11.5px] text-ink" title="Drive letters on this disk">
                {volumes.join(" ")}
              </span>
            )}
            {physical?.isSystemDisk && (
              <span className="rounded border border-line bg-white/[0.04] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-silver">
                System
              </span>
            )}
            {physical?.serial && (
              <span className="truncate font-mono text-[10.5px] text-muted" title="Serial number (masked)">
                SN {maskSerial(physical.serial)}
              </span>
            )}
          </div>
        </div>
        <StatusPill tone={view.tone} icon={view.icon} title={`${view.label}. ${health.reason}`}>
          {health.state === "unknown" ? "Unknown" : view.label}
        </StatusPill>
      </div>

      {/* Classifier explanation, always visible (not colour alone) */}
      <p className={cn("mt-2.5 text-[11.5px] leading-snug", health.state === "good" ? "text-muted" : toneCls.text)}>
        {health.state === "unknown" ? health.label : health.reason || view.label}
      </p>

      {/* S.M.A.R.T. readouts */}
      <div className="mt-3 grid grid-cols-4 gap-2">
        <Readout
          label="Temp"
          icon={<Thermometer size={11} />}
          value={tempC == null ? <Unavailable compact reason={smartReason} /> : fmtTemp(tempC, tempUnit)}
        />
        <Readout
          label="Life"
          value={life == null ? <Unavailable compact reason={telemetry ? "unsupported" : smartReason} /> : `${Math.round(life)}%`}
          valueClass={life == null ? undefined : toneCls.text}
          title={`Remaining rated life. State: ${view.label}`}
        />
        <Readout
          label="Written"
          value={fmtTb(telemetry?.tbw)}
          unit={telemetry?.tbw != null ? "TB" : undefined}
        />
        <Readout
          label="Power-on"
          value={telemetry?.powerOnHours != null ? fmtCount(telemetry.powerOnHours) : "—"}
          unit={telemetry?.powerOnHours != null ? "h" : undefined}
        />
      </div>

      {life != null && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", toneCls.bg)}
            style={{ width: `${Math.max(0, Math.min(100, life))}%` }}
          />
        </div>
      )}

      {/* Live throughput */}
      <div className="mt-4 rounded-lg border border-line bg-canvas-0/50 px-3 pb-1 pt-2.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="uppercase tracking-[0.16em] text-muted">Live I/O</span>
          {ioKnown && (
            <div className="flex items-center gap-3 font-mono">
              <span className="flex items-center gap-1 text-teal">
                <ArrowDownToLine size={11} />R {readNow == null ? "—" : fmtRate(readNow)}
              </span>
              <span className="flex items-center gap-1 text-cyan">
                <ArrowUpFromLine size={11} />W {writeNow == null ? "—" : fmtRate(writeNow)}
              </span>
            </div>
          )}
        </div>
        {telemetry && ioKnown ? (
          <ThroughputChart ts={series.ts} read={series.read} write={series.write} height={64} />
        ) : (
          <div className="flex h-[64px] items-center justify-center text-[11px] text-muted">
            {telemetry ? <Unavailable reason="unsupported" /> : "No live sensor matched this drive"}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate" title="Windows' own drive status, shown for information. Nexum's health state comes from the drive's S.M.A.R.T. data.">
          Windows reports: {physical?.healthStatus ?? "—"}
        </span>
        <button
          type="button"
          onClick={onDetails}
          disabled={!telemetry || !onDetails}
          title={telemetry ? "Open the S.M.A.R.T. details" : "No S.M.A.R.T. data for this drive"}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-2.5 py-1 text-[11.5px] font-medium text-silver transition hover:border-white/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ListTree size={13} />
          S.M.A.R.T. details
        </button>
      </div>
    </div>
  );
}

function Readout({
  label,
  value,
  unit,
  icon,
  valueClass,
  title,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  icon?: ReactNode;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-canvas-0/40 px-2.5 py-2" title={title}>
      <div className="flex items-center gap-1 text-[9.5px] uppercase tracking-[0.16em] text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cn("truncate font-mono text-[15px] font-semibold", valueClass ?? "text-ink")}>{value}</span>
        {unit && <span className="font-mono text-[10px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}
