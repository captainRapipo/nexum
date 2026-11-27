/** Copies plain text to the clipboard. Falls back to a hidden textarea when the async API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  ta.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("Clipboard is not available");
  } finally {
    document.body.removeChild(ta);
    active?.focus?.({ preventScroll: true });
  }
}
