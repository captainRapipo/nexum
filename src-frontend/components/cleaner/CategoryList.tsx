import { useState } from "react";
import {
  Archive,
  Bug,
  ChevronRight,
  Cpu,
  ExternalLink,
  FileWarning,
  Folder,
  Globe,
  Info,
  Lock,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import { RECYCLE_AGE_OPTIONS, type TrashCategory, type TrashCategoryId } from "../../types";
import { Segmented, Toggle } from "../ui";
import { cn } from "../../lib/format";
import { fmtIn, listUnit, type ByteUnit } from "./cleanerCopy";
import CategoryDetails from "./CategoryDetails";

/** Segmented has no null value; 0 stands for "All" (null) in the control only. */
const RECYCLE_AGE_SEGMENTS = RECYCLE_AGE_OPTIONS.map((d) => ({
  value: d ?? 0,
  label: d == null ? "All" : d === 1 ? "1 day" : `${d} days`,
  title:
    d == null
      ? "Everything in the Recycle Bin"
      : `Only items that have been in the Recycle Bin for more than ${d === 1 ? "1 day" : `${d} days`}`,
}));

export interface RecycleAgeControl {
  /** Settings.recycleMinAgeDays (null = every item). */
  value: number | null;
  onChange: (days: number | null) => void;
  disabled?: boolean;
}

export interface CategoryDetailsControl {
  /** The age filter the list was measured with (passed to scan_trash_details). */
  recycleMinAgeDays: number | null;
  /** Changes on every re-measure so open lists refresh with it. */
  scanStamp: number;
}

const ICONS: Record<TrashCategoryId, typeof Folder> = {
  temp: Folder,
  "wu-cache": RefreshCcw,
  logs: FileWarning,
  dumps: Bug,
  "memory-dump": Archive,
  shader: Cpu,
  recycle: Trash2,
  browser: Globe,
};

export interface CategoryListProps {
  categories: TrashCategory[];
  selected: Set<TrashCategoryId>;
  onToggle: (id: TrashCategoryId, on: boolean) => void;
  disabled?: boolean;
  /** Tighter rows for the modal. */
  compact?: boolean;
  /** Unit shared by the whole list (one unit per list); derived from the categories when omitted. */
  unit?: ByteUnit;
  /** Extra UI notes rendered under a category (e.g. "bound to Settings"). Backend notes come from `note`. */
  extraNotes?: Partial<Record<TrashCategoryId, string>>;
  /** Shown next to the crash-dump categories: opens Windows Reliability Monitor. */
  onOpenReliabilityMonitor?: () => void;
  /** [1.1] Recycle Bin age filter control, rendered in the Recycle Bin row (Cleaner page only). */
  recycleAge?: RecycleAgeControl;
  /** [1.1] Enables the per-category "Show files" drill-down (Cleaner page only). */
  details?: CategoryDetailsControl;
}

function Badge({ children, title }: { children: string; title?: string }) {
  return (
    <span
      title={title}
      className="rounded border border-line bg-white/5 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-slate-400"
    >
      {children}
    </span>
  );
}

/** Measured cache categories with selection toggles, sizes, file counts and skip notes (MF-4). */
export default function CategoryList({
  categories,
  selected,
  onToggle,
  disabled,
  compact,
  unit: unitProp,
  extraNotes,
  onOpenReliabilityMonitor,
  recycleAge,
  details,
}: CategoryListProps) {
  const unit = unitProp ?? listUnit(categories);
  const [openIds, setOpenIds] = useState<ReadonlySet<TrashCategoryId>>(() => new Set());
  const toggleOpen = (id: TrashCategoryId) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const maxBytes = Math.max(1, ...categories.map((c) => (c.available === false ? 0 : c.bytes || 0)));

  return (
    <ul className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
      {categories.map((c) => {
        const available = c.available !== false;
        const on = available && selected.has(c.id);
        const Icon = ICONS[c.id] ?? Folder;
        const share = available ? ((c.bytes || 0) / maxBytes) * 100 : 0;
        const isDump = c.id === "dumps" || c.id === "memory-dump";
        const extra = extraNotes?.[c.id];
        const canDrill = !!details && available && ((c.files || 0) > 0 || (c.bytes || 0) > 0);
        const open = canDrill && openIds.has(c.id);
        const detailsId = `nx-clean-details-${c.id}`;

        return (
          <li
            key={c.id}
            className={cn(
              "group relative overflow-hidden rounded-xl border transition-colors",
              compact ? "px-3 py-2.5" : "px-4 py-3",
              on ? "border-teal/30 bg-teal/[0.04]" : "border-line bg-white/[0.015]",
              !available && "opacity-75",
            )}
          >
            {/* Share-of-total bar; hidden while the file list is open so it does not run behind it. */}
            {available && !open && (
              <span
                aria-hidden
                className={cn("absolute inset-y-0 left-0 transition-[width] duration-500", on ? "bg-teal/[0.06]" : "bg-white/[0.02]")}
                style={{ width: `${share}%` }}
              />
            )}
            <div className="relative flex items-center gap-3">
              <span
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-lg border",
                  compact ? "h-8 w-8" : "h-9 w-9",
                  on ? "border-teal/45 text-teal" : "border-line text-muted",
                )}
              >
                <Icon size={compact ? 15 : 16} />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("text-[13px] font-semibold", on ? "text-ink" : "text-silver")}>{c.label}</span>
                  {c.optional && <Badge title="Off by default; never run by the F9 quick path">Optional</Badge>}
                  {c.requiresAdmin && available && <Badge>Admin</Badge>}
                  {!available && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] text-slate-400">
                      <Lock size={10} aria-hidden="true" />
                      Needs administrator
                    </span>
                  )}
                </div>
                {!compact && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{c.description}</div>}
                {compact && (
                  <div className="truncate text-[11px] text-muted" title={c.description}>
                    {c.description}
                  </div>
                )}
                {c.note && (available || !/administrator/i.test(c.note)) && (
                  <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-cyan">
                    <Info size={11} className="mt-[2px] shrink-0" aria-hidden="true" />
                    <span>{c.note}</span>
                  </div>
                )}
                {extra && <div className="mt-0.5 text-[10.5px] text-slate-400">{extra}</div>}
                {isDump && onOpenReliabilityMonitor && c.id === "dumps" && (
                  <button
                    type="button"
                    onClick={onOpenReliabilityMonitor}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-silver underline decoration-white/20 underline-offset-2 transition hover:text-ink"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                    Open Reliability Monitor
                  </button>
                )}
                {c.id === "recycle" && recycleAge && !compact && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-slate-400" id="nx-recycle-age-label">
                      Items older than
                    </span>
                    <Segmented
                      value={recycleAge.value ?? 0}
                      options={RECYCLE_AGE_SEGMENTS}
                      onChange={(v) => recycleAge.onChange(v === 0 ? null : v)}
                      size="sm"
                      ariaLabel="Recycle Bin: only items older than"
                      disabled={recycleAge.disabled || !available}
                    />
                  </div>
                )}
                {canDrill && (
                  <button
                    type="button"
                    onClick={() => toggleOpen(c.id)}
                    aria-expanded={open}
                    aria-controls={detailsId}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-silver transition hover:text-ink"
                  >
                    <ChevronRight
                      size={12}
                      aria-hidden="true"
                      className={cn("transition-transform duration-150", open && "rotate-90")}
                    />
                    {open ? "Hide files" : "Show files"}
                  </button>
                )}
              </div>

              <div className="shrink-0 text-right">
                <div
                  className={cn("font-mono text-[14px] font-semibold", on ? "text-ink" : "text-silver", !available && "text-muted")}
                  title={!available ? "Estimate: read without administrator rights" : undefined}
                >
                  {fmtIn(c.bytes || 0, unit)}
                </div>
                <div className="font-mono text-[10.5px] text-muted">
                  {!available ? "estimate" : `${(c.files || 0).toLocaleString("en-US")} ${c.files === 1 ? "file" : "files"}`}
                </div>
              </div>

              <div className="shrink-0 pl-1">
                <Toggle
                  checked={on}
                  disabled={disabled || !available}
                  ariaLabel={available ? `Include ${c.label}` : `${c.label}: needs administrator`}
                  onChange={(v: boolean) => onToggle(c.id, v)}
                />
              </div>
            </div>
            {open && details && (
              <div id={detailsId} className="relative mt-2 border-t border-line pt-1.5 pl-12">
                <CategoryDetails
                  categoryId={c.id}
                  recycleMinAgeDays={details.recycleMinAgeDays}
                  scanStamp={details.scanStamp}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
