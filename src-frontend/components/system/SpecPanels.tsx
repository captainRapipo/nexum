import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EChartsOption } from "echarts";
import { CircleCheck, CircuitBoard, Cpu, Info, MemoryStick, Monitor, MonitorCog } from "lucide-react";
import type {
  BoardSpec,
  CpuSpec,
  DiskLink,
  GpuSpec,
  MemorySpec,
  OsSpec,
  PhysicalDisk,
  SecuritySpec,
  SpdInfo,
  UnavailableReason,
} from "../../types";
import { cn, fmtBoardName, fmtCount, fmtDate, fmtUptime, toTempUnit } from "../../lib/format";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import GlassCard from "../layout/GlassCard";
import { CHART_HEX, EChart, Segmented, Sparkline, Tag, Unavailable, nexumLine } from "../ui";
import { SpecCard, SpecHero, SpecRows, type HeroStat } from "./SpecCard";
import {
  biosRows,
  boardRows,
  cacheTypeLabel,
  cacheWays,
  clockRows,
  cpuRows,
  dimmRows,
  diskBusLabel,
  diskLinkName,
  diskLinkText,
  displayCodename,
  fmtChannels,
  fmtDimmCount,
  fmtKb,
  fmtMts,
  fmtPcieLink,
  fmtSizeGb,
  GPU_VENDOR_LABEL,
  gpuRows,
  memoryCoupling,
  osRows,
  PCIE_IDLE_HINT,
  securityRows,
  spdCycleRows,
  spdNsRows,
  SPD_NOT_RUNNING_NOTE,
  timingRows,
  TIMINGS_SOURCE_HINT,
  TIMINGS_SOURCE_LABEL,
  type RowCtx,
} from "./specModel";

/* ------------------------------------------------------------------ shared */

const STACK = "flex flex-col gap-(--grid-gap)";
const GRID = "grid grid-cols-12 gap-(--grid-gap)";

/** Whole section missing (the details could not be read at all). */
export function SectionUnavailable({ title, reason, detail }: { title: string; reason: UnavailableReason; detail: string }) {
  return (
    <GlassCard title={title}>
      <div className="flex flex-col items-start gap-2 pb-2">
        <Unavailable reason={reason} />
        <p className="text-body text-ink-2">{detail}</p>
      </div>
    </GlassCard>
  );
}

/** Dense table inside a card (SPEC §7, mock ".ctbl"): 26 px header, 30 px rows, hairlines. */
const TABLE = "tnum w-full border-collapse text-[12.5px] leading-none";
const TH = "h-[26px] whitespace-nowrap border-b border-hairline text-left text-[11px] font-semibold text-ink-2";
const TD = "h-[30px] border-b border-divider group-last:border-b-0";

/**
 * Where a set of values comes from. Not a health state: neutral surface, and the live source adds a
 * check mark so the difference never depends on colour. The hover explains the source.
 */
