// Shared controls new in 1.2 (CONTRACT §4.7; docs/design/SPEC.md §9, §11, §14, §15, §20, §21). Owner: P.
// Every control here is graphite: none of them ever uses the brand crimson or a status colour for
// its own state (the only status colour is the critical outline of an invalid text field).
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { clamp, cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";
import { StatusIcon } from "./StatusPill";

/* ------------------------------------------------------------------ */
/* Tag (SPEC §21): a neutral label. A tag never conveys health.         */
/* ------------------------------------------------------------------ */

export interface TagProps {
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Tag({ children, title, className }: TagProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] bg-tag px-1.5 text-[10.5px] font-semibold leading-none tracking-[0.01em] text-ink-2 [&>svg]:h-[11px] [&>svg]:w-[11px]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Checkbox (SPEC §14): 15 x 15, outlined when off, graphite when on.   */
/* ------------------------------------------------------------------ */

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Mixed state (some of a group selected); shown as a dash. */
  indeterminate?: boolean;
  id?: string;
  className?: string;
  /** Accessible name when no visible `label` is rendered. */
  ariaLabel?: string;
}

export function Checkbox({ checked, onChange, label, disabled = false, indeterminate = false, id, className, ariaLabel }: CheckboxProps) {
  const autoId = useId();
  const boxId = id ?? `checkbox-${autoId}`;
  const on = checked || indeterminate;
  const box = (
    <button
      id={boxId}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label != null ? undefined : ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-xs transition-[background-color,box-shadow] duration-(--dur-instant)",
        on ? "bg-control-on" : "bg-white shadow-[inset_0_0_0_1px_var(--color-control-border)]",
        disabled && "opacity-40",
      )}
    >
      {on && (
        <svg width={15} height={15} viewBox="0 0 15 15" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {indeterminate ? <path d="M4.2 7.5h6.6" /> : <path d="M4 7.7l2.4 2.4L11 5.2" />}
        </svg>
      )}
    </button>
  );
  if (label == null || label === false) return <span className={cn("inline-flex", className)}>{box}</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-[7px]", className)}>
      {box}
      <label htmlFor={boxId} className={cn("min-w-0 truncate text-body", disabled ? "text-ink-disabled" : "text-ink")}>
        {label}
      </label>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* TextField (SPEC §11): 28 px, white, 1 px graphite-grey outline.      */
/* ------------------------------------------------------------------ */

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** Leading icon (14 px, tertiary). */
  icon?: IconLike;
  /** Trailing key hint, e.g. "Ctrl K". */
  kbd?: string;
  /** Critical outline; pair with `message`. */
  invalid?: boolean;
  /** Line under the field (critical text with the octagon when `invalid`). */
  message?: ReactNode;
  /** JetBrains Mono 12 px, for identifiers such as "name.exe". */
  mono?: boolean;
  /** Class of the outer wrapper (width goes here). */
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}

export function TextField({ value, onChange, icon, kbd, invalid = false, message, mono = false, className, inputRef, disabled, ...rest }: TextFieldProps) {
  const autoId = useId();
  const msgId = message != null ? `field-${autoId}-msg` : undefined;
  return (
    <span className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <span
        className={cn(
          "flex h-7 min-w-0 items-center gap-[7px] rounded-sm px-[9px] transition-shadow duration-(--dur-instant)",
          disabled
            ? "bg-disabled shadow-[inset_0_0_0_1px_var(--color-subtle)]"
            : cn(
                "bg-white",
                // The focus ring sits outside the outline, and the outline itself turns graphite.
                "has-[input:focus-visible]:shadow-[inset_0_0_0_1px_var(--color-control-on)] has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-1 has-[input:focus-visible]:outline-control-on",
                invalid ? "shadow-[inset_0_0_0_1px_var(--color-crit-icon)]" : "shadow-[inset_0_0_0_1px_var(--color-control-border)]",
              ),
        )}
      >
        {icon != null && <span className={cn("flex shrink-0 items-center", disabled ? "text-ink-disabled" : "text-ink-3")}>{renderIcon(icon, 14)}</span>}
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={msgId}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none disabled:text-ink-disabled disabled:placeholder:text-ink-disabled",
            mono ? "font-mono text-[12px]" : "text-body",
          )}
          {...rest}
        />
        {kbd != null && <kbd className="kbd shrink-0 whitespace-nowrap">{kbd}</kbd>}
      </span>
      {message != null && (
        <span id={msgId} className={cn("flex items-center gap-1 text-callout", invalid ? "text-crit" : "text-ink-2")}>
          {invalid && <StatusIcon tone="crit" size={13} />}
          {message}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* IconButton (SPEC §1): 30 x 28 toolbar / card-header button.          */
/* ------------------------------------------------------------------ */

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconLike;
  /** Tooltip and accessible name (required: there is no visible text). */
  label: string;
  /** Pressed / open state (neutral selected background). */
  active?: boolean;
  /** Shows a spinner instead of the icon and blocks clicks. */
  loading?: boolean;
  /** Spins the icon itself (Rescan while a scan runs). */
  spin?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, active = false, loading = false, spin = false, disabled, className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "inline-flex h-7 w-[30px] shrink-0 items-center justify-center rounded-btn transition-colors duration-(--dur-instant)",
        disabled && !loading ? "text-ink-disabled" : "text-icon enabled:hover:bg-hover enabled:active:bg-pressed",
        active && "bg-selected",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={17} className="animate-spin" aria-hidden="true" />
      ) : (
        <span className={cn("flex items-center", spin && "animate-spin")}>{renderIcon(icon, 17)}</span>
      )}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Slider (SPEC §15): 4 px track, graphite fill, 16 px white thumb.     */
