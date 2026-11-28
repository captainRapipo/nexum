import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn, fmtBytes } from "../../lib/format";
import { StatusIcon } from "../ui";
import LedProgress from "./LedProgress";
import { splitAmount } from "./cleanerCopy";
import { fmtDuration, type PurgeEngineState } from "./purgeEngine";

/**
 * Live cleanup progress: the running total, step x of y with the current category, a 4 px bar and
 * a per-category checklist driven by `purge-progress` events.
 */
export default function PurgeProgressPanel({ engine, compact = false }: { engine: PurgeEngineState; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!engine.running) return;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [engine.running]);

  const p = engine.progress;
  const total = p?.totalSteps && p.totalSteps > 0 ? p.totalSteps : Math.max(1, engine.plan.length);
  const step = p ? Math.max(0, Math.min(total, p.step)) : 0;
  const doneCount = engine.completed.length;
  const inFlight = engine.touched.some((id) => !engine.completed.includes(id)) ? 0.5 : 0;
  const pct = p ? Math.min(100, ((doneCount + inFlight) / total) * 100) : null;
  const elapsed = engine.startedAt ? now - engine.startedAt : 0;
  const currentId = p?.categoryId ?? null;
  const [amount, unit] = splitAmount(fmtBytes(engine.freedSoFar, 2));

  return (
    <div className={cn("flex flex-col", compact ? "gap-3.5 py-1" : "gap-5 px-(--card-pad-x) pb-(--card-pad-y) pt-2")}>
      <div>
        <div className="text-[12.5px] font-medium leading-[17px] text-ink-2">Freed so far</div>
        <div className={cn("tnum mt-1 font-semibold text-ink", compact ? "text-display" : "text-[52px] leading-[56px] tracking-[-0.035em]")}>
          {amount}
          <small className={cn("ml-[5px] font-medium leading-none tracking-normal text-ink-2", compact ? "text-[16px]" : "text-[20px]")}>{unit}</small>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3 text-callout">
          <span className="min-w-0 truncate text-ink-2">
            {p ? (
              <>
                Cleaning <span className="font-semibold text-ink">{p.label}</span>
              </>
            ) : (
              "Preparing…"
            )}
          </span>
          <span className="tnum shrink-0 text-ink-3">
            {p ? `Step ${step} of ${total}` : `0 of ${total}`} · {fmtDuration(elapsed)}
          </span>
        </div>
        <LedProgress value={pct} label="Cleanup progress" />
      </div>

      <ul className={cn("grid gap-x-6", compact ? "grid-cols-1" : "grid-cols-2")}>
        {engine.plan.map((c) => {
          const done = engine.completed.includes(c.id);
          const active = !done && c.id === currentId && engine.running;
          return (
            <li key={c.id} className="flex h-7 items-center gap-2 border-b border-divider text-body">
              <span className="flex size-4 shrink-0 items-center justify-center">
                {active ? (
                  <Loader2 size={14} className="animate-spin text-ink-2" aria-hidden="true" />
                ) : done ? (
                  <StatusIcon tone="ok" size={14} />
                ) : (
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-control-border" />
                )}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", active ? "font-medium text-ink" : done ? "text-ink" : "text-ink-2")}>{c.label}</span>
              <span className="shrink-0 text-callout text-ink-3">{active ? "Cleaning" : done ? "Done" : "Waiting"}</span>
            </li>
          );
        })}
      </ul>

      <p className="text-callout text-ink-3">Files in use are skipped, never forced. Protected system paths are never touched.</p>
    </div>
  );
}
