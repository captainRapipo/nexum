// First-run update question (CONTRACT §2.15.3). Shown once, while Settings.updateCheck is still "ask".
// Until it is answered Rust makes no network request at all; either answer ends the question for good.
import { useState } from "react";
import { UPDATE_TEXT, type UpdateCheckMode } from "../../types";
import { errorMessage } from "../../lib/api";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useUpdater } from "../../hooks/useUpdater";
import { toast } from "../feedback/Toast";
import { Button, Modal } from "../ui";

export interface UpdatePromptProps {
  /** True while another app-level dialog is open (Settings, cache cleanup, the update dialog): the question waits. */
  blocked?: boolean;
}

export function UpdatePrompt({ blocked = false }: UpdatePromptProps) {
  const { settings, update: saveSettings, loaded } = useSettings();
  const { update } = useUpdater();
  const { agent } = useTelemetry();
  const [saving, setSaving] = useState(false);

  // The PawnIO first-run screen comes first (CONTRACT §5.4). While the driver choice is undecided, wait
  // until it is known whether that screen applies (it needs the first sensor report), and while it shows.
  const reasons = agent?.limitedReasons ?? [];
  const pawnIoScreen =
    settings.sensorDriverChoice === "undecided" &&
    (agent == null ||
      agent.phase === "starting" ||
      agent.phase === "restarting" ||
      reasons.includes("pawnIoMissing") ||
      reasons.includes("pawnIoOutdated"));

  const open =
    loaded &&
    settings.updateCheck === "ask" &&
    // Rust has answered get_update_state, and this build can update from inside the app.
    update.currentVersion !== "" &&
    update.state !== "disabled" &&
    !pawnIoScreen &&
    !blocked;

  const answer = async (mode: Exclude<UpdateCheckMode, "ask">) => {
    if (saving) return;
    setSaving(true);
    try {
      // Saving "auto" is all it takes: Rust re-arms its schedule when the setting changes (§2.15.4).
      await saveSettings({ updateCheck: mode });
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="alert"
      open={open}
      // Esc and closing the dialog mean "Not now".
      onClose={() => void answer("manual")}
      dismissible={!saving}
      closeOnBackdrop={false}
      title={UPDATE_TEXT.askTitle}
      footer={
        <>
          <Button className="min-w-24" onClick={() => void answer("manual")} disabled={saving}>
            {UPDATE_TEXT.askNo}
          </Button>
          <Button variant="primary" className="min-w-24" onClick={() => void answer("auto")} disabled={saving}>
            {UPDATE_TEXT.askYes}
          </Button>
        </>
      }
    >
      <p className="text-body text-ink-2">{UPDATE_TEXT.askBody}</p>
      <p className="mt-2 text-callout text-ink-3">{UPDATE_TEXT.askNote}</p>
    </Modal>
  );
}

export default UpdatePrompt;
