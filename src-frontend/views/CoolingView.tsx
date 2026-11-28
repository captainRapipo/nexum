import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Fan, Loader2, Lock, ShieldCheck } from "lucide-react";
import type { AgentAck, FanPreset, FanSafety, FanTelemetry } from "../types";
import { api } from "../lib/api";
import { resolveUnavailable } from "../lib/status";
import { cn } from "../lib/format";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSettings } from "../hooks/useSettings";
import { useSensorStream } from "../hooks/useSensors";
import { useSensorLabels } from "../hooks/useSensorLabels";
import GlassCard from "../components/layout/GlassCard";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import { Segmented, StatusIcon, Toggle, Unavailable, UNAVAILABLE_TEXT } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import FanCard from "../components/fans/FanCard";
import PresetSelector, { FIXED_SPEED_TEXT, type SelectablePreset } from "../components/fans/PresetSelector";
import CoolingTemps from "../components/fans/CoolingTemps";
import { GpuCoolingPanel } from "../components/fans/HardwarePanels";
import { isGpuFan } from "../components/fans/fanHelpers";

// Read-only GPU tuning panel (CONTRACT §4.10.1). Loaded and mounted only while its tab is selected,
// so nothing tuning-related runs unless the user opens it (ROADMAP §5.2 item 8).
const GpuTuningPanel = lazy(() => import("../components/tuning/GpuTuningPanel"));

type CoolingTab = "fans" | "tuning";
const COOLING_TABS: ReadonlyArray<{ value: CoolingTab; label: string }> = [
  { value: "fans", label: "Case fans" },
  { value: "tuning", label: "GPU tuning" },
];

/** The GPU tuning panel portals its "Read at … / Refresh" actions into this slot of the tabs row. */
const TAB_ACTIONS_ID = "nx-cooling-tab-actions";

