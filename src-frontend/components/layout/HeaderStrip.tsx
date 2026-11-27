import { useEffect, useState, type ReactNode } from "react";
import { Activity, Clock, Monitor, ScanLine, ShieldAlert, ShieldCheck } from "lucide-react";
import { useDriverScan } from "../../hooks/useDriverScan";
import { useSettings } from "../../hooks/useSettings";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { cn, DASH, fmtDateTime, fmtTemp, fmtUptime, pickPrimaryGpu, shortCpuName, shortGpuName } from "../../lib/format";
import { StatusPill, type StatusTone } from "../ui/StatusPill";

/** Re-render every `intervalMs` with the current epoch ms. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Thermal alert threshold (°C) for CPU package / GPU core. */
export const THERMAL_ALERT_C = 85;

function Segment({ icon, label, children, className, title }: { icon: ReactNode; label: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)} title={title}>
      <span className="text-slate-500">{icon}</span>
      <span className="label-caps [--label-size:9.5px]">{label}</span>
      <span className="num text-[12px] text-slate-200">{children}</span>
    </div>
  );
}

const Divider = () => <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />;

export function HeaderStrip() {
  const { info, infoFetchedAt } = useSystemInfo();
  const { latest, agent } = useTelemetry();
  const { lastScan, loading: scanning } = useDriverScan();
  const { settings } = useSettings();
  const now = useNow(1000);

  const hostname = info?.hostname || DASH;
  const cpu = shortCpuName(info?.cpuName || latest?.cpu.name);
  const gpuFull = pickPrimaryGpu(info?.gpuNames) ?? latest?.gpu?.name ?? null;
  const gpu = gpuFull ? shortGpuName(gpuFull) : DASH;

  // Live uptime: snapshot from get_system_info + time elapsed since it was fetched.
  const uptimeSecs =
    info && infoFetchedAt != null ? info.uptimeSecs + Math.max(0, (now - infoFetchedAt) / 1000) : null;

  const scanStamp = lastScan ?? (info?.lastDriverScan ? new Date(info.lastDriverScan) : null);

  // Overall status
  const cpuT = latest?.cpu.packageTempC ?? null;
  const gpuT = latest?.gpu?.tempC ?? null;
  const thermal = (cpuT != null && cpuT >= THERMAL_ALERT_C) || (gpuT != null && gpuT >= THERMAL_ALERT_C);
  const staleAfter = Math.max(5000, settings.pollIntervalMs * 4);
  const stale = latest != null && now - latest.ts > staleAfter;

  let tone: StatusTone;
  let statusLabel: string;
  let statusTitle: string | undefined;
  if (thermal) {
    tone = "crit";
    statusLabel = "Thermal Alert";
    statusTitle = `CPU ${fmtTemp(cpuT, settings.tempUnit)} · GPU ${fmtTemp(gpuT, settings.tempUnit)} (alert at ${fmtTemp(THERMAL_ALERT_C, settings.tempUnit)})`;
  } else if (agent && !agent.running) {
    tone = "warn";
    statusLabel = "Degraded";
    statusTitle = agent.message || "Hardware agent is not running";
  } else if (stale) {
    tone = "warn";
    statusLabel = "Degraded";
    statusTitle = `No telemetry for ${Math.round((now - (latest?.ts ?? now)) / 1000)} s`;
  } else if (!latest) {
    tone = "info";
    statusLabel = "Connecting";
    statusTitle = agent?.message;
  } else {
    tone = "ok";
    statusLabel = "Synced / Optimal";
    statusTitle = agent?.message;
  }

  const isAdmin = info?.isAdmin ?? agent?.isAdmin ?? null;
  const hz = settings.pollIntervalMs > 0 ? 1000 / settings.pollIntervalMs : 0;

  return (
    <div className="relative z-10 flex h-11 shrink-0 select-none items-center gap-4 border-b border-line bg-black/25 px-5 text-[12px]">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Monitor size={15} strokeWidth={1.9} className="shrink-0 text-teal" aria-hidden="true" />
        <span className="shrink-0 font-semibold uppercase tracking-[0.1em] text-ink">{hostname}</span>
        <span className="shrink-0 text-muted">—</span>
        <span className="min-w-0 truncate text-slate-300" title={[info?.cpuName, gpuFull].filter(Boolean).join(" / ")}>
          {cpu} <span className="text-muted">/</span> <span className="text-gold">{gpu}</span>
        </span>
      </div>

      <StatusPill tone={tone} pulse={tone === "ok" || tone === "crit"} title={statusTitle}>
        {statusLabel}
      </StatusPill>

      <div className="ml-auto flex min-w-0 items-center gap-4">
        <Segment icon={<Clock size={13} aria-hidden="true" />} label="Uptime">
          {fmtUptime(uptimeSecs)}
        </Segment>
        <Divider />
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
          <StatusPill tone="ok" icon={<ShieldCheck size={12} aria-hidden="true" />} title="Running with administrator privileges">
            Admin
          </StatusPill>
        ) : (
          <StatusPill
            tone="warn"
            icon={<ShieldAlert size={12} aria-hidden="true" />}
            title="Not elevated: fan control, Windows Temp / Update cache cleanup and some sensors are unavailable. Restart Nexum as administrator."
          >
            Limited Mode
          </StatusPill>
        )}
      </div>
    </div>
  );
}

export default HeaderStrip;
