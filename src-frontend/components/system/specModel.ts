// Row model of the System view (CONTRACT §1.4, §2.6, §4.10). The spec sheet and "Copy as text"
// render from the same rows, so the two never disagree.

import type {
  BoardSpec,
  CpuCacheSpec,
  CpuSpec,
  DimmSpec,
  DiskLink,
  GpuSpec,
  GpuVendor,
  MemorySpec,
  MemoryTimings,
  OsSpec,
  PcieLink,
  PhysicalDisk,
  SecuritySpec,
  SpdInfo,
  SpdTimingKey,
  SystemSpec,
  TimingsSource,
  UnavailableReason,
} from "../../types";
import { fmtBiosVendor, fmtBoardName, fmtCount, fmtDate, fmtTemp, fmtUptime } from "../../lib/format";

export type SpecTabId = "cpu" | "board" | "memory" | "spd" | "graphics" | "os";

export const SPEC_TABS: ReadonlyArray<{ id: SpecTabId; label: string }> = [
  { id: "cpu", label: "CPU" },
  { id: "board", label: "Mainboard" },
  { id: "memory", label: "Memory" },
  { id: "spd", label: "SPD" },
  { id: "graphics", label: "Graphics" },
  { id: "os", label: "OS & Security" },
];

/** Exact cause texts of <Unavailable> (CONTRACT §4.7), for plain-text export. */
const UNAVAILABLE_COPY: Record<UnavailableReason, string> = {
  notElevated: "Needs administrator",
  pawnIoMissing: "Needs PawnIO driver",
  pawnIoOutdated: "PawnIO update needed",
  unsupported: "Not reported by this hardware",
  agentOffline: "Hardware agent offline",
};

export type SpecValue =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "unavailable"; reason: UnavailableReason }
  /** A value that does not exist for this source (e.g. command rate in SPD data): em dash + short reason. */
  | { kind: "muted"; text: string; hint: string };

export interface SpecRow {
  label: string;
  value: SpecValue;
}

export const txt = (text: string, mono = false): SpecValue => ({ kind: "text", text, mono });
export const na = (reason: UnavailableReason): SpecValue => ({ kind: "unavailable", reason });

/** Text, or <Unavailable> when the source is null / empty. */
function orNa(v: string | null | undefined, reason: UnavailableReason, mono = false): SpecValue {
  const t = (v ?? "").trim();
  return t ? txt(t, mono) : na(reason);
}

export function specValueText(v: SpecValue): string {
  switch (v.kind) {
    case "text":
      return v.text;
    case "unavailable":
      return `— (${UNAVAILABLE_COPY[v.reason]})`;
    case "muted":
      return `— (${v.text})`;
  }
}

/* ------------------------------------------------------------------ formatting */

/** 25 → "19h". */
export const hexId = (n: number) => `${Math.max(0, Math.trunc(n)).toString(16).toUpperCase()}h`;

export const fmtFms = (cpu: CpuSpec) => `${hexId(cpu.family)} / ${hexId(cpu.model)} / ${cpu.stepping}`;

export function fmtKb(kb: number): string {
  if (kb >= 1024 && kb % 1024 === 0) return `${fmtCount(kb / 1024)} MB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${fmtCount(kb)} KB`;
}

export function cacheName(c: CpuCacheSpec): string {
  if (c.level === 1) return c.type === "instruction" ? "L1 Instruction" : c.type === "data" ? "L1 Data" : "L1";
  return `L${c.level}`;
}

export const cacheTypeLabel: Record<CpuCacheSpec["type"], string> = {
  data: "Data",
  instruction: "Instruction",
  unified: "Unified",
};

export const cacheSize = (c: CpuCacheSpec) => (c.instances > 1 ? `${c.instances} × ${fmtKb(c.sizeKb)}` : fmtKb(c.sizeKb));
export const cacheWays = (c: CpuCacheSpec) => (c.ways == null ? "—" : `${c.ways}-way`);

export const GPU_VENDOR_LABEL: Record<GpuVendor, string> = {
  nvidia: "NVIDIA",
  amd: "AMD",
  intel: "Intel",
  unknown: "Other",
};

const CHANNEL_NAMES: Record<number, string> = { 1: "Single", 2: "Dual", 3: "Triple", 4: "Quad", 6: "Hexa", 8: "Octa" };
export const fmtChannels = (n: number) => CHANNEL_NAMES[n] ?? String(n);

