import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { HardDrive } from "lucide-react";
import { EChart, StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTrashEstimate } from "../../hooks/useTrashEstimate";
import { cn, fmtBytes } from "../../lib/format";
import { HEALTH_THRESHOLDS, type Volume } from "../../types";


/** The Windows system volume: isSystem flag, else C:, else the largest fixed volume. */
export function pickSystemVolume(volumes: Volume[] | null | undefined): Volume | null {
  if (!volumes || volumes.length === 0) return null;
  const sys = volumes.find((v) => v.isSystem);
  if (sys) return sys;
  const c = volumes.find((v) => v.letter?.toUpperCase().startsWith("C"));
  if (c) return c;
  const fixed = volumes.filter((v) => v.driveType === "Fixed" && v.totalBytes > 0);
  if (fixed.length > 0) return [...fixed].sort((a, b) => b.totalBytes - a.totalBytes)[0];
  return volumes[0];
}

export function usedPctOf(v: Volume): number {
  if (!v.totalBytes || v.totalBytes <= 0) return 0;
  const used = v.usedBytes > 0 ? v.usedBytes : v.totalBytes - v.freeBytes;
  return Math.min(100, Math.max(0, (used / v.totalBytes) * 100));
}

const C = {
  used: "#2DD4BF",
  reclaimable: "#22D3EE",
  free: "rgba(148,163,184,0.16)",
};

const SPACE_RULE = `Attention below ${HEALTH_THRESHOLDS.freeSpaceWarnPct}% free, critical below ${HEALTH_THRESHOLDS.freeSpaceCritPct}% free.`;

