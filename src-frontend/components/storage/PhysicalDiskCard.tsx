import { useMemo, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, HardDrive, Thermometer } from "lucide-react";
import type { DiskTelemetry, PhysicalDisk, TelemetryPacket } from "../../types";
import { StatusPill } from "../ui";
import { cn, fmtBytes, fmtTemp } from "../../lib/format";
import ThroughputChart, { fmtRate } from "./ThroughputChart";
import { mediaChips, type MediaChip } from "./diskMatch";

const CHIP_STYLE: Record<MediaChip["tone"], string> = {
  teal: "border-teal/40 bg-teal/10 text-teal",
  gold: "border-gold/40 bg-gold/10 text-gold",
  purple: "border-purple/45 bg-purple/15 text-[#c084fc]",
  cyan: "border-cyan/40 bg-cyan/10 text-cyan",
  silver: "border-white/15 bg-white/5 text-silver",
};

function healthTone(status: PhysicalDisk["healthStatus"] | undefined, pct: number | null): "ok" | "warn" | "crit" | "info" {
  if (status === "Unhealthy") return "crit";
  if (status === "Warning") return "warn";
  if (pct != null) {
    if (pct < 50) return "crit";
    if (pct < 80) return "warn";
    return "ok";
  }
  if (status === "Healthy") return "ok";
  return "info";
}

function tempTone(c: number | null): string {
  if (c == null) return "text-muted";
  if (c >= 70) return "text-rose";
  if (c >= 55) return "text-gold";
  return "text-ink";
}

function fmtHours(h: number | null): string {
  if (h == null || !Number.isFinite(h)) return "—";
  return Math.round(h).toLocaleString();
}

function fmtTbw(tb: number | null): string {
  if (tb == null || !Number.isFinite(tb)) return "—";
  return tb >= 100 ? tb.toFixed(0) : tb.toFixed(1);
}

export interface PhysicalDiskCardProps {
  physical: PhysicalDisk | null;
  telemetry: DiskTelemetry | null;
  history: TelemetryPacket[];
  tempUnit: "C" | "F";
}

export default function PhysicalDiskCard({ physical, telemetry, history, tempUnit }: PhysicalDiskCardProps) {
  const name = physical?.model || telemetry?.name || "Unknown drive";
  const chips = mediaChips(physical, telemetry?.name);
  const healthPct = telemetry?.healthPct ?? null;
  const tone = healthTone(physical?.healthStatus, healthPct);
  const statusLabel =
    physical?.healthStatus && physical.healthStatus !== "Unknown"
      ? physical.healthStatus
      : healthPct != null
        ? tone === "ok"
          ? "Healthy"
          : tone === "warn"
            ? "Warning"
            : "Degraded"
        : "Unknown";

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
  }, [history, telemetry]);

  const tempC = telemetry?.tempC ?? null;
  const readNow = telemetry?.readMBps ?? null;
  const writeNow = telemetry?.writeMBps ?? null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-white/[0.02] p-4 transition hover:border-white/15">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-teal/25 bg-teal/[0.08] text-teal">
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
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  CHIP_STYLE[c.tone],
                )}
              >
                {c.label}
              </span>
            ))}
            {physical && (
              <span className="font-mono text-[11.5px] text-silver">{fmtBytes(physical.sizeBytes, 0)}</span>
            )}
            {physical?.serial && (
              <span className="truncate font-mono text-[10.5px] text-muted" title={`Serial ${physical.serial}`}>
                SN {physical.serial}
              </span>
            )}
          </div>
        </div>
        <StatusPill tone={tone} pulse={tone === "crit"}>
          {statusLabel}
        </StatusPill>
      </div>

      {/* S.M.A.R.T. readouts */}
      <div className="mt-4 grid grid-cols-4 gap-2">
        <Readout
          label="Temp"
          icon={<Thermometer size={11} />}
          value={tempC == null ? "—" : fmtTemp(tempC, tempUnit)}
          valueClass={tempTone(tempC)}
        />
        <Readout
          label="Health"
          value={healthPct == null ? "—" : `${Math.round(healthPct)}%`}
          valueClass={healthPct == null ? "text-muted" : tone === "crit" ? "text-rose" : tone === "warn" ? "text-gold" : "text-teal"}
        />
        <Readout label="TBW" value={fmtTbw(telemetry?.tbw ?? null)} unit={telemetry?.tbw != null ? "TB" : undefined} />
        <Readout
          label="Power-on"
          value={fmtHours(telemetry?.powerOnHours ?? null)}
          unit={telemetry?.powerOnHours != null ? "h" : undefined}
        />
      </div>

      {healthPct != null && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              tone === "crit" ? "bg-rose" : tone === "warn" ? "bg-gold" : "bg-teal",
            )}
            style={{ width: `${Math.max(0, Math.min(100, healthPct))}%` }}
          />
        </div>
      )}

      {/* Live throughput */}
      <div className="mt-4 rounded-lg border border-line bg-canvas-0/50 px-3 pb-1 pt-2.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="uppercase tracking-[0.16em] text-muted">Live I/O</span>
          <div className="flex items-center gap-3 font-mono">
            <span className="flex items-center gap-1 text-teal">
              <ArrowDownToLine size={11} />
              R {readNow == null ? "—" : fmtRate(readNow)}
            </span>
            <span className="flex items-center gap-1 text-gold">
              <ArrowUpFromLine size={11} />W {writeNow == null ? "—" : fmtRate(writeNow)}
            </span>
          </div>
        </div>
        {telemetry ? (
          <ThroughputChart ts={series.ts} read={series.read} write={series.write} height={64} />
        ) : (
          <div className="flex h-[64px] items-center justify-center text-[11px] text-muted">
            No live sensor matched for this drive
          </div>
        )}
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
}: {
  label: string;
  value: string;
  unit?: string;
  icon?: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-canvas-0/40 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[9.5px] uppercase tracking-[0.16em] text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cn("font-mono text-[15px] font-semibold", valueClass ?? "text-ink")}>{value}</span>
        {unit && <span className="font-mono text-[10px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}
