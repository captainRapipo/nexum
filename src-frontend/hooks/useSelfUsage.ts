import { useEffect, useSyncExternalStore } from "react";
import { subscribe as subscribeEvent } from "../lib/api";
import type { SelfUsage } from "../types";

/* Module-level store fed by the Rust `self-usage` event (every 5 s while the window is visible). */

let latest: SelfUsage | null = null;
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  subscribeEvent<SelfUsage>("self-usage", (u) => {
    if (!u || typeof u !== "object" || typeof u.cpuPct !== "number") return;
    latest = { ...u };
    listeners.forEach((l) => l());
  });
}

function subscribeStore(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => latest;

/** Nexum's own CPU / memory footprint (Nexum.exe + nexum-agent + WebView2), null until the first event. */
export function useSelfUsage(): SelfUsage | null {
  useEffect(start, []);
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}

/** Sidebar footer copy (CONTRACT §2.5, §4.6.1): `Nexum 0.6% CPU · 142 MB`, `—` until the first event. */
export function fmtSelfUsage(u: SelfUsage | null): string {
  if (!u) return "—";
  return `Nexum ${u.cpuPct.toFixed(1)}% CPU · ${Math.round(u.workingSetMb).toLocaleString("en-US")} MB`;
}

/** [NEW 1.2] Hover text of that line (CONTRACT §4.6.1, §4.8.1). */
export function selfUsageTitle(u: SelfUsage | null): string {
  if (!u) return "Nexum's own CPU and memory use appears a few seconds after start.";
  const n = u.processCount;
  return `Nexum's own use of this PC: ${n} ${n === 1 ? "process" : "processes"}. CPU is a share of the whole PC.`;
}

export default useSelfUsage;
