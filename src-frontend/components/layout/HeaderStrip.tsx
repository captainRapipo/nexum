import { useId, useState, type ReactNode } from "react";
import { Activity, Monitor, ScanLine, ShieldCheck, ShieldOff } from "lucide-react";
import { useDriverScan } from "../../hooks/useDriverScan";
import { useHealth } from "../../hooks/useHealth";
import { useSettings } from "../../hooks/useSettings";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { cn, DASH, fmtDateTime, pickPrimaryGpu, shortCpuName, shortGpuName } from "../../lib/format";
import { requestNavigate } from "../../lib/nav";
import { alertState, healthLevelTone, healthPillText } from "../../lib/status";
import { StatusPill, STATUS_ICON } from "../ui/StatusPill";
import { renderIcon } from "../ui/icon";
import type { SystemHealth } from "../../types";

/** Kept for existing imports; the hook lives in hooks/useNow.ts. */
export { useNow } from "../../hooks/useNow";

function Segment({ icon, label, children, className, title }: { icon: ReactNode; label: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)} title={title}>
      <span className="text-slate-500">{icon}</span>
      <span className="label-caps [--label-size:9.5px]">{label}</span>
      <span className="num text-[12px] text-slate-200">{children}</span>
    </div>
  );
}

const Divider = ({ className }: { className?: string }) => (
  <span aria-hidden="true" className={cn("h-4 w-px shrink-0 bg-line", className)} />
);

const SEV_TEXT = { crit: "text-rose-400", warn: "text-warn", info: "text-cyan" } as const;

/** Rule-backed status pill (MF-6). Hover / focus shows the active conditions and every rule. */
function HealthPill({ health }: { health: SystemHealth }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const tone = healthLevelTone(health.level);
  const text = healthPillText(health);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        aria-describedby={open ? panelId : undefined}
        aria-label={`System status: ${text}. Open Dashboard health alerts.`}
        onClick={() => requestNavigate("dashboard")}
        className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
      >
        <StatusPill tone={tone} pulse={tone === "crit"}>
          {text}
        </StatusPill>
      </button>
      {open && (
        <div
          id={panelId}
          role="tooltip"
          className="glass-strong absolute left-0 top-[calc(100%+8px)] z-50 w-[440px] max-w-[calc(100vw-32px)] p-3.5 text-[12px] normal-case tracking-normal shadow-2xl animate-fade-in"
        >
          {health.conditions.length > 0 ? (
            <>
              <div className="label-caps mb-1.5">Active</div>
              <ul className="mb-3 space-y-1.5">
                {health.conditions.map((c) => (
                  <li key={c.id} className="flex items-start gap-2">
                    <span className={cn("mt-px shrink-0", SEV_TEXT[c.severity])}>{renderIcon(STATUS_ICON[alertState(c.severity)], 13)}</span>
                    <span className="min-w-0">
                      <span className="text-ink">{c.title}</span>
                      {c.detail && <span className="block text-[11.5px] leading-snug text-slate-400">{c.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mb-3 text-slate-300">No active alerts. Every rule below is satisfied.</p>
          )}
          <div className="label-caps mb-1.5">Rules</div>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-slate-400">
            {health.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function HeaderStrip() {
  const { info } = useSystemInfo();
  const { latest, agent } = useTelemetry();
  const { lastScan, loading: scanning } = useDriverScan();
  const { settings } = useSettings();
  const health = useHealth();

  const hostname = info?.hostname || DASH;
  const cpu = shortCpuName(info?.cpuName || latest?.cpu.name);
  const gpuFull = pickPrimaryGpu(info?.gpuNames) ?? latest?.gpu?.name ?? null;
  const gpu = gpuFull ? shortGpuName(gpuFull) : DASH;

  const scanStamp = lastScan ?? (info?.lastDriverScan ? new Date(info.lastDriverScan) : null);
  const isAdmin = agent?.running ? agent.isAdmin : (info?.isAdmin ?? null);
  const hz = settings.pollIntervalMs > 0 ? 1000 / settings.pollIntervalMs : 0;

  return (
    <div className="relative z-10 flex h-11 shrink-0 select-none items-center gap-4 border-b border-line bg-black/25 px-5 text-[12px]">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Monitor size={15} strokeWidth={1.9} className="shrink-0 text-teal" aria-hidden="true" />
        <span className="shrink-0 font-semibold uppercase tracking-[0.1em] text-ink">{hostname}</span>
        <span className="shrink-0 text-muted">—</span>
        <span className="min-w-0 truncate text-slate-300" title={[info?.cpuName, gpuFull].filter(Boolean).join(" / ")}>
          {cpu} <span className="text-muted">/</span> <span className="text-slate-200">{gpu}</span>
        </span>
      </div>

      <HealthPill health={health} />

      <div className="ml-auto flex min-w-0 items-center gap-4">
        <Segment
          icon={<ScanLine size={13} aria-hidden="true" />}
          label="Driver Scan"
          title={scanStamp ? scanStamp.toLocaleString() : undefined}
        >
          {scanning ? <span className="text-teal">Scanning…</span> : scanStamp ? fmtDateTime(scanStamp) : DASH}
        </Segment>
        <Divider />
        <Segment
          icon={<Activity size={13} aria-hidden="true" />}
          label="Poll"
          className="hidden min-[1440px]:flex"
          title={`Telemetry every ${settings.pollIntervalMs} ms`}
        >
          {hz >= 1 ? `${hz.toFixed(hz % 1 === 0 ? 0 : 1)} Hz` : `${(settings.pollIntervalMs / 1000).toFixed(0)} s`}
        </Segment>
        {isAdmin != null && <Divider />}
        {isAdmin == null ? null : isAdmin ? (
          <StatusPill tone="ok" icon={<ShieldCheck size={12} aria-hidden="true" />} title="Nexum runs with administrator rights.">
            Administrator
          </StatusPill>
        ) : (
          <StatusPill
            tone="unknown"
            icon={<ShieldOff size={12} aria-hidden="true" />}
            title="Nexum runs without administrator rights: some sensors, fan control and some cache cleanup are unavailable."
          >
            Not elevated
          </StatusPill>
        )}
      </div>
    </div>
  );
}

export default HeaderStrip;
