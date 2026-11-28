import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { DEFAULT_SETTINGS, type TrashCategory } from "../types";
import { api } from "../lib/api";
import { onRescanRequest } from "../lib/nav";
import { useSettings } from "../hooks/useSettings";
import { useTightMode } from "../hooks/useTightMode";
import { fmtBytes, fmtClock } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import { Button, InkLink, Modal, StatusIcon } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import CategoryList from "../components/cleaner/CategoryList";
import CleanupSummary from "../components/cleaner/CleanupSummary";
import PurgeProgressPanel from "../components/cleaner/PurgeProgressPanel";
import ScanningState from "../components/cleaner/ScanningState";
import SelectionWell from "../components/cleaner/SelectionWell";
import { useCategorySelection, useTrashScan } from "../components/cleaner/useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "../components/cleaner/purgeEngine";
import {
  CLEANUP_RULES,
  CONFIRM_BODY,
  CONFIRM_REASSURANCE,
  PAGE_DESCRIPTION,
  PROTECTED_PATHS,
  READY_NOTE_CONFIRM,
  READY_NOTE_DIRECT,
  dirnameOf,
  fmtFiles,
  fmtIn,
  headline,
  listUnit,
  splitAmount,
} from "../components/cleaner/cleanerCopy";

/** Shown while the backend omits the browser category (it is only listed when includeBrowser is on). */
const BROWSER_PLACEHOLDER: TrashCategory = {
  id: "browser",
  label: "Browser and Discord caches",
  description:
    "Chrome, Edge, Firefox and Discord cache folders. Logins, cookies, history and saved site data are never touched. Turn on to include it in the measurement.",
  bytes: 0,
  files: 0,
  enabled: false,
  optional: true,
  requiresAdmin: false,
  available: true,
  unavailableReason: null,
  note: null,
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

/**
 * Clean caches (F9 row of the sidebar; CONTRACT §3, §4.10, §4.10.3): the measured categories on the
 * left, the total with the one button and this session's history on the right. The page button is
 * secondary and opens the confirmation; that dialog owns the only primary button.
 */
export default function CleanerView() {
  const { settings: rawSettings, update } = useSettings();
  const settings = rawSettings ?? DEFAULT_SETTINGS;

  const engine = usePurgeEngine();
  const scanner = useTrashScan();
  const { rescan } = scanner;
  const includeBrowser = settings.includeBrowserCaches;
  // Recycle Bin age filter (CONTRACT §3.2): passed explicitly to every scan, and the cleanup reuses the value
  // the shown estimate was measured with (scanner.scannedRecycleAge).
  const recycleAge = settings.recycleMinAgeDays;
  const recycleAgeRef = useRef(recycleAge);
  recycleAgeRef.current = recycleAge;
  const [savingAge, setSavingAge] = useState(false);
  const forced = useMemo(() => ({ browser: includeBrowser }), [includeBrowser]);
  const selection = useCategorySelection(scanner.scan, forced);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  /** Run id whose summary is pinned on this page until dismissed. */
  const [summaryRun, setSummaryRun] = useState<number | null>(null);
  /** When the shown estimate was measured (the scan itself carries no timestamp). */
  const [measuredAt, setMeasuredAt] = useState<number | null>(null);
  useEffect(() => {
    if (scanner.scanStamp > 0) setMeasuredAt(Date.now());
  }, [scanner.scanStamp]);

  useEffect(() => attachPurgeViewer(), []);

  // Any cleanup running while this page is visible (e.g. from the Clean caches dialog) gets its summary here too.
  useEffect(() => {
    if (engine.running) setSummaryRun(engine.runId);
  }, [engine.running, engine.runId]);

  // Measure on mount and whenever the browser-cache setting or the Recycle Bin age filter changes
  // (here, in Settings, or when the saved settings finish loading).
  useEffect(() => {
    if (!getPurgeState().running) void rescan(includeBrowser, recycleAge);
  }, [includeBrowser, recycleAge, rescan]);

  // F5 while on this page re-measures (CONTRACT §4.6), unless a cleanup is running.
  useEffect(
    () =>
      onRescanRequest("cleaner", () => {
        if (!getPurgeState().running) void rescan(includeBrowser, recycleAgeRef.current);
      }),
    [includeBrowser, rescan],
  );

  // Re-measure after any cleanup so the numbers reflect reality.
  const lastSeenRun = useRef<number | null>(engine.lastRunId);
  useEffect(() => {
    if (engine.lastRunId !== null && engine.lastRunId !== lastSeenRun.current && !engine.running) {
      lastSeenRun.current = engine.lastRunId;
      void rescan(includeBrowser, recycleAgeRef.current);
    }
  }, [engine.lastRunId, engine.running, includeBrowser, rescan]);

  const categories = useMemo(() => {
    const list = scanner.scan?.categories ?? [];
    if (list.some((c) => c.id === "browser")) return list;
    // Keep the browser row visible (as a switch bound to the setting) even when the backend omitted it.
    return [...list, BROWSER_PLACEHOLDER];
  }, [scanner.scan]);

  const onToggle = useCallback(
    (id: TrashCategory["id"], on: boolean) => {
      if (id === "browser") {
        Promise.resolve(update({ includeBrowserCaches: on })).catch((e: unknown) =>
          toast(`Could not save setting: ${errMsg(e)}`, "crit"),
        );
        return;
      }
      selection.toggle(id, on);
    },
    [selection, update],
  );

  // The optimistic settings update re-measures through the effect above with the new value.
  const onRecycleAge = useCallback(
    (days: number | null) => {
      if (days === recycleAgeRef.current) return;
      setSavingAge(true);
      update({ recycleMinAgeDays: days })
        .catch((e: unknown) => toast(`Could not save setting: ${errMsg(e)}`, "crit"))
        .finally(() => setSavingAge(false));
    },
    [update],
  );

  const openReliability = useCallback(() => {
    api.openReliabilityMonitor().catch((e: unknown) => toast(`Could not open Reliability Monitor: ${errMsg(e)}`, "crit"));
  }, []);

  const selectedCats = selection.selectedCategories;
  const nothingSelected = selectedCats.length === 0;
  const head = headline(selection.selectedBytes, scanner.scan);

  const runClean = useCallback(() => {
    setConfirmOpen(false);
    // Already running (e.g. a double-click on the confirm button): the progress panel is showing it.
    if (getPurgeState().running) return;
    const runId = getPurgeState().runId + 1;
    setSummaryRun(runId);
    startPurge(selectedCats, "Clean caches page", scanner.scannedRecycleAge).catch((e: unknown) => {
      // A run that started reports its own failure; only errors raised before the run began need surfacing.
      if (getPurgeState().lastRunId !== runId && !getPurgeState().running) toast(`Cleanup failed: ${errMsg(e)}`, "crit");
    });
  }, [selectedCats, scanner.scannedRecycleAge]);

  const onCleanClick = () => {
    if (nothingSelected || engine.running) return;
    if (settings.confirmBeforePurge) setConfirmOpen(true);
    else runClean();
  };

  const sessionFreed = engine.history.reduce((a, h) => a + h.result.freedBytes, 0);
  const showSummary =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult !== null;
  const runFailed =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult === null && engine.error;

  const scanning = scanner.phase === "scanning" || (scanner.phase === "idle" && !scanner.scan);
  const unit = listUnit(categories);
  const idle = !engine.running && !showSummary;
  const [readyAmount, readyUnit] = splitAmount(head.now);
  const availableCount = categories.filter((c) => c.available !== false).length;
  const measuredClock = measuredAt != null ? fmtClock(measuredAt, false) : null;
  const lastLog = engine.history.find((h) => h.result.logPath)?.result.logPath ?? null;

  usePageChrome({
    subtitle: engine.running
      ? "Cleaning…"
      : scanner.scan && measuredClock
        ? `${head.now} ready · measured ${measuredClock}`
        : "Measuring…",
  });

  const openLogFolder = () => {
    if (!lastLog) return;
    api.openExternal(dirnameOf(lastLog)).catch((e: unknown) => toast(`Could not open the log folder: ${errMsg(e)}`, "crit"));
  };

  const remeasure = () => void rescan(includeBrowser, recycleAgeRef.current);
  // Regular mode: right of the large title. Tight mode: in the Categories card header (SPEC, "Page actions").
  const tight = useTightMode();
  const measureButton = (
    <Button
      size={tight ? "sm" : "md"}
      icon={<RefreshCw size={tight ? 13 : 15} className={scanner.phase === "scanning" ? "animate-spin" : undefined} aria-hidden="true" />}
      onClick={remeasure}
      disabled={scanner.phase === "scanning" || engine.running}
      title="Measure again (F5)"
    >
      Measure again
    </Button>
  );
  const hasHistory = engine.history.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader view="cleaner" description={PAGE_DESCRIPTION} actions={measureButton} tightActions="none" />

      {/* Every card ends at its content: a short state (cleaning, the result, an empty history) is a short
          card on the canvas, never a tall blank panel. */}
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-(--grid-gap) tight:grid-cols-[minmax(0,1fr)_340px]">
        <GlassCard
          padded={false}
          bodyClassName="flex flex-col"
          title={engine.running ? "Cleaning…" : showSummary ? "Cleanup finished" : "Categories"}
          actions={
            idle && (scanner.scan || tight) ? (
              <span className="flex items-center gap-3.5">
                {scanner.scan && (
                  <>
                    <InkLink chevron={false} onClick={selection.resetOverrides} title="Back to the categories that are on by default">
                      Select defaults
                    </InkLink>
                    <InkLink chevron={false} onClick={() => selection.setAll(true)}>
                      All
                    </InkLink>
                    <InkLink chevron={false} onClick={() => selection.setAll(false)}>
                      None
                    </InkLink>
                  </>
                )}
                {tight && measureButton}
              </span>
            ) : undefined
          }
        >
          {engine.running ? (
            <PurgeProgressPanel engine={engine} />
          ) : showSummary && engine.lastResult ? (
            <CleanupSummary result={engine.lastResult} onDone={() => setSummaryRun(null)} />
          ) : (
            <>
              {runFailed && (
                <div role="alert" className="mx-(--card-pad-x) mb-3 flex items-center gap-2.5 rounded-lg border border-crit-border bg-crit-bg px-3.5 py-2.5 text-body">
                  <StatusIcon tone="crit" size={18} />
                  <span className="min-w-0 flex-1">
                    <b className="font-semibold text-ink">Cleanup failed.</b> <span className="text-ink-2">{engine.error}</span>
                  </span>
                </div>
              )}
              {scanner.phase === "error" && (
                <div role="alert" className="mx-(--card-pad-x) mb-3 flex items-center gap-2.5 rounded-lg border border-crit-border bg-crit-bg px-3.5 py-2.5 text-body">
                  <StatusIcon tone="crit" size={18} />
                  <span className="min-w-0 flex-1">
                    <b className="font-semibold text-ink">Measuring failed.</b> <span className="text-ink-2">{scanner.error}</span>
                  </span>
                  <Button size="sm" onClick={remeasure}>
                    Try again
                  </Button>
                </div>
              )}

              {scanning && !scanner.scan ? (
                <ScanningState />
              ) : (
                <CategoryList
                  className={scanner.phase === "scanning" ? "pointer-events-none opacity-60 transition-opacity" : undefined}
                  categories={categories}
                  unit={unit}
                  selected={selection.selected}
                  onToggle={onToggle}
                  disabled={scanner.phase === "scanning"}
                  onOpenReliabilityMonitor={openReliability}
                  extraNotes={{ browser: "Same switch as Settings › Include browser caches" }}
                  recycleAge={{
                    value: recycleAge,
                    onChange: onRecycleAge,
                    disabled: savingAge || scanner.phase === "scanning" || engine.running,
                  }}
                  details={{
                    recycleMinAgeDays: scanner.scannedRecycleAge === undefined ? recycleAge : scanner.scannedRecycleAge,
                    scanStamp: scanner.scanStamp,
                  }}
                />
              )}
            </>
          )}
        </GlassCard>

        <div className="flex min-w-0 flex-col gap-(--grid-gap)">
          <GlassCard>
            <div className="text-[12.5px] font-medium leading-[17px] text-ink-2">Ready to clean</div>
            <div className="tnum mt-1 text-[52px] font-semibold leading-[56px] tracking-[-0.035em] text-ink">
              {scanner.scan ? (
                <>
                  {readyAmount}
                  <small className="ml-[5px] text-[20px] font-medium leading-none tracking-normal text-ink-2">{readyUnit}</small>
                </>
              ) : (
                <span className="text-ink-3" title="Measuring…" aria-label="Measuring">
                  —
                </span>
              )}
            </div>
            <div className="tnum mt-0.5 text-callout text-ink-2">
              {scanner.scan
                ? `${selectedCats.length} of ${availableCount} categories · ${fmtFiles(selection.selectedFiles)}${measuredClock ? ` · measured ${measuredClock}` : ""}`
                : "Measuring…"}
            </div>
            {head.more && (
              <div className="tnum mt-0.5 text-callout text-ink-3" title="Sum of the categories that need administrator rights">
                {head.more} more as administrator
              </div>
            )}

            <ul className="tnum my-3.5 border-t border-divider">
              {selectedCats.map((c) => (
                <li key={c.id} className="flex h-[30px] items-center justify-between gap-3 border-b border-divider">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <span className="shrink-0 font-medium">{fmtIn(c.bytes, head.unit)}</span>
                </li>
              ))}
              {selectedCats.length === 0 && (
                <li className="flex h-[30px] items-center border-b border-divider text-ink-2">
                  {scanner.scan ? "Nothing is selected." : "Measuring reclaimable caches…"}
                </li>
              )}
            </ul>

            {/* Secondary on purpose: it opens the confirmation, and that dialog owns the only primary (CONTRACT §4.9 rule 1). */}
            <Button
              size="lg"
              className="w-full justify-center"
              icon={Sparkles}
              onClick={onCleanClick}
              disabled={nothingSelected || engine.running || !scanner.scan}
            >
              {`Clean ${head.now}${settings.confirmBeforePurge ? "…" : ""}`}
            </Button>
            <p className="mt-3 flex gap-2 text-callout text-ink-2">
              <ShieldCheck size={14} className="mt-px shrink-0 text-ok-icon" aria-hidden="true" />
              <span>
                {settings.confirmBeforePurge ? READY_NOTE_CONFIRM : READY_NOTE_DIRECT}{" "}
                <InkLink onClick={() => setRulesOpen(true)} className="align-baseline">
                  What is never touched
                </InkLink>
              </span>
            </p>
          </GlassCard>

          <GlassCard
            bodyClassName="flex flex-col"
            title="History"
            actions={
              lastLog ? (
                <InkLink chevron={false} onClick={openLogFolder} title={dirnameOf(lastLog)}>
                  Open log folder
                </InkLink>
              ) : undefined
            }
            footer={
              hasHistory ? (
                <>
                  <span>Freed this session</span>
                  <b className="tnum font-semibold text-ink">{fmtBytes(sessionFreed, 2)}</b>
                </>
              ) : undefined
            }
          >
            {!hasHistory ? (
              <p className="border-t border-divider pt-3 text-callout text-ink-2">No cleanups yet this session.</p>
            ) : (
              <ul className="tnum max-h-[300px] min-h-0 flex-1 overflow-y-auto">
                {engine.history.map((h) => (
                  <li key={h.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t border-divider py-[9px]">
                    <b className="font-medium">
                      {fmtClock(h.at)} <span className="font-normal text-ink-3">· {h.source}</span>
                    </b>
                    <em className="text-right font-semibold not-italic">{fmtBytes(h.result.freedBytes, 2)}</em>
                    <span className="truncate text-callout text-ink-2" title={h.categories.join(", ")}>
                      {h.categories.join(", ")}
                    </span>
                    <span
                      className="text-right text-callout text-ink-3"
                      title={`${h.result.filesSkipped.toLocaleString("en-US")} skipped · took ${fmtDuration(h.result.durationMs)}`}
                    >
                      {fmtFiles(h.result.filesDeleted)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>
      </div>

      {/* Confirmation (SPEC §18): the app icon, the summary well and the only primary button of the screen. */}
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        variant="alert"
        title={`Clean ${head.now} of cache files?`}
        subtitle={CONFIRM_BODY}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)} data-autofocus>
              Cancel
            </Button>
            <Button variant="primary" onClick={runClean}>
              {`Clean ${head.now}`}
            </Button>
          </>
        }
      >
        <SelectionWell categories={selectedCats} unit={head.unit} totalFiles={selection.selectedFiles} totalBytes={selection.selectedBytes} />
        <p className="mt-3 flex gap-2 text-callout text-ink-2">
          <ShieldCheck size={14} className="mt-px shrink-0 text-ok-icon" aria-hidden="true" />
          {CONFIRM_REASSURANCE}
        </p>
      </Modal>

      {/* The rules of CONTRACT §3, one click away from the button they protect. */}
      <Modal
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        title="What is never touched"
        subtitle="The same rules apply to measuring and to cleaning"
        icon={ShieldCheck}
        width={560}
        footer={<Button onClick={() => setRulesOpen(false)}>Close</Button>}
      >
        <p className="text-body text-ink-2">
          Nexum deletes only inside the listed cache folders and handles every file individually. These locations are never touched:
        </p>
        <ul className="mt-2.5 rounded-lg bg-inset px-3 py-1">
          {PROTECTED_PATHS.map((p) => (
            <li key={p} className="flex items-start gap-2 border-b border-divider py-1.5 last:border-b-0">
              <Lock size={12} className="mt-0.5 shrink-0 text-ink-3" aria-hidden="true" />
              <span className="font-mono text-[11.5px] leading-4 text-ink">{p}</span>
            </li>
          ))}
        </ul>
        <ul className="mt-3 flex flex-col gap-1">
          {CLEANUP_RULES.map((r) => (
            <li key={r} className="text-callout text-ink-2">
              {r}
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
