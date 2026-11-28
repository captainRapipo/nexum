import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import type { DriverInfo } from "../../types";
import { api } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button, IconButton, KeyValueRow, StatusIcon, STATUS_CLASS, type StatusTone } from "../ui";
import { toast } from "../feedback/Toast";
import { DriverStatusBadge } from "./DriverTable";
import { fmtAge, NEUTRAL_CODES, problemText, signatureKind, signatureLabel, vendorPortalFor } from "./driverUtils";

export interface DriverDetailPanelProps {
  driver: DriverInfo | null;
  /** All identical devices when the table row is a group ("Processor × 16"). */
  members?: DriverInfo[];
  onClose: () => void;
  className?: string;
}

/**
 * Details of one driver as a docked inspector (CONTRACT §4.10.3, SPEC §19): 380 px on the right,
 * hairline on its left, no scrim; the list beside it stays usable. The INF name and hardware ids live
 * here, not in the table. Esc or × closes it.
 */
export default function DriverDetailPanel({ driver, members, onClose, className }: DriverDetailPanelProps) {
  const [copied, setCopied] = useState(false);
  const open = driver !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Esc in the toolbar filter clears the filter first; a menu or dialog handles its own Esc.
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    setCopied(false);
  }, [driver]);

  if (!driver) return null;

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

  return (
    <aside
      aria-label="Driver details"
      className={cn("flex h-full w-(--inspector-w) shrink-0 animate-fade-in flex-col border-l border-hairline bg-content", className)}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start gap-2 border-b border-divider py-3 pl-5 pr-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-title-2 text-ink">
            {driver.deviceName || "Unknown device"}
            {group && <span className="ml-1.5 font-normal text-ink-3 tnum">× {group.length}</span>}
          </h2>
          <p className="mt-0.5 truncate text-callout text-ink-2">
            {[driver.category, driver.provider].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2 flex h-5 items-center">
            <DriverStatusBadge driver={driver} />
          </div>
        </div>
        <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {driver.status === "problem" && (
          <Note tone="warn">
            Windows reports a problem with this device: {problemText(driver.problemCode)}. Open Device Manager for the troubleshooting steps Windows
            offers.
          </Note>
        )}
        {neutralCode && <Note tone="unknown">{problemText(driver.problemCode)}. This is not a fault.</Note>}

        <Section title="Driver package">
          <KeyValueRow label="Provider" value={driver.provider || "—"} />
          <KeyValueRow label="Manufacturer" value={driver.manufacturer || "—"} />
          <KeyValueRow label="Version" value={driver.version || "—"} />
          <KeyValueRow label="Release date" value={driver.date || "—"} valueClassName="whitespace-nowrap" />
          <KeyValueRow label="Age" value={fmtAge(driver.ageDays)} valueClassName="text-ink-3" />
          <KeyValueRow label="INF file" value={driver.infName || "—"} valueClassName="font-mono text-[11.5px]" />
          <KeyValueRow label="Origin" value={driver.isInbox ? "In-box (ships with Windows)" : "Third-party package"} />
          <p className="mt-2 text-callout text-ink-3">Driver age is information only. An older driver that works is not a problem.</p>
        </Section>

        <Section title="Device">
          <KeyValueRow label="Device class" value={driver.deviceClass || "—"} />
          <KeyValueRow label="Category" value={driver.category} />
          <div className="mt-3 rounded-lg bg-inset p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-caption font-medium text-ink-2">{group ? `Hardware IDs (${group.length})` : "Hardware ID"}</span>
              <Button size="sm" variant="plain" icon={copied ? Check : Copy} onClick={() => void copyId()} disabled={!driver.deviceId}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {group ? (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {group.map((m) => (
                  <li key={m.deviceId} className="break-all font-mono text-mono text-ink">
                    {m.deviceId || "—"}
                  </li>
                ))}
              </ul>
            ) : (
              <code className="block break-all font-mono text-mono text-ink">{driver.deviceId || "—"}</code>
            )}
          </div>
        </Section>

        <Section title="Digital signature">
          <KeyValueRow label="Status" value={signatureLabel(sig)} />
          <KeyValueRow label="Signer" value={driver.signer || "—"} />
          {sig === "unsigned" && (
            <Note tone="warn" className="mt-3">
              This driver has no valid digital signature. Prefer a WHQL-certified package from the device maker.
            </Note>
          )}
        </Section>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-divider bg-toolbar px-5 py-3">
        <Button icon={ExternalLink} onClick={() => void openPortal()} className="w-full" title={portal.url}>
          Open {portal.vendor} support page
        </Button>
        <div className="mt-2 truncate text-center font-mono text-[10.5px] leading-4 text-ink-3" title={portal.url}>
          {portal.url}
        </div>
        <p className="mt-1 text-center text-callout text-ink-2">Nexum never installs drivers.</p>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="shrink-0">
      <h3 className="mb-1 text-headline text-ink">{title}</h3>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** In-panel note: tint, icon and text from the status tokens (never colour alone). */
function Note({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  const c = STATUS_CLASS[tone];
  return (
    <p className={cn("flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-callout text-ink", c.soft, c.border, className)}>
      <StatusIcon tone={tone} size={15} className="mt-px" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
