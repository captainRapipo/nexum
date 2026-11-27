import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClipboardCopy, Info, Loader2, RefreshCw } from "lucide-react";
import type { UnavailableReason } from "../types";
import { fmtClock } from "../lib/format";
import { resolveUnavailable } from "../lib/status";
import { useSystemSpec } from "../hooks/useSystemSpec";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { Button } from "../components/ui/Button";
import { toast } from "../components/feedback/Toast";
import { copyText } from "../components/sensors/copyText";
import { SpecTabs, panelDomId, tabDomId } from "../components/system/SpecTabs";
import {
  BoardPanel,
  CpuPanel,
  GraphicsPanel,
  MemoryPanel,
  OsPanel,
  SectionUnavailable,
  SpdPanel,
} from "../components/system/SpecPanels";
import { buildSpecText, SPEC_TABS, type RowCtx, type SpecTabId } from "../components/system/specModel";

const TAB_STORE = "nexum.system.tab";

function loadTab(): SpecTabId {
  try {
    const v = localStorage.getItem(TAB_STORE);
    if (v && SPEC_TABS.some((t) => t.id === v)) return v as SpecTabId;
  } catch {
    /* per-viewer convenience only */
  }
  return "cpu";
}

/**
 * System (F3): CPU-Z style spec sheet, "lite" for v1.0 (CONTRACT §1.4, §2.6, §4.10).
 * F5 (handled by App) and the Refresh button re-query with refresh:true.
 */
export default function SystemView() {
  const { spec, loading, error, refresh } = useSystemSpec();
  const { info } = useSystemInfo();
  const { agent } = useTelemetry();

  const [tab, setTab] = useState<SpecTabId>(loadTab);
  const [slot, setSlot] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORE, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  // Reason for a whole agent-owned section being null.
  const sectionReason: UnavailableReason = agent ? resolveUnavailable(agent, "none") : "agentOffline";
  const ctx: RowCtx = useMemo(
    () => ({
      missing: "unsupported",
      superIo: agent ? resolveUnavailable(agent, "pawnio") : "agentOffline",
      admin: info && !info.isAdmin ? "notElevated" : "unsupported",
    }),
    [agent, info],
  );

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const copyAll = async () => {
    if (!spec) return;
    try {
      await copyText(buildSpecText(spec, sectionReason, ctx, Date.now()));
      toast("System details copied as text", "ok");
    } catch {
      toast("Could not copy to the clipboard", "warn");
    }
  };

  const openSlot = (s: string) => {
    setSlot(s);
    setTab("spd");
  };

  const busy = loading || refreshing;

  const offlineDetail =
    sectionReason === "agentOffline"
      ? "These details come from the hardware agent, which is not running."
      : "The hardware agent did not return these details.";

  let panel: ReactNode = null;
  if (spec) {
    switch (tab) {
      case "cpu":
        panel = spec.cpu ? (
          <CpuPanel cpu={spec.cpu} ctx={ctx} />
        ) : (
          <SectionUnavailable title="Processor" reason={sectionReason} detail={offlineDetail} />
        );
        break;
      case "board":
        panel = spec.board ? (
          <BoardPanel board={spec.board} ctx={ctx} />
        ) : (
          <SectionUnavailable title="Motherboard" reason={sectionReason} detail={offlineDetail} />
        );
        break;
      case "memory":
        panel = spec.memory ? (
          <MemoryPanel memory={spec.memory} ctx={ctx} onOpenSlot={openSlot} />
        ) : (
          <SectionUnavailable title="Memory" reason={sectionReason} detail={offlineDetail} />
        );
        break;
      case "spd":
        panel = spec.memory ? (
          <SpdPanel memory={spec.memory} ctx={ctx} slot={slot} onSlot={setSlot} />
        ) : (
          <SectionUnavailable title="Memory modules" reason={sectionReason} detail={offlineDetail} />
        );
        break;
      case "graphics":
        panel =
          spec.gpus.length > 0 ? (
            <GraphicsPanel gpus={spec.gpus} ctx={ctx} />
          ) : (
            <SectionUnavailable title="Graphics" reason={sectionReason} detail={offlineDetail} />
          );
        break;
      case "os":
        panel = <OsPanel os={spec.os} security={spec.security} ctx={ctx} />;
        break;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-gold/80">F3 · System details</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">System</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Processor, mainboard, memory, graphics and Windows, read once and kept until you refresh.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {spec && (
            <span className="mr-1 text-[11.5px] text-slate-500">
              Read at <span className="num text-slate-300">{fmtClock(spec.capturedTs, false)}</span>
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={14} className={busy ? "animate-spin" : undefined} aria-hidden="true" />}
            onClick={() => void doRefresh()}
            disabled={busy}
            title="Read the details again (F5)"
          >
            Refresh
          </Button>
          <Button size="sm" variant="teal" icon={ClipboardCopy} onClick={() => void copyAll()} disabled={!spec} title="Copy every tab as plain text">
            Copy as text
          </Button>
        </div>
      </div>

      <SpecTabs value={tab} onChange={setTab} />

      <div
        role="tabpanel"
        id={panelDomId(tab)}
        aria-labelledby={tabDomId(tab)}
        tabIndex={-1}
        className="min-w-0 outline-none"
      >
        {panel ??
          (spec == null && loading ? (
            <div className="flex items-center gap-2 py-16 text-[12.5px] text-muted">
              <Loader2 size={14} className="animate-spin text-teal" aria-hidden="true" />
              Reading hardware details…
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 py-12">
              <p className="text-[13px] text-slate-300">{error ? `Could not read system details: ${error}` : "No system details yet."}</p>
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void doRefresh()} loading={busy}>
                Try again
              </Button>
            </div>
          ))}
      </div>

      {spec && spec.errors.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-line bg-white/[0.02] px-3 py-2.5 text-[11.5px] text-slate-500">
          <Info size={13} className="mt-[1px] shrink-0" aria-hidden="true" />
          <div>
            <span className="text-slate-400">Some details could not be read: </span>
            {spec.errors.join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}
