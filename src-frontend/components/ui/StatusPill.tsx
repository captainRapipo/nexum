import type { ReactNode, SVGProps } from "react";
import { ChevronDown, CircleCheck, CircleDashed, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";
import { CHECKING_CLASS, STATUS_CLASS, type StatusClasses, type StatusPillTone, type StatusTone } from "./tones";

export type { StatusTone, StatusPillTone } from "./tones";

// CONTRACT §4.7 / docs/design/SPEC.md §4 (header pill), §21 (status chip).
// Status is icon + word + tint. The five glyphs differ in SHAPE (dashed ring, check circle,
// triangle, filled octagon, half-filled circle), so they also read in greyscale.

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "ref"> & { size?: number | string };

/** Filled octagon with a white mark: "Critical" never relies on colour (or on an outline) alone. */
function OctagonFilled({ size = 14, className, strokeWidth: _sw, ...rest }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" {...rest}>
      <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" fill="currentColor" />
      <path d="M12 7.4v5.4" stroke="white" strokeWidth={2.4} strokeLinecap="round" fill="none" />
      <circle cx={12} cy={16.6} r={1.3} fill="white" />
    </svg>
  );
}

/** Half-filled circle (the lucide "Contrast" idea with the half drawn solid): "some of it is known". */
function HalfCircle({ size = 14, className, strokeWidth = 2, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      <circle cx={12} cy={12} r={10} />
      <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Default icon per tone. `crit` is the FILLED octagon and `unknown` the half-filled circle (local
 * SVGs that accept `size` and `className` like a lucide icon); the others are lucide outlines.
 */
export const STATUS_ICON: Record<StatusTone, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  crit: OctagonFilled as unknown as LucideIcon,
  info: Info,
  unknown: HalfCircle as unknown as LucideIcon,
};

function classesFor(tone: StatusPillTone): StatusClasses {
  return tone === "checking" ? CHECKING_CLASS : (STATUS_CLASS[tone] ?? STATUS_CLASS.unknown);
}

export interface StatusIconProps {
  tone: StatusPillTone;
  size?: number;
  className?: string;
}

/** The status glyph in its tone's icon colour. Use it wherever a status icon is drawn. */
export function StatusIcon({ tone, size = 14, className }: StatusIconProps) {
  const cls = cn("shrink-0", classesFor(tone).icon, className);
  if (tone === "checking") return <CircleDashed size={size} className={cls} aria-hidden="true" />;
  const Icon = STATUS_ICON[tone] ?? STATUS_ICON.unknown;
  return <Icon size={size} className={cls} aria-hidden="true" />;
}

export interface StatusPillProps {
  tone: StatusPillTone;
  children: ReactNode;
  /** "chip" (default): 20 px status chip for content. "pill": the 26 px header pill. */
  size?: "chip" | "pill";
  /** Text after " · " in medium weight (header pill: "1 drive worn"). */
  summary?: ReactNode;
  /** Makes it a button with a chevron (header pill → popover). */
  onClick?: () => void;
  /** aria-expanded for the popover; turns the chevron. */
  expanded?: boolean;
  /** Ignored since 1.2 (nothing pulses). Kept so call sites compile. */
  pulse?: boolean;
  /** Replaces the default per-tone icon. */
  icon?: IconLike;
  /** Hover text: every status claim shows the rule that produced it (CONTRACT §4.8). */
  title?: string;
  className?: string;
}

export function StatusPill({ tone, children, size = "chip", summary, onClick, expanded, icon, title, className }: StatusPillProps) {
  const c = classesFor(tone);
  const pill = size === "pill";
  const iconSize = pill ? 15 : 13;
  const cls = cn(
    "inline-flex shrink-0 items-center whitespace-nowrap font-semibold leading-none",
    pill ? "h-[26px] gap-1.5 rounded-full border px-2 text-[12px]" : "h-5 gap-1 rounded-[10px] pl-[5px] pr-2 text-[11px]",
    c.soft,
    c.text,
    pill && c.border,
    // A chip has no border; the neutral one sits on white, so it gets a hairline to stay visible.
    !pill && tone === "checking" && "shadow-[inset_0_0_0_1px_var(--color-subtle)]",
    // Hover darkens the tint by 4 % without touching the text.
    onClick && "hover:bg-[linear-gradient(var(--color-hover),var(--color-hover))] active:bg-[linear-gradient(var(--color-pressed),var(--color-pressed))]",
    className,
  );
  const body = (
    <>
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {icon != null ? <span className={cn("flex items-center", c.icon)}>{renderIcon(icon, iconSize)}</span> : <StatusIcon tone={tone} size={iconSize} />}
      </span>
      <span>{children}</span>
      {summary != null && summary !== "" && summary !== false && (
        <span className="font-medium">
          <span aria-hidden="true" className="mr-1.5 ml-px font-semibold">
            ·
          </span>
          {summary}
        </span>
      )}
      {onClick && (
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={cn("ml-px shrink-0 opacity-70 transition-transform duration-(--dur-fast) ease-standard", expanded && "rotate-180")}
        />
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" title={title} aria-expanded={expanded} onClick={onClick} className={cls}>
        {body}
      </button>
    );
  }
  return (
    <span title={title} className={cls}>
      {body}
    </span>
  );
}

export default StatusPill;
