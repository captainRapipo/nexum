import { useId, useState } from "react";
import { Activity, ChartLine, ChevronRight, Cpu, Gamepad2 } from "lucide-react";
import { errorMessage } from "../../lib/api";
import { cn } from "../../lib/format";
import { Button, EmptyState } from "../ui";
import {
  ANTI_CHEAT_MATRIX,
  ANTI_CHEAT_SUMMARY,
  OPT_IN_BODY,
  OPT_IN_BUTTON,
  OPT_IN_JAVELIN,
  OPT_IN_TILES,
  OPT_IN_TITLE,
} from "./gamingText";

export interface FrameCaptureOptInProps {
  /** `useFrames().setEnabled`. */
  setEnabled: (on: boolean) => Promise<void>;
}

const TILE_ICONS = [Activity, ChartLine, Cpu];

/**
 * Shown while frame capture is off (CONTRACT §4.10.1, §4.10.3): what it does, the ONE primary
 * button of the screen, what the page shows afterwards and the honest anti-cheat status.
 */
export default function FrameCaptureOptIn({ setEnabled }: FrameCaptureOptInProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await setEnabled(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <EmptyState
        icon={<Gamepad2 size={34} strokeWidth={1.75} className="text-icon-2" aria-hidden="true" />}
        title={OPT_IN_TITLE}
        body={OPT_IN_BODY}
        note={<span className="mx-auto block max-w-[520px]">{OPT_IN_JAVELIN}</span>}
        action={
          <>
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              onClick={() => void turnOn()}
              title="You can turn it off here or in Settings at any time."
            >
              {OPT_IN_BUTTON}
            </Button>
            {error && (
              <p role="alert" className="mt-2 text-callout text-crit">
                {error}
              </p>
            )}
          </>
        }
      >
        {/* The tiles use the full 640 px of the empty state (its text column is inset by 24 px a side). */}
        <div className="-mx-6 grid grid-cols-3 gap-3">
          {OPT_IN_TILES.map((t, i) => {
            const Icon = TILE_ICONS[i] ?? Activity;
            return (
              <div key={t.title} className="flex flex-col gap-[3px] rounded-lg bg-card p-3.5 text-left shadow-card">
                <Icon size={18} strokeWidth={1.75} className="mb-1.5 text-icon-2" aria-hidden="true" />
                <b className="text-headline text-ink">{t.title}</b>
                <span className="text-callout text-ink-2">{t.body}</span>
              </div>
            );
          })}
        </div>
        <AntiCheatNote className="-mx-6 mt-4" />
      </EmptyState>
    </div>
  );
}

/**
 * What capture does and that no anti-cheat system has been tested yet, with the test list behind a
 * disclosure (CONTRACT §4.8: never "safe with anti-cheat"; say what it does and what is untested).
 */
export function AntiCheatNote({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className={cn("text-left text-callout text-ink-3", className)}>
      <p>
        {ANTI_CHEAT_SUMMARY}{" "}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="link-ink rounded-xs align-baseline text-callout"
        >
          {open ? "Hide the list" : "Show the list"}
          <ChevronRight aria-hidden="true" className={cn("transition-transform duration-[140ms]", open && "rotate-90")} />
        </button>
      </p>
      {open && (
        <table id={listId} className="mt-2 w-full rounded-lg bg-card text-callout shadow-card">
          <caption className="sr-only">Anti-cheat test status</caption>
          <thead>
            <tr className="text-left text-ink-2">
              <th scope="col" className="px-3.5 pb-1 pt-2.5 font-semibold">
                System
              </th>
              <th scope="col" className="px-3.5 pb-1 pt-2.5 text-right font-semibold">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {ANTI_CHEAT_MATRIX.map((r) => (
              <tr key={r.system} className="border-t border-divider">
                <td className="px-3.5 py-1.5 text-ink">{r.system}</td>
                <td className="px-3.5 py-1.5 text-right text-ink-2">{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
