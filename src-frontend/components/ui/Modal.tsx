import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconLike;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** Explicit max width (px or CSS length); overrides `size`. */
  width?: number | string;
  /** When false, Esc / backdrop / close button do nothing (e.g. while a purge runs). Default true. */
  dismissible?: boolean;
  /** Close when the backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean;
  /** Element to focus when opened; defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Accessible name when no visible title is given. */
  ariaLabel?: string;
  className?: string;
  bodyClassName?: string;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[560px]",
  lg: "max-w-[760px]",
  xl: "max-w-[980px]",
};

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

// Stack of open modal ids: only the top-most modal reacts to Esc / Tab.
const stack: string[] = [];
const EXIT_MS = 180;

/** True while any <Modal> is open (used by global hotkeys so they don't act behind a dialog). */
export function isModalOpen(): boolean {
  return stack.length > 0;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  size = "md",
  width,
  dismissible = true,
  closeOnBackdrop = true,
  initialFocusRef,
  ariaLabel,
  className,
  bodyClassName,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = `${id}-desc`;
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  const requestClose = useCallback(() => {
    if (dismissibleRef.current) onCloseRef.current();
  }, []);

  // Mount / unmount with enter + exit transitions.
  useEffect(() => {
    if (open) {
      setMounted(true);
      let f2 = 0;
      const f1 = requestAnimationFrame(() => {
        f2 = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(f1);
        cancelAnimationFrame(f2);
      };
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  // Stack registration, focus capture / restore.
  useEffect(() => {
    if (!open || !mounted) return;
    stack.push(id);
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        initialFocusRef?.current ?? panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? panel).focus({ preventScroll: true });
    }, 30);

    return () => {
      window.clearTimeout(focusTimer);
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      const restore = restoreRef.current;
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
    };
  }, [open, mounted, id, initialFocusRef]);

  // Esc + focus trap (top-most modal only).
  useEffect(() => {
    if (!open || !mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, mounted, id, requestClose]);

  if (!mounted || typeof document === "undefined") return null;

  const hasHeader = title != null || icon != null || dismissible;
  const maxWidthStyle = width != null ? { maxWidth: typeof width === "number" ? `${width}px` : width } : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" data-state={visible ? "open" : "closed"}>
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-[#02060a]/70 backdrop-blur-md transition-opacity duration-200",
          visible ? "opacity-100" : "opacity-0",
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && closeOnBackdrop) requestClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        aria-describedby={subtitle != null ? descId : undefined}
        tabIndex={-1}
        style={maxWidthStyle}
        className={cn(
          "glass-strong relative flex max-h-[calc(100vh-48px)] w-full flex-col overflow-hidden outline-none",
          "transition-[opacity,transform] duration-200 ease-out",
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.985] opacity-0",
          width == null && SIZE_CLASS[size],
          className,
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-10 top-0 h-px bg-linear-to-r from-transparent via-teal/60 to-transparent"
        />
        {hasHeader && (
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4">
            {icon != null && (
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-teal/30 bg-teal/[0.08] text-teal">
                {renderIcon(icon, 16)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {title != null && (
                <h2 id={titleId} className="text-[15px] font-semibold tracking-[0.02em] text-ink">
                  {title}
                </h2>
              )}
              {subtitle != null && (
                <p id={descId} className="mt-0.5 text-[12px] text-muted">
                  {subtitle}
                </p>
              )}
            </div>
            {dismissible && (
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close dialog"
                className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>{children}</div>
        {footer != null && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-black/20 px-5 py-3">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
