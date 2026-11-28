import { useMemo, useState } from "react";
import { Card, InkLink, Meter, Tag, Unavailable } from "../ui";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { useTightMode } from "../../hooks/useTightMode";
import { resolveUnavailable, sensorsUp } from "../../lib/status";
import { requestNavigate } from "../../lib/nav";
import { clamp, cn } from "../../lib/format";
import { NOT_AVAILABLE_TEXT, type FanPreset, type FanTelemetry, type UnavailableReason } from "../../types";
import { countText, finite, isGpuFan, tempText } from "./sensorHelpers";

/** Meter scale floor for fans without a duty reading, so a quiet 600 rpm case fan doesn't look pegged. */
const RPM_SCALE_FLOOR = 2000;

const PRESET_LABEL: Record<FanPreset, string> = {
  auto: "BIOS auto",
  silent: "Silent",
  balanced: "Balanced",
  turbo: "Turbo",
  custom: "Custom",
};

/** Why the motherboard's fan headers are not listed, in a full sentence. */
const BOARD_FANS_WHY: Record<UnavailableReason, string | null> = {
  notElevated: "Motherboard fan speeds are read through the Super I/O chip, which needs administrator rights.",
  pawnIoMissing: "Motherboard fan speeds are read through the Super I/O chip, which needs the PawnIO driver.",
  pawnIoOutdated: "Motherboard fan speeds are read through the Super I/O chip, which needs a newer PawnIO driver.",
  unsupported: null,
  agentOffline: null,
};

/** A header that never spun this session and is not driven by Nexum. */
function isUnused(f: FanTelemetry, manualActive: boolean): boolean {
  const max = f.rpmMax ?? (finite(f.rpm) ? f.rpm : null);
  return max === 0 && !(manualActive && f.controllable);
}

/**
 * "Cooling" (CONTRACT §4.10.3): one row per fan with its speed, duty and a meter; a neutral tag for
 * the fan preset; a footer naming the temperatures that drive fan decisions. Motherboard fans come
 * first, GPU fans after them (tagged, never substituted for a motherboard fan). A row opens to show
 * the header's hardware, control mode and session minimum / maximum.
 */
