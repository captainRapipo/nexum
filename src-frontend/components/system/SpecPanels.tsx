import { useEffect, useState } from "react";
import { CircuitBoard, Cpu, Info, Layers, MemoryStick, Monitor, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import type { CpuSpec, GpuSpec, MemorySpec, OsSpec, SecuritySpec, BoardSpec, UnavailableReason } from "../../types";
import { cn, fmtBoardName } from "../../lib/format";
import GlassCard from "../layout/GlassCard";
import { Segmented } from "../ui/Segmented";
import { Unavailable } from "../ui/Unavailable";
import { SpecCard, SpecRows } from "./SpecCard";
import {
  biosRows,
  boardRows,
  cacheName,
  cacheSize,
  cacheTypeLabel,
  cacheWays,
  cpuRows,
  dimmRows,
  fmtMts,
  fmtSizeGb,
  gpuRows,
  memoryRows,
  osRows,
  securityRows,
  type RowCtx,
} from "./specModel";

/* ------------------------------------------------------------------ shared */

function Hero({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-2 border-b border-line pb-2.5">
      <div className="truncate text-[15px] font-semibold tracking-tight text-ink" title={title}>
        {title}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** Whole section missing (agent offline or the section query failed). */
export function SectionUnavailable({ title, reason, detail }: { title: string; reason: UnavailableReason; detail: string }) {
  return (
    <GlassCard title={title} icon={Info}>
      <div className="flex flex-col items-start gap-2 py-6">
        <Unavailable reason={reason} className="text-[13px]" />
        <p className="text-[12px] text-muted">{detail}</p>
      </div>
    </GlassCard>
  );
}

const thCls = "label-caps pb-1.5 text-left font-semibold [--label-color:#64748b] [--label-size:10px]";

/* ------------------------------------------------------------------ CPU */

export function CpuPanel({ cpu, ctx }: { cpu: CpuSpec; ctx: RowCtx }) {
  const rows = cpuRows(cpu, ctx).filter((r) => r.label !== "Name");
  const sub = [cpu.vendor !== "Other" ? cpu.vendor : null, cpu.codename, cpu.socket ? `Socket ${cpu.socket}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SpecCard title="Processor" icon={Cpu}>
        <Hero title={cpu.name} sub={sub || undefined} />
        <SpecRows rows={rows} />
      </SpecCard>

      <SpecCard title="Caches" icon={Layers}>
        {cpu.caches.length === 0 ? (
          <div className="py-4">
            <Unavailable reason={ctx.missing} />
          </div>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <th scope="col" className={thCls}>Level</th>
                <th scope="col" className={thCls}>Type</th>
                <th scope="col" className={cn(thCls, "text-right")}>Size</th>
                <th scope="col" className={cn(thCls, "text-right")}>Ways</th>
              </tr>
            </thead>
            <tbody>
              {cpu.caches.map((c, i) => (
                <tr key={`${c.level}-${c.type}-${c.sizeKb}-${i}`} className="border-t border-white/[0.05]">
                  <td className="py-[6px] font-semibold text-slate-200">{cacheName(c)}</td>
                  <td className="py-[6px] text-slate-400">{cacheTypeLabel[c.type]}</td>
                  <td className="num py-[6px] text-right text-ink">{cacheSize(c)}</td>
                  <td
                    className="num py-[6px] text-right text-slate-300"
                    title={c.ways == null ? "Fully associative or not reported" : undefined}
                  >
                    {cacheWays(c)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SpecCard>

      <SpecCard title="Instructions" icon={Sparkles} className="xl:col-span-2">
        {cpu.instructions.length === 0 ? (
          <Unavailable reason={ctx.missing} />
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Supported instruction sets">
            {cpu.instructions.map((ins) => (
              <li
                key={ins}
                className="num rounded-md border border-line bg-white/[0.03] px-2 py-[3px] text-[11px] text-slate-200"
              >
                {ins}
              </li>
            ))}
          </ul>
        )}
      </SpecCard>
    </div>
  );
}

/* ------------------------------------------------------------------ Mainboard */

export function BoardPanel({ board, ctx }: { board: BoardSpec; ctx: RowCtx }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SpecCard title="Motherboard" icon={CircuitBoard}>
        <Hero title={fmtBoardName(board.manufacturer, board.product)} />
        <SpecRows rows={boardRows(board, ctx).filter((r) => r.label !== "Model")} />
      </SpecCard>
      <SpecCard title="BIOS" icon={Terminal} rows={biosRows(board, ctx)} />
    </div>
  );
}

/* ------------------------------------------------------------------ Memory */

export function MemoryPanel({
  memory,
  ctx,
  onOpenSlot,
}: {
  memory: MemorySpec;
  ctx: RowCtx;
  onOpenSlot: (slot: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SpecCard title="General" icon={MemoryStick}>
        <Hero title={`${memory.totalGb.toFixed(1)} GB ${memory.type !== "Unknown" ? memory.type : ""}`.trim()} />
        <SpecRows rows={memoryRows(memory, ctx)} />
      </SpecCard>

      <SpecCard title="Modules" icon={Layers}>
        {memory.dimms.length === 0 ? (
          <div className="py-4">
            <Unavailable reason={ctx.missing} />
          </div>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <th scope="col" className={thCls}>Slot</th>
                <th scope="col" className={cn(thCls, "text-right")}>Size</th>
                <th scope="col" className={thCls}>
                  <span className="pl-3">Part number</span>
                </th>
                <th scope="col" className={cn(thCls, "text-right")}>Speed</th>
              </tr>
            </thead>
            <tbody>
              {memory.dimms.map((d, i) => (
                <tr key={`${d.slot}-${i}`} className="border-t border-white/[0.05]">
                  <td className="py-[5px]">
                    <button
                      type="button"
                      onClick={() => onOpenSlot(d.slot)}
                      title={`Show ${d.slot} in the SPD tab`}
                      className="font-semibold text-slate-200 underline decoration-white/15 underline-offset-[3px] hover:text-teal hover:decoration-teal/60"
                    >
                      {d.slot || `Module ${i + 1}`}
                    </button>
                  </td>
                  <td className="num py-[5px] text-right text-ink">{fmtSizeGb(d.sizeGb)}</td>
                  <td className="num max-w-0 truncate py-[5px] pl-3 text-slate-300" title={d.partNumber}>
                    {d.partNumber.trim() || "—"}
                  </td>
                  <td className="num whitespace-nowrap py-[5px] text-right text-slate-300">
                    {d.configuredSpeedMts ? fmtMts(d.configuredSpeedMts) : d.speedMts ? fmtMts(d.speedMts) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SpecCard>
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
    return (
      <SectionUnavailable
        title="Memory modules"
        reason={ctx.missing}
        detail="The firmware did not list any memory modules."
      />
    );
  }
  const index = Math.max(0, dimms.findIndex((d) => d.slot === slot));
  const d = dimms[index];
  // Slot labels can repeat on some boards; keep the picker keyed by position.
  const options = dimms.map((m, i) => ({ value: i, label: m.slot || `Module ${i + 1}` }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="label-caps">Slot</span>
        <Segmented
          value={index}
          options={options}
          onChange={(i) => onSlot(dimms[i].slot)}
          ariaLabel="Memory slot"
          size="sm"
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <SpecCard title="Module" icon={MemoryStick}>
          <Hero
            title={`${fmtSizeGb(d.sizeGb)} ${memory.type !== "Unknown" ? memory.type : ""} ${d.formFactor}`.replace(/\s+/g, " ").trim()}
            sub={[d.manufacturer.trim(), d.partNumber.trim()].filter(Boolean).join(" · ") || undefined}
          />
          <SpecRows rows={dimmRows(d, ctx)} />
        </SpecCard>
        <GlassCard title="About this data" icon={Info}>
          <div className="space-y-2 text-[12px] leading-relaxed text-slate-400">
            <p>Module details come from the motherboard&rsquo;s SMBIOS tables, which Windows reads without a driver.</p>
            <p>
              Memory timings are read in Nexum 1.1. XMP profiles are not read in this version, so the rated speed is the
              module&rsquo;s JEDEC speed as the firmware reports it.
            </p>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Graphics */

export function GraphicsPanel({ gpus, ctx }: { gpus: GpuSpec[]; ctx: RowCtx }) {
  return (
    <div className={cn("grid grid-cols-1 gap-4", gpus.length > 1 && "xl:grid-cols-2")}>
      {gpus.map((g, i) => (
        <SpecCard key={`${g.name}-${i}`} title={gpus.length > 1 ? `GPU ${i + 1}` : "GPU"} icon={Monitor}>
          <Hero title={g.name} />
          <SpecRows rows={gpuRows(g, ctx).filter((r) => r.label !== "Name")} />
        </SpecCard>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ OS & Security */

export function OsPanel({ os, security, ctx }: { os: OsSpec; security: SecuritySpec; ctx: RowCtx }) {
  // Uptime is derived from bootTs (CONTRACT §4.8); tick locally so only this panel re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const rows = osRows(os, now, ctx);
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SpecCard title="Operating system" icon={Terminal}>
        <Hero title={os.caption || "Windows"} sub={[os.displayVersion, os.build ? `Build ${os.build}` : ""].filter(Boolean).join(" · ") || undefined} />
        <SpecRows rows={rows.filter((r) => r.label !== "Operating system")} />
      </SpecCard>
      <SpecCard title="Security" icon={ShieldCheck} rows={securityRows(security, ctx)} />
    </div>
  );
}
