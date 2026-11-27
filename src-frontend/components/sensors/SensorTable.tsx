import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { SensorLabelMeta, UnavailableReason } from "../../types";
import { cn, fmtSensorValue } from "../../lib/format";
import { isModalOpen } from "../ui/Modal";
import { toast } from "../feedback/Toast";
import { copyText } from "./copyText";
import { GRID_COLS, SensorRow, type SensorStats } from "./SensorRow";
import { TreeNodeRow } from "./TreeNodeRow";
import { ROW_H, sensorIdsOfRow, type SensorRowModel, type TreeRow } from "./sensorTreeModel";

const OVERSCAN = 8;

export interface FocusRequest {
  key: string;
  nonce: number;
}

export interface SensorTableProps {
  rows: readonly TreeRow[];
  /** Re-render trigger: bumps at most once per animation frame while values stream. */
  paint: number;
  tempUnit: "C" | "F";
  nullReason: UnavailableReason;
  /** Values are frozen (agent offline): dim the numbers. */
  stale: boolean;
  getStats: (id: string) => SensorStats | null;
  getHistory: (idx: number) => readonly (number | null)[];
  labelOf: (id: string, defaultName: string) => string;
  isPinned: (id: string) => boolean;
  pinFull: boolean;
  onToggle: (key: string) => void;
  onToggleHidden: (ids: string[]) => void;
  onTogglePin: (id: string) => void;
  onRename: (id: string, label: string, meta: SensorLabelMeta) => void;
  onSelectionChange: (sensorIds: string[]) => void;
  focusRequest: FocusRequest | null;
}

