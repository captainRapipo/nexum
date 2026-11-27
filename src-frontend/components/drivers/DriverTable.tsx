import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { DriverInfo } from "../../types";
import { StatusPill } from "../ui";
import { cn } from "../../lib/format";
import {
  compareVersions,
  fmtAge,
  NEUTRAL_CODES,
  problemText,
  signatureKind,
  signatureLabel,
  STATUS_RANK,
  type DriverRow,
  type SignatureKind,
} from "./driverUtils";

export type DriverSortKey = "device" | "category" | "provider" | "version" | "date" | "age" | "signature";

interface Column {
  key: DriverSortKey;
  label: string;
  className: string;
}

/** Category is hidden below 1440 px; INF lives in the detail panel only (MF-5, MF-10). */
const COLUMNS: Column[] = [
  { key: "device", label: "Device", className: "w-[31%] min-w-[200px]" },
  { key: "category", label: "Category", className: "w-[9%] max-[1439px]:hidden" },
  { key: "provider", label: "Provider", className: "w-[15%]" },
  { key: "version", label: "Version", className: "w-[14%]" },
  { key: "date", label: "Date", className: "w-[11%] min-w-[96px]" },
  { key: "age", label: "Age", className: "w-[7%] min-w-[64px]" },
  { key: "signature", label: "Signature", className: "w-[12%] min-w-[104px]" },
];

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

const PAGE_SIZES = [25, 50, 100];

export interface DriverTableProps {
  rows: DriverRow[];
  selectedKey: string | null;
  onSelect: (row: DriverRow) => void;
  loading?: boolean;
}

export function SignatureBadge({ driver }: { driver: DriverInfo }) {
  const kind = signatureKind(driver);
  const unsigned = kind === "unsigned";
  return (
    <span
      title={driver.signer || (unsigned ? "No digital signature" : "Signed")}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        unsigned ? "border-warn/45 bg-warn/10 text-warn" : "border-line bg-white/[0.04] text-silver",
      )}
    >
      {unsigned ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
      {kind === "microsoft" ? "MS signed" : signatureLabel(kind)}
    </span>
  );
}

const STATUS_RULE =
  "Problem = Windows reports a device error (Device Manager code other than 22 Disabled or 45 Not connected). Unsigned = no valid digital signature. Driver age never changes the status.";

/** Status pill for ok / unsigned / problem (MF-5). Codes 22 and 45 render as a neutral note, not a problem. */
export function DriverStatusBadge({ driver }: { driver: DriverInfo }) {
  if (driver.status === "problem") {
    return (
      <StatusPill tone="crit" title={`${problemText(driver.problemCode)}. ${STATUS_RULE}`}>
        Problem
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
      <span
        title={`${problemText(driver.problemCode)}. Not a fault.`}
        className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full border border-line bg-white/[0.04] px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400"
      >
        {driver.problemCode === 22 ? "Disabled" : "Not connected"}
      </span>
    );
  }
  return (
    <StatusPill tone="ok" title={`Signed and Windows reports no device problem. ${STATUS_RULE}`}>
      OK
    </StatusPill>
  );
}

export default function DriverTable({ rows: input, selectedKey, onSelect, loading }: DriverTableProps) {
  const [sortKey, setSortKey] = useState<DriverSortKey>("device");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    // Problems always first (MF-5), then the chosen column; tie-break on device name so pages stay stable.
    return [...input].sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (s !== 0) return s;
      const c = compareBy(sortKey, a.driver, b.driver) * dir;
      if (c !== 0) return c;
      return (a.driver.deviceName || "").localeCompare(b.driver.deviceName || "");
    });
  }, [input, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));

  useEffect(() => {
    setPage(0);
  }, [input, sortKey, sortDir, pageSize]);

  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const start = page * pageSize;
  const rows = sorted.slice(start, start + pageSize);

  const toggleSort = (key: DriverSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "asc");
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="nx-scroll max-h-[62vh] min-h-[240px] overflow-auto rounded-lg border border-line">
        <table className="w-full table-fixed border-collapse text-left text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-[rgba(9,17,20,0.96)] backdrop-blur">
            <tr className="border-b border-line">
              {COLUMNS.map((c) => {
                const active = c.key === sortKey;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    className={cn("px-3 py-2.5 font-medium", c.className)}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn(
                        "inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] uppercase tracking-[0.14em] transition",
                        active ? "text-ink" : "text-muted hover:text-silver",
                      )}
                    >
                      {c.label}
                      {active ? (
                        sortDir === "asc" ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        )
                      ) : (
                        <ChevronsUpDown size={11} className="opacity-50" />
                      )}
                    </button>
                  </th>
                );
              })}
              <th
                scope="col"
                className="w-[118px] px-3 py-2.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted"
                title={STATUS_RULE}
              >
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-14 text-center text-muted">
                  {loading ? "Scanning device drivers…" : "No drivers match the current filters."}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const d = r.driver;
              const selected = r.key === selectedKey;
              const count = r.members.length;
              return (
                <tr
                  key={r.key}
                  tabIndex={0}
                  onClick={() => onSelect(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(r);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-line/60 outline-none transition-colors",
                    "hover:bg-white/[0.035] focus-visible:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_1px_rgba(45,212,191,0.65)]",
                    selected && "bg-white/[0.06] shadow-[inset_2px_0_0_var(--color-teal)]",
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate font-medium text-ink" title={d.deviceName}>
                        {d.deviceName || "Unknown device"}
                      </span>
                      {count > 1 && (
                        <span className="shrink-0 font-mono text-[11px] text-silver" title={`${count} identical devices`}>
                          × {count}
                        </span>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                      <span className="truncate" title={d.deviceClass}>
                        {d.deviceClass || "—"}
                      </span>
                      {d.isInbox && (
                        <span
                          className="shrink-0 rounded border border-line px-1 text-[9px] font-semibold uppercase tracking-wider text-slate-400"
                          title="In-box driver: ships with Windows"
                        >
                          In-box
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="truncate px-3 py-2 text-silver max-[1439px]:hidden">{d.category}</td>
                  <td className="truncate px-3 py-2 text-silver" title={d.provider}>
                    {d.provider || "—"}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-[12px] text-ink" title={d.version}>
                    {d.version || "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-ink">{d.date || "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[11.5px] text-muted">{fmtAge(d.ageDays)}</td>
                  <td className="px-3 py-2">
                    <SignatureBadge driver={d} />
                  </td>
                  <td className="px-3 py-2">
                    <DriverStatusBadge driver={d} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
        <div className="font-mono">
          {sorted.length === 0 ? "0 rows" : `${start + 1}–${Math.min(start + pageSize, sorted.length)} of ${sorted.length}`}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-[10.5px] uppercase tracking-wider">Rows</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-line bg-canvas-0/80 px-2 py-1 font-mono text-ink outline-none focus:border-teal/50"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1">
            <PagerBtn label="First page" disabled={page === 0} onClick={() => setPage(0)}>
              <ChevronsLeft size={14} />
            </PagerBtn>
            <PagerBtn label="Previous page" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft size={14} />
            </PagerBtn>
            <span className="min-w-[72px] text-center font-mono text-ink">
              {page + 1} / {pageCount}
            </span>
            <PagerBtn
              label="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              <ChevronRight size={14} />
            </PagerBtn>
            <PagerBtn label="Last page" disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)}>
              <ChevronsRight size={14} />
            </PagerBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function PagerBtn({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-line bg-white/[0.03] p-1.5 text-silver transition hover:border-white/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-line disabled:hover:text-silver"
    >
      {children}
    </button>
  );
}
