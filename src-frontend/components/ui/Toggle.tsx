import { useId, type ReactNode } from "react";
import { cn } from "../../lib/format";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Accessible name when no visible `label` is rendered. */
  ariaLabel?: string;
}

/** Accessible switch (role="switch"). With a label it renders as a full settings row. */
export function Toggle({ checked, onChange, label, description, disabled = false, id, className, ariaLabel }: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? `toggle-${autoId}`;
  const descId = description ? `${switchId}-desc` : undefined;

  const sw = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={descId}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200",
        checked
          ? "border-teal/60 bg-teal/25 shadow-[0_0_12px_-2px_rgba(45,212,191,0.55)]"
          : "border-white/[0.12] bg-white/[0.05]",
        disabled && "opacity-40",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-[2px] size-[14px] rounded-full transition-transform duration-200",
          checked ? "translate-x-4 led-teal" : "translate-x-0 bg-slate-500",
        )}
      />
    </button>
  );

  if (!label) return <span className={className}>{sw}</span>;

  return (
    <div className={cn("flex items-center justify-between gap-4", disabled && "opacity-70", className)}>
      <div className="min-w-0">
        <label htmlFor={switchId} className={cn("block text-[13px] text-slate-200", !disabled && "cursor-pointer")}>
          {label}
        </label>
        {description && (
          <p id={descId} className="mt-0.5 text-[11.5px] leading-snug text-muted">
            {description}
          </p>
        )}
      </div>
      {sw}
    </div>
  );
}

export default Toggle;
