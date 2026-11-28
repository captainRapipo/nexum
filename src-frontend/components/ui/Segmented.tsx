import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/format";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** [NEW 1.2] Count shown after the label in tertiary text ("Display 12"). */
  count?: number;
}

export interface SegmentedProps<T extends string | number> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** "sm" and "md": 22 px segments. "lg" (view tabs): 26 px, 13 px text. */
  size?: "sm" | "md" | "lg";
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Segmented control (radiogroup with arrow-key navigation). CONTRACT §4.7 / docs/design/SPEC.md §13:
 * grey track, the selected segment is graphite with white 600 text (never crimson). `size="lg"` is the
 * view-tab look (System, Cooling).
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
  ariaLabel,
  className,
  disabled = false,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + dir * k + n) % n;
      if (!options[i].disabled) {
        onChange(options[i].value);
        refs.current[i]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    }
  };

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[8px] bg-seg-track p-0.5",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            ref={(node) => {
              refs.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            disabled={disabled || o.disabled}
            tabIndex={i === selectedIndex ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "tnum inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm leading-none",
              "transition-[background-color,color,box-shadow] duration-(--dur-fast) ease-standard",
              size === "lg" ? "h-[26px] px-3.5 text-[13px]" : "h-[22px] px-2.5 text-[12px]",
              active ? "bg-control-on font-semibold text-white shadow-[0_1px_2px_var(--color-strong)]" : "font-medium text-ink enabled:hover:bg-fill/5",
              o.disabled && "opacity-40",
            )}
          >
            {o.label}
            {o.count != null && <span className={cn("font-medium", active ? "text-seg-count" : "text-ink-3")}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
