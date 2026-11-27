import { Cpu, Feather, Gauge, Rocket, SlidersHorizontal } from "lucide-react";
import type { FanPreset } from "../../types";
import { cn } from "../../lib/format";

export type SelectablePreset = Exclude<FanPreset, "custom">;

const PRESETS: { id: SelectablePreset; label: string; duty: string; desc: string; Icon: typeof Cpu }[] = [
  { id: "silent", label: "Silent", duty: "30%", desc: "Lowest noise", Icon: Feather },
  { id: "balanced", label: "Balanced", duty: "50%", desc: "Everyday default", Icon: Gauge },
  { id: "turbo", label: "Turbo", duty: "100%", desc: "Max airflow", Icon: Rocket },
  { id: "auto", label: "Auto (BIOS)", duty: "BIOS", desc: "Release to firmware curve", Icon: Cpu },
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
              className={cn(
                "relative flex items-center gap-3 overflow-hidden rounded-xl border px-3.5 py-3 text-left transition",
                isActive
                  ? "border-gold/60 bg-gold/[0.09] shadow-[0_0_22px_rgba(212,163,89,0.18)]"
                  : "border-line bg-white/[0.02] hover:border-white/20",
                disabled && "cursor-not-allowed opacity-45 hover:border-line",
              )}
            >
              {isActive && <span className="absolute inset-x-0 top-0 h-[2px] bg-gold shadow-[0_0_10px_rgba(212,163,89,0.8)]" />}
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                  isActive ? "border-gold/50 text-gold" : "border-line text-silver",
                  isPending && "animate-pulse",
                )}
              >
                <p.Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className={cn("block text-[13px] font-semibold", isActive ? "text-gold" : "text-ink")}>{p.label}</span>
                <span className="block truncate text-[11px] text-muted">
                  <span className="font-mono text-silver">{p.duty}</span> · {p.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {active === "custom" && (
        <div className="flex items-center gap-2 rounded-lg border border-cyan/30 bg-cyan/[0.06] px-3 py-2 text-[12px] text-cyan">
          <SlidersHorizontal size={14} />
          Custom — manual duty cycles set per fan. Pick a preset to override.
        </div>
      )}
    </div>
  );
}