export default function StorageGauge() {
  const { volumes } = useSystemInfo();
  const { totalBytes: trashBytes, loading: trashLoading } = useTrashEstimate();
  const vol = useMemo(() => pickSystemVolume(volumes), [volumes]);

  const model = useMemo(() => {
    if (!vol || vol.totalBytes <= 0) return null;
    const total = vol.totalBytes;
    const used = Math.min(total, Math.max(0, vol.usedBytes > 0 ? vol.usedBytes : total - vol.freeBytes));
    const free = Math.max(0, total - used);
    // Reclaimable trash lives inside "used" on this volume; clamp so the arc never exceeds the disk.
    const trash = Math.min(used, Math.max(0, trashBytes ?? 0));
    const usedNet = used - trash;
    const usedPct = (used / total) * 100;
    return { total, used, free, trash, usedNet, usedPct };
  }, [vol, trashBytes]);

  const usedColor = C.used;

  const option = useMemo<EChartsOption>(() => {
    const m = model;
    // A few GB of trash on a multi-TB disk would be an invisible sliver; give any non-zero
    // reclaimable slice a minimum arc (2.5%) so it always reads. Tooltips use the real value.
    const minTrash = m && m.trash > 0 ? Math.max(m.trash, m.total * 0.025) : 0;
    const parts = m
      ? [
          { name: "Used", value: Math.max(0, m.usedNet - (minTrash - m.trash)), real: m.usedNet, color: usedColor },
          { name: "Reclaimable", value: minTrash, real: m.trash, color: C.reclaimable },
          { name: "Free", value: m.free, real: m.free, color: C.free },
        ]
      : [{ name: "Free", value: 1, real: 0, color: C.free }];
    const sum = parts.reduce((s, p) => s + p.value, 0) || 1;

    return {
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 600,
      animationDurationUpdate: 500,
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: "rgba(7,11,14,0.94)",
        borderColor: "rgba(45,212,191,0.35)",
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: "#F8FAFC", fontSize: 12 },
        extraCssText: "border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,0.5);",
        formatter: (raw: unknown) => {
          const p = raw as { name?: string; value?: number; color?: string; data?: { real?: number } };
          if (!p || p.name === "__pad__" || typeof p.value !== "number" || !m) return "";
          const real = typeof p.data?.real === "number" ? p.data.real : p.value;
          const pct = ((real / m.total) * 100).toFixed(1);
          return (
            `<div style="display:flex;align-items:center;gap:8px">` +
            `<span style="width:8px;height:8px;border-radius:2px;background:${p.color === C.free ? "#64748B" : p.color}"></span>` +
            `<span style="color:#94A3B8;font-size:10px;letter-spacing:.14em;text-transform:uppercase">${p.name}</span>` +
            `<span style="margin-left:10px;font-family:'JetBrains Mono',ui-monospace,monospace">${fmtBytes(real)}</span>` +
            `<span style="color:#64748B;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px">${pct}%</span>` +
            `</div>`
          );
        },
      },
      series: [
        {
          type: "pie",
          // Percentages are relative to min(w,h)/2; container is wide & short so >100% yields a large half-arc.
          radius: ["150%", "182%"],
          center: ["50%", "96%"],
          startAngle: 180,
          clockwise: true,
          avoidLabelOverlap: false,
          label: { show: false },
          labelLine: { show: false },
          padAngle: 1.2,
          itemStyle: { borderRadius: 3, borderWidth: 0 },
          emphasis: { scale: true, scaleSize: 3 },
          data: [
            ...parts.map((p) => ({
              name: p.name,
              value: p.value,
              real: p.real,
              itemStyle: {
                color: p.color,
                shadowBlur: p.color === C.free ? 0 : 12,
                shadowColor: p.color === C.free ? "transparent" : p.color,
              },
            })),
            // Invisible lower half: equal to the visible sum so the arc spans exactly 180°.
            {
              name: "__pad__",
              value: sum,
              itemStyle: { color: "transparent", shadowBlur: 0 },
              emphasis: { disabled: true },
              select: { disabled: true },
              tooltip: { show: false },
              label: { show: false },
            },
          ],
        },
      ],
    } as EChartsOption;
  }, [model, usedColor]);

  const freePct = model ? 100 - model.usedPct : null;
  const crit = freePct !== null && freePct < HEALTH_THRESHOLDS.freeSpaceCritPct;
  const warn = freePct !== null && freePct < HEALTH_THRESHOLDS.freeSpaceWarnPct;

  return (
    <GlassCard
      title="Storage"
      icon={<HardDrive size={14} />}
      accent="teal"
      actions={
        vol ? (
          <StatusPill tone={crit ? "crit" : warn ? "warn" : "ok"} title={`${vol.letter || "System volume"}: ${SPACE_RULE}`}>
            {vol.letter || "SYS"}
          </StatusPill>
        ) : null
      }
    >
      <div className="relative mx-auto h-[124px] w-full max-w-[260px]">
        <EChart option={option} className="absolute inset-0" style={{ width: "100%", height: "100%" }} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
          <div className="flex items-baseline gap-0.5">
            <span
              className={cn("font-mono text-[30px] font-semibold leading-none tabular-nums", "text-ink")}
            >
              {model ? model.usedPct.toFixed(0) : "—"}
            </span>
            <span className="font-mono text-sm text-muted">%</span>
          </div>
          <span className="mt-1 whitespace-nowrap text-[9.5px] uppercase tracking-[0.24em] text-muted">
            {model ? `Used of ${fmtBytes(model.total)}` : "Used"}
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
        <Legend color={usedColor} label="Used" value={model ? fmtBytes(model.usedNet) : "—"} />
        <Legend
          color={C.reclaimable}
          label="Caches"
          title="Reclaimable caches (measured by the cleaner)"
          value={trashBytes === null ? (trashLoading ? "Scanning" : "—") : fmtBytes(model ? model.trash : trashBytes)}
          dim={trashBytes === null}
        />
        <Legend color="#64748B" label="Free" value={model ? fmtBytes(model.free) : "—"} />
      </div>
    </GlassCard>
  );
}

function Legend({
  color,
  label,
  value,
  dim = false,
  title,
}: {
  color: string;
  label: string;
  value: string;
  dim?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        <span className="truncate text-[9.5px] uppercase tracking-[0.2em] text-muted">{label}</span>
      </div>
      <div className={cn("mt-0.5 truncate font-mono text-[12px] tabular-nums", dim ? "text-muted" : "text-ink")}>
        {value}
      </div>
    </div>
  );
}
