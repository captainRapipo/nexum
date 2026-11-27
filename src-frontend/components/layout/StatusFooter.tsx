import { Fragment } from "react";
import type { ViewId } from "../../types";
import { isTauri } from "../../lib/api";
import { cn, fmtClock } from "../../lib/format";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useNow } from "./HeaderStrip";

export interface StatusFooterProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  onRescan: () => void;
  onQuickClean: () => void;
}

interface KeyDef {
  key: string;
  label: string;
  view?: ViewId;
  action?: "rescan" | "clean";
}

const KEYS: readonly KeyDef[] = [
  { key: "F1", label: "Dashboard", view: "dashboard" },
  { key: "F2", label: "Drivers", view: "drivers" },
  { key: "F3", label: "Storage", view: "storage" },
  { key: "F4", label: "Fans", view: "fans" },
  { key: "F5", label: "Rescan", action: "rescan" },
  { key: "F9", label: "Quick Clean", action: "clean" },
];

/** BIOS-style key legend + live link status. */
export function StatusFooter({ view, onNavigate, onRescan, onQuickClean }: StatusFooterProps) {
  const { agent, latest } = useTelemetry();
  const now = useNow(1000);

  const online = agent?.running ?? latest != null;
  const packetAge = latest ? Math.max(0, (now - latest.ts) / 1000) : null;

  return (
    <footer className="relative z-10 flex h-8 shrink-0 select-none items-center gap-4 border-t border-line bg-[#05090b]/85 px-4 text-[11px] backdrop-blur-md">
      <nav aria-label="Keyboard shortcuts" className="flex min-w-0 items-center gap-2">
        {KEYS.map((k, i) => {
          const active = k.view != null && k.view === view;
          const onClick = () => {
            if (k.view) onNavigate(k.view);
            else if (k.action === "rescan") onRescan();
            else if (k.action === "clean") onQuickClean();
          };
          return (
            <Fragment key={k.key}>
              {i > 0 && (
                <span aria-hidden="true" className="text-slate-700">
                  ·
                </span>
              )}
              <button
                type="button"
                onClick={onClick}
                className="group flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-white/[0.04]"
              >
                <kbd
                  className={cn(
                    "kbd",
                    active && "[--kbd-color:var(--color-teal)] [--kbd-border:rgba(45,212,191,0.45)]",
                    k.action === "clean" && "[--kbd-color:var(--color-gold)] [--kbd-border:rgba(212,163,89,0.45)]",
                  )}
                >
                  {k.key}
                </kbd>
                <span
                  className={cn(
                    "whitespace-nowrap uppercase tracking-[0.1em]",
                    active ? "text-teal" : "text-slate-400 group-hover:text-slate-200",
                  )}
                >
                  {k.label}
                </span>
              </button>
            </Fragment>
          );
        })}
        <span aria-hidden="true" className="text-slate-700">
          ·
        </span>
        <span className="flex items-center gap-1.5 px-1">
          <kbd className="kbd">Esc</kbd>
          <span className="uppercase tracking-[0.1em] text-slate-500">Close</span>
        </span>
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-3 text-slate-500">
        {!isTauri && (
          <span className="rounded border border-gold/30 bg-gold/[0.06] px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.14em] text-gold/90">
            Preview · Simulated data
          </span>
        )}
        <span className="flex items-center gap-1.5" title={agent?.message}>
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", online ? "led-teal animate-led-pulse" : "led-rose")}
          />
          <span className="font-mono uppercase tracking-[0.12em]">{online ? "Agent link" : "Agent offline"}</span>
          {packetAge != null && online && <span className="num text-slate-400">{packetAge < 10 ? packetAge.toFixed(1) : Math.round(packetAge)}s</span>}
        </span>
        <span aria-hidden="true" className="h-3 w-px bg-line" />
        <span className="num text-slate-300">{fmtClock(now)}</span>
      </div>
    </footer>
  );
}

export default StatusFooter;
