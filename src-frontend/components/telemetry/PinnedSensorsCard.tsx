import { useState } from "react";
import { PinOff } from "lucide-react";
import { Card, IconButton, InkLink, Sparkline, Unavailable } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { useSensors, useSensorStream } from "../../hooks/useSensors";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { resolveUnavailable, sensorsUp } from "../../lib/status";
import { NOT_AVAILABLE_TEXT } from "../../types";
import { requestNavigate } from "../../lib/nav";
import { cn, fmtSensorValue } from "../../lib/format";
import { needForHardware, sensorValueParts } from "./sensorHelpers";

/** Rows shown on the Dashboard; further pins stay in the Sensors view. */
const MAX_ROWS = 5;
const NO_HISTORY: readonly (number | null)[] = [];

/**
 * Pinned sensors (CONTRACT §4.10.3): the user's pins, or the default rule (CPU temperature, GPU hot
 * spot, VRM, system-drive temperature) while nothing was pinned yet. Up to five rows: name, device, a
 * neutral 60 s sparkline (regular mode), the value and its session maximum. "Edit" turns the
 * sparklines into Unpin buttons. Values come from the sensor stream, which is switched on only while
 * this card is mounted and shows at least one pin.
 */
export default function PinnedSensorsCard({ className }: { className?: string }) {
  const { agent } = useTelemetry();
  const { settings } = useSettings();
  const tempUnit = settings?.tempUnit ?? "C";
  const { tree, values, byId, statsOf, historyOf } = useSensors();
  const { pinned, labelOf, togglePin } = useSensorLabels();
  const [editing, setEditing] = useState(false);
  // The tree itself comes from get_sensor_tree; values are needed only while something is pinned.
  useSensorStream(pinned.length > 0);

  const shown = pinned.slice(0, MAX_ROWS);
  const more = pinned.length - shown.length;
  const canEdit = !!tree && pinned.length > 0;
  const isEditing = editing && canEdit;

  let body;
  if (!tree) {
    // An empty card says why in words; single missing values elsewhere stay a dash with this text as the hover.
    body = <p className="text-callout text-ink-3">{sensorsUp(agent) ? "Reading the sensor list…" : NOT_AVAILABLE_TEXT}</p>;
  } else if (pinned.length === 0) {
    body = <p className="text-callout text-ink-2">No pinned sensors. Pin any reading in the Sensors view (F2).</p>;
  } else {
    body = (
      <ul className="-mt-1 flex flex-col">
        {shown.map((id) => {
          const entry = byId.get(id);
          const stats = statsOf(id);
          const name = entry ? labelOf(id, entry.meta.name) : labelOf(id, id.split("/").pop() || id);
          const hwName = entry?.hw.name ?? "Not in the current sensor list";
          const value = stats?.value ?? null;
          const parts = entry ? sensorValueParts(value, entry.meta, tempUnit) : null;
          const max = entry && stats?.max != null && !entry.meta.static ? sensorValueParts(stats.max, entry.meta, tempUnit).num : null;
          // No values packet for the current sensor list yet (just after start, a rescan or a settings
          // change): the value is only missing for a moment, so no cause and no lock are shown.
          const unavailable = !entry ? "unsupported" : values == null ? "agentOffline" : resolveUnavailable(agent, needForHardware(entry.hw.kind));
          const hover = entry
            ? `${entry.meta.name} · ${entry.hw.name}\nMin ${fmtSensorValue(stats?.min ?? null, entry.meta, tempUnit)} · Max ${fmtSensorValue(
                stats?.max ?? null,
                entry.meta,
                tempUnit,
              )} · Avg ${fmtSensorValue(stats?.avg ?? null, entry.meta, tempUnit)}`
            : id;
          return (
            <li key={id} className="flex h-[42px] items-center gap-3 border-b border-divider last:border-b-0 tight:h-[38px]" title={hover}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium leading-[17px] text-ink">{name}</div>
                <div className="truncate text-callout text-ink-3">{hwName}</div>
              </div>
              {isEditing ? (
                <IconButton icon={PinOff} label={`Unpin ${name}`} onClick={() => togglePin(id)} className="shrink-0" />
              ) : !entry || value === null ? null : (
                <div className="w-[72px] shrink-0 tight:hidden" aria-hidden="true">
                  {entry && !entry.meta.static && <Sparkline data={historyOf(entry.meta.idx) ?? NO_HISTORY} height={18} strokeWidth={1.25} />}
                </div>
              )}
              <div className={cn("shrink-0 text-right", entry && value !== null ? "w-[74px]" : "max-w-[60%]")}>
                {entry && parts && value !== null ? (
                  <>
                    <div className="whitespace-nowrap text-[15px] font-semibold leading-none tracking-[-0.01em] text-ink tnum">
                      {parts.num}
                      {parts.unit && <span className="ml-0.5 text-[11.5px] font-medium tracking-normal text-ink-3">{parts.unit}</span>}
                    </div>
                    {max != null && <div className="mt-[3px] whitespace-nowrap text-callout leading-none text-ink-3 tnum">max {max}</div>}
                  </>
                ) : (
                  <>
                    <span className="tight:hidden">
                      <Unavailable reason={unavailable} />
                    </span>
                    <span className="hidden tight:inline">
                      <Unavailable compact reason={unavailable} />
                    </span>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card
      title="Pinned sensors"
      actions={
        <span className="flex items-center gap-3.5">
          {canEdit && (
            <InkLink chevron={false} onClick={() => setEditing((v) => !v)} aria-pressed={isEditing} title="Choose which sensors stay pinned">
              {isEditing ? "Done" : "Edit"}
            </InkLink>
          )}
          <InkLink onClick={() => requestNavigate("sensors")} title="Open Sensors (F2)">
            Sensors
          </InkLink>
        </span>
      }
      footer={
        more > 0 ? (
          <>
            <span>
              {more} more pinned {more === 1 ? "sensor" : "sensors"}
            </span>
            <span>shown in Sensors</span>
          </>
        ) : undefined
      }
      className={className}
    >
      {body}
    </Card>
  );
}
