import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Cpu, ExternalLink, X } from "lucide-react";
import type { DriverInfo } from "../../types";
import { api } from "../../lib/api";
import { DottedLeaderRow } from "../ui";
import { cn } from "../../lib/format";
import { toast } from "../feedback/Toast";
import { DriverStatusBadge, SignatureBadge } from "./DriverTable";
import { fmtAge, signatureKind, signatureLabel, vendorPortalFor } from "./driverUtils";

export interface DriverDetailPanelProps {
  driver: DriverInfo | null;
  onClose: () => void;
}

/** Right-hand slide-over with the full metadata of one driver. */
export default function DriverDetailPanel({ driver, onClose }: DriverDetailPanelProps) {
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

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(driver.deviceId);
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
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
            <Cpu size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">{driver.category} · Driver</div>
            <h2 className="mt-0.5 text-[15px] font-semibold leading-snug text-ink">{driver.deviceName || "Unknown device"}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DriverStatusBadge driver={driver} />
              <SignatureBadge driver={driver} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted transition hover:bg-white/5 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="nx-scroll flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <SectionLabel>Driver package</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow label="Provider" value={driver.provider || "—"} />
              <DottedLeaderRow label="Manufacturer" value={driver.manufacturer || "—"} />
              <DottedLeaderRow label="Version" value={driver.version || "—"} valueClassName="font-mono" />
              <DottedLeaderRow
                label="Release date"
                value={driver.date || "—"}
                valueClassName={cn("font-mono", driver.status === "outdated" && "text-rose")}
              />
              <DottedLeaderRow label="Age" value={fmtAge(driver.ageDays)} valueClassName="font-mono" />
              <DottedLeaderRow label="INF file" value={driver.infName || "—"} valueClassName="font-mono" />
            </div>
          </section>

          <section>
            <SectionLabel>Device</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow label="Device class" value={driver.deviceClass || "—"} />
              <DottedLeaderRow label="Category" value={driver.category} />
            </div>
            <div className="mt-3 rounded-lg border border-line bg-canvas-0/70 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10.5px] uppercase tracking-[0.16em] text-muted">Hardware / Device ID</span>
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
              <code className="block break-all font-mono text-[11.5px] leading-relaxed text-cyan">
                {driver.deviceId || "—"}
              </code>
            </div>
          </section>

          <section>
            <SectionLabel>Digital signature</SectionLabel>
            <div className="space-y-1.5">
              <DottedLeaderRow
                label="Status"
                value={signatureLabel(sig)}
                valueClassName={sig === "unsigned" ? "text-gold" : sig === "whql" ? "text-teal" : "text-cyan"}
              />
              <DottedLeaderRow label="Signer" value={driver.signer || "—"} />
            </div>
            {sig === "unsigned" && (
              <p className="mt-2 rounded-md border border-gold/30 bg-gold/[0.06] px-3 py-2 text-[12px] leading-relaxed text-gold/90">
                This driver has no valid digital signature. Prefer a WHQL-certified package from the vendor.
              </p>
            )}
            {driver.status === "outdated" && (
              <p className="mt-2 rounded-md border border-rose/30 bg-rose/[0.06] px-3 py-2 text-[12px] leading-relaxed text-rose/90">
                Released more than 3 years ago. Check the vendor portal for a newer version.
              </p>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={openPortal}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-gold/60 bg-gold/10 px-4 py-2.5 text-[13px] font-semibold text-gold shadow-[0_0_18px_rgba(212,163,89,0.15)] transition hover:bg-gold/20"
          >
            <ExternalLink size={15} />
            Vendor update portal · {portal.vendor}
          </button>
          <div className="mt-2 truncate text-center font-mono text-[10.5px] text-muted" title={portal.url}>
            {portal.url}
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-gold/80">
      <span className="h-px w-3 bg-gold/50" />
      {children}
    </div>
  );
}
