// In-app updates, frontend side (CONTRACT §2.15.7, §4.4). The frontend has no network API: Rust owns the
// check, the download, the signature check and the install. This hook only mirrors Rust's UpdateState
// (`get_update_state` on mount, then the `update-state` event) and forwards the two user actions.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import {
  EVENTS,
  INITIAL_UPDATE_STATE,
  type UpdateChannel,
  type UpdateErrorCode,
  type UpdateState,
  type UpdateStatus,
} from "../types";
import { toast } from "../components/feedback/Toast";

export interface UpdaterValue {
  /** Rust's current update state; INITIAL_UPDATE_STATE (currentVersion "") until the first answer. */
  update: UpdateState;
  /**
   * A check the user asked for ("Check now"). Never rejects: a failure is shown by the state
   * (`state: "error"`), or as a toast when the state does not carry it.
   */
  check: () => Promise<void>;
  /** The "Install update" click. Never rejects (same rule as `check`). */
  install: () => Promise<void>;
}

const STATES: readonly UpdateStatus[] = ["idle", "checking", "available", "downloading", "ready", "installing", "error", "disabled"];
const CHANNELS: readonly UpdateChannel[] = ["stable", "preview"];

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const channel = (v: unknown): UpdateChannel | null => (CHANNELS.includes(v as UpdateChannel) ? (v as UpdateChannel) : null);

/** Fill members a partial payload may lack; an unknown `state` is treated as idle. */
export function normalizeUpdateState(raw: unknown): UpdateState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<UpdateState>;
  const state: UpdateStatus = STATES.includes(s.state as UpdateStatus) ? (s.state as UpdateStatus) : "idle";
  const progress = num(s.progress);
  return {
    state,
    currentVersion: typeof s.currentVersion === "string" ? s.currentVersion : "",
    latestVersion: str(s.latestVersion),
    notes: str(s.notes),
    publishedAt: str(s.publishedAt),
    progress: progress == null ? null : Math.round(Math.min(100, Math.max(0, progress))),
    downloadedBytes: num(s.downloadedBytes),
    totalBytes: num(s.totalBytes),
    error: state === "error" ? str(s.error) : null,
    errorCode: state === "error" ? ((str(s.errorCode) as UpdateErrorCode | null) ?? "unknown") : null,
    channel: channel(s.channel),
    buildChannel: channel(s.buildChannel),
    lastCheckTs: num(s.lastCheckTs),
  };
}

/** True while an update is on offer or being installed: the states that show the toolbar indicator. */
export function updateOnOffer(u: UpdateState): boolean {
  return u.state === "available" || u.state === "downloading" || u.state === "ready" || u.state === "installing";
}

/** True while the download / install runs: the update dialog cannot be dismissed (CONTRACT §2.15.7). */
export function updateBusy(u: UpdateState): boolean {
  return u.state === "downloading" || u.state === "ready" || u.state === "installing";
}

const UpdaterContext = createContext<UpdaterValue | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const current = useRef<UpdateState>(INITIAL_UPDATE_STATE);
  const gotEvent = useRef(false);

  const apply = useCallback((next: UpdateState | null) => {
    if (!next) return;
    current.current = next;
    setUpdate(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    const off = subscribe<unknown>(EVENTS.updateState, (raw) => {
      gotEvent.current = true;
      apply(normalizeUpdateState(raw));
    });
    api
      .getUpdateState()
      .then((s) => {
        // A pushed event is fresher than this initial query.
        if (!disposed && !gotEvent.current) apply(normalizeUpdateState(s));
      })
      .catch((err) => console.warn("[nexum] get_update_state failed:", errorMessage(err)));
    return () => {
      disposed = true;
      off();
    };
  }, [apply]);

  /** The rejection text goes into a toast only when the state did not already carry the error. */
  const report = useCallback((err: unknown) => {
    const text = errorMessage(err);
    const s = current.current;
    if (s.state === "error" && s.error === text) return;
    toast(text, "warn");
  }, []);

  const check = useCallback(async () => {
    try {
      apply(normalizeUpdateState(await api.checkForUpdate()));
    } catch (err) {
      report(err);
    }
  }, [apply, report]);

  const install = useCallback(async () => {
    try {
      await api.installUpdate();
    } catch (err) {
      report(err);
    }
  }, [report]);

  const value = useMemo<UpdaterValue>(() => ({ update, check, install }), [update, check, install]);
  return createElement(UpdaterContext.Provider, { value }, children);
}

/** Update state + the two user actions (CONTRACT §4.4). Must be used under <UpdaterProvider>. */
export function useUpdater(): UpdaterValue {
  const ctx = useContext(UpdaterContext);
  if (!ctx) throw new Error("useUpdater() must be used inside <UpdaterProvider>");
  return ctx;
}

export default useUpdater;
