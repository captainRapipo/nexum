import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/format";

export interface ScrollFadeProps {
  children: ReactNode;
  className?: string;
  /** Max height of the scrolling column (px number or any CSS length). */
  maxHeight?: number | string;
}

/**
 * Independently scrolling column (MF-10): thin visible scrollbar and a bottom fade mask
 * shown only while there is more content below.
 */
export function ScrollFade({ children, className, maxHeight }: ScrollFadeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setFade(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    mo?.observe(el, { childList: true, subtree: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={ref}
      onScroll={measure}
      data-fade={fade ? "true" : "false"}
      className={cn("scroll-fade min-h-0", className)}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      <div>{children}</div>
    </div>
  );
}

export default ScrollFade;
