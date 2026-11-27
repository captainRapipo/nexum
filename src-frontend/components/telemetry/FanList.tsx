import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, Fan } from "lucide-react";
import { StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { clamp, cn, fmtRpm } from "../../lib/format";
import type { TelemetryPacket } from "../../types";

const GPU_FAN_ID = "__gpu_fan__";
/** Bar scale floor so a quiet 600 RPM case fan doesn't look pegged. */
const RPM_SCALE_FLOOR = 2000;

interface FanRow {
  id: string;
  name: string;
  hardware: string;
  rpm: number | null;
  controllable: boolean;
  controlPct: number | null;
  isGpu: boolean;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function rowsFor(p: TelemetryPacket | null): FanRow[] {
  if (!p) return [];
  const rows: FanRow[] = (p.fans ?? []).map((f) => ({
    id: f.id,
    name: f.name || "Fan",
    hardware: f.hardware || "—",
    rpm: finite(f.rpm) ? f.rpm : null,
    controllable: !!f.controllable,
    controlPct: finite(f.controlPct) ? f.controlPct : null,
    isGpu: false,
  }));
  const gpu = p.gpu;
  if (gpu && (finite(gpu.fanRpm) || finite(gpu.fanPct))) {
    rows.push({
      id: GPU_FAN_ID,
      name: "GPU Fan",
      hardware: gpu.name || "GPU",
      rpm: finite(gpu.fanRpm) ? gpu.fanRpm : null,
      controllable: false,
      controlPct: finite(gpu.fanPct) ? gpu.fanPct : null,
      isGpu: true,
    });
  }
  return rows;
}

function fanRpmOf(p: TelemetryPacket, id: string): number | null {
  if (id === GPU_FAN_ID) return p.gpu && finite(p.gpu.fanRpm) ? p.gpu.fanRpm : null;
  const f = (p.fans ?? []).find((x) => x.id === id);
  return f && finite(f.rpm) ? f.rpm : null;
}

const PRESET_LABEL: Record<string, string> = {
  auto: "BIOS Auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

function navigate(view: string) {
  window.dispatchEvent(new CustomEvent("nexum:navigate", { detail: view }));
}

export default function FanList() {
  const { latest, history, agent } = useTelemetry();
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => rowsFor(latest), [latest]);

  /** Per-fan peak and min RPM over the history window (for the expanded detail + bar scaling). */
  const stats = useMemo(() => {
    const map = new Map<string, { peak: number; min: number }>();
    for (const r of rows) {
      let peak = 0;
      let min = Number.POSITIVE_INFINITY;
      for (const p of history) {
        const v = fanRpmOf(p, r.id);
        if (v === null) continue;
        if (v > peak) peak = v;
        if (v < min) min = v;
      }
      map.set(r.id, { peak, min: Number.isFinite(min) ? min : 0 });
    }
    return map;
  }, [rows, history]);

  const scale = useMemo(() => {
    let m = RPM_SCALE_FLOOR;
    for (const s of stats.values()) m = Math.max(m, s.peak);
    return m;
  }, [stats]);

  const preset = latest?.fanPreset ? PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset : null;
  const noAdmin = agent && !agent.isAdmin;

  return (
    <GlassCard
      title="Active Cooling"
      icon={<Fan size={14} />}
      accent="cyan"
      actions={
        <button
          type="button"
          onClick={() => navigate("fans")}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-cyan"
          title={preset ? `Fan preset: ${preset} — open Fan Control (F4)` : "Open Fan Control (F4)"}
        >
          {preset ? <StatusPill tone="info">{preset}</StatusPill> : "Control"}
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </button>
      }
    >
      {rows.length === 0 ? (
        <div className="py-3 text-center text-[11px] leading-relaxed text-muted">
          {!latest
            ? "Waiting for sensor stream…"
            : noAdmin
              ? "No fan headers readable — restart Nexum as administrator to access Super I/O sensors."
              : "No fan sensors detected on this system."}
        </div>
      ) : (
        <ul className="-mx-1 flex flex-col gap-1">
          {rows.map((r, i) => {
            const open = expanded === r.id;
            const rpm = r.rpm;
            const spinning = finite(rpm) && rpm > 0;
            const pct = finite(rpm) ? clamp((rpm / scale) * 100, 0, 100) : 0;
            // Spin period inversely proportional to RPM: ~0.35s at 3000 RPM, ~2s at 500 RPM.
            const spinSecs = spinning ? clamp(1000 / rpm, 0.3, 2.4) : 0;
            const st = stats.get(r.id);
            return (
              <li
                key={r.id}
                className={cn(
                  "rounded-lg border transition-colors",
                  open ? "border-cyan/30 bg-cyan/[0.05]" : "border-transparent hover:border-line hover:bg-white/[0.03]",
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : r.id)}
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
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={r.name}>
                      {r.name}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-[12px] tabular-nums",
                        spinning ? "text-ink" : "text-muted",
                      )}
                    >
                      {finite(rpm) ? fmtRpm(rpm) : "—"}
                    </span>
                    <ChevronDown
                      size={12}
                      className={cn("shrink-0 text-muted transition-transform", open && "rotate-180 text-cyan")}
                    />
                  </div>
                  <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-cyan transition-[width] duration-700 ease-out"
                      style={{ width: `${pct}%`, boxShadow: spinning ? "0 0 6px rgba(34,211,238,0.7)" : undefined }}
                    />
                  </div>
                </button>
                {open && (
                  <div id={`fan-detail-${i}`} className="px-2.5 pb-2">
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2 text-[10.5px]">
                      <Detail label="Hardware" value={r.hardware} wide />
                      <Detail
                        label={r.isGpu ? "Fan Duty" : "Control"}
                        value={
                          finite(r.controlPct)
                            ? `${r.controlPct.toFixed(0)}%`
                            : r.controllable
                              ? "BIOS"
                              : "Read-only"
                        }
                      />
                      <Detail label="Writable" value={r.controllable ? "Yes" : "No"} />
                      <Detail label="Peak 2m" value={st && st.peak > 0 ? fmtRpm(st.peak) : "—"} />
                      <Detail label="Min 2m" value={st && st.peak > 0 ? fmtRpm(st.min) : "—"} />
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
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
