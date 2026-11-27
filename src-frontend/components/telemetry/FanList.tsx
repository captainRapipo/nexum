import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Fan } from "lucide-react";
import { Unavailable } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { resolveUnavailable } from "../../lib/status";
import { requestNavigate } from "../../lib/nav";
import { clamp, cn, fmtRpm } from "../../lib/format";
import type { FanPreset, FanTelemetry } from "../../types";
import { finite, isGpuFan } from "./sensorHelpers";

/** Bar scale floor so a quiet 600 RPM case fan doesn't look pegged. */
const RPM_SCALE_FLOOR = 2000;

const PRESET_LABEL: Record<FanPreset, string> = {
  auto: "BIOS auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

/** A header that never spun this session and is not driven by Nexum. */
function isUnused(f: FanTelemetry, manualActive: boolean): boolean {
  const max = f.rpmMax ?? (finite(f.rpm) ? f.rpm : null);
  return max === 0 && !(manualActive && f.controllable);
}

export default function FanList() {
  const { latest, agent } = useTelemetry();
  const { labelOf } = useSensorLabels();
  const [expanded, setExpanded] = useState<string | null>(null);

  const manualActive = !!latest?.fanSafety?.manualActive;
  const { rows, hidden } = useMemo(() => {
    const all = latest?.fans ?? [];
    const board = all.filter((f) => !isGpuFan(f));
    const gpu = all.filter((f) => isGpuFan(f));
    const visible = [...board, ...gpu].filter((f) => !isUnused(f, manualActive));
    return { rows: visible, hidden: all.length - visible.length };
  }, [latest?.fans, manualActive]);

  const scale = useMemo(() => {
    let m = RPM_SCALE_FLOOR;
    for (const f of rows) m = Math.max(m, f.rpmMax ?? 0, finite(f.rpm) ? f.rpm : 0);
    return m;
  }, [rows]);

  const preset = latest?.fanPreset ? PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset : null;

  return (
    <GlassCard
      title="Active cooling"
      icon={<Fan size={14} />}
      accent="cyan"
      actions={
        <button
          type="button"
          onClick={() => requestNavigate("cooling")}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-cyan"
          title={preset ? `Fan preset: ${preset}. Open Cooling (F6)` : "Open Cooling (F6)"}
        >
          {preset ? (
            <span className="rounded-full border border-line bg-white/[0.04] px-2 py-0.5 normal-case tracking-normal text-silver">
              {preset}
            </span>
          ) : (
            "Cooling"
          )}
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </button>
      }
    >
      {rows.length === 0 ? (
        <div className="py-3 text-[11px] leading-relaxed text-muted">
          {!latest ? (
            "Waiting for sensor data…"
          ) : (latest.fans ?? []).length === 0 ? (
            <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
          ) : (
            `${hidden} unused ${hidden === 1 ? "header" : "headers"} hidden (0 RPM this session).`
          )}
        </div>
      ) : (
        <ul className="-mx-1 flex flex-col gap-1">
          {rows.map((f, i) => {
            const open = expanded === f.id;
            const rpm = finite(f.rpm) ? f.rpm : null;
            const spinning = rpm !== null && rpm > 0;
            const pct = rpm !== null ? clamp((rpm / scale) * 100, 0, 100) : 0;
            // Spin period inversely proportional to RPM: ~0.35 s at 3000 RPM, ~2 s at 500 RPM.
            const spinSecs = spinning ? clamp(1000 / rpm, 0.3, 2.4) : 0;
            const name = labelOf(f.id, f.name);
            const gpu = isGpuFan(f);
            return (
              <li
                key={f.id}
                className={cn(
                  "rounded-lg border transition-colors",
                  open ? "border-cyan/30 bg-cyan/[0.05]" : "border-transparent hover:border-line hover:bg-white/[0.03]",
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : f.id)}
                  aria-expanded={open}
                  aria-controls={open ? `fan-detail-${i}` : undefined}
                  className={cn("group block w-full rounded-lg px-2.5 pt-2 text-left", open ? "pb-1" : "pb-2")}
                >
                  <div className="flex items-center gap-2.5">
                    <Fan
                      size={14}
                      className={cn("shrink-0", spinning ? "animate-spin text-cyan" : "text-muted")}
                      style={spinning ? { animationDuration: `${spinSecs.toFixed(2)}s` } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={name !== f.name ? `${name} (${f.name})` : name}>
                      {name}
                    </span>
                    {gpu && (
                      <span className="shrink-0 rounded border border-line px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted">
                        GPU
                      </span>
                    )}
                    <span className={cn("font-mono text-[12px] tabular-nums", spinning ? "text-ink" : "text-muted")}>
                      {fmtRpm(rpm)}
                    </span>
                    <ChevronDown
                      size={12}
                      className={cn("shrink-0 text-muted transition-transform", open && "rotate-180 text-cyan")}
                    />
                  </div>
                  <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-cyan transition-[width] duration-700 ease-out"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </button>
                {open && (
                  <div id={`fan-detail-${i}`} className="px-2.5 pb-2">
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2 text-[10.5px]">
                      <Detail label="Hardware" value={f.hardware || "—"} wide />
                      {name !== f.name && <Detail label="Sensor" value={f.name} wide />}
                      <Detail
                        label="Duty"
                        value={finite(f.controlPct) ? `${f.controlPct.toFixed(0)}%` : f.controllable ? "BIOS" : "Read-only"}
                      />
                      <Detail label="Control" value={gpu ? "Read-only" : f.controllable ? "PWM" : "Read-only"} />
                      <Detail label="Min" value={fmtRpm(f.rpmMin)} />
                      <Detail label="Max" value={fmtRpm(f.rpmMax)} />
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
          {hidden > 0 && (
            <li className="px-2.5 pt-1 text-[10.5px] text-muted">
              {hidden} unused {hidden === 1 ? "header" : "headers"} hidden
            </li>
          )}
        </ul>
      )}
    </GlassCard>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-2", wide && "col-span-2")}>
      <dt className="shrink-0 uppercase tracking-[0.16em] text-muted">{label}</dt>
      <dd className="truncate font-mono text-silver" title={value}>
        {value}
      </dd>
    </div>
  );
}
