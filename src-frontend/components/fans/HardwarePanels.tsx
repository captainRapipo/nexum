import { useEffect, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type { AgentStatus, FanTelemetry, GpuTelemetry } from "../../types";
import GlassCard from "../layout/GlassCard";
import { KeyValueRow, Segmented, Tag, Unavailable, UNAVAILABLE_TEXT } from "../ui";
import { resolveUnavailable } from "../../lib/status";
import { toTempUnit } from "../../lib/format";
import { isZeroRpmIdle, rpmNumber } from "./fanHelpers";

type Unit = "C" | "F";

const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/* --------------------------------------------------------------------------- GPU cooling */

/**
 * GPU cooling, read-only. GPU fans are shown here only (never among the motherboard fans) and Nexum
 * never sends a command to them.
 */
export function GpuCoolingPanel({
  gpus,
  primary,
  gpuFans,
  labelOf,
  unit,
  agent,
  className,
}: {
  gpus: GpuTelemetry[];
  primary: GpuTelemetry | null;
  gpuFans: FanTelemetry[];
  labelOf: (id: string, defaultName: string) => string;
  unit: Unit;
  agent: AgentStatus | null;
  className?: string;
}) {
  const list = gpus.length > 0 ? gpus : primary ? [primary] : [];
  const primaryIdx = primary ? Math.max(0, list.findIndex((g) => g.name === primary.name)) : 0;
  const [idx, setIdx] = useState(primaryIdx);
  useEffect(() => {
    if (idx >= list.length) setIdx(0);
  }, [idx, list.length]);
  const gpu = list[idx] ?? null;
  const na = (v: number | null | undefined, fmt: (n: number) => string): ReactNode =>
    fin(v) ? fmt(v) : <Unavailable compact reason={resolveUnavailable(agent, "none")} />;
  const temp = (c: number, digits: number) => `${toTempUnit(c, unit).toFixed(digits)} °${unit}`;

  return (
    <GlassCard
      title="GPU cooling"
      className={className}
      actions={
        <>
          {list.length > 1 && (
            <Segmented
              size="sm"
              ariaLabel="Graphics card"
              value={idx}
              onChange={setIdx}
              options={list.map((g, i) => ({ value: i, label: `GPU ${i + 1}`, title: g.name }))}
            />
          )}
          <Tag title="Nexum shows GPU fans for information and never changes them." className="gap-1">
            <Lock size={10} aria-hidden="true" />
            Read-only
          </Tag>
        </>
      }
    >
      {!gpu ? (
        <div className="py-2 text-body">
          {resolveUnavailable(agent, "none") === "agentOffline" ? (
            <span className="text-callout text-ink-3">{UNAVAILABLE_TEXT.agentOffline}</span>
          ) : (
            <Unavailable reason="unsupported" />
          )}
        </div>
      ) : (
        <div>
          <KeyValueRow label="Adapter" value={gpu.name || "Unknown GPU"} />
          <KeyValueRow label="Load" value={na(gpu.load, (n) => `${n.toFixed(0)}%`)} />
          <KeyValueRow label="Edge temp" value={na(gpu.tempC, (n) => temp(n, 0))} />
          <KeyValueRow label="Hot spot" value={na(gpu.hotspotTempC, (n) => temp(n, 1))} />
          <KeyValueRow
            label="Fan"
            hint={isZeroRpmIdle(gpu) ? <Tag title="The GPU fan is stopped because the card is cool enough">Zero-RPM idle</Tag> : undefined}
            value={
              fin(gpu.fanRpm)
                ? `${rpmNumber(gpu.fanRpm)} rpm${fin(gpu.fanPct) ? ` · ${gpu.fanPct.toFixed(0)}%` : ""}`
                : na(gpu.fanPct, (n) => `${n.toFixed(0)}%`)
            }
          />
          {gpuFans.length > 1 &&
            gpuFans.map((f) => <KeyValueRow key={f.id} label={labelOf(f.id, f.name)} value={`${rpmNumber(f.rpm)} rpm`} />)}
          <KeyValueRow label="Memory junction" value={na(gpu.memJunctionTempC, (n) => temp(n, 1))} className="last:border-b-0" />
        </div>
      )}
    </GlassCard>
  );
}
