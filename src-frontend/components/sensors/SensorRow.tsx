import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Copy, Eye, EyeOff, Pencil, Pin, PinOff } from "lucide-react";
import type { UnavailableReason } from "../../types";
import { cn, fmtSensorValue } from "../../lib/format";
import { Sparkline } from "../ui/Sparkline";
import { Unavailable } from "../ui/Unavailable";
import { INDENT, ROW_H, sparkColor, type SensorRowModel } from "./sensorTreeModel";

/** Column template shared by the header and every row: Sensor | Value | Min | Max | Avg | 60 s. */
export const GRID_COLS = "minmax(220px,1fr) repeat(4, minmax(84px, 100px)) minmax(110px, 0.45fr)";

export interface SensorStats {
  value: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface SensorRowProps {
  row: SensorRowModel;
  domId: string;
  top: number;
  label: string;
  stats: SensorStats | null;
  history: readonly (number | null)[];
  tempUnit: "C" | "F";
  /** Why a null value is null (agent offline vs. not reported). */
  nullReason: UnavailableReason;
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
  active,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
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
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-slate-400 transition-colors",
        "hover:bg-white/[0.08] hover:text-ink disabled:opacity-35",
        active && "text-teal",
      )}
    >
      {children}
    </button>
  );
}

/**
 * One sensor in the Sensors view (ROADMAP §6.2): fixed height, inline rename input
 * (Enter saves, Esc cancels, empty restores the default name), row actions with labels.
 */
function SensorRowImpl(props: SensorRowProps) {
  const {
    row,
    domId,
    top,
    label,
    stats,
    history,
    tempUnit,
    nullReason,
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

  const fmt = (v: number | null | undefined) => fmtSensorValue(v ?? null, meta, tempUnit);
  const value = stats?.value ?? null;

  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.level + 1}
      aria-selected={selected}
      onMouseDown={(e) => onPointerSelect(e, row.key)}
      onDoubleClick={() => onStartRename(row.key)}
      className={cn(
        "group absolute inset-x-0 grid select-none items-center gap-x-3 pr-3 text-[12.5px]",
        "border-b border-white/[0.025] transition-colors duration-100",
        selected ? "bg-teal/[0.08]" : "hover:bg-white/[0.025]",
        focused && "shadow-[inset_2px_0_0_0_var(--color-teal)]",
        userHidden && "opacity-55",
      )}
      style={{ top, height: ROW_H, gridTemplateColumns: GRID_COLS }}
    >
      {/* Sensor name */}
      <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: 12 + row.level * INDENT }}>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            maxLength={64}
            spellCheck={false}
            aria-label={`Rename ${meta.name}. Enter saves, Esc cancels, empty restores the default name.`}
            placeholder={meta.name}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onInputKey}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={() => {
              if (!settled.current) {
                settled.current = true;
                onCommit();
              }
            }}
            className="h-[22px] min-w-0 flex-1 rounded-[5px] border border-teal/50 bg-black/40 px-1.5 text-[12.5px] text-ink outline-none shadow-[0_0_0_3px_rgba(45,212,191,0.12)] placeholder:text-slate-600"
          />
        ) : (
          <>
            <span
              className={cn("min-w-0 truncate", renamed ? "text-ink" : "text-slate-200")}
              title={renamed ? `${label} (default name: ${meta.name})` : meta.name}
            >
              {label}
            </span>
            {renamed && <span className="hidden min-w-0 shrink truncate text-[11px] text-slate-500 lg:inline">{meta.name}</span>}
            {pinned && (
              <Pin size={11} className="shrink-0 text-teal/80" aria-label="Pinned to Dashboard" strokeWidth={2.2} />
            )}
            {userHidden && <EyeOff size={11} className="shrink-0 text-slate-500" aria-label="Hidden" />}
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100",
                "group-hover:opacity-100",
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
                label={pinned ? "Unpin from Dashboard (P)" : pinDisabled ? "Up to 12 sensors can be pinned" : "Pin to Dashboard (P)"}
                onClick={() => onTogglePin(meta.id)}
                disabled={!pinned && pinDisabled}
                active={pinned}
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

      {/* Value / Min / Max / Avg */}
      <span className="num whitespace-nowrap text-right tabular-nums text-ink">
        {value == null ? <Unavailable reason={nullReason} compact /> : fmt(value)}
      </span>
      <span className="num whitespace-nowrap text-right tabular-nums text-slate-400">{fmt(stats?.min)}</span>
      <span className="num whitespace-nowrap text-right tabular-nums text-slate-300">{fmt(stats?.max)}</span>
      <span className="num whitespace-nowrap text-right tabular-nums text-slate-400">{fmt(stats?.avg)}</span>

      {/* 60 s sparkline (none for static sensors) */}
      <div className="flex h-full items-center pl-2 opacity-85" aria-hidden="true">
        {meta.static ? null : <Sparkline data={history} color={sparkColor(meta.kind)} height={16} fill={false} strokeWidth={1.3} />}
      </div>
    </div>
  );
}

export const SensorRow = memo(SensorRowImpl);
export default SensorRow;
