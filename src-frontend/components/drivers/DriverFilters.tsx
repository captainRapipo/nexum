import { Search, X } from "lucide-react";
import type { DriverCategory } from "../../types";
import { cn } from "../../lib/format";
import { DRIVER_CATEGORIES, type DriverStatusFilter } from "./driverUtils";

export interface DriverFiltersProps {
  query: string;
  onQuery: (q: string) => void;
  category: DriverCategory | "all";
  onCategory: (c: DriverCategory | "all") => void;
  status: DriverStatusFilter;
  onStatus: (s: DriverStatusFilter) => void;
  categoryCounts: Record<string, number>;
  statusCounts: Record<DriverStatusFilter, number>;
  total: number;
}

const STATUS_OPTIONS: { id: DriverStatusFilter; label: string; tone: string }[] = [
  { id: "all", label: "All", tone: "text-silver" },
  { id: "ok", label: "OK", tone: "text-teal" },
  { id: "outdated", label: "Outdated", tone: "text-rose" },
  { id: "unsigned", label: "Unsigned", tone: "text-gold" },
];

export default function DriverFilters({
  query,
  onQuery,
  category,
  onCategory,
  status,
  onStatus,
  categoryCounts,
  statusCounts,
  total,
}: DriverFiltersProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative min-w-[260px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search device, provider, version, INF, hardware ID…"
            spellCheck={false}
            className="w-full rounded-lg border border-line bg-canvas-0/70 py-2 pl-9 pr-8 text-[13px] text-ink placeholder:text-muted/80 outline-none transition focus:border-gold/50 focus:shadow-[0_0_0_3px_rgba(212,163,89,0.12)]"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* Status segmented control */}
        <div role="radiogroup" aria-label="Driver status" className="flex rounded-lg border border-line bg-canvas-0/60 p-0.5">
          {STATUS_OPTIONS.map((o) => {
            const active = status === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onStatus(o.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition",
                  active ? "bg-white/[0.07] text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" : "text-muted hover:text-silver",
                )}
              >
                <span className={active ? o.tone : undefined}>{o.label}</span>
                <span className="font-mono text-[10.5px] text-muted">{statusCounts[o.id] ?? 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Category chips */}
      <div className="flex flex-wrap gap-1.5">
        <Chip active={category === "all"} onClick={() => onCategory("all")} label="All" count={total} />
        {DRIVER_CATEGORIES.map((c) => {
          const n = categoryCounts[c] ?? 0;
          if (n === 0 && category !== c) return null;
          return <Chip key={c} active={category === c} onClick={() => onCategory(c)} label={c} count={n} />;
        })}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] transition",
        active
          ? "border-gold/55 bg-gold/10 text-gold shadow-[0_0_12px_rgba(212,163,89,0.18)]"
          : "border-line bg-white/[0.02] text-silver hover:border-white/20 hover:text-ink",
      )}
    >
      {label}
      <span className={cn("font-mono text-[10.5px]", active ? "text-gold/80" : "text-muted")}>{count}</span>
    </button>
  );
}
