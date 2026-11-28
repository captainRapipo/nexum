import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Activity, RefreshCw, SearchX } from "lucide-react";
import type { CpuLimitInfo, DiskTelemetry, SensorLabelMeta, SensorMeta, SensorTree, Settings, UnavailableReason } from "../types";
import { errorMessage } from "../lib/api";
import { fmtClock } from "../lib/format";
import { CPU_TEMP_RULE, findSensor, isUnused } from "../lib/sensors";
import { onFocusRequest, takePendingFocus } from "../lib/nav";
import { resolveUnavailable } from "../lib/status";
import { useSensors, useSensorStream } from "../hooks/useSensors";
import { useSensorLabels } from "../hooks/useSensorLabels";
import { useSettings } from "../hooks/useSettings";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useHealthAlerts } from "../hooks/useHealthAlerts";
import { usePageChrome } from "../components/layout/PageChrome";
import { Button, EmptyState, InkLink, UNAVAILABLE_TEXT } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import { SensorTable, type FocusRequest } from "../components/sensors/SensorTable";
import { SensorToolbar, type SensorFilter } from "../components/sensors/SensorToolbar";
import { SensorLogControls, SensorLogStatusLine } from "../components/sensors/SensorLogControls";
import type { SensorLimit, SensorStats } from "../components/sensors/SensorRow";
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

function Hint({ keys, children }: { keys: string; children: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="kbd-sm">{keys}</kbd>
      {children}
    </span>
  );
}

const EMPTY_DISKS: DiskTelemetry[] = [];
const GPU_HW: ReadonlySet<string> = new Set(["gpuAmd", "gpuNvidia", "gpuIntel"]);

/**
 * The Limit column (CONTRACT §4.10.3): the CPU limit on the CPU package temperature row, the GPU
 * hot-spot and memory-junction critical limits on those rows, and a drive's own warning temperature
 * on its temperature rows. Everything else has no limit. Uses only data the app already holds.
 */
function buildLimits(
  tree: SensorTree | null,
  cpuLimit: CpuLimitInfo,
  alerts: Settings["alerts"] | undefined,
  disks: readonly DiskTelemetry[],
): ReadonlyMap<string, SensorLimit> {
  const out = new Map<string, SensorLimit>();
  if (!tree) return out;

  const cpu = findSensor(tree, CPU_TEMP_RULE);
  if (cpu) {
    const src = cpuLimit.source === "table" ? "AMD specification" : cpuLimit.source === "user" ? "your setting" : "default";
    out.set(cpu.id, {
      shown: cpuLimit.limitC,
      warnAt: cpuLimit.warnC,
      critAt: cpuLimit.limitC,
      title: `Limit for this CPU (${src}). Attention from 5 degrees below it.`,
    });
  }

  const hotspot = alerts?.gpuHotspotC ?? 110;
  const junction = alerts?.gpuMemJunctionC ?? 105;
  for (const hw of tree.hardware) {
    if (GPU_HW.has(hw.kind)) {
      for (const m of hw.sensors) {
        if (m.kind !== "temperature") continue;
        if (m.name === "GPU Hot Spot") {
          out.set(m.id, { shown: hotspot, warnAt: hotspot - 10, critAt: hotspot, title: "GPU hot-spot limit (Settings › Alerts). Attention from 10 degrees below it." });
        } else if (m.name === "GPU Memory Junction" || m.name === "GPU Memory") {
          out.set(m.id, { shown: junction, warnAt: junction - 10, critAt: junction, title: "GPU memory limit (Settings › Alerts). Attention from 10 degrees below it." });
        }
      }
    } else if (hw.kind === "storage") {
      const disk = disks.find((d) => d.id === hw.id);
      const warn = disk?.warningTempC;
      if (typeof warn !== "number" || !Number.isFinite(warn)) continue;
      const crit = typeof disk?.criticalTempC === "number" && Number.isFinite(disk.criticalTempC) ? disk.criticalTempC : Infinity;
      for (const m of hw.sensors) {
        if (m.kind !== "temperature" || m.static) continue;
        // The drive's own thresholds are listed as sensors too; they are limits, not readings.
        if (/warning|critical|threshold|limit/i.test(m.name)) continue;
        out.set(m.id, { shown: warn, warnAt: warn, critAt: crit, title: "The warning temperature this drive reports for itself." });
      }
    }
  }
  return out;
}

