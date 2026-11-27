import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Fan, ShieldAlert, Wind } from "lucide-react";
import type { AgentAck, FanPreset } from "../types";
import { api, onEvent } from "../lib/api";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useSettings } from "../hooks/useSettings";
import GlassCard from "../components/layout/GlassCard";
import { StatusPill } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import FanCard, { FAN_CARD_CSS } from "../components/fans/FanCard";
import PresetSelector, { type SelectablePreset } from "../components/fans/PresetSelector";
import { CpuPanel, GpuPanel, RamPanel } from "../components/fans/HardwarePanels";

const OVERRIDE_MS = 5000;
const FAN_CONTROL_MSG = "Fan control requires Administrator and a supported Super I/O chip";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/** Accept either a bare payload or a Tauri `Event<T>` wrapper. */
function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && "payload" in (raw as Record<string, unknown>) && "event" in (raw as Record<string, unknown>)) {
    return (raw as { payload: T }).payload;
  }
  return raw as T;
}

const PRESET_NAME: Record<FanPreset, string> = {
  auto: "Auto (BIOS)",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

function defaultMax(name: string) {
  return /pump|aio/i.test(name) ? 3000 : 2000;
}

export default function FanControlView() {
  const { latest, history, agent } = useTelemetry();
  const { info } = useSystemInfo();
  const { settings } = useSettings();
  const unit = settings?.tempUnit ?? "C";

  const fans = useMemo(() => latest?.fans ?? [], [latest]);
  const isAdmin = agent?.isAdmin ?? info?.isAdmin ?? false;
  const controllable = fans.filter((f) => f.controllable);
  const canControl = isAdmin && controllable.length > 0;

  const [override, setOverride] = useState<{ preset: FanPreset; until: number } | null>(null);
  const [pending, setPending] = useState<SelectablePreset | null>(null);
  const [lastAck, setLastAck] = useState<(AgentAck & { at: number }) | null>(null);

  const livePreset: FanPreset | null = latest?.fanPreset ?? null;
  const shownPreset: FanPreset | null =
    override && Date.now() < override.until ? override.preset : livePreset;

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
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onEvent<AgentAck>("agent-ack", (raw: unknown) => {
      const ack = unwrap<AgentAck>(raw);
      if (!ack || typeof ack.cmd !== "string") return;
      if (!/^fan/i.test(ack.cmd)) return;
      setLastAck({ ...ack, at: Date.now() });
      toast(ack.message || (ack.ok ? "Fan command applied" : "Fan command failed"), ack.ok ? "ok" : "crit");
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {
        /* event bridge unavailable – acks simply won't show */
      });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

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

  const setPct = useCallback((id: string, pct: number) => {
    setOverride({ preset: "custom", until: Date.now() + OVERRIDE_MS });
    api.setFanControl(id, pct).catch((e: unknown) => toast(`Fan command failed: ${errMsg(e)}`, "crit"));
  }, []);

  // Gauge scale per fan: observed peak in the history window, rounded up to 500 RPM.
  const maxRpm = useMemo(() => {
    const peaks = new Map<string, number>();
    for (const p of history ?? []) {
      for (const f of p.fans ?? []) {
        if (Number.isFinite(f.rpm) && f.rpm > (peaks.get(f.id) ?? 0)) peaks.set(f.id, f.rpm);
      }
    }
    const out = new Map<string, number>();
    for (const f of fans) {
      const peak = Math.max(peaks.get(f.id) ?? 0, f.rpm || 0);
      out.set(f.id, Math.max(defaultMax(f.name), Math.ceil((peak * 1.15) / 500) * 500));
    }
    return out;
  }, [history, fans]);

  const spinning = fans.filter((f) => f.rpm > 0);
  const avgRpm = spinning.length ? spinning.reduce((a, f) => a + f.rpm, 0) / spinning.length : 0;

  return (
    <div className="flex flex-col gap-5">
      <style>{FAN_CARD_CSS}</style>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-gold/80">Module A · Thermal Control</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">Fan Control &amp; Hardware</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Super I/O PWM headers, cooling presets and live CPU / GPU / memory sensors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {agent && !agent.running ? (
            <StatusPill tone="crit" pulse>
              Agent offline
            </StatusPill>
          ) : (
            <StatusPill tone={isAdmin ? "ok" : "warn"}>{isAdmin ? "Administrator" : "Standard user"}</StatusPill>
          )}
          {shownPreset && <StatusPill tone="info">{`Preset · ${PRESET_NAME[shownPreset]}`}</StatusPill>}
        </div>
      </div>

      {agent && !agent.running && (
        <div className="flex items-start gap-3 rounded-xl border border-rose/35 bg-rose/[0.07] px-4 py-3 text-[13px] text-rose">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>Hardware agent is not running{agent.message ? ` — ${agent.message}` : ""}. Sensor values may be stale.</span>
        </div>
      )}

      <GlassCard
        title="Cooling Preset"
        icon={<Wind size={15} />}
        accent="gold"
        actions={
          lastAck ? (
            <span
              className={`max-w-[360px] truncate font-mono text-[11px] ${lastAck.ok ? "text-teal" : "text-rose"}`}
              title={lastAck.message}
            >
              {lastAck.ok ? "ACK" : "ERR"} · {lastAck.message}
            </span>
          ) : undefined
        }
      >
        <PresetSelector active={shownPreset} pending={pending} disabled={!canControl || pending !== null} onSelect={(p) => void selectPreset(p)} />
        {!canControl && fans.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-gold/30 bg-gold/[0.06] px-3 py-2.5 text-[12px] text-gold/90">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              {FAN_CONTROL_MSG}.{" "}
              {!isAdmin
                ? "Nexum is running without elevation — restart it as Administrator to unlock PWM control."
                : "No controllable PWM headers were detected on this board; fans are shown read-only."}
            </span>
          </div>
        )}
      </GlassCard>

      <GlassCard
        title="Fans & Pumps"
        icon={<Fan size={15} />}
        accent="cyan"
        actions={
          fans.length > 0 ? (
            <span className="font-mono text-[11px] text-muted">
              {fans.length} headers · avg {Math.round(avgRpm).toLocaleString()} RPM · {controllable.length} PWM
            </span>
          ) : undefined
        }
      >
        {!latest ? (
          <div className="py-14 text-center text-[12px] uppercase tracking-[0.2em] text-muted">Waiting for telemetry stream…</div>
        ) : fans.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-white/[0.03] text-muted">
              <Fan size={26} />
            </div>
            <div className="text-[14px] font-semibold text-ink">No fan sensors available</div>
            <p className="max-w-md text-[12.5px] leading-relaxed text-muted">
              {FAN_CONTROL_MSG}. {!isAdmin ? "Restart Nexum as Administrator so the sensor driver can read the motherboard's fan headers." : "This motherboard's fan controller is not exposed to LibreHardwareMonitor (common on laptops and some OEM boards)."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {fans.map((f) => (
              <FanCard
                key={f.id}
                fan={f}
                maxRpm={maxRpm.get(f.id) ?? defaultMax(f.name)}
                canControl={canControl && f.controllable}
                onSetPct={setPct}
              />
            ))}
          </div>
        )}
      </GlassCard>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <CpuPanel cpu={latest?.cpu ?? null} unit={unit} />
        <GpuPanel gpus={latest?.gpus ?? []} primary={latest?.gpu ?? null} unit={unit} />
        <RamPanel ram={latest?.ram ?? null} />
      </div>
    </div>
  );
}
