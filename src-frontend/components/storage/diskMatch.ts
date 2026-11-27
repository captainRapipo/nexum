import type { PhysicalDisk } from "../../types";

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Media/bus chips are decoration (never state), so they use neutral and series colours only. */
export type MediaChip = { label: string; tone: "teal" | "purple" | "cyan" | "silver" };

export function mediaChips(p: PhysicalDisk | null, nameHint?: string): MediaChip[] {
  if (!p) {
    const n = norm(nameHint);
    if (n.includes("nvme")) return [{ label: "NVMe", tone: "teal" }];
    return [{ label: "Sensor only", tone: "silver" }];
  }
  const bus = norm(p.busType);
  const chips: MediaChip[] = [];
  if (bus === "nvme") chips.push({ label: "NVMe", tone: "teal" });
  else if (bus === "usb") chips.push({ label: "USB", tone: "purple" });
  else if (bus === "sata" || bus === "ata") {
    if (p.mediaType === "SSD") chips.push({ label: "SATA SSD", tone: "cyan" });
    else if (p.mediaType === "HDD") chips.push({ label: "SATA HDD", tone: "silver" });
    else chips.push({ label: "SATA", tone: "silver" });
  } else if (p.busType) chips.push({ label: p.busType, tone: "silver" });

  if (p.mediaType === "HDD" && !chips.some((c) => c.label.includes("HDD"))) chips.push({ label: "HDD", tone: "silver" });
  if (p.mediaType === "SSD" && bus !== "nvme" && !chips.some((c) => c.label.includes("SSD")))
    chips.push({ label: "SSD", tone: "cyan" });
  return chips;
}
