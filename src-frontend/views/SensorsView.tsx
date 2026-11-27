import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import type { SensorLabelMeta, SensorMeta, UnavailableReason } from "../types";
import { errorMessage } from "../lib/api";
import { cn, fmtClock } from "../lib/format";
import { isUnused } from "../lib/sensors";
import { onFocusRequest, takePendingFocus } from "../lib/nav";
import { resolveUnavailable } from "../lib/status";
import { useSensors, useSensorStream } from "../hooks/useSensors";
import { useSensorLabels } from "../hooks/useSensorLabels";
import { useSettings } from "../hooks/useSettings";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import GlassCard from "../components/layout/GlassCard";
import { Button } from "../components/ui/Button";
import { Unavailable } from "../components/ui/Unavailable";
import { isModalOpen } from "../components/ui/Modal";
import { toast } from "../components/feedback/Toast";
import { SensorTable, type FocusRequest } from "../components/sensors/SensorTable";
import { SensorToolbar } from "../components/sensors/SensorToolbar";
import type { SensorStats } from "../components/sensors/SensorRow";
import {
  flattenTree,
  fmtElapsed,
  groupKey,
  hwKey,
  ROOT_KEY,
  sensorKey,
} from "../components/sensors/sensorTreeModel";

const COLLAPSED_STORE = "nexum.sensors.collapsed";
const MAX_PINS = 12;
const TREE_WAIT_MS = 8000;

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORE);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: ReadonlySet<string>) {
  try {
    localStorage.setItem(COLLAPSED_STORE, JSON.stringify([...set].slice(0, 2000)));
  } catch {
    /* per-viewer convenience only */
  }
}

function Kbd({ children }: { children: string }) {
  return <span className="kbd-sm">{children}</span>;
}

/**
 * Sensors (F2): HWMonitor-style tree of every LHM sensor with session Min / Max / Avg and a
 * 60 s sparkline (CONTRACT §1.3, §4.10). Streams values only while mounted.
 */