/**
 * Sensors (F2), a list page (CONTRACT §4.10.3, SPEC §8): full-bleed white, no card. A 44 px filter
 * bar, the tree-table of every sensor this PC reports (session Min / Max / Avg, a known limit, a
 * 60 s sparkline) and a 30 px status bar. The text filter is published to the app toolbar.
 * Streams values only while mounted.
 */
export default function SensorsView() {
  useSensorStream(true);
  const { tree, values, tick, statsOf, historyOf, reset, refreshTree } = useSensors();
  const labels = useSensorLabels();
  const { settings, update } = useSettings();
  const { info } = useSystemInfo();
  const { agent, latest } = useTelemetry();
  const { snapshot } = useHealthAlerts();

  const agentUp = !!agent?.running;
  // A value that is missing because nothing has arrived yet (start-up, a restart) is a plain dash;
  // once values are streaming, a null is a sensor this hardware does not report.
  const nullReason: UnavailableReason = agentUp && values != null ? "unsupported" : "agentOffline";

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
  const [filter, setFilter] = useState<SensorFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [resetting, setResetting] = useState<"all" | "selected" | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

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

  // "Pinned" and "Changed" (a value that moved since the last reset: session max above session min).
  const isPinned = labels.isPinned;
  const only = useMemo<((meta: SensorMeta) => boolean) | undefined>(() => {
    if (filter === "pinned") return (meta) => isPinned(meta.id);
    if (filter === "changed")
      return (meta) => {
        if (meta.static) return false;
        const st = statsRef.current(meta.id);
        return st != null && st.min != null && st.max != null && st.max > st.min;
      };
    return undefined;
  }, [filter, isPinned]);

  // The unused rule and "Changed" depend on session values, so re-filter on paint only while they apply.
  const filterPaint = labels.hideUnused || filter === "changed" ? paint : 0;
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
            only,
          })
        : null,
    // eslint-disable-next-line
    [tree, rootName, collapsed, deferredQuery, labels.hidden, showHidden, labels.hideUnused, labels.labelOf, unusedRule, maxOf, only, filterPaint],
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
    setFilter("all");
    if (labels.hidden.has(id)) setShowHidden(true);
    setFocusRequest({ key: sensorKey(id), nonce: Date.now() });
  }, [tree, paint, labels.hidden]);

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

  /* ---------------------------------------------- limits, page chrome */
  // Telemetry brings a new disks array every second; the limits only change when a threshold does.
  const disks = latest?.disks ?? EMPTY_DISKS;
  const diskLimitsKey = disks.map((d) => `${d.id}:${d.warningTempC ?? ""}:${d.criticalTempC ?? ""}`).join("|");
  const disksRef = useRef(disks);
  disksRef.current = disks;
  const limits = useMemo(
    () => buildLimits(tree, snapshot.cpuLimit, settings.alerts, disksRef.current),
    // eslint-disable-next-line
    [tree, snapshot.cpuLimit, settings.alerts, diskLimitsKey],
  );

  usePageChrome({
    subtitle: flat ? `${flat.total} sensor${flat.total === 1 ? "" : "s"} from ${flat.devices} device${flat.devices === 1 ? "" : "s"}` : null,
    search: { value: query, onChange: setQuery, placeholder: "Filter sensors", ariaLabel: "Filter sensors by name or device" },
  });

  /* ---------------------------------------------- render */
  const sessionStart = tree?.sessionStartTs ?? null;
  const limited = agentUp && (agent?.limitedReasons.length ?? 0) > 0;
  const limitedReason: UnavailableReason | null = limited && agent ? resolveUnavailable(agent, "pawnio") : null;
  const searching = deferredQuery.trim().length > 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-content">
      <SensorToolbar
        filter={filter}
        onFilter={setFilter}
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
      >
        <SensorLogControls selectedIds={selectedIds} disabled={!tree || !agentUp} />
      </SensorToolbar>

      {tree && flat ? (
        <>
          {flat.shown === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
              {searching ? (
                <EmptyState
                  icon={SearchX}
                  title={`No sensor matches “${deferredQuery.trim()}”`}
                  body="The filter looks at sensor names, your own names and device names."
                />
              ) : filter === "pinned" ? (
                <EmptyState
                  icon={Activity}
                  title="No pinned sensors"
                  body="Pin a sensor with P, or with the pin button on its row. Pinned sensors also appear on the Dashboard."
                />
              ) : filter === "changed" ? (
                <EmptyState
                  icon={Activity}
                  title="Nothing has changed yet"
                  body="Sensors appear here once their value moves after Min, Max and Avg were last reset."
                />
              ) : (
                <EmptyState icon={Activity} title="No sensors to show" body="Every sensor is hidden by Hide unused or was hidden by you." />
              )}
            </div>
          ) : (
            <SensorTable
              rows={flat.rows}
              paint={paint}
              tempUnit={settings.tempUnit}
              nullReason={nullReason}
              stale={!agentUp}
              limits={limits}
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
          )}

          {/* Status bar (SPEC §3): counts and the session on the left, key hints on the right. */}
          <footer className="flex h-[30px] shrink-0 items-center gap-4 whitespace-nowrap border-t border-hairline bg-toolbar px-(--page-pad-x) text-callout text-ink-2">
            <span className="flex min-w-0 items-center gap-1.5 tnum">
              <span>
                {flat.shown} of {flat.total} sensors
              </span>
              {flat.hiddenUnused > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <InkLink chevron={false} className="font-normal text-ink-2" onClick={() => labels.setHideUnused(false)} title="Show sensors hidden by Hide unused">
                    {flat.hiddenUnused} unused hidden
                  </InkLink>
                </>
              )}
              {flat.hiddenByUser > 0 && !showHidden && (
                <>
                  <span aria-hidden="true">·</span>
                  <InkLink chevron={false} className="font-normal text-ink-2" onClick={() => setShowHidden(true)} title="Show the sensors you hid">
                    {flat.hiddenByUser} hidden by you
                  </InkLink>
                </>
              )}
              {sessionStart != null && (
                <span className="truncate" title="Min, Max and Avg cover this period. Reset all starts a new one.">
                  · Min, Max and Avg since {fmtClock(sessionStart, false)} ({fmtElapsed(now - sessionStart)})
                </span>
              )}
              {!agentUp && <span className="truncate text-ink-3">· Showing the last values received</span>}
              {limitedReason && (
                <span className="truncate text-ink-3" title="Some sensors cannot be read in this mode.">
                  · Partial list: {UNAVAILABLE_TEXT[limitedReason]}
                </span>
              )}
            </span>
            <SensorLogStatusLine />
            <span className="ml-auto flex shrink-0 items-center gap-3.5">
              <Hint keys="F2">Rename</Hint>
              <Hint keys="P">Pin</Hint>
              <Hint keys="H">Hide</Hint>
              <Hint keys="Ctrl C">Copy value</Hint>
            </span>
          </footer>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
          {!agentUp ? (
            <EmptyState icon={Activity} title={UNAVAILABLE_TEXT.agentOffline} body="The sensor list appears as soon as Nexum can read the sensors." />
          ) : (
            <EmptyState
              icon={Activity}
              title="Reading the sensor list…"
              action={
                waitedOut ? (
                  <Button size="lg" icon={RefreshCw} loading={retrying} onClick={() => void retry()}>
                    Try again
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
