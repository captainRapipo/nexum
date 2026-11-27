import { useEffect, useState } from "react";
import {
  CircuitBoard,
  Cpu,
  Gauge,
  HardDrive,
  Info,
  Layers,
  MemoryStick,
  Monitor,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
} from "lucide-react";
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
import { cn, fmtBoardName, fmtCount } from "../../lib/format";
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
  clockRows,
  cpuRows,
  dimmRows,
  diskBusLabel,
  diskLinkName,
  diskLinkText,
  displayCodename,
  fmtMts,
  fmtSizeGb,
  gpuRows,
  memoryCoupling,
  memoryRows,
  osRows,
  PCIE_IDLE_HINT,
  securityRows,
  spdCycleRows,
  spdNsRows,
  timingRows,
  TIMINGS_SOURCE_HINT,
  TIMINGS_SOURCE_LABEL,
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

/** Neutral source/info chip (not a health state, so no status colour). Hover explains it. */
function InfoChip({ children, title, tone = "neutral" }: { children: string; title: string; tone?: "neutral" | "live" }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 truncate whitespace-nowrap rounded-full border px-2 py-[2px] text-[10.5px] font-semibold",
        tone === "live" ? "border-teal/35 bg-teal/[0.06] text-teal" : "border-line bg-white/[0.04] text-silver",
      )}
    >
      {tone === "live" && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-teal" />}
      {children}
    </span>
  );
}

