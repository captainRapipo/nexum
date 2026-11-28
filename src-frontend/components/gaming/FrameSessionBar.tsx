import { useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { FrameSession, HealthCondition } from "../../types";
import { errorMessage } from "../../lib/api";
import { fmtClock } from "../../lib/format";
import { Button, HealthBanner } from "../ui";
import { SESSION_ERROR_HINT, SESSION_FAILED, SESSION_PAUSED, SESSION_STARTING, signatureTitle } from "./gamingText";

export interface FrameSessionBarProps {
  session: FrameSession | null;
  /** `useFrames().setEnabled`. */
  setEnabled: (on: boolean) => Promise<void>;
  /** Sensor reading is up (frame capture is started by the same background service). */
  agentRunning: boolean;
  /** Controls shown before `Turn off` (the statistics window selector). */
  trailing?: ReactNode;
}

/** Session line shown whenever capture is enabled (CONTRACT §4.10.1, §1.6.6). */
export default function FrameSessionBar({ session, setEnabled, agentRunning, trailing }: FrameSessionBarProps) {
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

  const failed = session?.state === "error";
  const failMessage = failed ? session.message : "";
  const failCode = failed ? session.code : null;

  // The error state is a critical banner with one secondary action (never a crimson button).
  const alert = useMemo<HealthCondition | null>(() => {
    if (!failed) return null;
    const hint = failCode ? SESSION_ERROR_HINT[failCode] : "";
    return {
      id: "frame-capture",
      severity: "crit",
      source: "gpu",
      group: "frame-capture",
      short: "Frame capture stopped",
      title: failMessage,
      detail: hint,
      rule: "Shown when frame capture could not start or stopped by itself.",
      dismissKey: `frame-capture:${failCode ?? "error"}`,
      // Only the label is used: the banner's button runs the retry below.
      action: { label: "Try again", nav: { view: "gaming" } },
    };
  }, [failed, failMessage, failCode]);

  let body: ReactNode;
  if (failed) {
    body = <span className="min-w-0 flex-1 truncate">{SESSION_FAILED}</span>;
  } else if (session?.state === "running") {
    body = (
      <>
        <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-ok-icon" />
        <span className="min-w-0 flex-1 truncate" title={`${session.message} ${signatureTitle(session)}`}>
          <b className="font-medium text-ink">Intel-signed PresentMon {session.backendVersion}</b>
          {` · session ${session.sessionName} · capturing since ${fmtClock(session.sinceTs, false)}`}
        </span>
      </>
    );
  } else {
    body = (
      <>
        <Loader2 size={14} className="shrink-0 animate-spin text-ink-3" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {session?.state === "starting" ? session.message : agentRunning ? SESSION_STARTING : SESSION_PAUSED}
        </span>
      </>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2">
      {alert && <HealthBanner alert={alert} onAction={() => void run("retry")} busy={busy === "retry"} />}
      <div
        role="status"
        className="tnum flex min-w-0 items-center gap-3 whitespace-nowrap rounded-lg bg-card py-2.5 pl-[18px] pr-4 text-callout text-ink-2 shadow-card"
      >
        {body}
        {trailing}
        <Button size="sm" loading={busy === "off"} disabled={busy != null} onClick={() => void run("off")}>
          Turn off
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-1 text-callout text-crit">
          {error}
        </p>
      )}
    </div>
  );
}
