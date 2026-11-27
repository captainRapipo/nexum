import { useState } from "react";
import { Activity, ShieldQuestion } from "lucide-react";
import { errorMessage } from "../../lib/api";
import GlassCard from "../layout/GlassCard";
import { Button } from "../ui";
import { ANTI_CHEAT_MATRIX, ANTI_CHEAT_SUMMARY, OPT_IN_BODY, OPT_IN_BUTTON, OPT_IN_JAVELIN, OPT_IN_TITLE } from "./gamingText";

export interface FrameCaptureOptInProps {
  /** `useFrames().setEnabled`. */
  setEnabled: (on: boolean) => Promise<void>;
}

/** Shown while frame capture is off (CONTRACT §4.10.1): explanation + one button, no other controls. */
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
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <GlassCard title={OPT_IN_TITLE} icon={Activity} accent="teal" bodyClassName="pt-1">
        <div className="flex max-w-[680px] flex-col gap-3 text-[13px] leading-relaxed text-slate-300">
          <p>{OPT_IN_BODY}</p>
          <p className="text-slate-400">{OPT_IN_JAVELIN}</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button variant="teal" icon={Activity} loading={busy} onClick={() => void turnOn()}>
              {OPT_IN_BUTTON}
            </Button>
            <span className="text-[11.5px] text-slate-500">You can turn it off here or in Settings at any time.</span>
          </div>
          {error && (
            <p role="alert" className="text-[12px] text-rose-400">
              {error}
            </p>
          )}
        </div>
      </GlassCard>
      <AntiCheatNote />
    </div>
  );
}

/** What capture does and that no anti-cheat system has been tested yet, plus the test matrix placeholder. */
export function AntiCheatNote({ className }: { className?: string }) {
  return (
    <GlassCard title="Anti-cheat" icon={ShieldQuestion} className={className} bodyClassName="pt-1">
      <p className="text-[12px] leading-snug text-slate-400">{ANTI_CHEAT_SUMMARY}</p>
      <table className="mt-3 w-full text-[12px]">
        <caption className="sr-only">Anti-cheat test status</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="label-caps pb-1 font-semibold">
              System
            </th>
            <th scope="col" className="label-caps pb-1 text-right font-semibold">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {ANTI_CHEAT_MATRIX.map((r) => (
            <tr key={r.system} className="border-t border-line">
              <td className="py-1.5 text-slate-300">{r.system}</td>
              <td className="py-1.5 text-right text-slate-500">{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassCard>
  );
}
