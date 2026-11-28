// Pure model for the Sensors view (CONTRACT §1.3, §4.10, §4.10.3): flattens a SensorTree into the
// visible row list (hostname root → hardware nodes → kind groups → sensors) after applying
// collapse state, the filter, user-hidden ids and the "unused" rule. No React in here.

import {
  Activity,
  Battery,
  Clock3,
  CircuitBoard,
  Cpu,
  Database,
  Droplets,
  Fan,
  Gauge,
  HardDrive,
  Hourglass,
  Layers,
  MemoryStick,
  Microchip,
  Monitor,
  Network,
  Percent,
  Plug,
  Sigma,
  Thermometer,
  Timer,
  Volume2,
  Waves,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { SENSOR_KIND_ORDER, type HardwareKind, type HardwareNode, type SensorKind, type SensorMeta, type SensorTree } from "../../types";

/** Fixed row height of the virtualized list (px): the dense 24 px row of SPEC §7 (`--row-h-dense`). */
export const ROW_H = 24;
/** Indentation per tree level (px). */
export const INDENT = 16;

export const ROOT_KEY = "root";
export const hwKey = (hwId: string) => `hw:${hwId}`;
export const groupKey = (hwId: string, kind: SensorKind) => `grp:${hwId}:${kind}`;
export const sensorKey = (id: string) => `s:${id}`;

export const KIND_LABEL: Record<SensorKind, string> = {
  voltage: "Voltages",
  current: "Currents",
  power: "Powers",
  clock: "Clocks",
  frequency: "Frequencies",
  temperature: "Temperatures",
  load: "Utilization",
  fan: "Fans",
  control: "Fan control",
  flow: "Flow rates",
  level: "Levels",
  factor: "Factors",
  data: "Data",
  smallData: "Data (MB)",
  throughput: "Throughput",
  timeSpan: "Time",
  timing: "Timings",
  energy: "Energy",
  noise: "Noise",
  conductivity: "Conductivity",
  humidity: "Humidity",
};

export const KIND_ICON: Record<SensorKind, LucideIcon> = {
  voltage: Zap,
  current: Waves,
  power: Plug,
  clock: Gauge,
  frequency: Activity,
  temperature: Thermometer,
  load: Percent,
  fan: Fan,
  control: Wind,
  flow: Droplets,
  level: Layers,
  factor: Sigma,
  data: Database,
  smallData: Database,
  throughput: Activity,
  timeSpan: Hourglass,
  timing: Timer,
  energy: Battery,
  noise: Volume2,
  conductivity: Waves,
  humidity: Droplets,
};

export const HW_ICON: Record<HardwareKind, LucideIcon> = {
  motherboard: CircuitBoard,
  superio: Microchip,
  cpu: Cpu,
  memory: MemoryStick,
  gpuNvidia: Monitor,
  gpuAmd: Monitor,
  gpuIntel: Monitor,
  storage: HardDrive,
  network: Network,
  cooler: Fan,
  embeddedController: Microchip,
  psu: Plug,
  battery: Battery,
  powerMonitor: Zap,
  other: Clock3,
};

export const ROOT_ICON: LucideIcon = Monitor;

export type RowKind = "root" | "hw" | "group" | "sensor";

interface RowBase {
  key: string;
  kind: RowKind;
  level: number;
  /** Key of the row that collapses this one (null for root). */
  parentKey: string | null;
}

export interface RootRow extends RowBase {
  kind: "root";
  name: string;
  expandable: true;
  expanded: boolean;
  sensorCount: number;
}

export interface HwRow extends RowBase {
  kind: "hw";
  hw: HardwareNode;
  expandable: boolean;
  expanded: boolean;
  /** Visible sensors in this node (not its children). */
  sensorCount: number;
}

export interface GroupRow extends RowBase {
  kind: "group";
  hw: HardwareNode;
  sensorKind: SensorKind;
  expandable: true;
  expanded: boolean;
  sensorIds: string[];
  /** Distinct units of the listed sensors, as reported ("°C", "RPM"); shown once on the group row. */
  units: string[];
}

export interface SensorRowModel extends RowBase {
  kind: "sensor";
  hw: HardwareNode;
  meta: SensorMeta;
  /** True when the user hid this sensor (only listed while "Show hidden" is on). */
  userHidden: boolean;
  expandable: false;
  expanded: false;
}

export type TreeRow = RootRow | HwRow | GroupRow | SensorRowModel;

export interface FlattenInput {
  tree: SensorTree;
  rootName: string;
  collapsed: ReadonlySet<string>;
  query: string;
  hidden: ReadonlySet<string>;
  showHidden: boolean;
  hideUnused: boolean;
  /** Session max of a sensor (for the "unused" rule). */
  maxOf: (meta: SensorMeta) => number | null;
  isUnused: (meta: SensorMeta, max: number | null) => boolean;
  labelOf: (id: string, defaultName: string) => string;
  /** Extra filter of the filter bar ("Pinned", "Changed"); omitted = every sensor. */
  only?: (meta: SensorMeta) => boolean;
}

export interface FlattenResult {
  rows: TreeRow[];
  /** Every sensor id in tree order (unfiltered). */
  total: number;
  /** Sensors that passed every filter. */
  shown: number;
  hiddenByUser: number;
  hiddenUnused: number;
  /** Search active but nothing matched. */
  noMatches: boolean;
  /** Hardware nodes that have at least one sensor (for "<n> sensors from <m> devices"). */
  devices: number;
  /** All hardware keys (for "Collapse all"). */
  hwKeys: string[];
}

const KIND_RANK: Record<string, number> = Object.fromEntries(SENSOR_KIND_ORDER.map((k, i) => [k, i]));

/** Depth of each hardware node (0 = root hardware). A missing or cyclic parent counts as a root. */
function hardwareDepths(hardware: readonly HardwareNode[]): Map<string, number> {
  const byId = new Map(hardware.map((h) => [h.id, h]));
  const depth = new Map<string, number>();
  const resolve = (h: HardwareNode, guard: number): number => {
    const known = depth.get(h.id);
    if (known != null) return known;
    const parent = h.parentId ? byId.get(h.parentId) : undefined;
    const d = parent && guard < 16 && parent.id !== h.id ? resolve(parent, guard + 1) + 1 : 0;
    depth.set(h.id, d);
    return d;
  };
  for (const h of hardware) resolve(h, 0);
  return depth;
}

function matches(q: string, ...fields: string[]): boolean {
  for (const f of fields) if (f.toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Builds the visible row list. While a search is active, collapse state is ignored so every
 * match is visible.
 */
export function flattenTree(input: FlattenInput): FlattenResult {
  const { tree, rootName, collapsed, hidden, showHidden, hideUnused, maxOf, isUnused, labelOf, only } = input;
  const q = input.query.trim().toLowerCase();
  const searching = q.length > 0;
  const hardware = tree.hardware;
  const depth = hardwareDepths(hardware);
  const byId = new Map(hardware.map((h) => [h.id, h]));

  let total = 0;
  let hiddenByUser = 0;
  let hiddenUnused = 0;

  // 1. Per node: visible sensors grouped by kind.
  const groups = new Map<string, Map<SensorKind, { meta: SensorMeta; userHidden: boolean }[]>>();
  const ownCount = new Map<string, number>();
  for (const hw of hardware) {
    const byKind = new Map<SensorKind, { meta: SensorMeta; userHidden: boolean }[]>();
    let count = 0;
    for (const meta of hw.sensors) {
      total++;
      const userHidden = hidden.has(meta.id);
      if (userHidden && !showHidden) {
        hiddenByUser++;
        continue;
      }
      if (!userHidden && hideUnused && isUnused(meta, maxOf(meta))) {
        hiddenUnused++;
        continue;
      }
      if (only && !only(meta)) continue;
      if (searching && !matches(q, labelOf(meta.id, meta.name), meta.name, hw.name)) continue;
      let list = byKind.get(meta.kind);
      if (!list) byKind.set(meta.kind, (list = []));
      list.push({ meta, userHidden });
      count++;
    }
    groups.set(hw.id, byKind);
    ownCount.set(hw.id, count);
  }

  // 2. Bottom-up: does a node or any descendant have something to show?
  const hasVisible = new Map<string, boolean>();
  for (let i = hardware.length - 1; i >= 0; i--) {
    const hw = hardware[i];
    if ((ownCount.get(hw.id) ?? 0) > 0) hasVisible.set(hw.id, true);
    if (hasVisible.get(hw.id) && hw.parentId && byId.has(hw.parentId)) hasVisible.set(hw.parentId, true);
  }
  const childCount = new Map<string, number>();
  for (const hw of hardware) {
    if (hw.parentId && byId.has(hw.parentId) && hasVisible.get(hw.id)) {
      childCount.set(hw.parentId, (childCount.get(hw.parentId) ?? 0) + 1);
    }
  }

  // 3. Emit rows in tree order.
  const rows: TreeRow[] = [];
  const rootExpanded = searching || !collapsed.has(ROOT_KEY);
  let shown = 0;
  for (const c of ownCount.values()) shown += c;
  rows.push({
    key: ROOT_KEY,
    kind: "root",
    level: 0,
    parentKey: null,
    name: rootName,
    expandable: true,
    expanded: rootExpanded,
    sensorCount: shown,
  });

  const isOpen = (key: string) => searching || !collapsed.has(key);
  const ancestorsOpen = (hw: HardwareNode): boolean => {
    let p = hw.parentId ? byId.get(hw.parentId) : undefined;
    let guard = 0;
    while (p && guard++ < 16) {
      if (!isOpen(hwKey(p.id))) return false;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return true;
  };

  if (rootExpanded) {
    for (const hw of hardware) {
      if (!hasVisible.get(hw.id)) continue;
      if (!ancestorsOpen(hw)) continue;
      const level = 1 + (depth.get(hw.id) ?? 0);
      const key = hwKey(hw.id);
      const parentKey = hw.parentId && byId.has(hw.parentId) ? hwKey(hw.parentId) : ROOT_KEY;
      const expanded = isOpen(key);
      const sensorCount = ownCount.get(hw.id) ?? 0;
      rows.push({
        key,
        kind: "hw",
        level,
        parentKey,
        hw,
        expandable: sensorCount > 0 || (childCount.get(hw.id) ?? 0) > 0,
        expanded,
        sensorCount,
      });
      if (!expanded) continue;
      const byKind = groups.get(hw.id)!;
      const kinds = [...byKind.keys()].sort((a, b) => (KIND_RANK[a] ?? 99) - (KIND_RANK[b] ?? 99));
      for (const kind of kinds) {
        const list = byKind.get(kind)!;
        const gk = groupKey(hw.id, kind);
        const gOpen = isOpen(gk);
        rows.push({
          key: gk,
          kind: "group",
          level: level + 1,
          parentKey: key,
          hw,
          sensorKind: kind,
          expandable: true,
          expanded: gOpen,
          sensorIds: list.map((s) => s.meta.id),
          units: [...new Set(list.map((s) => s.meta.unit as string).filter(Boolean))],
        });
        if (!gOpen) continue;
        for (const { meta, userHidden } of list) {
          rows.push({
            key: sensorKey(meta.id),
            kind: "sensor",
            level: level + 2,
            parentKey: gk,
            hw,
            meta,
            userHidden,
            expandable: false,
            expanded: false,
          });
        }
      }
    }
  }

  return {
    rows,
    total,
    shown,
    hiddenByUser,
    hiddenUnused,
    noMatches: searching && shown === 0,
    devices: hardware.filter((h) => h.sensors.length > 0).length,
    hwKeys: hardware.map((h) => hwKey(h.id)),
  };
}

/** Sensor ids covered by a row (a group or hardware row covers all of its visible sensors). */
export function sensorIdsOfRow(row: TreeRow, rows: readonly TreeRow[]): string[] {
  switch (row.kind) {
    case "sensor":
      return [row.meta.id];
    case "group":
      return row.sensorIds;
    case "hw": {
      const ids: string[] = [];
      // Descendant rows follow the hardware row until the level returns to it.
      const start = rows.indexOf(row);
      for (let i = start + 1; i < rows.length; i++) {
        const r = rows[i];
        if (r.level <= row.level) break;
        if (r.kind === "group") ids.push(...r.sensorIds);
      }
      // Collapsed node: no group rows emitted; fall back to the node's own sensors.
      if (ids.length === 0) for (const s of row.hw.sensors) ids.push(s.id);
      return ids;
    }
    case "root":
      return [];
  }
}

/** "since 14:02 (1 h 12 min)" pieces. */
export function fmtElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 1) return "under 1 min";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
