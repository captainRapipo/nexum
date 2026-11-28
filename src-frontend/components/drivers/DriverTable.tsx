import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, HardDrive, SearchX } from "lucide-react";
import type { DriverInfo } from "../../types";
import { EmptyState, StatusIcon, StatusPill } from "../ui";
import { cn } from "../../lib/format";
import {
  compareVersions,
  fmtAge,
  NEUTRAL_CODES,
  problemChipText,
  problemText,
  signatureKind,
  signatureLabel,
  STATUS_RANK,
  type DriverRow,
  type SignatureKind,
} from "./driverUtils";

export type DriverSortKey = "device" | "category" | "provider" | "version" | "date" | "age" | "signature";

/** Dense row of SPEC §7 (`--row-h-dense`). */
const ROW_H = 24;
const OVERSCAN = 12;

interface Column {
  key: DriverSortKey;
  label: string;
  /** Width (on the `th`) and visibility (repeated on the `td`s) by the width of the table itself. */
  th: string;
  td: string;
  right?: boolean;
}

/**
 * Columns by the width of the table (container queries, so a docked detail panel counts too):
 *   1210 px and more   every column (a 1440 px window and wider: 1220 px less the scrollbar)
 *   below 1210 px      no Category, narrower columns (MF-5, MF-10: hidden below a 1440 px window)
 *   below 900 px       Device, Version, Date and Status only (the detail panel shows the rest)
 * INF lives in the detail panel only. Widths are those of the design (cells include their 12 px side
 * padding); the Device column takes what is left.
 */
const COLUMNS: Column[] = [
  { key: "device", label: "Device", th: "", td: "font-medium text-ink" },
  { key: "category", label: "Category", th: "w-[100px] @max-[1210px]:hidden", td: "text-ink-2 @max-[1210px]:hidden" },
  { key: "provider", label: "Provider", th: "w-[210px] @max-[1210px]:w-[140px] @max-[900px]:hidden", td: "text-ink-2 @max-[900px]:hidden" },
  { key: "version", label: "Version", th: "w-[140px] @max-[1210px]:w-[142px]", td: "text-ink", right: true },
  { key: "date", label: "Date", th: "w-[112px] @max-[1210px]:w-[106px]", td: "text-ink", right: true },
  { key: "age", label: "Age", th: "w-[76px] @max-[1210px]:w-[66px] @max-[900px]:hidden", td: "text-ink-3 @max-[900px]:hidden", right: true },
  { key: "signature", label: "Signature", th: "w-[96px] @max-[1210px]:w-[84px] @max-[900px]:hidden", td: "text-ink-2 @max-[900px]:hidden" },
];
const STATUS_TH = "w-[206px] @max-[1210px]:w-[196px]";

/** Body cell: one 24 px line, cut with an ellipsis. */
const TD = "h-6 overflow-hidden text-ellipsis whitespace-nowrap py-0";

const SIG_RANK: Record<SignatureKind, number> = { whql: 0, microsoft: 1, signed: 2, unsigned: 3 };

function compareBy(key: DriverSortKey, a: DriverInfo, b: DriverInfo): number {
  switch (key) {
    case "device":
      return (a.deviceName || "").localeCompare(b.deviceName || "", undefined, { sensitivity: "base" });
    case "category":
      return a.category.localeCompare(b.category);
    case "provider":
      return (a.provider || "").localeCompare(b.provider || "", undefined, { sensitivity: "base" });
    case "version":
      return compareVersions(a.version, b.version);
    case "date": {
      // Empty dates always sort as "oldest"
      const da = a.date || "0000-00-00";
      const db = b.date || "0000-00-00";
      return da < db ? -1 : da > db ? 1 : 0;
    }
    case "age":
      return (a.ageDays ?? -1) - (b.ageDays ?? -1);
    case "signature":
      return SIG_RANK[signatureKind(a)] - SIG_RANK[signatureKind(b)];
  }
}

export interface DriverTableProps {
  rows: DriverRow[];
  selectedKey: string | null;
  onSelect: (row: DriverRow) => void;
  loading?: boolean;
  className?: string;
}

