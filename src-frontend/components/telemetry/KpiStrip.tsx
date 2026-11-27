import { useMemo, type ReactNode } from "react";
import { SERIES_HEX, Unavailable, UNAVAILABLE_TEXT } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { resolveUnavailable } from "../../lib/status";
import { clamp, cn, fmtGhz, fmtTemp } from "../../lib/format";
import type { AgentStatus, FanPreset, TelemetryPacket } from "../../types";
import { finite, isZeroRpmIdle, pickCpuFan } from "./sensorHelpers";

/** Short sub-label for the CPU fan tile at 1280–1439 px (the tooltip keeps the full cause). */
const FAN_REASON_SHORT: Record<ReturnType<typeof resolveUnavailable>, string> = {
  notElevated: "Needs admin",
  pawnIoMissing: "Needs PawnIO",
  pawnIoOutdated: "Update PawnIO",
  unsupported: "Not reported",
  agentOffline: "Agent offline",
};

interface Kpi {
  key: string;
  label: string;
  /** Series colour (decoration only, never state). */
  color: string;
  value: ReactNode;
  unit: string | null;
  /** Sub-label at ≥ 1440 px. */
  sub: ReactNode;
  /** Shorter sub-label at 1280–1439 px (MF-10). */
  subShort?: ReactNode;
  /** Hover text for the sub-label. */
  subTitle?: string;
  /** 0-100 fill for the thin baseline meter; null hides it. */
  meter: number | null;
  /** Small neutral badge on the value row (e.g. "Zero-RPM idle"). */
  badge?: ReactNode;
}

