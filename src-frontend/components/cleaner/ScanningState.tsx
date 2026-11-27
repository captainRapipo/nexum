import { useEffect, useState } from "react";
import { ScanSearch } from "lucide-react";
import LedProgress from "./LedProgress";

const STAGES = [
  "Temporary files",
  "Windows Update cache",
  "Error reports and old logs",
  "Old crash dumps",
  "Shader caches",
  "Recycle Bin",
  "Browser and Discord caches",
];

const CSS = `
@keyframes nx-radar { to { transform: rotate(360deg); } }
@keyframes nx-ping { 0% { transform: scale(.6); opacity: .7 } 100% { transform: scale(1.6); opacity: 0 } }
.nx-radar { animation: nx-radar 1.8s linear infinite; }
.nx-ping { animation: nx-ping 1.8s ease-out infinite; }
@media (prefers-reduced-motion: reduce) { .nx-radar, .nx-ping { animation: none; } }
`;

/** Dry-run scan animation: radar sweep + cycling stage label + indeterminate LED bar. */
export default function ScanningState({ title = "Measuring reclaimable caches…" }: { title?: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setStage((s) => (s + 1) % STAGES.length), 650);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col items-center gap-5 py-8">
      <style>{CSS}</style>
      <div className="relative h-28 w-28">
        <span className="nx-ping absolute inset-0 rounded-full border border-teal/40" />
        <span className="absolute inset-0 rounded-full border border-line bg-[radial-gradient(circle,rgba(45,212,191,0.10),transparent_70%)]" />
        <span className="absolute inset-4 rounded-full border border-white/[0.06]" />
        <span className="absolute inset-8 rounded-full border border-white/[0.06]" />
        <span
          className="nx-radar absolute inset-0 rounded-full"
          style={{ background: "conic-gradient(from 0deg, rgba(45,212,191,0.5), rgba(45,212,191,0) 70deg, transparent 360deg)" }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-teal">
          <ScanSearch size={26} />
        </span>
      </div>
      <div className="text-center">
        <div className="text-[15px] font-semibold text-ink">{title}</div>
        <div className="mt-1 h-4 font-mono text-[11.5px] text-muted">Scanning · {STAGES[stage]}</div>
      </div>
      <div className="w-full max-w-sm">
        <LedProgress tone="teal" segments={32} height={6} />
      </div>
      <div className="text-[11px] text-muted">Measuring only. Nothing is deleted until you choose Clean.</div>
    </div>
  );
}
