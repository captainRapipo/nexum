import { useState } from "react";
import { ExternalLink, Fan, Lock, OctagonAlert, AlertTriangle, ShieldCheck, X } from "lucide-react";
import { api, errorMessage, PAWNIO_URL } from "../../lib/api";
import { cn } from "../../lib/format";
import { useFanFailsafe } from "../../hooks/useFanFailsafe";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useHealth } from "../../hooks/useHealth";
import { toast } from "./Toast";

/**
 * Fan fail-safe banner (MF-13, CONTRACT §2.4). Always first, above every view.
 * Rose for interrupted / agentLost, amber (dismissible) for previousBoot.
 */
export function FanFailsafeBanner() {
  const { state, dismiss } = useFanFailsafe();
  const [busy, setBusy] = useState(false);
  if (!state.active) return null;
  const crit = state.severity !== "warn";
  const Icon = crit ? OctagonAlert : AlertTriangle;

  const onDismiss = async () => {
    setBusy(true);
    try {
      await dismiss();
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role={crit ? "alert" : "status"}
      className={cn(
        "relative z-10 flex shrink-0 items-center gap-3 border-b px-5 py-2.5 text-[12.5px]",
        crit ? "border-crit/50 bg-crit/[0.12]" : "border-warn/45 bg-warn/[0.09]",
      )}
    >
      <Icon size={17} aria-hidden="true" className={cn("shrink-0", crit ? "text-rose-400" : "text-warn")} />
      <Fan size={15} aria-hidden="true" className="shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-ink">{crit ? "Fan control interrupted. " : "Fan control notice. "}</span>
        <span className="text-slate-200">{state.message}</span>
        {crit && state.kind === "interrupted" && !state.fansAt100 && (
          <span className="ml-1 text-slate-400">Nexum cannot set the fans without administrator rights.</span>
        )}
      </div>
      {state.dismissible && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDismiss()}
          title="Dismiss"
          aria-label="Dismiss"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-ink disabled:opacity-50"
        >
          <X size={13} aria-hidden="true" />
          Dismiss
        </button>
      )}
    </div>
  );
}

/**
 * Limited-mode banner (MF-2, CONTRACT §5.4): names the missing features and offers
 * "Restart as administrator" / "Get PawnIO". Hidden when the user chose "no kernel driver"
 * and only PawnIO reasons remain (the pill still says Partial sensors).
 */
export function LimitedModeBanner() {
  const { agent } = useTelemetry();
  const { settings } = useSettings();
  const health = useHealth();
  const [busy, setBusy] = useState(false);

  const cond = health.conditions.find((c) => c.id === "limited-mode");
  if (!cond || !agent) return null;
  const reasons = agent.limitedReasons ?? [];
  const notElevated = reasons.includes("notElevated");
  const pawn = reasons.includes("pawnIoMissing") || reasons.includes("pawnIoOutdated");
  if (!notElevated && settings.sensorDriverChoice === "none") return null;

  const elevate = async () => {
    setBusy(true);
    try {
      await api.restartAsAdmin();
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setBusy(false);
    }
  };

  const lead = notElevated
    ? "Nexum is running without administrator rights."
    : reasons.includes("pawnIoOutdated")
      ? "The PawnIO sensor driver needs an update."
      : "The PawnIO sensor driver is not installed.";

  return (
    <div role="status" title={cond.rule} className="relative z-10 flex shrink-0 items-center gap-3 border-b border-line bg-white/[0.025] px-5 py-2 text-[12.5px]">
      <Lock size={15} aria-hidden="true" className="shrink-0 text-slate-400" />
      {/* Wraps instead of truncating: the list of unavailable features is the point of the banner. */}
      <div className="min-w-0 flex-1 leading-snug">
        <span className="font-semibold text-ink">Partial sensors. </span>
        <span className="text-slate-300">{lead} </span>
        <span className="text-slate-400">{cond.detail}</span>
      </div>
      {notElevated && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void elevate()}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-white/[0.09] disabled:opacity-50"
        >
          <ShieldCheck size={13} aria-hidden="true" />
          Restart as administrator
        </button>
      )}
      {(pawn || (!notElevated && agent.sensorDriver?.kind === "none")) && (
        <button
          type="button"
          onClick={() => void api.openExternal(PAWNIO_URL).catch((err) => toast(errorMessage(err), "warn"))}
          title="Opens pawnio.eu in your browser"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-white/[0.09]"
        >
          <ExternalLink size={13} aria-hidden="true" />
          Get PawnIO
        </button>
      )}
    </div>
  );
}
