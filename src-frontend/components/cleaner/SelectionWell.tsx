import { Lock } from "lucide-react";
import type { TrashCategory, TrashCategoryId } from "../../types";
import { cn } from "../../lib/format";
import { Toggle } from "../ui";
import { CATEGORY_ICONS } from "./CategoryList";
import { fmtFiles, fmtIn, type ByteUnit } from "./cleanerCopy";

export interface SelectionWellProps {
  /** Rows, in list order. */
  categories: readonly TrashCategory[];
  /** One unit for the whole well, the same as the dialog's headline number. */
  unit: ByteUnit;
  /** Total of what will be cleaned (the last row). */
  totalFiles: number;
  totalBytes: number;
  /** With `selected` + `onToggle` every row gets a switch (the F9 dialog); without, the rows are a read-only list. */
  selected?: ReadonlySet<TrashCategoryId>;
  onToggle?: (id: TrashCategoryId, on: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Summary well of the cleanup confirmation (SPEC §18): one 32 px row per category with its file
 * count and size, then the total. A skip note sits under its category.
 */
export default function SelectionWell({ categories, unit, totalFiles, totalBytes, selected, onToggle, disabled, className }: SelectionWellProps) {
  const editable = selected != null && onToggle != null;
  const cols = editable ? "grid-cols-[18px_minmax(0,1fr)_auto_64px_32px]" : "grid-cols-[18px_minmax(0,1fr)_auto_64px]";
  return (
    <div className={cn("tnum rounded-lg bg-inset px-3 py-1 text-body text-ink", className)}>
      {categories.map((c) => {
        const available = c.available !== false;
        const on = !editable || (available && selected.has(c.id));
        const Icon = CATEGORY_ICONS[c.id];
        const note = c.note && (available || !/administrator/i.test(c.note)) ? c.note : null;
        return (
          <div key={c.id} className={cn("grid min-h-8 items-center gap-x-2.5 border-b border-divider py-1", cols)}>
            <Icon size={14} strokeWidth={1.75} className="text-icon-2" aria-hidden="true" />
            <span className={cn("min-w-0 truncate", !on && "text-ink-2")} title={c.description}>
              {c.label}
            </span>
            <span className="text-callout text-ink-3">
              {available ? (
                fmtFiles(c.files || 0)
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Lock size={12} aria-hidden="true" />
                  Needs administrator
                </span>
              )}
            </span>
            <span
              className={cn("text-right", on ? "font-semibold" : "text-ink-2")}
              title={!available ? "Estimate: read without administrator rights" : undefined}
            >
              {fmtIn(c.bytes || 0, unit)}
            </span>
            {editable && (
              <Toggle
                checked={on}
                disabled={disabled || !available}
                ariaLabel={available ? `Include ${c.label}` : `${c.label}: needs administrator`}
                onChange={(v: boolean) => onToggle(c.id, v)}
              />
            )}
            {note && <span className="col-span-full col-start-2 pb-0.5 text-callout text-ink-2">{note}</span>}
          </div>
        );
      })}
      <div className={cn("grid h-8 items-center gap-x-2.5 font-semibold", cols)}>
        <span />
        <span>Total</span>
        <span className="text-callout font-normal text-ink-3">{fmtFiles(totalFiles)}</span>
        <span className="text-right">{fmtIn(totalBytes, unit)}</span>
        {editable && <span />}
      </div>
    </div>
  );
}
