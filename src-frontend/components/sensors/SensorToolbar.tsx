import type { ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown, RotateCcw } from "lucide-react";
import { Button, Checkbox, Segmented } from "../ui";

/** Which sensors the list shows (filter bar, first control). */
export type SensorFilter = "all" | "pinned" | "changed";

const FILTER_OPTIONS: { value: SensorFilter; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every sensor" },
  { value: "pinned", label: "Pinned", title: "Only the sensors pinned to the Dashboard" },
  { value: "changed", label: "Changed", title: "Only sensors whose value has changed since Min, Max and Avg were last reset" },
];

export interface SensorToolbarProps {
  filter: SensorFilter;
  onFilter: (f: SensorFilter) => void;
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
  /** The "Log to CSV" group (`SensorLogControls`), placed before the reset buttons. */
  children?: ReactNode;
}

/**
 * Filter bar of the Sensors list page (SPEC §3, CONTRACT §4.10.3): 44 px, white, hairline below.
 * Left: which sensors are listed. Right: the CSV log group, then reset and expand / collapse.
 * The text filter lives in the app toolbar (Ctrl+K). Every control has a text label or a tooltip.
 */
export function SensorToolbar(p: SensorToolbarProps) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3.5 whitespace-nowrap border-b border-hairline bg-content px-(--page-pad-x)">
      <Segmented value={p.filter} options={FILTER_OPTIONS} onChange={p.onFilter} size="sm" ariaLabel="Sensors shown" disabled={p.disabled} />
      <span title="Hides sensors with no reading, and fan headers or voltage rails that have read 0 this session.">
        <Checkbox checked={p.hideUnused} onChange={p.onHideUnused} label="Hide unused" disabled={p.disabled} />
      </span>
      <span title="Shows sensors you hid, dimmed, so you can unhide them.">
        <Checkbox
          checked={p.showHidden}
          onChange={p.onShowHidden}
          label={p.hiddenCount > 0 ? `Show hidden (${p.hiddenCount})` : "Show hidden"}
          disabled={p.disabled}
        />
      </span>

      <span className="min-w-0 flex-1" />

      {p.children}
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-divider" />
      <div className="flex shrink-0 items-center gap-1.5">
        {p.selectedCount > 0 && (
          <Button
            size="sm"
            onClick={p.onResetSelected}
            disabled={p.disabled}
            loading={p.resetting === "selected"}
            title="Reset Min, Max and Avg of the selected sensors"
          >
            Reset selected ({p.selectedCount})
          </Button>
        )}
        <Button
          size="sm"
          icon={RotateCcw}
          onClick={p.onResetAll}
          disabled={p.disabled}
          loading={p.resetting === "all"}
          title="Reset Min, Max and Avg of every sensor and start a new session"
        >
          Reset all
        </Button>
        {/* Regular mode: text buttons. Tight mode: the same two actions as icon buttons. */}
        <span className="contents tight:hidden">
          <Button size="sm" variant="plain" onClick={p.onExpandAll} disabled={p.disabled}>
            Expand all
          </Button>
          <Button size="sm" variant="plain" onClick={p.onCollapseAll} disabled={p.disabled}>
            Collapse all
          </Button>
        </span>
        <span className="hidden tight:contents">
          <Button size="sm" variant="plain" icon={ChevronsUpDown} onClick={p.onExpandAll} disabled={p.disabled} title="Expand all" aria-label="Expand all" />
          <Button size="sm" variant="plain" icon={ChevronsDownUp} onClick={p.onCollapseAll} disabled={p.disabled} title="Collapse all" aria-label="Collapse all" />
        </span>
      </div>
    </div>
  );
}

export default SensorToolbar;
