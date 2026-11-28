import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Card, SERIES_CLASS, SERIES_HEX, Sparkline, Tag, Unavailable, type SeriesKey } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { useFrames } from "../../hooks/useFrames";
import { fmtFps, fpsKpi } from "../../lib/frames";
import { requestNavigate } from "../../lib/nav";
import { resolveUnavailable } from "../../lib/status";
import { cn, fmtGhz } from "../../lib/format";
import { NOT_AVAILABLE_TEXT, type AgentStatus, type FanPreset, type TelemetryPacket } from "../../types";
import { countText, finite, isZeroRpmIdle, pickCpuFan, tempText } from "./sensorHelpers";

const PRESET_LABEL: Record<FanPreset, string> = {
  auto: "BIOS auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

/** Sparkline window: the telemetry history the provider keeps (last 120 packets). */
const FPS_POINTS = 60;

interface Kpi {
  key: string;
  label: string;
  /** Series identity (dot and sparkline colour). Decoration only, never state. */
  series: SeriesKey;
  /** Number shown at display size, or null when the value cannot be read. */
  value: string | null;
  unit: string | null;
  /** One line under the value. */
  meta: ReactNode;
  /** Hover text of the meta line (what the figures are). */
  metaTitle?: string;
  /** Neutral tag after the label ("Zero-RPM idle"). */
  tag?: ReactNode;
  spark: readonly (number | null)[];
  sparkMin?: number;
  sparkMax?: number;
  /** Makes the whole cell a button (Frame rate → Gaming). */
  onClick?: () => void;
  clickTitle?: string;
}

/** Scale for a sparkline whose absolute level matters less than its movement (rpm, fps). */
function fitRange(values: readonly (number | null)[], minSpan: number): { min: number; max: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return null;
  const span = Math.max(hi - lo, minSpan);
  const mid = (hi + lo) / 2;
  return { min: Math.max(0, mid - span * 0.75), max: mid + span * 0.75 };
}

function buildKpis(
  latest: TelemetryPacket | null,
  history: readonly TelemetryPacket[],
  agent: AgentStatus | null,
  tempUnit: "C" | "F",
  labelOf: (id: string, defaultName: string) => string,
): Kpi[] {
  const cpu = latest?.cpu ?? null;
  const gpu = latest?.gpu ?? null;
  const ram = latest?.ram ?? null;
  // Nothing is read right now: the large dash already says so (hover: "Not available right now"), so the
  // meta line stays empty instead of showing a second dash under it.
  const missingReason = resolveUnavailable(agent, "none");
  const missing = !latest && missingReason === "agentOffline" ? null : <Unavailable reason={missingReason} />;

  /* ---- CPU: load, package temperature, effective clock ---- */
  const cpuLoad = cpu?.loadTotal;
  const cpuTemp = cpu?.packageTempC;
  const cpuClock = cpu?.clockMhz;
  const cpuKnown = [finite(cpuTemp) ? tempText(cpuTemp, tempUnit, 1) : null, finite(cpuClock) ? fmtGhz(cpuClock) : null].filter(Boolean);
  const cpuMissing = [finite(cpuTemp) ? null : "temp", finite(cpuClock) ? null : "clock"].filter(Boolean);
  const cpuMeta: ReactNode = !latest ? (
    missing
  ) : cpuMissing.length === 0 ? (
    cpuKnown.join(" · ")
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Unavailable reason={resolveUnavailable(agent, "pawnio")} compact />
      <span className="truncate">{[cpuMissing.join(" · "), ...cpuKnown].join(" · ")}</span>
    </span>
  );
  const coresText = cpu && cpu.cores > 0 ? `${cpu.cores} cores, ${cpu.threads} threads` : null;
  const cpuKpi: Kpi = {
    key: "cpu",
    label: "CPU",
    series: "cpu",
    value: finite(cpuLoad) ? cpuLoad.toFixed(0) : null,
    unit: "%",
    meta: cpuMeta,
    metaTitle: ["Package temperature and average effective clock across all cores", coresText].filter(Boolean).join(" · "),
    spark: history.map((p) => (finite(p.cpu?.loadTotal) ? p.cpu.loadTotal : null)),
    sparkMin: 0,
    sparkMax: 100,
  };

  /* ---- GPU: load, edge temperature, power ---- */
  const gpuLoad = gpu?.load;
  const edge = gpu?.tempC;
  const gpuParts = [finite(edge) ? `${tempText(edge, tempUnit)} edge` : null, finite(gpu?.powerW) ? `${gpu!.powerW!.toFixed(0)} W` : null].filter(Boolean);
  const gpuKpi: Kpi = {
    key: "gpu",
    label: "GPU",
    series: "gpu",
    value: finite(gpuLoad) ? gpuLoad.toFixed(0) : null,
    unit: "%",
    meta: !latest ? missing : !gpu ? "No graphics sensor" : gpuParts.length > 0 ? gpuParts.join(" · ") : missing,
    metaTitle: "Edge temperature and board power. The hot spot reading is on the Sensors and Cooling pages.",
    tag: isZeroRpmIdle(gpu) ? (
      <Tag title="Zero-RPM idle: the graphics card's fan is stopped because the card is cool enough">Zero-RPM idle</Tag>
    ) : undefined,
    spark: history.map((p) => (finite(p.gpu?.load) ? p.gpu!.load : null)),
    sparkMin: 0,
    sparkMax: 100,
  };

  /* ---- Memory ---- */
  const ramUsed = ram?.usedGb;
  const ramTotal = ram?.totalGb;
  const ramParts = [finite(ramTotal) ? `of ${ramTotal.toFixed(0)} GB` : null, finite(ram?.speedMts) ? `${ram!.speedMts} MT/s` : null].filter(Boolean);
  const dimms = finite(ram?.slotsUsed) && finite(ram?.slotsTotal) ? `${ram!.slotsUsed} of ${ram!.slotsTotal} DIMMs` : null;
  const ramKpi: Kpi = {
    key: "ram",
    label: "Memory",
    series: "ram",
    value: finite(ramUsed) ? ramUsed.toFixed(1) : null,
    unit: "GB",
    meta: !latest ? missing : ramParts.length > 0 ? ramParts.join(" · ") : missing,
    metaTitle: ["Memory in use", dimms].filter(Boolean).join(" · "),
    spark: history.map((p) => (finite(p.ram?.usedGb) ? p.ram.usedGb : null)),
    sparkMin: 0,
    sparkMax: finite(ramTotal) && ramTotal > 0 ? ramTotal : undefined,
  };

  /* ---- Video memory ---- */
  const vramUsed = gpu?.vramUsedGb;
  const vramTotal = gpu?.vramTotalGb;
  const vramKpi: Kpi = {
    key: "vram",
    label: "Video memory",
    series: "vram",
    value: finite(vramUsed) ? vramUsed.toFixed(1) : null,
    unit: "GB",
    meta: !latest ? missing : !gpu ? "No graphics sensor" : finite(vramTotal) ? `of ${vramTotal.toFixed(vramTotal >= 100 ? 0 : 1).replace(/\.0$/, "")} GB` : missing,
    metaTitle: "Graphics memory in use",
    spark: history.map((p) => (finite(p.gpu?.vramUsedGb) ? p.gpu!.vramUsedGb : null)),
    sparkMin: 0,
    sparkMax: finite(vramTotal) && vramTotal > 0 ? vramTotal : undefined,
  };

  /* ---- CPU fan: the CPU header only, never averaged, never substituted (CONTRACT §4.8) ---- */
  const fan = latest ? pickCpuFan(latest.fans) : null;
  const fanReason = resolveUnavailable(agent, "pawnio");
  const rpm = fan && finite(fan.rpm) ? fan.rpm : null;
  const preset = latest?.fanPreset ? (PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset) : null;
  const held = !!latest?.fanSafety?.overrideActive;
  const fanName = fan ? labelOf(fan.id, fan.name) : null;
  const duty = fan && finite(fan.controlPct) ? `${fan.controlPct.toFixed(0)}%` : null;
  const fanSeries = history.map((p) => {
    const f = pickCpuFan(p.fans);
    return f && finite(f.rpm) ? f.rpm : null;
  });
  const fanFit = fitRange(fanSeries, 400);
  const fanKpi: Kpi = {
    key: "fan",
    label: "CPU fan",
    series: "neutral",
    value: rpm !== null ? countText(rpm) : null,
    unit: "rpm",
    meta: !latest ? missing : !fan ? <Unavailable reason={fanReason} /> : held ? "Held at 100% for safety" : [preset, duty].filter(Boolean).join(" · ") || "—",
    metaTitle: fan
      ? `${fanName ?? fan.name} · ${fan.hardware}. Fan preset and duty. Shows the CPU fan header only, never an average or another fan.`
      : "Shows the motherboard's CPU fan header only, never another fan.",
    spark: fanSeries,
    sparkMin: fanFit?.min,
    sparkMax: fanFit?.max,
  };

  return [cpuKpi, gpuKpi, ramKpi, vramKpi, fanKpi];
}

/** 6th cell (CONTRACT §4.10.2): shown only while fpsKpi(useFrames()).visible. */
function buildFpsKpi(fps: number | null, low1: number | null, process: string | null, spark: readonly number[]): Kpi {
  const fit = fitRange(spark, 20);
  return {
    key: "fps",
    label: "Frame rate",
    series: "neutral",
    value: fps == null ? null : fmtFps(fps),
    unit: "fps",
    meta: [`P1 ${fmtFps(low1)}`, process].filter(Boolean).join(" · "),
    metaTitle: `Rendered frames per second of ${process ?? "the game"}, measured with Intel PresentMon. P1 = 1000 / 99th-percentile frame time.`,
    spark,
    sparkMin: fit?.min,
    sparkMax: fit?.max,
    onClick: () => requestNavigate("gaming"),
    clickTitle: "Open Gaming (F8)",
  };
}

/**
 * KPI strip (CONTRACT §4.10.3, SPEC §5): ONE card whose cells are divided by hairlines. 5 cells, 6
 * while a game is being measured. Each cell: series dot + label, the value at display size with its
 * unit, one meta line and a sparkline of the last two minutes in the series colour.
 */
export default function KpiStrip() {
  const { latest, history, agent } = useTelemetry();
  const { settings } = useSettings();
  const { labelOf } = useSensorLabels();
  const frames = useFrames();
  const tempUnit = settings?.tempUnit ?? "C";

  const kpis = useMemo(() => buildKpis(latest, history, agent, tempUnit, labelOf), [latest, history, agent, tempUnit, labelOf]);

  const fpsView = fpsKpi({
    enabled: frames.enabled,
    session: frames.session,
    target: frames.target,
    stats: frames.stats,
    statsFresh: frames.statsFresh,
  });
  // The frame-rate sparkline has no backing history, so the last minute of readings is kept here
  // (one point per statistics packet; cleared when the cell goes away).
  const fpsHist = useRef<{ ts: number | null; pid: number | null; points: number[] }>({ ts: null, pid: null, points: [] });
  const statsTs = frames.stats?.ts ?? null;
  const statsPid = frames.stats?.pid ?? null;
  if (!fpsView.visible) {
    if (fpsHist.current.points.length > 0) fpsHist.current = { ts: null, pid: null, points: [] };
  } else if (statsTs !== fpsHist.current.ts && fpsView.fps != null) {
    const keep = statsPid === fpsHist.current.pid ? fpsHist.current.points.slice(-(FPS_POINTS - 1)) : [];
    fpsHist.current = { ts: statsTs, pid: statsPid, points: [...keep, fpsView.fps] };
  }

  const all = fpsView.visible ? [...kpis, buildFpsKpi(fpsView.fps, fpsView.low1, fpsView.process, fpsHist.current.points)] : kpis;

  return (
    <Card padded={false} aria-label="Key figures" className="shrink-0 overflow-hidden">
      {/* auto-fit re-flows 5 → 6 cells on one row without a layout jump (CONTRACT §4.10.2). */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {all.map((k) => (
          <KpiCell key={k.key} kpi={k} />
        ))}
      </div>
    </Card>
  );
}

function KpiCell({ kpi }: { kpi: Kpi }) {
  const clickable = !!kpi.onClick;
  const color = SERIES_HEX[kpi.series];
  const interactive = clickable
    ? {
        role: "button" as const,
        tabIndex: 0,
        title: kpi.clickTitle,
        "aria-label": `${kpi.label} ${kpi.value ?? "not available"} ${kpi.value ? (kpi.unit ?? "") : ""}. ${kpi.clickTitle ?? ""}`.replace(/\s+/g, " ").trim(),
        onClick: kpi.onClick,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            kpi.onClick?.();
          }
        },
      }
    : {};
  return (
    <div
      {...interactive}
      className={cn(
        "min-w-0 border-l border-divider px-[18px] pb-3 pt-3.5 first:border-l-0 tight:px-3.5 tight:pb-2.5 tight:pt-3",
        // The focus ring follows the card's corners when the cell is the first or the last one.
        clickable && "focus-inset transition-colors duration-[80ms] first:rounded-l-card last:rounded-r-card hover:bg-hover active:bg-pressed",
      )}
    >
      {/* Fixed height: an 18 px tag in one cell must not push that cell's figures below its neighbours'. */}
      <div className="flex h-[17px] min-w-0 items-center gap-[7px] text-[12.5px] font-medium leading-[17px] text-ink-2">
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", SERIES_CLASS[kpi.series].bg)} />
        <span className="truncate">{kpi.label}</span>
        {kpi.tag && <span className="ml-auto flex shrink-0 items-center">{kpi.tag}</span>}
      </div>
      <div className="mt-1.5 whitespace-nowrap text-display tnum tight:text-display-tight">
        {kpi.value != null ? (
          <>
            <span className="text-ink">{kpi.value}</span>
            {kpi.unit && <span className="ml-[3px] text-[16px] font-medium leading-none tracking-normal text-ink-2 tight:text-[14px]">{kpi.unit}</span>}
          </>
        ) : (
          <span className="text-ink-3" role="img" aria-label={NOT_AVAILABLE_TEXT} title={NOT_AVAILABLE_TEXT}>
            —
          </span>
        )}
      </div>
      <div className="mb-2 mt-px flex h-[17px] min-w-0 items-center truncate text-callout text-ink-2 tnum tight:mb-1.5" title={kpi.metaTitle}>
        {typeof kpi.meta === "string" ? <span className="truncate">{kpi.meta}</span> : kpi.meta}
      </div>
      <div className="h-[22px]">
        <Sparkline data={kpi.spark} color={color} height={22} fill min={kpi.sparkMin} max={kpi.sparkMax} strokeWidth={1.5} />
      </div>
    </div>
  );
}
