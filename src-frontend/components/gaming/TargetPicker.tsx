import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Crosshair, Loader2, MonitorSmartphone, RefreshCw } from "lucide-react";
import type { FrameTarget, PresentingProcess } from "../../types";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { fmtFps } from "../../lib/frames";
import { targetReasonText } from "./gamingText";

export interface TargetPickerProps {
  target: FrameTarget | null;
  /** `useFrames().listPresenting`. */
  listPresenting: () => Promise<PresentingProcess[]>;
  /** `useFrames().setTarget`. */
  setTarget: (pid: number | null) => Promise<void>;
  /** Incremented by the view on F5: refreshes the list. */
  refreshSignal: number;
  /** Capture is running (the list is empty otherwise). */
  running: boolean;
  className?: string;
}

const AUTO_LABEL = "Auto (foreground game)";

/**
 * Target picker (CONTRACT §4.10.1): `Auto (foreground game)` plus the apps PresentMon currently sees
 * presenting frames. The list is fetched when the menu opens and on F5. Choosing an app pins it.
 */
export default function TargetPicker({ target, listPresenting, setTarget, refreshSignal, running, className }: TargetPickerProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PresentingProcess[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPid, setBusyPid] = useState<number | "auto" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reqId = useRef(0);
  const listId = useId();

  const refresh = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const list = await listPresenting();
      if (id !== reqId.current) return;
      setItems(list);
      setError(null);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(errorMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [listPresenting]);

  // F5 (signal > 0) refreshes; the initial 0 does not fetch until the menu opens.
  useEffect(() => {
    if (refreshSignal > 0 && running) void refresh();
  }, [refreshSignal, running, refresh]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void refresh();
  };

  const choose = async (pid: number | null) => {
    setBusyPid(pid ?? "auto");
    setError(null);
    try {
      await setTarget(pid);
      setOpen(false);
      buttonRef.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
      void refresh();
    } finally {
      setBusyPid(null);
    }
  };

  const manual = target?.reason === "manual";
  const current =
    target && target.pid != null
      ? `${target.process ?? `PID ${target.pid}`}${target.windowTitle ? ` · ${target.windowTitle}` : ""}`
      : "No app selected";

  return (
    <div ref={rootRef} className={cn("relative flex min-w-0 flex-col gap-1.5", className)}>
      <span className="truncate text-[11px] text-slate-500">{targetReasonText(target)}</span>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={!running}
        title={running ? "Choose which app to measure" : "Frame capture is not running"}
        onClick={toggle}
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-lg border bg-black/25 px-3 text-left text-[12.5px] transition-colors",
          open ? "border-teal/50" : "border-line hover:border-white/20",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <Crosshair size={14} className={manual ? "shrink-0 text-gold" : "shrink-0 text-teal"} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-slate-400">{manual ? "Pinned: " : "Auto: "}</span>
          <span className="text-ink">{current}</span>
        </span>
        <ChevronDown size={14} className={cn("shrink-0 text-slate-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Apps presenting frames"
          className="glass-strong absolute left-0 right-0 top-full z-30 mt-1 max-h-[320px] overflow-y-auto p-1.5"
        >
          <Option
            selected={!manual}
            busy={busyPid === "auto"}
            onSelect={() => void choose(null)}
            primary={AUTO_LABEL}
            secondary="Measures the app in the foreground and keeps it while you alt-tab."
          />
          <div className="my-1 flex items-center justify-between gap-2 px-2 pt-1">
            <span className="label-caps [--label-size:9.5px]">Presenting now</span>
            <button
              type="button"
              onClick={() => void refresh()}
              title="Refresh the list (F5)"
              aria-label="Refresh the list"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : undefined} aria-hidden="true" />
              Refresh
            </button>
          </div>
          {items == null && loading && (
            <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Reading apps…
            </div>
          )}
          {items != null && items.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-muted">No app is presenting frames right now.</div>
          )}
          {items?.map((p) => (
            <Option
              key={p.pid}
              selected={manual && target?.pid === p.pid}
              busy={busyPid === p.pid}
              onSelect={() => void choose(p.pid)}
              primary={`${p.process} · ${fmtFps(p.fps)} fps`}
              secondary={[p.windowTitle, p.runtime, p.presentMode, p.isForeground ? "foreground" : null, `PID ${p.pid}`]
                .filter(Boolean)
                .join(" · ")}
              icon={p.isForeground ? MonitorSmartphone : undefined}
            />
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11.5px] text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

interface OptionProps {
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  primary: string;
  secondary: string;
  icon?: typeof MonitorSmartphone;
}

function Option({ selected, busy, onSelect, primary, secondary, icon: Icon }: OptionProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      disabled={busy}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-teal/[0.1]" : "hover:bg-white/[0.05]",
      )}
    >
      <span className="mt-[2px] flex w-4 shrink-0 justify-center text-teal">
        {busy ? (
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        ) : selected ? (
          <Check size={13} aria-hidden="true" />
        ) : Icon ? (
          <Icon size={13} className="text-slate-500" aria-hidden="true" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="num block truncate text-[12.5px] text-ink">{primary}</span>
        <span className="block truncate text-[11px] text-slate-500" title={secondary}>
          {secondary}
        </span>
      </span>
    </button>
  );
}
