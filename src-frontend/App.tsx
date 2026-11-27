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
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { ViewId } from "./types";
import { isTauri, subscribe } from "./lib/api";
import { SettingsProvider, useSettings } from "./hooks/useSettings";
import { SystemInfoProvider, useSystemInfo } from "./hooks/useSystemInfo";
import { DriverScanProvider, useDriverScan } from "./hooks/useDriverScan";
import { TelemetryProvider } from "./hooks/useTelemetryStream";
import { TopBar } from "./components/layout/TopBar";
import { HeaderStrip } from "./components/layout/HeaderStrip";
import { StatusFooter } from "./components/layout/StatusFooter";
import { SettingsModal } from "./components/layout/SettingsModal";
import { Button } from "./components/ui/Button";
import { isModalOpen } from "./components/ui/Modal";
import { ToastHost } from "./components/feedback/Toast";

/* ------------------------------------------------------------------ */
/* Lazy modules                                                        */
/* ------------------------------------------------------------------ */

const VIEW_IDS: readonly ViewId[] = ["dashboard", "drivers", "storage", "fans", "cleaner"];

function isViewId(v: unknown): v is ViewId {
  return typeof v === "string" && (VIEW_IDS as readonly string[]).includes(v);
}

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
  drivers: () => import("./views/DriversView"),
  storage: () => import("./views/StorageView"),
  fans: () => import("./views/FanControlView"),
  cleaner: () => import("./views/CleanerView"),
};

const VIEWS = {
  dashboard: lazyModule(viewLoaders.dashboard, "DashboardView"),
  drivers: lazyModule(viewLoaders.drivers, "DriversView"),
  storage: lazyModule(viewLoaders.storage, "StorageView"),
  fans: lazyModule(viewLoaders.fans, "FanControlView"),
  cleaner: lazyModule(viewLoaders.cleaner, "CleanerView"),
} satisfies Record<ViewId, unknown>;

const VIEW_LABEL: Record<ViewId, string> = {
  dashboard: "Dashboard",
  drivers: "Drivers",
  storage: "Storage",
  fans: "Fan Control",
  cleaner: "Cleaner",
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
        <div className="glass glow-rose w-full max-w-[520px] p-6">
          <div className="flex items-center gap-2.5 text-rose-400">
            <AlertTriangle size={18} aria-hidden="true" />
            <h2 className="label-caps [--label-color:currentColor]">Module fault · {this.props.label}</h2>
          </div>
          <p className="mt-3 text-[13px] text-slate-300">This panel stopped responding. Telemetry and the rest of Nexum keep running.</p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-line bg-black/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-slate-400 select-text">
            {error.message || String(error)}
          </pre>
          <div className="mt-4 flex justify-end">
            <Button variant="teal" size="sm" icon={RotateCcw} onClick={this.reset}>
              Reload panel
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
      <div className="relative h-[3px] w-48 overflow-hidden rounded-full bg-white/[0.06]">
        <span className="absolute inset-y-0 left-0 w-1/3 animate-sweep rounded-full bg-teal shadow-[0_0_12px_rgba(45,212,191,0.8)]" />
      </div>
      <span className="label-caps">Loading module · {label}</span>
    </div>
  );
}

/**
 * Deep-link support: `?view=drivers` opens a module directly and `?purge=1` opens the
 * 1-Click Purge modal on start (handy for screenshots, the tray and debugging).
 */
function readInitialRoute(): { view: ViewId; purge: boolean } {
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("view");
    const p = q.get("purge");
    return { view: isViewId(v) ? v : "dashboard", purge: p === "1" || p === "true" };
  } catch {
    return { view: "dashboard", purge: false };
  }
}

interface PurgeState {
  open: boolean;
  autoStart: boolean;
}

