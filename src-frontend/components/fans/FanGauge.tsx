import { Sparkline } from "../ui";
import { cn } from "../../lib/format";
import { rpmNumber } from "./fanHelpers";

export interface FanGaugeProps {
  /** Current speed; 0 = not spinning. */
  rpm: number;
  /** Session minimum / maximum (null = not reported). */
  rpmMin?: number | null;
  rpmMax?: number | null;
  /** Recent speeds, oldest first, for the 30 px sparkline. */
  history?: readonly (number | null)[];
  className?: string;
}

/**
 * Fan speed readout (1.2: the arc gauge is retired, SPEC §15 / mock cooling-fans): a large rpm
 * number, the session min / max beside it and a neutral sparkline underneath. A sparkline never
 * takes a status colour.
 */
export default function FanGauge({ rpm, rpmMin, rpmMax, history, className }: FanGaugeProps) {
  const stopped = !(rpm > 0);
  return (
    <div className={className}>
      <div className="flex items-end justify-between gap-4">
        <div className="tnum whitespace-nowrap text-display text-ink tight:text-display-tight" aria-label={`${rpmNumber(rpm)} rpm`}>
          {rpmNumber(rpm)}
          <small className="ml-[3px] text-[15px] font-medium tracking-normal text-ink-2">rpm</small>
        </div>
        <div className={cn("tnum whitespace-nowrap text-right text-callout text-ink-2")}>
          {stopped ? (
            "Not spinning"
          ) : (
            <>
              Min {rpmNumber(rpmMin)}
              <br />
              Max {rpmNumber(rpmMax)}
            </>
          )}
        </div>
      </div>
      <div className="mb-3 mt-2.5 h-[30px]">{history && <Sparkline data={history} height={30} strokeWidth={1.25} fill />}</div>
    </div>
  );
}
