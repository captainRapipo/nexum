import { useEffect, useState, type ReactNode } from "react";
import { Cpu, Monitor, ShieldCheck } from "lucide-react";
import type { SystemInfo } from "../../types";
import { DottedLeaderRow, StatusPill } from "../ui";
import { fmtUptime } from "../../lib/format";

/**
 * BIOS / UEFI + Windows details for the Drivers view (Module C).
 * Uptime ticks locally between system-info refreshes.
 */
export default function FirmwareOsPanel({ info }: { info: SystemInfo | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setElapsed(0);
    if (!info) return;
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [info]);

  if (!info) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-white/[0.04]" />
        ))}
      </div>
    );
  }

  const { bios, os, motherboard } = info;
  const tpmOk = info.tpm?.present === true;
  const tpmVer = info.tpm?.version ?? null;
  const tpm2 = tpmOk && (tpmVer ?? "").trim().startsWith("2");

  return (
    <div className="space-y-5">
      <section>
        <Label icon={<Cpu size={12} />}>Firmware</Label>
        <div className="space-y-1.5">
          <DottedLeaderRow label="Mode" value={bios.mode} valueClassName={bios.mode === "UEFI" ? "text-teal" : "text-gold"} />
          <DottedLeaderRow label="Vendor" value={bios.vendor || "—"} />
          <DottedLeaderRow label="Version" value={bios.version || "—"} valueClassName="font-mono" />
          <DottedLeaderRow label="Release date" value={bios.releaseDate || "—"} valueClassName="font-mono" />
          <DottedLeaderRow
            label="Board"
            value={[motherboard.manufacturer, motherboard.product].filter(Boolean).join(" ") || "—"}
          />
        </div>
      </section>

      <section>
        <Label icon={<ShieldCheck size={12} />}>Platform security</Label>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">Secure Boot</span>
            {info.secureBoot === null ? (
              <StatusPill tone="info">Unknown</StatusPill>
            ) : info.secureBoot ? (
              <StatusPill tone="ok">Enabled</StatusPill>
            ) : (
              <StatusPill tone="warn">Disabled</StatusPill>
            )}
          </div>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-muted">TPM</span>
            {info.tpm === null ? (
              <StatusPill tone="info">Unknown</StatusPill>
            ) : !tpmOk ? (
              <StatusPill tone="crit">Not present</StatusPill>
            ) : tpm2 ? (
              <StatusPill tone="ok">{`TPM 2.0${tpmVer && tpmVer !== "2.0" ? ` (${tpmVer})` : ""}`}</StatusPill>
            ) : (
              <StatusPill tone="warn">{tpmVer ? `TPM ${tpmVer}` : "Present"}</StatusPill>
            )}
          </div>
        </div>
      </section>

      <section>
        <Label icon={<Monitor size={12} />}>Operating system</Label>
        <div className="space-y-1.5">
          <DottedLeaderRow label="Edition" value={os.caption || "—"} />
          <DottedLeaderRow label="Release" value={os.displayVersion || "—"} valueClassName="font-mono" />
          <DottedLeaderRow
            label="Build"
            value={os.build ? `${os.build}${os.version ? ` · ${os.version}` : ""}` : os.version || "—"}
            valueClassName="font-mono"
          />
          <DottedLeaderRow label="Architecture" value={os.architecture || "—"} />
          <DottedLeaderRow label="Installed" value={os.installDate || "—"} valueClassName="font-mono" />
          <DottedLeaderRow
            label="Uptime"
            value={fmtUptime(Math.max(0, (info.uptimeSecs || 0) + elapsed))}
            valueClassName="font-mono text-teal"
          />
          <DottedLeaderRow label="Host" value={info.hostname || "—"} valueClassName="font-mono" />
        </div>
      </section>
    </div>
  );
}

function Label({ children, icon }: { children: string; icon: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-gold/80">
      {icon}
      {children}
    </div>
  );
}
