import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/format";
import { renderIcon, type IconLike } from "./icon";
import appIcon from "./assets/icon-128.png";

// CONTRACT §4.7 / docs/design/SPEC.md §18 (alert), §19 (sheet header and footer).

export type ModalSize = "sm" | "md" | "lg" | "xl";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Dialog variant: shown in the header's icon well. Ignored by the alert variant (it shows the app icon). */
  icon?: IconLike;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /**
   * "dialog" (default): header (icon well, title, subtitle, close) / scrolling body / footer bar.
   * "alert": the NSAlert layout (468 px, the Nexum app icon, title, then `subtitle` and `children`
   * as the body in secondary text, `footer` buttons right-aligned with a 96 px minimum width, no
   * close button). In an alert, Enter presses the default button: the one marked `data-default`,
   * else the primary button. Enter on a focused button presses that button, so a destructive flow
   * that starts with the focus on Cancel stays safe.
   */
  variant?: "dialog" | "alert";
  /** Explicit max width (px or CSS length); overrides `size` (and the alert's 468 px). */
  width?: number | string;
  /** When false, Esc / backdrop / close button do nothing (e.g. while a cleanup runs). Default true. */
  dismissible?: boolean;
  /** Close when the backdrop is clicked. Default true. */
  closeOnBackdrop?: boolean;
  /** Element to focus when opened; defaults to `[data-autofocus]`, else the first focusable element. */
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
const EXIT_MS = 160;

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
  variant = "dialog",
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
  const bodyId = `${id}-body`;
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

  const alert = variant === "alert";
  const hasBody = children != null && children !== false;
  const maxWidthStyle = width != null ? { maxWidth: typeof width === "number" ? `${width}px` : width } : undefined;
  const describedBy = subtitle != null ? descId : alert && hasBody ? bodyId : undefined;

  // Alert only: Enter presses the default button unless a button, link or multi-line field has the focus.
  const onPanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!alert || e.key !== "Enter" || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (stack[stack.length - 1] !== id) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, a[href], textarea, select, summary, [role="button"], [contenteditable="true"]')) return;
    const panel = panelRef.current;
    const def =
      panel?.querySelector<HTMLButtonElement>("button[data-default]:not(:disabled)") ??
      panel?.querySelector<HTMLButtonElement>("button[data-variant=primary]:not(:disabled)");
    if (def) {
      e.preventDefault();
      def.click();
    }
  };

  return createPortal(
    // Portal on <body>: the scrim covers the whole window, sidebar and toolbar included.
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" data-state={visible ? "open" : "closed"}>
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0 bg-scrim transition-opacity ease-standard",
          visible ? "opacity-100 duration-(--dur-base)" : "opacity-0 duration-150",
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && closeOnBackdrop) requestClose();
        }}
      />
      <div
        ref={panelRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        style={maxWidthStyle}
        onKeyDown={onPanelKeyDown}
        className={cn(
          "relative flex max-h-[calc(100vh-48px)] w-full flex-col overflow-hidden rounded-sheet bg-card shadow-sheet outline-none forced-colors:border",
          "origin-center transition-[opacity,scale] ease-standard",
          visible ? "scale-100 opacity-100 duration-(--dur-slow)" : "scale-[0.98] opacity-0 duration-150",
          width == null && (alert ? "max-w-(--dialog-w)" : SIZE_CLASS[size]),
          alert && "px-[22px] pt-[22px] pb-[18px]",
          className,
        )}
      >
        {alert ? (
          <>
            <img src={appIcon} alt="" width={56} height={56} draggable={false} className="mb-3 block h-14 w-14 shrink-0 select-none" />
            {title != null && (
              <h2 id={titleId} className="shrink-0 text-[16px] font-semibold leading-[21px] tracking-[-0.01em] text-ink">
                {title}
              </h2>
            )}
            {subtitle != null && (
              <p id={descId} className="mt-1.5 shrink-0 text-body text-ink-2">
                {subtitle}
              </p>
            )}
            {hasBody && (
              <div
                id={bodyId}
                className={cn(
                  "-mx-[3px] min-h-0 flex-1 overflow-y-auto px-[3px] text-body text-ink-2",
                  subtitle != null ? "mt-3.5" : "mt-1.5",
                  bodyClassName,
                )}
              >
                {children}
              </div>
            )}
            {footer != null && <div className="mt-[18px] flex shrink-0 items-center justify-end gap-2 [&_button]:min-w-24">{footer}</div>}
          </>
        ) : (
          <>
            {(title != null || icon != null || dismissible) && (
              <div className="flex shrink-0 items-center gap-3 border-b border-divider px-5 py-3.5">
                {icon != null && (
                  <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]">
                    {renderIcon(icon, 18)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {title != null && (
                    <h2 id={titleId} className="truncate text-[16px] font-semibold leading-[21px] tracking-[-0.01em] text-ink">
                      {title}
                    </h2>
                  )}
                  {subtitle != null && (
                    <p id={descId} className="mt-px truncate text-callout text-ink-2">
                      {subtitle}
                    </p>
                  )}
                </div>
                {dismissible && (
                  <button
                    type="button"
                    onClick={requestClose}
                    title="Close"
                    aria-label="Close"
                    className="-mr-1.5 flex h-7 w-[30px] shrink-0 items-center justify-center rounded-btn text-icon transition-colors duration-(--dur-instant) hover:bg-hover active:bg-pressed"
                  >
                    <X size={17} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4 text-body text-ink", bodyClassName)}>{children}</div>
            {footer != null && (
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-divider bg-toolbar px-5 py-3">{footer}</div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default Modal;
