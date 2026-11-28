import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

  // Many categories do not fit a narrow window: the control then scrolls sideways (the arrow keys
  // reach every segment) and its cut edge fades, so it never looks like the list simply ends.
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
      setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [options.length]);

  // Keep the chosen segment in view (keyboard navigation, or a category picked while scrolled).
  useEffect(() => {
    scroller.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scope]);

  return (
    <div className="flex h-11 shrink-0 items-center gap-3.5 whitespace-nowrap border-b border-hairline bg-content px-(--page-pad-x)">
      <div
        ref={scroller}
        className={cn(
          "-my-1 min-w-0 shrink overflow-x-auto py-1 [scrollbar-width:none]",
          fade.right && !fade.left && "[mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]",
          fade.left && !fade.right && "[mask-image:linear-gradient(to_left,black_calc(100%-28px),transparent)]",
          fade.left && fade.right && "[mask-image:linear-gradient(to_right,transparent,black_28px,black_calc(100%-28px),transparent)]",
        )}
      >
        <Segmented value={scope} options={options} onChange={onScope} size="sm" ariaLabel="Drivers shown" />
      </div>
      <span className="shrink-0" title="Hides drivers that ship with Windows.">
        <Toggle checked={thirdPartyOnly} onChange={onThirdPartyOnly} label="Third-party only" />
      </span>

      <span className="min-w-0 flex-1" />

      <ExportMenu exporting={exporting} onExport={onExport} disabled={!canExport} />
      <Button size="sm" icon={HardDriveDownload} onClick={onBackup} loading={backingUp} title={backupTitle}>
        {backingUp ? "Backing up…" : "Back up drivers"}
      </Button>
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

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (format: "json" | "csv") => {
    setOpen(false);
    onExport(format);
  };
  const item =
    "focus-inset flex h-7 w-full items-center rounded-sm px-2.5 text-left text-body text-ink hover:bg-hover active:bg-pressed";

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
          <button ref={first} type="button" role="menuitem" className={item} onClick={() => pick("csv")}>
            Spreadsheet (.csv)
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => pick("json")}>
            JSON (.json)
          </button>
        </div>
      )}
    </div>
  );
}