function Note({ children }: { children: string }) {
  return (
    <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-slate-400">
      <Info size={12} className="mt-[2px] shrink-0 text-slate-500" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ CPU */

export function CpuPanel({ cpu, ctx }: { cpu: CpuSpec; ctx: RowCtx }) {
  const rows = cpuRows(cpu, ctx).filter((r) => r.label !== "Name");
  const sub = [cpu.vendor !== "Other" ? cpu.vendor : null, displayCodename(cpu), cpu.socket ? `Socket ${cpu.socket}` : null]
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

      <TimingsCard memory={memory} ctx={ctx} />
      <ClocksCard memory={memory} />
    </div>
  );
}

function TimingsCard({ memory, ctx }: { memory: MemorySpec; ctx: RowCtx }) {
  const src = memory.timingsSource;
  const rows = timingRows(memory, ctx);
  return (
    <SpecCard
      title="Timings"
      icon={Timer}
      actions={
        <InfoChip tone={src === "umc" ? "live" : "neutral"} title={TIMINGS_SOURCE_HINT[src]}>
          {TIMINGS_SOURCE_LABEL[src]}
        </InfoChip>
      }
    >
      {rows.length > 0 ? (
        <SpecRows rows={rows} />
      ) : (
        <div className="py-1.5">
          {memory.timingsNote ? (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-500">
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
  return (
    <SpecCard
      title="Clocks"
      icon={Gauge}
      actions={
        c.coupled == null ? undefined : (
          <InfoChip tone={c.coupled ? "live" : "neutral"} title={c.hint}>
            {c.coupled ? "1:1" : "Not 1:1"}
          </InfoChip>
        )
      }
    >
      <SpecRows rows={clockRows(memory)} />
      <Note>
        MEMCLK is the memory clock (half the MT/s rating). FCLK is the Infinity Fabric clock and UCLK the memory-controller
        clock, read from the processor&apos;s power-management table when it reports them.
      </Note>
    </SpecCard>
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
  const anySpd = dimms.some((m) => m.spd != null);
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
        {d.spd ? (
          <SpdTimingsCard spd={d.spd} />
        ) : (
          <SpecCard title="JEDEC timings" icon={Timer}>
            <div className="py-2">
              <Unavailable reason={anySpd ? "unsupported" : ctx.superIo} />
            </div>
            <Note>
              {anySpd
                ? "Nexum could not match this slot to an SPD chip."
                : "SPD timings are read from the module's SPD chip, which needs administrator rights and the PawnIO driver."}
            </Note>
          </SpecCard>
        )}
        <GlassCard title="About this data" icon={Info} className="xl:col-span-2">
          <div className="space-y-2 text-[12px] leading-relaxed text-slate-400">
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

function SpdTimingsCard({ spd }: { spd: SpdInfo }) {
  const cyc = spdCycleRows(spd);
  const ns = spdNsRows(spd);
  return (
    <SpecCard
      title={spd.jedecSpeedMts != null ? `JEDEC timings at ${fmtCount(spd.jedecSpeedMts)} MT/s` : "JEDEC timings"}
      icon={Timer}
      actions={
        <InfoChip title={TIMINGS_SOURCE_HINT.spd}>SPD JEDEC</InfoChip>
      }
    >
      {cyc.length > 0 ? (
        <SpecRows rows={cyc} />
      ) : (
        <Note>The rated speed is not reported, so the times below cannot be converted to clock cycles.</Note>
      )}
      {ns.length > 0 && (
        <details className="mt-3 rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12px] [&_summary]:cursor-pointer">
          <summary className="text-[11.5px] font-semibold text-slate-300">
            Minimum times in nanoseconds ({ns.length})
          </summary>
          <div className="mt-1.5">
            <SpecRows rows={ns} />
          </div>
        </details>
      )}
      <p className="mt-2 text-[10.5px] leading-snug text-slate-500">
        Cycles = ceil(ns ÷ clock period − 0.025), the JEDEC rounding rule.
        {spd.matchedBy === "order" ? " Matched to this slot by module order." : " Matched to this slot by part number."}
      </p>
    </SpecCard>
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
          {g.link && (
            <p className="mt-2 text-[10.5px] leading-snug text-slate-500" title={PCIE_IDLE_HINT}>
              {g.link.source === "adl" ? "Link read through the AMD driver." : g.link.source === "devpkey" ? "Link reported by Windows." : ""}{" "}
              {PCIE_IDLE_HINT}
            </p>
          )}
          {g.link?.note && <Note>{g.link.note}</Note>}
        </SpecCard>
      ))}
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
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SpecCard title="Operating system" icon={Terminal}>
        <Hero title={os.caption || "Windows"} sub={[os.displayVersion, os.build ? `Build ${os.build}` : ""].filter(Boolean).join(" · ") || undefined} />
        <SpecRows rows={rows.filter((r) => r.label !== "Operating system")} />
      </SpecCard>
      <SpecCard title="Security" icon={ShieldCheck} rows={securityRows(security, ctx)} />
      <StorageLinksCard links={diskLinks} disks={disks} ctx={ctx} />
    </div>
  );
}

function StorageLinksCard({ links, disks, ctx }: { links: readonly DiskLink[]; disks: readonly PhysicalDisk[]; ctx: RowCtx }) {
  const sorted = [...links].sort((a, b) => a.diskNumber - b.diskNumber);
  return (
    <SpecCard title="Storage links" icon={HardDrive} className="xl:col-span-2">
      {sorted.length === 0 ? (
        <div className="py-2">
          <Unavailable reason={ctx.missing} />
        </div>
      ) : (
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-[64px]" />
            <col />
            <col className="w-[70px]" />
            <col className="w-[38%]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={thCls}>Disk</th>
              <th scope="col" className={thCls}>Drive</th>
              <th scope="col" className={thCls}>Bus</th>
              <th scope="col" className={thCls}>Link</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l) => {
              const name = diskLinkName(l, disks);
              const link = diskLinkText(l);
              return (
                <tr key={l.diskNumber} className="border-t border-white/[0.05]">
                  <td className="num py-[6px] text-slate-400">{l.diskNumber}</td>
                  <td className="truncate py-[6px] pr-3 text-slate-200" title={name}>
                    {name}
                  </td>
                  <td className="py-[6px] text-slate-300">{diskBusLabel(l)}</td>
                  <td className="num truncate py-[6px] text-ink" title={l.bus === "nvme" ? `${link}. ${PCIE_IDLE_HINT}` : link}>
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
