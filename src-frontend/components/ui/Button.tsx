import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";

// CONTRACT §4.7 / docs/design/SPEC.md §12.

/**
 * primary     crimson: at most ONE per screen (the default button of a dialog or sheet, or the single
 *             call to action of an empty state)
 * secondary   white with a hairline ring: the default
 * destructive white with critical text: irreversible removals outside a confirmed flow
 * plain       no chrome until hovered
 * The 1.1 names are aliases: gold and teal → secondary, ghost → plain, danger → destructive.
 * "gold" does NOT map to primary: crimson needs an explicit variant="primary".
 */
export type ButtonVariant = "primary" | "secondary" | "destructive" | "plain" | "gold" | "ghost" | "teal" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Default "secondary". */
  variant?: ButtonVariant;
  /** sm 24 px, md 28 px (default), lg 32 px. */
  size?: ButtonSize;
  /** Leading icon: element or lucide component. */
  icon?: IconLike;
  /** Trailing icon. */
  iconRight?: IconLike;
  /** Show a spinner and block clicks. The button keeps its look (it is busy, not unavailable). */
  loading?: boolean;
}

type Canonical = "primary" | "secondary" | "destructive" | "plain";

const ALIAS: Record<ButtonVariant, Canonical> = {
  primary: "primary",
  secondary: "secondary",
  destructive: "destructive",
  plain: "plain",
  gold: "secondary",
  teal: "secondary",
  ghost: "plain",
  danger: "destructive",
};

/** Resting look plus hover / press. `enabled:` keeps a disabled or busy button from reacting. */
const VARIANTS: Record<Canonical, string> = {
  primary: "bg-brand text-white shadow-primary enabled:hover:bg-brand-hover enabled:active:bg-brand-pressed",
  secondary: "bg-white text-ink shadow-control enabled:hover:bg-row-alt enabled:active:bg-sidebar",
  destructive: "bg-white text-crit shadow-control enabled:hover:bg-crit-bg enabled:active:bg-crit-bg",
  plain: "bg-transparent text-ink enabled:hover:bg-hover enabled:active:bg-pressed",
};

/** Disabled look (SPEC §12): a flat grey plate with a faint outline and disabled text; the plain variant only greys its text. */
const DISABLED: Record<Canonical, string> = {
  primary: "bg-disabled text-ink-disabled shadow-control-disabled",
  secondary: "bg-disabled text-ink-disabled shadow-control-disabled",
  destructive: "bg-disabled text-ink-disabled shadow-control-disabled",
  plain: "bg-transparent text-ink-disabled",
};

/** Icon colour while enabled: slightly softer than the label, white on crimson, vermilion on destructive. */
const ICON_TONE: Record<Canonical, string> = {
  primary: "text-white",
  secondary: "text-icon",
  destructive: "text-crit-icon",
  plain: "text-icon",
};

const SIZES: Record<ButtonSize, { base: string; plain: string; square: string; icon: number }> = {
  sm: { base: "h-6 px-2.5 text-[12px] rounded-sm", plain: "h-6 px-2 text-[12px] rounded-sm", square: "h-6 w-6 rounded-sm", icon: 13 },
  md: { base: "h-7 px-3 text-[13px] rounded-btn", plain: "h-7 px-2 text-[13px] rounded-btn", square: "h-7 w-7 rounded-btn", icon: 15 },
  lg: { base: "h-8 px-4 text-[13px] rounded-[8px]", plain: "h-8 px-2 text-[13px] rounded-[8px]", square: "h-8 w-8 rounded-[8px]", icon: 15 },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, loading = false, disabled, className, children, type, ...rest },
  ref,
) {
  const kind = ALIAS[variant] ?? "secondary";
  const s = SIZES[size] ?? SIZES.md;
  const iconOnly = children == null || children === false || children === "";
  const off = Boolean(disabled) && !loading;
  // The wrapper carries the icon colour, so an icon that brings its own colour class keeps it.
  const iconCls = cn("flex shrink-0 items-center", !off && ICON_TONE[kind]);
  const lead = loading ? <Loader2 size={s.icon} className="animate-spin" aria-hidden="true" /> : renderIcon(icon, s.icon);
  const trail = loading ? null : renderIcon(iconRight, s.icon);
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={kind}
      className={cn(
        "tnum inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium leading-none",
        "transition-[background-color,color,box-shadow] duration-(--dur-instant)",
        off ? DISABLED[kind] : VARIANTS[kind],
        iconOnly ? s.square : kind === "plain" ? s.plain : s.base,
        className,
      )}
      {...rest}
    >
      {lead != null && <span className={iconCls}>{lead}</span>}
      {!iconOnly && children}
      {trail != null && <span className={iconCls}>{trail}</span>}
    </button>
  );
});

export default Button;
