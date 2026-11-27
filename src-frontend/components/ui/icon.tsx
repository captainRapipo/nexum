import { isValidElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Either a rendered element (`<Zap size={14} />`) or a component (`Zap`). */
export type IconLike = ReactNode | LucideIcon;

function isComponent(icon: unknown): icon is LucideIcon {
  if (typeof icon === "function") return true;
  // forwardRef / memo components are objects tagged with $$typeof.
  return typeof icon === "object" && icon !== null && "$$typeof" in icon && !isValidElement(icon);
}

export function renderIcon(icon: IconLike | undefined, size = 16, className?: string): ReactNode {
  if (icon == null || icon === false) return null;
  if (isValidElement(icon)) return icon;
  if (isComponent(icon)) {
    const C = icon;
    return <C size={size} className={className} aria-hidden="true" strokeWidth={1.9} />;
  }
  return icon as ReactNode;
}
