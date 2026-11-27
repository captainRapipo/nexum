import { useMemo } from "react";
import { Thermometer } from "lucide-react";
import type { AgentStatus } from "../../types";
import GlassCard from "../layout/GlassCard";
import { Unavailable } from "../ui";
import { useSensors } from "../../hooks/useSensors";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { COOLING_TEMP_RULES, resolveRules } from "../../lib/sensors";
import { resolveUnavailable } from "../../lib/status";
import { fmtSensorValue } from "../../lib/format";
import { needForHardware } from "../telemetry/sensorHelpers";

/**
 * Temperatures that drive fan decisions (ROADMAP §6.5): CPU Tctl/Tdie, VRM MOS, Chipset, System #1/#2,
 * GPU hot spot. Sensors the board does not have are omitted. The caller keeps the sensor stream on.
 */
export default function CoolingTemps({ agent, tempUnit }: { agent: AgentStatus | null; tempUnit: "C" | "F" }) {
  const { tree, byId, statsOf } = useSensors();
  const { labelOf } = useSensorLabels();
  const metas = useMemo(() => resolveRules(tree, COOLING_TEMP_RULES), [tree]);

  return (
    <GlassCard title="Temperatures" icon={<Thermometer size={15} />} accent="cyan">
      {!tree ? (
        <div className="py-4 text-[12px]">
          {agent?.running ? <span className="text-muted">Reading the sensor list…</span> : <Unavailable reason="agentOffline" />}
        </div>
      ) : metas.length === 0 ? (
        <div className="py-4 text-[12px]">
          <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-4 gap-y-1.5 text-[12.5px]">
          <span className="text-[9.5px] uppercase tracking-[0.16em] text-muted">Sensor</span>
          <span className="text-right text-[9.5px] uppercase tracking-[0.16em] text-muted">Now</span>
          <span className="text-right text-[9.5px] uppercase tracking-[0.16em] text-muted">Max</span>
          {metas.map((m) => {
            const hw = byId.get(m.id)?.hw;
            const st = statsOf(m.id);
            const name = labelOf(m.id, m.name);
            return (
              <div key={m.id} className="contents">
                <span className="min-w-0 truncate text-ink" title={`${m.name} · ${hw?.name ?? ""}`}>
                  {name}
                  <span className="ml-1.5 text-[10.5px] text-muted">{hw?.name}</span>
                </span>
                <span className="text-right font-mono tabular-nums text-ink">
                  {st?.value != null ? (
                    fmtSensorValue(st.value, m, tempUnit)
                  ) : (
                    <Unavailable compact reason={resolveUnavailable(agent, needForHardware(hw?.kind))} />
                  )}
                </span>
                <span className="text-right font-mono tabular-nums text-slate-400">{fmtSensorValue(st?.max ?? null, m, tempUnit)}</span>
              </div>
            );
          })}
        </div>
      )}
    </GlassCard>
  );
}