function Shell() {
  const [initial] = useState(readInitialRoute);
  const [view, setView] = useState<ViewId>(initial.view);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [purge, setPurge] = useState<PurgeState>({ open: initial.purge, autoStart: false });
  const [purgeMounted, setPurgeMounted] = useState(initial.purge);

  const { settings } = useSettings();
  const { refresh: refreshSystem, loading: systemLoading } = useSystemInfo();
  const { rescan, loading: scanLoading } = useDriverScan();

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const purgeOpenRef = useRef(purge.open);
  purgeOpenRef.current = purge.open;

  const navigate = useCallback((next: ViewId) => {
    // Transition keeps the current view on screen while a lazy view loads.
    startTransition(() => setView(next));
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([refreshSystem(), rescan()]);
  }, [refreshSystem, rescan]);

  const openPurge = useCallback((viaHotkey: boolean) => {
    if (purgeOpenRef.current) return;
    setPurgeMounted(true);
    setPurge({ open: true, autoStart: viaHotkey && !settingsRef.current.confirmBeforePurge });
  }, []);

  const closePurge = useCallback(() => setPurge((p) => ({ ...p, open: false })), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Global BIOS-style hotkeys.
  useEffect(() => {
    const production = isTauri && !import.meta.env.DEV;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // F5 in any combination (Ctrl+F5 / Shift+F5 are hard reloads in WebView2) must never reload.
      if (e.key === "F5") {
        e.preventDefault();
        if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) void refreshAll();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        // Block WebView reload shortcuts (Ctrl+R / Ctrl+Shift+R) in the packaged app.
        if (production && e.ctrlKey && (e.key === "r" || e.key === "R")) e.preventDefault();
        return;
      }
      // While a dialog is open, view switching / opening another dialog would act behind it.
      if (isModalOpen() && (e.key === "F1" || e.key === "F2" || e.key === "F3" || e.key === "F4" || e.key === "F9")) {
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case "F1":
          e.preventDefault();
          navigate("dashboard");
          break;
        case "F2":
          e.preventDefault();
          navigate("drivers");
          break;
        case "F3":
          e.preventDefault();
          navigate("storage");
          break;
        case "F4":
          e.preventDefault();
          navigate("fans");
          break;
        case "F9":
          e.preventDefault();
          if (!e.repeat) openPurge(true);
          break;
        case "F7":
          // Caret-browsing prompt in WebView2.
          if (production) e.preventDefault();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, refreshAll, openPurge]);

  // Navigation requests from the tray menu / Rust core.
  useEffect(
    () =>
      subscribe<unknown>("navigate", (payload) => {
        const target =
          typeof payload === "string"
            ? payload
            : payload && typeof payload === "object" && "view" in payload
              ? String((payload as { view: unknown }).view)
              : "";
        if (isViewId(target)) navigate(target);
        else if (target === "purge" || target === "quick-clean") openPurge(true);
        else if (target === "settings") setSettingsOpen(true);
      }),
    [navigate, openPurge],
  );

  // In-app navigation requests from widgets ("View all", "Control", …) via a DOM CustomEvent.
  useEffect(() => {
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<unknown>).detail;
      if (isViewId(target)) navigate(target);
      else if (target === "purge") openPurge(false);
      else if (target === "settings") setSettingsOpen(true);
    };
    window.addEventListener("nexum:navigate", onNav);
    return () => window.removeEventListener("nexum:navigate", onNav);
  }, [navigate, openPurge]);

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
      for (const id of VIEW_IDS) viewLoaders[id]().catch(() => undefined);
      purgeLoader().catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(t);
  }, []);

  const ActiveView = VIEWS[view];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TopBar
        view={view}
        onNavigate={navigate}
        onPurge={() => openPurge(false)}
        onRefresh={refreshAll}
        onSettings={openSettings}
        refreshing={systemLoading || scanLoading}
      />
      <HeaderStrip />

      <main id="nexum-main" className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <ModuleErrorBoundary label={VIEW_LABEL[view]}>
          <Suspense fallback={<ViewLoader label={VIEW_LABEL[view]} />}>
            <div key={view} className="flex min-h-full flex-1 flex-col animate-view-in p-4">
              <ActiveView />
            </div>
          </Suspense>
        </ModuleErrorBoundary>
      </main>

      <StatusFooter view={view} onNavigate={navigate} onRescan={() => void refreshAll()} onQuickClean={() => openPurge(true)} />

      {purgeMounted && (
        <ModuleErrorBoundary label="1-Click Purge" silent>
          <Suspense fallback={null}>
            <OneClickPurgeModal open={purge.open} onClose={closePurge} autoStart={purge.autoStart} />
          </Suspense>
        </ModuleErrorBoundary>
      )}

      <SettingsModal open={settingsOpen} onClose={closeSettings} />
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <SystemInfoProvider>
        <DriverScanProvider>
          <TelemetryProvider>
            <Shell />
          </TelemetryProvider>
        </DriverScanProvider>
      </SystemInfoProvider>
    </SettingsProvider>
  );
}
