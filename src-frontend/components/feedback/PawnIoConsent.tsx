import { useState } from "react";
import { Cpu, ExternalLink } from "lucide-react";
import { api, errorMessage, PAWNIO_URL } from "../../lib/api";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { toast } from "./Toast";

/**
 * First-run sensor-driver choice (MF-3, CONTRACT §5.4). Shown once while
 * `sensorDriverChoice === "undecided"` and the agent reports PawnIO missing or outdated.
 * "No kernel driver" is a first-class choice, not an error.
 */
export function PawnIoConsent() {
  const { settings, update, loaded } = useSettings();
  const { agent } = useTelemetry();
  const [saving, setSaving] = useState(false);

  const reasons = agent?.running ? (agent.limitedReasons ?? []) : [];
  const outdated = reasons.includes("pawnIoOutdated");
  const needed = outdated || reasons.includes("pawnIoMissing");
  const open = loaded && settings.sensorDriverChoice === "undecided" && needed;

  const choose = async (choice: "pawnio" | "none") => {
    setSaving(true);
    try {
      if (choice === "pawnio") await api.openExternal(PAWNIO_URL);
    } catch (err) {
      toast(errorMessage(err), "warn");
    }
    try {
      await update({ sensorDriverChoice: choice });
    } catch (err) {
      toast(errorMessage(err), "warn");
    } finally {
      setSaving(false);
    }
  };

  const version = agent?.sensorDriver?.version;
  const minVersion = agent?.sensorDriver?.minVersion ?? "2.1.0";

  return (
    <Modal
      open={open}
      onClose={() => void choose("none")}
      dismissible={!saving}
      closeOnBackdrop={false}
      title={outdated ? "Update the sensor driver?" : "Use a sensor driver?"}
      subtitle="CPU, motherboard and fan sensors need a kernel driver"
      icon={Cpu}
      size="md"
      footer={
        <>
          <span className="min-w-0 flex-1" />
          <Button variant="ghost" onClick={() => void choose("none")} disabled={saving}>
            Continue without kernel driver
          </Button>
          <Button variant="teal" icon={ExternalLink} onClick={() => void choose("pawnio")} loading={saving}>
            Get PawnIO
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] leading-relaxed text-slate-300">
        <p>
          PawnIO is a vendor-signed kernel driver. Nexum uses it to read CPU temperature, power and clock, motherboard
          temperatures, voltages and fans, and to control fans.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-slate-400">
          <li>Install it from its official website, pawnio.eu. Nexum never installs or uninstalls it, because other apps may use it.</li>
          <li>
            Nexum needs version {minVersion} or newer.
            {outdated && version ? ` This PC has ${version}.` : ""}
          </li>
          <li>Without it, Nexum still shows GPU, drive, memory and network data, and CPU load.</li>
        </ul>
        <p className="text-[12px] text-muted">You can change this later in Settings › Sensor driver.</p>
      </div>
    </Modal>
  );
}

export default PawnIoConsent;
