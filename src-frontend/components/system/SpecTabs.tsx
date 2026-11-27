import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/format";
import { SPEC_TABS, type SpecTabId } from "./specModel";

export const tabDomId = (id: SpecTabId) => `nx-spec-tab-${id}`;
export const panelDomId = (id: SpecTabId) => `nx-spec-panel-${id}`;

/** CPU-Z style tab strip (role="tablist", arrow keys / Home / End). */
export function SpecTabs({ value, onChange }: { value: SpecTabId; onChange: (id: SpecTabId) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const go = (i: number) => {
    const n = SPEC_TABS.length;
    const idx = (i + n) % n;
    onChange(SPEC_TABS[idx].id);
    refs.current[idx]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(SPEC_TABS.length - 1);
    }
  };

  return (
    <div role="tablist" aria-label="System details" className="flex min-w-0 flex-wrap items-end gap-1 border-b border-line">
      {SPEC_TABS.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(n) => {
              refs.current[i] = n;
            }}
            id={tabDomId(t.id)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={panelDomId(t.id)}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative -mb-px h-9 shrink-0 whitespace-nowrap rounded-t-lg border border-b-0 px-4 text-[12.5px] font-semibold transition-colors",
              active
                ? "border-line bg-white/[0.04] text-ink"
                : "border-transparent text-slate-400 hover:bg-white/[0.03] hover:text-slate-200",
            )}
          >
            {t.label}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 top-0 h-[2px] rounded-full bg-teal shadow-[0_0_10px_1px_rgba(45,212,191,0.55)]"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default SpecTabs;
