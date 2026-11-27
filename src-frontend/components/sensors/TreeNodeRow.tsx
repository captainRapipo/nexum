import { memo, type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/format";
import { GRID_COLS } from "./SensorRow";
import { HW_ICON, INDENT, KIND_ICON, KIND_LABEL, ROOT_ICON, ROW_H, type GroupRow, type HwRow, type RootRow } from "./sensorTreeModel";

export interface TreeNodeRowProps {
  row: RootRow | HwRow | GroupRow;
  /** 1-based position in the treegrid (row 1 is the column header). */
  rowIndex: number;
  domId: string;
  top: number;
  selected: boolean;
  focused: boolean;
  onPointerSelect: (e: MouseEvent, key: string) => void;
  onToggle: (key: string) => void;
}

/** Hostname root, hardware node or sensor-kind group header. Subtle, never zebra. */
function TreeNodeRowImpl({ row, rowIndex, domId, top, selected, focused, onPointerSelect, onToggle }: TreeNodeRowProps) {
  let Icon = ROOT_ICON;
  let title = "";
  let meta = "";
  if (row.kind === "root") {
    title = row.name;
    meta = `${row.sensorCount} sensor${row.sensorCount === 1 ? "" : "s"}`;
  } else if (row.kind === "hw") {
    Icon = HW_ICON[row.hw.kind] ?? HW_ICON.other;
    title = row.hw.name;
    meta = row.sensorCount > 0 ? String(row.sensorCount) : "";
  } else {
    Icon = KIND_ICON[row.sensorKind];
    title = KIND_LABEL[row.sensorKind];
    meta = String(row.sensorIds.length);
  }

  const isGroup = row.kind === "group";

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
        "absolute inset-x-0 grid select-none items-center gap-x-3 pr-3 transition-colors duration-100",
        selected ? "bg-teal/[0.08]" : "hover:bg-white/[0.025]",
        focused && "shadow-[inset_2px_0_0_0_var(--color-teal)]",
        !isGroup && "border-t border-white/[0.04]",
      )}
      style={{ top, height: ROW_H, gridTemplateColumns: GRID_COLS }}
    >
      <div
        role="gridcell"
        aria-colindex={1}
        aria-colspan={6}
        aria-label={meta ? `${title}, ${row.kind === "root" ? meta : `${meta} sensors`}` : title}
        className="col-span-6 flex min-w-0 items-center gap-1.5"
        style={{ paddingLeft: 4 + row.level * INDENT }}
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
            "flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-white/[0.06] hover:text-slate-200",
            !row.expandable && "invisible",
          )}
        >
          <ChevronRight
            size={13}
            strokeWidth={2.2}
            className={cn("transition-transform duration-150", row.expanded && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        <Icon
          size={isGroup ? 12 : 14}
          strokeWidth={1.9}
          aria-hidden="true"
          className={cn("shrink-0", isGroup ? "text-slate-500" : row.kind === "root" ? "text-teal" : "text-slate-300")}
        />
        {isGroup ? (
          <span className="truncate text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</span>
        ) : (
          <span
            className={cn(
              "truncate font-semibold",
              row.kind === "root" ? "text-[13px] tracking-wide text-ink" : "text-[12.5px] text-slate-100",
            )}
            title={title}
          >
            {title}
          </span>
        )}
        {meta && <span className="num shrink-0 text-[10.5px] text-slate-600">{meta}</span>}
      </div>
    </div>
  );
}

export const TreeNodeRow = memo(TreeNodeRowImpl);
export default TreeNodeRow;
