// In-app navigation (CONTRACT §4.5 lib/nav.ts, §4.6). Every "View …" link goes through
// requestNavigate(); App.tsx listens for the DOM event and switches views / opens modals.

import { VIEW_ORDER, type NavRequest, type NavTarget, type ViewId } from "../types";

export const NAV_EVENT = "nexum:navigate";

export function isViewId(v: unknown): v is ViewId {
  return typeof v === "string" && (VIEW_ORDER as readonly string[]).includes(v);
}

export function isNavTarget(v: unknown): v is NavTarget {
  return isViewId(v) || v === "quick-clean" || v === "settings";
}

/** Normalise a `navigate` / `nexum:navigate` payload. Returns null for anything unknown. */
export function parseNavPayload(payload: unknown): NavTarget | NavRequest | null {
  if (isNavTarget(payload)) return payload;
  if (payload && typeof payload === "object" && "view" in payload) {
    const p = payload as { view: unknown; focus?: unknown };
    if (isViewId(p.view)) {
      return { view: p.view, focus: typeof p.focus === "string" ? p.focus : null };
    }
  }
  return null;
}

/** Dispatch `nexum:navigate` (detail = NavTarget | NavRequest). */
export function requestNavigate(target: NavTarget | NavRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NAV_EVENT, { detail: target }));
}

/* ------------------------------------------------------------------ */
/* Focus hand-off: a view reads (and clears) the focus it was opened   */
/* with, e.g. Storage opens the S.M.A.R.T. drawer of DiskTelemetry.id. */
/* ------------------------------------------------------------------ */

let pendingFocus: NavRequest | null = null;
const focusListeners = new Set<(req: NavRequest) => void>();

/** Called by App.tsx when a NavRequest with `focus` arrives. */
export function setPendingFocus(req: NavRequest): void {
  pendingFocus = req;
  focusListeners.forEach((l) => l(req));
}

/** Returns and clears the pending focus for `view` (null when none). */
export function takePendingFocus(view: ViewId): string | null {
  if (!pendingFocus || pendingFocus.view !== view) return null;
  const f = pendingFocus.focus ?? null;
  pendingFocus = null;
  return f;
}

/** Subscribe to focus requests while a view is already mounted. Returns an unsubscribe function. */
export function onFocusRequest(cb: (req: NavRequest) => void): () => void {
  focusListeners.add(cb);
  return () => {
    focusListeners.delete(cb);
  };
}

/* ------------------------------------------------------------------ */
/* F5 hand-off: App dispatches `nexum:rescan` (detail = active ViewId) */
/* so a view can re-run its own scan (e.g. the Cleaner).               */
/* ------------------------------------------------------------------ */

export const RESCAN_EVENT = "nexum:rescan";

/** Run `cb` when F5 / the Rescan button is used while `view` is active. Returns an unsubscribe function. */
export function onRescanRequest(view: ViewId, cb: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<unknown>).detail === view) cb();
  };
  window.addEventListener(RESCAN_EVENT, handler);
  return () => window.removeEventListener(RESCAN_EVENT, handler);
}
