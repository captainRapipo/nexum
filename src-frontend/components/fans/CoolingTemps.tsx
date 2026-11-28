import { useMemo } from "react";
import type { AgentStatus } from "../../types";
import GlassCard from "../layout/GlassCard";
import { Sparkline, Unavailable, UNAVAILABLE_TEXT } from "../ui";
import { useSensors } from "../../hooks/useSensors";
import { useSensorLabels } from "../../hooks/useSensorLabels";
import { COOLING_TEMP_RULES, resolveRules } from "../../lib/sensors";
import { resolveUnavailable, sensorsUp } from "../../lib/status";
import { cn, toTempUnit } from "../../lib/format";
import { needForHardware } from "./fanHelpers";

const TH = "h-[26px] border-b border-hairline text-left text-[11px] font-semibold text-ink-2";
const TD = "h-[31px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-divider group-last:border-b-0";

/**
 * Temperatures that drive fan decisions (ROADMAP §6.5): CPU Tctl/Tdie, VRM MOS, Chipset, System #1/#2,
 * GPU hot spot. Sensors the board does not have are omitted. The caller keeps the sensor stream on.
 * The unit is shown once, in the Now cell (CONTRACT §4.8).
 */
export default function CoolingTemps({ agent, tempUnit, className }: { agent: AgentStatus | null; tempUnit: "C" | "F"; className?: string }) {
  const { tree, byId, statsOf, historyOf } = useSensors();
  const { labelOf } = useSensorLabels();
  const metas = useMemo(() => resolveRules(tree, COOLING_TEMP_RULES), [tree]);
  // While sensor reading is not up the held values are the last ones of a process that is gone:
  // the rows show "—" (hover "Not available right now"), not frozen numbers.
  const up = sensorsUp(agent);
  const num = (c: number | null | undefined, decimals: number) => (c == null || !Number.isFinite(c) ? null : toTempUnit(c, tempUnit).toFixed(decimals));

  return (
    <GlassCard title="Temperatures" actions="The readings fan curves react to" className={className}>
      {!tree ? (
        <div className="py-2 text-body">
          {/* An empty card says why in words; a single missing value elsewhere is a dash with this text as its hover. */}
          {agent?.running ? <span className="text-ink-2">Reading the sensor list…</span> : <span className="text-callout text-ink-3">{UNAVAILABLE_TEXT.agentOffline}</span>}
        </div>
      ) : metas.length === 0 ? (
        <div className="py-2 text-body">
          <Unavailable reason={resolveUnavailable(agent, "pawnio")} />
        </div>
      ) : (
        <table className="tnum w-full table-fixed border-collapse text-[13px] leading-none">
          <caption className="sr-only">Temperatures behind fan decisions</caption>
          <colgroup>
            <col />
            <col className="w-[84px]" />
            <col className="w-[84px]" />
            <col className="w-[150px] tight:w-[110px]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={TH}>Sensor</th>
              <th scope="col" className={cn(TH, "text-right")}>Now</th>
              <th scope="col" className={cn(TH, "text-right")}>Max</th>
              <th scope="col" className={cn(TH, "pl-[18px]")}>Last 60 s</th>
            </tr>
          </thead>
          <tbody>
            {metas.map((m) => {
              const hw = byId.get(m.id)?.hw;
              const st = up ? statsOf(m.id) : null;
              const name = labelOf(m.id, m.name);
              const now = num(st?.value, m.decimals);
              const max = num(st?.max, m.decimals);
              return (
                <tr key={m.id} className="group">
                  <td className={cn(TD, "text-ink")} title={`${m.name} · ${hw?.name ?? ""}`}>
                    {name}
                    <span className="ml-1.5 text-[12px] text-ink-3">{hw?.name}</span>
                  </td>
                  <td className={cn(TD, "text-right font-semibold text-ink")}>
                    {now != null ? (
                      <>
                        {now}
                        <span className="ml-[3px] font-normal text-ink-3">°{tempUnit}</span>
                      </>
                    ) : (
                      <Unavailable compact reason={resolveUnavailable(agent, needForHardware(hw?.kind))} />
                    )}
                  </td>
                  <td className={cn(TD, "text-right text-ink-2")}>{max ?? "—"}</td>
                  <td className={cn(TD, "pl-[18px]")}>
                    {up && <Sparkline data={historyOf(m.idx)} height={14} strokeWidth={1.25} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </GlassCard>
  );
}