const DESCRIPTION =
  "Motherboard fan headers, fixed-speed presets and the temperatures behind fan decisions. GPU values are read-only.";

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
  // Tab choice lives in component state only (CONTRACT §4.10.2: remembered per session, no setting).
  const [tab, setTab] = useState<CoolingTab>("fans");
  useSensorStream(tab === "fans");
  const { latest, history, agent, lastAck } = useTelemetry();
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

  const sensorsUp = !!agent?.running;
  const isAdmin = !!agent?.isAdmin;
  const controllable = boardFans.filter((f) => f.controllable);
  const canControl = sensorsUp && isAdmin && controllable.length > 0 && !failsafe;

  const [override, setOverride] = useState<{ preset: FanPreset; until: number } | null>(null);
  const [pending, setPending] = useState<SelectablePreset | null>(null);
  const [ackLine, setAckLine] = useState<(AgentAck & { at: number }) | null>(null);
  /** The Custom tile was picked: sliders are unlocked, nothing has been sent yet. */
  const [customArmed, setCustomArmed] = useState(false);

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

  // Once a slider has made the preset "custom" the armed flag has done its job.
  useEffect(() => {
    if (livePreset === "custom") setCustomArmed(false);
  }, [livePreset]);

  // Acknowledgements for fan commands → toast + the line in the Preset card header.
  useEffect(() => {
    if (!lastAck || typeof lastAck.cmd !== "string" || !/^fan/i.test(lastAck.cmd)) return;
    setAckLine({ ...lastAck, at: Date.now() });
    toast(lastAck.message || (lastAck.ok ? "Fan command applied" : "Fan command failed"), lastAck.ok ? "ok" : "warn");
  }, [lastAck]);

  const selectPreset = useCallback(
    async (p: SelectablePreset) => {
      if (!canControl) return;
      setCustomArmed(false);
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

  /** Recent speeds per fan (sparkline), from the shared telemetry history. */
  const rpmHistory = useMemo(() => {
    const out = new Map<string, (number | null)[]>();
    for (const f of boardFans) out.set(f.id, []);
    for (const p of history ?? []) {
      const byId = new Map((p.fans ?? []).map((f) => [f.id, f.rpm] as const));
      for (const [id, arr] of out) {
        const v = byId.get(id);
        arr.push(typeof v === "number" && Number.isFinite(v) ? v : null);
      }
    }
    return out;
  }, [boardFans, history]);

  const biosControlled = (shownPreset ?? "auto") === "auto" && !customArmed;
  const cols = Math.max(1, Math.min(shownFans.length, 4));
  const presetNote = !sensorsUp
    ? null
    : failsafe
      ? FAILSAFE_TEXT
      : !isAdmin
        ? "Fan control needs administrator rights."
        : controllable.length === 0 && boardFans.length > 0
          ? "No fan header on this board accepts a duty cycle; fans are shown read-only."
          : null;
  const sliderHint = (f: FanTelemetry): string | null => {
    if (!f.controllable) return "Speed reading only";
    if (failsafe) return "Locked at 100%";
    if (held) return "Held by the safety rule";
    if (!isAdmin) return "Needs administrator";
    if (biosControlled) return "Set a preset to change";
    return null;
  };

  usePageChrome({
    subtitle:
      tab === "tuning"
        ? "GPU tuning · read-only"
        : `Case fans · ${held ? "held at 100%" : customArmed && shownPreset !== "custom" ? PRESET_NAME.custom : shownPreset ? PRESET_NAME[shownPreset] : "reading…"}`,
  });

  const unusedLabel = `Show ${unused.length} unused ${unused.length === 1 ? "header" : "headers"}`;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageHeader view="cooling" description={DESCRIPTION} />

      <div className="mb-4 flex min-h-[30px] items-center justify-between gap-4">
        <Segmented value={tab} options={COOLING_TABS} onChange={setTab} size="lg" ariaLabel="Cooling" />
        <div id={TAB_ACTIONS_ID} className="flex min-w-0 items-center gap-3.5">
          {tab === "fans" && unused.length > 0 && (
            <Toggle checked={showUnused} onChange={setShowUnused} label={unusedLabel} />
          )}
        </div>
      </div>

      {tab === "tuning" ? (
        <div role="region" aria-label="GPU tuning" className="min-w-0">
          <Suspense
            fallback={
              <div className="flex items-center gap-2 py-12 text-body text-ink-2">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Loading…
              </div>
            }
          >
            <GpuTuningPanel />
          </Suspense>
        </div>
      ) : (
        <div role="region" aria-label="Case fans" className="flex min-w-0 flex-col gap-(--grid-gap)">
          {held && !failsafe && safety && (
            <div
              role="status"
              className="flex items-center gap-3 rounded-lg border border-warn-border bg-warn-bg px-3.5 py-2.5"
              title={`Safety rule: every controlled fan goes to 100% at ${safety.triggerC} °C CPU, at the GPU limit, or when a temperature sensor stops reporting, and is released ${safety.triggerC - safety.releaseC} °C lower after 3 readings.`}
            >
              <StatusIcon tone="warn" size={18} />
              <div className="min-w-0 flex-1">
                <b className="block text-body font-semibold text-ink">Fans held at 100%</b>
                <span className="text-callout text-ink-2">{overrideText(safety)}</span>
              </div>
            </div>
          )}

          <GlassCard
            title="Preset"
            actions={
              ackLine ? (
                <span className={cn("max-w-[420px] truncate", !ackLine.ok && "text-warn")} title={ackLine.message}>
                  {ackLine.message}
                </span>
              ) : controllable.length > 0 ? (
                `Applies to ${controllable.length} motherboard ${controllable.length === 1 ? "fan" : "fans"}`
              ) : undefined
            }
          >
            <PresetSelector
              active={shownPreset}
              pending={pending}
              disabled={!canControl || pending !== null}
              onSelect={(p) => void selectPreset(p)}
              onCustom={() => setCustomArmed(true)}
              customArmed={customArmed}
            />
            {presetNote ? (
              <div className="mt-3 flex items-center gap-2 text-callout text-ink-2">
                <Lock size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                <span>{presetNote}</span>
              </div>
            ) : customArmed && shownPreset !== "custom" ? (
              <div className="mt-3 flex items-center gap-2 text-callout text-ink-2">
                <Fan size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
                <span>Move a fan&rsquo;s slider to set its speed. {FIXED_SPEED_TEXT}.</span>
              </div>
            ) : canControl && safety ? (
              <div className="mt-3 flex items-center gap-2 text-callout text-ink-2">
                <ShieldCheck size={14} className="shrink-0 text-ok-icon" aria-hidden="true" />
                <span>
                  Thermal fail-safe: while Nexum sets the fan speed, every fan goes to 100% if the CPU reaches {safety.triggerC} °C or a
                  temperature reading is lost.
                </span>
              </div>
            ) : null}
          </GlassCard>

          {!latest ? (
            <GlassCard>
              <div className={cn("py-8 text-center", sensorsUp ? "text-body text-ink-2" : "text-callout text-ink-3")}>
                {sensorsUp ? "Reading fans…" : UNAVAILABLE_TEXT.agentOffline}
              </div>
            </GlassCard>
          ) : boardFans.length === 0 ? (
            <GlassCard>
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-card bg-inset text-icon-2">
                  <Fan size={22} aria-hidden="true" />
                </span>
                <div className="text-body">
                  <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
                </div>
                <p className="max-w-md text-callout text-ink-2">
                  Motherboard fan headers are read through the Super I/O chip. Some laptops and OEM boards do not expose them.
                </p>
              </div>
            </GlassCard>
          ) : shownFans.length === 0 ? (
            <GlassCard>
              <div className="py-6 text-center text-body text-ink-2">
                Every header reported 0 rpm this session and is hidden. Turn on “{unusedLabel}” to see them.
              </div>
            </GlassCard>
          ) : (
            <div className="grid gap-(--grid-gap)" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {shownFans.map((f) => (
                <FanCard
                  key={f.id}
                  fan={f}
                  label={labelOf(f.id, f.name)}
                  onRename={setLabel}
                  rpmHistory={rpmHistory.get(f.id)}
                  canControl={canControl && f.controllable && !biosControlled}
                  biosControlled={biosControlled}
                  held={held && f.controllable}
                  hint={sliderHint(f)}
                  onSetPct={setPct}
                />
              ))}
            </div>
          )}

          {/* GPU fans stay here (read-only), because the motherboard fans above never list them. */}
          <div className="grid grid-cols-12 gap-(--grid-gap)">
            <CoolingTemps agent={agent} tempUnit={unit} className="col-span-7" />
            <GpuCoolingPanel
              gpus={latest?.gpus ?? []}
              primary={latest?.gpu ?? null}
              gpuFans={gpuFans}
              labelOf={labelOf}
              unit={unit}
              agent={agent}
              className="col-span-5"
            />
          </div>
        </div>
      )}
    </div>
  );
}
