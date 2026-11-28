import { Cpu, Feather, Gauge, Loader2, Rocket, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { FanPreset } from "../../types";
import { cn } from "../../lib/format";

export type SelectablePreset = Exclude<FanPreset, "custom">;

/** Exact subtitle for every non-auto preset (CONTRACT §1.2, §4.8). */
export const FIXED_SPEED_TEXT = "Fixed speed, ignores temperature";

const PRESETS: { id: SelectablePreset; label: string; duty: string | null; desc: string; Icon: LucideIcon }[] = [
  { id: "auto", label: "Auto (BIOS)", duty: null, desc: "Motherboard fan curve", Icon: Cpu },
  { id: "silent", label: "Silent", duty: "30%", desc: FIXED_SPEED_TEXT, Icon: Feather },
  { id: "balanced", label: "Balanced", duty: "50%", desc: FIXED_SPEED_TEXT, Icon: Gauge },
  { id: "turbo", label: "Turbo", duty: "100%", desc: FIXED_SPEED_TEXT, Icon: Rocket },
];

export interface PresetSelectorProps {
  /** Preset in effect (telemetry, or the optimistic choice). */
  active: FanPreset | null;
  pending: SelectablePreset | null;
  disabled?: boolean;
  onSelect: (p: SelectablePreset) => void;
  /**
   * The user picked the Custom tile. Nothing is sent: it only unlocks the per-fan sliders, and the
   * first slider move makes the preset "custom". Omit to show Custom as a state only.
   */
  onCustom?: () => void;
  /** Custom was picked but no slider has moved yet (the tile shows selected). */
  customArmed?: boolean;
}

/**
 * Preset tiles (SPEC §6 "selected card"): the selected tile has the neutral ink outline and a filled
 * radio mark. Selection is never crimson.
 */
export default function PresetSelector({ active, pending, disabled, onSelect, onCustom, customArmed = false }: PresetSelectorProps) {
  const customOn = active === "custom" || customArmed;
  return (
    <div role="radiogroup" aria-label="Fan preset" className="grid grid-cols-5 gap-2.5">
      {PRESETS.map((p) => (
        <Tile
          key={p.id}
          label={p.label}
          duty={p.duty}
          desc={p.desc}
          Icon={p.Icon}
          selected={!customOn && active === p.id}
          pending={pending === p.id && active !== p.id}
          disabled={disabled}
          onClick={() => onSelect(p.id)}
          title={
            p.id === "auto"
              ? "Return every fan to the motherboard's own fan curve"
              : `${p.label}: every fan at ${p.duty}. ${FIXED_SPEED_TEXT}.`
          }
        />
      ))}
      <Tile
        label="Custom"
        duty="per fan"
        desc={FIXED_SPEED_TEXT}
        Icon={SlidersHorizontal}
        selected={customOn}
        pending={false}
        disabled={disabled || (!onCustom && !customOn)}
        onClick={() => onCustom?.()}
        title={`Custom: your own speed for each fan, set with its slider. ${FIXED_SPEED_TEXT}.`}
      />
    </div>
  );
}

function Tile({
  label,
  duty,
  desc,
  Icon,
  selected,
  pending,
  disabled,
  onClick,
  title,
}: {
  label: string;
  duty: string | null;
  desc: string;
  Icon: LucideIcon;
  selected: boolean;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "flex min-w-0 items-start gap-[11px] rounded-lg bg-card px-3.5 py-3 text-left transition-shadow duration-[140ms]",
        selected ? "shadow-selected" : "shadow-[inset_0_0_0_1px_var(--color-subtle)] hover:bg-row-alt",
        disabled && "text-ink-disabled hover:bg-card",
      )}
    >
      {/* Tight mode: five tiles share a narrow row, so the icon well gives its width to the text (the spinner still shows). */}
      <span
        className={cn(
          "flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-inset",
          !pending && "tight:hidden",
          disabled ? "text-ink-disabled" : "text-icon-2",
        )}
      >
        {pending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <b className={cn("block truncate text-headline", disabled ? "text-ink-disabled" : "text-ink")}>
          {label}
          {duty && <small className={cn("tnum ml-[5px] text-[11.5px] font-medium", disabled ? "text-ink-disabled" : "text-ink-3")}>{duty}</small>}
        </b>
        <span className={cn("block text-callout", disabled ? "text-ink-disabled" : "text-ink-2")}>{desc}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 h-[15px] w-[15px] shrink-0 rounded-full",
          selected
            ? disabled
              ? "shadow-[inset_0_0_0_4.5px_var(--color-ink-disabled)]"
              : "shadow-[inset_0_0_0_4.5px_var(--color-control-on)]"
            : "shadow-[inset_0_0_0_1px_var(--color-control-border)]",
        )}
      />
    </button>
  );
}
