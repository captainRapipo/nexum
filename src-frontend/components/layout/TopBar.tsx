import { useCallback, useEffect, useRef, useState } from "react";
import { Fan, HardDrive, LayoutDashboard, Cpu, RefreshCw, Settings, Sparkles, Zap, type LucideIcon } from "lucide-react";
import type { ViewId } from "../../types";
import { cn } from "../../lib/format";
import { Button } from "../ui/Button";
import { NexumEmblem } from "./NexumEmblem";

export interface TopBarProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  onPurge: () => void;
  /** May return a promise; the refresh icon spins until it settles. */
  onRefresh: () => void | Promise<unknown>;
  onSettings: () => void;
  /** External busy flag (e.g. a scan started via F5). */
  refreshing?: boolean;
}

interface TabDef {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  hotkey?: string;
}

export const VIEW_TABS: readonly TabDef[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, hotkey: "F1" },
  { id: "drivers", label: "Drivers", icon: Cpu, hotkey: "F2" },
  { id: "storage", label: "Storage", icon: HardDrive, hotkey: "F3" },
  { id: "fans", label: "Fan Control", icon: Fan, hotkey: "F4" },
  { id: "cleaner", label: "Cleaner", icon: Sparkles },
];

const MIN_SPIN_MS = 700;

export function TopBar({ view, onNavigate, onPurge, onRefresh, onSettings, refreshing = false }: TopBarProps) {
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
    <header className="relative z-20 flex h-14 shrink-0 select-none items-center gap-5 border-b border-line bg-[#081114]/75 px-5 backdrop-blur-xl">
      {/* bottom hairline glow */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-linear-to-r from-transparent via-teal/35 to-transparent"
      />

      {/* Brand */}
      <div className="flex shrink-0 items-center gap-2.5">
        <NexumEmblem size={30} />
        <div className="leading-none">
          <div className="pl-[0.38em] text-[15px] font-semibold tracking-[0.38em] text-ink">NEXUM</div>
          <div className="mt-1 hidden pl-[0.3em] font-mono text-[8.5px] uppercase tracking-[0.3em] text-muted min-[1440px]:block">
            Telemetry Core
          </div>
        </div>
      </div>

      <span aria-hidden="true" className="h-6 w-px shrink-0 bg-line" />

      {/* View switcher */}
      <nav aria-label="Views" className="flex h-full min-w-0 items-stretch gap-0.5">
        {VIEW_TABS.map((tab) => {
          const active = tab.id === view;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={active ? "page" : undefined}
              title={tab.hotkey ? `${tab.label} (${tab.hotkey})` : tab.label}
              onClick={() => onNavigate(tab.id)}
              className={cn(
                "group relative flex items-center gap-2 px-3 text-[12.5px] font-medium tracking-[0.02em] transition-colors duration-150",
                active ? "text-ink" : "text-slate-400 hover:text-slate-200",
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-1 bottom-0 top-2 rounded-t-lg bg-linear-to-t from-teal/[0.12] to-transparent"
                />
              )}
              <Icon
                size={15}
                strokeWidth={1.9}
                aria-hidden="true"
                className={cn("relative transition-colors", active ? "text-teal drop-shadow-[0_0_6px_rgba(45,212,191,0.7)]" : "text-slate-500 group-hover:text-slate-300")}
              />
              <span className="relative whitespace-nowrap">{tab.label}</span>
              {tab.hotkey && (
                <span
                  className={cn(
                    "kbd-sm relative hidden min-[1440px]:inline-flex",
                    active && "[--kbd-color:var(--color-teal)] [--kbd-border:rgba(45,212,191,0.35)]",
                  )}
                >
                  {tab.hotkey}
                </span>
              )}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-2 -bottom-px h-[2px] rounded-full transition-[opacity,transform] duration-200",
                  active ? "scale-x-100 bg-teal opacity-100 shadow-[0_0_10px_1px_rgba(45,212,191,0.75)]" : "scale-x-50 bg-teal opacity-0",
                )}
              />
            </button>
          );
        })}
      </nav>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button variant="gold" icon={Zap} onClick={onPurge} title="1-Click Purge Trash (F9)" className="uppercase tracking-[0.08em]">
          1-Click Purge Trash
          <span className="kbd-sm ml-0.5 hidden [--kbd-border:rgba(212,163,89,0.4)] [--kbd-color:rgba(212,163,89,0.85)] min-[1440px]:inline-flex">
            F9
          </span>
        </Button>
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-line" />
        <Button
          variant="ghost"
          aria-label="Refresh sensors (F5)"
          title="Refresh sensors (F5)"
          onClick={() => void handleRefresh()}
          aria-busy={spinning || undefined}
          icon={<RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" className={cn(spinning && "animate-spin text-teal")} />}
        />
        <Button variant="ghost" aria-label="Settings" title="Settings" onClick={onSettings} icon={Settings} />
      </div>
    </header>
  );
}

export default TopBar;
