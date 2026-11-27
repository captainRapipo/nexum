// Row model of the System view (CONTRACT §1.4, §2.6, §4.10). The spec sheet and "Copy as text"
// render from the same rows, so the two never disagree.

import type {
  BoardSpec,
  CpuCacheSpec,
  CpuSpec,
  DimmSpec,
  GpuSpec,
  GpuVendor,
  MemorySpec,
  OsSpec,
  SecuritySpec,
  SystemSpec,
  UnavailableReason,
} from "../../types";
import { fmtBiosVendor, fmtBoardName, fmtCount, fmtDate, fmtUptime } from "../../lib/format";

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

/** Row text of the memory timings in v1.0 (CONTRACT §4.10). */
export const TIMINGS_LOCKED = "Not available in this version";
export const TIMINGS_LOCKED_HINT = "Memory timings are read in Nexum 1.1.";

export type SpecValue =
  | { kind: "text"; text: string; mono?: boolean }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "locked"; text: string; hint: string };

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
    case "locked":
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
  /** Reason for board.superIo (needs PawnIO through LHM). */
  superIo: UnavailableReason;
  /** Reason for Rust-owned security values that need elevation. */
  admin: UnavailableReason;
  forCopy?: boolean;
}

export function cpuRows(cpu: CpuSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Name", value: txt(cpu.name) },
    { label: "Codename", value: orNa(cpu.codename, ctx.missing) },
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
    { label: "Timings", value: { kind: "locked", text: TIMINGS_LOCKED, hint: TIMINGS_LOCKED_HINT } },
  ];
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
    { label: "Timings", value: { kind: "locked", text: TIMINGS_LOCKED, hint: TIMINGS_LOCKED_HINT } },
  ];
}

export function gpuRows(g: GpuSpec, ctx: RowCtx): SpecRow[] {
  return [
    { label: "Name", value: txt(g.name) },
    { label: "Vendor", value: txt(GPU_VENDOR_LABEL[g.vendor] ?? "Other") },
    { label: "Video memory", value: g.vramGb != null ? txt(`${g.vramGb.toFixed(1)} GB`, true) : na(ctx.missing) },
    { label: "Driver version", value: orNa(g.driverVersion, ctx.missing, true) },
    { label: "Driver date", value: dateValue(g.driverDate, ctx.missing, !!ctx.forCopy) },
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
export function buildSpecText(spec: SystemSpec, sectionReason: UnavailableReason, ctx: RowCtx, now: number): string {
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
  out.push(...(spec.memory ? rowsText(memoryRows(spec.memory, c)) : [missingSection]));
  out.push("");

  out.push("[SPD]");
  if (spec.memory && spec.memory.dimms.length > 0) {
    spec.memory.dimms.forEach((d, i) => {
      if (i > 0) out.push("");
      out.push(d.slot || `Module ${i + 1}`);
      out.push(...rowsText(dimmRows(d, c).filter((r) => r.label !== "Slot"), "  "));
    });
  } else out.push(spec.memory ? "— (No modules reported)" : missingSection);
  out.push("");

  out.push("[Graphics]");
  if (spec.gpus.length > 0) {
    spec.gpus.forEach((g, i) => {
      if (i > 0) out.push("");
      out.push(`GPU ${i + 1}`);
      out.push(...rowsText(gpuRows(g, c), "  "));
    });
  } else out.push(missingSection);
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
