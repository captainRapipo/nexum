import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/format";
import type { IconLike } from "../ui/icon";
import type { Tone } from "../ui/tones";

// CONTRACT §4.7 / docs/design/SPEC.md §6. Owner: P. The 1.1 name is kept; it is a plain white card now.

export type GlassAccent = Tone;

export interface GlassCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Card title, sentence case (15/20 semibold). A node may add a tag or chip after the text. */
  title?: ReactNode;
  /** Callout line under the title. */
  subtitle?: ReactNode;
  /** Right side of the header: ONE of a callout meta, an ink link, a tag or a small button (or a short row of them). */
  actions?: ReactNode;
  /** Footer line: top divider, pushed to the bottom, callout text. Ends a card at a summary instead of whitespace. */
  footer?: ReactNode;
  /** false = no body padding (the body is a flush table or list; it is clipped to the card's corners). Default true. */
  padded?: boolean;
  /** Neutral selected look (1 px ink + 3 px grey ring). Never crimson. */
  selected?: boolean;
  /** Ignored since 1.2 (cards have no title icon). Kept so call sites compile. */
  icon?: IconLike;
  /** Ignored since 1.2 (cards have no accent bar). Kept so call sites compile. */
  accent?: GlassAccent;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/**
 * The card: white, radius 14, soft shadow, no border, padding 16 × 20. The header renders only when
 * a title or actions are given. The body takes the remaining height, so a `footer` always sits at
 * the bottom edge.
 */
export function GlassCard({
  title,
  subtitle,
  actions,
  footer,
  padded = true,
  selected = false,
  icon: _icon,
  accent: _accent,
  className,
  bodyClassName,
  children,
  ...rest
}: GlassCardProps) {
  const hasHeader = title != null || actions != null;
  const plainTitle = typeof title === "string" || typeof title === "number";
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col rounded-card bg-card forced-colors:border",
        selected ? "shadow-selected" : "shadow-card",
        !padded && "overflow-hidden",
        className,
      )}
      {...rest}
    >
      {hasHeader && (
        <header
          className={cn(
            "flex min-h-[22px] shrink-0 gap-3 px-(--card-pad-x) pt-(--card-pad-y) pb-3 box-content",
            subtitle != null ? "items-start" : "items-center",
          )}
        >
          <div className="min-w-0 flex-1">
            {title != null && (
              <h3 className="flex min-w-0 items-center gap-2 whitespace-nowrap text-title-2 text-ink">
                {plainTitle ? <span className="truncate">{title}</span> : title}
              </h3>
            )}
            {subtitle != null && <p className="mt-px truncate text-callout text-ink-2">{subtitle}</p>}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-2 text-callout text-ink-2">{actions}</div>}
        </header>
      )}
      <div
        className={cn(
          "min-h-0 flex-1",
          padded && "px-(--card-pad-x)",
          padded && !hasHeader && "pt-(--card-pad-y)",
          padded && footer == null && "pb-(--card-pad-y)",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer != null && (
        <footer className="tnum mx-(--card-pad-x) flex shrink-0 items-center justify-between gap-3 whitespace-nowrap border-t border-divider pt-2.5 pb-(--card-pad-y) text-callout text-ink-2">
          {footer}
        </footer>
      )}
    </section>
  );
}

/** The same component under its 1.2 name. */
export const Card = GlassCard;

export default GlassCard;
