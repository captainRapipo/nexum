import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { StatusIcon } from "../ui/StatusPill";

/**
 * Tiny global toast system (CONTRACT §4.7). White card, popover shadow, status icon + text.
 *
 *   toast("Exported to C:\\…", "ok", { action: { label: "Open folder", onClick } })
 *   <ToastHost />   // render anywhere; multiple hosts are de-duplicated so only one paints.
 */

export type ToastTone = "ok" | "warn" | "crit" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Optional call-to-action rendered as a small button inside the toast. */
  action?: ToastAction;
  /** Auto-dismiss delay. 0 = sticky. Defaults: 4.5s (6.5s when an action is present, 7s for crit). */
  durationMs?: number;
  /** Secondary line rendered under the message (e.g. a file path). */
  detail?: string;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  detail?: string;
  durationMs: number;
  createdAt: number;
}

const MAX_VISIBLE = 5;

/* ------------------------------------------------------------------ toast store */

let toasts: ToastItem[] = [];
let nextId = 1;
const toastListeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emitToasts() {
  toastListeners.forEach((l) => l());
}

function subscribeToasts(l: () => void) {
  toastListeners.add(l);
  return () => {
    toastListeners.delete(l);
  };
}

function getToasts() {
  return toasts;
}

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const before = toasts.length;
  toasts = toasts.filter((x) => x.id !== id);
  if (toasts.length !== before) emitToasts();
}

export function toast(message: string, tone: ToastTone = "info", opts: ToastOptions = {}): number {
  const id = nextId++;
  const durationMs =
    opts.durationMs ?? (tone === "crit" ? 7000 : opts.action ? 6500 : 4500);

  // Collapse exact duplicates that are still on screen (e.g. the same confirmation arriving twice).
  const dup = toasts.find((x) => x.message === message && x.tone === tone && x.detail === opts.detail);
  if (dup) dismissToast(dup.id);

  const item: ToastItem = {
    id,
    message,
    tone,
    action: opts.action,
    detail: opts.detail,
    durationMs,
    createdAt: Date.now(),
  };
  toasts = [...toasts, item].slice(-MAX_VISIBLE);
  emitToasts();

  if (durationMs > 0) {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), durationMs),
    );
  }
  return id;
}

/* ------------------------------------------------------------- host de-duplication */

let hosts: symbol[] = [];
const hostListeners = new Set<() => void>();

function subscribeHosts(l: () => void) {
  hostListeners.add(l);
  return () => {
    hostListeners.delete(l);
  };
}

function getActiveHost(): symbol | null {
  return hosts.length > 0 ? hosts[0] : null;
}

function registerHost(sym: symbol) {
  if (!hosts.includes(sym)) {
    hosts = [...hosts, sym];
    hostListeners.forEach((l) => l());
  }
}

function unregisterHost(sym: symbol) {
  hosts = hosts.filter((h) => h !== sym);
  hostListeners.forEach((l) => l());
}

/* ------------------------------------------------------------------------- UI */

/** The tone is carried by the status glyph (shape + colour); the card itself stays white. */
function ToastCard({ item }: { item: ToastItem }) {
  return (
    <div
      role={item.tone === "crit" ? "alert" : "status"}
      className="pointer-events-auto flex w-[380px] max-w-[calc(100vw-2rem)] animate-fade-in items-start gap-2.5 rounded-lg bg-card py-2.5 pr-2 pl-3 shadow-popover forced-colors:border"
    >
      <StatusIcon tone={item.tone} size={17} className="mt-[1.5px]" />
      <div className="min-w-0 flex-1">
        <div className="text-body text-ink [overflow-wrap:anywhere]">{item.message}</div>
        {item.detail && (
          <div className="mt-px truncate font-mono text-mono text-ink-3" title={item.detail}>
            {item.detail}
          </div>
        )}
        {item.action && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-2 mb-0.5"
            onClick={() => {
              try {
                item.action?.onClick();
              } finally {
                dismissToast(item.id);
              }
            }}
          >
            {item.action.label}
          </Button>
        )}
      </div>
      <button
        type="button"
        title="Dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(item.id)}
        className="-mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors duration-(--dur-instant) hover:bg-hover hover:text-ink active:bg-pressed"
      >
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Renders the toast stack (bottom-right, portalled to <body>). Safe to render from several views at
 * once: only the first mounted host paints; the others render nothing.
 */
export function ToastHost() {
  const symRef = useRef<symbol | null>(null);
  if (symRef.current === null) symRef.current = Symbol("nx-toast-host");

  useEffect(() => {
    const sym = symRef.current as symbol;
    registerHost(sym);
    return () => unregisterHost(sym);
  }, []);

  const active = useSyncExternalStore(subscribeHosts, getActiveHost, getActiveHost);
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

  if (active !== symRef.current || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-[1000] flex flex-col items-end gap-2"
    >
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}

export default ToastHost;
