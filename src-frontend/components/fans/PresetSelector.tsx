import { Cpu, Feather, Gauge, Rocket, SlidersHorizontal } from "lucide-react";
import type { FanPreset } from "../../types";
import { cn } from "../../lib/format";

export type SelectablePreset = Exclude<FanPreset, "custom">;

/** Exact subtitle for every non-auto preset (CONTRACT §1.2, §4.8). */
export const FIXED_SPEED_TEXT = "Fixed speed, ignores temperature";

const PRESETS: { id: SelectablePreset; label: string; duty: string; desc: string; Icon: typeof Cpu }[] = [
  { id: "auto", label: "Auto (BIOS)", duty: "BIOS", desc: "Motherboard fan curve", Icon: Cpu },
  { id: "silent", label: "Silent", duty: "30%", desc: FIXED_SPEED_TEXT, Icon: Feather },
  { id: "balanced", label: "Balanced", duty: "50%", desc: FIXED_SPEED_TEXT, Icon: Gauge },
  { id: "turbo", label: "Turbo", duty: "100%", desc: FIXED_SPEED_TEXT, Icon: Rocket },
];

export interface PresetSelectorProps {
  active: FanPreset | null;
  pending: SelectablePreset | null;
  disabled?: boolean;
  onSelect: (p: SelectablePreset) => void;
}

export default function PresetSelector({ active, pending, disabled, onSelect }: PresetSelectorProps) {
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Fan preset" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {PRESETS.map((p) => {
          const isActive = active === p.id;
          const isPending = pending === p.id && !isActive;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={disabled}
              onClick={() => onSelect(p.id)}
              title={p.id === "auto" ? "Return every fan to the motherboard's own fan curve" : `${p.label}: every fan at ${p.duty}. ${FIXED_SPEED_TEXT}.`}
              className={cn(
                "relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border px-3.5 py-3 text-left transition",
                isActive ? "border-teal/55 bg-teal/[0.08]" : "border-line bg-white/[0.02] hover:border-white/20",
                disabled && "cursor-not-allowed opacity-45 hover:border-line",
              )}
            >
              {isActive && <span className="absolute inset-x-0 top-0 h-[2px] bg-teal" />}
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                  isActive ? "border-teal/50 text-teal" : "border-line text-silver",
                  isPending && "animate-pulse",
                )}
              >
                <p.Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[13px] font-semibold", isActive ? "text-ink" : "text-silver")}>
                  {p.label} <span className="font-mono text-[11px] font-normal text-muted">{p.duty}</span>
                </span>
                <span className="block truncate text-[11px] text-muted">{p.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
      {active === "custom" && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-[12px] text-silver">
          <SlidersHorizontal size={14} />
          Custom: duty cycles set per fan. {FIXED_SPEED_TEXT}.
        </div>
      )}
    </div>
  );
}
