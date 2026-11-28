import { useCallback, useMemo, useRef } from "react";
import { resolveDefaultPins } from "../lib/sensors";
import type { SensorLabelMeta } from "../types";
import { useSensors } from "./useSensors";
import { useSettings } from "./useSettings";
import { useSystemInfo } from "./useSystemInfo";
import { useTelemetry } from "./useTelemetryStream";

export const MAX_LABEL_LEN = 64;
export const MAX_PINS = 12;

export interface SensorLabelsValue {
  /** User label, else the LHM default name. Use everywhere a sensor or fan name is shown. */
  labelOf: (id: string, defaultName: string) => string;
  /** `""` restores the default name. */
  setLabel: (id: string, label: string, meta: SensorLabelMeta) => void;
  /** Resolved pins: the explicit list, or the default-pin rule while `pinnedSensors === null`. */
  pinned: string[];
  isPinned: (id: string) => boolean;
  togglePin: (id: string) => void;
  hidden: ReadonlySet<string>;
  toggleHidden: (id: string) => void;
  hideUnused: boolean;
  setHideUnused: (on: boolean) => void;
}

/** Labels, pins and hidden sensors (CONTRACT §4.4); persisted through settings. */
export function useSensorLabels(): SensorLabelsValue {
  const { settings, update } = useSettings();
  const { tree } = useSensors();
  const { disks: physical } = useSystemInfo();
  const { latest } = useTelemetry();

  const labels = settings.sensorLabels ?? {};
  const explicitPins = settings.pinnedSensors;
  // `latest` is null while sensor reading is not up: the default pins keep using the drives last seen, so
  // the pinned list does not lose its drive row for the length of a restart.
  const seenDisks = useRef(latest?.disks);
  if (latest?.disks) seenDisks.current = latest.disks;
  const tele = latest?.disks ?? seenDisks.current;

  // Telemetry disks change identity every tick; the default pins only depend on ids/serials/numbers.
  const teleKey = (tele ?? []).map((d) => `${d.id}:${d.serial ?? ""}:${d.diskNumber ?? ""}`).join("|");
  const pinned = useMemo(
    () => (Array.isArray(explicitPins) ? explicitPins : resolveDefaultPins(tree, physical, tele ?? [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- teleKey stands in for tele
    [explicitPins, tree, physical, teleKey],
  );
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const hidden = useMemo(() => new Set(settings.hiddenSensors ?? []), [settings.hiddenSensors]);

  const labelOf = useCallback(
    (id: string, defaultName: string) => {
      const l = labels[id];
      return typeof l === "string" && l.trim() ? l : defaultName;
    },
    [labels],
  );

  const setLabel = useCallback(
    (id: string, label: string, meta: SensorLabelMeta) => {
      const text = label.trim().slice(0, MAX_LABEL_LEN);
      const nextLabels = { ...(settings.sensorLabels ?? {}) };
      const nextMeta = { ...(settings.sensorLabelMeta ?? {}) };
      if (!text || text === meta.defaultName) {
        delete nextLabels[id];
        delete nextMeta[id];
      } else {
        nextLabels[id] = text;
        nextMeta[id] = { defaultName: meta.defaultName, hardwareName: meta.hardwareName };
      }
      update({ sensorLabels: nextLabels, sensorLabelMeta: nextMeta }).catch(() => undefined);
    },
    [settings.sensorLabels, settings.sensorLabelMeta, update],
  );

  const isPinned = useCallback((id: string) => pinnedSet.has(id), [pinnedSet]);

  const togglePin = useCallback(
    (id: string) => {
      // The first change writes the resolved default list plus the change.
      const base = [...pinned];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id].slice(-MAX_PINS);
      update({ pinnedSensors: next }).catch(() => undefined);
    },
    [pinned, update],
  );

  const toggleHidden = useCallback(
    (id: string) => {
      const cur = settings.hiddenSensors ?? [];
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      update({ hiddenSensors: next }).catch(() => undefined);
    },
    [settings.hiddenSensors, update],
  );

  const setHideUnused = useCallback(
    (on: boolean) => {
      update({ hideUnusedSensors: on }).catch(() => undefined);
    },
    [update],
  );

  return {
    labelOf,
    setLabel,
    pinned,
    isPinned,
    togglePin,
    hidden,
    toggleHidden,
    hideUnused: settings.hideUnusedSensors ?? true,
    setHideUnused,
  };
}

/** Alias (task brief name). */
export const useLabels = useSensorLabels;

export default useSensorLabels;
