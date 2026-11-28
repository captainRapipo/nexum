// Page chrome (CONTRACT §4.6.1): how a view publishes its toolbar subtitle and filter field, and
// how a grouped page draws its large title.
//
//   usePageChrome({ subtitle, search })   every view calls it (values may change on every render)
//   <PageHeader view description actions />  first child of every GROUPED page (never on list pages)
//   usePageChromeValue()                  Toolbar only
//   <PageChromeProvider>                  App.tsx, around the Toolbar and <main>
//
// Without a provider usePageChrome() is a no-op, so views work in any shell.
// Created by the 1.2 foundation step so every view can build against it; owner: S (API frozen).
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { VIEW_TITLES, type ViewId } from "../../types";
import { cn } from "../../lib/format";
import { useTightMode } from "../../hooks/useTightMode";

/** A page's filter, shown as the toolbar field ("Filter sensors", "Filter drivers"). Ctrl+K focuses it. */
export interface PageSearch {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder, e.g. "Filter sensors". Also the accessible name unless `ariaLabel` is given. */
  placeholder: string;
  ariaLabel?: string;
}

export interface PageChrome {
  /**
   * Short live summary for the toolbar, under the title: "3 drives · 3 volumes", "Game.exe · 140 fps".
   * Shown in tight mode and on list pages. Max about 60 characters (the toolbar cuts it at 420 px).
   */
  subtitle?: string | null;
  /** Filter field of this page; null / omitted = the toolbar shows no field. */
  search?: PageSearch | null;
}

interface Store {
  get: () => PageChrome;
  set: (next: PageChrome) => void;
  subscribe: (cb: () => void) => () => void;
}

const EMPTY: PageChrome = { subtitle: null, search: null };

function createStore(): Store {
  let current: PageChrome = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      current = next;
      for (const l of listeners) l();
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

const PageChromeContext = createContext<Store | null>(null);

/** Mounted once by App.tsx around the Toolbar and the active view. */
export function PageChromeProvider({ children }: { children: ReactNode }) {
  const store = useMemo(createStore, []);
  return <PageChromeContext.Provider value={store}>{children}</PageChromeContext.Provider>;
}

/**
 * Publishes this view's toolbar subtitle and filter field. Call it unconditionally from the view
 * component; pass fresh values on every render. Cleared automatically when the view unmounts.
 */
export function usePageChrome(chrome: PageChrome): void {
  const store = useContext(PageChromeContext);
  const subtitle = chrome.subtitle ?? null;
  const search = chrome.search ?? null;
  const hasSearch = search != null;
  const value = search?.value ?? "";
  const placeholder = search?.placeholder ?? "";
  const ariaLabel = search?.ariaLabel;
  // The latest onChange is read through a ref, so a new callback identity does not republish.
  const onChangeRef = useRef(search?.onChange);
  onChangeRef.current = search?.onChange;

  useEffect(() => {
    if (!store) return;
    store.set({
      subtitle,
      search: hasSearch ? { value, placeholder, ariaLabel, onChange: (v) => onChangeRef.current?.(v) } : null,
    });
  }, [store, subtitle, hasSearch, value, placeholder, ariaLabel]);

  useEffect(() => {
    if (!store) return;
    return () => store.set(EMPTY);
  }, [store]);
}

const noopSubscribe = () => () => undefined;
const getEmpty = () => EMPTY;

/** Toolbar side: the chrome the active view published (EMPTY while none has). */
export function usePageChromeValue(): PageChrome {
  const store = useContext(PageChromeContext);
  return useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.get : getEmpty, getEmpty);
}

export interface PageHeaderProps {
  view: ViewId;
  /** One or two sentences under the large title (regular mode only). */
  description?: ReactNode;
  /** Page actions: right of the large title in regular mode. At most ONE of them may be primary. */
  actions?: ReactNode;
  /**
   * Tight mode: "row" (default) keeps the actions in a compact right-aligned row above the content;
   * "none" renders nothing because the view shows them in its first card header (use useTightMode()).
   */
  tightActions?: "row" | "none";
  className?: string;
}

/**
 * Large page title of a grouped page (SPEC §3): title 26/32 semibold, description, actions on the
 * title baseline. In tight mode the title lives in the toolbar, so only the actions row remains.
 * The title text is VIEW_TITLES[view]. List pages (Sensors, Drivers) never render this.
 */
export function PageHeader({ view, description, actions, tightActions = "row", className }: PageHeaderProps) {
  const tight = useTightMode();
  if (tight) {
    if (actions == null || tightActions === "none") return null;
    return <div className={cn("mb-3 flex shrink-0 items-center justify-end gap-2", className)}>{actions}</div>;
  }
  return (
    <header className={cn("mb-[18px] flex shrink-0 items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-title-1 text-ink">{VIEW_TITLES[view]}</h1>
        {description != null && <p className="mt-[3px] text-body text-ink-2">{description}</p>}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div>}
    </header>
  );
}
