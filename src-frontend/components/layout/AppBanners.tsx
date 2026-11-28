// App-level banners (CONTRACT §4.6.1, §5.4; docs/design/SPEC.md §17): full-bleed bars under the toolbar,
// in this order, each only when active:
//   1. fan fail-safe
//   2. sensors: the ONE place that says "Nexum can't read sensors right now." (only when Rust gave up
//      restarting sensor reading, §4.8.1)
//   3. limited mode (hidden while 2 shows)
// No banner carries a crimson button: every action is secondary.
import { useEffect, useRef, useState } from "react";
import {
  SENSORS_DOWN_REASON,
  SENSORS_DOWN_SHORT,
  SENSORS_DOWN_TITLE,
  SENSORS_RETRY_LABEL,
  type HealthCondition,
  type SensorFailReason,
} from "../../types";
import { api, errorMessage } from "../../lib/api";
import { HEALTH_RULES, limitedBannerShown, runHealthAction, sensorsFailed } from "../../lib/status";
import { useFanFailsafe } from "../../hooks/useFanFailsafe";
import { useHealth } from "../../hooks/useHealth";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { toast } from "../feedback/Toast";
import { HealthBanner } from "../ui";

/**
 * Fan fail-safe banner (MF-13, CONTRACT §2.4). Always first. Critical for `interrupted` / `agentLost`,
 * a dismissible warning for `previousBoot`.
 */
export function FanFailsafeBanner() {
  const { state, dismiss } = useFanFailsafe();
  const [busy, setBusy] = useState(false);
  if (!state.active) return null;
  const crit = state.severity !== "warn";

  const onDismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await dismiss();
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setBusy(false);
    }
  };

  const extra = crit && state.kind === "interrupted" && !state.fansAt100 ? " Nexum cannot set the fans without administrator rights." : "";
  const alert: HealthCondition = {
    id: "fan-failsafe",
    severity: crit ? "crit" : "warn",
    source: "fan",
    group: "fan-failsafe",
    short: "Fan fail-safe",
    title: crit ? "Fan control interrupted." : "Fan control notice.",
    detail: `${state.message}${extra}`,
    rule: HEALTH_RULES.failsafe,
    dismissKey: `fan-failsafe:${state.kind ?? "active"}`,
    action: null,
  };

  return <HealthBanner variant="bar" alert={alert} onDismiss={state.dismissible ? () => void onDismiss() : undefined} />;
}

type Retry = "no" | "sent" | "starting";

/**
 * The sensors banner (CONTRACT §4.8.1). Shown only while the sensor service is in phase "failed":
 * while it works, starts or is being restarted the UI says nothing. One button, `Try again`, which
 * shows as loading until the phase leaves "starting". No Dismiss.
 */
export function SensorsBanner() {
  const { agent } = useTelemetry();
  const [retry, setRetry] = useState<Retry>("no");
  const lastReason = useRef<SensorFailReason | null>(null);

  const phase = agent?.phase ?? null;
  const failed = sensorsFailed(agent);
  if (failed) lastReason.current = agent?.failReason ?? null;

  // Follow the retry: failed → (click) → starting → running | restarting | failed.
  useEffect(() => {
    if (retry === "no") return;
    if (phase === "starting") {
      if (retry !== "starting") setRetry("starting");
      return;
    }
    if (retry === "starting") {
      setRetry("no");
      return;
    }
    // "sent" but no "starting" was seen (an older core, or the event was missed): do not spin for ever.
    const t = window.setTimeout(() => setRetry("no"), 4000);
    return () => window.clearTimeout(t);
  }, [phase, retry]);

  const visible = failed || (retry !== "no" && phase === "starting");
  if (!visible) return null;

  const tryAgain = async () => {
    if (retry !== "no") return;
    setRetry("sent");
    try {
      await api.restartAgent();
    } catch (err) {
      setRetry("no");
      toast(errorMessage(err), "warn");
    }
  };

  const reason = lastReason.current;
  const alert: HealthCondition = {
    id: "agent-offline",
    severity: "warn",
    source: "agent",
    group: "agent-offline",
    short: SENSORS_DOWN_SHORT,
    title: SENSORS_DOWN_TITLE,
    // No reason line when Rust gave none.
    detail: reason ? SENSORS_DOWN_REASON[reason] : "",
    rule: HEALTH_RULES.offline,
    dismissKey: "agent-offline:warn",
    action: { label: SENSORS_RETRY_LABEL, command: "retrySensors" },
  };

  return <HealthBanner variant="bar" alert={alert} busy={retry !== "no"} onAction={() => void tryAgain()} />;
}

/**
 * Limited-mode banner (MF-2, CONTRACT §5.4): names what is unavailable and offers the way out
 * (`Restart as administrator` or `Get PawnIO`, rule 9). Hidden when the user chose "no kernel driver"
 * and only PawnIO reasons remain (the pill still says Partial sensors).
 */
export function LimitedModeBanner() {
  const { agent } = useTelemetry();
  const { settings } = useSettings();
  const health = useHealth();
  const [busy, setBusy] = useState(false);

  const cond = health.conditions.find((c) => c.id === "limited-mode");
  if (!cond || !agent || !limitedBannerShown(agent, settings.sensorDriverChoice)) return null;
  const reasons = agent.limitedReasons ?? [];
  const notElevated = reasons.includes("notElevated") || !agent.isAdmin;

  const title = notElevated
    ? "Some sensors need administrator rights."
    : reasons.includes("pawnIoOutdated")
      ? "Some sensors need a newer PawnIO driver."
      : "Some sensors need the PawnIO driver.";

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runHealthAction(cond.action);
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setBusy(false);
    }
  };

  return <HealthBanner variant="bar" alert={{ ...cond, title }} busy={busy} onAction={cond.action ? () => void run() : undefined} />;
}

/** The app-level bars, in their fixed order. */
export function AppBanners() {
  const { agent } = useTelemetry();
  const sensorsDown = sensorsFailed(agent);
  return (
    <>
      <FanFailsafeBanner />
      <SensorsBanner />
      {!sensorsDown && <LimitedModeBanner />}
    </>
  );
}

export default AppBanners;
