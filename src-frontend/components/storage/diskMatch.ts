import type { PhysicalDisk } from "../../types";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Bus / media words for a drive ("NVMe", "SATA HDD", "USB"). They are plain descriptions, never a
 * state, so they are rendered as text or neutral tags only.
 */
export function mediaLabels(p: PhysicalDisk | null, nameHint?: string): string[] {
  if (!p) {
    return norm(nameHint).includes("nvme") ? ["NVMe"] : ["Sensor only"];
  }
  const bus = norm(p.busType);
  const out: string[] = [];
  if (bus === "nvme") out.push("NVMe");
  else if (bus === "usb") out.push("USB");
  else if (bus === "sata" || bus === "ata") {
    if (p.mediaType === "SSD") out.push("SATA SSD");
    else if (p.mediaType === "HDD") out.push("SATA HDD");
    else out.push("SATA");
  } else if (p.busType) out.push(p.busType);

  if (p.mediaType === "HDD" && !out.some((c) => c.includes("HDD"))) out.push("HDD");
  if (p.mediaType === "SSD" && bus !== "nvme" && !out.some((c) => c.includes("SSD"))) out.push("SSD");
  return out;
}

/** True for spinning drives (they get the hard-disk glyph and report no wear counter). */
export function isHdd(p: PhysicalDisk | null, teleId?: string | null): boolean {
  if (p) return p.mediaType === "HDD";
  return /^\/hdd/i.test(teleId ?? "");
}

/**
 * Short name for tight spots ("on addlink (Life 44%)"): the brand word when the model starts with
 * one, else the whole model. The full model always goes into the hover text.
 */
export function shortModel(model: string | null | undefined): string {
  const m = (model ?? "").trim();
  if (!m) return "drive";
  const first = m.split(/\s+/)[0];
  return m.includes(" ") && /^[A-Za-z][A-Za-z_-]{2,}$/.test(first) ? first : m;
}
