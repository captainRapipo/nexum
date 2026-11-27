import { useEffect, useState, type ReactNode } from "react";
import { Cpu, Lock, MonitorSpeaker } from "lucide-react";
import type { AgentStatus, CpuTelemetry, FanTelemetry, GpuTelemetry } from "../../types";
import GlassCard from "../layout/GlassCard";
import { DottedLeaderRow, Unavailable } from "../ui";
import { resolveUnavailable } from "../../lib/status";
import { cn, fmtGhz, fmtRpm, fmtTemp } from "../../lib/format";
import { isZeroRpmIdle } from "../telemetry/sensorHelpers";

type Unit = "C" | "F";

const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

function Skeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-white/[0.04]" />
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------- CPU load */

/**
 * Per-core load for the Cooling view. `loadPerCore` has one entry per PHYSICAL core (SMT threads folded,
 * CONTRACT §1.1.2), so the label says "Per-core load (8C/16T)", never "per thread".
 */
export function CpuLoadPanel({ cpu, unit, agent }: { cpu: CpuTelemetry | null; unit: Unit; agent: AgentStatus | null }) {
  const cores = cpu?.loadPerCore ?? [];
  const label = cpu && cpu.cores > 0 ? `Per-core load (${cpu.cores}C/${cpu.threads}T)` : "Per-core load";
  const cols = Math.min(Math.max(cores.length, 1), 16);
  return (
    <GlassCard title="Processor load" icon={<Cpu size={15} />} accent="teal">
      {!cpu ? (
        <Skeleton />
      ) : (
        <div className="space-y-3">
          <div className="truncate text-[12.5px] font-semibold text-ink" title={cpu.name}>
            {cpu.name || "Unknown CPU"}
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-muted">
              <span>{label}</span>
              <span className="font-mono normal-case tracking-normal text-silver">
                {fin(cpu.loadTotal) ? `${cpu.loadTotal.toFixed(0)}% total` : "—"}
              </span>
            </div>
            {cores.length === 0 ? (
              <div className="py-3 text-[11.5px]">
                <Unavailable reason={resolveUnavailable(agent, "none")} />
              </div>
            ) : (
              <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {cores.map((v, i) => {
                  const val = fin(v) ? Math.max(0, Math.min(100, v)) : 0;
                  return (
                    <div key={i} title={`Core ${i}: ${fin(v) ? `${val.toFixed(0)}%` : "no reading"}`}>
                      <div className="flex h-10 items-end overflow-hidden rounded-[3px] bg-white/[0.05]">
                        <div
                          className="w-full rounded-[3px] bg-teal transition-[height] duration-500"
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
          <div className="space-y-0.5">
            <DottedLeaderRow
              label="CPU temperature"
              value={fin(cpu.packageTempC) ? fmtTemp(cpu.packageTempC, unit) : <Unavailable compact reason={resolveUnavailable(agent, "pawnio")} />}
              valueClassName="font-mono"
            />
            <DottedLeaderRow
              label="Effective clock"
              value={fin(cpu.clockMhz) ? fmtGhz(cpu.clockMhz) : <Unavailable compact reason={resolveUnavailable(agent, "pawnio")} />}
              valueClassName="font-mono"
            />
          </div>
        </div>
      )}
    </GlassCard>
  );
}

/* --------------------------------------------------------------------------- GPU cooling */

/**
 * GPU cooling, read-only. GPU fans are shown here only (never in the motherboard fan grid) and Nexum
 * never sends a command to them.
 */
export function GpuCoolingPanel({
  gpus,
  primary,
  gpuFans,
  labelOf,
  unit,
  agent,
}: {
  gpus: GpuTelemetry[];
  primary: GpuTelemetry | null;
  gpuFans: FanTelemetry[];
  labelOf: (id: string, defaultName: string) => string;
  unit: Unit;
  agent: AgentStatus | null;
}) {
  const list = gpus.length > 0 ? gpus : primary ? [primary] : [];
  const primaryIdx = primary ? Math.max(0, list.findIndex((g) => g.name === primary.name)) : 0;
  const [idx, setIdx] = useState(primaryIdx);
  useEffect(() => {
    if (idx >= list.length) setIdx(0);
  }, [idx, list.length]);
  const gpu = list[idx] ?? null;
  const na = (v: number | null | undefined, fmt: (n: number) => string): ReactNode =>
    fin(v) ? fmt(v) : <Unavailable compact reason={resolveUnavailable(agent, "none")} />;

  return (
    <GlassCard
      title="GPU cooling"
      icon={<MonitorSpeaker size={15} />}
      accent="gold"
      actions={
        list.length > 1 ? (
          <div className="flex gap-1" role="tablist" aria-label="GPU">
            {list.map((g, i) => (
              <button
                key={`${g.name}-${i}`}
                type="button"
                role="tab"
                aria-selected={i === idx}
                onClick={() => setIdx(i)}
                title={g.name}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10.5px] transition",
                  i === idx ? "bg-white/[0.08] text-ink" : "text-muted hover:text-silver",
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
        <div className="py-6 text-[12px]">
          <Unavailable reason={resolveUnavailable(agent, "none")} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[12.5px] font-semibold text-ink" title={gpu.name}>
              {gpu.name || "Unknown GPU"}
            </span>
            <span className="flex shrink-0 items-center gap-1 rounded border border-line bg-white/5 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted">
              <Lock size={9} />
              Read-only
            </span>
          </div>
          <div className="space-y-0.5">
            <DottedLeaderRow label="Load" value={na(gpu.load, (n) => `${n.toFixed(0)}%`)} valueClassName="font-mono" />
            <DottedLeaderRow label="Edge temp" value={na(gpu.tempC, (n) => fmtTemp(n, unit))} valueClassName="font-mono" />
            <DottedLeaderRow label="Hot spot" value={na(gpu.hotspotTempC, (n) => fmtTemp(n, unit))} valueClassName="font-mono" />
            <DottedLeaderRow
              label="Fan"
              hint={
                isZeroRpmIdle(gpu) ? (
                  <span
                    className="rounded border border-line bg-white/[0.04] px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-silver"
                    title="The GPU fan is stopped because the card is cool enough"
                  >
                    Zero-RPM idle
                  </span>
                ) : undefined
              }
              value={
                fin(gpu.fanRpm) ? `${fmtRpm(gpu.fanRpm)}${fin(gpu.fanPct) ? ` · ${gpu.fanPct.toFixed(0)}%` : ""}` : na(gpu.fanPct, (n) => `${n.toFixed(0)}%`)
              }
              valueClassName="font-mono"
            />
            {gpuFans.length > 1 &&
              gpuFans.map((f) => (
                <DottedLeaderRow key={f.id} label={labelOf(f.id, f.name)} value={fmtRpm(f.rpm)} valueClassName="font-mono text-silver" />
              ))}
          </div>
          <p className="text-[11px] leading-relaxed text-muted">Nexum shows GPU fans for information and never changes them.</p>
        </div>
      )}
    </GlassCard>
  );
}
