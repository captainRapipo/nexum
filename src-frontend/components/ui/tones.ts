// Static class maps per accent tone. Kept as full literal class names so
// Tailwind's scanner picks them up.

export type Tone = "teal" | "gold" | "purple" | "rose" | "cyan" | "silver";

export const TONE_HEX: Record<Tone, string> = {
  teal: "#2DD4BF",
  gold: "#D4A359",
  purple: "#A855F7", // brighter than the #9333EA token so it reads on dark glass
  rose: "#E11D48",
  cyan: "#22D3EE",
  silver: "#CBD5E1",
};

export interface ToneClasses {
  text: string;
  bg: string;
  led: string;
  border: string;
  soft: string;
  glow: string;
}

export const TONE_CLASS: Record<Tone, ToneClasses> = {
  teal: { text: "text-teal", bg: "bg-teal", led: "led-teal", border: "border-teal/40", soft: "bg-teal/10", glow: "text-glow-teal" },
  gold: { text: "text-gold", bg: "bg-gold", led: "led-gold", border: "border-gold/40", soft: "bg-gold/10", glow: "text-glow-gold" },
  purple: { text: "text-purple-400", bg: "bg-purple", led: "led-purple", border: "border-purple/50", soft: "bg-purple/15", glow: "text-glow-purple" },
  rose: { text: "text-rose", bg: "bg-rose", led: "led-rose", border: "border-rose/45", soft: "bg-rose/10", glow: "text-glow-rose" },
  cyan: { text: "text-cyan", bg: "bg-cyan", led: "led-cyan", border: "border-cyan/40", soft: "bg-cyan/10", glow: "text-glow-cyan" },
  silver: { text: "text-silver", bg: "bg-silver", led: "led-silver", border: "border-silver/30", soft: "bg-silver/10", glow: "text-glow-silver" },
};

/** Load-style tone: teal under 75, gold under 90, rose at/above 90. */
export function toneForLevel(value: number, warnAt = 75, critAt = 90): Tone {
  if (value >= critAt) return "rose";
  if (value >= warnAt) return "gold";
  return "teal";
}
