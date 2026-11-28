import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Copy, Eye, EyeOff, Pencil, Pin, PinOff } from "lucide-react";
import type { UnavailableReason } from "../../types";
import { cn } from "../../lib/format";
import { sensorState } from "../../lib/status";
import { Sparkline, StatusIcon, STATUS_CLASS, TextField, Unavailable } from "../ui";
import { sensorValueParts } from "../telemetry/sensorHelpers";
import { INDENT, ROW_H, type SensorRowModel } from "./sensorTreeModel";

/**
 * Column template shared by the header and every row (CONTRACT §4.10.3):
 * Sensor | Value | Min | Max | Avg | Limit | Last 60 s. The widths come from `--sensor-cols`, which the
 * table sets (and narrows in tight mode); cells carry their own 12 px side padding.
 */
export const GRID_COLS = "var(--sensor-cols)";

/** Shared cell classes. The first cell starts at the page padding, the last one ends at it. */
export const CELL = "min-w-0 px-3";
export const CELL_LAST = "min-w-0 pl-3 pr-[calc(var(--page-pad-x)-var(--sensor-gutter,0px))]";

export interface SensorStats {
  value: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

/**
 * A known limit for a sensor, in the sensor's own unit before conversion (°C). `shown` is the number
 * in the Limit column; a reading at or above `warnAt` / `critAt` marks the row.
 */
export interface SensorLimit {
  shown: number;
  warnAt: number;
  critAt: number;
  /** Where the limit comes from, for the hover text. */
  title: string;
}

export interface SensorRowProps {
  row: SensorRowModel;
  /** 1-based position in the treegrid (row 1 is the column header). */
  rowIndex: number;
  domId: string;
  top: number;
  /** Zebra: every second row of the list. */
  alt: boolean;
  label: string;
  stats: SensorStats | null;
  history: readonly (number | null)[];
  tempUnit: "C" | "F";
  /** Why a null value is null (not available right now vs. not reported). */
  nullReason: UnavailableReason;
  limit: SensorLimit | null;
  selected: boolean;
  focused: boolean;
  pinned: boolean;
  pinDisabled: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onPointerSelect: (e: MouseEvent, key: string) => void;
  onStartRename: (key: string) => void;
  onToggleHidden: (id: string) => void;
  onTogglePin: (id: string) => void;
  onCopy: (key: string) => void;
}

function ActionButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded-xs text-icon-2 transition-colors duration-[80ms] hover:bg-pressed hover:text-ink disabled:text-ink-disabled disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/**
 * One sensor in the Sensors tree-table (SPEC §8): a fixed 24 px row. The value is semibold with its
 * unit once in tertiary text; Min, Max and Avg are plain numbers; the Limit column is filled only
 * where a limit is known. A reading at or above its limit gets a status icon and the status text
 * colour (never a row tint). Inline rename: Enter saves, Esc cancels, empty restores the default name.
 */
function SensorRowImpl(props: SensorRowProps) {
  const {
    row,
    rowIndex,
    domId,
    top,
    alt,
    label,
    stats,
    history,
    tempUnit,
    nullReason,
    limit,
    selected,
    focused,
    pinned,
    pinDisabled,
    editing,
    draft,
    onDraftChange,
    onCommit,
    onCancel,
    onPointerSelect,
    onStartRename,
    onToggleHidden,
    onTogglePin,
    onCopy,
  } = props;
  const { meta, userHidden } = row;
  const renamed = label !== meta.name;
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [editing]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      settled.current = true;
      onCommit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      settled.current = true;
      onCancel();
    }
  };

  const num = (v: number | null | undefined) => sensorValueParts(v ?? null, meta, tempUnit).num;
  const value = stats?.value ?? null;
  const parts = sensorValueParts(value, meta, tempUnit);
  const state = limit && value != null ? sensorState(value, limit.warnAt, limit.critAt) : "ok";
  const hot = state === "warn" || state === "crit" ? state : null;
  const hotText = hot ? STATUS_CLASS[hot].text : null;
  const limitText = limit ? sensorValueParts(limit.shown, { unit: meta.unit, decimals: 0 }, tempUnit) : null;

  return (
    <div
      id={domId}
      role="row"
      aria-rowindex={rowIndex}
      aria-level={row.level + 1}
      aria-selected={selected}
      onMouseDown={(e) => onPointerSelect(e, row.key)}
      onDoubleClick={() => onStartRename(row.key)}
      className={cn(
        "group absolute inset-x-0 grid select-none items-center text-table text-ink tnum",
        selected ? "bg-selected" : cn(alt && "bg-row-alt", "hover:bg-hover"),
        focused && "group-focus-visible/grid:shadow-[inset_0_0_0_2px_var(--color-control-on)]",
        userHidden && "opacity-55",
      )}
      style={{ top, height: ROW_H, gridTemplateColumns: GRID_COLS }}
    >
      {/* Sensor name */}
      <div
        role="gridcell"
        aria-colindex={1}
        className="flex min-w-0 items-center gap-1.5 pr-3"
        style={{ paddingLeft: `calc(var(--page-pad-x) + ${row.level * INDENT + 18}px)` }}
      >
        {editing ? (
          <TextField
            inputRef={inputRef}
            value={draft}
            onChange={onDraftChange}
            maxLength={64}
            spellCheck={false}
            aria-label={`Rename ${meta.name}. Enter saves, Esc cancels, empty restores the default name.`}
            placeholder={meta.name}
            onKeyDown={onInputKey}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={() => {
              if (!settled.current) {
                settled.current = true;
                onCommit();
              }
            }}
            // The table row is 24 px, so the field is the 22 px variant of SPEC §8.
            className="-ml-[9px] flex-1 [&>span:first-child]:h-[22px]"
          />
        ) : (
          <>
            <span className={cn("min-w-0 truncate", hot && "font-medium")} title={renamed ? `${label} (default name: ${meta.name})` : meta.name}>
              {label}
            </span>
            {renamed && <span className="hidden min-w-0 shrink truncate text-[11.5px] text-ink-3 regular:inline">{meta.name}</span>}
            {pinned && <Pin size={12} className="shrink-0 text-ink-3" aria-label="Pinned to the Dashboard" />}
            {userHidden && <EyeOff size={12} className="shrink-0 text-ink-3" aria-label="Hidden" />}
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[80ms] group-hover:opacity-100",
                (focused || selected) && "opacity-100",
              )}
            >
              <ActionButton label="Rename (F2)" onClick={() => onStartRename(row.key)}>
                <Pencil size={12} />
              </ActionButton>
              <ActionButton label={userHidden ? "Unhide (H)" : "Hide (H)"} onClick={() => onToggleHidden(meta.id)}>
                {userHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </ActionButton>
              <ActionButton
                label={pinned ? "Unpin from the Dashboard (P)" : pinDisabled ? "Up to 12 sensors can be pinned" : "Pin to the Dashboard (P)"}
                onClick={() => onTogglePin(meta.id)}
                disabled={!pinned && pinDisabled}
              >
                {pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </ActionButton>
              <ActionButton label="Copy value (Ctrl+C)" onClick={() => onCopy(row.key)}>
                <Copy size={12} />
              </ActionButton>
            </span>
          </>
        )}
      </div>

      {/* Value: semibold number, the unit once */}
      <span
        role="gridcell"
        aria-colindex={2}
        // Last values received (sensor reading is not up): regular weight in the secondary grey. A colour
        // step, not opacity, so the numbers stay at 4.5:1 or better on every row background.
        className={cn(
          CELL,
          "flex items-center justify-end whitespace-nowrap font-semibold group-data-[stale=true]/grid:font-normal group-data-[stale=true]/grid:text-ink-2",
          hotText,
        )}
        title={hot && limit ? `${hot === "crit" ? "Critical" : "Attention"}: at or above ${hot === "crit" ? "the limit" : "the attention level"}. ${limit.title}` : undefined}
      >
        {value == null ? (
          <Unavailable reason={nullReason} compact className="font-normal" />
        ) : (
          <>
            {hot && (
              <>
                <StatusIcon tone={hot} size={14} className="mr-1.5" />
                <span className="sr-only">{hot === "crit" ? "Critical" : "Attention"}</span>
              </>
            )}
            {parts.num}
            {parts.unit && <span className={cn("ml-[3px] font-normal", !hot && "text-ink-3")}>{parts.unit}</span>}
          </>
        )}
      </span>

      {/* Min / Max / Avg: numbers only */}
      <span role="gridcell" aria-colindex={3} className={cn(CELL, "truncate text-right text-ink-2 group-data-[stale=true]/grid:text-ink-3")}>
        {num(stats?.min)}
      </span>
      <span role="gridcell" aria-colindex={4} className={cn(CELL, "truncate text-right text-ink-2 group-data-[stale=true]/grid:text-ink-3")}>
        {num(stats?.max)}
      </span>
      <span role="gridcell" aria-colindex={5} className={cn(CELL, "truncate text-right text-ink-2 group-data-[stale=true]/grid:text-ink-3")}>
        {num(stats?.avg)}
      </span>

      {/* Limit: blank when no limit is known */}
      <span
        role="gridcell"
        aria-colindex={6}
        aria-label={limitText ? `Limit ${limitText.num} ${limitText.unit}` : "No known limit"}
        title={limit?.title}
        className={cn(CELL, "truncate text-right", hotText ?? "text-ink-3")}
      >
        {limitText?.num ?? ""}
      </span>

      {/* Last 60 s (none for fixed values). A sparkline is always neutral, never a status colour. */}
      <div
        role="gridcell"
        aria-colindex={7}
        aria-label={meta.static ? "No history (fixed value)" : "Last 60 seconds"}
        className={cn(CELL_LAST, "flex h-full items-center")}
      >
        {meta.static ? null : <Sparkline data={history} height={14} strokeWidth={1.25} />}
      </div>
    </div>
  );
}

export const SensorRow = memo(SensorRowImpl);
export default SensorRow;
