import { X } from "lucide-react";
import type { HealthCondition } from "../../types";
import { cn } from "../../lib/format";
import { renderIcon } from "./icon";
import { STATUS_ICON } from "./StatusPill";

export interface HealthBannerProps {
  alert: HealthCondition;
  /** Runs `alert.action` (the caller decides how: requestNavigate / api command). */
  onAction?: () => void;
  /** Shows a "Dismiss" button when given. */
  onDismiss?: () => void;
  className?: string;
}

const SEVERITY_STYLE = {
  crit: { wrap: "border-crit/50 bg-crit/[0.09]", icon: "text-rose-400", tone: "crit" as const },
  warn: { wrap: "border-warn/45 bg-warn/[0.08]", icon: "text-warn", tone: "warn" as const },
  info: { wrap: "border-cyan/35 bg-cyan/[0.06]", icon: "text-cyan", tone: "info" as const },
};

/** Full-width alert bar: warn = amber, crit = rose, info = cyan (CONTRACT §4.7). */
export function HealthBanner({ alert, onAction, onDismiss, className }: HealthBannerProps) {
  const s = SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.info;
  return (
    <div
      role={alert.severity === "crit" ? "alert" : "status"}
      title={alert.rule}
      className={cn("flex min-w-0 items-center gap-3 rounded-xl border px-4 py-2.5 text-[12.5px]", s.wrap, className)}
    >
      <span className={cn("shrink-0", s.icon)}>{renderIcon(STATUS_ICON[s.tone], 16)}</span>
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-ink">{alert.title}</span>
        {alert.detail && <span className="ml-2 text-slate-300">{alert.detail}</span>}
      </div>
      {alert.action && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-white/[0.09]"
        >
          {alert.action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
        >
          <X size={13} aria-hidden="true" />
          Dismiss
        </button>
      )}
    </div>
  );
}

export default HealthBanner;
