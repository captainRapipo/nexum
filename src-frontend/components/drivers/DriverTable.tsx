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
  driverKey,
  fmtAge,
  signatureKind,
  signatureLabel,
  type SignatureKind,
} from "./driverUtils";

export type DriverSortKey = "device" | "category" | "provider" | "version" | "date" | "signature" | "inf";

interface Column {
  key: DriverSortKey;
  label: string;
  className: string;
}

const COLUMNS: Column[] = [
  { key: "device", label: "Device", className: "w-[30%] min-w-[220px]" },
  { key: "category", label: "Category", className: "w-[9%]" },
  { key: "provider", label: "Provider", className: "w-[14%]" },
  { key: "version", label: "Version", className: "w-[13%]" },
  { key: "date", label: "Date", className: "w-[11%]" },
  { key: "signature", label: "Signature", className: "w-[12%]" },
  { key: "inf", label: "INF", className: "w-[11%]" },
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
    case "signature":
      return SIG_RANK[signatureKind(a)] - SIG_RANK[signatureKind(b)];
    case "inf":
      return (a.infName || "").localeCompare(b.infName || "", undefined, { numeric: true });
  }
}

const PAGE_SIZES = [25, 50, 100];

export interface DriverTableProps {
  drivers: DriverInfo[];
  selectedKey: string | null;
  onSelect: (d: DriverInfo) => void;
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
        unsigned
          ? "border-gold/40 bg-gold/10 text-gold"
          : kind === "whql"
            ? "border-teal/35 bg-teal/10 text-teal"
            : "border-cyan/30 bg-cyan/10 text-cyan",
      )}
    >
      {unsigned ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
      {kind === "microsoft" ? "MS signed" : signatureLabel(kind)}
    </span>
  );
}

export function DriverStatusBadge({ driver }: { driver: DriverInfo }) {
  // START.md §2.1: rose marks outdated drivers; unsigned is a gold warning (matches the dashboard list).
  if (driver.status === "unsigned") return <StatusPill tone="warn">Unsigned</StatusPill>;
  if (driver.status === "outdated") return <StatusPill tone="crit">Outdated</StatusPill>;
  return <StatusPill tone="ok">OK</StatusPill>;
}

export default function DriverTable({ drivers, selectedKey, onSelect, loading }: DriverTableProps) {
  const [sortKey, setSortKey] = useState<DriverSortKey>("device");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    // Stable sort: tie-break on device name so pages don't reshuffle on refresh.
    return [...drivers].sort((a, b) => {
      const c = compareBy(sortKey, a, b) * dir;
      if (c !== 0) return c;
      return (a.deviceName || "").localeCompare(b.deviceName || "");
    });
  }, [drivers, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));

  // Reset to the first page whenever the filtered set or ordering changes.
  useEffect(() => {
    setPage(0);
  }, [drivers, sortKey, sortDir, pageSize]);

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
                        "inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.14em] transition",
                        active ? "text-gold" : "text-muted hover:text-silver",
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
              <th scope="col" className="w-[84px] px-3 py-2.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
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
            {rows.map((d) => {
              const key = driverKey(d);
              const selected = key === selectedKey;
              return (
                <tr
                  key={key}
                  tabIndex={0}
                  onClick={() => onSelect(d)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(d);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-line/60 outline-none transition-colors",
                    "hover:bg-white/[0.035] focus-visible:bg-white/[0.05] focus-visible:shadow-[inset_0_0_0_1px_rgba(45,212,191,0.65)]",
                    selected && "bg-gold/[0.07] shadow-[inset_2px_0_0_var(--color-gold)]",
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="truncate font-medium text-ink" title={d.deviceName}>
                      {d.deviceName || "Unknown device"}
                    </div>
                    <div className="truncate text-[11px] text-muted" title={d.deviceClass}>
                      {d.deviceClass || "—"}
                    </div>
                  </td>
                  <td className="truncate px-3 py-2 text-silver">{d.category}</td>
                  <td className="truncate px-3 py-2 text-silver" title={d.provider}>
                    {d.provider || "—"}
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-[12px] text-ink" title={d.version}>
                    {d.version || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div
                      className={cn(
                        "font-mono text-[12px]",
                        d.status === "outdated" ? "text-rose" : "text-ink",
                      )}
                    >
                      {d.date || "—"}
                    </div>
                    <div className="font-mono text-[10.5px] text-muted">{fmtAge(d.ageDays)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <SignatureBadge driver={d} />
                  </td>
                  <td className="truncate px-3 py-2 font-mono text-[11.5px] text-muted" title={d.infName}>
                    {d.infName || "—"}
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
          {sorted.length === 0
            ? "0 rows"
            : `${start + 1}–${Math.min(start + pageSize, sorted.length)} of ${sorted.length}`}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="uppercase tracking-wider text-[10.5px]">Rows</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-line bg-canvas-0/80 px-2 py-1 font-mono text-ink outline-none focus:border-gold/50"
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
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-line bg-white/[0.03] p-1.5 text-silver transition hover:border-gold/40 hover:text-gold disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-line disabled:hover:text-silver"
    >
      {children}
    </button>
  );
}
