import { useMemo } from "react";
import { TONE_HEX } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { clamp, cn, fmtMhz } from "../../lib/format";
import type { FanTelemetry, TelemetryPacket } from "../../types";

type Accent = "teal" | "gold" | "silver" | "purple" | "cyan";

const ACCENT_HEX: Record<Accent | "rose", string> = TONE_HEX;

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Primary fan for the KPI: the CPU header if present, otherwise the fastest spinning fan, otherwise the GPU fan. */
function primaryFan(p: TelemetryPacket | null): { rpm: number; label: string } | null {
  if (!p) return null;
  const fans: FanTelemetry[] = p.fans ?? [];
  const cpu = fans.find((f) => /cpu|pump|aio/i.test(f.name) && finite(f.rpm) && f.rpm > 0);
  if (cpu) return { rpm: cpu.rpm, label: cpu.name };
  const spinning = fans.filter((f) => finite(f.rpm) && f.rpm > 0).sort((a, b) => b.rpm - a.rpm);
  if (spinning.length > 0) return { rpm: spinning[0].rpm, label: spinning[0].name };
  const g = p.gpu?.fanRpm;
  if (finite(g)) return { rpm: g, label: "GPU Fan" };
  if (fans.length > 0) return { rpm: 0, label: fans[0].name };
  return null;
}

interface Kpi {
  key: string;
  label: string;
  accent: Accent;
  value: string;
  unit: string;
  sub: string;
  /** 0-100 fill for the thin baseline meter; null hides it. */
  meter: number | null;
  crit?: boolean;
}

const PRESET_LABEL: Record<string, string> = {
  auto: "BIOS Auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

export default function KpiStrip() {
  const { latest } = useTelemetry();

  const kpis = useMemo<Kpi[]>(() => {
    const cpu = latest?.cpu;
    const gpu = latest?.gpu ?? null;
    const ram = latest?.ram;

    const cpuLoad = cpu?.loadTotal;
    const cpuClock = cpu?.clockMhz;
    const gpuLoad = gpu?.load;
    const gpuClock = gpu?.coreClockMhz;
    const vramUsed = gpu?.vramUsedGb;
    const vramTotal = gpu?.vramTotalGb;
    const ramUsed = ram?.usedGb;
    const ramTotal = ram?.totalGb;
    const fan = primaryFan(latest);
    const fanCount = latest?.fans?.length ?? 0;
    const preset = latest?.fanPreset ? PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset : null;

    const cpuSub = [
      finite(cpuClock) ? fmtMhz(cpuClock) : null,
      cpu && cpu.cores > 0 ? `${cpu.cores}C/${cpu.threads}T` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const gpuSub = [
      finite(gpuClock) ? fmtMhz(gpuClock) : null,
      finite(gpu?.powerW) ? `${gpu!.powerW!.toFixed(0)} W` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const ramSub = [
      finite(ramTotal) ? `of ${ramTotal.toFixed(ramTotal >= 100 ? 0 : 1)} GB` : null,
      finite(ram?.speedMts) ? `${ram!.speedMts} MT/s` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return [
      {
        key: "cpu",
        label: "CPU Load",
        accent: "teal",
        value: finite(cpuLoad) ? cpuLoad.toFixed(0) : "—",
        unit: "%",
        sub: cpuSub || "—",
        meter: finite(cpuLoad) ? cpuLoad : null,
      },
      {
        key: "gpu",
        label: "GPU Load",
        accent: "gold",
        value: finite(gpuLoad) ? gpuLoad.toFixed(0) : "—",
        unit: "%",
        sub: gpu ? gpuSub || "—" : "No GPU sensor",
        meter: finite(gpuLoad) ? gpuLoad : null,
      },
      {
        key: "vram",
        label: "VRAM Used",
        accent: "silver",
        value: finite(vramUsed) ? vramUsed.toFixed(1) : "—",
        unit: "GB",
        sub: finite(vramTotal) ? `of ${vramTotal.toFixed(vramTotal >= 100 ? 0 : 1)} GB` : "—",
        meter: finite(vramUsed) && finite(vramTotal) && vramTotal > 0 ? (vramUsed / vramTotal) * 100 : null,
      },
      {
        key: "ram",
        label: "RAM Used",
        accent: "purple",
        value: finite(ramUsed) ? ramUsed.toFixed(1) : "—",
        unit: "GB",
        sub: ramSub || "—",
        meter: finite(ram?.loadPct) ? ram!.loadPct : null,
        crit: finite(ram?.loadPct) && ram!.loadPct >= 92,
      },
      {
        key: "fan",
        label: "Fan Speed",
        accent: "cyan",
        value: fan ? Math.round(fan.rpm).toString() : "—",
        unit: "RPM",
        sub: fan ? [preset, fanCount > 0 ? `${fanCount} fans` : null].filter(Boolean).join(" · ") || fan.label : "No fan sensors",
        meter: fan ? clamp((fan.rpm / 2400) * 100, 0, 100) : null,
      },
    ];
  }, [latest]);

  return (
    <div className="grid grid-cols-5 gap-3 max-[1439px]:gap-2">
      {kpis.map((k) => (
        <KpiCard key={k.key} kpi={k} />
      ))}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  const color = kpi.crit ? ACCENT_HEX.rose : ACCENT_HEX[kpi.accent];
  const meter = kpi.meter === null ? null : clamp(kpi.meter, 0, 100);
  return (
    <div
      className={cn(
        "glass relative min-w-0 overflow-hidden py-3 pl-4 pr-3",
        "max-[1439px]:py-2.5 max-[1439px]:pl-3.5 max-[1439px]:pr-2",
      )}
    >
      {/* Vertical accent line */}
      <span
        aria-hidden
        className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full"
        style={{ background: color, boxShadow: `0 0 10px ${color}, 0 0 2px ${color}` }}
      />
      {/* Soft accent wash in the corner */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-8 -top-8 h-20 w-20 rounded-full opacity-[0.12] blur-2xl"
        style={{ background: color }}
      />
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.2em] text-muted">{kpi.label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span
          className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink max-[1439px]:text-[22px]"
          style={kpi.crit ? { color } : undefined}
        >
          {kpi.value}
        </span>
        <span className="font-mono text-[11px] font-medium" style={{ color }}>
          {kpi.unit}
        </span>
      </div>
      <div className="mt-1.5 truncate font-mono text-[10.5px] text-muted" title={kpi.sub}>
        {kpi.sub}
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
