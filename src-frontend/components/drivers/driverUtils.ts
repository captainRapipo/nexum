import type { DriverCategory, DriverInfo } from "../../types";

export const DRIVER_CATEGORIES: DriverCategory[] = [
  "Display",
  "Chipset",
  "Network",
  "Audio",
  "Storage",
  "USB",
  "Bluetooth",
  "Firmware",
  "Input",
  "System",
  "Other",
];

export type DriverStatusFilter = "all" | "ok" | "outdated" | "unsigned";

/** Stable identity for a driver row (deviceId alone may repeat for multi-function devices). */
export function driverKey(d: DriverInfo): string {
  return `${d.deviceId}::${d.infName}::${d.version}`;
}

export type SignatureKind = "whql" | "microsoft" | "signed" | "unsigned";

export function signatureKind(d: DriverInfo): SignatureKind {
  if (!d.signed) return "unsigned";
  const s = (d.signer || "").toLowerCase();
  if (s.includes("hardware compatibility publisher") || s.includes("whql")) return "whql";
  if (s.includes("microsoft")) return "microsoft";
  return "signed";
}

export function signatureLabel(kind: SignatureKind): string {
  switch (kind) {
    case "whql":
      return "WHQL";
    case "microsoft":
      return "Microsoft signed";
    case "signed":
      return "Signed";
    default:
      return "Unsigned";
  }
}

/** Compare dotted version strings numerically ("31.0.15.5222" vs "4.1.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = (a || "").split(/[.\-_ ]/).map((x) => parseInt(x, 10));
  const pb = (b || "").split(/[.\-_ ]/).map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : -1;
    const y = Number.isFinite(pb[i]) ? pb[i] : -1;
    if (x !== y) return x - y;
  }
  return (a || "").localeCompare(b || "");
}

/** Human friendly age: "3.4 yrs", "8 mo", "12 d". */
export function fmtAge(days: number | null): string {
  if (days == null || !Number.isFinite(days) || days < 0) return "—";
  if (days >= 365) return `${(days / 365).toFixed(1)} yrs`;
  if (days >= 60) return `${Math.round(days / 30.44)} mo`;
  return `${Math.round(days)} d`;
}

export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i <= 0) return p;
  // Keep "C:\" form for a root path
  if (i === 2 && p[1] === ":") return p.slice(0, 3);
  return p.slice(0, i);
}

export interface VendorPortal {
  vendor: string;
  url: string;
}

const MS_MANUAL_DRIVERS =
  "https://support.microsoft.com/windows/update-drivers-manually-in-windows-ec62f46c-ff14-c91d-eead-d7126dc1f7b6";

const PORTALS: { test: RegExp; vendor: string; url: string }[] = [
  { test: /nvidia/i, vendor: "NVIDIA", url: "https://www.nvidia.com/Download/index.aspx" },
  {
    test: /\bamd\b|advanced micro devices|\bati\b|ati technologies/i,
    vendor: "AMD",
    url: "https://www.amd.com/en/support",
  },
  // Killer networking is owned by Intel (ex Rivet Networks) – drivers ship via Intel DSA.
  {
    test: /killer|rivet networks/i,
    vendor: "Intel Killer",
    url: "https://www.intel.com/content/www/us/en/support/detect.html",
  },
  { test: /qualcomm|atheros/i, vendor: "Qualcomm", url: "https://www.qualcomm.com/support" },
  { test: /mediatek|ralink/i, vendor: "MediaTek", url: "https://www.mediatek.com/support" },
  {
    test: /\bintel\b|intel\(r\)|intel corporation/i,
    vendor: "Intel",
    url: "https://www.intel.com/content/www/us/en/support/detect.html",
  },
  {
    test: /realtek/i,
    vendor: "Realtek",
    url: "https://www.realtek.com/Download/List?cate_id=593",
  },
  {
    test: /samsung/i,
    vendor: "Samsung",
    url: "https://semiconductor.samsung.com/consumer-storage/support/tools/",
  },
  { test: /microsoft/i, vendor: "Microsoft", url: MS_MANUAL_DRIVERS },
];

/**
 * Map a driver to its official vendor update portal. Provider is checked first, then manufacturer.
 * Falls back to a Microsoft Update Catalog search for the device name.
 */
export function vendorPortalFor(d: DriverInfo): VendorPortal {
  for (const field of [d.provider, d.manufacturer]) {
    if (!field) continue;
    for (const p of PORTALS) {
      if (p.test.test(field)) return { vendor: p.vendor, url: p.url };
    }
  }
  const q = (d.deviceName || d.deviceId || "").trim();
  return {
    vendor: "Microsoft Update Catalog",
    url: `https://www.catalog.update.microsoft.com/Search.aspx?q=${encodeURIComponent(q)}`,
  };
}

/** Lower-cased haystack used by the search box. */
export function driverSearchText(d: DriverInfo): string {
  return [
    d.deviceName,
    d.deviceClass,
    d.category,
    d.provider,
    d.manufacturer,
    d.version,
    d.date,
    d.signer,
    d.infName,
    d.deviceId,
  ]
    .join(" ")
    .toLowerCase();
}