const domIdOf = (key: string) => `nx-sensor-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function SensorTableImpl(props: SensorTableProps) {
  const {
    rows,
    tempUnit,
    nullReason,
    stale,
    getStats,
    getHistory,
    labelOf,
    isPinned,
    pinFull,
    onToggle,
    onToggleHidden,
    onTogglePin,
    onRename,
    onSelectionChange,
    focusRequest,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(480);
  const scrollRaf = useRef(0);

  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const anchorKey = useRef<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const indexByKey = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);

  /* ------------------------------------------------------------ viewport */

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  const onScroll = useCallback(() => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  const ensureVisible = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0) return;
      const top = index * ROW_H;
      const bottom = top + ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      setScrollTop(el.scrollTop);
    },
    [],
  );

  /* ------------------------------------------------------------ selection */

  const lastFocusIdx = useRef(0);

  // Drop selected keys that no longer exist (hidden, filtered, tree rev change). If the focused
  // row went away, focus the row that took its place so H / P / F2 keep working.
  const live = useRef({ selection, focusKey, editingKey });
  live.current = { selection, focusKey, editingKey };
  useEffect(() => {
    const { selection: prev, focusKey: fk, editingKey: ek } = live.current;
    const kept = [...prev].filter((k) => indexByKey.has(k));
    const changed = kept.length !== prev.size;
    if (ek && !indexByKey.has(ek)) setEditingKey(null);
    if (fk != null && !indexByKey.has(fk) && rows.length > 0) {
      const key = rows[Math.min(lastFocusIdx.current, rows.length - 1)].key;
      setFocusKey(key);
      anchorKey.current = key;
      setSelection(new Set(kept.length > 0 ? kept : [key]));
    } else if (changed) {
      setSelection(new Set(kept));
    }
    // Runs when the row list changes; the live ref carries the current selection and focus.
  }, [indexByKey]); // eslint-disable-line

  useEffect(() => {
    const ids = new Set<string>();
    for (const k of selection) {
      const i = indexByKey.get(k);
      if (i == null) continue;
      for (const id of sensorIdsOfRow(rows[i], rows)) ids.add(id);
    }
    onSelectionChange([...ids]);
  }, [selection, rows, indexByKey, onSelectionChange]);

  const focusIndex = focusKey != null ? (indexByKey.get(focusKey) ?? -1) : -1;
  if (focusIndex >= 0) lastFocusIdx.current = focusIndex;

  const moveFocus = useCallback(
    (index: number, extend: boolean) => {
      if (rows.length === 0) return;
      const i = Math.max(0, Math.min(rows.length - 1, index));
      const key = rows[i].key;
      setFocusKey(key);
      if (extend && anchorKey.current != null && indexByKey.has(anchorKey.current)) {
        const a = indexByKey.get(anchorKey.current)!;
        const [lo, hi] = a < i ? [a, i] : [i, a];
        setSelection(new Set(rows.slice(lo, hi + 1).map((r) => r.key)));
      } else {
        anchorKey.current = key;
        setSelection(new Set([key]));
      }
      ensureVisible(i);
    },
    [rows, indexByKey, ensureVisible],
  );

  const onPointerSelect = useCallback(
    (e: MouseEvent, key: string) => {
      if (e.button !== 0) return;
      const i = indexByKey.get(key);
      if (i == null) return;
      setFocusKey(key);
      if (e.shiftKey && anchorKey.current != null && indexByKey.has(anchorKey.current)) {
        const a = indexByKey.get(anchorKey.current)!;
        const [lo, hi] = a < i ? [a, i] : [i, a];
        setSelection(new Set(rows.slice(lo, hi + 1).map((r) => r.key)));
      } else if (e.ctrlKey || e.metaKey) {
        anchorKey.current = key;
        setSelection((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      } else {
        anchorKey.current = key;
        setSelection(new Set([key]));
      }
    },
    [indexByKey, rows],
  );

  // External focus request (NavRequest.focus = sensor id).
  useEffect(() => {
    if (!focusRequest) return;
    const i = indexByKey.get(focusRequest.key);
    if (i == null) return;
    setFocusKey(focusRequest.key);
    anchorKey.current = focusRequest.key;
    setSelection(new Set([focusRequest.key]));
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 3);
      setScrollTop(el.scrollTop);
      el.focus({ preventScroll: true });
    }
    // Runs only when a new request arrives or its row appears, not on every row-list change.
  }, [focusRequest, indexByKey.has(focusRequest?.key ?? "")]); // eslint-disable-line

  /* ------------------------------------------------------------ rename */

  const sensorRowAt = useCallback(
    (key: string | null): SensorRowModel | null => {
      if (key == null) return null;
      const i = indexByKey.get(key);
      const r = i != null ? rows[i] : null;
      return r && r.kind === "sensor" ? r : null;
    },
    [indexByKey, rows],
  );

  const startRename = useCallback(
    (key: string) => {
      const r = sensorRowAt(key);
      if (!r) return;
      setFocusKey(key);
      anchorKey.current = key;
      setSelection(new Set([key]));
      setDraft(labelOf(r.meta.id, r.meta.name));
      setEditingKey(key);
      const i = indexByKey.get(key);
      if (i != null) ensureVisible(i);
    },
    [sensorRowAt, labelOf, indexByKey, ensureVisible],
  );

  const refocus = () => requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));

  const commitRename = useCallback(() => {
    const r = sensorRowAt(editingKey);
    setEditingKey(null);
    refocus();
    if (!r) return;
    const next = draft.trim().slice(0, 64);
    const current = labelOf(r.meta.id, r.meta.name);
    if (next === current) return;
    // Empty, or the default name typed back, restores the default.
    onRename(r.meta.id, next === r.meta.name ? "" : next, { defaultName: r.meta.name, hardwareName: r.hw.name });
  }, [sensorRowAt, editingKey, draft, labelOf, onRename]);

  const cancelRename = useCallback(() => {
    setEditingKey(null);
    refocus();
  }, []);

  /* ------------------------------------------------------------ copy */

  const valueLine = useCallback(
    (r: SensorRowModel) => {
      const st = getStats(r.meta.id);
      return `${r.hw.name} › ${labelOf(r.meta.id, r.meta.name)}: ${fmtSensorValue(st?.value ?? null, r.meta, tempUnit)}`;
    },
    [getStats, labelOf, tempUnit],
  );

  const copyKeys = useCallback(
    async (keys: string[]) => {
      const lines: string[] = [];
      const seen = new Set<string>();
      for (const k of keys) {
        const i = indexByKey.get(k);
        if (i == null) continue;
        const ids = sensorIdsOfRow(rows[i], rows);
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const r = rows[indexByKey.get(`s:${id}`) ?? -1];
          if (r && r.kind === "sensor") lines.push(valueLine(r));
        }
      }
      if (lines.length === 0) return;
      try {
        await copyText(lines.join("\n"));
        toast(lines.length === 1 ? "Value copied" : `${lines.length} values copied`, "ok");
      } catch {
        toast("Could not copy to the clipboard", "warn");
      }
    },
    [indexByKey, rows, valueLine],
  );

  const onCopyRow = useCallback((key: string) => void copyKeys([key]), [copyKeys]);

  /* ------------------------------------------------------------ keyboard */

  const selectedOrFocused = (): string[] => {
    if (selection.size > 0) return [...selection];
    return focusKey ? [focusKey] : [];
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isTypingTarget(e.target)) return;
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1);
    const cur = focusIndex;
    const row = cur >= 0 ? rows[cur] : null;
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveFocus(cur < 0 ? 0 : cur + 1, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(cur < 0 ? 0 : cur - 1, e.shiftKey);
        return;
      case "PageDown":
        e.preventDefault();
        moveFocus(cur + page, e.shiftKey);
        return;
      case "PageUp":
        e.preventDefault();
        moveFocus(cur - page, e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        moveFocus(0, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        moveFocus(rows.length - 1, e.shiftKey);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (!row) return moveFocus(0, false);
        if (row.expandable && row.expanded) onToggle(row.key);
        else if (row.parentKey) moveFocus(indexByKey.get(row.parentKey) ?? cur, false);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (!row) return moveFocus(0, false);
        if (row.expandable && !row.expanded) onToggle(row.key);
        else if (row.expandable && row.expanded) moveFocus(cur + 1, false);
        return;
      case "Enter":
      case " ":
        if (row?.expandable) {
          e.preventDefault();
          onToggle(row.key);
        }
        return;
      case "F2":
        e.preventDefault();
        e.stopPropagation();
        if (row?.kind === "sensor") startRename(row.key);
        return;
      case "Escape":
        if (selection.size > 0) {
          e.stopPropagation();
          setSelection(new Set());
        }
        return;
    }
    if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      void copyKeys(selectedOrFocused());
      return;
    }
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      setSelection(new Set(rows.filter((r) => r.kind === "sensor").map((r) => r.key)));
      return;
    }
    if (!mod && !e.altKey && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      const ids = new Set<string>();
      for (const k of selectedOrFocused()) {
        const r = sensorRowAt(k);
        if (r) ids.add(r.meta.id);
      }
      if (ids.size > 0) onToggleHidden([...ids]);
      return;
    }
    if (!mod && !e.altKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      const r = sensorRowAt(focusKey);
      if (r && (isPinned(r.meta.id) || !pinFull)) onTogglePin(r.meta.id);
      return;
    }
  };

  // F2 from anywhere in the Sensors view (the global F2 is a no-op here, CONTRACT §4.6).
  useEffect(() => {
    const onWinKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "F2" || e.defaultPrevented) return;
      if (isTypingTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      const r = sensorRowAt(focusKey);
      if (r) startRename(r.key);
      else scrollRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, [sensorRowAt, focusKey, startRename]);

  /* ------------------------------------------------------------ render */

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const hideIds = useCallback((id: string) => onToggleHidden([id]), [onToggleHidden]);
  const toggleRow = useCallback((key: string) => onToggle(key), [onToggle]);

  const items = [];
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const top = i * ROW_H;
    const selected = selection.has(r.key);
    const focused = r.key === focusKey;
    if (r.kind === "sensor") {
      const pinned = isPinned(r.meta.id);
      items.push(
        <SensorRow
          key={r.key}
          row={r}
          domId={domIdOf(r.key)}
          top={top}
          label={labelOf(r.meta.id, r.meta.name)}
          stats={getStats(r.meta.id)}
          history={r.meta.static ? EMPTY : getHistory(r.meta.idx)}
          tempUnit={tempUnit}
          nullReason={nullReason}
          selected={selected}
          focused={focused}
          pinned={pinned}
          pinDisabled={pinFull}
          editing={editingKey === r.key}
          draft={editingKey === r.key ? draft : ""}
          onDraftChange={setDraft}
          onCommit={commitRename}
          onCancel={cancelRename}
          onPointerSelect={onPointerSelect}
          onStartRename={startRename}
          onToggleHidden={hideIds}
          onTogglePin={onTogglePin}
          onCopy={onCopyRow}
        />,
      );
    } else {
      items.push(
        <TreeNodeRow
          key={r.key}
          row={r}
          domId={domIdOf(r.key)}
          top={top}
          selected={selected}
          focused={focused}
          onPointerSelect={onPointerSelect}
          onToggle={toggleRow}
        />,
      );
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Column header (reserves the same scrollbar gutter as the body so columns align) */}
      <div
        className="grid shrink-0 items-end gap-x-3 overflow-hidden border-b border-line pb-1.5 pr-3 scrollbar-gutter-stable"
        style={{ gridTemplateColumns: GRID_COLS }}
        aria-hidden="true"
      >
        {["Sensor", "Value", "Min", "Max", "Avg", "60 s"].map((h, i) => (
          <span
            key={h}
            className={cn(
              "label-caps [--label-color:#64748b] [--label-size:10px]",
              i === 0 ? "pl-3" : i === 5 ? "pl-2 normal-case tracking-[0.08em]" : "text-right",
            )}
          >
            {h}
          </span>
        ))}
      </div>

      <div
        ref={scrollRef}
        role="tree"
        aria-label="Hardware sensors"
        aria-multiselectable="true"
        aria-activedescendant={focusKey && focusIndex >= first && focusIndex < last ? domIdOf(focusKey) : undefined}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (focusKey == null && rows.length > 0) setFocusKey(rows[0].key);
        }}
        className={cn(
          "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none scrollbar-gutter-stable",
          "focus-visible:shadow-[inset_0_0_0_1px_rgba(45,212,191,0.35)] rounded-b-lg",
          stale && "[&_.num]:opacity-55",
        )}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>{items}</div>
      </div>
    </div>
  );
}

const EMPTY: readonly (number | null)[] = [];

export const SensorTable = memo(SensorTableImpl);
export default SensorTable;