/* ------------------------------------------------------------------ */

export interface SliderProps {
  value: number;
  /** Fires while dragging and on every key step. */
  onChange: (value: number) => void;
  /** Fires when the drag or key press ends (send the command here). */
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

/**
 * A native range input (keyboard, pointer and screen-reader behaviour for free) under a drawn
 * track and thumb. The drawn thumb travels the same 8 px-inset path as the native one, so a click
 * lands where the thumb is. Arrows move one step, Page Up / Page Down a tenth of the range.
 * Label the two ends under the slider in tertiary callout text where the range is not obvious.
 */
export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, disabled = false, ariaLabel, className }: SliderProps) {
  const span = max - min || 1;
  const frac = clamp((value - min) / span, 0, 1);
  const thumbLeft = `calc(${frac} * (100% - 16px))`;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Page Up / Page Down move a tenth of the range (the native default is browser-dependent).
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    const next = clamp(value + (e.key === "PageUp" ? 1 : -1) * Math.max(step, span / 10), min, max);
    onChange(next);
    onCommit?.(next);
  };
  return (
    <span className={cn("relative flex h-4 w-full items-center", className)}>
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-1 rounded-[2px] bg-slider-track" />
      <span
        aria-hidden="true"
        className={cn("pointer-events-none absolute left-0 h-1 rounded-[2px]", disabled ? "bg-ink-disabled" : "bg-control-on")}
        style={{ width: `calc(${thumbLeft} + 8px)` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyDown={onKeyDown}
        className="peer absolute inset-0 m-0 h-full w-full cursor-default opacity-0"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute h-4 w-4 rounded-full bg-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-control-on",
          disabled
            ? "shadow-[0_0_0_1px_var(--color-strong),0_1px_2px_var(--color-subtle)]"
            : "shadow-[0_0_0_1px_var(--color-control-border),0_1px_3px_var(--color-strong)]",
        )}
        style={{ left: thumbLeft }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* EmptyState (SPEC §20)                                                */
/* ------------------------------------------------------------------ */

export interface EmptyStateProps {
  icon: IconLike;
  title: ReactNode;
  body?: ReactNode;
  /** Secondary note in tertiary text. */
  note?: ReactNode;
  /** At most one button (the screen's primary, size "lg"). Omit for "no results". */
  action?: ReactNode;
  /** Optional row of "what you'll get" tiles. */
  children?: ReactNode;
  className?: string;
}

/** Centred in whatever height its parent gives it (it fills the parent and centres its content). */
export function EmptyState({ icon, title, body, note, action, children, className }: EmptyStateProps) {
  return (
    <div className={cn("mx-auto flex min-h-full w-full max-w-[640px] flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-[18px] bg-card text-icon-2 shadow-card">{renderIcon(icon, 34)}</span>
      <h2 className="mt-5 text-[22px] font-semibold leading-7 tracking-[-0.015em] text-ink">{title}</h2>
      {body != null && <div className="mt-2.5 text-[14px] leading-[21px] text-ink-2 [text-wrap:balance]">{body}</div>}
      {note != null && <div className="mt-2.5 max-w-[520px] text-callout text-ink-3 [text-wrap:balance]">{note}</div>}
      {action != null && <div className="mt-[22px]">{action}</div>}
      {children != null && <div className="mt-11 w-full">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* InkLink (SPEC §9): ink text + grey chevron. Never red, never blue.   */
/* ------------------------------------------------------------------ */

export interface InkLinkProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Trailing chevron. Default true. */
  chevron?: boolean;
}

export function InkLink({ chevron = true, className, children, type, ...rest }: InkLinkProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn("link-ink shrink-0 whitespace-nowrap rounded-xs text-[12px] leading-none disabled:text-ink-disabled disabled:no-underline", className)}
      {...rest}
    >
      {children}
      {chevron && <ChevronRight strokeWidth={2} aria-hidden="true" />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* ProgressBar: 4 px graphite bar (update download, cleanup progress).  */
/* ------------------------------------------------------------------ */

export interface ProgressBarProps {
  /** 0–100, or null when the amount is unknown (same as `indeterminate`). */
  value: number | null;
  indeterminate?: boolean;
  /** Accessible name. */
  label?: string;
  className?: string;
}

export function ProgressBar({ value, indeterminate = false, label, className }: ProgressBarProps) {
  const unknown = indeterminate || value == null || !Number.isFinite(value);
  const v = unknown ? 0 : clamp(value as number, 0, 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={unknown ? undefined : Math.round(v)}
      className={cn("relative h-1 w-full overflow-hidden rounded-[2px] bg-meter-track", className)}
    >
      {unknown ? (
        // 40 % wide: the sweep keyframes move it by 250 % of its own width, which is exactly one track length.
        <span className="absolute inset-y-0 left-0 w-2/5 animate-sweep rounded-[2px] bg-meter-fill" />
      ) : (
        <span className="absolute inset-y-0 left-0 rounded-[2px] bg-meter-fill transition-[width] duration-(--dur-base) ease-standard" style={{ width: `${v}%` }} />
      )}
    </div>
  );
}