/** Signature as a word: `WHQL`, `Microsoft`, `Signed` or `Unsigned` (the signer is the hover text). */
export function signatureWord(driver: DriverInfo): string {
  const kind = signatureKind(driver);
  return kind === "microsoft" ? "Microsoft" : signatureLabel(kind);
}

const STATUS_RULE =
  "A code means Windows reports a device error (Device Manager). Codes 22 (disabled by you) and 45 (not connected) are not faults. Unsigned = no valid digital signature. Driver age never changes the status.";

/**
 * Status of one driver (MF-5, SPEC §7): a chip for a Device Manager code (`Code 28 · no driver`,
 * attention; codes 22 and 45 neutral) or a missing signature; a quiet green check and "OK" otherwise,
 * so a long list stays calm. Icon + word always; the rule is the hover text.
 */
export function DriverStatusBadge({ driver }: { driver: DriverInfo }) {
  if (driver.status === "problem") {
    return (
      <StatusPill tone="warn" title={`${problemText(driver.problemCode)}. ${STATUS_RULE}`}>
        {problemChipText(driver.problemCode)}
      </StatusPill>
    );
  }
  if (driver.status === "unsigned") {
    return (
      <StatusPill tone="warn" title={`No valid digital signature. ${STATUS_RULE}`}>
        Unsigned
      </StatusPill>
    );
  }
  if (driver.problemCode != null && NEUTRAL_CODES.has(driver.problemCode)) {
    return (
      <StatusPill tone="unknown" title={`${problemText(driver.problemCode)}. Not a fault. ${STATUS_RULE}`}>
        {problemChipText(driver.problemCode)}
      </StatusPill>
    );
  }
  return (
    <span className="inline-flex items-center gap-[5px] align-middle leading-none text-ink-2" title={`Signed and Windows reports no device problem. ${STATUS_RULE}`}>
      <StatusIcon tone="ok" size={13} />
      OK
    </span>
  );
}

/**
 * Driver list (SPEC §7): full-bleed on the white content surface, sticky 28 px header, 24 px zebra
 * rows without row borders. Problems always sort first, then the chosen column. Identical devices
 * arrive grouped ("× 16"). Only the rows near the viewport are in the DOM (fixed row height).
 */
