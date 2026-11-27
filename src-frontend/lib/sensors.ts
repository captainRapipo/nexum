// Sensor-tree helpers (CONTRACT §4.5 lib/sensors.ts): rule-based lookup, default pins,
// Cooling temperatures, the "unused" rule and label re-matching.

import type {
  DiskTelemetry,
  HardwareKind,
  HardwareNode,
  PhysicalDisk,
  SensorKind,
  SensorMeta,
  SensorTree,
  Settings,
} from "../types";
import { systemDiskTelemetry } from "./disks";

export interface SensorRule {
  hwKinds: HardwareKind[];
  kind: SensorKind;
  /** Exact sensor names, priority order. */
  names: string[];
}

const GPU_KINDS: HardwareKind[] = ["gpuAmd", "gpuNvidia", "gpuIntel"];

/**
 * First sensor matching the rule. Names are tried in priority order; for each name the
 * hardware nodes are tried in `hwKinds` order (so discrete GPUs precede gpuIntel), then tree order.
 */
export function findSensor(tree: SensorTree | null | undefined, rule: SensorRule): SensorMeta | null {
  if (!tree || !Array.isArray(tree.hardware)) return null;
  const nodes = tree.hardware
    .map((hw, order) => ({ hw, order, rank: rule.hwKinds.indexOf(hw.kind) }))
    .filter((n) => n.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const name of rule.names) {
    for (const { hw } of nodes) {
      const s = hw.sensors.find((m) => m.kind === rule.kind && m.name === name);
      if (s) return s;
    }
  }
  return null;
}

export const CPU_TEMP_RULE: SensorRule = {
  hwKinds: ["cpu"],
  kind: "temperature",
  names: ["Core (Tctl/Tdie)", "CPU Package", "Core (Tctl)", "Core (Tdie)", "Tctl/Tdie", "Package"],
};

export const GPU_HOTSPOT_RULE: SensorRule = { hwKinds: GPU_KINDS, kind: "temperature", names: ["GPU Hot Spot"] };

export const VRM_RULE: SensorRule = { hwKinds: ["superio"], kind: "temperature", names: ["VRM MOS", "VRM"] };

/** Default pins 1–3 (pin 4, the system-drive temperature, is resolved from the disk join). */
export const DEFAULT_PIN_RULES: readonly SensorRule[] = [CPU_TEMP_RULE, GPU_HOTSPOT_RULE, VRM_RULE];

/** Temperatures that drive fan decisions, shown in the Cooling view (missing ones are omitted). */
export const COOLING_TEMP_RULES: readonly SensorRule[] = [
  CPU_TEMP_RULE,
  { hwKinds: ["superio"], kind: "temperature", names: ["VRM MOS"] },
  { hwKinds: ["superio"], kind: "temperature", names: ["Chipset"] },
  { hwKinds: ["superio"], kind: "temperature", names: ["System #1"] },
  { hwKinds: ["superio"], kind: "temperature", names: ["System #2"] },
  GPU_HOTSPOT_RULE,
];

/** Resolve a list of rules to the sensors present in the tree (deduplicated, order kept). */
export function resolveRules(tree: SensorTree | null | undefined, rules: readonly SensorRule[]): SensorMeta[] {
  const out: SensorMeta[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    const s = findSensor(tree, r);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/** The default pin list used while `settings.pinnedSensors === null` (CONTRACT §4.5). */
export function resolveDefaultPins(
  tree: SensorTree | null | undefined,
  physical: readonly PhysicalDisk[],
  tele: readonly DiskTelemetry[],
): string[] {
  if (!tree) return [];
  const ids = resolveRules(tree, DEFAULT_PIN_RULES).map((s) => s.id);
  const sys = systemDiskTelemetry(physical, tele);
  if (sys) {
    const node = tree.hardware.find((h) => h.id === sys.id);
    const t = node?.sensors.find((s) => s.kind === "temperature");
    if (t && !ids.includes(t.id)) ids.push(t.id);
  }
  return ids;
}

/** "Unused": no value at tree build, or a fan / voltage whose session max is null or 0. */
export function isUnused(meta: SensorMeta, max: number | null): boolean {
  return meta.defaultHidden || ((meta.kind === "fan" || meta.kind === "voltage") && (max === null || max === 0));
}

/** id → { meta, hw } index of a tree. */
export function indexTree(tree: SensorTree | null | undefined): Map<string, { meta: SensorMeta; hw: HardwareNode }> {
  const map = new Map<string, { meta: SensorMeta; hw: HardwareNode }>();
  if (!tree || !Array.isArray(tree.hardware)) return map;
  for (const hw of tree.hardware) {
    for (const meta of hw.sensors) map.set(meta.id, { meta, hw });
  }
  return map;
}

/**
 * Label re-match (CONTRACT §4.5): for each labelled id absent from the tree, if exactly one sensor
 * has `name === meta.defaultName`, its node `name === meta.hardwareName`, and no label of its own,
 * move label + meta to that id. Returns the settings patch, or null when nothing moves.
 */
export function rematchLabels(
  tree: SensorTree | null | undefined,
  settings: Pick<Settings, "sensorLabels" | "sensorLabelMeta">,
): Partial<Settings> | null {
  if (!tree || !Array.isArray(tree.hardware)) return null;
  const index = indexTree(tree);
  const labels = { ...(settings.sensorLabels ?? {}) };
  const metas = { ...(settings.sensorLabelMeta ?? {}) };
  let moved = false;

  for (const oldId of Object.keys(labels)) {
    if (index.has(oldId)) continue;
    const meta = metas[oldId];
    if (!meta) continue;
    const candidates: string[] = [];
    for (const [id, { meta: m, hw }] of index) {
      if (m.name === meta.defaultName && hw.name === meta.hardwareName) candidates.push(id);
    }
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    if (labels[target]) continue;
    labels[target] = labels[oldId];
    metas[target] = meta;
    delete labels[oldId];
    delete metas[oldId];
    moved = true;
  }

  return moved ? { sensorLabels: labels, sensorLabelMeta: metas } : null;
}
