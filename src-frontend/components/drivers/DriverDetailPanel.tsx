import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Cpu, ExternalLink, X } from "lucide-react";
import type { DriverInfo } from "../../types";
import { api } from "../../lib/api";
import { DottedLeaderRow } from "../ui";
import { toast } from "../feedback/Toast";
import { DriverStatusBadge, SignatureBadge } from "./DriverTable";
import { fmtAge, NEUTRAL_CODES, problemText, signatureKind, signatureLabel, vendorPortalFor } from "./driverUtils";

export interface DriverDetailPanelProps {
  driver: DriverInfo | null;
  /** All identical devices when the table row is a group ("Processor × 16"). */
  members?: DriverInfo[];
  onClose: () => void;
}

/** Right-hand slide-over with the full metadata of one driver (INF lives here, not in the table). */
export default function DriverDetailPanel({ driver, members, onClose }: DriverDetailPanelProps) {
  const [copied, setCopied] = useState(false);
  const open = driver !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    setCopied(false);
  }, [driver]);

  if (!driver || typeof document === "undefined") return null;

  const portal = vendorPortalFor(driver);
  const sig = signatureKind(driver);
  const group = members && members.length > 1 ? members : null;
  const neutralCode = driver.problemCode != null && NEUTRAL_CODES.has(driver.problemCode);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(group ? group.map((m) => m.deviceId).join("\n") : driver.deviceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Clipboard is not available", "warn");
    }
  };

  const openPortal = async () => {
    try {
      await api.openExternal(portal.url);
    } catch (e) {
      toast(`Could not open browser: ${String(e)}`, "crit");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Driver details">
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[2px]"
      />
      <aside className="nx-drawer-in relative flex h-full w-[460px] max-w-[92vw] flex-col border-l border-line bg-[rgba(9,16,19,0.94)] shadow-[-24px_0_60px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        <style>{`@keyframes nx-drawer-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}.nx-drawer-in{animation:nx-drawer-in 200ms ease-out}@media (prefers-reduced-motion: reduce){.nx-drawer-in{animation:none}}`}</style>

        {/* Header */}
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.04] text-silver">
            <Cpu size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">{driver.category} · Driver</div>
            <h2 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">
              {driver.deviceName || "Unknown device"}
              {group && <span className="ml-1.5 font-mono text-[13px] font-normal text-silver">× {group.length}</span>}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DriverStatusBadge driver={driver} />
              <SignatureBadge driver={driver} />
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

        {/* Body */}
        <div className="nx-scroll flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {driver.status === "problem" && (
            <p className="rounded-md border border-crit/40 bg-crit/[0.07] px-3 py-2 text-[12px] leading-relaxed text-rose-300">
              Windows reports a problem with this device: {problemText(driver.problemCode)}. Open Device Manager for
              Windows' own troubleshooting steps.
            </p>
          )}
          {neutralCode && (
            <p className="rounded-md border border-line bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed text-silver">
              {problemText(driver.problemCode)}. This is not a fault.
            </p>
          )}

          <section>
            <SectionLabel>Driver package</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow label="Provider" value={driver.provider || "—"} />
              <DottedLeaderRow label="Manufacturer" value={driver.manufacturer || "—"} />
              <DottedLeaderRow label="Version" value={driver.version || "—"} valueClassName="font-mono" />
              <DottedLeaderRow label="Release date" value={driver.date || "—"} valueClassName="font-mono whitespace-nowrap" />
              <DottedLeaderRow label="Age" value={fmtAge(driver.ageDays)} valueClassName="font-mono text-slate-400" />
              <DottedLeaderRow label="INF file" value={driver.infName || "—"} valueClassName="font-mono" />
              <DottedLeaderRow
                label="Origin"
                value={driver.isInbox ? "In-box (ships with Windows)" : "Third-party package"}
              />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Driver age is information only. An older driver that works is not a problem.
            </p>
          </section>

          <section>
            <SectionLabel>Device</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow label="Device class" value={driver.deviceClass || "—"} />
              <DottedLeaderRow label="Category" value={driver.category} />
            </div>
            <div className="mt-3 rounded-lg border border-line bg-canvas-0/70 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10.5px] uppercase tracking-[0.16em] text-muted">
                  {group ? `Device IDs (${group.length})` : "Hardware / Device ID"}
                </span>
                <button
                  type="button"
                  onClick={copyId}
                  disabled={!driver.deviceId}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-silver transition hover:bg-white/5 hover:text-ink disabled:opacity-40"
                >
                  {copied ? <Check size={12} className="text-teal" /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {group ? (
                <ul className="nx-scroll max-h-40 space-y-1 overflow-y-auto">
                  {group.map((m) => (
                    <li key={m.deviceId} className="break-all font-mono text-[11px] leading-relaxed text-cyan">
                      {m.deviceId || "—"}
                    </li>
                  ))}
                </ul>
              ) : (
                <code className="block break-all font-mono text-[11.5px] leading-relaxed text-cyan">{driver.deviceId || "—"}</code>
              )}
            </div>
          </section>

          <section>
            <SectionLabel>Digital signature</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow label="Status" value={signatureLabel(sig)} valueClassName={sig === "unsigned" ? "text-warn" : "text-silver"} />
              <DottedLeaderRow label="Signer" value={driver.signer || "—"} />
            </div>
            {sig === "unsigned" && (
              <p className="mt-2 rounded-md border border-warn/35 bg-warn/[0.06] px-3 py-2 text-[12px] leading-relaxed text-warn">
                This driver has no valid digital signature. Prefer a WHQL-certified package from the device maker.
              </p>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={openPortal}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2.5 text-[13px] font-semibold text-ink transition hover:bg-white/[0.08]"
          >
            <ExternalLink size={15} />
            Open {portal.vendor} support page
          </button>
          <div className="mt-2 truncate text-center font-mono text-[10.5px] text-muted" title={portal.url}>
            {portal.url}
          </div>
          <p className="mt-2 text-center text-[11px] text-muted">Nexum never installs drivers.</p>
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
