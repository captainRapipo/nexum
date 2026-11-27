import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import { indexTree, rematchLabels } from "../lib/sensors";
import type { HardwareNode, SensorMeta, SensorTree, SensorValues } from "../types";
import { useSettings } from "./useSettings";

/** Sparkline window. */
export const SENSOR_HISTORY_MS = 60_000;
const MAX_SAMPLES = 240;

export interface SensorStats {
  value: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

export interface SensorsValue {
  tree: SensorTree | null;
  values: SensorValues | null;
  /** Increments once per accepted `sensor-values` packet. */
  tick: number;
  byId: ReadonlyMap<string, { meta: SensorMeta; hw: HardwareNode }>;
  statsOf: (id: string) => SensorStats | null;
  /** Last 60 s of values for `idx`, oldest first (null = no reading). */
  historyOf: (idx: number) => readonly (number | null)[];
  reset: (ids: string[] | null) => Promise<void>;
  refreshTree: () => Promise<void>;
}

const SensorsContext = createContext<SensorsValue | null>(null);

/** Stable actions only: consumers of this context do not re-render on every values packet. */
interface SensorsActions {
  reset: (ids: string[] | null) => Promise<void>;
  refreshTree: () => Promise<void>;
}
const SensorsActionsContext = createContext<SensorsActions | null>(null);

interface Sample {
  ts: number;
  value: ReadonlyArray<number | null>;
}

function sensorCount(tree: SensorTree): number {
  let n = 0;
  for (const hw of tree.hardware) n += hw.sensors.length;
  return n;
}

/** idx ⇄ id mapping signature; history is only valid while it is unchanged. */
function treeSignature(tree: SensorTree): string {
  const parts: string[] = [String(tree.rev)];
  for (const hw of tree.hardware) for (const s of hw.sensors) parts.push(`${s.idx}=${s.id}`);
  return parts.join("|");
}

function isTree(t: unknown): t is SensorTree {
  return !!t && typeof t === "object" && Array.isArray((t as SensorTree).hardware) && typeof (t as SensorTree).rev === "number";
}

/**
 * Holds the LHM sensor tree and the value stream (CONTRACT §1.3, §4.4).
 * Rev rule: the tree is replaced on every `sensor-tree` event; `sensor-values` whose `rev`
 * differs from the held tree are dropped and the tree is re-requested.
 */
export function SensorsProvider({ children }: { children: ReactNode }) {
  const [tree, setTree] = useState<SensorTree | null>(null);
  const [values, setValues] = useState<SensorValues | null>(null);
  const [tick, setTick] = useState(0);

  const treeRef = useRef<SensorTree | null>(null);
  const sigRef = useRef<string>("");
  const countRef = useRef(0);
  const samples = useRef<Sample[]>([]);
  const lastTreeRequest = useRef(0);
  const treeInflight = useRef<Promise<void> | null>(null);

  const acceptTree = useCallback((t: SensorTree) => {
    const sig = treeSignature(t);
    if (sig !== sigRef.current) {
      samples.current = [];
      setValues(null);
    }
    sigRef.current = sig;
    countRef.current = sensorCount(t);
    treeRef.current = t;
    setTree(t);
  }, []);

  const refreshTree = useCallback((): Promise<void> => {
    if (treeInflight.current) return treeInflight.current;
    lastTreeRequest.current = Date.now();
    const run = api
      .getSensorTree()
      .then((t) => {
        if (isTree(t)) acceptTree(t);
      })
      .catch((err) => console.warn("[nexum] get_sensor_tree failed:", errorMessage(err)))
      .finally(() => {
        treeInflight.current = null;
      });
    treeInflight.current = run;
    return run;
  }, [acceptTree]);

  useEffect(() => {
    const offTree = subscribe<unknown>("sensor-tree", (t) => {
      if (isTree(t)) acceptTree(t);
    });
    const offValues = subscribe<SensorValues>("sensor-values", (v) => {
      if (!v || typeof v !== "object" || !Array.isArray(v.value)) return;
      const t = treeRef.current;
      if (!t || v.rev !== t.rev || v.value.length !== countRef.current) {
        // Stale or unknown mapping: drop and re-fetch the tree (throttled).
        if (Date.now() - lastTreeRequest.current > 2000) void refreshTree();
        return;
      }
      const buf = samples.current;
      const last = buf[buf.length - 1];
      if (!last || v.ts > last.ts) {
        const from = v.ts - SENSOR_HISTORY_MS;
        let start = 0;
        while (start < buf.length && buf[start].ts < from) start++;
        const next = start > 0 ? buf.slice(start) : buf.slice();
        next.push({ ts: v.ts, value: v.value });
        samples.current = next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
      }
      setValues(v);
      setTick((n) => n + 1);
    });
    void refreshTree();
    return () => {
      offTree();
      offValues();
    };
  }, [acceptTree, refreshTree]);

  // Label re-match (CONTRACT §4.5) whenever a new tree arrives.
  const { settings, update, loaded } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!tree || !loaded) return;
    const patch = rematchLabels(tree, settingsRef.current);
    if (patch) update(patch).catch(() => undefined);
  }, [tree, loaded, update]);

  const byId = useMemo(() => indexTree(tree), [tree]);

  const statsOf = useCallback(
    (id: string): SensorStats | null => {
      const entry = byId.get(id);
      if (!entry) return null;
      const i = entry.meta.idx;
      if (!values) return { value: null, min: null, max: null, avg: null };
      return {
        value: values.value[i] ?? null,
        min: values.min?.[i] ?? null,
        max: values.max?.[i] ?? null,
        avg: values.avg?.[i] ?? null,
      };
    },
    [byId, values],
  );

  const historyOf = useCallback(
    (idx: number): readonly (number | null)[] => samples.current.map((s) => s.value[idx] ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- new identity per accepted packet
    [tick, tree],
  );

  const reset = useCallback(async (ids: string[] | null) => {
    await api.resetSensorStats(ids);
  }, []);

  const value = useMemo<SensorsValue>(
    () => ({ tree, values, tick, byId, statsOf, historyOf, reset, refreshTree }),
    [tree, values, tick, byId, statsOf, historyOf, reset, refreshTree],
  );

  const actions = useMemo<SensorsActions>(() => ({ reset, refreshTree }), [reset, refreshTree]);

  return createElement(
    SensorsActionsContext.Provider,
    { value: actions },
    createElement(SensorsContext.Provider, { value }, children),
  );
}

