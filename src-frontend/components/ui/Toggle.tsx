import { useId, type ReactNode } from "react";
import { cn } from "../../lib/format";

// CONTRACT §4.7 / docs/design/SPEC.md §14. Graphite when on, outlined and hollow when off:
// the two states differ in shape, not only in colour. Never crimson, never green.

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

/**
 * Accessible switch (role="switch").
 *   no label               the bare switch
 *   label only             switch, then the label to its right (filter bars, SPEC §14)
 *   label + description    a settings row: text on the left, the switch on the right
 */
export function Toggle({ checked, onChange, label, description, disabled = false, id, className, ariaLabel }: ToggleProps) {
  const autoId = useId();
  const switchId = id ?? `toggle-${autoId}`;
  const descId = description != null ? `${switchId}-desc` : undefined;

  const sw = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label != null ? undefined : ariaLabel}
      aria-describedby={descId}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-[background-color,box-shadow] duration-(--dur-fast) ease-standard",
        checked ? "bg-control-on" : "bg-white shadow-[inset_0_0_0_1px_var(--color-control-border)]",
        disabled && "opacity-40",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-0 rounded-full transition-[translate,width,height,background-color] duration-(--dur-fast) ease-standard",
          checked
            ? "h-[14px] w-[14px] translate-x-4 translate-y-[2px] bg-white shadow-[0_1px_2px_var(--color-strong)]"
            : "h-3 w-3 translate-x-[3px] translate-y-[3px] bg-control-border",
        )}
      />
    </button>
  );

  if (label == null || label === false) return <span className={cn("inline-flex", className)}>{sw}</span>;

  if (description == null) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-[7px]", className)}>
        {sw}
        <label htmlFor={switchId} className={cn("min-w-0 truncate text-body", disabled ? "text-ink-disabled" : "text-ink")}>
          {label}
        </label>
      </span>
    );
  }

  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={switchId} className={cn("block text-body", disabled ? "text-ink-disabled" : "text-ink")}>
          {label}
        </label>
        <p id={descId} className="mt-px text-callout text-ink-2">
          {description}
        </p>
      </div>
      {sw}
    </div>
  );
}

export default Toggle;