export function fmtDimmCount(used: number, total: number | null): string {
  if (total != null && total > 0) return `${used} of ${total} DIMMs`;
  return `${used} DIMM${used === 1 ? "" : "s"}`;
}

export function fmtSizeGb(gb: number): string {
  return Number.isInteger(gb) ? `${fmtCount(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export const fmtMts = (n: number) => `${fmtCount(n)} MT/s`;

/** "YYYY-MM-DD" → "Nov 25, 2026" (spec sheet); the copy keeps ISO. */
function dateValue(iso: string | null | undefined, reason: UnavailableReason, forCopy: boolean): SpecValue {
  const t = (iso ?? "").trim();
  if (!t) return na(reason);
  return txt(forCopy ? t : fmtDate(t));
}

/* ------------------------------------------------------------------ rows per tab */

export interface RowCtx {
  /** Reason for fields the agent owns but did not report (usually "unsupported"). */
  missing: UnavailableReason;
  /** Reason for board.superIo and SPD data (need PawnIO through LHM). */
  superIo: UnavailableReason;
  /** Reason for Rust-owned security values that need elevation. */
  admin: UnavailableReason;
  /** Unit for module temperatures (Settings.tempUnit). */
  tempUnit?: "C" | "F";
  forCopy?: boolean;
}

/** Codename with the X3D suffix the agent's family/model table cannot tell apart (CONTRACT §1.4.1). */
export function displayCodename(cpu: CpuSpec): string | null {
  const c = (cpu.codename ?? "").trim();
  if (!c) return null;
  return /X3D/i.test(cpu.name) && !/X3D/i.test(c) ? `${c}-X3D` : c;
}

export function cpuRows(cpu: CpuSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Name", value: txt(cpu.name) },
    { label: "Codename", value: orNa(displayCodename(cpu), ctx.missing) },
    { label: "Vendor", value: txt(cpu.vendor) },
    { label: "Socket", value: orNa(cpu.socket, ctx.missing) },
    { label: "Family / Model / Stepping", value: txt(fmtFms(cpu), true) },
    { label: "Cores / Threads", value: txt(`${cpu.cores} cores / ${cpu.threads} threads`, true) },
    {
      label: "Base clock",
      value: cpu.baseClockMhz != null && cpu.baseClockMhz > 0 ? txt(`${fmtCount(cpu.baseClockMhz)} MHz`, true) : na(ctx.missing),
    },
  ];
}

export function boardRows(board: BoardSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Model", value: txt(fmtBoardName(board.manufacturer, board.product)) },
    { label: "Manufacturer", value: orNa(board.manufacturer, ctx.missing) },
    { label: "Product", value: orNa(board.product, ctx.missing) },
    { label: "Version", value: orNa(board.version, ctx.missing) },
    { label: "Super I/O", value: board.superIo ? txt(board.superIo) : na(ctx.superIo) },
  ];
}

export function biosRows(board: BoardSpec, ctx: RowCtx): SpecRow[] {
  const vendor = board.biosVendor.trim();
  return [
    { label: "Vendor", value: vendor ? txt(fmtBiosVendor(vendor)) : na(ctx.missing) },
    { label: "Version", value: orNa(board.biosVersion, ctx.missing, true) },
    { label: "Date", value: dateValue(board.biosDate, ctx.missing, !!ctx.forCopy) },
  ];
}

export function memoryRows(mem: MemorySpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Type", value: mem.type === "Unknown" ? na(ctx.missing) : txt(mem.type) },
    { label: "Total size", value: txt(`${mem.totalGb.toFixed(1)} GB`, true) },
    { label: "Channels", value: mem.channels != null ? txt(fmtChannels(mem.channels)) : na(ctx.missing) },
    { label: "Modules", value: txt(fmtDimmCount(mem.slotsUsed, mem.slotsTotal)) },
  ];
}

/* ------------------------------------------------------------------ memory timings and clocks (1.1) */

/** Source chip text (CONTRACT §4.10.2, §2.12). */
export const TIMINGS_SOURCE_LABEL: Record<TimingsSource, string> = {
  umc: "Live (memory controller)",
  spd: "SPD JEDEC (not the running timings)",
  unavailable: "Not available",
};

export const TIMINGS_SOURCE_HINT: Record<TimingsSource, string> = {
  umc: "Read from the AMD memory controller registers while Windows runs: these are the timings in use now.",
  spd: "JEDEC minimum times from the first module's SPD chip, converted to clock cycles at its rated JEDEC speed. The BIOS (or XMP / EXPO) may run the memory with different timings.",
  unavailable: "Memory timings could not be read on this system.",
};

/** Shown under SPD-sourced timing rows so they are never read as the running timings (CONTRACT §1.4.1). */
export const SPD_NOT_RUNNING_NOTE =
  "These are the module's JEDEC minimum timings from its SPD chip, not the timings the memory runs at now.";

const NOT_IN_SPD: SpecValue = {
  kind: "muted",
  text: "Not in SPD data",
  hint: "SPD stores JEDEC minimum times only; this is a memory-controller setting.",
};

const cyc = (n: number | null | undefined) => (n == null ? "—" : String(n));

/** `16-18-18-18-36` = CL-tRCDRD-tRCDWR-tRP-tRAS. */
export function primaryTimings(t: MemoryTimings): string {
  return [t.cl, t.rcdRd, t.rcdWr, t.rp, t.ras].map(cyc).join("-");
}

function cycles(n: number | null, missing: SpecValue): SpecValue {
  return n == null ? missing : txt(String(n), true);
}

function pair(a: number | null, b: number | null, missing: SpecValue): SpecValue {
  return a == null && b == null ? missing : txt(`${cyc(a)} / ${cyc(b)}`, true);
}

/** Timing rows of the Memory tab; [] when there are no timings (the note explains why). */
export function timingRows(mem: MemorySpec, ctx: RowCtx): SpecRow[] {
  const t = mem.timings;
  if (!t || mem.timingsSource === "unavailable") return [];
  const spd = mem.timingsSource === "spd";
  const missing: SpecValue = spd ? NOT_IN_SPD : na(ctx.missing);
  return [
    { label: "CL-tRCDRD-tRCDWR-tRP-tRAS", value: txt(primaryTimings(t), true) },
    { label: "tRC", value: cycles(t.rc, missing) },
    { label: "tRFC", value: cycles(t.rfc, missing) },
    { label: "tRRDS / tRRDL", value: pair(t.rrds, t.rrdl, missing) },
    { label: "tFAW", value: cycles(t.faw, missing) },
    { label: "tWTRS / tWTRL", value: pair(t.wtrs, t.wtrl, missing) },
    { label: "tWR", value: cycles(t.wr, missing) },
    { label: "tRTP", value: cycles(t.rtp, missing) },
    { label: "tCWL", value: cycles(t.cwl, missing) },
    { label: "Command rate", value: t.commandRate ? txt(t.commandRate, true) : missing },
    { label: "Gear-down mode", value: t.gearDown == null ? missing : txt(t.gearDown ? "Enabled" : "Disabled") },
  ];
}

const mhz = (n: number | null | undefined): SpecValue =>
  n != null && Number.isFinite(n) && n > 0 ? txt(`${fmtCount(Math.round(n))} MHz`, true) : na("unsupported");

/** Clocks within this many MHz count as equal (LHM's fabric clock reading jitters slightly). */
const COUPLED_TOLERANCE_MHZ = 15;

export interface Coupling {
  /** true = FCLK, UCLK and MEMCLK equal (1:1); false = not; null = cannot tell. */
  coupled: boolean | null;
  text: string;
  hint: string;
}

/** The 1:1 indicator (FCLK = UCLK = MEMCLK) of the Memory tab. */
export function memoryCoupling(mem: MemorySpec): Coupling {
  const hint = `1:1 when FCLK, UCLK and MEMCLK are within ${COUPLED_TOLERANCE_MHZ} MHz of each other. Ryzen memory latency is lowest when they run 1:1.`;
  const { memclkMhz: m, fclkMhz: f, uclkMhz: u } = mem;
  if (m == null || f == null || u == null || m <= 0) {
    return { coupled: null, text: "Needs FCLK, UCLK and MEMCLK readings", hint };
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= COUPLED_TOLERANCE_MHZ;
  if (near(f, m) && near(u, m)) return { coupled: true, text: "1:1 (FCLK = UCLK = MEMCLK)", hint };
  if (near(u, m / 2)) return { coupled: false, text: "Not 1:1 (UCLK runs at half MEMCLK)", hint };
  return { coupled: false, text: "Not 1:1 (FCLK differs from MEMCLK)", hint };
}

export function clockRows(mem: MemorySpec): SpecRow[] {
  const c = memoryCoupling(mem);
  return [
    { label: "MEMCLK", value: mhz(mem.memclkMhz) },
    { label: "FCLK", value: mhz(mem.fclkMhz) },
    { label: "UCLK", value: mhz(mem.uclkMhz) },
    { label: "FCLK : UCLK : MEMCLK", value: c.coupled == null ? { kind: "muted", text: c.text, hint: c.hint } : txt(c.text) },
  ];
}

/* ------------------------------------------------------------------ SPD JEDEC (1.1) */

/** Display order of SpdInfo.timingsNs (CONTRACT §1.4.1). */
export const SPD_NS_KEYS: readonly SpdTimingKey[] = [
  "tAA",
  "tRCD",
  "tRP",
  "tRAS",
  "tRC",
  "tRFC1",
  "tRFC2",
  "tRFC4",
  "tFAW",
  "tRRD_S",
  "tRRD_L",
  "tCCD_L",
  "tWR",
  "tWTR_S",
  "tWTR_L",
];

export const fmtNs = (ns: number) => `${Number(ns.toFixed(3))} ns`;

/** `JEDEC timings at 2666 MT/s` cycle rows; [] when the speed is unknown. */
export function spdCycleRows(spd: SpdInfo): SpecRow[] {
  if (spd.jedecSpeedMts == null) return [];
  const c = spd.cycles;
  const missing = na("unsupported");
  return [
    { label: "CL-tRCD-tRP-tRAS", value: txt([c.cl, c.rcd, c.rp, c.ras].map(cyc).join("-"), true) },
    { label: "tRC", value: cycles(c.rc, missing) },
    { label: "tRFC", value: cycles(c.rfc, missing) },
    { label: "tRRD_S / tRRD_L", value: pair(c.rrds, c.rrdl, missing) },
    { label: "tFAW", value: cycles(c.faw, missing) },
    { label: "tWR", value: cycles(c.wr, missing) },
    { label: "tWTR_S / tWTR_L", value: pair(c.wtrs, c.wtrl, missing) },
  ];
}

/** JEDEC minimum times in ns (only the ones the module reports). */
export function spdNsRows(spd: SpdInfo): SpecRow[] {
  const out: SpecRow[] = [];
  for (const k of SPD_NS_KEYS) {
    const v = spd.timingsNs[k];
    if (v != null && Number.isFinite(v)) out.push({ label: k, value: txt(fmtNs(v), true) });
  }
  return out;
}

/* ------------------------------------------------------------------ PCIe / storage links (1.1) */

/** `Gen 4 x16 (max Gen 4 x16)`; null when nothing is known. */
export function fmtPcieLink(l: { gen: number | null; width: number | null; maxGen: number | null; maxWidth: number | null }): string | null {
  const cur = l.gen != null || l.width != null ? `Gen ${cyc(l.gen)} x${cyc(l.width)}` : null;
  const max = l.maxGen != null || l.maxWidth != null ? `Gen ${cyc(l.maxGen)} x${cyc(l.maxWidth)}` : null;
  if (cur && max) return `${cur} (max ${max})`;
  if (cur) return cur;
  if (max) return `max ${max}`;
  return null;
}

export const PCIE_IDLE_HINT =
  "Graphics cards and SSDs lower their link speed when idle to save power, so a lower generation at idle is normal.";

export function gpuLinkValue(link: PcieLink | null, ctx: RowCtx): SpecValue {
  const t = link ? fmtPcieLink(link) : null;
  return t ? txt(t, true) : na(ctx.missing);
}

const BUS_LABEL: Record<DiskLink["bus"], string> = { nvme: "NVMe", sata: "SATA", usb: "USB", other: "Other" };
const SATA_RATE: Record<number, string> = { 1: "1.5 Gb/s", 2: "3 Gb/s", 3: "6 Gb/s" };

export function diskBusLabel(l: DiskLink): string {
  return BUS_LABEL[l.bus] ?? "Other";
}

/** Link column of the Storage links table. */
export function diskLinkText(l: DiskLink): string {
  if (l.bus === "nvme") {
    const t = fmtPcieLink(l);
    return t ? `PCIe ${t}` : "PCIe link not reported";
  }
  if (l.bus === "sata") {
    return l.sataGen != null ? `SATA ${l.sataGen}${SATA_RATE[l.sataGen] ? ` (${SATA_RATE[l.sataGen]})` : ""}` : "Speed not reported";
  }
  return "—";
}

/** `C:, D: (Samsung SSD 980 PRO 1TB)` using the Windows disk joined by number, else the link's model. */
export function diskLinkName(l: DiskLink, disks: readonly PhysicalDisk[]): string {
  const d = disks.find((p) => String(p.deviceId).trim() === String(l.diskNumber));
  const model = (d?.model ?? "").trim() || l.model.trim() || `Disk ${l.diskNumber}`;
  const vols = d && Array.isArray(d.volumes) ? d.volumes.filter(Boolean) : [];
  return vols.length > 0 ? `${vols.join(", ")} (${model})` : model;
}

export function dimmRows(d: DimmSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Slot", value: orNa(d.slot, ctx.missing) },
    { label: "Size", value: txt(fmtSizeGb(d.sizeGb), true) },
    { label: "Ranks", value: d.ranks != null ? txt(d.ranks === 1 ? "Single (1)" : d.ranks === 2 ? "Dual (2)" : String(d.ranks)) : na(ctx.missing) },
    { label: "Manufacturer", value: orNa(d.manufacturer, ctx.missing) },
    { label: "Part number", value: orNa(d.partNumber, ctx.missing, true) },
    { label: "Rated speed", value: d.speedMts != null && d.speedMts > 0 ? txt(fmtMts(d.speedMts), true) : na(ctx.missing) },
    {
      label: "Configured speed",
      value: d.configuredSpeedMts != null && d.configuredSpeedMts > 0 ? txt(fmtMts(d.configuredSpeedMts), true) : na(ctx.missing),
    },
    { label: "Voltage", value: d.voltage != null && d.voltage > 0 ? txt(`${d.voltage.toFixed(3)} V`, true) : na(ctx.missing) },
    { label: "Form factor", value: orNa(d.formFactor, ctx.missing) },
    ...(d.spd?.tempC != null && Number.isFinite(d.spd.tempC)
      ? [{ label: "Module temperature", value: txt(fmtTemp(d.spd.tempC, ctx.tempUnit ?? "C"), true) }]
      : []),
  ];
}

export function gpuRows(g: GpuSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Name", value: txt(g.name) },
    { label: "Vendor", value: txt(GPU_VENDOR_LABEL[g.vendor] ?? "Other") },
    { label: "Video memory", value: g.vramGb != null ? txt(`${g.vramGb.toFixed(1)} GB`, true) : na(ctx.missing) },
    { label: "Driver version", value: orNa(g.driverVersion, ctx.missing, true) },
    { label: "Driver date", value: dateValue(g.driverDate, ctx.missing, !!ctx.forCopy) },
    { label: "PCIe link", value: gpuLinkValue(g.link, ctx) },
  ];
}

export function osRows(os: OsSpec, now: number, ctx: RowCtx): SpecRow[] {
  const up = os.bootTs > 0 ? (now - os.bootTs) / 1000 : null;
  return [
    { label: "Operating system", value: orNa(os.caption, "unsupported") },
    { label: "Version", value: orNa(os.displayVersion, "unsupported") },
    { label: "Build", value: orNa(os.build, "unsupported", true) },
    { label: "Architecture", value: orNa(os.architecture, "unsupported") },
    { label: "Installed", value: dateValue(os.installDate, "unsupported", !!ctx.forCopy) },
    { label: "Uptime", value: up != null && up >= 0 ? txt(fmtUptime(up), true) : na("unsupported") },
  ];
}

export function securityRows(sec: SecuritySpec, ctx: RowCtx): SpecRow[] {
  const tpm: SpecValue =
    sec.tpm == null
      ? na(ctx.admin)
      : sec.tpm.present
        ? txt(sec.tpm.version ? `Present (version ${sec.tpm.version})` : "Present")
        : txt("Not present");
  return [
    { label: "Secure Boot", value: sec.secureBoot == null ? na(ctx.admin) : txt(sec.secureBoot ? "Enabled" : "Disabled") },
    { label: "TPM", value: tpm },
    { label: "BIOS mode", value: sec.biosMode === "Unknown" ? na("unsupported") : txt(sec.biosMode) },
  ];
}

/* ------------------------------------------------------------------ plain-text export */

const PAD = 28;

function line(label: string, value: string, indent = ""): string {
  return `${indent}${label.padEnd(PAD - indent.length)}${value}`;
}

function rowsText(rows: SpecRow[], indent = ""): string[] {
  return rows.map((r) => line(r.label, specValueText(r.value), indent));
}

function isoStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Plain text of every tab (CONTRACT §4.10 "Copy as text"). No hostname, no serials. */
export function buildSpecText(
  spec: SystemSpec,
  sectionReason: UnavailableReason,
  ctx: RowCtx,
  now: number,
  disks: readonly PhysicalDisk[] = [],
): string {
  const c: RowCtx = { ...ctx, forCopy: true };
  const out: string[] = ["Nexum system report", line("Captured", isoStamp(spec.capturedTs || now)), ""];
  const missingSection = `— (${UNAVAILABLE_COPY[sectionReason]})`;

  out.push("[CPU]");
  if (spec.cpu) {
    out.push(...rowsText(cpuRows(spec.cpu, c)));
    if (spec.cpu.caches.length > 0) {
      out.push("Caches");
      for (const cache of spec.cpu.caches) {
        out.push(line(cacheName(cache), `${cacheSize(cache)}${cache.ways != null ? `, ${cacheWays(cache)}` : ""}`, "  "));
      }
    }
    out.push(line("Instructions", spec.cpu.instructions.length > 0 ? spec.cpu.instructions.join(", ") : "—"));
  } else out.push(missingSection);
  out.push("");

  out.push("[Mainboard]");
  if (spec.board) {
    out.push(...rowsText(boardRows(spec.board, c)));
    out.push("BIOS");
    out.push(...rowsText(biosRows(spec.board, c), "  "));
  } else out.push(missingSection);
  out.push("");

  out.push("[Memory]");
  if (spec.memory) {
    const mem = spec.memory;
    out.push(...rowsText(memoryRows(mem, c)));
    out.push(`Timings: ${TIMINGS_SOURCE_LABEL[mem.timingsSource]}`);
    out.push(...rowsText(timingRows(mem, c), "  "));
    if (mem.timingsNote) out.push(`  ${mem.timingsNote}`);
    out.push("Clocks");
    out.push(...rowsText(clockRows(mem), "  "));
  } else out.push(missingSection);
  out.push("");

  out.push("[SPD]");
  if (spec.memory && spec.memory.dimms.length > 0) {
    spec.memory.dimms.forEach((d, i) => {
      if (i > 0) out.push("");
      out.push(d.slot || `Module ${i + 1}`);
      out.push(...rowsText(dimmRows(d, c).filter((r) => r.label !== "Slot"), "  "));
      if (d.spd && d.spd.jedecSpeedMts != null) {
        out.push(`  JEDEC timings at ${fmtCount(d.spd.jedecSpeedMts)} MT/s (SPD minimums, not the running timings)`);
        out.push(...rowsText(spdCycleRows(d.spd), "    "));
      }
      if (d.spd) {
        const ns = spdNsRows(d.spd);
        if (ns.length > 0) {
          out.push("  JEDEC minimum times");
          out.push(...rowsText(ns, "    "));
        }
      }
    });
  } else out.push(spec.memory ? "— (No modules reported)" : missingSection);
  out.push("");

  out.push("[Graphics]");
  if (spec.gpus.length > 0) {
    spec.gpus.forEach((g, i) => {
      if (i > 0) out.push("");
      out.push(`GPU ${i + 1}`);
      out.push(...rowsText(gpuRows(g, c), "  "));
      if (g.link?.note) out.push(`  ${g.link.note}`);
    });
  } else out.push(missingSection);
  out.push("");

  out.push("[Storage links]");
  const links = spec.diskLinks ?? [];
  if (links.length > 0) {
    for (const l of links) {
      out.push(line(`Disk ${l.diskNumber}`, `${diskLinkName(l, disks)} · ${diskBusLabel(l)} · ${diskLinkText(l)}`));
    }
  } else out.push(`— (${UNAVAILABLE_COPY[spec.cpu || spec.memory ? "unsupported" : sectionReason]})`);
  out.push("");

  out.push("[OS & Security]");
  out.push(...rowsText(osRows(spec.os, now, c)));
  out.push(...rowsText(securityRows(spec.security, c)));

  if (spec.errors.length > 0) {
    out.push("", "[Notes]");
    for (const e of spec.errors) out.push(`- ${e}`);
  }
  return out.join("\n") + "\n";
}
