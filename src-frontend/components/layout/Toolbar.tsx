// Toolbar (CONTRACT §4.6.1, docs/design/SPEC.md §1, §4): title block (tight mode and list pages), the
// rule-backed health pill with its click-open condition list, the freshness text, the quiet update
// indicator, the page's filter field, Rescan and Settings.
// The window keeps its native title bar: no caption buttons, no drag region, no window API calls.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDownToLine, ChevronRight, RotateCw, Search } from "lucide-react";
import {
  HEALTH_THRESHOLDS,
  PAGE_KIND,
  SEARCH_HOTKEY_LABEL,
  UPDATE_TEXT,
  VIEW_TITLES,
  type HealthCondition,
  type SystemHealth,
  type ViewId,
} from "../../types";
import { errorMessage } from "../../lib/api";
import { cn, fmtClock } from "../../lib/format";
import { alertState, healthLevelTone, healthPillTitle, runHealthAction } from "../../lib/status";
import { useHealth } from "../../hooks/useHealth";
import { useHealthAlerts } from "../../hooks/useHealthAlerts";
import { useNow } from "../../hooks/useNow";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useTightMode } from "../../hooks/useTightMode";
import { updateOnOffer, useUpdater } from "../../hooks/useUpdater";
import { toast } from "../feedback/Toast";
import { Button, IconButton, StatusIcon, StatusPill, TextField } from "../ui";
import { usePageChromeValue, type PageSearch } from "./PageChrome";

export interface ToolbarProps {
  view: ViewId;
  /** May return a promise; the Rescan icon spins until it settles. */
  onRefresh: () => void | Promise<unknown>;
  onSettings: () => void;
  /** Opens the update dialog (the indicator is shown only while an update is on offer). */
  onOpenUpdate: () => void;
  /** External busy flag (e.g. a scan started with F5). */
  refreshing?: boolean;
}

/** DOM id of the filter field; App focuses it on Ctrl+K. */
export const TOOLBAR_FILTER_ID = "nexum-toolbar-filter";

/** Focus the toolbar filter field if the active page has one. Returns false when there is none. */
export function focusToolbarFilter(): boolean {
  const el = document.getElementById(TOOLBAR_FILTER_ID);
  if (!(el instanceof HTMLInputElement) || el.disabled) return false;
  el.focus();
  el.select();
  return true;
}

const ICON_STROKE = 1.75;
const MIN_SPIN_MS = 700;

/** Three sliders with knobs: the Settings glyph of the design package. */
function SlidersIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx={15} cy={6} r={2} />
      <circle cx={9} cy={12} r={2} />
      <circle cx={17} cy={18} r={2} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Health pill + condition list                                        */
/* ------------------------------------------------------------------ */

function conditionsHeading(health: SystemHealth): string {
  const n = health.conditions.length;
  if (n === 0) return health.level === "checking" ? "Checking" : "No active conditions";
  return n === 1 ? "1 active condition" : `${n} active conditions`;
}

