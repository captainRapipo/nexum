import { useId, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { FIXED_FRAME_EXCLUDES, FPS_EXCLUDES_MAX } from "../../types";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button, TextField } from "../ui";
import { EXCLUDES_HINT, checkExclude } from "./gamingText";

export interface ExcludesEditorProps {
  /** `Settings.fpsExcludes`. */
  excludes: readonly string[];
  /** `useFrames().setExcludes`. */
  setExcludes: (names: string[]) => Promise<void>;
  className?: string;
}

/**
 * "Never follow": the user's excludes (CONTRACT §2.13, §4.10.1). Validation matches Rust's
 * sanitizer; the rows are filtered at the source, so editing the list never restarts the
 * PresentMon session.
 */
export default function ExcludesEditor({ excludes, setExcludes, className }: ExcludesEditorProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  // Nexum's own programs are on the fixed list too; the hover names them as "Nexum itself", not by file name.
  const always = `Always ignored: ${[...FIXED_FRAME_EXCLUDES.filter((n) => !/^nexum/i.test(n)), "Nexum itself"].join(", ")}`;

  const apply = async (next: string[]): Promise<boolean> => {
    setBusy(true);
    try {
      await setExcludes(next);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const res = checkExclude(draft, excludes);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    if (await apply([...excludes, res.name])) setDraft("");
  };

  const onRemove = (name: string) => {
    if (busy) return;
    setError(null);
    void apply(excludes.filter((x) => x !== name));
  };

  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="text-[12px] font-semibold leading-4 text-ink-2" title={`${EXCLUDES_HINT}\n\n${always}`}>
          Never follow
        </label>
        <span className="tnum text-caption text-ink-3" title={`Up to ${FPS_EXCLUDES_MAX} apps. ${always}`}>
          {excludes.length} of {FPS_EXCLUDES_MAX}
        </span>
      </div>
      <p className="sr-only">
        {EXCLUDES_HINT} {always}
      </p>

      {excludes.length > 0 && (
        <ul className="mb-2.5 flex max-h-[84px] flex-wrap gap-1.5 overflow-y-auto" aria-label="Apps that are never followed">
          {excludes.map((name) => (
            <li
              key={name}
              className="inline-flex h-6 items-center gap-0.5 rounded-full bg-inset pl-[9px] pr-0.5 font-mono text-[11.5px] text-ink shadow-[inset_0_0_0_0.5px_var(--color-subtle)]"
            >
              {name}
              <button
                type="button"
                onClick={() => onRemove(name)}
                disabled={busy}
                title={`Remove ${name}`}
                aria-label={`Remove ${name}`}
                className="flex size-5 items-center justify-center rounded-full text-ink-3 transition-colors duration-[80ms] hover:bg-hover hover:text-ink disabled:text-ink-disabled"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(e) => void onAdd(e)} className="flex items-start gap-2" noValidate>
        <TextField
          id={inputId}
          mono
          value={draft}
          onChange={(v) => {
            setDraft(v);
            if (error) setError(null);
          }}
          placeholder="name.exe"
          spellCheck={false}
          autoComplete="off"
          maxLength={64}
          invalid={error != null}
          message={error != null ? <span role="alert">{error}</span> : undefined}
          className="flex-1"
        />
        <Button type="submit" size="sm" className="h-7" loading={busy} disabled={draft.trim() === ""}>
          Add
        </Button>
      </form>
    </div>
  );
}