export default function FanList({ className }: { className?: string }) {
  const { latest, agent } = useTelemetry();
  const { settings } = useSettings();
  const { labelOf } = useSensorLabels();
  const tight = useTightMode();
  const tempUnit = settings?.tempUnit ?? "C";
  const [expanded, setExpanded] = useState<string | null>(null);

  const manualActive = !!latest?.fanSafety?.manualActive;
  const { board, gpu, hidden } = useMemo(() => {
    const all = latest?.fans ?? [];
    const b = all.filter((f) => !isGpuFan(f) && !isUnused(f, manualActive));
    // A graphics-card fan is never an "unused header": at 0 rpm it is in zero-RPM idle, and the row says so.
    const g = all.filter((f) => isGpuFan(f));
    return { board: b, gpu: g, hidden: all.length - b.length - g.length };
  }, [latest?.fans, manualActive]);
  const rows = [...board, ...gpu];

  const scale = useMemo(() => {
    let m = RPM_SCALE_FLOOR;
    for (const f of rows) m = Math.max(m, f.rpmMax ?? 0, finite(f.rpm) ? f.rpm : 0);
    return m;
    // eslint-disable-next-line
  }, [board, gpu]);

  const preset = latest?.fanPreset ? (PRESET_LABEL[latest.fanPreset] ?? latest.fanPreset) : null;
  const held = !!latest?.fanSafety?.overrideActive;

  // No motherboard header at all although the PC has fans: say why (limited mode), then list the rest.
  const boardReason = resolveUnavailable(agent, "pawnio");
  const boardMissing = !!latest && (latest.fans ?? []).every((f) => isGpuFan(f)) && boardReason !== "unsupported" && boardReason !== "agentOffline";

  const cpuTemp = latest?.cpu?.packageTempC;
  const gpuTemp = latest?.gpu?.tempC;
  const drivers = [finite(cpuTemp) ? `CPU ${tempText(cpuTemp, tempUnit, 1)}` : null, finite(gpuTemp) ? `GPU ${tempText(gpuTemp, tempUnit)}` : null].filter(
    (s): s is string => !!s,
  );

  return (
    <Card
      title="Cooling"
      actions={
        <span className="flex items-center gap-2.5">
          {held ? (
            <Tag title="Fans are held at 100% for safety. Details are on the Cooling page.">Held at 100%</Tag>
          ) : (
            preset && <Tag title={`Fan preset: ${preset}`}>{preset}</Tag>
          )}
          <InkLink onClick={() => requestNavigate("cooling")} title="Open Cooling (F6)">
            Cooling
          </InkLink>
        </span>
      }
      footer={
        !tight && drivers.length > 0 ? (
          <>
            <span>Curve driven by</span>
            <span className="truncate font-medium text-ink tnum">{drivers.join(" · ")}</span>
          </>
        ) : undefined
      }
      className={className}
    >
      {!latest ? (
        <p className="text-callout text-ink-3">{sensorsUp(agent) ? "Waiting for sensor data…" : NOT_AVAILABLE_TEXT}</p>
      ) : (
        <>
          {boardMissing && (
            <div className="pb-3 pt-1">
              <Unavailable reason={boardReason} />
              {BOARD_FANS_WHY[boardReason] && <p className="mt-2 text-callout text-ink-2">{BOARD_FANS_WHY[boardReason]}</p>}
            </div>
          )}
          {rows.length === 0 && !boardMissing && (
            <p className="text-callout text-ink-2">
              {(latest.fans ?? []).length === 0 ? (
                <Unavailable reason={boardReason} />
              ) : (
                `${hidden} unused ${hidden === 1 ? "header" : "headers"} hidden (0 rpm this session).`
              )}
            </p>
          )}
          {rows.length > 0 && (
            <ul className="-mt-2 flex flex-col">
              {rows.map((f, i) => {
                const open = expanded === f.id;
                const rpm = finite(f.rpm) ? f.rpm : null;
                const duty = finite(f.controlPct) ? clamp(f.controlPct, 0, 100) : null;
                const fill = duty ?? (rpm !== null ? clamp((rpm / scale) * 100, 0, 100) : 0);
                const name = labelOf(f.id, f.name);
                const gpuFan = isGpuFan(f);
                return (
                  <li key={f.id} className="border-b border-divider last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : f.id)}
                      aria-expanded={open}
                      aria-controls={open ? `fan-detail-${i}` : undefined}
                      title={open ? "Hide details" : "Show details"}
                      className="focus-inset grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-[5px] py-2 text-left tight:py-1.5"
                    >
                      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-[17px] text-ink">
                        <span className="truncate" title={name !== f.name ? `${name} (${f.name})` : undefined}>
                          {name}
                        </span>
                        {gpuFan && <Tag title="This fan belongs to the graphics card">GPU</Tag>}
                      </span>
                      <span className="whitespace-nowrap text-right text-[13px] font-semibold leading-[17px] text-ink tnum">
                        {countText(rpm)}
                        <span className="ml-0.5 text-[11.5px] font-medium text-ink-3">rpm</span>
                        {duty !== null && <span className="ml-2 font-normal text-ink-3">{duty.toFixed(0)}%</span>}
                      </span>
                      <Meter value={fill} height={4} className="col-span-2" label={`${name}: ${duty !== null ? `${duty.toFixed(0)}% duty` : `${countText(rpm)} rpm`}`} />
                    </button>
                    {open && (
                      <dl id={`fan-detail-${i}`} className="grid grid-cols-2 gap-x-4 gap-y-0.5 pb-2 text-callout">
                        <Detail label="Hardware" value={f.hardware || "—"} wide />
                        {name !== f.name && <Detail label="Sensor" value={f.name} wide />}
                        <Detail label="Duty" value={duty !== null ? `${duty.toFixed(0)}%` : f.controllable ? "BIOS" : "Read-only"} />
                        <Detail label="Control" value={gpuFan ? "Read-only" : f.controllable ? "PWM" : "Read-only"} />
                        <Detail label="Min" value={finite(f.rpmMin) ? `${countText(f.rpmMin)} rpm` : "—"} />
                        <Detail label="Max" value={finite(f.rpmMax) ? `${countText(f.rpmMax)} rpm` : "—"} />
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {hidden > 0 && rows.length > 0 && (
            <p className="pt-1.5 text-callout text-ink-3" title="Headers that have read 0 rpm since Nexum started. The Cooling page can show them.">
              {hidden} unused {hidden === 1 ? "header" : "headers"} hidden
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-2", wide && "col-span-2")}>
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="truncate text-ink tnum" title={value}>
        {value}
      </dd>
    </div>
  );
}
