import { useCallback } from "react";
import { HealthBanner } from "../ui";
import { toast } from "../feedback/Toast";
import { useHealth } from "../../hooks/useHealth";
import { useSettings } from "../../hooks/useSettings";
import type { HealthCondition } from "../../types";
import { runHealthAction } from "./healthActions";

/** Max dismissal keys kept in settings (CONTRACT §2.2: keep last 200). */
const MAX_DISMISSED = 200;

/**
 * Dashboard drive banners (MF-1, CONTRACT §5.4): one per drive condition (rule 4, ids "drive:<id>")
 * with severity warn or crit that the user has not dismissed. A worse state produces a new dismiss key,
 * so the banner comes back. Dismissal never hides the header pill or the Health alerts card.
 */
export default function DriveWearBanners() {
  const health = useHealth();
  const { settings, update } = useSettings();
  const dismissed = settings?.dismissedAlerts ?? [];

  const banners = health.conditions.filter(
    (c) => c.id.startsWith("drive:") && (c.severity === "warn" || c.severity === "crit") && !dismissed.includes(c.dismissKey),
  );

  const dismiss = useCallback(
    (c: HealthCondition) => {
      const prev = settings?.dismissedAlerts ?? [];
      if (prev.includes(c.dismissKey)) return;
      const next = [...prev, c.dismissKey].slice(-MAX_DISMISSED);
      Promise.resolve(update({ dismissedAlerts: next })).catch((e: unknown) =>
        toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "crit"),
      );
    },
    [settings?.dismissedAlerts, update],
  );

  if (banners.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {banners.map((c) => (
        <HealthBanner
          key={c.id}
          alert={c}
          onAction={c.action ? () => runHealthAction(c.action!) : undefined}
          onDismiss={() => dismiss(c)}
        />
      ))}
    </div>
  );
}
