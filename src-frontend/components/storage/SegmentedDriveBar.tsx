import { useMemo } from "react";
import { Database } from "lucide-react";
import { SegmentedBar, StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { cn, fmtBytes } from "../../lib/format";
import { DISK_CRIT_PCT, DISK_WARN_PCT, pickSystemVolume, usedPctOf } from "./StorageGauge";

function navigate(view: string) {
  window.dispatchEvent(new CustomEvent("nexum:navigate", { detail: view }));
}

export default function SegmentedDriveBar() {
  const { volumes, disks } = useSystemInfo();
  const vol = useMemo(() => pickSystemVolume(volumes), [volumes]);

  const pct = vol ? usedPctOf(vol) : null;
  const crit = pct !== null && pct >= DISK_CRIT_PCT;
  const warn = pct !== null && pct >= DISK_WARN_PCT;
  const tone = crit ? "rose" : warn ? "gold" : "teal";

  // Media hint only when unambiguous (single physical disk) — volume→disk mapping isn't in the contract.
  const mediaHint = useMemo(() => {
    if (!disks || disks.length !== 1) return null;
    const pick = disks[0];
    return [pick.busType, pick.mediaType !== "Unspecified" ? pick.mediaType : null].filter(Boolean).join(" ");
  }, [disks]);

  const otherFixed = useMemo(
    () => (volumes ?? []).filter((v) => v !== vol && v.driveType === "Fixed" && v.totalBytes > 0).length,
    [volumes, vol],
  );

  return (
    <GlassCard
      title="Primary Drive"
      icon={<Database size={14} />}
      accent={tone}
      actions={
        <button
          type="button"
          onClick={() => navigate("storage")}
          className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-teal"
          title="Open Storage (F3)"
        >
          {otherFixed > 0 ? `+${otherFixed} volume${otherFixed > 1 ? "s" : ""}` : "Details"}
        </button>
      }
    >
      {!vol ? (
        <div className="py-2 text-[11px] text-muted">Reading volumes…</div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn("font-mono text-2xl font-semibold leading-none tabular-nums", crit ? "text-rose" : "text-ink")}
                style={crit ? { textShadow: "0 0 16px rgba(225,29,72,0.45)" } : undefined}
              >
                {pct !== null ? pct.toFixed(0) : "—"}%
              </span>
              <span className="truncate text-[11px] uppercase tracking-[0.16em] text-muted">
                Used <span className="text-muted/60">—</span>{" "}
                <span className={cn("font-mono normal-case tracking-normal", crit ? "text-rose" : "text-silver")}>
                  {fmtBytes(vol.freeBytes)}
                </span>{" "}
                Free
              </span>
            </div>
            {crit && (
              <StatusPill tone="crit" pulse>
                Low space
              </StatusPill>
            )}
          </div>

          <div className="mt-3">
            <SegmentedBar value={pct ?? 0} segments={28} tone={tone} />
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2 font-mono text-[10.5px] text-muted">
            <span className="truncate">
              {vol.letter}
              {vol.label ? ` ${vol.label}` : ""}
              {vol.fileSystem ? ` · ${vol.fileSystem}` : ""}
              {mediaHint ? ` · ${mediaHint}` : ""}
            </span>
            <span className="shrink-0 tabular-nums">
              {fmtBytes(vol.usedBytes > 0 ? vol.usedBytes : vol.totalBytes - vol.freeBytes)} / {fmtBytes(vol.totalBytes)}
            </span>
          </div>
        </>
      )}
    </GlassCard>
  );
}
