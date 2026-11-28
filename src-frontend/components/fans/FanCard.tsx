import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Fan, Lock, Pencil, X } from "lucide-react";
import type { FanTelemetry, SensorLabelMeta } from "../../types";
import GlassCard from "../layout/GlassCard";
import { IconButton, Slider, Tag, TextField } from "../ui";
import { cn } from "../../lib/format";
import FanGauge from "./FanGauge";
import { isPump } from "./fanHelpers";

export const FAN_MIN_PCT = 20;
export const FAN_MAX_PCT = 100;
const DEBOUNCE_MS = 250;
const MAX_LABEL_LEN = 64;

export interface FanCardProps {
  fan: FanTelemetry;
  /** Display name: the user's label, else the default name. */
  label: string;
  /** Saves a label ("" restores the default name). */
  onRename?: (id: string, label: string, meta: SensorLabelMeta) => void;
  /** Recent speeds of this fan, oldest first (sparkline). */
  rpmHistory?: readonly (number | null)[];
  /** Whether the slider may be moved right now (admin + controllable + a manual preset + not locked). */
  canControl: boolean;
  /** True while the motherboard's own curve drives this header (preset Auto). */
  biosControlled?: boolean;
  /** True while the thermal override holds every header at 100%. */
  held?: boolean;
  /** Why the slider is disabled, shown between the ends ("Set a preset to change"). */
  hint?: string | null;
  /** Called (debounced) with the new duty cycle. */
  onSetPct: (id: string, pct: number) => void;
}

function clampPct(v: number) {
  if (!Number.isFinite(v)) return 50;
  return Math.max(FAN_MIN_PCT, Math.min(FAN_MAX_PCT, Math.round(v)));
}

/**
 * One motherboard fan header (SPEC §15, mock cooling-fans): name and tag, a large rpm number with
 * session min / max, a sparkline, and the duty-cycle slider (graphite; disabled with a hint while
 * the BIOS curve is in control).
 */
export default function FanCard({ fan, label, onRename, rpmHistory, canControl, biosControlled = false, held = false, hint, onSetPct }: FanCardProps) {
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
  const active = fan.controllable && canControl && !held;
  const knownPct = telemetryPct != null && Number.isFinite(telemetryPct) ? Math.round(Math.max(0, Math.min(100, telemetryPct))) : null;
  const shownPct = held ? 100 : active ? draft : knownPct;
  const dutyLabel = held ? "Duty cycle · held at 100%" : biosControlled && fan.controllable ? "Duty cycle · BIOS curve" : "Duty cycle";
  const DeviceIcon = Fan;

  return (
    <GlassCard className="group" aria-label={label}>
      <div className="flex min-h-[22px] items-center justify-between gap-2">
        {editing ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <TextField
              autoFocus
              value={labelDraft}
              maxLength={MAX_LABEL_LEN}
              onChange={setLabelDraft}
              onKeyDown={onRenameKey}
              aria-label={`Name for ${fan.name}`}
              placeholder={fan.name}
              className="min-w-0 flex-1"
            />
            <IconButton icon={Check} label="Save name" onClick={saveRename} />
            <IconButton icon={X} label="Cancel" onClick={() => setEditing(false)} />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <DeviceIcon size={16} className="shrink-0 text-icon-2" aria-hidden="true" />
            <b className="truncate text-title-2 text-ink" title={label !== fan.name ? `${label} (${fan.name})` : label}>
              {label}
            </b>
            {isPump(fan.name) || isPump(label) ? <Tag title="Liquid-cooling pump header">Pump</Tag> : null}
            {onRename && (
              <button
                type="button"
                onClick={startRename}
                title={`Rename ${label}`}
                aria-label={`Rename ${label}`}
                className="shrink-0 rounded-xs p-0.5 text-ink-3 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Pencil size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {!editing &&
          (fan.controllable ? (
            <Tag title="This header accepts a duty cycle (PWM)">PWM</Tag>
          ) : (
            <Tag title="This header reports its speed but accepts no duty cycle" className="gap-1">
              <Lock size={10} aria-hidden="true" />
              Read-only
            </Tag>
          ))}
      </div>
      <div className="mt-px truncate text-callout text-ink-3" title={fan.hardware}>
        {label !== fan.name ? `${fan.name} · ` : ""}
        {fan.hardware || "—"}
      </div>

      <FanGauge rpm={rpm} rpmMin={fan.rpmMin} rpmMax={fan.rpmMax} history={rpmHistory} className="mt-3.5" />

      <div className="mb-2 flex justify-between text-callout text-ink-2">
        <span>{dutyLabel}</span>
        <b className={cn("tnum font-semibold", shownPct == null ? "text-ink-3" : "text-ink")}>{shownPct == null ? "—" : `${shownPct}%`}</b>
      </div>
      {shownPct == null ? (
        // No duty reading: leave the track empty rather than drawing a made-up level.
        <div className="flex h-4 items-center" aria-hidden="true">
          <div className="h-1 w-full rounded-[2px] bg-slider-track" />
        </div>
      ) : (
        <Slider
          value={Math.max(FAN_MIN_PCT, shownPct)}
          min={FAN_MIN_PCT}
          max={FAN_MAX_PCT}
          step={1}
          disabled={!active}
          ariaLabel={`${label} duty cycle`}
          onChange={change}
        />
      )}
      <div className="tnum mt-1.5 flex justify-between gap-2 text-callout text-ink-3">
        <span>{FAN_MIN_PCT}%</span>
        {!active && hint && <span className="truncate">{hint}</span>}
        <span>{FAN_MAX_PCT}%</span>
      </div>
    </GlassCard>
  );
}
