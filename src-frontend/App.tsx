// App shell (CONTRACT §4.6, §4.6.1): Sidebar | Toolbar + app banners + the active view.
import {
  Component,
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { RotateCcw } from "lucide-react";
import { FKEY_MAP, PAGE_KIND, VIEW_ORDER, VIEW_TITLES, type NavRequest, type NavTarget, type ViewId } from "./types";
import { api, isTauri, subscribe } from "./lib/api";
import { cn } from "./lib/format";
import { isViewId, NAV_EVENT, parseNavPayload, RESCAN_EVENT, setPendingFocus } from "./lib/nav";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { SystemInfoProvider, useSystemInfo } from "./hooks/useSystemInfo";
import { DriverScanProvider, useDriverScan } from "./hooks/useDriverScan";
import { TelemetryProvider } from "./hooks/useTelemetryStream";
import { SensorsProvider, useSensorsActions } from "./hooks/useSensors";
import { SystemSpecProvider, useSystemSpecRefresh } from "./hooks/useSystemSpec";
import { HealthProvider } from "./hooks/useHealth";
import { FramesProvider } from "./hooks/useFrames";
import { UpdaterProvider } from "./hooks/useUpdater";
import { TraySensorSync } from "./hooks/useTraySensorSync";
import { Sidebar } from "./components/layout/Sidebar";
import { focusToolbarFilter, Toolbar } from "./components/layout/Toolbar";
import { AppBanners } from "./components/layout/AppBanners";
import { PageChromeProvider } from "./components/layout/PageChrome";
import { SettingsModal } from "./components/layout/SettingsModal";
import { UpdateDialog } from "./components/layout/UpdateDialog";
import { UpdatePrompt } from "./components/layout/UpdatePrompt";
import { Button, ProgressBar, StatusIcon } from "./components/ui";
import { isModalOpen } from "./components/ui/Modal";
import { ToastHost } from "./components/feedback/Toast";
import { PawnIoConsent } from "./components/feedback/PawnIoConsent";

/* ------------------------------------------------------------------ */
/* Lazy modules                                                        */
/* ------------------------------------------------------------------ */

/** Lazy component accepting either a default export or a same-named export. */
function lazyModule<P extends object>(loader: () => Promise<unknown>, exportName: string) {
  return lazy(async () => {
    const mod = (await loader()) as Record<string, unknown>;
    const C = (mod.default ?? mod[exportName]) as ComponentType<P> | undefined;
    if (!C) throw new Error(`${exportName}: module has no default export`);
    return { default: C };
  });
}

const viewLoaders: Record<ViewId, () => Promise<unknown>> = {
  dashboard: () => import("./views/DashboardView"),
  sensors: () => import("./views/SensorsView"),
  system: () => import("./views/SystemView"),
  storage: () => import("./views/StorageView"),
  cooling: () => import("./views/CoolingView"),
  drivers: () => import("./views/DriversView"),
  gaming: () => import("./views/GamingView"),
  cleaner: () => import("./views/CleanerView"),
};

const VIEWS: Record<ViewId, ComponentType<object>> = {
  dashboard: lazyModule(viewLoaders.dashboard, "DashboardView"),
  sensors: lazyModule(viewLoaders.sensors, "SensorsView"),
  system: lazyModule(viewLoaders.system, "SystemView"),
  storage: lazyModule(viewLoaders.storage, "StorageView"),
  cooling: lazyModule(viewLoaders.cooling, "CoolingView"),
  drivers: lazyModule(viewLoaders.drivers, "DriversView"),
  gaming: lazyModule(viewLoaders.gaming, "GamingView"),
  cleaner: lazyModule(viewLoaders.cleaner, "CleanerView"),
};

interface PurgeModalProps {
  open: boolean;
  onClose: () => void;
  autoStart?: boolean;
}

const purgeLoader = () => import("./components/cleaner/OneClickPurgeModal");
const OneClickPurgeModal = lazyModule<PurgeModalProps>(purgeLoader, "OneClickPurgeModal");

/* ------------------------------------------------------------------ */
/* Error boundary                                                      */
/* ------------------------------------------------------------------ */

interface BoundaryProps {
  label: string;
  children: ReactNode;
  /** Render nothing on error instead of the recovery card. */
  silent?: boolean;
}

class ModuleErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[nexum] ${this.props.label} crashed:`, error, info.componentStack);
  }

  componentDidUpdate(prev: BoundaryProps) {
    // Navigating to another module clears a previous fault.
    if (prev.label !== this.props.label && this.state.error) this.setState({ error: null });
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    return (
      <div className="flex min-h-[320px] flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[520px] rounded-card bg-card px-(--card-pad-x) py-(--card-pad-y) shadow-card" role="alert">
          <div className="flex items-center gap-2">
            <StatusIcon tone="warn" size={18} />
            <h2 className="text-title-2 text-ink">{this.props.label} stopped working</h2>
          </div>
          <p className="mt-2 text-body text-ink-2">This page ran into a problem. Sensor readings and the rest of Nexum keep running.</p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-inset p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2 select-text">
            {error.message || String(error)}
          </pre>
          <div className="mt-4 flex justify-end">
            <Button size="sm" icon={RotateCcw} onClick={this.reset}>
              Reload page
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function ViewLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-3" role="status" aria-live="polite">
      <ProgressBar value={null} indeterminate label={`Loading ${label}`} className="w-48" />
      <span className="text-callout text-ink-3">Loading {label}…</span>
    </div>
  );
}

/**
 * Deep links: `?view=sensors` opens a view directly (`fans` is accepted as an alias of `cooling`),
 * `&focus=<id>` hands a focus target to it, and `?clean=1` opens the cache-cleanup dialog.
 */
function readInitialRoute(): { view: ViewId; focus: string | null; clean: boolean } {
  try {
    const q = new URLSearchParams(window.location.search);
    const raw = q.get("view");
    const v = raw === "fans" ? "cooling" : raw;
    const c = q.get("clean");
    return {
      view: isViewId(v) ? v : "dashboard",
      focus: q.get("focus"),
      clean: c === "1" || c === "true",
    };
  } catch {
    return { view: "dashboard", focus: null, clean: false };
  }
}

interface CleanState {
  open: boolean;
  autoStart: boolean;
}

/** Focus is in a text field: global hotkeys must not act (Esc excepted). */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  return !!t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function Shell() {
  const [initial] = useState(readInitialRoute);
  const [view, setView] = useState<ViewId>(initial.view);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [clean, setClean] = useState<CleanState>({ open: initial.clean, autoStart: false });
  const [cleanMounted, setCleanMounted] = useState(initial.clean);

  const { settings } = useSettings();
  const { refresh: refreshSystem, loading: systemLoading } = useSystemInfo();
  const { rescan, loading: scanLoading } = useDriverScan();
  // Actions only: subscribing to useSensors() here would re-render the whole shell on every values packet.
  const { refreshTree } = useSensorsActions();
  const refreshSpec = useSystemSpecRefresh();

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const cleanOpenRef = useRef(clean.open);
  cleanOpenRef.current = clean.open;
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (initial.focus) setPendingFocus({ view: initial.view, focus: initial.focus });
  }, [initial]);

  const navigate = useCallback((next: ViewId) => {
    // Transition keeps the current view on screen while a lazy view loads.
    startTransition(() => setView(next));
  }, []);

  /** F5 / refresh button: inventory always; drivers / spec / tree / cleaner for the active view. */
  const rescanAll = useCallback(async () => {
    const v = viewRef.current;
    const jobs: Array<Promise<unknown>> = [refreshSystem()];
    if (v === "drivers") jobs.push(rescan());
    if (v === "sensors") jobs.push(refreshTree());
    if (v === "system") jobs.push(refreshSpec());
    // Views with their own scan (the Cleaner) listen via lib/nav onRescanRequest().
    window.dispatchEvent(new CustomEvent(RESCAN_EVENT, { detail: v }));
    await Promise.allSettled(jobs);
  }, [refreshSystem, rescan, refreshTree, refreshSpec]);

  const openClean = useCallback((viaHotkey: boolean) => {
    if (cleanOpenRef.current) return;
    setCleanMounted(true);
    setClean({ open: true, autoStart: viaHotkey && !settingsRef.current.confirmBeforePurge });
  }, []);

  const closeClean = useCallback(() => setClean((p) => ({ ...p, open: false })), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  /** The toolbar indicator, or "View update" in Settings (which closes first: one dialog at a time). */
  const openUpdate = useCallback(() => {
    setSettingsOpen(false);
    setUpdateOpen(true);
  }, []);
  const closeUpdate = useCallback(() => setUpdateOpen(false), []);

  const handleNav = useCallback(
    (target: NavTarget | NavRequest | null) => {
      if (!target) return;
      if (typeof target === "object") {
        if (target.focus) setPendingFocus(target);
        navigate(target.view);
        return;
      }
      if (isViewId(target)) navigate(target);
      // quick-clean (tray menu or an in-app link) always asks first: autoStart only for the F9 key.
      else if (target === "quick-clean") openClean(false);
      else if (target === "settings") setSettingsOpen(true);
    },
    [navigate, openClean],
  );

  // Global keymap (CONTRACT §4.6).
  useEffect(() => {
    const production = isTauri && !import.meta.env.DEV;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const key = e.key;
      const typing = isTypingTarget(e.target);

      // Never reload the WebView: F5 in any combination, Ctrl+R / Ctrl+Shift+R in the packaged app.
      if (key === "F5") {
        e.preventDefault();
        if (!typing && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !isModalOpen()) void rescanAll();
        return;
      }
      if (production && e.ctrlKey && (key === "r" || key === "R")) {
        e.preventDefault();
        return;
      }
      // Caret-browsing prompt in WebView2.
      if (key === "F7") e.preventDefault();

      // [NEW 1.2] Ctrl+K focuses the toolbar filter field when the page has one; no effect otherwise.
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (key === "k" || key === "K")) {
        e.preventDefault();
        if (!typing && !e.repeat && !isModalOpen()) focusToolbarFilter();
        return;
      }

      if (typing) {
        // Keep WebView2 defaults (help, find bar, …) off our F-keys; the text field keeps every other key.
        if (FKEY_MAP[key] && !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
        return;
      }

      // Ctrl+1..8 → VIEW_ORDER[n-1] (Ctrl+7 Gaming, Ctrl+8 Cleaner)
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[1-8]$/.test(key)) {
        e.preventDefault();
        if (isModalOpen()) return;
        navigate(VIEW_ORDER[Number(key) - 1]);
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const action = FKEY_MAP[key];
      if (!action) return;
      // In the Sensors view F2 means "rename selected row"; the view handles it.
      if (key === "F2" && viewRef.current === "sensors") return;
      e.preventDefault();
      // While a dialog is open, view switching / opening another dialog would act behind it.
      if (isModalOpen() || e.repeat) return;
      if (action.type === "view") navigate(action.view);
      else if (action.type === "cleanCaches") openClean(true);
      else if (action.type === "rescan") void rescanAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, rescanAll, openClean]);

  // Navigation requests from the tray menu / Rust core.
  useEffect(
    () =>
      subscribe<unknown>("navigate", (payload) => {
        const legacy = payload === "fans" ? "cooling" : payload;
        handleNav(parseNavPayload(legacy));
      }),
    [handleNav],
  );

  // In-app navigation requests ("View drive", "System →", …) via lib/nav requestNavigate().
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      const legacy = detail === "fans" ? "cooling" : detail;
      handleNav(parseNavPayload(legacy));
    };
    window.addEventListener(NAV_EVENT, onNav);
    return () => window.removeEventListener(NAV_EVENT, onNav);
  }, [handleNav]);

  // Disable the WebView context menu in the packaged app (keep it for text fields).
  useEffect(() => {
    if (!isTauri || import.meta.env.DEV) return;
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Warm the other modules once the first view is up so switching is instant.
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const id of VIEW_ORDER) viewLoaders[id]().catch(() => undefined);
      purgeLoader().catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(t);
  }, []);

  // Keep the backend's poll interval in step with the saved setting on start.
  useEffect(() => {
    if (!isTauri) return;
    api.setPollInterval(settings.pollIntervalMs).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, after settings load
  }, []);

  // A new view starts at its top.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [view]);

  const ActiveView = VIEWS[view];
  const label = VIEW_TITLES[view];
  const listPage = PAGE_KIND[view] === "list";

  return (
    <div className="grid h-full min-h-0 grid-cols-[var(--sidebar-w)_minmax(0,1fr)] overflow-hidden">
      <Sidebar view={view} onNavigate={navigate} />

      <PageChromeProvider>
        <div className="flex min-h-0 min-w-0 flex-col">
          <Toolbar
            view={view}
            onRefresh={rescanAll}
            onSettings={openSettings}
            onOpenUpdate={openUpdate}
            refreshing={systemLoading || scanLoading}
          />
          <AppBanners />

          {/* Grouped pages sit on the canvas and scroll here; list pages are full-bleed white and scroll their own table. */}
          <main
            id="nexum-main"
            ref={mainRef}
            className={cn(
              "relative flex min-h-0 flex-1 flex-col",
              listPage ? "overflow-hidden bg-content" : "overflow-x-hidden overflow-y-auto bg-canvas",
            )}
          >
            <ModuleErrorBoundary label={label}>
              <Suspense fallback={<ViewLoader label={label} />}>
                <div
                  key={view}
                  className={cn(
                    "flex animate-fade-in flex-col",
                    listPage ? "min-h-0 flex-1" : "min-h-full flex-1 px-(--page-pad-x) py-(--page-pad-y)",
                  )}
                >
                  <ActiveView />
                </div>
              </Suspense>
            </ModuleErrorBoundary>
          </main>
        </div>
      </PageChromeProvider>

      {cleanMounted && (
        <ModuleErrorBoundary label="Cache cleanup" silent>
          <Suspense fallback={null}>
            <OneClickPurgeModal open={clean.open} onClose={closeClean} autoStart={clean.autoStart} />
          </Suspense>
        </ModuleErrorBoundary>
      )}

      <SettingsModal open={settingsOpen} onClose={closeSettings} onViewUpdate={openUpdate} />
      <UpdateDialog open={updateOpen} onClose={closeUpdate} />
      <PawnIoConsent />
      <UpdatePrompt blocked={settingsOpen || clean.open || updateOpen} />
      <ToastHost />
      <TraySensorSync />
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <UpdaterProvider>
        <SystemInfoProvider>
          <DriverScanProvider>
            <TelemetryProvider>
              <SensorsProvider>
                <SystemSpecProvider>
                  <HealthProvider>
                    <FramesProvider>
                      <Shell />
                    </FramesProvider>
                  </HealthProvider>
                </SystemSpecProvider>
              </SensorsProvider>
            </TelemetryProvider>
          </DriverScanProvider>
        </SystemInfoProvider>
      </UpdaterProvider>
    </SettingsProvider>
  );
}
