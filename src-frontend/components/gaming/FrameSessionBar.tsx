import { useState, type ReactNode } from "react";
import { Loader2, Power, RotateCcw, ShieldCheck } from "lucide-react";
import type { FrameSession } from "../../types";
import { errorMessage } from "../../lib/api";
import { cn, fmtClock } from "../../lib/format";
import { Button, STATUS_ICON } from "../ui";
import { SESSION_ERROR_HINT, signatureTitle } from "./gamingText";

export interface FrameSessionBarProps {
  session: FrameSession | null;
  /** `useFrames().setEnabled`. */
  setEnabled: (on: boolean) => Promise<void>;
  /** Hardware agent connected. */
  agentRunning: boolean;
}

/** Session line shown whenever capture is enabled (CONTRACT §4.10.1, §1.6.6). */
export default function FrameSessionBar({ session, setEnabled, agentRunning }: FrameSessionBarProps) {
  const [busy, setBusy] = useState<"off" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "off" | "retry") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "off") {
        await setEnabled(false);
      } else {
        await setEnabled(false);
        await setEnabled(true);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const turnOff = (
    <Button size="sm" variant="ghost" icon={Power} loading={busy === "off"} disabled={busy != null} onClick={() => void run("off")}>
      Turn off
    </Button>
  );

  let body: ReactNode;
  if (session?.state === "error") {
    const CritIcon = STATUS_ICON.crit;
    return (
      <div className="flex flex-col gap-1">
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-crit/50 bg-crit/[0.09] px-4 py-2.5 text-[12.5px]">
          <CritIcon size={16} className="shrink-0 text-rose-400" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="font-semibold text-ink">{session.message}</span>
            {session.code && <span className="ml-2 text-slate-300">{SESSION_ERROR_HINT[session.code]}</span>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={RotateCcw}
            loading={busy === "retry"}
            disabled={busy != null}
            onClick={() => void run("retry")}
            className="border-white/15 bg-white/[0.04]"
          >
            Try again
          </Button>
          {turnOff}
        </div>
        {error && <p className="px-1 text-[11.5px] text-rose-400">{error}</p>}
      </div>
    );
  }

  if (session?.state === "running") {
    body = (
      <>
        <span aria-hidden="true" className="led-ok size-2 shrink-0 rounded-full animate-led-pulse" />
        <span className="min-w-0 flex-1 truncate text-slate-200" title={`${session.message} ${signatureTitle(session)}`}>
          <ShieldCheck size={13} className="mr-1.5 inline -translate-y-px text-ok" aria-hidden="true" />
          Intel-signed PresentMon {session.backendVersion} · session {session.sessionName}
          <span className="ml-2 text-slate-500">since {fmtClock(session.sinceTs, false)}</span>
        </span>
      </>
    );
  } else if (session?.state === "starting") {
    body = (
      <>
        <Loader2 size={14} className="shrink-0 animate-spin text-teal" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-slate-300">{session.message}</span>
      </>
    );
  } else {
    body = (
      <>
        <Loader2 size={14} className="shrink-0 animate-spin text-slate-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-slate-400">
          {agentRunning
            ? "Waiting for the hardware agent to start frame capture…"
            : "Hardware agent offline. Frame capture starts when it reconnects."}
        </span>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div
        role="status"
        className={cn("flex min-w-0 items-center gap-3 rounded-xl border border-line bg-white/[0.025] px-4 py-2 text-[12.5px]")}
      >
        {body}
        {turnOff}
      </div>
      {error && <p className="px-1 text-[11.5px] text-rose-400">{error}</p>}
    </div>
  );
}
