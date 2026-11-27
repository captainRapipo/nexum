import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Fan, Lock, Pencil, X } from "lucide-react";
import type { FanTelemetry, SensorLabelMeta } from "../../types";
import { cn, fmtRpm } from "../../lib/format";
import FanGauge from "./FanGauge";

export const FAN_MIN_PCT = 20;
export const FAN_MAX_PCT = 100;
const DEBOUNCE_MS = 250;
const MAX_LABEL_LEN = 64;

export interface FanCardProps {
  fan: FanTelemetry;
  /** Display name: the user's label, else the LHM default name. */
  label: string;
  /** Saves a label ("" restores the default name). */
  onRename?: (id: string, label: string, meta: SensorLabelMeta) => void;
  /** Scale for the gauge (session max or a sensible default). */
  maxRpm: number;
  /** Whether manual control is allowed right now (admin + controllable + not locked). */
  canControl: boolean;
  /** True while the thermal override holds every header at 100%. */
  held?: boolean;
  /** Called (debounced) with the new duty cycle. */
  onSetPct: (id: string, pct: number) => void;
}

function isPump(name: string) {
  return /pump|aio/i.test(name);
}

export default function FanCard({ fan, label, onRename, maxRpm, canControl, held = false, onSetPct }: FanCardProps) {
  const telemetryPct = fan.controlPct;
  const [draft, setDraft] = useState<number>(clampPct(telemetryPct ?? 50));
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(label);
  const dirtyUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSetRef = useRef(onSetPct);
  onSetRef.current = onSetPct;

  // Follow the live duty cycle unless the user has just moved the slider.
  useEffect(() => {
    if (telemetryPct == null) return;
    if (Date.now() < dirtyUntil.current) return;
    setDraft(clampPct(telemetryPct));
  }, [telemetryPct]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const change = (v: number) => {
    const pct = clampPct(v);
    setDraft(pct);
    // Hold off telemetry sync while the command round-trips (debounce + a couple of packets).
    dirtyUntil.current = Date.now() + DEBOUNCE_MS + 2500;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSetRef.current(fan.id, pct);
    }, DEBOUNCE_MS);
  };

  const startRename = () => {
    setLabelDraft(label);
    setEditing(true);
  };
  const saveRename = () => {
    const next = labelDraft.trim().slice(0, MAX_LABEL_LEN);
    onRename?.(fan.id, next === fan.name ? "" : next, { defaultName: fan.name, hardwareName: fan.hardware });
    setEditing(false);
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  };

  const rpm = Number.isFinite(fan.rpm) ? fan.rpm : 0;
  const stopped = rpm <= 0;
  const pump = isPump(fan.name) || isPump(label);
  const color = pump ? "#A855F7" : "#22D3EE";
  const fill = ((draft - FAN_MIN_PCT) / (FAN_MAX_PCT - FAN_MIN_PCT)) * 100;

  return (
    <div className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-white/[0.02] p-4 transition hover:border-cyan/25">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={labelDraft}
                maxLength={MAX_LABEL_LEN}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={onRenameKey}
                aria-label={`Name for ${fan.name}`}
                placeholder={fan.name}
                className="min-w-0 flex-1 rounded border border-cyan/40 bg-canvas-0/80 px-1.5 py-0.5 text-[12.5px] text-ink outline-none"
              />
              <button type="button" onClick={saveRename} title="Save name" aria-label="Save name" className="rounded p-1 text-silver hover:text-ink">
                <Check size={13} />
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                title="Cancel"
                aria-label="Cancel rename"
                className="rounded p-1 text-muted hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Fan
                size={14}
                className={cn("shrink-0", pump ? "text-purple-400" : "text-cyan", !stopped && "nx-fan-spin")}
                style={!stopped ? { animationDuration: `${Math.max(0.25, 3 - (rpm / Math.max(1, maxRpm)) * 2.6)}s` } : undefined}
              />
              <span className="truncate text-[13px] font-semibold text-ink" title={label !== fan.name ? `${label} (${fan.name})` : label}>
                {label}
              </span>
              {onRename && (
                <button
                  type="button"
                  onClick={startRename}
                  title={`Rename ${label}`}
                  aria-label={`Rename ${label}`}
                  className="shrink-0 rounded p-0.5 text-muted opacity-0 transition hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 truncate text-[10.5px] text-muted" title={fan.hardware}>
            {label !== fan.name ? `${fan.name} · ` : ""}
            {fan.hardware || "—"}
          </div>
        </div>
        {fan.controllable ? (
          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider",
              canControl ? "border-teal/40 bg-teal/10 text-teal" : "border-line bg-white/5 text-muted",
            )}
            title="This header accepts a PWM duty cycle"
          >
            PWM
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded border border-line bg-white/5 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-muted">
            <Lock size={9} />
            Read-only
          </span>
        )}
      </div>

      <div className="mt-2 flex justify-center">
        <FanGauge rpm={rpm} maxRpm={maxRpm} color={color} stalled={false} />
      </div>
      <div className="-mt-1 text-center font-mono text-[10.5px] text-muted">
        {stopped ? (
          <span>Not spinning</span>
        ) : (
          <span>
            Min {fan.rpmMin != null ? Math.round(fan.rpmMin).toLocaleString("en-US") : "—"} · Max{" "}
            {fan.rpmMax != null ? fmtRpm(fan.rpmMax) : "—"}
          </span>
        )}
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-[10.5px]">
          <span className="uppercase tracking-[0.16em] text-muted">Duty cycle</span>
          <span className="font-mono text-[12px] text-ink">
            {fan.controllable ? (held ? "100% (held)" : `${Math.round(canControl ? draft : (telemetryPct ?? draft))}%`) : "—"}
          </span>
        </div>
        {fan.controllable && canControl ? (
          <input
            type="range"
            min={FAN_MIN_PCT}
            max={FAN_MAX_PCT}
            step={1}
            value={draft}
            aria-label={`${label} duty cycle`}
            onChange={(e) => change(Number(e.target.value))}
            className="nx-range w-full"
            style={{
              background: `linear-gradient(90deg, ${color} 0%, ${color} ${fill}%, rgba(255,255,255,0.08) ${fill}%, rgba(255,255,255,0.08) 100%)`,
            }}
          />
        ) : (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-white/20" style={{ width: `${clampPct(telemetryPct ?? 0)}%` }} />
          </div>
        )}
        <div className="mt-1 flex justify-between font-mono text-[9.5px] text-muted">
          <span>{FAN_MIN_PCT}%</span>
          <span>{FAN_MAX_PCT}%</span>
        </div>
      </div>
    </div>
  );
}

function clampPct(v: number) {
  if (!Number.isFinite(v)) return 50;
  return Math.max(FAN_MIN_PCT, Math.min(FAN_MAX_PCT, Math.round(v)));
}

/** Styles for the slider thumb + spinning fan icon; render once per view. */
export const FAN_CARD_CSS = `
@keyframes nx-fan-spin { to { transform: rotate(360deg); } }
.nx-fan-spin { animation: nx-fan-spin 1.2s linear infinite; transform-origin: center; }
@media (prefers-reduced-motion: reduce) { .nx-fan-spin { animation: none; } }
.nx-range { -webkit-appearance: none; appearance: none; height: 6px; border-radius: 999px; outline: none; cursor: pointer; }
.nx-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 999px;
  background: #F8FAFC; border: 2px solid #22D3EE; box-shadow: 0 0 10px rgba(34,211,238,0.6); transition: transform 120ms; }
.nx-range:active::-webkit-slider-thumb { transform: scale(1.15); }
.nx-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(34,211,238,0.25), 0 0 10px rgba(34,211,238,0.6); }
.nx-range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 999px; background: #F8FAFC; border: 2px solid #22D3EE; }
`;
