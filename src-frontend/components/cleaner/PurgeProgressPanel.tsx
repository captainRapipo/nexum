import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { cn, fmtBytes } from "../../lib/format";
import LedProgress from "./LedProgress";
import { fmtDuration, type PurgeEngineState } from "./purgeEngine";

/**
 * Live cleanup progress: step x/y, current category, running freed bytes, LED bar and a
 * per-category checklist driven by `purge-progress` events.
 */
export default function PurgeProgressPanel({ engine }: { engine: PurgeEngineState }) {
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

  const checklist = engine.plan;

  return (
    <div className="flex flex-col gap-6 py-2">
      <div className="flex flex-col items-center text-center">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-teal">
          <Sparkles size={13} className="animate-pulse" />
          Cleaning caches
        </div>
        <div className="mt-3 font-mono text-[44px] font-semibold leading-none text-ink tabular-nums">
          {fmtBytes(engine.freedSoFar, 2)}
        </div>
        <div className="mt-1.5 text-[12px] text-muted">freed so far</div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="truncate text-silver">
            {p ? (
              <>
                Cleaning <span className="font-semibold text-ink">{p.label}</span>
              </>
            ) : (
              "Preparing…"
            )}
          </span>
          <span className="shrink-0 font-mono text-muted">
            {p ? `Step ${step}/${total}` : `0/${total}`} · {fmtDuration(elapsed)}
          </span>
        </div>
        <LedProgress value={pct} segments={40} tone="teal" height={12} />
      </div>

      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {checklist.map((c) => {
          const done = engine.completed.includes(c.id);
          const active = !done && c.id === currentId && engine.running;
          return (
            <li
              key={c.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] transition-colors",
                active
                  ? "border-teal/45 bg-teal/[0.07] text-ink"
                  : done
                    ? "border-teal/30 bg-teal/[0.05] text-silver"
                    : "border-line text-muted",
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {active ? (
                  <Loader2 size={14} className="animate-spin text-teal" />
                ) : done ? (
                  <Check size={14} className="text-teal" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                )}
              </span>
              <span className="truncate">{c.label}</span>
            </li>
          );
        })}
      </ul>

      <p className="text-center text-[11px] text-muted">
        Files in use are skipped, never forced. Protected system paths are never touched.
      </p>
    </div>
  );
}
