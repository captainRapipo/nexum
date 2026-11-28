import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronDown, Download, HardDriveDownload } from "lucide-react";
import { Button, Segmented, Toggle, type SegmentedOption } from "../ui";
import { cn } from "../../lib/format";
import { DRIVER_CATEGORIES, type DriverScope } from "./driverUtils";

export interface DriverFiltersProps {
  /** One selection: everything, one status, or one category. */
  scope: DriverScope;
  onScope: (s: DriverScope) => void;
  /** Row counts per scope (after the text filter and "Third-party only"). */
  counts: Partial<Record<DriverScope, number>>;
  thirdPartyOnly: boolean;
  onThirdPartyOnly: (on: boolean) => void;
  exporting: "json" | "csv" | null;
  onExport: (format: "json" | "csv") => void;
  canExport: boolean;
  backingUp: boolean;
  onBackup: () => void;
  /** Hover text of the backup button (what it does, and the administrator note). */
  backupTitle: string;
}

const PROBLEM_RULE =
  "Devices for which Windows reports an error code (Device Manager), except 22 (disabled by you) and 45 (not connected).";
const UNSIGNED_RULE = "Drivers without a valid digital signature.";

/**
 * Filter bar of the Drivers list page (SPEC §3, CONTRACT §4.10.3): 44 px, white, hairline below.
 * One segmented control with counts (All, Problems, Unsigned when there are any, then each category
 * that has drivers), the "Third-party only" switch, and the two actions. The text filter lives in the
 * app toolbar (Ctrl+K).
 */
