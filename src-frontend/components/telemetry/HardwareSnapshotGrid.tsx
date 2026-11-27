import { useMemo, type ReactNode } from "react";
import { Cpu, Fan, LayoutGrid, MemoryStick, MonitorSpeaker } from "lucide-react";
import { Sparkline, TONE_HEX, TrendArrow } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { cn, fmtTemp } from "../../lib/format";
import type { TelemetryPacket } from "../../types";
import { CRITICAL_TEMP_C } from "./ThermalLoadCard";

const TREND_WINDOW_MS = 10_000;
const SPARK_POINTS = 60;

const COLORS = TONE_HEX;

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Average RPM across spinning motherboard fans; falls back to the GPU fan when no headers report. */
export function avgFanRpm(p: TelemetryPacket | null | undefined): number | null {
  if (!p) return null;
  const spinning = (p.fans ?? []).map((f) => f.rpm).filter((r) => finite(r) && r > 0);
  if (spinning.length > 0) return spinning.reduce((s, r) => s + r, 0) / spinning.length;
  const g = p.gpu?.fanRpm;
  if (finite(g) && g > 0) return g;
  if ((p.fans ?? []).length > 0) return 0; // fans present but all stopped (e.g. zero-RPM mode)
  return null;
}

type Extractor = (p: TelemetryPacket) => number | null;

interface MetricDef {
  key: string;
  label: string;
  icon: ReactNode;
  color: string;
  get: Extractor;
  isTemp?: boolean;
  unit?: string;
  digits: number;
  /** Rising is bad (temps, memory pressure) → TrendArrow colours up-moves rose. */
  invertTrend: boolean;
}

const METRICS: MetricDef[] = [
  {
    key: "cpuTemp",
    label: "CPU Temp",
    icon: <Cpu size={12} />,
    color: COLORS.teal,
    get: (p) => p.cpu?.packageTempC ?? null,
    isTemp: true,
    digits: 0,
    invertTrend: true,
  },
  {
    key: "gpuTemp",
    label: "GPU Temp",
    icon: <MonitorSpeaker size={12} />,
    color: COLORS.gold,
    get: (p) => p.gpu?.tempC ?? null,
    isTemp: true,
    digits: 0,
    invertTrend: true,
  },
  {
    key: "ramUsed",
    label: "RAM Used",
    icon: <MemoryStick size={12} />,
    color: COLORS.purple,
    get: (p) => (finite(p.ram?.usedGb) ? p.ram.usedGb : null),
    unit: "GB",
    digits: 1,
    invertTrend: true,
  },
  {
    key: "fanAvg",
    label: "Avg Fan",
    icon: <Fan size={12} />,
    color: COLORS.cyan,
    get: (p) => avgFanRpm(p),
    unit: "RPM",
    digits: 0,
    invertTrend: false,
  },
];

/** Find the packet closest to (latest.ts - 10s); falls back to the oldest sample available. */
function baselinePacket(history: TelemetryPacket[], latest: TelemetryPacket | null): TelemetryPacket | null {
  if (!latest || history.length < 2) return null;
  const target = latest.ts - TREND_WINDOW_MS;
  let best: TelemetryPacket | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i];
    if (p === latest) continue;
    if (p.ts <= target) {
      best = p;
      break;
    }
    best = p; // keep walking back; ends at oldest if window not yet filled
  }
  return best;
}

function toUnit(c: number, unit: "C" | "F"): number {
  return unit === "F" ? (c * 9) / 5 + 32 : c;
}

export default function HardwareSnapshotGrid() {
  const { latest, history } = useTelemetry();
  const { settings } = useSettings();
  const unit = settings?.tempUnit ?? "C";

  const tiles = useMemo(() => {
    const base = baselinePacket(history, latest);
    const recent = history.slice(-SPARK_POINTS);
    return METRICS.map((m) => {
      const raw = latest ? m.get(latest) : null;
      const then = base ? m.get(base) : null;
      const series: number[] = [];
      for (const p of recent) {
        const v = m.get(p);
        if (finite(v)) series.push(m.isTemp ? toUnit(v, unit) : v);
      }
      let delta: number | null = null;
      if (finite(raw) && finite(then)) {
        delta = m.isTemp ? toUnit(raw, unit) - toUnit(then, unit) : raw - then;
      }
      const crit = m.isTemp && finite(raw) && raw >= CRITICAL_TEMP_C;
      let value = "—";
      let unitLabel = m.unit ?? "";
      if (finite(raw)) {
        if (m.isTemp) {
          value = toUnit(raw, unit).toFixed(m.digits);
          unitLabel = `°${unit}`;
        } else {
          value = raw.toFixed(m.digits);
        }
      } else if (m.isTemp) {
        unitLabel = `°${unit}`;
      }
      const title = m.isTemp && finite(raw) ? fmtTemp(raw, unit) : undefined;
      return { m, value, unitLabel, delta, series, crit, title };
    });
  }, [history, latest, unit]);

  const ramTotal = latest?.ram?.totalGb;

  return (
    <GlassCard title="Hardware Snapshot" icon={<LayoutGrid size={14} />} accent="teal">
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map(({ m, value, unitLabel, delta, series, crit, title }) => (
          <div
            key={m.key}
            title={title}
            className={cn(
              "relative overflow-hidden rounded-lg border bg-white/[0.02] px-3 pb-2 pt-2.5 transition-colors",
              crit ? "border-rose/50 shadow-[0_0_18px_rgba(225,29,72,0.25)]" : "border-line hover:border-white/15",
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted">
              <span className="shrink-0" style={{ color: crit ? COLORS.rose : m.color }}>
                {m.icon}
              </span>
              <span className="truncate">{m.label}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span
                className={cn(
                  "font-mono text-xl font-semibold leading-none tabular-nums",
                  crit ? "text-rose" : "text-ink",
                )}
              >
                {value}
              </span>
              <span className="whitespace-nowrap font-mono text-[10px] text-muted">
                {unitLabel}
                {m.key === "ramUsed" && finite(ramTotal) ? ` / ${ramTotal.toFixed(0)}` : ""}
              </span>
            </div>
            <div className="relative mt-1.5 h-7">
              {delta !== null && (
                <TrendArrow
                  delta={delta}
                  invert={m.invertTrend}
                  unit={m.isTemp ? "°" : ""}
                  precision={m.key === "ramUsed" ? 1 : 0}
                  threshold={m.key === "ramUsed" ? 0.05 : m.key === "fanAvg" ? 15 : 0.5}
                  className="absolute -top-0.5 right-0 z-10 rounded bg-[#0a1316]/85 px-1 text-[10px] leading-4"
                />
              )}
              {series.length >= 2 ? (
                <Sparkline data={series} color={crit ? COLORS.rose : m.color} height={28} />
              ) : (
                <div className="flex h-full items-center text-[10px] uppercase tracking-[0.18em] text-muted">
                  {finite(raw(m, latest)) ? "Sampling…" : "No sensor"}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function raw(m: MetricDef, latest: TelemetryPacket | null): number | null {
  return latest ? m.get(latest) : null;
}
