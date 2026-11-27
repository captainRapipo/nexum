import { useMemo } from "react";
import { Activity, Flame } from "lucide-react";
import { DotMatrix, StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { clamp, cn, fmtTemp } from "../../lib/format";
import type { TelemetryPacket } from "../../types";

/** Temperatures at/above this (°C) are treated as critical across the dashboard. */
export const CRITICAL_TEMP_C = 85;

/** Temperature → 0-100 thermal pressure: 30 °C idle floor, 95 °C ceiling. */
function thermalPressure(tempC: number): number {
  return clamp(((tempC - 30) / (95 - 30)) * 100, 0, 100);
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Weighted Thermal & Load Index (0-100).
 * CPU load 30% · CPU temp 30% · GPU load 20% · GPU temp 20%.
 * Missing sensors are dropped and the remaining weights re-normalised, so a machine
 * without a discrete GPU (or without temp access) still yields a meaningful index.
 * Returns null when nothing is measurable.
 */
export function computeThermalLoadIndex(p: TelemetryPacket | null | undefined): number | null {
  if (!p) return null;
  const parts: Array<[number, number]> = [];
  const cpuLoad = p.cpu?.loadTotal;
  const cpuTemp = p.cpu?.packageTempC;
  const gpuLoad = p.gpu?.load;
  const gpuTemp = p.gpu?.tempC;
  if (finite(cpuLoad)) parts.push([clamp(cpuLoad, 0, 100), 0.3]);
  if (finite(cpuTemp)) parts.push([thermalPressure(cpuTemp), 0.3]);
  if (finite(gpuLoad)) parts.push([clamp(gpuLoad, 0, 100), 0.2]);
  if (finite(gpuTemp)) parts.push([thermalPressure(gpuTemp), 0.2]);
  const wSum = parts.reduce((s, [, w]) => s + w, 0);
  if (wSum <= 0) return null;
  return clamp(parts.reduce((s, [v, w]) => s + v * w, 0) / wSum, 0, 100);
}

type Band = { label: string; tone: "ok" | "warn" | "crit" | "info"; accent: "teal" | "gold" | "rose" };

function bandFor(index: number | null, hotSensor: boolean): Band {
  if (hotSensor) return { label: "Thermal Alert", tone: "crit", accent: "rose" };
  if (index === null) return { label: "No Signal", tone: "info", accent: "teal" };
  if (index >= 85) return { label: "Critical", tone: "crit", accent: "rose" };
  if (index >= 65) return { label: "High Load", tone: "warn", accent: "gold" };
  if (index >= 40) return { label: "Active", tone: "info", accent: "teal" };
  return { label: "Nominal", tone: "ok", accent: "teal" };
}

const MATRIX_COLUMNS = 28;

export default function ThermalLoadCard() {
  const { latest, history } = useTelemetry();
  const { settings } = useSettings();
  const unit = settings?.tempUnit ?? "C";

  const index = useMemo(() => computeThermalLoadIndex(latest), [latest]);

  const matrix = useMemo(() => {
    const recent = history.slice(-MATRIX_COLUMNS);
    const vals: number[] = [];
    let last = 0;
    for (const p of recent) {
      const v = computeThermalLoadIndex(p);
      if (v !== null) last = v;
      vals.push(Math.round(last));
    }
    // Left-pad so the visualizer has a stable width while history warms up.
    while (vals.length < MATRIX_COLUMNS) vals.unshift(0);
    return vals;
  }, [history]);

  const peak = useMemo(() => {
    let m: number | null = null;
    for (const p of history) {
      const v = computeThermalLoadIndex(p);
      if (v !== null && (m === null || v > m)) m = v;
    }
    return m;
  }, [history]);

  const cpuTemp = latest?.cpu?.packageTempC ?? null;
  const gpuTemp = latest?.gpu?.tempC ?? null;
  const hotSensor =
    (finite(cpuTemp) && cpuTemp >= CRITICAL_TEMP_C) || (finite(gpuTemp) && gpuTemp >= CRITICAL_TEMP_C);
  const band = bandFor(index, hotSensor);
  const isCrit = band.accent === "rose";
  const valueColor = isCrit ? "text-rose" : band.accent === "gold" ? "text-gold" : "text-teal";
  const glow = isCrit
    ? "0 0 22px rgba(225,29,72,0.45)"
    : band.accent === "gold"
      ? "0 0 22px rgba(212,163,89,0.40)"
      : "0 0 22px rgba(45,212,191,0.40)";

  const cpuLoad = latest?.cpu?.loadTotal;
  const gpuLoad = latest?.gpu?.load;

  return (
    <GlassCard
      title="Thermal & Load Index"
      icon={<Flame size={14} />}
      accent={band.accent}
    >
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1">
          <span
            className={cn("font-mono text-5xl font-semibold leading-none tracking-tight tabular-nums", valueColor)}
            style={{ textShadow: glow }}
          >
            {index === null ? "—" : Math.round(index)}
          </span>
          <span className="font-mono text-xl text-muted">%</span>
        </div>
        <StatusPill tone={band.tone} pulse={isCrit}>
          {band.label}
        </StatusPill>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[10px] uppercase tracking-[0.18em] text-muted">
        <span className="min-w-0 truncate">CPU · GPU load &amp; temp</span>
        <span className="shrink-0 whitespace-nowrap">
          Peak 2m{" "}
          <span className="font-mono text-sm normal-case tracking-normal tabular-nums text-ink">
            {peak === null ? "—" : `${Math.round(peak)}%`}
          </span>
        </span>
      </div>

      <div className="mt-3">
        <DotMatrix values={matrix} rows={6} tone={band.accent} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3">
        <MiniStat label="CPU Load" value={finite(cpuLoad) ? `${cpuLoad.toFixed(0)}%` : "—"} />
        <MiniStat
          label="CPU Temp"
          value={finite(cpuTemp) ? fmtTemp(cpuTemp, unit) : "—"}
          crit={finite(cpuTemp) && cpuTemp >= CRITICAL_TEMP_C}
        />
        <MiniStat label="GPU Load" value={finite(gpuLoad) ? `${gpuLoad.toFixed(0)}%` : "—"} />
        <MiniStat
          label="GPU Temp"
          value={finite(gpuTemp) ? fmtTemp(gpuTemp, unit) : "—"}
          crit={finite(gpuTemp) && gpuTemp >= CRITICAL_TEMP_C}
        />
      </div>

      {!latest && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
          <Activity size={12} className="shrink-0" />
          Waiting for sensor stream…
        </div>
      )}
    </GlassCard>
  );
}

function MiniStat({ label, value, crit = false }: { label: string; value: string; crit?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</span>
      <span className={cn("font-mono text-xs tabular-nums", crit ? "text-rose" : "text-ink")}>{value}</span>
    </div>
  );
}
