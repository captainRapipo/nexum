import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HardDrive, X } from "lucide-react";
import type { DiskTelemetry, DriveHealth, PhysicalDisk } from "../../types";
import { DottedLeaderRow, StatCells, StatusPill } from "../ui";
import { driveHealthView } from "../../lib/status";
import { driveDisplayName } from "../../lib/disks";
import { fmtCount, fmtTemp } from "../../lib/format";
import WearHistory from "./WearHistory";

export interface SmartDrawerProps {
  tele: DiskTelemetry | null;
  disk: PhysicalDisk | null;
  health: DriveHealth;
  tempUnit: "C" | "F";
  onClose: () => void;
}

const SOURCE_TEXT: Record<DriveHealth["source"], string> = {
  nvme: "NVMe health log",
  smart: "ATA S.M.A.R.T. attributes",
  none: "No S.M.A.R.T. data",
};

const NOT_REPORTED = <span className="text-muted">Not reported</span>;

function num(n: number | null | undefined, unit = ""): ReactNode {
  if (n == null || !Number.isFinite(n)) return NOT_REPORTED;
  return `${fmtCount(n)}${unit}`;
}

function tb(n: number | null | undefined): ReactNode {
  if (n == null || !Number.isFinite(n)) return NOT_REPORTED;
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} TB`;
}

function minutes(n: number | null | undefined): ReactNode {
  if (n == null || !Number.isFinite(n)) return NOT_REPORTED;
  if (n >= 120) return `${fmtCount(Math.round(n / 60))} h ${Math.round(n % 60)} min`;
  return `${fmtCount(n)} min`;
}

/** Sector counters are only meaningful above zero; zero is shown plainly. */
function sectors(n: number | null | undefined): ReactNode {
  if (n == null || !Number.isFinite(n)) return NOT_REPORTED;
  return fmtCount(n);
}

/** Per-drive S.M.A.R.T. details drawer (ROADMAP §3 "S.M.A.R.T. details drawer", CONTRACT §4.10 Storage). */
export default function SmartDrawer({ tele, disk, health, tempUnit, onClose }: SmartDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const view = driveHealthView(health);
  const name = driveDisplayName(disk, tele);
  const spare =
    tele?.availableSparePct != null
      ? `${fmtCount(tele.availableSparePct)}%${tele.availableSpareThresholdPct != null ? ` (threshold ${fmtCount(tele.availableSpareThresholdPct)}%)` : ""}`
      : null;
  const hasAta =
    tele != null && (tele.reallocatedSectors != null || tele.pendingSectors != null || tele.uncorrectableSectors != null);
  const thresholdC = (c: number | null | undefined): ReactNode => (c == null ? NOT_REPORTED : fmtTemp(c, tempUnit));

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={`S.M.A.R.T. details for ${name}`}>
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[2px]"
      />
      <aside className="nx-drawer-in relative flex h-full w-[460px] max-w-[92vw] flex-col border-l border-line bg-[rgba(9,16,19,0.94)] shadow-[-24px_0_60px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        <style>{`@keyframes nx-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}.nx-drawer-in{animation:nx-drawer-in 200ms ease-out}@media (prefers-reduced-motion: reduce){.nx-drawer-in{animation:none}}`}</style>

        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.04] text-silver">
            <HardDrive size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">S.M.A.R.T. details</div>
            <h2 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill tone={view.tone} icon={view.icon} title={health.reason}>
                {health.state === "unknown" ? "Unknown" : view.label}
              </StatusPill>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-md p-1.5 text-muted transition hover:bg-white/5 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="nx-scroll flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <SectionLabel>Health</SectionLabel>
            <p className="mb-2 text-[12px] leading-relaxed text-silver">{health.state === "unknown" ? health.label : health.reason}</p>
            {health.state === "unknown" && health.reason && (
              <p className="mb-2 text-[11.5px] leading-relaxed text-muted">{health.reason}</p>
            )}
            <div className="space-y-0.5">
              <DottedLeaderRow label="Data source" value={SOURCE_TEXT[health.source]} />
              <DottedLeaderRow label="Windows reports" value={disk?.healthStatus ?? NOT_REPORTED} />
              <DottedLeaderRow
                label="NVMe critical warning"
                value={tele?.criticalWarning == null ? NOT_REPORTED : tele.criticalWarning === 0 ? "None" : `0x${tele.criticalWarning.toString(16).toUpperCase().padStart(2, "0")}`}
                valueClassName="font-mono"
              />
            </div>
          </section>

          <section>
            <SectionLabel>Wear</SectionLabel>
            <div className="space-y-0.5">
              <DottedLeaderRow label="Life left" value={num(tele?.healthPct, "%")} valueClassName="font-mono" />
              <DottedLeaderRow label="Rated endurance used" value={num(tele?.percentageUsed, "%")} valueClassName="font-mono" />
              <DottedLeaderRow label="Available spare" value={spare ?? NOT_REPORTED} valueClassName="font-mono" />
              <DottedLeaderRow label="Data written" value={tb(tele?.tbw)} valueClassName="font-mono" />
              <DottedLeaderRow label="Data read" value={tb(tele?.dataReadTb)} valueClassName="font-mono" />
            </div>
          </section>

          {tele?.serial && tele.serial.trim() && (
            <section>
              <SectionLabel>Wear history</SectionLabel>
              <WearHistory serial={tele.serial} />
            </section>
          )}

          <section>
            <SectionLabel>Errors and events</SectionLabel>
            <div className="space-y-0.5">
              <DottedLeaderRow label="Media errors" value={num(tele?.mediaErrors)} valueClassName="font-mono" />
              <DottedLeaderRow label="Error-log entries" value={num(tele?.errorLogEntries)} valueClassName="font-mono" />
              <DottedLeaderRow label="Unsafe shutdowns" value={num(tele?.unsafeShutdowns)} valueClassName="font-mono" />
              <DottedLeaderRow label="Power cycles" value={num(tele?.powerCycles)} valueClassName="font-mono" />
              <DottedLeaderRow label="Power-on hours" value={num(tele?.powerOnHours, " h")} valueClassName="font-mono" />
            </div>
          </section>

          {(hasAta || health.source === "smart") && (
            <section>
              <SectionLabel>Sectors (ATA)</SectionLabel>
              <div className="space-y-0.5">
                <DottedLeaderRow label="Reallocated (05)" value={sectors(tele?.reallocatedSectors)} valueClassName="font-mono" />
                <DottedLeaderRow label="Pending (C5)" value={sectors(tele?.pendingSectors)} valueClassName="font-mono" />
                <DottedLeaderRow label="Uncorrectable (C6)" value={sectors(tele?.uncorrectableSectors)} valueClassName="font-mono" />
              </div>
            </section>
          )}

          <section>
            <SectionLabel>Temperature</SectionLabel>
            <div className="grid grid-cols-4 gap-x-3 rounded-lg border border-line bg-canvas-0/60 px-3 py-2 font-mono text-[13px]">
              {["Now", "Min", "Max", "Avg"].map((h) => (
                <span key={h} className="text-right text-[9.5px] uppercase tracking-[0.16em] text-muted">
                  {h}
                </span>
              ))}
              <StatCells
                value={tele?.tempC ?? null}
                min={tele?.tempMinC ?? null}
                max={tele?.tempMaxC ?? null}
                avg={null}
                meta={{ unit: "°C", decimals: 0, kind: "temperature" }}
                tempUnit={tempUnit}
              />
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted">Min and max since the hardware agent started. Average is in the Sensors view.</p>
            <div className="mt-2 space-y-0.5">
              <DottedLeaderRow label="Warning threshold" value={thresholdC(tele?.warningTempC)} valueClassName="font-mono" />
              <DottedLeaderRow label="Critical threshold" value={thresholdC(tele?.criticalTempC)} valueClassName="font-mono" />
              <DottedLeaderRow label="Time above warning" value={minutes(tele?.warningTempMinutes)} valueClassName="font-mono" />
              <DottedLeaderRow label="Time above critical" value={minutes(tele?.criticalTempMinutes)} valueClassName="font-mono" />
            </div>
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-silver">
      <span className="h-px w-3 bg-white/25" />
      {children}
    </div>
  );
}
