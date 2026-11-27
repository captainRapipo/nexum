import { useId } from "react";
import { cn } from "../../lib/format";

export interface NexumEmblemProps {
  size?: number;
  className?: string;
  /** Add a soft teal bloom behind the mark. Default true. */
  glow?: boolean;
  title?: string;
}

/**
 * NEXUM mark: hexagonal frame enclosing an "N" drawn as a linked circuit trace,
 * with gold nodes at its two terminals (the "connection").
 */
export function NexumEmblem({ size = 28, className, glow = true, title = "Nexum" }: NexumEmblemProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ring = `nx-ring-${uid}`;
  const fill = `nx-fill-${uid}`;
  const bloom = `nx-bloom-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <defs>
        <linearGradient id={ring} x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5EEAD4" />
          <stop offset="0.55" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#0F766E" />
        </linearGradient>
        <radialGradient id={fill} cx="32" cy="26" r="34" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2DD4BF" stopOpacity="0.16" />
          <stop offset="1" stopColor="#2DD4BF" stopOpacity="0.02" />
        </radialGradient>
        <filter id={bloom} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>

      {glow && (
        <g filter={`url(#${bloom})`} opacity="0.55">
          <polygon points="32,3.5 56.7,17.75 56.7,46.25 32,60.5 7.3,46.25 7.3,17.75" fill="none" stroke="#2DD4BF" strokeWidth="2.4" />
          <path d="M22 43V21l20 22V21" fill="none" stroke="#2DD4BF" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}

      {/* outer frame */}
      <polygon
        points="32,3.5 56.7,17.75 56.7,46.25 32,60.5 7.3,46.25 7.3,17.75"
        fill={`url(#${fill})`}
        stroke={`url(#${ring})`}
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* inner gold trace ring */}
      <polygon
        points="32,11 50.19,21.5 50.19,42.5 32,53 13.81,42.5 13.81,21.5"
        fill="none"
        stroke="#D4A359"
        strokeOpacity="0.4"
        strokeWidth="0.9"
        strokeDasharray="3 2.2"
      />
      {/* N trace */}
      <path d="M22 43V21l20 22V21" fill="none" stroke="#2DD4BF" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      {/* nodes */}
      <circle cx="22" cy="43" r="2.6" fill="#2DD4BF" stroke="#070B0E" strokeWidth="1.3" />
      <circle cx="42" cy="21" r="2.6" fill="#2DD4BF" stroke="#070B0E" strokeWidth="1.3" />
      <circle cx="22" cy="21" r="3.3" fill="#D4A359" stroke="#070B0E" strokeWidth="1.3" />
      <circle cx="42" cy="43" r="3.3" fill="#D4A359" stroke="#070B0E" strokeWidth="1.3" />
    </svg>
  );
}

export default NexumEmblem;
