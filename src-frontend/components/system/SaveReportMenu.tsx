import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, FileDown, FileText, Globe } from "lucide-react";
import type { ReportFormat } from "../../types";
import { api, errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button } from "../ui/Button";
import { toast } from "../feedback/Toast";
import { dirnameOf } from "../cleaner/cleanerCopy";

const ITEMS: ReadonlyArray<{ format: ReportFormat; label: string; icon: typeof FileText; hint: string }> = [
  { format: "txt", label: "Text (.txt)", icon: FileText, hint: "Plain text, easy to paste into a forum post" },
  { format: "html", label: "Web page (.html)", icon: Globe, hint: "Formatted page that prints well" },
];

/**
 * "Save report" menu of the System view (CONTRACT §2.12, §4.10.2). Rust writes the file to
 * Documents\Nexum\Reports (no hostname, user name or serial numbers); the toast shows the path and an
 * Open folder action.
 */
export function SaveReportMenu({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<ReportFormat | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    itemRefs.current[0]?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const openFolder = (path: string) => {
    api.openExternal(dirnameOf(path)).catch((e: unknown) => toast(`Could not open the folder: ${errorMessage(e)}`, "warn"));
  };

  const save = async (format: ReportFormat) => {
    setOpen(false);
    setSaving(format);
    try {
      const path = await api.saveReport(format);
      setLastPath(path);
      toast(`Saved to ${path}`, "ok", { action: { label: "Open folder", onClick: () => openFolder(path) } });
    } catch (e) {
      toast(`Could not save the report: ${errorMessage(e)}`, "crit");
    } finally {
      setSaving(null);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = itemRefs.current.findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = ITEMS.length;
      const next = ((i < 0 ? 0 : i) + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      itemRefs.current[next]?.focus();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="sm"
        variant="ghost"
        icon={FileDown}
        iconRight={<ChevronDown size={13} aria-hidden="true" />}
        loading={saving !== null}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={lastPath ? `Save the System details as a file. Last saved: ${lastPath}` : "Save the System details as a file"}
      >
        Save report
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Report format"
          onKeyDown={onMenuKey}
          className="glass-strong absolute right-0 top-[calc(100%+6px)] z-40 w-[230px] border border-line p-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
        >
          {ITEMS.map((it, i) => {
            const Icon = it.icon;
            return (
              <button
                key={it.format}
                ref={(n) => {
                  itemRefs.current[i] = n;
                }}
                type="button"
                role="menuitem"
                onClick={() => void save(it.format)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition",
                  "hover:bg-white/[0.06] focus-visible:bg-white/[0.06]",
                )}
              >
                <Icon size={14} className="mt-[2px] shrink-0 text-silver" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-semibold text-ink">{it.label}</span>
                  <span className="block text-[11px] leading-snug text-muted">{it.hint}</span>
                </span>
              </button>
            );
          })}
          <p className="border-t border-line px-2.5 pb-1 pt-1.5 text-[10.5px] leading-snug text-slate-500">
            Saved to Documents\Nexum\Reports. No PC name, user name or serial numbers.
          </p>
        </div>
      )}
    </div>
  );
}

export default SaveReportMenu;