function ConditionRow({ c, onDone }: { c: HealthCondition; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const action = c.action;
  const run = async () => {
    if (!action) return;
    const isNav = "nav" in action;
    setBusy(true);
    try {
      await runHealthAction(action);
      if (isNav) onDone();
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 border-t border-divider py-2" title={c.rule}>
      <StatusIcon tone={alertState(c.severity)} size={16} className="mt-px" />
      <span className="min-w-0 text-headline text-ink">{c.title}</span>
      {action ? (
        <Button size="sm" loading={busy} onClick={() => void run()}>
          {action.label}
        </Button>
      ) : (
        <span />
      )}
      {c.detail && <p className="col-span-2 col-start-2 text-callout text-ink-2">{c.detail}</p>}
    </li>
  );
}

function HealthPill() {
  const health = useHealth();
  const { snapshot } = useHealthAlerts();
  const [open, setOpen] = useState(false);
  /** The rule list is reference material: open by default only when there is no condition to show. */
  const [rulesToggled, setRulesToggled] = useState<boolean | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) wrapRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      setRulesToggled(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  const n = health.conditions.length;
  const evaluated = snapshot.evaluatedTs;
  const showRules = rulesToggled ?? n === 0;

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <StatusPill
        size="pill"
        tone={healthLevelTone(health.level)}
        summary={health.summary}
        expanded={open}
        onClick={() => setOpen((v) => !v)}
        // The native hover text lists the conditions and the rules; the open list already shows them.
        title={open ? undefined : healthPillTitle(health)}
      >
        {health.label}
      </StatusPill>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="System status"
          className="absolute top-[calc(100%+8px)] left-0 z-50 flex max-h-[calc(100vh-140px)] w-[440px] max-w-[calc(100vw-var(--sidebar-w)-48px)] animate-fade-in flex-col rounded-[12px] bg-white px-3.5 py-3 shadow-popover"
        >
          <div className="mb-2 flex shrink-0 items-baseline justify-between gap-3">
            <h2 className="text-headline text-ink">{conditionsHeading(health)}</h2>
            {evaluated != null && <span className="tnum text-callout text-ink-3">evaluated {fmtClock(evaluated)}</span>}
          </div>
          {/* The negative margin keeps the buttons' outline rings inside the scroll box. */}
          <div className="-mx-3.5 min-h-0 overflow-y-auto px-3.5">
            {n > 0 ? (
              <ul>
                {health.conditions.map((c) => (
                  <ConditionRow key={c.id} c={c} onDone={() => close(false)} />
                ))}
              </ul>
            ) : (
              <p className="border-t border-divider py-2 text-callout text-ink-2">
                {health.level === "checking"
                  ? "Nexum is still reading this PC. The status appears as soon as the first values are in."
                  : "Every rule below is satisfied."}
              </p>
            )}
            <div className="border-t border-divider pt-2 text-callout text-ink-3">
              <button
                type="button"
                aria-expanded={showRules}
                onClick={() => setRulesToggled(!showRules)}
                className="-ml-0.5 flex items-center gap-1 rounded-xs pr-1 font-medium text-ink-2 hover:text-ink"
              >
                <ChevronRight size={13} aria-hidden="true" className={cn("transition-transform duration-(--dur-fast)", showRules && "rotate-90")} />
                How this status is decided
              </button>
              {showRules && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-[18px]">
                  {health.rules.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Freshness                                                           */
/* ------------------------------------------------------------------ */

/** 1000 → "1 Hz", 500 → "2 Hz", 250 → "4 Hz", 2000 and above → "every 2 s". */
function rateText(pollIntervalMs: number): string {
  const ms = pollIntervalMs > 0 ? pollIntervalMs : 1000;
  if (ms >= 2000) return `every ${Math.round(ms / 100) / 10} s`;
  return `${Math.round(10000 / ms) / 10} Hz`;
}

/** "Updated 1 s ago · 1 Hz". Renders nothing while there is nothing to say (no data yet, or stale data). */
function Freshness() {
  const { latest, agent } = useTelemetry();
  const { settings } = useSettings();
  const now = useNow(1000);
  // agent-status is not re-emitted for every packet: use the newest of the two timestamps.
  const lastTs = Math.max(agent?.lastPacketTs ?? 0, latest?.ts ?? 0);
  const poll = settings.pollIntervalMs > 0 ? settings.pollIntervalMs : 1000;
  const staleMs = Math.max(HEALTH_THRESHOLDS.staleMinMs, 3 * poll);
  if (!agent || !agent.running || lastTs <= 0 || now - lastTs > staleMs) return null;
  const n = Math.max(0, Math.round((now - lastTs) / 1000));
  return (
    <span className="tnum shrink-0 text-callout whitespace-nowrap text-ink-2 tight:hidden">
      Updated {n} s ago · {rateText(poll)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Update indicator                                                    */
/* ------------------------------------------------------------------ */

/** Quiet, graphite, no badge, no animation: an update never announces itself any louder (CONTRACT §2.15.7). */
function UpdateIndicator({ onOpen }: { onOpen: () => void }) {
  const { update } = useUpdater();
  const tight = useTightMode();
  if (!updateOnOffer(update)) return null;
  const title = update.latestVersion ? UPDATE_TEXT.indicatorTitle.replace("{v}", update.latestVersion) : UPDATE_TEXT.indicator;
  if (tight) return <IconButton icon={<ArrowDownToLine size={17} strokeWidth={ICON_STROKE} aria-hidden="true" />} label={title} onClick={onOpen} />;
  return (
    <Button variant="plain" size="sm" icon={ArrowDownToLine} title={title} aria-label={title} onClick={onOpen}>
      {UPDATE_TEXT.indicator}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Filter field                                                        */
/* ------------------------------------------------------------------ */

function FilterField({ search }: { search: PageSearch }) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    // Esc clears first; a second Esc (or Esc on an empty field) leaves the field.
    if (search.value !== "") search.onChange("");
    else e.currentTarget.blur();
  };
  return (
    <TextField
      id={TOOLBAR_FILTER_ID}
      value={search.value}
      onChange={search.onChange}
      placeholder={search.placeholder}
      aria-label={search.ariaLabel ?? search.placeholder}
      title={`${search.placeholder} (${SEARCH_HOTKEY_LABEL.replace(" ", "+")})`}
      icon={<Search size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
      kbd={SEARCH_HOTKEY_LABEL}
      spellCheck={false}
      autoComplete="off"
      onKeyDown={onKeyDown}
      className="w-[210px] shrink-0"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

export function Toolbar({ view, onRefresh, onSettings, onOpenUpdate, refreshing = false }: ToolbarProps) {
  const chrome = usePageChromeValue();
  const listPage = PAGE_KIND[view] === "list";

  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const handleRefresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const started = performance.now();
    try {
      await onRefresh();
    } catch (err) {
      console.warn("[nexum] refresh failed", err);
    } finally {
      const remaining = MIN_SPIN_MS - (performance.now() - started);
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      if (alive.current) setBusy(false);
    }
  }, [busy, onRefresh]);

  const spinning = busy || refreshing;

  return (
    <header className="relative z-30 flex h-(--toolbar-h) shrink-0 items-center gap-3 border-b border-hairline bg-toolbar pr-[calc(var(--page-pad-x)-7px)] pl-(--page-pad-x) select-none">
      {/* Title block: list pages always; grouped pages only in tight mode (their large title is in the page). */}
      <div className={cn("mr-1 min-w-0 flex-col justify-center", listPage ? "flex" : "hidden tight:flex")}>
        <h1 className="text-toolbar-title whitespace-nowrap text-ink">{VIEW_TITLES[view]}</h1>
        {chrome.subtitle ? (
          <p className="tnum mt-px max-w-[420px] truncate text-toolbar-sub text-ink-2" title={chrome.subtitle}>
            {chrome.subtitle}
          </p>
        ) : null}
      </div>

      <HealthPill />
      <Freshness />

      <span className="min-w-0 flex-1" />

      <UpdateIndicator onOpen={onOpenUpdate} />
      {chrome.search ? <FilterField search={chrome.search} /> : null}
      <IconButton
        icon={<RotateCw size={17} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        label="Rescan (F5)"
        spin={spinning}
        aria-busy={spinning || undefined}
        onClick={() => void handleRefresh()}
      />
      <IconButton icon={<SlidersIcon />} label="Settings" onClick={onSettings} />
    </header>
  );
}

export default Toolbar;
