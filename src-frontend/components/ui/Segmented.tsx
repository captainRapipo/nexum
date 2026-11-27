import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/format";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string | number> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

/** Segmented control (radiogroup with arrow-key navigation). */
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
        "inline-flex items-center gap-0.5 rounded-lg border border-line bg-black/25 p-0.5",
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
              "num rounded-md font-semibold transition-[background-color,color,box-shadow] duration-150",
              size === "sm" ? "h-6 px-2.5 text-[11px]" : "h-7 px-3 text-[12px]",
              active
                ? "bg-teal/[0.14] text-teal shadow-[inset_0_0_0_1px_rgba(45,212,191,0.45),0_0_14px_-4px_rgba(45,212,191,0.6)]"
                : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-200",
              o.disabled && "opacity-40",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
