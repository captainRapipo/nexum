import { memo, type MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/format";
import { unitText } from "../telemetry/sensorHelpers";
import { GRID_COLS } from "./SensorRow";
import { HW_ICON, INDENT, KIND_LABEL, ROOT_ICON, ROW_H, type GroupRow, type HwRow, type RootRow } from "./sensorTreeModel";

export interface TreeNodeRowProps {
  row: RootRow | HwRow | GroupRow;
  /** 1-based position in the treegrid (row 1 is the column header). */
  rowIndex: number;
  domId: string;
  top: number;
  /** Zebra: every second row of the list. */
  alt: boolean;
  tempUnit: "C" | "F";
  selected: boolean;
  focused: boolean;
  onPointerSelect: (e: MouseEvent, key: string) => void;
  onToggle: (key: string) => void;
}

/**
 * This PC (root), a hardware node, or a sensor-kind group (SPEC §8). Hardware rows are semibold with
 * a 15 px icon; a group row reads "Temperatures · °C 6": the unit once for the whole group, then
 * the number of sensors in tertiary text.
 */
function TreeNodeRowImpl({ row, rowIndex, domId, top, alt, tempUnit, selected, focused, onPointerSelect, onToggle }: TreeNodeRowProps) {
  let Icon = ROOT_ICON;
  let title = "";
  let count = "";
  let countLabel = "";
  let units = "";
  if (row.kind === "root") {
    title = row.name;
    count = `${row.sensorCount} sensor${row.sensorCount === 1 ? "" : "s"}`;
    countLabel = count;
  } else if (row.kind === "hw") {
    Icon = HW_ICON[row.hw.kind] ?? HW_ICON.other;
    title = row.hw.name;
    count = row.sensorCount > 0 ? String(row.sensorCount) : "";
    countLabel = count ? `${count} sensors` : "";
  } else {
    title = KIND_LABEL[row.sensorKind];
    count = String(row.sensorIds.length);
    countLabel = `${count} sensors`;
    units = [...new Set(row.units.map((u) => unitText(u, tempUnit)))].join(" · ");
  }

  const isGroup = row.kind === "group";
  const Chevron = row.expanded ? ChevronDown : ChevronRight;

  return (
    <div
      id={domId}
      role="row"
      aria-rowindex={rowIndex}
      aria-level={row.level + 1}
      aria-selected={selected}
      aria-expanded={row.expandable ? row.expanded : undefined}
      onMouseDown={(e) => onPointerSelect(e, row.key)}
      onDoubleClick={() => row.expandable && onToggle(row.key)}
      className={cn(
        "absolute inset-x-0 grid select-none items-center text-table",
        selected ? "bg-selected" : cn(alt && "bg-row-alt", "hover:bg-hover"),
        focused && "group-focus-visible/grid:shadow-[inset_0_0_0_2px_var(--color-control-on)]",
      )}
      style={{ top, height: ROW_H, gridTemplateColumns: GRID_COLS }}
    >
      <div
        role="gridcell"
        aria-colindex={1}
        aria-colspan={7}
        aria-label={[title, units ? `in ${units}` : "", countLabel].filter(Boolean).join(", ")}
        className="col-span-7 flex min-w-0 items-center pr-3"
        style={{ paddingLeft: `calc(var(--page-pad-x) + ${row.level * INDENT}px)` }}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.expanded ? `Collapse ${title}` : `Expand ${title}`}
          title={row.expanded ? "Collapse (Left)" : "Expand (Right)"}
          disabled={!row.expandable}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.key);
          }}
          className={cn(
            "-ml-1 mr-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-xs text-ink-3 hover:bg-pressed hover:text-ink",
            !row.expandable && "invisible",
          )}
        >
          <Chevron size={12} aria-hidden="true" />
        </button>
        {!isGroup && <Icon size={15} aria-hidden="true" className="mr-[7px] shrink-0 text-icon-2" />}
        <span className={cn("truncate font-semibold", isGroup ? "text-[12px] text-ink-2" : "text-ink")} title={title}>
          {title}
        </span>
        {units && <span className="ml-1.5 shrink-0 whitespace-nowrap text-[12px] text-ink-3">· {units}</span>}
        {count && <span className="ml-2 shrink-0 whitespace-nowrap text-[11.5px] text-ink-3 tnum">{count}</span>}
      </div>
    </div>
  );
}

export const TreeNodeRow = memo(TreeNodeRowImpl);
export default TreeNodeRow;