export default function DriverFilters({
  scope,
  onScope,
  counts,
  thirdPartyOnly,
  onThirdPartyOnly,
  exporting,
  onExport,
  canExport,
  backingUp,
  onBackup,
  backupTitle,
}: DriverFiltersProps) {
  const options = useMemo(() => {
    const out: SegmentedOption<DriverScope>[] = [
      { value: "all", label: "All", count: counts.all ?? 0, title: "Every driver" },
      { value: "st:problem", label: "Problems", count: counts["st:problem"] ?? 0, title: PROBLEM_RULE },
    ];
    const unsigned = counts["st:unsigned"] ?? 0;
    if (unsigned > 0 || scope === "st:unsigned") out.push({ value: "st:unsigned", label: "Unsigned", count: unsigned, title: UNSIGNED_RULE });
    for (const c of DRIVER_CATEGORIES) {
      const key: DriverScope = `cat:${c}`;
      const n = counts[key] ?? 0;
      if (n === 0 && scope !== key) continue;
      out.push({ value: key, label: c, count: n });
    }
    return out;
  }, [counts, scope]);

  // Many categories do not fit a narrow window (or the bar next to the open detail panel). The
  // segments that fit stay in the control; the rest move into a "More" menu, so every category is one
  // click away and nothing is cut mid-word. The chosen scope always stays in the control.
  const lead = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<number>(options.length);
  const selectedIndex = options.findIndex((o) => o.value === scope);

  useLayoutEffect(() => {
    const box = lead.current;
    const rule = ruler.current;
    if (!box || !rule) return;
    const measure = () => {
      const widths = Array.from(rule.querySelectorAll<HTMLElement>('[role="radio"]'), (b) => b.offsetWidth);
      const n = widths.length;
      const avail = box.clientWidth - (toggleRef.current?.offsetWidth ?? 0) - BAR_GAP;
      // Track padding 2 + 2, segments 2 px apart.
      const need = (idx: number[]) => 4 + idx.reduce((sum, i) => sum + widths[i], 0) + 2 * Math.max(0, idx.length - 1);
      const all = widths.map((_, i) => i);
      let next = n;
      if (need(all) > avail) {
        next = 1;
        for (let k = n - 1; k >= 1; k--) {
          if (need(visibleIndexes(n, k, selectedIndex)) + MORE_GAP + MORE_WIDTH <= avail) {
            next = k;
            break;
          }
        }
      }
      setFit((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(rule);
    return () => ro.disconnect();
  }, [options, selectedIndex]);

  const shown = visibleIndexes(options.length, Math.min(fit, options.length), selectedIndex);
  const visible = shown.map((i) => options[i]);
  const overflow = options.filter((_, i) => !shown.includes(i));

  return (
    <div className="flex h-11 shrink-0 items-center gap-3.5 whitespace-nowrap border-b border-hairline bg-content px-(--page-pad-x)">
      <div ref={lead} className="relative flex min-w-0 flex-1 items-center gap-3.5">
        {/* Invisible copy with every segment: the ruler the fit is measured against. */}
        <div ref={ruler} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden">
          <Segmented value={scope} options={options} onChange={noop} size="sm" />
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <Segmented value={scope} options={visible} onChange={onScope} size="sm" ariaLabel="Drivers shown" />
          {overflow.length > 0 && <MoreMenu options={overflow} onPick={onScope} />}
        </span>
        <span ref={toggleRef} className="shrink-0" title="Hides drivers that ship with Windows.">
          <Toggle checked={thirdPartyOnly} onChange={onThirdPartyOnly} label="Third-party only" />
        </span>
      </div>

      <ExportMenu exporting={exporting} onExport={onExport} disabled={!canExport} />
      <Button size="sm" icon={HardDriveDownload} onClick={onBackup} loading={backingUp} title={backupTitle}>
        {backingUp ? "Backing up…" : "Back up drivers"}
      </Button>
    </div>
  );
}

const noop = () => undefined;
/** Gap between the control and the switch (gap-3.5), between the control and "More", and the width kept for "More". */
const BAR_GAP = 14;
const MORE_GAP = 6;
const MORE_WIDTH = 68;

/** The first `count` segments, with the last slot given to the chosen one when it would otherwise be hidden. */
function visibleIndexes(total: number, count: number, selected: number): number[] {
  const n = Math.max(1, Math.min(count, total));
  const idx = Array.from({ length: n }, (_, i) => i);
  if (selected >= n && n >= 1) idx[n - 1] = selected;
  return idx;
}

const MENU_ITEM =
  "focus-inset flex h-7 w-full items-center rounded-sm px-2.5 text-left text-body text-ink hover:bg-hover active:bg-pressed";

/** Closes a menu on an outside press or on Esc. */
function useMenuDismiss(open: boolean, wrap: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, wrap, close]);
}

/** "More": the categories that do not fit the bar, each with its count. */
function MoreMenu({ options, onPick }: { options: SegmentedOption<DriverScope>[]; onPick: (s: DriverScope) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, wrap, close);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <Button
        size="sm"
        variant="plain"
        iconRight={ChevronDown}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${options.length} more ${options.length === 1 ? "category" : "categories"}`}
      >
        More
      </Button>
      {open && (
        <div role="menu" aria-label="More categories" className="absolute left-0 top-full z-30 mt-1.5 min-w-44 animate-fade-in rounded-lg bg-card p-1 shadow-popover">
          {options.map((o, i) => (
            <button
              key={String(o.value)}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              title={o.title}
              className={cn(MENU_ITEM, "tnum justify-between gap-6")}
              onClick={() => {
                setOpen(false);
                onPick(o.value);
              }}
            >
              <span>{o.label}</span>
              {o.count != null && <span className="text-ink-3">{o.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Export list": a small menu with the two file formats. */
function ExportMenu({
  exporting,
  onExport,
  disabled,
}: {
  exporting: "json" | "csv" | null;
  onExport: (format: "json" | "csv") => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, wrap, close);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);

  const pick = (format: "json" | "csv") => {
    setOpen(false);
    onExport(format);
  };
  return (
    <div ref={wrap} className="relative shrink-0">
      <Button
        size="sm"
        icon={Download}
        iconRight={ChevronDown}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        loading={exporting !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Save the driver list as a file"
      >
        {exporting ? "Exporting…" : "Export list"}
      </Button>
      {open && (
        <div role="menu" aria-label="Export list" className="absolute right-0 top-full z-30 mt-1.5 w-44 animate-fade-in rounded-lg bg-card p-1 shadow-popover">
          <button ref={first} type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick("csv")}>
            Spreadsheet (.csv)
          </button>
          <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick("json")}>
            JSON (.json)
          </button>
        </div>
      )}
    </div>
  );
}