export function useSensors(): SensorsValue {
  const ctx = useContext(SensorsContext);
  if (!ctx) throw new Error("useSensors() must be used inside <SensorsProvider>");
  return ctx;
}

/**
 * `refreshTree` / `reset` without subscribing to the value stream. App's shell uses it for F5 so the
 * whole shell does not re-render on every `sensor-values` packet.
 */
export function useSensorsActions(): SensorsActions {
  const ctx = useContext(SensorsActionsContext);
  if (!ctx) throw new Error("useSensorsActions() must be used inside <SensorsProvider>");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Ref-counted value stream                                            */
/* ------------------------------------------------------------------ */

let streamRefs = 0;
let streamSent: boolean | null = null;
let streamTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleStreamSync() {
  if (streamTimer) clearTimeout(streamTimer);
  // Short debounce so switching between two views that both stream never toggles it off/on.
  streamTimer = setTimeout(() => {
    streamTimer = null;
    const want = streamRefs > 0;
    if (want === streamSent) return;
    streamSent = want;
    api.setSensorStream(want).catch((err) => {
      streamSent = null; // retry on the next change
      console.warn("[nexum] set_sensor_stream failed:", errorMessage(err));
    });
  }, 200);
}

/**
 * `sensor-values` flow while at least one mounted caller passes `true`
 * (Sensors view, Dashboard pinned sensors, Cooling).
 */
export function useSensorStream(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    streamRefs++;
    scheduleStreamSync();
    return () => {
      streamRefs = Math.max(0, streamRefs - 1);
      scheduleStreamSync();
    };
  }, [active]);
}

export default useSensors;
