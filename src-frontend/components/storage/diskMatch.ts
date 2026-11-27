import type { DiskTelemetry, PhysicalDisk } from "../../types";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface DiskPair {
  physical: PhysicalDisk | null;
  telemetry: DiskTelemetry | null;
  key: string;
}

/**
 * Merge physical disks (WMI/Storage API) with live sensor disks (LibreHardwareMonitor) by model name:
 * exact (case-insensitive) match first, then "either contains the other". Each telemetry disk is used
 * at most once. When there is exactly one of each and nothing matched by name, they are paired.
 * Telemetry disks that match nothing are returned as sensor-only entries.
 */
export function pairDisks(physical: PhysicalDisk[], telemetry: DiskTelemetry[]): DiskPair[] {
  const used = new Set<string>();
  const result: DiskPair[] = physical.map((p) => ({ physical: p, telemetry: null, key: `pd:${p.deviceId}:${p.serial}` }));

  // Pass 1: exact name match
  result.forEach((r) => {
    const model = norm(r.physical?.model);
    if (!model) return;
    const t = telemetry.find((d) => !used.has(d.id) && norm(d.name) === model);
    if (t) {
      used.add(t.id);
      r.telemetry = t;
    }
  });

  // Pass 2: contains either way
  result.forEach((r) => {
    if (r.telemetry) return;
    const model = norm(r.physical?.model);
    if (!model) return;
    const t = telemetry.find((d) => {
      if (used.has(d.id)) return false;
      const n = norm(d.name);
      return n.length > 0 && (n.includes(model) || model.includes(n));
    });
    if (t) {
      used.add(t.id);
      r.telemetry = t;
    }
  });

  // Pass 3: unambiguous 1:1 fallback
  const unmatchedPhys = result.filter((r) => !r.telemetry);
  const unmatchedTel = telemetry.filter((d) => !used.has(d.id));
  if (unmatchedPhys.length === 1 && unmatchedTel.length === 1 && physical.length === 1) {
    unmatchedPhys[0].telemetry = unmatchedTel[0];
    used.add(unmatchedTel[0].id);
  }

  telemetry
    .filter((d) => !used.has(d.id))
    .forEach((d) => result.push({ physical: null, telemetry: d, key: `td:${d.id}` }));

  return result;
}

export type MediaChip = { label: string; tone: "teal" | "gold" | "purple" | "cyan" | "silver" };

export function mediaChips(p: PhysicalDisk | null, nameHint?: string): MediaChip[] {
  if (!p) {
    const n = norm(nameHint);
    if (n.includes("nvme")) return [{ label: "NVMe", tone: "teal" }];
    return [{ label: "Sensor", tone: "silver" }];
  }
  const bus = norm(p.busType);
  const chips: MediaChip[] = [];
  if (bus === "nvme") chips.push({ label: "NVMe", tone: "teal" });
  else if (bus === "usb") chips.push({ label: "USB", tone: "purple" });
  else if (bus === "sata" || bus === "ata") {
    if (p.mediaType === "SSD") chips.push({ label: "SATA SSD", tone: "cyan" });
    else if (p.mediaType === "HDD") chips.push({ label: "SATA HDD", tone: "gold" });
    else chips.push({ label: "SATA", tone: "silver" });
  } else if (p.busType) chips.push({ label: p.busType, tone: "silver" });

  if (p.mediaType === "HDD" && !chips.some((c) => c.label.includes("HDD"))) chips.push({ label: "HDD", tone: "gold" });
  if (p.mediaType === "SSD" && bus !== "nvme" && !chips.some((c) => c.label.includes("SSD")))
    chips.push({ label: "SSD", tone: "cyan" });
  return chips;
}