function SourceChip({ children, title, live = false }: { children: string; title: string; live?: boolean }) {
  return (
    <span
      title={title}
      className="inline-flex h-5 max-w-full items-center gap-[5px] truncate whitespace-nowrap rounded-[10px] bg-inset px-2 text-[11px] font-medium text-ink-2 shadow-[inset_0_0_0_0.5px_var(--color-subtle)]"
    >
      {live && <CircleCheck size={12} className="shrink-0 text-ok-icon" aria-hidden="true" />}
      {children}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex items-start gap-2 text-callout text-ink-2">
      <Info size={14} className="mt-px shrink-0 text-ink-3" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

const ghz = (mhz: number | null | undefined): string | null => (mhz != null && Number.isFinite(mhz) && mhz > 0 ? (mhz / 1000).toFixed(1) : null);

/* ------------------------------------------------------------------ CPU */

export function CpuPanel({ cpu, ctx }: { cpu: CpuSpec; ctx: RowCtx }) {
  const { latest } = useTelemetry();
  const sub = [displayCodename(cpu), cpu.socket ? `Socket ${cpu.socket}` : null, cpu.vendor !== "Other" ? cpu.vendor : null].filter(Boolean).join(" · ");
  const l3 = cpu.caches.find((c) => c.level === 3);
  const l3Total = l3 ? fmtKb(l3.sizeKb * Math.max(1, l3.instances)).split(" ") : null;
  const stats: HeroStat[] = [
    { label: "Cores", value: String(cpu.cores) },
    { label: "Threads", value: String(cpu.threads) },
    { label: "Base clock", value: ghz(cpu.baseClockMhz), unit: "GHz" },
    {
      label: "Clock now",
      value: ghz(latest?.cpu?.clockMhz),
      unit: "GHz",
      title: "Average effective clock of all cores right now.",
    },
    { label: "L3 cache", value: l3Total ? l3Total[0] : null, unit: l3Total?.[1] },
  ];
  return (
    <div className={STACK}>
      <SpecHero icon={Cpu} title={cpu.name} sub={sub || null} stats={stats} />
      <div className={GRID}>
        <SpecCard title="Identification" className="col-span-7" rows={cpuRows(cpu, ctx)} />
        <div className={cn(STACK, "col-span-5")}>
          <SpecCard title="Cache" actions="per level">
            {cpu.caches.length === 0 ? (
              <div className="py-2">
                <Unavailable reason={ctx.missing} />
              </div>
            ) : (
              <table className={TABLE}>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>Level</th>
                    <th scope="col" className={TH}>Type</th>
                    <th scope="col" className={cn(TH, "text-right")}>Size × instances</th>
                    <th scope="col" className={cn(TH, "text-right")}>Ways</th>
                  </tr>
                </thead>
                <tbody>
                  {cpu.caches.map((c, i) => (
                    <tr key={`${c.level}-${c.type}-${c.sizeKb}-${i}`} className="group">
                      <td className={cn(TD, "text-ink")}>L{c.level}</td>
                      <td className={cn(TD, "text-ink")}>{cacheTypeLabel[c.type]}</td>
                      <td className={cn(TD, "text-right text-ink")}>
                        {fmtKb(c.sizeKb)} × {Math.max(1, c.instances)}
                      </td>
                      <td className={cn(TD, "text-right text-ink")} title={c.ways == null ? "Fully associative or not reported" : cacheWays(c)}>
                        {c.ways == null ? "—" : c.ways}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SpecCard>
          <SpecCard
            title="Instructions"
            className="flex-1"
            actions={cpu.instructions.length > 0 ? `${cpu.instructions.length} extension${cpu.instructions.length === 1 ? "" : "s"}` : undefined}
          >
            {cpu.instructions.length === 0 ? (
              <Unavailable reason={ctx.missing} />
            ) : (
              <ul className="flex flex-wrap gap-1.5" aria-label="Supported instruction sets">
                {cpu.instructions.map((ins) => (
                  <li key={ins}>
                    <Tag className="h-[22px] px-2 text-[11.5px] font-medium text-ink">{ins}</Tag>
                  </li>
                ))}
              </ul>
            )}
          </SpecCard>
        </div>
        <CoresNow />
      </div>
    </div>
  );
}

/** Live per-core load from the telemetry every view already receives (no extra query). */
function CoresNow() {
  const { latest, history } = useTelemetry();
  const cpu = latest?.cpu;
  const n = cpu?.loadPerCore?.length ?? 0;
  const series = useMemo(() => {
    const out: (number | null)[][] = Array.from({ length: n }, () => []);
    for (const p of history ?? []) {
      const loads = p.cpu?.loadPerCore ?? [];
      for (let i = 0; i < n; i++) {
        const v = loads[i];
        out[i].push(typeof v === "number" && Number.isFinite(v) ? v : null);
      }
    }
    return out;
  }, [history, n]);
  if (!cpu || n === 0) return null;
  const cols = Math.min(n, 8);
  return (
    <GlassCard title="Cores now" actions={`Per-core load (${cpu.cores}C/${cpu.threads}T)`} className="col-span-12">
      <div className="grid gap-y-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cpu.loadPerCore.map((load, i) => (
          <div key={i} className={cn("min-w-0 border-l border-divider px-4", i % cols === 0 && "border-l-0 pl-0", i % cols === cols - 1 && "pr-0")}>
            <div className="text-caption font-medium text-ink-2">Core {i}</div>
            <div className="tnum mt-1 whitespace-nowrap text-[18px] font-semibold leading-6 tracking-[-0.01em] text-ink">
              {Number.isFinite(load) ? Math.round(load) : "—"}
              <small className="ml-0.5 text-[11.5px] font-medium tracking-normal text-ink-3">%</small>
            </div>
            <div className="mt-2 h-7">
              <Sparkline data={series[i]} color="var(--color-series-cpu)" height={28} min={0} max={100} strokeWidth={1.25} fill />
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ Mainboard */

export function BoardPanel({ board, ctx }: { board: BoardSpec; ctx: RowCtx }) {
  const biosDate = board.biosDate?.trim() ? fmtDate(board.biosDate) : null;
  return (
    <div className={STACK}>
      <SpecHero
        icon={CircuitBoard}
        title={fmtBoardName(board.manufacturer, board.product)}
        sub={[board.version?.trim() ? `Version ${board.version.trim()}` : null, board.superIo ? `Super I/O ${board.superIo}` : null].filter(Boolean).join(" · ") || null}
        stats={[
          { label: "BIOS version", value: board.biosVersion?.trim() || null },
          { label: "BIOS date", value: biosDate },
        ]}
      />
      <div className={GRID}>
        <SpecCard title="Motherboard" className="col-span-7" rows={boardRows(board, ctx)} />
        <SpecCard title="BIOS" className="col-span-5" rows={biosRows(board, ctx)} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Memory */

function commonPart(memory: MemorySpec): string | null {
  const parts = memory.dimms.map((d) => [d.manufacturer.trim(), d.partNumber.trim()].filter(Boolean).join(" ")).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every((p) => p === parts[0]) ? parts[0] : null;
}

function memorySpeed(memory: MemorySpec): number | null {
  for (const d of memory.dimms) {
    const s = d.configuredSpeedMts ?? d.speedMts;
    if (s != null && s > 0) return s;
  }
  return null;
}

export function MemoryPanel({
  memory,
  ctx,
  onOpenSlot,
}: {
  memory: MemorySpec;
  ctx: RowCtx;
  onOpenSlot: (slot: string) => void;
}) {
  const { latest } = useTelemetry();
  const speed = memorySpeed(memory);
  const coupling = memoryCoupling(memory);
  const type = memory.type !== "Unknown" ? memory.type : "";
  const title = `${fmtSizeGb(Math.round(memory.totalGb))} ${type}${type && speed ? `-${speed}` : ""}`.trim();
  const sub = [
    memory.channels != null ? `${fmtChannels(memory.channels)} channel` : null,
    fmtDimmCount(memory.slotsUsed, memory.slotsTotal),
    commonPart(memory),
  ]
    .filter(Boolean)
    .join(" · ");
  const live = memory.timingsSource === "umc";
  const stats: HeroStat[] = [
    { label: "In use", value: latest?.ram ? latest.ram.usedGb.toFixed(1) : null, unit: "GB", title: "Memory in use right now." },
    { label: "Speed", value: speed != null ? fmtCount(speed) : null, unit: "MT/s" },
    ...(memory.timings?.cl != null
      ? [
          {
            label: live ? "CAS latency" : "CAS latency (SPD)",
            value: String(memory.timings.cl),
            unit: "CL",
            title: TIMINGS_SOURCE_HINT[memory.timingsSource],
          },
        ]
      : []),
    ...(coupling.coupled != null ? [{ label: "FCLK : MEMCLK", value: coupling.coupled ? "1 : 1" : "Not 1 : 1", title: `${coupling.text}. ${coupling.hint}` }] : []),
  ];
  const anyTemp = memory.dimms.some((d) => d.spd?.tempC != null);
  const empty = memory.slotsTotal != null ? Math.max(0, memory.slotsTotal - memory.dimms.length) : 0;
  const temp = (c: number) => `${toTempUnit(c, ctx.tempUnit ?? "C").toFixed(1)} °${ctx.tempUnit ?? "C"}`;

  return (
    <div className={STACK}>
      <SpecHero icon={MemoryStick} title={title} sub={sub || null} stats={stats} />
      <div className={GRID}>
        <TimingsCard memory={memory} ctx={ctx} className="col-span-6" />
        <div className={cn(STACK, "col-span-6")}>
          <SpecCard title="Modules" actions={memory.slotsTotal != null ? `${memory.slotsUsed} of ${memory.slotsTotal} slots used` : undefined}>
            {memory.dimms.length === 0 ? (
              <div className="py-2">
                <Unavailable reason={ctx.missing} />
              </div>
            ) : (
              <table className={cn(TABLE, "table-fixed")}>
                <colgroup>
                  <col className="w-[104px]" />
                  <col className="w-[64px]" />
                  <col />
                  <col className="w-[100px]" />
                  {anyTemp && <col className="w-[76px]" />}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>Slot</th>
                    <th scope="col" className={cn(TH, "text-right")}>Size</th>
                    <th scope="col" className={cn(TH, "pl-3")}>Part number</th>
                    <th scope="col" className={cn(TH, "text-right")}>Speed</th>
                    {anyTemp && <th scope="col" className={cn(TH, "text-right")}>Temp</th>}
                  </tr>
                </thead>
                <tbody>
                  {memory.dimms.map((d, i) => (
                    <tr key={`${d.slot}-${i}`} className="group">
                      <td className={cn(TD, "truncate")}>
                        <button
                          type="button"
                          onClick={() => onOpenSlot(d.slot)}
                          title={`Show ${d.slot || `module ${i + 1}`} in the SPD tab`}
                          className="rounded-xs font-medium text-ink hover:underline"
                        >
                          {d.slot || `Module ${i + 1}`}
                        </button>
                      </td>
                      <td className={cn(TD, "text-right text-ink")}>{fmtSizeGb(d.sizeGb)}</td>
                      <td className={cn(TD, "truncate pl-3 font-mono text-[11.5px] text-ink")} title={d.partNumber}>
                        {d.partNumber.trim() || "—"}
                      </td>
                      <td className={cn(TD, "whitespace-nowrap text-right text-ink")}>
                        {d.configuredSpeedMts ? fmtMts(d.configuredSpeedMts) : d.speedMts ? fmtMts(d.speedMts) : "—"}
                      </td>
                      {anyTemp && <td className={cn(TD, "text-right text-ink")}>{d.spd?.tempC != null ? temp(d.spd.tempC) : "—"}</td>}
                    </tr>
                  ))}
                  {empty > 0 && (
                    <tr className="group">
                      <td className={cn(TD, "text-ink-3")} colSpan={anyTemp ? 5 : 4}>
                        {empty} empty slot{empty === 1 ? "" : "s"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </SpecCard>
          <ClocksCard memory={memory} />
        </div>
        <MemoryUsage />
      </div>
    </div>
  );
}

function TimingsCard({ memory, ctx, className }: { memory: MemorySpec; ctx: RowCtx; className?: string }) {
  const src = memory.timingsSource;
  const rows = timingRows(memory, ctx);
  return (
    <SpecCard
      title="Timings"
      className={className}
      actions={
        <SourceChip live={src === "umc"} title={TIMINGS_SOURCE_HINT[src]}>
          {TIMINGS_SOURCE_LABEL[src]}
        </SourceChip>
      }
    >
      {rows.length > 0 ? (
        <>
          <SpecRows rows={rows} />
          {/* The chip can truncate at narrow widths: SPD values are never shown without this sentence. */}
          {src === "spd" && <Note>{SPD_NOT_RUNNING_NOTE}</Note>}
        </>
      ) : (
        <div className="py-1.5">
          {memory.timingsNote ? (
            <span className="inline-flex items-center gap-1.5 text-body text-ink-3">
              <span aria-hidden="true">—</span>
              Not available
            </span>
          ) : (
            <Unavailable reason={ctx.missing} />
          )}
        </div>
      )}
      {memory.timingsNote && <Note>{memory.timingsNote}</Note>}
    </SpecCard>
  );
}

function ClocksCard({ memory }: { memory: MemorySpec }) {
  const c = memoryCoupling(memory);
  // The 1:1 line is the card's header meta here; "Copy as text" keeps it as a row.
  const rows = clockRows(memory).filter((r) => r.label !== "FCLK : UCLK : MEMCLK");
  return (
    <SpecCard
      title="Clocks"
      className="flex-1"
      actions={
        <span title={c.hint} className="truncate">
          {c.text}
        </span>
      }
    >
      <SpecRows rows={rows} />
      <Note>
        MEMCLK is the memory clock (half the MT/s rating). FCLK is the Infinity Fabric clock and UCLK the memory-controller
        clock, read from the processor&rsquo;s power-management table when it reports them.
      </Note>
    </SpecCard>
  );
}

/** Live memory use from telemetry: in use against available, and the share in use over the last two minutes. */
function MemoryUsage() {
  const { latest, history } = useTelemetry();
  const ram = latest?.ram ?? null;
  const option = useMemo<EChartsOption>(() => {
    const hist = history ?? [];
    const last = hist.length > 0 ? hist[hist.length - 1].ts : 0;
    const data = hist.map((p) => [Math.round((p.ts - last) / 100) / 10, p.ram?.loadPct ?? null] as [number, number | null]);
    return {
      animation: false,
      grid: { left: 36, right: 6, top: 6, bottom: 22, containLabel: false },
      xAxis: {
        type: "value",
        min: -120,
        max: 0,
        interval: 60,
        axisLabel: {
          formatter: (v: number) => (v === 0 ? "Now" : `−${Math.abs(v) / 60} min`),
          showMinLabel: true,
          showMaxLabel: true,
          alignMinLabel: "left",
          alignMaxLabel: "right",
        },
        axisLine: { show: true, lineStyle: { color: CHART_HEX.axis, width: 1 } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: { type: "value", min: 0, max: 100, interval: 50, axisLabel: { formatter: "{value}%" } },
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (Array.isArray(params) ? params[0] : params) as { value?: [number, number | null] } | undefined;
          if (!p?.value) return "";
          const [x, v] = p.value;
          return `<span style="color:${CHART_HEX.label}">${x === 0 ? "Now" : `${Math.abs(Math.round(x))} s ago`}</span><br/>In use <b>${v == null ? "—" : `${Math.round(v)}%`}</b>`;
        },
      },
      series: [nexumLine("In use", "ram", [], "%", { data, endLabel: { show: false }, areaStyle: { opacity: 0.08 } })],
    } as EChartsOption;
  }, [history]);

  if (!ram || !(ram.totalGb > 0)) return null;
  const used = Math.max(0, ram.usedGb);
  const avail = Math.max(0, ram.availableGb);
  return (
    <GlassCard className="col-span-12">
      <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-stretch gap-8">
        <div className="min-w-0">
          <div className="mb-1.5 flex min-h-[22px] items-center justify-between gap-3">
            <h3 className="text-title-2 text-ink">Usage</h3>
            <span className="tnum text-callout text-ink-2">{ram.totalGb.toFixed(1)} GB usable</span>
          </div>
          <div
            className="my-1.5 flex h-3 gap-0.5 overflow-hidden rounded-sm"
            role="img"
            aria-label={`${used.toFixed(1)} GB in use, ${avail.toFixed(1)} GB available`}
          >
            <span className="block h-full bg-series-ram" style={{ flex: used }} />
            <span className="block h-full bg-meter-track" style={{ flex: avail }} />
          </div>
          <dl className="tnum mt-4 flex gap-x-7">
            <UsageFigure swatch="bg-series-ram" label="In use" value={used.toFixed(1)} />
            <UsageFigure swatch="bg-meter-track shadow-[inset_0_0_0_0.5px_var(--color-subtle)]" label="Available" value={avail.toFixed(1)} />
          </dl>
        </div>
        <div className="relative min-h-[112px]">
          <div className="absolute inset-0">
            <EChart option={option} notMerge />
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

function UsageFigure({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <dt className="flex items-center gap-1.5 text-callout text-ink-2">
        <span aria-hidden="true" className={cn("h-2 w-2 rounded-[2px]", swatch)} />
        {label}
      </dt>
      <dd className="text-[15px] font-semibold leading-none text-ink">
        {value}
        <small className="ml-0.5 text-[11.5px] font-medium text-ink-3">GB</small>
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------------ SPD */

export function SpdPanel({
  memory,
  ctx,
  slot,
  onSlot,
}: {
  memory: MemorySpec;
  ctx: RowCtx;
  slot: string | null;
  onSlot: (slot: string) => void;
}) {
  const dimms = memory.dimms;
  if (dimms.length === 0) {
    return <SectionUnavailable title="Memory modules" reason={ctx.missing} detail="The firmware did not list any memory modules." />;
  }
  const index = Math.max(0, dimms.findIndex((d) => d.slot === slot));
  const d = dimms[index];
  const anySpd = dimms.some((m) => m.spd != null);
  // Slot labels can repeat on some boards; keep the picker keyed by position.
  const options = dimms.map((m, i) => ({ value: i, label: m.slot || `Module ${i + 1}` }));
  const type = memory.type !== "Unknown" ? memory.type : "";
  const unit = ctx.tempUnit ?? "C";
  return (
    <div className={STACK}>
      <SpecHero
        icon={MemoryStick}
        title={`${fmtSizeGb(d.sizeGb)} ${type} ${d.formFactor}`.replace(/\s+/g, " ").trim()}
        sub={[d.manufacturer.trim(), d.partNumber.trim()].filter(Boolean).join(" · ") || null}
        stats={[
          { label: "Rated speed", value: d.speedMts != null && d.speedMts > 0 ? fmtCount(d.speedMts) : null, unit: "MT/s" },
          { label: "Configured", value: d.configuredSpeedMts != null && d.configuredSpeedMts > 0 ? fmtCount(d.configuredSpeedMts) : null, unit: "MT/s" },
          ...(d.spd?.tempC != null ? [{ label: "Temperature", value: toTempUnit(d.spd.tempC, unit).toFixed(1), unit: `°${unit}` }] : []),
        ]}
      >
        {dimms.length > 1 && (
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="text-callout text-ink-2">Slot</span>
            <Segmented value={index} options={options} onChange={(i) => onSlot(dimms[i].slot)} ariaLabel="Memory slot" size="sm" />
          </div>
        )}
      </SpecHero>
      <div className={GRID}>
        <SpecCard title="Module" className="col-span-6" rows={dimmRows(d, ctx)} />
        {d.spd ? (
          <SpdTimingsCard spd={d.spd} className="col-span-6" />
        ) : (
          <SpecCard title="JEDEC timings" className="col-span-6">
            <div className="py-1">
              <Unavailable reason={anySpd ? "unsupported" : ctx.superIo} />
            </div>
            <Note>
              {anySpd
                ? "Nexum could not match this slot to an SPD chip."
                : "SPD timings are read from the module's SPD chip, which needs administrator rights and the PawnIO driver."}
            </Note>
          </SpecCard>
        )}
        <GlassCard title="About this data" className="col-span-12">
          <div className="space-y-2 text-body text-ink-2">
            <p>
              Module details come from the motherboard&rsquo;s SMBIOS tables, which Windows reads without a driver. JEDEC timings
              come from the module&rsquo;s SPD chip: they are the minimum times the module supports at its rated JEDEC speed, not
              necessarily the timings the BIOS runs. The Memory tab shows the running timings when they can be read.
            </p>
            <p>XMP and EXPO profiles are not read in this version.</p>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

function SpdTimingsCard({ spd, className }: { spd: SpdInfo; className?: string }) {
  const cyc = spdCycleRows(spd);
  const ns = spdNsRows(spd);
  return (
    <SpecCard
      title={spd.jedecSpeedMts != null ? `JEDEC timings at ${fmtCount(spd.jedecSpeedMts)} MT/s` : "JEDEC timings"}
      className={className}
      actions={<SourceChip title={TIMINGS_SOURCE_HINT.spd}>SPD JEDEC</SourceChip>}
    >
      {cyc.length > 0 ? (
        <SpecRows rows={cyc} />
      ) : (
        <Note>The rated speed is not reported, so the times below cannot be converted to clock cycles.</Note>
      )}
      {ns.length > 0 && (
        <details className="mt-3 rounded-lg bg-inset px-3 py-2">
          <summary className="text-callout font-medium text-ink">Minimum times in nanoseconds ({ns.length})</summary>
          <div className="mt-1.5">
            <SpecRows rows={ns} />
          </div>
        </details>
      )}
      <p className="mt-2.5 text-callout text-ink-3">
        Cycles = ceil(ns ÷ clock period − 0.025), the JEDEC rounding rule.
        {spd.matchedBy === "order" ? " Matched to this slot by module order." : " Matched to this slot by part number."}
      </p>
    </SpecCard>
  );
}

/* ------------------------------------------------------------------ Graphics */

export function GraphicsPanel({ gpus, ctx }: { gpus: GpuSpec[]; ctx: RowCtx }) {
  return (
    <div className={STACK}>
      {gpus.map((g, i) => {
        const link = g.link ? fmtPcieLink({ gen: g.link.gen, width: g.link.width, maxGen: null, maxWidth: null }) : null;
        return (
          <div key={`${g.name}-${i}`} className={STACK}>
            <SpecHero
              icon={i === 0 ? Monitor : MonitorCog}
              title={g.name}
              sub={[gpus.length > 1 ? `GPU ${i + 1}` : null, GPU_VENDOR_LABEL[g.vendor] ?? "Other", g.driverVersion?.trim() ? `Driver ${g.driverVersion.trim()}` : null]
                .filter(Boolean)
                .join(" · ")}
              stats={[
                { label: "Video memory", value: g.vramGb != null ? g.vramGb.toFixed(1) : null, unit: "GB" },
                { label: "PCIe link", value: link, title: PCIE_IDLE_HINT },
              ]}
            />
            {/* Adapter (7) + Driver (5), the same split as Mainboard: no row stretches across the whole page. */}
            <div className={GRID}>
              <SpecCard title="Adapter" className="col-span-7" rows={gpuRows(g, ctx).filter((r) => !r.label.startsWith("Driver"))}>
                {g.link && (
                  <Note>
                    {g.link.source === "adl" ? "Link read through the AMD driver. " : g.link.source === "devpkey" ? "Link reported by Windows. " : ""}
                    {PCIE_IDLE_HINT}
                  </Note>
                )}
                {g.link?.note && <Note>{g.link.note}</Note>}
              </SpecCard>
              <SpecCard
                title="Driver"
                className="col-span-5"
                rows={gpuRows(g, ctx)
                  .filter((r) => r.label.startsWith("Driver"))
                  // The card is titled "Driver": its rows read "Version" and "Date".
                  .map((r) => ({ ...r, label: r.label.replace(/^Driver (.)/, (_m, c: string) => c.toUpperCase()) }))}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ OS & Security */

export function OsPanel({
  os,
  security,
  ctx,
  diskLinks,
  disks,
}: {
  os: OsSpec;
  security: SecuritySpec;
  ctx: RowCtx;
  diskLinks: readonly DiskLink[];
  disks: readonly PhysicalDisk[];
}) {
  // Uptime is derived from bootTs (CONTRACT §4.8); tick locally so only this panel re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const rows = osRows(os, now, ctx);
  const up = os.bootTs > 0 ? (now - os.bootTs) / 1000 : null;
  return (
    <div className={STACK}>
      <SpecHero
        icon={Monitor}
        title={os.caption || "Windows"}
        sub={[os.displayVersion, os.build ? `Build ${os.build}` : "", os.architecture].filter(Boolean).join(" · ") || null}
        stats={[
          { label: "Uptime", value: up != null && up >= 0 ? fmtUptime(up) : null, title: "Time since Windows started." },
          { label: "Installed", value: os.installDate?.trim() ? fmtDate(os.installDate) : null },
        ]}
      />
      <div className={GRID}>
        <SpecCard title="Operating system" className="col-span-7" rows={rows.filter((r) => r.label !== "Uptime")} />
        <SpecCard title="Security" className="col-span-5" rows={securityRows(security, ctx)} />
        <StorageLinksCard links={diskLinks} disks={disks} ctx={ctx} />
      </div>
    </div>
  );
}

function StorageLinksCard({ links, disks, ctx }: { links: readonly DiskLink[]; disks: readonly PhysicalDisk[]; ctx: RowCtx }) {
  const sorted = [...links].sort((a, b) => a.diskNumber - b.diskNumber);
  return (
    <SpecCard title="Storage links" className="col-span-12" actions="How each drive is connected">
      {sorted.length === 0 ? (
        <div className="py-1">
          <Unavailable reason={ctx.missing} />
        </div>
      ) : (
        <table className={cn(TABLE, "table-fixed")}>
          <colgroup>
            <col className="w-[64px]" />
            <col />
            <col className="w-[80px]" />
            <col className="w-[38%]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={TH}>Disk</th>
              <th scope="col" className={TH}>Drive</th>
              <th scope="col" className={TH}>Bus</th>
              <th scope="col" className={TH}>Link</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const name = diskLinkName(l, disks);
              const link = diskLinkText(l);
              return (
                <tr key={l.diskNumber} className="group">
                  <td className={cn(TD, "text-ink-2")}>{l.diskNumber}</td>
                  <td className={cn(TD, "truncate pr-3 text-ink")} title={name}>
                    {name}
                  </td>
                  <td className={cn(TD, "text-ink")}>{diskBusLabel(l)}</td>
                  <td className={cn(TD, "truncate text-ink")} title={l.bus === "nvme" ? `${link}. ${PCIE_IDLE_HINT}` : link}>
                    {link}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SpecCard>
  );
}
