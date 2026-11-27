import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { FIXED_FRAME_EXCLUDES, FPS_EXCLUDES_MAX } from "../../types";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button } from "../ui";
import { checkExclude } from "./gamingText";

export interface ExcludesEditorProps {
  /** `Settings.fpsExcludes`. */
  excludes: readonly string[];
  /** `useFrames().setExcludes`. */
  setExcludes: (names: string[]) => Promise<void>;
  className?: string;
}

/**
 * User excludes (CONTRACT §2.13, §4.10.1). Validation matches Rust's sanitizer; the agent filters
 * these rows itself, so editing the list never restarts the PresentMon session.
 */
export default function ExcludesEditor({ excludes, setExcludes, className }: ExcludesEditorProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const errId = `${inputId}-err`;

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
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11.5px] leading-snug text-muted">
          Frames from these apps are ignored and they are never chosen as the target, for example a recorder or a
          launcher.
        </p>
        <span className="num shrink-0 text-[11px] text-slate-500" title={`Up to ${FPS_EXCLUDES_MAX} apps`}>
          {excludes.length} / {FPS_EXCLUDES_MAX}
        </span>
      </div>
      <label htmlFor={inputId} className="sr-only">
        Program file name to ignore
      </label>

      <form onSubmit={(e) => void onAdd(e)} className="flex items-start gap-2" noValidate>
        <input
          id={inputId}
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          maxLength={64}
          placeholder="name.exe"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          className={cn(
            "num h-8 min-w-0 flex-1 rounded-md border bg-black/30 px-2.5 text-[12px] text-ink outline-none placeholder:text-slate-600",
            error ? "border-crit/60" : "border-line focus:border-teal/50",
          )}
        />
        <Button type="submit" size="sm" variant="teal" icon={Plus} loading={busy} disabled={draft.trim() === ""}>
          Add
        </Button>
      </form>
      {error && (
        <p id={errId} role="alert" className="text-[11.5px] text-rose-400">
          {error}
        </p>
      )}

      {excludes.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Ignored apps">
          {excludes.map((name) => (
            <li
              key={name}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-white/[0.03] pl-2.5 pr-1 text-[12px]"
            >
              <span className="num text-slate-200">{name}</span>
              <button
                type="button"
                onClick={() => onRemove(name)}
                disabled={busy}
                title={`Remove ${name}`}
                aria-label={`Remove ${name}`}
                className="flex size-5 items-center justify-center rounded text-slate-500 hover:bg-white/[0.08] hover:text-slate-200 disabled:opacity-40"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-slate-500" title="These are excluded by Nexum itself and cannot be removed.">
        Always ignored: {FIXED_FRAME_EXCLUDES.join(", ")}
      </p>
    </div>
  );
}
