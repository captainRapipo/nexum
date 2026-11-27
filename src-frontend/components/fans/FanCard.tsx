import { useEffect, useRef, useState } from "react";
import { Fan, Lock } from "lucide-react";
import type { FanTelemetry } from "../../types";
import { cn } from "../../lib/format";
import FanGauge from "./FanGauge";

export const FAN_MIN_PCT = 20;
export const FAN_MAX_PCT = 100;
const DEBOUNCE_MS = 250;

export interface FanCardProps {
  fan: FanTelemetry;
  /** Scale for the gauge (observed max or a sensible default). */
  maxRpm: number;
  /** Whether manual control is allowed right now (admin + controllable). */
  canControl: boolean;
  /** Called (debounced) with the new duty cycle. */
  onSetPct: (id: string, pct: number) => void;
}

function isPump(name: string) {
  return /pump|aio/i.test(name);
}

export default function FanCard({ fan, maxRpm, canControl, onSetPct }: FanCardProps) {
  const telemetryPct = fan.controlPct;
  const [draft, setDraft] = useState<number>(clampPct(telemetryPct ?? 50));
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

  const stalled = fan.rpm <= 0;
  const pump = isPump(fan.name);
  const color = pump ? "#9333EA" : "#22D3EE";
  const fill = ((draft - FAN_MIN_PCT) / (FAN_MAX_PCT - FAN_MIN_PCT)) * 100;

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-white/[0.02] p-4 transition",
        stalled ? "border-rose/30" : "border-line hover:border-cyan/25",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Fan
              size={14}
              className={cn(pump ? "text-purple" : "text-cyan", !stalled && "nx-fan-spin")}
              style={!stalled ? { animationDuration: `${Math.max(0.25, 3 - (fan.rpm / Math.max(1, maxRpm)) * 2.6)}s` } : undefined}
            />
            <span className="truncate text-[13px] font-semibold text-ink" title={fan.name}>
              {fan.name}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-muted" title={fan.hardware}>
            {fan.hardware || "—"}
          </div>
        </div>
        {fan.controllable ? (
          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider",
              canControl ? "border-teal/40 bg-teal/10 text-teal" : "border-line bg-white/5 text-muted",
            )}
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
        <FanGauge rpm={fan.rpm} maxRpm={maxRpm} color={color} stalled={stalled} />
      </div>
      {stalled && <div className="-mt-1 text-center text-[10.5px] uppercase tracking-[0.16em] text-rose">Stopped / 0 RPM</div>}

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-[10.5px]">
          <span className="uppercase tracking-[0.16em] text-muted">Duty cycle</span>
          <span className="font-mono text-[12px] text-ink">
            {fan.controllable ? `${Math.round(canControl ? draft : (telemetryPct ?? draft))}%` : "—"}
          </span>
        </div>
        {fan.controllable && canControl ? (
          <input
            type="range"
            min={FAN_MIN_PCT}
            max={FAN_MAX_PCT}
            step={1}
            value={draft}
            aria-label={`${fan.name} duty cycle`}
            onChange={(e) => change(Number(e.target.value))}
            className="nx-range w-full"
            style={{
              background: `linear-gradient(90deg, ${color} 0%, ${color} ${fill}%, rgba(255,255,255,0.08) ${fill}%, rgba(255,255,255,0.08) 100%)`,
            }}
          />
        ) : (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full bg-white/20"
              style={{ width: `${clampPct(telemetryPct ?? 0)}%` }}
            />
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
