import { useMemo, type ReactNode } from "react";
import { ArrowRight, Cable, Cpu, HardDrive, Monitor, RefreshCw, ShieldCheck, Volume2, Wifi } from "lucide-react";
import { StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useDriverScan } from "../../hooks/useDriverScan";
import { cn } from "../../lib/format";
import type { DriverInfo } from "../../types";

/** Fires the app-level navigation DOM event (App listens for `nexum:navigate`). */
function navigateTo(view: string) {
  window.dispatchEvent(new CustomEvent("nexum:navigate", { detail: view }));
}

const MS_VENDOR = /microsoft/i;

function text(d: DriverInfo): string {
  return `${d.deviceName} ${d.manufacturer} ${d.provider}`.toLowerCase();
}

function isMsGeneric(d: DriverInfo): boolean {
  return MS_VENDOR.test(d.provider || "") && MS_VENDOR.test(d.manufacturer || "");
}

/** Newer driver date wins ties; empty dates sort last. */
function dateScore(d: DriverInfo): number {
  const t = d.date ? Date.parse(d.date) : NaN;
  return Number.isFinite(t) ? t : 0;
}

interface Slot {
  key: string;
  label: string;
  icon: ReactNode;
  /** Returns a score for candidate drivers, or null when the driver is not a match for this slot. */
  score: (d: DriverInfo) => number | null;
}

const VIRTUAL = /virtual|wan miniport|hyper-v|vpn|tap-|tap adapter|wireguard|loopback|kernel debug|teredo|isatap|6to4|ras async|bluetooth|vmware|virtualbox|npcap|zerotier|tailscale/i;

const SLOTS: Slot[] = [
  {
    key: "display",
    label: "Display",
    icon: <Monitor size={13} />,
    score: (d) => {
      if (d.category !== "Display") return null;
      const t = text(d);
      if (/basic display|basic render|remote display|indirect display|virtual|parsec|spacedesk|meta|oculus/i.test(t)) return 0;
      let s = 10;
      if (/nvidia|geforce|rtx|gtx|quadro/.test(t)) s += 30;
      else if (/amd|radeon|ati /.test(t)) s += 28;
      else if (/intel|arc|iris|uhd/.test(t)) s += 15;
      return s;
    },
  },
  {
    key: "chipset",
    label: "Chipset",
    icon: <Cpu size={13} />,
    score: (d) => {
      if (d.category !== "Chipset") return null;
      const t = text(d);
      let s = 5;
      if (!isMsGeneric(d)) s += 20;
      if (/chipset|smbus|psp|platform security|management engine|\bmei\b|gpio|serial io|pci express root|host bridge|lpc controller|i2c/.test(t)) s += 10;
      if (/amd|intel/.test(t)) s += 5;
      return s;
    },
  },
  {
    key: "audio",
    label: "Audio",
    icon: <Volume2 size={13} />,
    score: (d) => {
      if (d.category !== "Audio") return null;
      const t = text(d);
      if (/virtual|steam streaming|voicemeeter|vb-audio|nahimic mirroring|oculus|meta/.test(t)) return 0;
      let s = 5;
      if (/realtek|creative|sound blaster|conexant|cirrus|via |idt|tempo|focusrite|usb audio/.test(t)) s += 30;
      // HDMI/DP audio from the GPU is valid but less interesting than the onboard codec.
      if (/nvidia|hdmi|display audio|amd high definition|intel\(r\) display/.test(t)) s += 8;
      if (/high definition audio/.test(t)) s += 4;
      if (!isMsGeneric(d)) s += 6;
      return s;
    },
  },
  {
    key: "lan",
    label: "LAN",
    icon: <Cable size={13} />,
    score: (d) => {
      if (d.category !== "Network") return null;
      const t = text(d);
      if (VIRTUAL.test(t) || /wi-?fi|wireless|802\.11|wlan/.test(t)) return null;
      if (!/ethernet|gbe|gigabit|lan|family controller|2\.5g|10g|killer e|i2\d\d|aquantia|marvell|realtek pcie/.test(t)) return null;
      let s = 10;
      if (!isMsGeneric(d)) s += 10;
      return s;
    },
  },
  {
    key: "wifi",
    label: "Wi-Fi",
    icon: <Wifi size={13} />,
    score: (d) => {
      if (d.category !== "Network") return null;
      const t = text(d);
      if (VIRTUAL.test(t) && !/wi-?fi direct/.test(t)) return null;
      if (/wi-?fi direct/.test(t)) return null;
      if (!/wi-?fi|wireless|802\.11|wlan|\bax\d{3}|\bbe\d{3}|killer.*(ax|1\d{3})|centrino/.test(t)) return null;
      let s = 10;
      if (!isMsGeneric(d)) s += 10;
      return s;
    },
  },
  {
    key: "storage",
    label: "NVMe / Storage",
    icon: <HardDrive size={13} />,
    score: (d) => {
      if (d.category !== "Storage") return null;
      const t = text(d);
      if (/virtual|storage spaces|microsoft storage spaces|volume manager|iscsi|usb attached scsi|mass storage/.test(t)) return 0;
      let s = 5;
      if (/nvme|nvm express/.test(t)) s += 30;
      else if (/raid|rst|rapid storage|vmd/.test(t)) s += 22;
      else if (/sata|ahci/.test(t)) s += 15;
      if (!isMsGeneric(d)) s += 6;
      return s;
    },
  },
];

