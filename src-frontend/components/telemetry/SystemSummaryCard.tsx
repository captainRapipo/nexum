import { ArrowUpRight, CircuitBoard } from "lucide-react";
import { DottedLeaderRow } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useNow } from "../../hooks/useNow";
import { requestNavigate } from "../../lib/nav";
import { fmtBoardName, fmtUptime, shortCpuName } from "../../lib/format";

/**
 * Three-line System summary (Dashboard, ROADMAP §3 "Dashboard slim-down"): board, CPU and uptime.
 * Uptime is derived from `bootTs` and shown only here on the Dashboard. Everything else is in the System view.
 */
export default function SystemSummaryCard() {
  const { info } = useSystemInfo();
  const now = useNow();

  const board = info ? fmtBoardName(info.motherboard?.manufacturer, info.motherboard?.product) : "—";
  const cpu = info?.cpuName ? shortCpuName(info.cpuName) || info.cpuName : "—";
  const bootTs = info?.bootTs;
  const uptime =
    typeof bootTs === "number" && Number.isFinite(bootTs) && bootTs > 0 ? fmtUptime(Math.max(0, (now - bootTs) / 1000)) : "—";

  return (
    <GlassCard
      title="System"
      icon={<CircuitBoard size={14} />}
      accent="silver"
      actions={
        <button
          type="button"
          onClick={() => requestNavigate("system")}
          className="group flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
          title="Open System (F3)"
          aria-label="Open the System view"
        >
          System
          <ArrowUpRight size={12} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
        <DottedLeaderRow label="Board" value={board} valueClassName="font-mono text-ink truncate" />
        <DottedLeaderRow label="CPU" value={cpu} valueClassName="font-mono text-ink truncate" />
        <DottedLeaderRow label="Uptime" value={uptime} valueClassName="font-mono text-ink tabular-nums" />
      </div>
    </GlassCard>
  );
}