export default function DriverTable({ rows: input, selectedKey, onSelect, loading, className }: DriverTableProps) {
  const [sortKey, setSortKey] = useState<DriverSortKey>("device");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    // Problems always first (MF-5), then the chosen column; tie-break on device name so the order is stable.
    return [...input].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      const c = compareBy(sortKey, a.driver, b.driver) * dir;
      if (c !== 0) return c;
      return (a.driver.deviceName || "").localeCompare(b.driver.deviceName || "");
    });
  }, [input, sortKey, sortDir]);

  /* ---------------------------------------------- windowing */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  // A new filter or sort starts at the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [input, sortKey, sortDir]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(sorted.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const selectedIndex = selectedKey ? sorted.findIndex((r) => r.key === selectedKey) : -1;
  // One row is in the tab order: the selected one while it is rendered, else the first rendered row.
  const tabIndexRow = selectedIndex >= first && selectedIndex < last ? selectedIndex : first;

  const toggleSort = (key: DriverSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "asc");
    }
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, r: DriverRow) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(r);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    let next = e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
    // Skip the spacer rows of the windowed list.
    while (next && !(next instanceof HTMLElement && next.dataset.row === "1")) {
      next = e.key === "ArrowDown" ? next.nextElementSibling : next.previousElementSibling;
    }
    if (next instanceof HTMLElement) {
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    }
  };

  if (sorted.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-content", className)}>
        {loading ? (
          <EmptyState icon={HardDrive} title="Scanning device drivers…" body="Reading the installed drivers from Windows. This takes a few seconds." />
        ) : (
          <EmptyState icon={SearchX} title="No drivers match" body="Nothing fits the filter and the category chosen above." />
        )}
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className={cn("@container min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-content", className)}>
      <table className="w-full table-fixed border-separate border-spacing-0 text-left text-table text-ink tnum" aria-rowcount={sorted.length + 1}>
        <thead>
          <tr>
            {COLUMNS.map((c, i) => {
              const active = c.key === sortKey;
              const Arrow = sortDir === "asc" ? ChevronDown : ChevronUp;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn(
                    "sticky top-0 z-10 h-7 overflow-hidden border-b border-hairline bg-content px-3 text-[11px] font-semibold tracking-[0.01em] text-ink-2",
                    i === 0 && "pl-(--page-pad-x)",
                    c.right && "text-right",
                    c.th,
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    title={`Sort by ${c.label.toLowerCase()}`}
                    className={cn("focus-inset inline-flex h-7 max-w-full items-center gap-0.5 whitespace-nowrap font-semibold hover:text-ink", active && "text-ink")}
                  >
                    <span className="truncate">{c.label}</span>
                    {active && <Arrow size={11} aria-hidden="true" className="shrink-0" />}
                  </button>
                </th>
              );
            })}
            <th
              scope="col"
              title={STATUS_RULE}
              className={cn(
                "sticky top-0 z-10 h-7 border-b border-hairline bg-content pl-3 pr-(--page-pad-x) text-[11px] font-semibold tracking-[0.01em] text-ink-2",
                STATUS_TH,
              )}
            >
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Spacer rows stand in for the rows outside the window. One cell, no colSpan: a span over
              the hidden columns would add an empty column to the fixed layout. */}
          {first > 0 && (
            <tr aria-hidden="true">
              <td style={{ height: first * ROW_H, padding: 0 }} />
            </tr>
          )}
          {sorted.slice(first, last).map((r, k) => {
            const i = first + k;
            const d = r.driver;
            const selected = r.key === selectedKey;
            const count = r.members.length;
            return (
              <tr
                key={r.key}
                data-row="1"
                aria-rowindex={i + 2}
                aria-selected={selected}
                tabIndex={i === tabIndexRow ? 0 : -1}
                onClick={() => onSelect(r)}
                onKeyDown={(e) => onRowKey(e, r)}
                title="Show details"
                className={cn("focus-inset h-6", selected ? "bg-selected" : cn(i % 2 === 1 && "bg-row-alt", "hover:bg-hover"))}
              >
                <td className={cn(TD, COLUMNS[0].td, "pl-(--page-pad-x) pr-3")} title={d.deviceName}>
                  {d.deviceName || "Unknown device"}
                  {count > 1 && (
                    <span className="ml-1.5 font-normal text-ink-3" title={`${count} identical devices`}>
                      × {count}
                    </span>
                  )}
                </td>
                <td className={cn(TD, "px-3", COLUMNS[1].td)}>{d.category}</td>
                <td className={cn(TD, "px-3", COLUMNS[2].td)} title={d.provider}>
                  {d.provider || "—"}
                </td>
                <td className={cn(TD, "px-3 text-right", COLUMNS[3].td)} title={d.version}>
                  {d.version || "—"}
                </td>
                <td className={cn(TD, "px-3 text-right", COLUMNS[4].td)}>{d.date || "—"}</td>
                <td className={cn(TD, "px-3 text-right", COLUMNS[5].td)}>{fmtAge(d.ageDays)}</td>
                <td className={cn(TD, "px-3", COLUMNS[6].td)} title={d.signer || (d.signed ? "Signed" : "No digital signature")}>
                  {d.provider || d.version || d.signed ? signatureWord(d) : "—"}
                </td>
                <td className={cn(TD, "pl-3 pr-(--page-pad-x)")}>
                  {/* A 20 px chip on a text baseline would stretch the 24 px row. */}
                  <div className="flex h-6 items-center">
                    <DriverStatusBadge driver={d} />
                  </div>
                </td>
              </tr>
            );
          })}
          {last < sorted.length && (
            <tr aria-hidden="true">
              <td style={{ height: (sorted.length - last) * ROW_H, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
