import { useEffect, useState } from "react";
import { Cpu, MemoryStick, MonitorSpeaker } from "lucide-react";
import type { CpuTelemetry, GpuTelemetry, RamTelemetry } from "../../types";
import GlassCard from "../layout/GlassCard";
import { DottedLeaderRow, SegmentedBar } from "../ui";
import { cn, fmtMhz, fmtRpm, fmtTemp } from "../../lib/format";

type Unit = "C" | "F";

const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const dash = "—";

function t(c: number | null | undefined, unit: Unit) {
  return fin(c) ? fmtTemp(c, unit) : dash;
}
function mhz(n: number | null | undefined) {
  return fin(n) ? fmtMhz(n) : dash;
}
function watts(n: number | null | undefined) {
  return fin(n) ? `${n.toFixed(n >= 100 ? 0 : 1)} W` : dash;
}
function pct(n: number | null | undefined) {
  return fin(n) ? `${n.toFixed(0)}%` : dash;
}
function gb(n: number | null | undefined, d = 1) {
  return fin(n) ? `${n.toFixed(d)} GB` : dash;
}

function loadColor(v: number) {
  if (v >= 90) return "bg-rose";
  if (v >= 65) return "bg-gold";
  return "bg-teal";
}

function tempClass(c: number | null | undefined) {
  if (!fin(c)) return "text-muted";
  if (c >= 90) return "text-rose";
  if (c >= 75) return "text-gold";
  return "text-ink";
}

