import { forwardRef } from "react";
import { ChevronsDownUp, ChevronsUpDown, RotateCcw, Search, X } from "lucide-react";
import { cn } from "../../lib/format";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Toggle";

export interface SensorToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  hideUnused: boolean;
  onHideUnused: (on: boolean) => void;
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  hiddenCount: number;
  selectedCount: number;
  resetting: "all" | "selected" | null;
  onResetAll: () => void;
  onResetSelected: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  disabled: boolean;
}

function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", disabled && "opacity-50")} title={title}>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} disabled={disabled} />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="whitespace-nowrap text-[12px] text-slate-300 hover:text-ink"
      >
        {label}
      </button>
    </div>
  );
}

/** Search, filters and reset actions of the Sensors view. Every control has a text label. */
export const SensorToolbar = forwardRef<HTMLInputElement, SensorToolbarProps>(function SensorToolbar(p, searchRef) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 pb-3">
      <label className="relative flex h-8 min-w-[220px] max-w-[340px] flex-1 items-center">
        <Search size={14} className="pointer-events-none absolute left-2.5 text-slate-500" aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && p.query) {
              e.preventDefault();
              e.stopPropagation();
              p.onQuery("");
            }
          }}
          disabled={p.disabled}
          spellCheck={false}
          aria-label="Search sensors by name or hardware"
          placeholder="Search sensors  (Ctrl+F)"
          className={cn(
            "h-8 w-full rounded-lg border border-line bg-black/25 pl-8 pr-8 text-[12.5px] text-ink outline-none",
            "placeholder:text-slate-600 focus:border-teal/50 focus:shadow-[0_0_0_3px_rgba(45,212,191,0.12)]",
            "[&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {p.query && (
          <button
            type="button"
            onClick={() => p.onQuery("")}
            title="Clear search (Esc)"
            aria-label="Clear search"
            className="absolute right-1.5 flex size-6 items-center justify-center rounded-md text-slate-500 hover:bg-white/[0.06] hover:text-ink"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </label>

      <Switch
        checked={p.hideUnused}
        onChange={p.onHideUnused}
        label="Hide unused"
        title="Hides sensors with no reading, and fan headers or voltage rails that have read 0 this session."
        disabled={p.disabled}
      />
      <Switch
        checked={p.showHidden}
        onChange={p.onShowHidden}
        label={p.hiddenCount > 0 ? `Show hidden (${p.hiddenCount})` : "Show hidden"}
        title="Shows sensors you hid, dimmed, so you can unhide them."
        disabled={p.disabled}
      />

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" icon={ChevronsUpDown} onClick={p.onExpandAll} disabled={p.disabled} title="Expand all">
          Expand all
        </Button>
        <Button size="sm" variant="ghost" icon={ChevronsDownUp} onClick={p.onCollapseAll} disabled={p.disabled} title="Collapse all">
          Collapse all
        </Button>
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          onClick={p.onResetSelected}
          disabled={p.disabled || p.selectedCount === 0}
          loading={p.resetting === "selected"}
          title="Reset Min, Max and Avg of the selected sensors"
        >
          {p.selectedCount > 0 ? `Reset selected (${p.selectedCount})` : "Reset selected"}
        </Button>
        <Button
          size="sm"
          variant="teal"
          icon={RotateCcw}
          onClick={p.onResetAll}
          disabled={p.disabled}
          loading={p.resetting === "all"}
          title="Reset Min, Max and Avg of every sensor and start a new session"
        >
          Reset all
        </Button>
      </div>
    </div>
  );
});

export default SensorToolbar;
