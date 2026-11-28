// Small clipboard / path helpers shared by the System and Storage views (owner V2).

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

/** `C:\x\y\file.txt` → `C:\x\y` (a drive root keeps its backslash). */
export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (i <= 0) return p;
  if (i === 2 && p[1] === ":") return p.slice(0, 3);
  return p.slice(0, i);
}
