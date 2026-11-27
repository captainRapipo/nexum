import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";

export type ButtonVariant = "gold" | "ghost" | "teal" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon: element or lucide component. */
  icon?: IconLike;
  /** Trailing icon. */
  iconRight?: IconLike;
  /** Show a spinner and disable the button. */
  loading?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  gold:
    "border-gold/60 bg-gold/[0.07] text-gold shadow-[0_0_18px_-8px_rgba(212,163,89,0.7)] " +
    "hover:border-gold hover:bg-gold/[0.13] hover:text-[#e8bf7d] hover:shadow-[0_0_24px_-6px_rgba(212,163,89,0.75)] " +
    "active:bg-gold/[0.18]",
  teal:
    "border-teal/50 bg-teal/[0.08] text-teal shadow-[0_0_18px_-8px_rgba(45,212,191,0.6)] " +
    "hover:border-teal hover:bg-teal/[0.14] hover:text-[#5eead4] hover:shadow-[0_0_24px_-6px_rgba(45,212,191,0.7)] " +
    "active:bg-teal/[0.2]",
  ghost:
    "border-transparent bg-transparent text-slate-300 " +
    "hover:border-line hover:bg-white/[0.05] hover:text-ink active:bg-white/[0.08]",
  danger:
    "border-rose/55 bg-rose/[0.07] text-rose-400 shadow-[0_0_18px_-8px_rgba(225,29,72,0.65)] " +
    "hover:border-rose hover:bg-rose/[0.14] hover:text-rose-300 active:bg-rose/[0.2]",
};

const SIZES: Record<ButtonSize, { base: string; square: string; icon: number }> = {
  sm: { base: "h-7 gap-1.5 px-2.5 text-[11.5px] rounded-md", square: "h-7 w-7 rounded-md", icon: 14 },
  md: { base: "h-9 gap-2 px-3.5 text-[12.5px] rounded-lg", square: "h-9 w-9 rounded-lg", icon: 16 },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", icon, iconRight, loading = false, disabled, className, children, type, ...rest },
  ref,
) {
  const s = SIZES[size];
  const iconOnly = children == null || children === false || children === "";
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap border font-semibold tracking-[0.02em]",
        "transition-[background-color,border-color,color,box-shadow,opacity] duration-150",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        iconOnly ? s.square : s.base,
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={s.icon} className="animate-spin" aria-hidden="true" /> : renderIcon(icon, s.icon)}
      {!iconOnly && children}
      {!loading && renderIcon(iconRight, s.icon)}
    </button>
  );
});

export default Button;
