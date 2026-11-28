import { useCallback, useState } from "react";
import { HealthBanner } from "../ui";
import { toast } from "../feedback/Toast";
import { useHealth } from "../../hooks/useHealth";
import { useHealthAlerts } from "../../hooks/useHealthAlerts";
import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/format";
import type { HealthCondition } from "../../types";
import { runHealthAction } from "./healthActions";

/**
 * Dashboard drive banners (MF-1, CONTRACT §5.4): one in-page banner per drive condition (ids "drive:<id>",
 * evaluated by Rust and mapped by deriveHealth) with severity warn or crit that the user has not dismissed.
 * A worse state produces a new dismiss key, so the banner comes back. Dismiss goes through
 * `dismiss_alert` (CONTRACT §2.10.5), which also mutes desktop notifications for that key; it never hides
 * the header pill or the Health alerts card.
 */
export default function DriveWearBanners({ className }: { className?: string }) {
  const health = useHealth();
  const { settings } = useSettings();
  const { dismiss: dismissAlert } = useHealthAlerts();
  // Hidden at once on click; the saved Settings list takes over once it arrives.
  const [justDismissed, setJustDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismissed = settings?.dismissedAlerts ?? [];

  const banners = health.conditions.filter(
    (c) =>
      c.id.startsWith("drive:") &&
      (c.severity === "warn" || c.severity === "crit") &&
      !dismissed.includes(c.dismissKey) &&
      !justDismissed.has(c.dismissKey),
  );

  const dismiss = useCallback(
    (c: HealthCondition) => {
      const key = c.dismissKey;
      setJustDismissed((prev) => new Set(prev).add(key));
      dismissAlert(key).catch((e: unknown) => {
        setJustDismissed((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "crit");
      });
    },
    [dismissAlert],
  );

  if (banners.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
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
