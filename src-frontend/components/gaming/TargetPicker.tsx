import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
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
  /** Incremented by the view on F5 (and by its Refresh control): reads the list again. */
  refreshSignal: number;
  /** Capture is running (the list is empty otherwise). */
  running: boolean;
  className?: string;
}

const AUTO_LABEL = "Auto (foreground game)";
const AUTO_TITLE = "Measures the app in the foreground and keeps it while you alt-tab.";

/**
 * Target picker (CONTRACT §4.10.1): `Auto (foreground game)` plus the apps PresentMon currently sees
 * presenting frames, as one radio list. The list is read when the page opens, when the measured app
 * changes and on F5. Choosing an app pins it.
 */
export default function TargetPicker({ target, listPresenting, setTarget, refreshSignal, running, className }: TargetPickerProps) {
  const [items, setItems] = useState<PresentingProcess[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPid, setBusyPid] = useState<number | "auto" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

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

  // Read on open, on F5 (refreshSignal), when capture starts and when the measured app changes.
  const targetPid = target?.pid ?? null;
  useEffect(() => {
    if (running) void refresh();
    else {
      reqId.current++;
      setItems(null);
      setLoading(false);
    }
    return () => {
      reqId.current++;
    };
  }, [running, refreshSignal, targetPid, refresh]);

  const choose = async (pid: number | null) => {
    if (busyPid != null) return;
    setBusyPid(pid ?? "auto");
    setError(null);
    try {
      await setTarget(pid);
    } catch (e) {
      setError(errorMessage(e));
      void refresh();
    } finally {
      setBusyPid(null);
    }
  };

  // Arrow keys move between the rows, as in a native radio list.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || rows.length === 0) return;
    e.preventDefault();
    rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
  };

  const manual = target?.reason === "manual";
  const hasTarget = target != null && target.reason !== "none" && target.pid != null;
  const autoNow = !manual && hasTarget ? (target.process ?? `PID ${target.pid}`) : "";
  // A pinned app that the list does not hold (not read yet, or it stopped presenting) still gets its row.
  const pinnedMissing = manual && hasTarget && !(items ?? []).some((p) => p.pid === target.pid);

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div ref={groupRef} role="radiogroup" aria-label="App to measure" onKeyDown={onKeyDown} className="flex max-h-[204px] flex-col overflow-y-auto tight:max-h-[180px]">
        <Row
          selected={!manual}
          busy={busyPid === "auto"}
          disabled={!running}
          onSelect={() => (manual ? void choose(null) : undefined)}
          primary={AUTO_LABEL}
          secondary={autoNow}
          title={running ? AUTO_TITLE : "Frame capture is not running"}
        />
        {pinnedMissing && (
          <Row selected busy={false} disabled={!running} onSelect={() => undefined} primary={target.process ?? `PID ${target.pid}`} secondary="" title={`PID ${target.pid}`} />
        )}
        {items?.map((p) => {
          const selected = manual && target?.pid === p.pid;
          return (
            <Row
              key={p.pid}
              selected={selected}
              busy={busyPid === p.pid}
              disabled={!running}
              onSelect={() => (selected ? undefined : void choose(p.pid))}
              primary={p.process}
              secondary={`${fmtFps(p.fps)} fps`}
              title={[p.windowTitle, p.runtime, p.presentMode, p.isForeground ? "foreground" : null, `PID ${p.pid}`].filter(Boolean).join(" · ")}
            />
          );
        })}
      </div>

      {running && items == null && loading && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 text-callout text-ink-3">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Reading apps…
        </div>
      )}
      {running && items != null && items.length === 0 && (
        <div className="px-2.5 py-1.5 text-callout text-ink-3">No app is presenting frames right now.</div>
      )}

      <p className="mx-2.5 mt-1.5 text-callout text-ink-3" aria-live="polite">
        {targetReasonText(target)}
      </p>
      {error && (
        <p role="alert" className="mx-2.5 mt-1 text-callout text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

interface RowProps {
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
  primary: string;
  secondary: string;
  title: string;
}

function Row({ selected, busy, disabled, onSelect, primary, secondary, title }: RowProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled || busy}
      title={title}
      className={cn(
        "focus-inset flex h-[34px] w-full min-w-0 shrink-0 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-body transition-colors duration-[80ms] tight:h-[30px]",
        selected ? "bg-selected" : "hover:bg-hover active:bg-pressed",
        disabled && "text-ink-disabled",
      )}
    >
      {busy ? (
        <Loader2 size={15} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-[15px] shrink-0 rounded-full bg-white",
            selected ? "shadow-[inset_0_0_0_4.5px_var(--color-control-on)]" : "shadow-[inset_0_0_0_1px_var(--color-control-border)]",
          )}
        />
      )}
      <span className={cn("min-w-0 flex-1 truncate font-medium", !disabled && "text-ink")}>{primary}</span>
      {secondary && <span className="tnum shrink-0 text-ink-2">{secondary}</span>}
    </button>
  );
}