const PRESET_LABEL: Record<FanPreset, string> = {
  auto: "BIOS auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

/** Bar scale floor so a quiet 600 RPM fan doesn't look pegged. */
const RPM_SCALE_FLOOR = 2000;

function Dash() {
  return <span className="text-muted">—</span>;
}

function buildKpis(
  latest: TelemetryPacket | null,
  agent: AgentStatus | null,
  tempUnit: "C" | "F",
  labelOf: (id: string, defaultName: string) => string,
): Kpi[] {
  const cpu = latest?.cpu ?? null;
  const gpu = latest?.gpu ?? null;
  const ram = latest?.ram ?? null;

  /* ---- CPU ---- */
  const cpuLoad = cpu?.loadTotal;
  const cpuClock = cpu?.clockMhz;
  const coresText = cpu && cpu.cores > 0 ? `${cpu.cores}C/${cpu.threads}T` : null;
  const clockNode: ReactNode = finite(cpuClock) ? (
    <span>{fmtGhz(cpuClock)} eff.</span>
  ) : latest ? (
    <Unavailable reason={resolveUnavailable(agent, "pawnio")} compact />
  ) : (
    <Dash />
  );
  const cpuKpi: Kpi = {
    key: "cpu",
    label: "CPU load",
    color: SERIES_HEX.cpu,
    value: finite(cpuLoad) ? cpuLoad.toFixed(0) : latest ? <Unavailable reason={resolveUnavailable(agent, "none")} compact /> : "—",
    unit: finite(cpuLoad) ? "%" : null,
    sub: (
      <>
        {clockNode}
        {coresText ? <span> · {coresText}</span> : null}
      </>
    ),
    subShort: finite(cpuClock) ? <span>{fmtGhz(cpuClock, 1)} eff.</span> : clockNode,
    subTitle: finite(cpuClock)
      ? "Average effective clock across all cores (LHM \"Cores (Average Effective)\")"
      : "CPU clock is not available",
    meter: finite(cpuLoad) ? cpuLoad : null,
  };

  /* ---- GPU ---- */
  const gpuLoad = gpu?.load;
  const edge = gpu?.tempC;
  const zeroRpm = isZeroRpmIdle(gpu);
  const badge = zeroRpm ? (
    <span
      className="whitespace-nowrap rounded border border-line bg-white/[0.04] px-1 py-px font-sans text-[9px] font-semibold uppercase tracking-wider text-silver"
      title="Zero-RPM idle: the GPU fan is stopped because the card is cool enough"
    >
      <span className="max-[1439px]:hidden">Zero-RPM idle</span>
      <span className="hidden max-[1439px]:inline">Zero-RPM</span>
    </span>
  ) : null;
  const gpuKpi: Kpi = {
    key: "gpu",
    label: "GPU load",
    color: SERIES_HEX.gpu,
    value: finite(gpuLoad) ? gpuLoad.toFixed(0) : gpu ? <Unavailable reason={resolveUnavailable(agent, "none")} compact /> : "—",
    unit: finite(gpuLoad) ? "%" : null,
    sub: gpu ? (
      <span>Edge temp {finite(edge) ? fmtTemp(edge, tempUnit) : "—"}</span>
    ) : latest ? (
      <span>No GPU sensor</span>
    ) : (
      <Dash />
    ),
    subShort: gpu ? <span>Edge {finite(edge) ? fmtTemp(edge, tempUnit) : "—"}</span> : undefined,
    badge,
    subTitle: "Edge temperature (LHM \"GPU Core\"). The hot spot reading is on the Sensors and Cooling pages.",
    meter: finite(gpuLoad) ? gpuLoad : null,
  };

  /* ---- VRAM ---- */
  const vramUsed = gpu?.vramUsedGb;
  const vramTotal = gpu?.vramTotalGb;
  const vramKpi: Kpi = {
    key: "vram",
    label: "VRAM used",
    color: SERIES_HEX.vram,
    value: finite(vramUsed) ? vramUsed.toFixed(1) : gpu ? <Unavailable reason={resolveUnavailable(agent, "none")} compact /> : "—",
    unit: finite(vramUsed) ? "GB" : null,
    sub: finite(vramTotal) ? `of ${vramTotal.toFixed(vramTotal >= 100 ? 0 : 1)} GB` : <Dash />,
    meter: finite(vramUsed) && finite(vramTotal) && vramTotal > 0 ? (vramUsed / vramTotal) * 100 : null,
  };

  /* ---- RAM ---- */
  const ramUsed = ram?.usedGb;
  const ramTotal = ram?.totalGb;
  const ramSub = [
    finite(ramTotal) ? `of ${ramTotal.toFixed(0)} GB` : null,
    finite(ram?.speedMts) ? `${ram!.speedMts} MT/s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const ramKpi: Kpi = {
    key: "ram",
    label: "RAM used",
    color: SERIES_HEX.ram,
    value: finite(ramUsed) ? ramUsed.toFixed(1) : "—",
    unit: finite(ramUsed) ? "GB" : null,
    sub: ramSub || <Dash />,
    subShort: finite(ramTotal) ? `of ${ramTotal.toFixed(0)} GB` : undefined,
    subTitle: ramSub || undefined,
    meter: finite(ram?.loadPct) ? ram!.loadPct : null,
  };

  /* ---- CPU fan (never averaged, never substituted) ---- */
  const fan = latest ? pickCpuFan(latest.fans) : null;
  const fanReason = resolveUnavailable(agent, "pawnio");
  const rpm = fan && finite(fan.rpm) ? fan.rpm : null;
  const preset = latest?.fanPreset ? PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset : null;
  const held = !!latest?.fanSafety?.overrideActive;
  const fanName = fan ? labelOf(fan.id, fan.name) : null;
  const fanSubText = held
    ? "Held at 100% for safety"
    : [preset ? `Preset: ${preset}` : null, fanName && fanName !== fan?.name ? fanName : null].filter(Boolean).join(" · ");
  const fanKpi: Kpi = {
    key: "fan",
    label: "CPU fan",
    color: "#22D3EE",
    value: rpm !== null ? Math.round(rpm).toLocaleString("en-US") : latest && !fan ? <Unavailable reason={fanReason} compact /> : "—",
    unit: rpm !== null ? "RPM" : null,
    sub: !latest ? (
      <Dash />
    ) : fan ? (
      fanSubText || <Dash />
    ) : (
      <span className="font-sans">{UNAVAILABLE_TEXT[fanReason]}</span>
    ),
    // The 1280 px tile cannot fit "Needs administrator"; the full cause stays in the tooltip.
    subShort: fan && preset && !held ? preset : latest && !fan ? <span className="font-sans">{FAN_REASON_SHORT[fanReason]}</span> : undefined,
    subTitle: fan
      ? `${fanName ?? fan.name} · ${fan.hardware}. Shows the CPU fan header only, never an average or another fan.`
      : `${latest ? `${UNAVAILABLE_TEXT[fanReason]}. ` : ""}Shows the motherboard's CPU fan header only, never another fan.`,
    meter: rpm !== null ? clamp((rpm / Math.max(RPM_SCALE_FLOOR, fan?.rpmMax ?? 0)) * 100, 0, 100) : null,
  };

  return [cpuKpi, gpuKpi, vramKpi, ramKpi, fanKpi];
}

export default function KpiStrip() {
  const { latest, agent } = useTelemetry();
  const { settings } = useSettings();
  const { labelOf } = useSensorLabels();
  const tempUnit = settings?.tempUnit ?? "C";

  const kpis = useMemo(() => buildKpis(latest, agent, tempUnit, labelOf), [latest, agent, tempUnit, labelOf]);

  return (
    <div className="grid grid-cols-5 gap-3 max-[1439px]:gap-2">
      {kpis.map((k) => (
        <KpiCard key={k.key} kpi={k} />
      ))}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const color = kpi.color;
  const meter = kpi.meter === null ? null : clamp(kpi.meter, 0, 100);
  return (
    <div
      className={cn(
        "glass relative min-w-0 overflow-hidden py-3 pl-4 pr-3",
        "max-[1439px]:py-2.5 max-[1439px]:pl-3.5 max-[1439px]:pr-2",
      )}
    >
      {/* Vertical series line (decoration, not state) */}
      <span
        aria-hidden
        className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full"
        style={{ background: color, boxShadow: `0 0 10px ${color}, 0 0 2px ${color}` }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -left-8 -top-8 h-20 w-20 rounded-full opacity-[0.12] blur-2xl"
        style={{ background: color }}
      />
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.2em] text-muted">{kpi.label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink max-[1439px]:text-[22px]">
          {kpi.value}
        </span>
        {kpi.unit && (
          <span className="font-mono text-[11px] font-medium" style={{ color }}>
            {kpi.unit}
          </span>
        )}
        {kpi.badge && <span className="ml-auto self-center">{kpi.badge}</span>}
      </div>
      <div className="mt-1.5 flex min-w-0 items-center truncate font-mono text-[10.5px] text-muted" title={kpi.subTitle}>
        {kpi.subShort !== undefined ? (
          <>
            <span className="flex min-w-0 items-center truncate max-[1439px]:hidden">{kpi.sub}</span>
            <span className="hidden min-w-0 items-center truncate max-[1439px]:flex">{kpi.subShort}</span>
          </>
        ) : (
          <span className="flex min-w-0 items-center truncate">{kpi.sub}</span>
        )}
      </div>
      <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-white/[0.06]">
        {meter !== null && (
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${meter}%`, background: color, boxShadow: `0 0 6px ${color}` }}
          />
        )}
      </div>
    </div>
  );
}
