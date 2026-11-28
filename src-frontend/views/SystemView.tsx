import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, Info, Loader2, RefreshCw } from "lucide-react";
import type { UnavailableReason } from "../types";
import { fmtClock } from "../lib/format";
import { resolveUnavailable } from "../lib/status";
import { useSystemSpec } from "../hooks/useSystemSpec";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useSettings } from "../hooks/useSettings";
import { useTelemetry } from "../hooks/useTelemetryStream";
import GlassCard from "../components/layout/GlassCard";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import { Button } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import { copyText } from "../components/system/clipboard";
import { SpecTabs, panelDomId } from "../components/system/SpecTabs";
import { SaveReportMenu } from "../components/system/SaveReportMenu";
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

const DESCRIPTION = "Processor, mainboard, memory, graphics and Windows. Read once and kept until you refresh.";

/** Toolbar subtitle: the selected tab's name (CONTRACT §4.6.1). */
const TAB_NAME: Record<SpecTabId, string> = {
  cpu: "Processor",
  board: "Mainboard",
  memory: "Memory",
  spd: "Memory modules (SPD)",
  graphics: "Graphics",
  os: "Windows and security",
};

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
 * System (F3): the spec sheet (CONTRACT §1.4, §1.4.1, §2.6, §4.10, §4.10.2, §4.10.3): one hero card
 * per tab, then key-value rows and dense tables; memory timings with their source, SPD JEDEC timings,
 * FCLK / UCLK / MEMCLK, PCIe links, "Copy as text" and "Save report". F5 (handled by App) re-reads
 * the details.
 */
export default function SystemView() {
  const { spec, loading, error, refresh } = useSystemSpec();
  const { info, disks } = useSystemInfo();
  const { agent } = useTelemetry();
  const { settings } = useSettings();
  const tempUnit = settings?.tempUnit ?? "C";

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

  usePageChrome({ subtitle: TAB_NAME[tab] });

  // Reason for a whole section being null.
  const sectionReason: UnavailableReason = agent ? resolveUnavailable(agent, "none") : "agentOffline";
  const ctx: RowCtx = useMemo(
    () => ({
      missing: "unsupported",
      superIo: agent ? resolveUnavailable(agent, "pawnio") : "agentOffline",
      admin: info && !info.isAdmin ? "notElevated" : "unsupported",
      tempUnit,
    }),
    [agent, info, tempUnit],
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
      await copyText(buildSpecText(spec, sectionReason, ctx, Date.now(), disks));
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

  const missingDetail =
    sectionReason === "agentOffline" ? "These details are not available right now." : "This PC did not report these details.";

  let panel: ReactNode = null;
  if (spec) {
    switch (tab) {
      case "cpu":
        panel = spec.cpu ? <CpuPanel cpu={spec.cpu} ctx={ctx} /> : <SectionUnavailable title="Processor" reason={sectionReason} detail={missingDetail} />;
        break;
      case "board":
        panel = spec.board ? (
          <BoardPanel board={spec.board} ctx={ctx} />
        ) : (
          <SectionUnavailable title="Motherboard" reason={sectionReason} detail={missingDetail} />
        );
        break;
      case "memory":
        panel = spec.memory ? (
          <MemoryPanel memory={spec.memory} ctx={ctx} onOpenSlot={openSlot} />
        ) : (
          <SectionUnavailable title="Memory" reason={sectionReason} detail={missingDetail} />
        );
        break;
      case "spd":
        panel = spec.memory ? (
          <SpdPanel memory={spec.memory} ctx={ctx} slot={slot} onSlot={setSlot} />
        ) : (
          <SectionUnavailable title="Memory modules" reason={sectionReason} detail={missingDetail} />
        );
        break;
      case "graphics":
        panel =
          spec.gpus.length > 0 ? (
            <GraphicsPanel gpus={spec.gpus} ctx={ctx} />
          ) : (
            <SectionUnavailable title="Graphics" reason={sectionReason} detail={missingDetail} />
          );
        break;
      case "os":
        panel = <OsPanel os={spec.os} security={spec.security} ctx={ctx} diskLinks={spec.diskLinks ?? []} disks={disks} />;
        break;
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <PageHeader view="system" description={DESCRIPTION} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SpecTabs value={tab} onChange={setTab} />
        <div className="flex items-center gap-2">
          {spec && (
            <span className="tnum mr-1 whitespace-nowrap text-callout text-ink-3" title="Press F5 to read the details again.">
              Read at {fmtClock(spec.capturedTs, false)}
            </span>
          )}
          <SaveReportMenu disabled={!spec} />
          <Button icon={Copy} onClick={() => void copyAll()} disabled={!spec} title="Copy every tab as plain text">
            Copy as text
          </Button>
        </div>
      </div>

      <div role="region" id={panelDomId(tab)} aria-label={TAB_NAME[tab]} className="min-w-0">
        {panel ??
          (spec == null && loading ? (
            <GlassCard>
              <div className="flex items-center gap-2 py-10 text-body text-ink-2">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Reading hardware details…
              </div>
            </GlassCard>
          ) : (
            <GlassCard>
              <div className="flex flex-col items-start gap-3 py-6">
                <p className="text-body text-ink">{error ? `Could not read system details: ${error}` : "No system details yet."}</p>
                <Button size="sm" icon={RefreshCw} onClick={() => void doRefresh()} loading={busy}>
                  Try again
                </Button>
              </div>
            </GlassCard>
          ))}
      </div>

      {spec && spec.errors.length > 0 && (
        <p className="mt-4 flex items-start gap-2 text-callout text-ink-2">
          <Info size={14} className="mt-px shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            <span className="font-medium text-ink">Some details could not be read: </span>
            {spec.errors.join(" · ")}
          </span>
        </p>
      )}
    </div>
  );
}
