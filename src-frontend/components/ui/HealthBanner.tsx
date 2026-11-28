import type { HealthCondition } from "../../types";
import { cn } from "../../lib/format";
import { Button } from "./Button";
import { StatusIcon } from "./StatusPill";
import { STATUS_CLASS, type StatusTone } from "./tones";

// CONTRACT §4.7 / docs/design/SPEC.md §17.

export interface HealthBannerProps {
  alert: HealthCondition;
  /** Runs `alert.action` (the caller decides how: requestNavigate / api command). */
  onAction?: () => void;
  /** Shows a "Dismiss" button when given. */
  onDismiss?: () => void;
  /**
   * "inline" (default): in-page banner (radius 10, 1 px border; the title on its own line, the detail under it).
   * "bar": app-level banner under the toolbar (full-bleed, bottom border only, min-height 44, side
   * padding --page-pad-x; the title and the detail run on in one paragraph).
   */
  variant?: "inline" | "bar";
  /** Shows the action button as loading ("Try again" while the retry runs). */
  busy?: boolean;
  className?: string;
}

const TONE: Record<HealthCondition["severity"], StatusTone> = { crit: "crit", warn: "warn", info: "info" };

/**
 * Alert banner: tint, border and icon from the status tokens (warn = amber triangle, crit =
 * vermilion filled octagon, info = blue). The action is a small secondary button, never crimson.
 */
export function HealthBanner({ alert, onAction, onDismiss, variant = "inline", busy = false, className }: HealthBannerProps) {
  const tone = TONE[alert.severity] ?? "info";
  const c = STATUS_CLASS[tone];
  const bar = variant === "bar";
  return (
    <div
      role={alert.severity === "crit" ? "alert" : "status"}
      title={alert.rule || undefined}
      className={cn(
        "flex min-w-0 items-center",
        c.soft,
        c.border,
        bar ? "min-h-11 shrink-0 gap-2.5 border-b px-(--page-pad-x) py-1.5 text-callout" : "gap-3 rounded-lg border px-3.5 py-2.5 text-body",
        className,
      )}
    >
      <StatusIcon tone={tone} size={bar ? 17 : 18} />
      {bar ? (
        <p className="min-w-0 flex-1 text-ink-2">
          <span className="font-semibold text-ink">{alert.title}</span>
          {alert.detail ? <> {alert.detail}</> : null}
        </p>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{alert.title}</p>
          {alert.detail && <p className="text-callout text-ink-2">{alert.detail}</p>}
        </div>
      )}
      {alert.action && onAction && (
        <Button size="sm" variant="secondary" loading={busy} onClick={onAction}>
          {alert.action.label}
        </Button>
      )}
      {onDismiss && (
        <Button size="sm" variant="plain" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

export default HealthBanner;
