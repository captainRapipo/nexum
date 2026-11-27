import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XOctagon } from "lucide-react";

/**
 * Tiny global toast system.
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

  // Collapse exact duplicates that are still on screen (e.g. repeated agent acks).
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

const TONE_STYLE: Record<ToastTone, { ring: string; text: string; bar: string; Icon: typeof Info }> = {
  ok: { ring: "border-teal/40", text: "text-teal", bar: "bg-teal", Icon: CheckCircle2 },
  info: { ring: "border-cyan/40", text: "text-cyan", bar: "bg-cyan", Icon: Info },
  warn: { ring: "border-gold/45", text: "text-gold", bar: "bg-gold", Icon: AlertTriangle },
  crit: { ring: "border-rose/50", text: "text-rose", bar: "bg-rose", Icon: XOctagon },
};

function ToastCard({ item }: { item: ToastItem }) {
  const s = TONE_STYLE[item.tone];
  const Icon = s.Icon;
  return (
    <div
      role={item.tone === "crit" ? "alert" : "status"}
      className={`nx-toast-in pointer-events-auto relative w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border ${s.ring} bg-[rgba(10,18,21,0.92)] shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl`}
    >
      <div className={`absolute inset-y-0 left-0 w-[3px] ${s.bar} opacity-80`} />
      <div className="flex items-start gap-3 py-3 pl-4 pr-3">
        <Icon size={18} className={`mt-0.5 shrink-0 ${s.text}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] leading-snug text-ink">{item.message}</div>
          {item.detail && (
            <div className="mt-1 truncate font-mono text-[11px] text-muted" title={item.detail}>
              {item.detail}
            </div>
          )}
          {item.action && (
            <button
              type="button"
              onClick={() => {
                try {
                  item.action?.onClick();
                } finally {
                  dismissToast(item.id);
                }
              }}
              className={`mt-2 rounded-md border border-line bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${s.text} transition hover:bg-white/10`}
            >
              {item.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismissToast(item.id)}
          className="shrink-0 rounded p-1 text-muted transition hover:bg-white/5 hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      {item.durationMs > 0 && (
        <div className="h-[2px] w-full bg-white/5">
          <div
            className={`h-full ${s.bar} opacity-60`}
            style={{ animation: `nx-toast-life ${item.durationMs}ms linear forwards` }}
          />
        </div>
      )}
    </div>
  );
}

const TOAST_KEYFRAMES = `
@keyframes nx-toast-life { from { width: 100%; } to { width: 0%; } }
@keyframes nx-toast-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }
.nx-toast-in { animation: nx-toast-in 180ms ease-out; }
@media (prefers-reduced-motion: reduce) { .nx-toast-in { animation: none; } }
`;

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
      <style>{TOAST_KEYFRAMES}</style>
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  );
}

export default ToastHost;
