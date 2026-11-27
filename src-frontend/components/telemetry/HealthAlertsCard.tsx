import { AlertTriangle, CheckCircle2, HeartPulse, Info, OctagonAlert, type LucideIcon } from "lucide-react";
import { ScrollFade, STATUS_CLASS, type StatusTone } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useHealth } from "../../hooks/useHealth";
import { alertState } from "../../lib/status";
import { cn } from "../../lib/format";
import type { HealthCondition } from "../../types";
import { runHealthAction } from "./healthActions";

const ICON: Record<StatusTone, LucideIcon> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  crit: OctagonAlert,
  info: Info,
  unknown: Info,
};

/**
 * Health alerts (MF-6, CONTRACT §5.4): every active condition from `deriveHealth`, worst first, with its
 * rule on hover. Replaces the old "Thermal & Load Index", which had no definition.
 */
export default function HealthAlertsCard() {
  const health = useHealth();
  const conditions = health.conditions;

  return (
    <GlassCard
      title="Health alerts"
      icon={<HeartPulse size={14} />}
      accent="silver"
      actions={
        conditions.length > 0 ? (
          <span className="font-mono text-[10.5px] text-muted">{conditions.length}</span>
        ) : undefined
      }
    >
      {conditions.length === 0 ? (
        <div>
          <div className={cn("flex items-center gap-2 text-[12.5px] font-medium", STATUS_CLASS.ok.text)}>
            <CheckCircle2 size={14} aria-hidden="true" />
            No active alerts
          </div>
          <div className="mt-2 text-[10.5px] uppercase tracking-[0.16em] text-muted">Checked rules</div>
          <ScrollFade className="mt-1 pr-1" maxHeight={150}>
            <ul className="flex flex-col gap-1">
              {health.rules.map((r) => (
                <li key={r} className="text-[11px] leading-snug text-muted">
                  {r}
                </li>
              ))}
            </ul>
          </ScrollFade>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {conditions.map((c) => (
            <AlertRow key={c.id} condition={c} />
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

function AlertRow({ condition: c }: { condition: HealthCondition }) {
  const tone = alertState(c.severity);
  const Icon = ICON[tone];
  const cls = STATUS_CLASS[tone];
  return (
    <li className={cn("rounded-lg border px-2.5 py-2", cls.border, cls.soft)} title={`Rule: ${c.rule}`}>
      <div className="flex items-start gap-2">
        <Icon size={14} className={cn("mt-px shrink-0", cls.text)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold leading-snug text-ink">{c.title}</div>
          <div className="mt-0.5 text-[11px] leading-snug text-silver">{c.detail}</div>
          {c.action && (
            <button
              type="button"
              onClick={() => runHealthAction(c.action!)}
              className={cn(
                "mt-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition hover:bg-white/[0.06]",
                cls.border,
                cls.text,
              )}
            >
              {c.action.label}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
