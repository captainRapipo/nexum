import { cn } from "../../lib/format";

export interface FanGaugeProps {
  rpm: number;
  maxRpm: number;
  /** Arc colour as CSS colour. */
  color?: string;
  size?: number;
  stalled?: boolean;
}

/**
 * 240° SVG arc gauge for a fan's RPM, with tick marks and a glowing value arc.
 * Pure SVG (no chart instance per fan) to keep the fan grid cheap to re-render at 1 Hz.
 */
export default function FanGauge({ rpm, maxRpm, color = "#22D3EE", size = 132, stalled }: FanGaugeProps) {
  const r = 52;
  const cx = 64;
  const cy = 64;
  const startDeg = 150;
  const sweep = 240;
  const frac = maxRpm > 0 ? Math.max(0, Math.min(1, rpm / maxRpm)) : 0;

  const polar = (deg: number, rad = r) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = polar(from);
    const [x2, y2] = polar(to);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const ticks = Array.from({ length: 13 }, (_, i) => startDeg + (sweep / 12) * i);
  const valueEnd = startDeg + sweep * frac;
  const arcColor = stalled ? "#E11D48" : color;

  return (
    <svg viewBox="0 0 128 112" width={size} height={(size * 112) / 128} className="block" aria-hidden="true">
      <defs>
        <filter id="nx-fan-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {ticks.map((deg, i) => {
        const [x1, y1] = polar(deg, r + 7);
        const [x2, y2] = polar(deg, r + (i % 3 === 0 ? 11 : 9));
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={deg <= valueEnd ? arcColor : "rgba(255,255,255,0.14)"}
            strokeOpacity={deg <= valueEnd ? 0.75 : 1}
            strokeWidth={i % 3 === 0 ? 1.6 : 1}
          />
        );
      })}
      <path d={arc(startDeg, startDeg + sweep)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={8} strokeLinecap="round" />
      {frac > 0.004 && (
        <path
          d={arc(startDeg, valueEnd)}
          fill="none"
          stroke={arcColor}
          strokeWidth={8}
          strokeLinecap="round"
          filter="url(#nx-fan-glow)"
          style={{ transition: "d 600ms ease" }}
        />
      )}
      <text
        x={cx}
        y={cy + 2}
        textAnchor="middle"
        className={cn("font-mono")}
        fill="#F8FAFC"
        fontSize="20"
        fontWeight={600}
        fontFamily="JetBrains Mono, ui-monospace, monospace"
      >
        {Math.round(rpm).toLocaleString()}
      </text>
      <text x={cx} y={cy + 17} textAnchor="middle" fill="#64748B" fontSize="9" letterSpacing="2" fontFamily="Inter, sans-serif">
        RPM
      </text>
      <text x={polar(startDeg, r)[0] + 2} y={108} textAnchor="middle" fill="#64748B" fontSize="8" fontFamily="JetBrains Mono, monospace">
        0
      </text>
      <text
        x={polar(startDeg + sweep, r)[0] - 2}
        y={108}
        textAnchor="middle"
        fill="#64748B"
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
      >
        {maxRpm >= 1000 ? `${(maxRpm / 1000).toFixed(1)}k` : Math.round(maxRpm)}
      </text>
    </svg>
  );
}