function BigReadout({ label, value, unit, className }: { label: string; value: string; unit?: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={cn("font-mono text-[24px] font-semibold leading-none", className ?? "text-ink")}>{value}</span>
        {unit && <span className="font-mono text-[11px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-white/[0.04]" />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------- CPU */

export function CpuPanel({ cpu, unit }: { cpu: CpuTelemetry | null; unit: Unit }) {
  const cores = cpu?.loadPerCore ?? [];
  return (
    <GlassCard title="Processor" icon={<Cpu size={15} />} accent="teal">
      {!cpu ? (
        <Skeleton />
      ) : (
        <div className="space-y-4">
          <div className="truncate text-[13.5px] font-semibold text-ink" title={cpu.name}>
            {cpu.name || "Unknown CPU"}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <BigReadout label="Load" value={fin(cpu.loadTotal) ? cpu.loadTotal.toFixed(0) : dash} unit="%" className="text-teal" />
            <BigReadout label="Package" value={t(cpu.packageTempC, unit)} className={tempClass(cpu.packageTempC)} />
            <BigReadout label="Power" value={fin(cpu.powerW) ? cpu.powerW.toFixed(0) : dash} unit="W" />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-muted">
              <span>Per-thread load</span>
              <span className="font-mono normal-case tracking-normal">{cores.length} logical</span>
            </div>
            {cores.length === 0 ? (
              <div className="py-4 text-center text-[11.5px] text-muted">Per-core data unavailable</div>
            ) : (
              <div
                className="grid gap-[3px]"
                style={{ gridTemplateColumns: `repeat(${Math.min(cores.length, cores.length > 16 ? 16 : cores.length)}, minmax(0, 1fr))` }}
              >
                {cores.map((v, i) => {
                  const val = fin(v) ? Math.max(0, Math.min(100, v)) : 0;
                  return (
                    <div key={i} className="group relative" title={`Core #${i}: ${val.toFixed(0)}%`}>
                      <div className="flex h-12 items-end overflow-hidden rounded-[3px] bg-white/[0.05]">
                        <div
                          className={cn("w-full rounded-[3px] transition-[height] duration-500", loadColor(val))}
                          style={{ height: `${Math.max(2, val)}%`, opacity: 0.35 + (val / 100) * 0.65 }}
                        />
                      </div>
                      <div className="mt-0.5 text-center font-mono text-[8.5px] text-muted">{i}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <DottedLeaderRow label="Clock" value={mhz(cpu.clockMhz)} valueClassName="font-mono" />
            <DottedLeaderRow label="Max boost observed" value={mhz(cpu.maxClockMhz)} valueClassName="font-mono" />
            <DottedLeaderRow label="Core voltage" value={fin(cpu.voltage) ? `${cpu.voltage.toFixed(3)} V` : dash} valueClassName="font-mono" />
            <DottedLeaderRow label="Package power" value={watts(cpu.powerW)} valueClassName="font-mono" />
            <DottedLeaderRow label="Cores / Threads" value={`${cpu.cores || dash} / ${cpu.threads || dash}`} valueClassName="font-mono" />
          </div>
        </div>
      )}
    </GlassCard>
  );
}

/* --------------------------------------------------------------------------- GPU */

export function GpuPanel({ gpus, primary, unit }: { gpus: GpuTelemetry[]; primary: GpuTelemetry | null; unit: Unit }) {
  const list = gpus.length > 0 ? gpus : primary ? [primary] : [];
  const primaryIdx = primary ? Math.max(0, list.findIndex((g) => g.name === primary.name)) : 0;
  const [idx, setIdx] = useState(primaryIdx);
  useEffect(() => {
    if (idx >= list.length) setIdx(0);
  }, [idx, list.length]);
  const gpu = list[idx] ?? null;

  const vramPct =
    gpu && fin(gpu.vramUsedGb) && fin(gpu.vramTotalGb) && gpu.vramTotalGb > 0 ? (gpu.vramUsedGb / gpu.vramTotalGb) * 100 : null;

  return (
    <GlassCard
      title="Graphics"
      icon={<MonitorSpeaker size={15} />}
      accent="gold"
      actions={
        list.length > 1 ? (
          <div className="flex gap-1">
            {list.map((g, i) => (
              <button
                key={`${g.name}-${i}`}
                type="button"
                onClick={() => setIdx(i)}
                title={g.name}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10.5px] transition",
                  i === idx ? "bg-gold/15 text-gold" : "text-muted hover:text-silver",
                )}
              >
                GPU{i}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      {!gpu ? (
        <div className="py-10 text-center text-[12px] text-muted">No GPU sensors reported</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-ink" title={gpu.name}>
              {gpu.name || "Unknown GPU"}
            </span>
            <span className="shrink-0 rounded border border-gold/35 bg-gold/10 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-gold">
              {gpu.vendor}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <BigReadout label="Load" value={fin(gpu.load) ? gpu.load.toFixed(0) : dash} unit={fin(gpu.load) ? "%" : undefined} className="text-gold" />
            <BigReadout label="Core" value={t(gpu.tempC, unit)} className={tempClass(gpu.tempC)} />
            <BigReadout label="Power" value={fin(gpu.powerW) ? gpu.powerW.toFixed(0) : dash} unit={fin(gpu.powerW) ? "W" : undefined} />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-muted">
              <span>VRAM</span>
              <span className="font-mono normal-case tracking-normal text-silver">
                {gb(gpu.vramUsedGb)} / {gb(gpu.vramTotalGb, 0)}
              </span>
            </div>
            <SegmentedBar value={vramPct ?? 0} segments={28} tone={vramPct != null && vramPct >= 90 ? "rose" : "purple"} />
          </div>

          <div className="space-y-1.5">
            <DottedLeaderRow label="Core clock" value={mhz(gpu.coreClockMhz)} valueClassName="font-mono" />
            <DottedLeaderRow label="Memory clock" value={mhz(gpu.memClockMhz)} valueClassName="font-mono" />
            <DottedLeaderRow label="Hotspot" value={t(gpu.hotspotTempC, unit)} valueClassName={cn("font-mono", tempClass(gpu.hotspotTempC))} />
            <DottedLeaderRow label="Board power" value={watts(gpu.powerW)} valueClassName="font-mono" />
            <DottedLeaderRow
              label="Fan"
              value={fin(gpu.fanRpm) ? `${fmtRpm(gpu.fanRpm)}${fin(gpu.fanPct) ? ` · ${pct(gpu.fanPct)}` : ""}` : pct(gpu.fanPct)}
              valueClassName="font-mono"
            />
          </div>
        </div>
      )}
    </GlassCard>
  );
}

/* --------------------------------------------------------------------------- RAM */

export function RamPanel({ ram }: { ram: RamTelemetry | null }) {
  const slotsTotal = ram && fin(ram.slotsTotal) && ram.slotsTotal > 0 ? Math.min(16, ram.slotsTotal) : null;
  const slotsUsed = ram && fin(ram.slotsUsed) ? ram.slotsUsed : null;

  return (
    <GlassCard title="Memory" icon={<MemoryStick size={15} />} accent="purple">
      {!ram ? (
        <Skeleton />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <BigReadout label="Used" value={fin(ram.usedGb) ? ram.usedGb.toFixed(1) : dash} unit="GB" className="text-[#c084fc]" />
            <BigReadout label="Available" value={fin(ram.availableGb) ? ram.availableGb.toFixed(1) : dash} unit="GB" />
            <BigReadout label="Total" value={fin(ram.totalGb) ? ram.totalGb.toFixed(0) : dash} unit="GB" />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-muted">
              <span>Load</span>
              <span className="font-mono normal-case tracking-normal text-silver">{pct(ram.loadPct)}</span>
            </div>
            <SegmentedBar
              value={fin(ram.loadPct) ? ram.loadPct : 0}
              segments={28}
              tone={fin(ram.loadPct) && ram.loadPct >= 90 ? "rose" : fin(ram.loadPct) && ram.loadPct >= 75 ? "gold" : "purple"}
            />
          </div>

          {slotsTotal != null && (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted">Slot configuration</div>
              <div className="flex gap-1.5">
                {Array.from({ length: slotsTotal }).map((_, i) => {
                  const filled = slotsUsed != null && i < slotsUsed;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex h-9 flex-1 flex-col items-center justify-end rounded-[3px] border pb-0.5",
                        filled
                          ? "border-purple/60 bg-purple/20 shadow-[0_0_10px_rgba(147,51,234,0.35)]"
                          : "border-dashed border-white/12 bg-transparent",
                      )}
                      title={filled ? `Slot ${i + 1}: populated` : `Slot ${i + 1}: empty`}
                    >
                      <span className={cn("font-mono text-[8.5px]", filled ? "text-[#c084fc]" : "text-muted")}>{i + 1}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <DottedLeaderRow label="Speed" value={fin(ram.speedMts) ? `${Math.round(ram.speedMts)} MT/s` : dash} valueClassName="font-mono" />
            <DottedLeaderRow label="Form factor" value={ram.formFactor || dash} />
            <DottedLeaderRow
              label="Slots"
              value={slotsUsed != null && fin(ram.slotsTotal) ? `${slotsUsed} of ${ram.slotsTotal} used` : dash}
              valueClassName="font-mono"
            />
          </div>
        </div>
      )}
    </GlassCard>
  );
}
