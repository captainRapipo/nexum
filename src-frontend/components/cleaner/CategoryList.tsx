import { useState } from "react";
import { Archive, Bug, ChevronRight, Cpu, FileWarning, Folder, Globe, Info, Lock, RefreshCcw, Trash2, type LucideIcon } from "lucide-react";
import { RECYCLE_AGE_OPTIONS, type TrashCategory, type TrashCategoryId } from "../../types";
import { InkLink, Segmented, Tag, Toggle } from "../ui";
import { cn } from "../../lib/format";
import { fmtFiles, fmtIn, listUnit, type ByteUnit } from "./cleanerCopy";
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

/** One icon per category, shared by the page list and the dialogs. */
export const CATEGORY_ICONS: Record<TrashCategoryId, LucideIcon> = {
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
  /** Unit shared by the whole list (one unit per list); derived from the categories when omitted. */
  unit?: ByteUnit;
  /** Extra UI notes rendered under a category (e.g. "bound to Settings"). Backend notes come from `note`. */
  extraNotes?: Partial<Record<TrashCategoryId, string>>;
  /** Shown next to the crash-dump category: opens Windows Reliability Monitor. */
  onOpenReliabilityMonitor?: () => void;
  /** [1.1] Recycle Bin age filter control, rendered in the Recycle Bin row. */
  recycleAge?: RecycleAgeControl;
  /** [1.1] Enables the per-category "Show files" drill-down. */
  details?: CategoryDetailsControl;
  className?: string;
}

/**
 * Measured cache categories of the Clean caches page (CONTRACT §4.10.3): one row per category with
 * its size and file count, neutral tags, skip notes, the "Show files" drill-down and a graphite switch.
 * Rows share the height of the card, so the list ends at the card's edge.
 */
export default function CategoryList({
  categories,
  selected,
  onToggle,
  disabled,
  unit: unitProp,
  extraNotes,
  onOpenReliabilityMonitor,
  recycleAge,
  details,
  className,
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

  return (
    <ul className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {categories.map((c) => {
        const available = c.available !== false;
        const on = available && selected.has(c.id);
        const Icon = CATEGORY_ICONS[c.id] ?? Folder;
        const extra = extraNotes?.[c.id];
        const canDrill = !!details && available && ((c.files || 0) > 0 || (c.bytes || 0) > 0);
        const open = canDrill && openIds.has(c.id);
        const detailsId = `nx-clean-details-${c.id}`;
        const showNote = !!c.note && (available || !/administrator/i.test(c.note));
        const showAge = c.id === "recycle" && !!recycleAge;
        const showFiles = canDrill && (
          <InkLink
            onClick={() => toggleOpen(c.id)}
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            chevron={false}
            className="shrink-0"
          >
            {open ? "Hide files" : "Show files"}
            <ChevronRight aria-hidden="true" className={cn("transition-transform duration-[140ms]", open && "rotate-90")} />
          </InkLink>
        );
        const showReliability = c.id === "dumps" && !!onOpenReliabilityMonitor;
        // "Show files" joins a line the row already has, so a row never grows just for the link.
        const linkLine: "age" | "note" | "links" | "desc" = showAge ? "age" : showNote ? "note" : showReliability ? "links" : "desc";

        return (
          <li
            key={c.id}
            className="grid flex-1 grid-cols-[34px_minmax(0,1fr)_auto_40px] content-center items-center gap-x-3.5 border-t border-divider px-(--card-pad-x) py-[11px]"
          >
            <span
              aria-hidden="true"
              className="grid size-[34px] place-items-center rounded-[9px] bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]"
            >
              <Icon size={16} strokeWidth={1.75} />
            </span>

            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium leading-[18px] text-ink">
                <span className="truncate">{c.label}</span>
                {c.requiresAdmin && available && <Tag title="Cleaned only while Nexum runs as administrator">Admin</Tag>}
                {c.optional && <Tag title="Off by default; never included by the F9 quick path">Optional</Tag>}
                {!available && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-callout font-normal text-ink-3">
                    <Lock size={12} aria-hidden="true" />
                    Needs administrator
                  </span>
                )}
              </div>
              <div className="mt-px flex min-w-0 items-center gap-2.5">
                <span className="min-w-0 truncate text-callout text-ink-2" title={c.description}>
                  {c.description}
                </span>
                {linkLine === "desc" && showFiles}
              </div>
              {showNote && (
                <div className="mt-[5px] flex min-w-0 items-center gap-1.5 text-callout text-ink-2">
                  <Info size={13} className="shrink-0 text-info-icon" aria-hidden="true" />
                  <span className="min-w-0 truncate" title={c.note ?? undefined}>
                    {c.note}
                  </span>
                  {linkLine === "note" && <span className="ml-1 shrink-0">{showFiles}</span>}
                </div>
              )}
              {extra && <div className="mt-0.5 truncate text-callout text-ink-3">{extra}</div>}
              {showReliability && (
                <div className="mt-1 flex items-center gap-3.5">
                  <InkLink onClick={onOpenReliabilityMonitor}>Open Reliability Monitor</InkLink>
                  {linkLine === "links" && showFiles}
                </div>
              )}
              {showAge && recycleAge && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-callout text-ink-2">
                  <span>Older than</span>
                  <Segmented
                    value={recycleAge.value ?? 0}
                    options={RECYCLE_AGE_SEGMENTS}
                    onChange={(v) => recycleAge.onChange(v === 0 ? null : v)}
                    size="sm"
                    ariaLabel="Recycle Bin: only items older than"
                    disabled={recycleAge.disabled || !available}
                  />
                  {linkLine === "age" && <span className="ml-1.5">{showFiles}</span>}
                </div>
              )}
            </div>

            <div className="tnum whitespace-nowrap text-right">
              <b
                className={cn("block text-[13px] leading-[18px]", on ? "font-semibold text-ink" : "font-medium text-ink-2")}
                title={!available ? "Estimate: read without administrator rights" : undefined}
              >
                {fmtIn(c.bytes || 0, unit)}
              </b>
              <span className="text-callout text-ink-3">{!available ? "estimate" : fmtFiles(c.files || 0)}</span>
            </div>

            <div className="flex justify-end">
              <Toggle
                checked={on}
                disabled={disabled || !available}
                ariaLabel={available ? `Include ${c.label}` : `${c.label}: needs administrator`}
                onChange={(v: boolean) => onToggle(c.id, v)}
              />
            </div>

            {open && details && (
              <div id={detailsId} className="col-span-full mt-2.5 pl-12">
                <CategoryDetails categoryId={c.id} recycleMinAgeDays={details.recycleMinAgeDays} scanStamp={details.scanStamp} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
