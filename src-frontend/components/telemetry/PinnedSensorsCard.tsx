import { ArrowUpRight, Pin, PinOff } from "lucide-react";
import { Unavailable } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { useSensors, useSensorStream } from "../../hooks/useSensors";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { resolveUnavailable } from "../../lib/status";
import { requestNavigate } from "../../lib/nav";
import { fmtSensorValue } from "../../lib/format";
import { needForHardware } from "./sensorHelpers";

/**
 * Pinned sensors (Dashboard): the user's pins, or the default rule (CPU temperature, GPU hot spot, VRM,
 * system-drive temperature) while nothing was pinned yet. Values come from the sensor stream, which is
 * switched on only while this card is mounted and shows at least one pin.
 */
export default function PinnedSensorsCard() {
  const { agent } = useTelemetry();
  const { settings } = useSettings();
  const tempUnit = settings?.tempUnit ?? "C";
  const { tree, byId, statsOf } = useSensors();
  const { pinned, labelOf, togglePin } = useSensorLabels();
  // The tree itself comes from get_sensor_tree; values are needed only while something is pinned.
  useSensorStream(pinned.length > 0);

  const openSensors = () => requestNavigate("sensors");

  let body;
  if (!tree) {
    body =
      agent && agent.running ? (
        <div className="py-3 text-[11.5px] text-muted">Reading the sensor list…</div>
      ) : (
        <div className="py-3 text-[11.5px]">
          <Unavailable reason="agentOffline" />
        </div>
      );
  } else if (pinned.length === 0) {
    body = (
      <div className="py-2 text-[11.5px] leading-relaxed text-muted">
        No pinned sensors. Pin any reading in the Sensors view (F2).
      </div>
    );
  } else {
    body = (
      <ul className="-mx-1 flex flex-col">
        {pinned.map((id) => {
          const entry = byId.get(id);
          const stats = statsOf(id);
          const name = entry ? labelOf(id, entry.meta.name) : labelOf(id, id.split("/").pop() || id);
          const hwName = entry?.hw.name ?? "Not in the current sensor list";
          const value = stats?.value ?? null;
          const hover = entry
            ? `${entry.meta.name} · ${entry.hw.name}\nMin ${fmtSensorValue(stats?.min ?? null, entry.meta, tempUnit)} · Max ${fmtSensorValue(
                stats?.max ?? null,
                entry.meta,
                tempUnit,
              )} · Avg ${fmtSensorValue(stats?.avg ?? null, entry.meta, tempUnit)}`
            : id;
          return (
            <li
              key={id}
              className="group flex items-center gap-2 rounded-md px-1 py-1.5 transition-colors hover:bg-white/[0.03]"
              title={hover}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-ink">{name}</div>
                <div className="truncate text-[10px] text-muted">{hwName}</div>
              </div>
              <div className="shrink-0 text-right">
                {entry && value !== null ? (
                  <>
                    <div className="font-mono text-[13px] font-semibold tabular-nums text-ink">
                      {fmtSensorValue(value, entry.meta, tempUnit)}
                    </div>
                    {stats?.max != null && !entry.meta.static && (
                      <div className="font-mono text-[9.5px] tabular-nums text-muted">
                        max {fmtSensorValue(stats.max, entry.meta, tempUnit)}
                      </div>
                    )}
                  </>
                ) : (
                  <Unavailable
                    compact
                    reason={entry ? resolveUnavailable(agent, needForHardware(entry.hw.kind)) : "unsupported"}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => togglePin(id)}
                title={`Unpin ${name}`}
                aria-label={`Unpin ${name}`}
                className="shrink-0 rounded p-1 text-muted opacity-0 transition hover:bg-white/[0.06] hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              >
                <PinOff size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <GlassCard
      title="Pinned sensors"
      icon={<Pin size={14} />}
      accent="cyan"
      actions={
        <button
          type="button"
          onClick={openSensors}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-cyan"
          title="Open Sensors (F2)"
        >
          Sensors
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </button>
      }
    >
      {body}
    </GlassCard>
  );
}
