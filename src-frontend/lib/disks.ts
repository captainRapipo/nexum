// Telemetry disk ⇄ Windows PhysicalDisk join (CONTRACT §1.1.3 join rule, §4.5 lib/disks.ts).
// Drive health always comes from DiskTelemetry.health; PhysicalDisk.healthStatus is display-only.

import type { DiskTelemetry, PhysicalDisk } from "../types";

/** Remove whitespace, dots, underscores and dashes; uppercase. Empty → null. */
export function normSerial(s: string | null | undefined): string | null {
  if (s == null) return null;
  const n = String(s).replace(/[\s._-]/g, "").toUpperCase();
  return n.length > 0 ? n : null;
}

export interface JoinedDisk {
  disk: PhysicalDisk;
  tele: DiskTelemetry | null;
}

/**
 * One entry per PhysicalDisk (input order):
 * 1. normalized serials equal, else 2. `tele.diskNumber === Number(disk.deviceId)`, else unmatched.
 * A telemetry disk is used at most once; serial matches are resolved before number matches.
 */
export function joinDisks(physical: readonly PhysicalDisk[], tele: readonly DiskTelemetry[]): JoinedDisk[] {
  const used = new Set<number>();
  const result: Array<DiskTelemetry | null> = physical.map(() => null);

  physical.forEach((d, i) => {
    const ps = normSerial(d.serial);
    if (!ps) return;
    const j = tele.findIndex((t, k) => !used.has(k) && normSerial(t.serial) === ps);
    if (j >= 0) {
      used.add(j);
      result[i] = tele[j];
    }
  });

  physical.forEach((d, i) => {
    if (result[i]) return;
    const num = Number(d.deviceId);
    if (!Number.isFinite(num) || String(d.deviceId).trim() === "") return;
    const j = tele.findIndex((t, k) => !used.has(k) && t.diskNumber != null && t.diskNumber === num);
    if (j >= 0) {
      used.add(j);
      result[i] = tele[j];
    }
  });

  return physical.map((disk, i) => ({ disk, tele: result[i] }));
}

/** Telemetry of the disk that holds %SystemDrive% (null if unknown or unmatched). */
export function systemDiskTelemetry(
  physical: readonly PhysicalDisk[],
  tele: readonly DiskTelemetry[],
): DiskTelemetry | null {
  const joined = joinDisks(physical, tele);
  return joined.find((j) => j.disk.isSystemDisk)?.tele ?? null;
}

/** The PhysicalDisk joined to a telemetry disk (reverse lookup), or null. */
export function physicalForTelemetry(
  physical: readonly PhysicalDisk[],
  tele: readonly DiskTelemetry[],
  teleId: string,
): PhysicalDisk | null {
  return joinDisks(physical, tele).find((j) => j.tele?.id === teleId)?.disk ?? null;
}

/**
 * Display name used by health alerts and chips (CONTRACT §5.2 rule 4):
 * `<volumes joined ", "> (<model>)` when the PhysicalDisk has volumes, else `<model>`;
 * `DiskTelemetry.name` when unjoined.
 */
export function driveDisplayName(disk: PhysicalDisk | null, tele: DiskTelemetry | null): string {
  if (disk) {
    const model = disk.model?.trim() || tele?.name || "Drive";
    const vols = Array.isArray(disk.volumes) ? disk.volumes.filter(Boolean) : [];
    return vols.length > 0 ? `${vols.join(", ")} (${model})` : model;
  }
  return tele?.name ?? "Drive";
}