export default function SensorsView() {
  useSensorStream(true);
  const { tree, values, tick, statsOf, historyOf, reset, refreshTree } = useSensors();
  const labels = useSensorLabels();
  const { settings, update } = useSettings();
  const { info } = useSystemInfo();
  const { agent } = useTelemetry();

  const agentUp = !!agent?.running;
  const nullReason: UnavailableReason = agentUp ? "unsupported" : "agentOffline";

  /* ---------------------------------------------- rAF-batched paint tick */
  const [paint, setPaint] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPaint((p) => (p + 1) % 1_000_000));
    return () => cancelAnimationFrame(id);
  }, [tick]);

  // Stable getters: rows read the latest stats on their next paint.
  const statsRef = useRef(statsOf);
  statsRef.current = statsOf;
  const historyRef = useRef(historyOf);
  historyRef.current = historyOf;
  const getStats = useCallback((id: string): SensorStats | null => statsRef.current(id), []);
  const getHistory = useCallback((idx: number) => historyRef.current(idx), []);

  /* ---------------------------------------------- view state */
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [resetting, setResetting] = useState<"all" | "selected" | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => saveCollapsed(collapsed), [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ---------------------------------------------- rows */
  const hasValues = values != null;
  const unusedRule = useCallback(
    (meta: SensorMeta, max: number | null) => (hasValues ? isUnused(meta, max) : meta.defaultHidden),
    [hasValues],
  );
  const maxOf = useCallback((meta: SensorMeta) => statsRef.current(meta.id)?.max ?? null, []);
  const rootName = info?.hostname?.trim() || "This PC";

  // The unused rule depends on session max values, so re-filter on paint only while it applies.
  const filterPaint = labels.hideUnused ? paint : 0;
  const flat = useMemo(
    () =>
      tree
        ? flattenTree({
            tree,
            rootName,
            collapsed,
            query: deferredQuery,
            hidden: labels.hidden,
            showHidden,
            hideUnused: labels.hideUnused,
            maxOf,
            isUnused: unusedRule,
            labelOf: labels.labelOf,
          })
        : null,
    // eslint-disable-next-line
    [tree, rootName, collapsed, deferredQuery, labels.hidden, showHidden, labels.hideUnused, labels.labelOf, unusedRule, maxOf, filterPaint],
  );

  /* ---------------------------------------------- focus hand-off (NavRequest.focus = sensor id) */
  const pendingFocus = useRef<string | null>(null);
  const tookFocus = useRef(false);
  if (!tookFocus.current) {
    tookFocus.current = true;
    pendingFocus.current = takePendingFocus("sensors");
  }
  useEffect(() => onFocusRequest((req) => {
    if (req.view === "sensors" && req.focus) {
      pendingFocus.current = req.focus;
      setPaint((p) => p + 1);
    }
  }), []);

  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !tree) return;
    const hw = tree.hardware.find((h) => h.sensors.some((s) => s.id === id));
    pendingFocus.current = null;
    if (!hw) return;
    const meta = hw.sensors.find((s) => s.id === id)!;
    // Open every ancestor and clear filters that would hide the row.
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(ROOT_KEY);
      next.delete(groupKey(hw.id, meta.kind));
      let cur: typeof hw | undefined = hw;
      let guard = 0;
      while (cur && guard++ < 16) {
        next.delete(hwKey(cur.id));
        const pid: string | null = cur.parentId;
        cur = pid ? tree.hardware.find((h) => h.id === pid) : undefined;
      }
      return next;
    });
    setQuery("");
    if (labels.hidden.has(id)) setShowHidden(true);
    setFocusRequest({ key: sensorKey(id), nonce: Date.now() });
  }, [tree, paint, labels.hidden]);

  /* ---------------------------------------------- Ctrl+F focuses search */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F") && !isModalOpen()) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------------------------------------------- session clock */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [tree?.sessionStartTs]);

  /* ---------------------------------------------- tree wait / retry */
  const [waitedOut, setWaitedOut] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (tree) return;
    setWaitedOut(false);
    const t = window.setTimeout(() => setWaitedOut(true), TREE_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [tree, agentUp]);

  const retry = async () => {
    setRetrying(true);
    try {
      await refreshTree();
    } catch (e) {
      toast(`Could not read the sensor list: ${errorMessage(e)}`, "warn");
    } finally {
      setRetrying(false);
    }
  };

  /* ---------------------------------------------- actions */
  const doReset = async (ids: string[] | null) => {
    setResetting(ids ? "selected" : "all");
    try {
      await reset(ids);
      toast(ids ? `Reset ${ids.length} sensor${ids.length === 1 ? "" : "s"}` : "Min, Max and Avg reset for every sensor", "ok");
    } catch (e) {
      toast(`Reset failed: ${errorMessage(e)}`, "warn");
    } finally {
      setResetting(null);
    }
  };

  const onToggleHidden = useCallback(
    (ids: string[]) => {
      if (ids.length === 1) {
        labels.toggleHidden(ids[0]);
        return;
      }
      // Several at once: one settings write. All hidden → unhide all; otherwise hide all.
      const current = new Set(settings.hiddenSensors);
      const allHidden = ids.every((id) => current.has(id));
      for (const id of ids) {
        if (allHidden) current.delete(id);
        else current.add(id);
      }
      void update({ hiddenSensors: [...current] });
    },
    [labels, settings.hiddenSensors, update],
  );

  const onTogglePin = useCallback(
    (id: string) => {
      if (!labels.isPinned(id) && labels.pinned.length >= MAX_PINS) {
        toast(`Up to ${MAX_PINS} sensors can be pinned to the Dashboard`, "info");
        return;
      }
      labels.togglePin(id);
    },
    [labels],
  );

  const onRename = useCallback(
    (id: string, label: string, meta: SensorLabelMeta) => labels.setLabel(id, label, meta),
    [labels],
  );

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    if (flat) setCollapsed(new Set(flat.hwKeys));
  }, [flat]);

  /* ---------------------------------------------- render */
  const sessionStart = tree?.sessionStartTs ?? null;
  const limited = agentUp && (agent?.limitedReasons.length ?? 0) > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-gold/80">F2 · Hardware sensors</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">Sensors</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Every sensor the hardware agent reads, with session Min, Max and Avg.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {sessionStart != null ? (
            <div className="flex items-center gap-2 text-[12px] text-slate-400" title="Min, Max and Avg cover this period. Reset all starts a new one.">
              <Activity size={13} className={cn(agentUp ? "text-teal" : "text-slate-600")} aria-hidden="true" />
              <span>
                Min / Max / Avg since{" "}
                <span className="num text-slate-200">{fmtClock(sessionStart, false)}</span>{" "}
                <span className="num text-slate-500">({fmtElapsed(now - sessionStart)})</span>
              </span>
            </div>
          ) : null}
          {!agentUp && tree && (
            <div className="flex items-center gap-2 text-[11.5px]">
              <Unavailable reason="agentOffline" />
              <span className="text-slate-500">Showing the last values received.</span>
            </div>
          )}
          {limited && agent && (
            <div className="flex items-center gap-2 text-[11.5px] text-slate-500">
              <span>Partial sensor list:</span>
              <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
            </div>
          )}
        </div>
      </div>

      <GlassCard className="min-h-[420px] flex-1" bodyClassName="flex min-h-0 flex-col">
        <SensorToolbar
          ref={searchRef}
          query={query}
          onQuery={setQuery}
          hideUnused={labels.hideUnused}
          onHideUnused={labels.setHideUnused}
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          hiddenCount={labels.hidden.size}
          selectedCount={selectedIds.length}
          resetting={resetting}
          onResetAll={() => void doReset(null)}
          onResetSelected={() => void doReset(selectedIds)}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
          disabled={!tree}
        />

        {tree && flat ? (
          <>
            <SensorTable
              rows={flat.rows}
              paint={paint}
              tempUnit={settings.tempUnit}
              nullReason={nullReason}
              stale={!agentUp}
              getStats={getStats}
              getHistory={getHistory}
              labelOf={labels.labelOf}
              isPinned={labels.isPinned}
              pinFull={labels.pinned.length >= MAX_PINS}
              onToggle={toggle}
              onToggleHidden={onToggleHidden}
              onTogglePin={onTogglePin}
              onRename={onRename}
              onSelectionChange={setSelectedIds}
              focusRequest={focusRequest}
            />
            {flat.noMatches && (
              <p className="py-6 text-center text-[12.5px] text-muted">
                No sensor matches “{deferredQuery.trim()}”.
              </p>
            )}
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[11px] text-slate-500">
              <span className="num">
                {flat.shown} of {flat.total} sensors
              </span>
              {flat.hiddenUnused > 0 && (
                <button
                  type="button"
                  className="hover:text-slate-300"
                  onClick={() => labels.setHideUnused(false)}
                  title="Show sensors hidden by the Hide unused rule"
                >
                  {flat.hiddenUnused} unused hidden
                </button>
              )}
              {flat.hiddenByUser > 0 && !showHidden && (
                <button type="button" className="hover:text-slate-300" onClick={() => setShowHidden(true)}>
                  {flat.hiddenByUser} hidden by you
                </button>
              )}
              <span className="ml-auto hidden items-center gap-1.5 xl:flex">
                <Kbd>↑↓</Kbd> move <Kbd>←→</Kbd> collapse / expand <Kbd>F2</Kbd> rename <Kbd>H</Kbd> hide <Kbd>P</Kbd> pin
                <Kbd>Ctrl+C</Kbd> copy
              </span>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            {!agentUp ? (
              <>
                <Unavailable reason={agent ? resolveUnavailable(agent, "none") : "agentOffline"} className="text-[13px]" />
                <p className="max-w-[420px] text-[12.5px] text-muted">
                  The sensor list appears when the hardware agent is running. Use Restart agent in Settings if it stays offline.
                </p>
              </>
            ) : waitedOut ? (
              <>
                <p className="text-[13px] text-slate-300">The hardware agent has not sent a sensor list yet.</p>
                <Button size="sm" variant="ghost" icon={RefreshCw} loading={retrying} onClick={() => void retry()}>
                  Try again
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Loader2 size={14} className="animate-spin text-teal" aria-hidden="true" />
                Reading the sensor list…
              </div>
            )}
          </div>
        )}
      </GlassCard>
    </div>
  );
}
