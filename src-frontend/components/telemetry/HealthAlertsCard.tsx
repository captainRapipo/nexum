import { Button, Card, ScrollFade, StatusIcon } from "../ui";
import { useHealth } from "../../hooks/useHealth";
import { useHealthAlerts } from "../../hooks/useHealthAlerts";
import { useSettings } from "../../hooks/useSettings";
import { alertState, limitedBannerShown } from "../../lib/status";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import type { CpuLimitInfo, HealthCondition } from "../../types";
import { runHealthAction } from "./healthActions";
import { tempText } from "./sensorHelpers";

/** Where the CPU limit comes from (CONTRACT §2.10.2); "default" says so plainly. */
function cpuLimitText(l: CpuLimitInfo, unit: "C" | "F"): { text: string; title: string } {
  const limit = tempText(l.limitC, unit);
  const warn = tempText(l.warnC, unit);
  const levels = `Attention at ${warn}, critical at ${limit}.`;
  switch (l.source) {
    case "table":
      return {
        text: `CPU limit ${limit} (${l.model ?? "this CPU"}, AMD specification)`,
        title: `AMD's published maximum operating temperature for this model. ${levels}`,
      };
    case "user":
      return { text: `CPU limit ${limit} (your setting)`, title: `Set in Settings › Alerts. ${levels}` };
    default:
      return {
        text: `CPU limit ${limit} (default)`,
        title: `This CPU model is not in Nexum's table; using a conservative ${limit} limit. ${levels}`,
      };
  }
}

/**
 * True while `DriveWearBanners` shows this condition as a banner right above the cards (a drive
 * condition, warn or crit, not dismissed yet). The banner then carries the detail, `View drive` and
 * `Dismiss`, so the row here is one line instead of a second copy of the same text and buttons.
 */
export function hasBanner(c: HealthCondition, dismissed: readonly string[]): boolean {
  return c.id.startsWith("drive:") && (c.severity === "warn" || c.severity === "crit") && !dismissed.includes(c.dismissKey);
}

/**
 * "Health" (CONTRACT §4.10.3, §5.4): every active condition from `deriveHealth`, worst first, as a row
 * with its status icon, title, detail and action. The rule behind each row is its hover text. Until
 * Nexum has finished its first check the card says "Checking", never "No active alerts". Dismissing a
 * drive banner never removes its row here: the row stays for as long as the condition holds.
 */
export default function HealthAlertsCard() {
  const health = useHealth();
  const { snapshot } = useHealthAlerts();
  const { settings } = useSettings();
  const conditions = health.conditions;
  const checking = health.level === "checking";
  const limit = cpuLimitText(snapshot.cpuLimit, settings?.tempUnit ?? "C");
  const limitKnown = snapshot.ready || snapshot.evaluatedTs != null;
  const dismissed = settings?.dismissedAlerts ?? [];
  // The limited-mode bar under the toolbar already carries this condition's detail and its button.
  const { agent } = useTelemetry();
  const limitedBar = limitedBannerShown(agent, settings?.sensorDriverChoice);

  const needAttention = conditions.filter((c) => c.severity === "warn" || c.severity === "crit").length;
  const meta =
    needAttention > 0
      ? `${needAttention} ${needAttention === 1 ? "item needs" : "items need"} attention`
      : conditions.length > 0
        ? `${conditions.length} ${conditions.length === 1 ? "item" : "items"}`
        : undefined;

  return (
    <Card
      title="Health"
      actions={
        meta ? (
          <span className="tnum" title={limitKnown ? `${limit.text}. ${limit.title}` : undefined}>
            {meta}
          </span>
        ) : undefined
      }
      className="min-h-0"
      bodyClassName="flex min-h-0 flex-col"
    >
      {conditions.length === 0 ? (
        <>
          <div
            className="flex shrink-0 items-center gap-2 text-headline text-ink"
            title={checking ? "Nexum has not finished its first check of temperatures, drives and free space." : undefined}
          >
            <StatusIcon tone={checking ? "checking" : "ok"} size={18} />
            {checking ? "Checking" : "No active alerts"}
          </div>
          <ScrollFade className="mt-2 min-h-0 flex-1 pr-1">
            <ul className="flex flex-col gap-1 text-callout text-ink-2">
              {limitKnown && <li title={limit.title}>{limit.text}</li>}
              {health.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </ScrollFade>
        </>
      ) : (
        <ScrollFade className="min-h-0 flex-1 pr-1">
          {/* pb: the last row's button draws its outline as a shadow, which the scroll box would clip. */}
          <ul className="flex flex-col pb-0.5">
            {conditions.map((c) => (
              <AlertRow key={c.id} condition={c} compact={hasBanner(c, dismissed) || (limitedBar && c.id === "limited-mode")} />
            ))}
          </ul>
        </ScrollFade>
      )}
    </Card>
  );
}

function AlertRow({ condition: c, compact }: { condition: HealthCondition; compact: boolean }) {
  const tone = alertState(c.severity);
  return (
    <li
      className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-0 last:pb-0"
      title={[c.title, c.detail, `Rule: ${c.rule}`].filter(Boolean).join("\n")}
    >
      <StatusIcon tone={tone} size={18} className="mt-px" />
      <div className="min-w-0">
        {/* Tight mode keeps a row to three lines (title, detail, button); the hover text has all of it. */}
        <h4 className={compact ? "truncate text-headline text-ink" : "text-headline text-ink tight:truncate"}>{c.title}</h4>
        {!compact && c.detail && <p className="mt-0.5 line-clamp-3 text-callout text-ink-2 tight:line-clamp-1">{c.detail}</p>}
        {!compact && c.action && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => runHealthAction(c.action!)}>
              {c.action.label}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
