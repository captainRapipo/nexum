import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Fan, Lock, Wind } from "lucide-react";
import type { AgentAck, FanPreset, FanSafety, FanTelemetry } from "../types";
import { api } from "../lib/api";
import { resolveUnavailable } from "../lib/status";
import { cn } from "../lib/format";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSettings } from "../hooks/useSettings";
import { useSensorStream } from "../hooks/useSensors";
import { useSensorLabels } from "../hooks/useSensorLabels";
import GlassCard from "../components/layout/GlassCard";
import { STATUS_CLASS, Unavailable } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import FanCard, { FAN_CARD_CSS } from "../components/fans/FanCard";
import PresetSelector, { type SelectablePreset } from "../components/fans/PresetSelector";
import CoolingTemps from "../components/fans/CoolingTemps";
import { GpuCoolingPanel } from "../components/fans/HardwarePanels";
import { isGpuFan } from "../components/telemetry/sensorHelpers";

const OVERRIDE_MS = 5000;

const PRESET_NAME: Record<FanPreset, string> = {
  auto: "Auto (BIOS)",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

const FAILSAFE_TEXT =
  "Fan control is locked at 100% after an interruption. Restart the PC to return fans to BIOS control.";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

function defaultMax(name: string) {
  return /pump|aio/i.test(name) ? 3000 : 2000;
}

/** A header that never spun this session and that Nexum is not driving (hidden by default). */
function isUnusedHeader(f: FanTelemetry, manualActive: boolean): boolean {
  const max = f.rpmMax ?? (Number.isFinite(f.rpm) ? f.rpm : null);
  return max === 0 && !(manualActive && f.controllable);
}

/** Banner text while the thermal override holds the fans at 100% (CONTRACT §1.5.2, §4.10). */
function overrideText(s: FanSafety): string {
  switch (s.reason) {
    case "cpuTemp":
      return `Fans are at 100% because the CPU reached ${s.triggerC} °C. They return to your setting when it cools to ${s.releaseC} °C.`;
    case "gpuTemp":
      return "Fans are at 100% because a GPU reached its temperature limit. They return to your setting when it cools by 10 °C.";
    case "sensorMissing":
      return "Fans are at 100% because a temperature sensor stopped reporting. They return to your setting when it reads again.";
    default:
      return "Fans are at 100% for safety.";
  }
}

export default function CoolingView() {
  useSensorStream(true);
  const { latest, agent, lastAck } = useTelemetry();
  const { settings } = useSettings();
  const { labelOf, setLabel } = useSensorLabels();
  const unit = settings?.tempUnit ?? "C";

  const allFans = useMemo(() => latest?.fans ?? [], [latest]);
  const safety = latest?.fanSafety ?? null;
  const manualActive = !!safety?.manualActive;
  const failsafe = !!safety?.failsafe;
  const held = !!safety?.overrideActive;

  const boardFans = useMemo(() => allFans.filter((f) => !isGpuFan(f)), [allFans]);
  const gpuFans = useMemo(() => allFans.filter((f) => isGpuFan(f)), [allFans]);
  const unused = useMemo(() => boardFans.filter((f) => isUnusedHeader(f, manualActive)), [boardFans, manualActive]);
  const [showUnused, setShowUnused] = useState(false);
  const shownFans = showUnused ? boardFans : boardFans.filter((f) => !unused.includes(f));

  const agentUp = !!agent?.running;
  const isAdmin = !!agent?.isAdmin;
  const controllable = boardFans.filter((f) => f.controllable);
  const canControl = agentUp && isAdmin && controllable.length > 0 && !failsafe;

  const [override, setOverride] = useState<{ preset: FanPreset; until: number } | null>(null);
  const [pending, setPending] = useState<SelectablePreset | null>(null);
  const [ackLine, setAckLine] = useState<(AgentAck & { at: number }) | null>(null);

  const livePreset: FanPreset | null = latest?.fanPreset ?? null;
  const shownPreset: FanPreset | null = override && Date.now() < override.until ? override.preset : livePreset;

  // Drop the optimistic override once telemetry confirms it, or when it expires.
  useEffect(() => {
    if (!override) return;
    if (livePreset === override.preset) {
      setOverride(null);
      return;
    }
    const left = override.until - Date.now();
    if (left <= 0) {
      setOverride(null);
      return;
    }
    const t = window.setTimeout(() => setOverride(null), left);
    return () => window.clearTimeout(t);
  }, [override, livePreset]);

  // Agent acknowledgements for fan commands → toast + inline status line.
  useEffect(() => {
    if (!lastAck || typeof lastAck.cmd !== "string" || !/^fan/i.test(lastAck.cmd)) return;
    setAckLine({ ...lastAck, at: Date.now() });
    toast(lastAck.message || (lastAck.ok ? "Fan command applied" : "Fan command failed"), lastAck.ok ? "ok" : "warn");
  }, [lastAck]);

  const selectPreset = useCallback(
    async (p: SelectablePreset) => {
      if (!canControl) return;
      setPending(p);
      try {
        await api.setFanPreset(p);
        setOverride({ preset: p, until: Date.now() + OVERRIDE_MS });
      } catch (e) {
        toast(`Could not apply ${PRESET_NAME[p]}: ${errMsg(e)}`, "crit");
      } finally {
        setPending(null);
      }
    },
    [canControl],
  );

  const setPct = useCallback(
    (id: string, pct: number) => {
      // Never send a command to a GPU fan: they are read-only in Nexum.
      const fan = allFans.find((f) => f.id === id);
      if (!fan || isGpuFan(fan) || !fan.controllable) return;
      setOverride({ preset: "custom", until: Date.now() + OVERRIDE_MS });
      api.setFanControl(id, pct).catch((e: unknown) => toast(`Fan command failed: ${errMsg(e)}`, "crit"));
    },
    [allFans],
  );

  const maxRpm = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of boardFans) {
      const peak = Math.max(f.rpmMax ?? 0, Number.isFinite(f.rpm) ? f.rpm : 0);
      out.set(f.id, Math.max(defaultMax(f.name), Math.ceil((peak * 1.15) / 500) * 500));
    }
    return out;
  }, [boardFans]);

  const cols = Math.max(1, Math.min(shownFans.length, 4));
  const presetNote = !agentUp
    ? null
    : failsafe
      ? FAILSAFE_TEXT
      : !isAdmin
        ? "Fan control needs administrator rights."
        : controllable.length === 0 && boardFans.length > 0
          ? "No fan header on this board accepts a duty cycle; fans are shown read-only."
          : null;

  return (
    <div className="flex flex-col gap-5">
      <style>{FAN_CARD_CSS}</style>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Cooling</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Motherboard fan headers, fixed-speed presets and the temperatures that drive fan decisions.
          </p>
        </div>
        {held ? (
          <span className="rounded-full border border-line bg-white/[0.04] px-3 py-1 text-[11px] text-silver">
            Fans held at 100%
          </span>
        ) : (
          shownPreset && (
            <span className="rounded-full border border-line bg-white/[0.04] px-3 py-1 text-[11px] text-silver">
              Preset: {PRESET_NAME[shownPreset]}
            </span>
          )
        )}
      </div>

      {held && !failsafe && safety && (
        <div
          role="status"
          className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]", STATUS_CLASS.warn.border, STATUS_CLASS.warn.soft)}
          title={`Safety rule: every controlled fan goes to 100% at ${safety.triggerC} °C CPU, at the GPU limit, or when a temperature sensor stops reporting, and is released ${safety.triggerC - safety.releaseC} °C lower after 3 readings.`}
        >
          <AlertTriangle size={16} className={cn("mt-0.5 shrink-0", STATUS_CLASS.warn.text)} />
          <span className="text-ink">{overrideText(safety)}</span>
        </div>
      )}

      <GlassCard
        title="Cooling preset"
        icon={<Wind size={15} />}
        accent="teal"
        actions={
          ackLine ? (
            <span
              className={cn("max-w-[360px] truncate font-mono text-[11px]", ackLine.ok ? "text-silver" : STATUS_CLASS.warn.text)}
              title={ackLine.message}
            >
              {ackLine.message}
            </span>
          ) : undefined
        }
      >
        <PresetSelector
          active={shownPreset}
          pending={pending}
          disabled={!canControl || pending !== null}
          onSelect={(p) => void selectPreset(p)}
        />
        {presetNote && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-white/[0.03] px-3 py-2.5 text-[12px] text-silver">
            <Lock size={14} className="mt-0.5 shrink-0 text-muted" />
            <span>{presetNote}</span>
          </div>
        )}
      </GlassCard>

      <GlassCard
        title="Fans and pumps"
        icon={<Fan size={15} />}
        accent="cyan"
        actions={
          boardFans.length > 0 ? (
            <div className="flex items-center gap-3 font-mono text-[11px] text-muted">
              <span>
                {shownFans.length} shown · {controllable.length} PWM
              </span>
              {unused.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUnused((v) => !v)}
                  aria-pressed={showUnused}
                  className="rounded-md border border-line px-2 py-0.5 font-sans text-[11px] text-silver transition hover:border-white/25 hover:text-ink"
                >
                  {showUnused
                    ? `Hide ${unused.length} unused ${unused.length === 1 ? "header" : "headers"}`
                    : `Show ${unused.length} unused ${unused.length === 1 ? "header" : "headers"}`}
                </button>
              )}
            </div>
          ) : undefined
        }
      >
        {!latest ? (
          <div className="py-14 text-center text-[12px] uppercase tracking-[0.2em] text-muted">Waiting for telemetry…</div>
        ) : boardFans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line bg-white/[0.03] text-muted">
              <Fan size={22} />
            </div>
            <div className="text-[13px]">
              <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
            </div>
            <p className="max-w-md text-[12px] leading-relaxed text-muted">
              Motherboard fan headers are read through the Super I/O chip. Some laptops and OEM boards do not expose them.
            </p>
          </div>
        ) : shownFans.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted">
            Every header reported 0 RPM this session and is hidden. Use “Show {unused.length} unused headers” to see them.
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {shownFans.map((f) => (
              <FanCard
                key={f.id}
                fan={f}
                label={labelOf(f.id, f.name)}
                onRename={setLabel}
                maxRpm={maxRpm.get(f.id) ?? defaultMax(f.name)}
                canControl={canControl && f.controllable}
                held={held && f.controllable}
                onSetPct={setPct}
              />
            ))}
          </div>
        )}
      </GlassCard>

      {/* ROADMAP §6.5 / CONTRACT §4.10: no duplicated CPU / RAM panels here. GPU fans stay (read-only),
          because the motherboard grid above never lists them. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CoolingTemps agent={agent} tempUnit={unit} />
        <GpuCoolingPanel
          gpus={latest?.gpus ?? []}
          primary={latest?.gpu ?? null}
          gpuFans={gpuFans}
          labelOf={labelOf}
          unit={unit}
          agent={agent}
        />
      </div>
    </div>
  );
}