interface Picked {
  slot: Slot;
  driver: DriverInfo | null;
}

function pickDrivers(drivers: DriverInfo[]): Picked[] {
  return SLOTS.map((slot) => {
    let best: DriverInfo | null = null;
    let bestScore = -1;
    for (const d of drivers) {
      const s = slot.score(d);
      if (s === null) continue;
      if (s > bestScore || (s === bestScore && best && dateScore(d) > dateScore(best))) {
        best = d;
        bestScore = s;
      }
    }
    return { slot, driver: best };
  });
}

function statusChip(d: DriverInfo): { tone: "ok" | "warn" | "crit"; label: string } {
  switch (d.status) {
    case "outdated":
      return { tone: "crit", label: "Outdated" };
    case "unsigned":
      return { tone: "warn", label: "Unsigned" };
    default:
      return { tone: "ok", label: "OK" };
  }
}

function ageLabel(days: number | null): string {
  if (days === null || !Number.isFinite(days) || days < 0) return "";
  if (days >= 365) return `${(days / 365).toFixed(1)}y`;
  if (days >= 60) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days)}d`;
}

function compactDeviceName(s: string): string {
  return (s || "Unknown device")
    .replace(/\((r|tm)\)/gi, "")
    .replace(/[®™]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default function DriverStatusList() {
  const { drivers, loading, error, lastScan, rescan } = useDriverScan();
  const list = drivers ?? [];

  const picked = useMemo(() => pickDrivers(list), [list]);
  const totals = useMemo(() => {
    let outdated = 0;
    let unsigned = 0;
    for (const d of list) {
      if (d.status === "outdated") outdated++;
      else if (d.status === "unsigned") unsigned++;
    }
    return { outdated, unsigned, total: list.length };
  }, [list]);

  const hasData = list.length > 0;
  const scanDate = lastScan ? new Date(lastScan) : null;
  const scanLabel =
    scanDate && Number.isFinite(scanDate.getTime())
      ? `Scanned ${scanDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Not scanned";

  const headerPill = !hasData ? null : totals.outdated > 0 ? (
    <StatusPill tone="crit" pulse>
      {totals.outdated} Outdated
    </StatusPill>
  ) : totals.unsigned > 0 ? (
    <StatusPill tone="warn">{totals.unsigned} Unsigned</StatusPill>
  ) : (
    <StatusPill tone="ok">All Current</StatusPill>
  );

  return (
    <GlassCard
      title="Driver & System Status"
      icon={<ShieldCheck size={14} />}
      accent={totals.outdated > 0 ? "rose" : "teal"}
      actions={headerPill}
    >
      {!hasData && loading ? (
        <ul className="flex flex-col gap-1.5" aria-busy="true">
          {SLOTS.map((s) => (
            <li key={s.key} className="h-[38px] animate-pulse rounded-lg bg-white/[0.03]" />
          ))}
        </ul>
      ) : !hasData && error ? (
        <div className="flex flex-col items-center gap-2 py-3 text-center">
          <span className="text-[11px] text-rose">Driver scan failed</span>
          <span className="line-clamp-2 text-[10.5px] text-muted" title={String(error)}>
            {String(error)}
          </span>
          <button
            type="button"
            onClick={() => rescan()}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-teal/40 hover:text-teal"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      ) : !hasData ? (
        <div className="py-3 text-center text-[11px] text-muted">No driver data yet — press F5 to scan.</div>
      ) : (
        <ul className="nexum-scroll -mx-1 flex max-h-[280px] flex-col gap-0.5 overflow-y-auto pr-1">
          {picked.map(({ slot, driver }) => {
            if (!driver) {
              return (
                <li key={slot.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 opacity-60">
                  <span className="shrink-0 text-muted">{slot.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[9.5px] uppercase tracking-[0.2em] text-muted">{slot.label}</div>
                    <div className="truncate text-[11.5px] text-muted">Not detected</div>
                  </div>
                </li>
              );
            }
            const chip = statusChip(driver);
            const outdated = driver.status === "outdated";
            const age = ageLabel(driver.ageDays);
            const name = compactDeviceName(driver.deviceName);
            return (
              <li
                key={slot.key}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border px-2 py-1.5 transition-colors",
                  outdated ? "border-rose/25 bg-rose/[0.05]" : "border-transparent hover:bg-white/[0.03]",
                )}
                title={`${driver.deviceName}\n${driver.provider} · ${driver.version}${driver.date ? ` · ${driver.date}` : ""}\n${driver.infName}`}
              >
                <span className={cn("shrink-0", outdated ? "text-rose" : "text-teal")}>{slot.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[9.5px] uppercase tracking-[0.2em] text-muted">{slot.label}</span>
                    {age && (
                      <span className={cn("font-mono text-[9.5px]", outdated ? "text-rose/80" : "text-muted")}>
                        {age}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11.5px] text-ink">{name}</div>
                  <div className="truncate font-mono text-[10.5px] text-silver/80">{driver.version || "—"}</div>
                </div>
                <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2">
        <span className="font-mono text-[10px] text-muted">
          {loading ? "Scanning…" : scanLabel}
          {hasData ? ` · ${totals.total} drivers` : ""}
        </span>
        <button
          type="button"
          onClick={() => navigateTo("drivers")}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-gold transition-colors hover:text-ink"
        >
          View all
          <ArrowRight size={11} className="transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </GlassCard>
  );
}
