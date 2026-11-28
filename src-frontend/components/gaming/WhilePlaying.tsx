import { useMemo } from "react";
import { NOT_AVAILABLE_TEXT, type TelemetryPacket } from "../../types";
import { cn, toTempUnit } from "../../lib/format";

export interface WhilePlayingProps {
  /** `useTelemetry().history` (oldest first). */
  history: readonly TelemetryPacket[];
  /** Statistics window of the frame data (s): the averages cover the same span. */
  windowSec: number;
  tempUnit: "C" | "F";
  className?: string;
}

/** `Average of the last 30 s`: the header meta of the card. */
export function whilePlayingMeta(windowSec: number): string {
  return `Average of the last ${windowSec} s`;
}

/** Mean of the readings that exist; null when none does (unavailable is not zero). */
function mean(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? null : sum / n;
}

function Cell({ label, value, unit }: { label: string; value: string | null; unit: string }) {
  return (
    <div className="min-w-0 border-l border-divider px-3 first:border-l-0 first:pl-0">
      <span className="block truncate text-caption text-ink-2">{label}</span>
      <div className="tnum mt-0.5 whitespace-nowrap text-[16px] font-semibold leading-[22px] text-ink">
        {value == null ? (
          <span className="text-ink-3" title={NOT_AVAILABLE_TEXT} aria-label={NOT_AVAILABLE_TEXT}>
            —
          </span>
        ) : (
          <>
            {value}
            <small className="ml-0.5 text-[11.5px] font-medium leading-none text-ink-3">{unit}</small>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What the PC did while the frames above were measured (CONTRACT §4.10.3): averages of the live
 * telemetry over the frame window. Read from the stream the app already has; nothing new is fetched.
 */
export default function WhilePlaying({ history, windowSec, tempUnit, className }: WhilePlayingProps) {
  const avg = useMemo(() => {
    const newest = history.length > 0 ? history[history.length - 1].ts : 0;
    const from = newest - windowSec * 1000;
    const span = history.filter((p) => p.ts >= from);
    const gpu = (pick: (g: NonNullable<TelemetryPacket["gpu"]>) => number | null) => mean(span.map((p) => (p.gpu ? pick(p.gpu) : null)));
    return {
      cpuTemp: mean(span.map((p) => p.cpu.packageTempC)),
      gpuHot: gpu((g) => g.hotspotTempC),
      gpuEdge: gpu((g) => g.tempC),
      gpuPower: gpu((g) => g.powerW),
      cpuLoad: mean(span.map((p) => p.cpu.loadTotal)),
      vram: gpu((g) => g.vramUsedGb),
      gpuFan: gpu((g) => g.fanRpm),
    };
  }, [history, windowSec]);

  const temp = (c: number | null) => (c == null ? null : toTempUnit(c, tempUnit).toFixed(1));
  const row = "grid grid-cols-3 border-t border-divider py-2.5 tight:py-[7px]";

  return (
    <div className={cn("flex flex-col", className)}>
      <div className={row}>
        <Cell label="CPU" value={temp(avg.cpuTemp)} unit={`°${tempUnit}`} />
        {/* Hot spot when the card reports one, else the edge temperature under its own name: never one as the other. */}
        {avg.gpuHot != null || avg.gpuEdge == null ? (
          <Cell label="GPU hot spot" value={temp(avg.gpuHot)} unit={`°${tempUnit}`} />
        ) : (
          <Cell label="GPU edge temp" value={temp(avg.gpuEdge)} unit={`°${tempUnit}`} />
        )}
        <Cell label="GPU power" value={avg.gpuPower == null ? null : Math.round(avg.gpuPower).toString()} unit="W" />
      </div>
      <div className={cn(row, "pb-0 tight:pb-0")}>
        <Cell label="CPU load" value={avg.cpuLoad == null ? null : Math.round(avg.cpuLoad).toString()} unit="%" />
        <Cell label="VRAM" value={avg.vram == null ? null : avg.vram.toFixed(1)} unit="GB" />
        <Cell label="GPU fan" value={avg.gpuFan == null ? null : Math.round(avg.gpuFan).toLocaleString("en-US")} unit="rpm" />
      </div>
    </div>
  );
}
