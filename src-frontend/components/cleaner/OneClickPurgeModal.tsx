import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { DEFAULT_ON_CATEGORIES, DEFAULT_SETTINGS } from "../../types";
import { api } from "../../lib/api";
import { useSettings } from "../../hooks/useSettings";
import { Button, InkLink, Modal } from "../ui";
import { toast } from "../feedback/Toast";
import ScanningState from "./ScanningState";
import SelectionWell from "./SelectionWell";
import PurgeProgressPanel from "./PurgeProgressPanel";
import CleanupSummary, { summaryDetail, summaryHeadline } from "./CleanupSummary";
import { availableCategories, useCategorySelection, useTrashScan } from "./useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "./purgeEngine";
import { CONFIRM_BODY, CONFIRM_REASSURANCE, headline, listUnit } from "./cleanerCopy";

export interface OneClickPurgeModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Quick path (F9 with confirmBeforePurge off): clean exactly the DEFAULT_ON_CATEGORIES that are
   * available, as soon as the measurement finishes. Never Recycle Bin, browser, dumps or shader caches.
   */
  autoStart?: boolean;
}

/**
 * "Clean caches" (F9 / tray): measure → the "Reclaimable caches" headline with per-category
 * switches → live progress via `purge-progress` → CleanupSummary with the audit log link.
 * An alert-style dialog (SPEC §18): its `Clean <size>` is the primary, `Cancel` has the first focus.
 */
export default function OneClickPurgeModal({ open, onClose, autoStart = false }: OneClickPurgeModalProps) {
  const { settings: rawSettings } = useSettings();
  const settings = rawSettings ?? DEFAULT_SETTINGS;

  const engine = usePurgeEngine();
  const scanner = useTrashScan();
  const selection = useCategorySelection(scanner.scan);
  /** The engine run this modal instance started (or adopted on open). */
  const [myRun, setMyRun] = useState<number | null>(null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoStartRef = useRef(autoStart);
  autoStartRef.current = autoStart;
  const { rescan, reset } = scanner;
  const { resetOverrides } = selection;

  // Count as a visible progress surface while open (suppresses the background-completion toast).
  useEffect(() => {
    if (!open) return;
    return attachPurgeViewer();
  }, [open]);

  const runScan = useCallback(async () => {
    const s = settingsRef.current;
    const res = await rescan(s.includeBrowserCaches, s.recycleMinAgeDays);
    if (!res || !autoStartRef.current) return;
    // Quick path: only the default-on ids that can run in this session (CONTRACT §3.1).
    const quick = availableCategories(res).filter((c) => (DEFAULT_ON_CATEGORIES as readonly string[]).includes(c.id));
    if (quick.length === 0) return;
    if (getPurgeState().running) return;
    const runId = getPurgeState().runId + 1;
    setMyRun(runId);
    startPurge(quick, "Quick clean", s.recycleMinAgeDays).catch((e: unknown) => onStartError(runId, e, setMyRun));
  }, [rescan]);

  // Fresh session every time the modal opens.
  useEffect(() => {
    if (!open) return;
    resetOverrides();
    const st = getPurgeState();
    if (st.running) {
      // A cleanup is already in flight (started elsewhere / modal re-opened): show its progress.
      setMyRun(st.runId);
      return;
    }
    setMyRun(null);
    void runScan();
    return () => reset();
  }, [open]);

  // Adopt any cleanup that is running while the modal is open (e.g. started from the Clean caches page).
  useEffect(() => {
    if (open && engine.running && myRun !== engine.runId) setMyRun(engine.runId);
  }, [open, engine.running, engine.runId, myRun]);

  const onClean = useCallback(() => {
    if (engine.running) return;
    const cats = selection.selectedCategories;
    if (cats.length === 0) return;
    if (getPurgeState().running) return; // double-click before re-render
    const runId = getPurgeState().runId + 1;
    setMyRun(runId);
    startPurge(cats, "Clean caches", scanner.scannedRecycleAge).catch((e: unknown) => onStartError(runId, e, setMyRun));
  }, [engine.running, selection.selectedCategories, scanner.scannedRecycleAge]);

  const scanAgain = useCallback(() => {
    setMyRun(null);
    resetOverrides();
    void rescan(settingsRef.current.includeBrowserCaches, settingsRef.current.recycleMinAgeDays);
  }, [rescan, resetOverrides]);

  const openReliability = useCallback(() => {
    api.openReliabilityMonitor().catch((e: unknown) =>
      toast(`Could not open Reliability Monitor: ${e instanceof Error ? e.message : String(e)}`, "crit"),
    );
  }, []);

  /* ------------------------------------------------------------------ view state */

  const running = engine.running;
  const finished = myRun !== null && !engine.running && engine.lastRunId === myRun;
  const result = finished ? engine.lastResult : null;
  const runError = finished && !engine.lastResult ? engine.error : null;

  const cats = scanner.scan?.categories ?? [];
  const nothingSelected = selection.selectedCategories.length === 0;
  const head = headline(selection.selectedBytes, scanner.scan);

  // The buttons change with every stage; when the focused one disappears, focus moves to the new
  // stage's safe button (Cancel / Close / Done) instead of falling out of the dialog.
  const stage = running
    ? "running"
    : result
      ? "done"
      : runError || scanner.phase === "error"
        ? "error"
        : scanner.phase !== "ready" || !scanner.scan
          ? "measuring"
          : "ready";
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
      if (!dialog || dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open, stage]);

  let title: string;
  let subtitle: ReactNode;
  let body: ReactNode = null;
  let footer: ReactNode;

  // Keyed, so the same DOM button (and the focus on it) survives from one stage to the next.
  const closeButton = (label: string) => (
    <Button key="close" onClick={onClose} data-autofocus>
      {label}
    </Button>
  );

  if (running) {
    title = "Cleaning caches…";
    subtitle = "You can close this window. The cleanup keeps running in the background.";
    body = <PurgeProgressPanel engine={engine} compact />;
    footer = <>{closeButton("Close")}</>;
  } else if (result) {
    title = summaryHeadline(result);
    subtitle = summaryDetail(result);
    body = <CleanupSummary variant="dialog" result={result} onDone={onClose} />;
    footer = (
      <>
        <Button key="again" onClick={scanAgain}>
          Measure again
        </Button>
        <Button key="done" variant="primary" onClick={onClose} data-autofocus>
          Done
        </Button>
      </>
    );
  } else if (runError || scanner.phase === "error") {
    title = runError ? "Cleanup failed" : "Measuring failed";
    subtitle = <span className="break-words">{runError ?? scanner.error ?? "Unknown error"}</span>;
    footer = (
      <>
        {closeButton("Close")}
        <Button key="again" onClick={scanAgain}>
          {runError ? "Measure again" : "Try again"}
        </Button>
      </>
    );
  } else if (scanner.phase !== "ready" || !scanner.scan) {
    title = autoStart ? "Measuring. Cleaning starts automatically…" : "Measuring reclaimable caches…";
    subtitle = "Measured first. Protected system paths and personal files are never touched.";
    body = <ScanningState compact title={title} />;
    footer = <>{closeButton("Cancel")}</>;
  } else {
    const scan = scanner.scan;
    title = nothingSelected ? "Reclaimable caches" : `Clean ${head.now} of cache files?`;
    subtitle = CONFIRM_BODY;
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] font-semibold leading-4 text-ink-2">Reclaimable caches</span>
          <span className="flex gap-3.5">
            <InkLink chevron={false} onClick={resetOverrides} title="Back to the categories that are on by default">
              Select defaults
            </InkLink>
            <InkLink chevron={false} onClick={() => selection.setAll(true)}>
              All
            </InkLink>
            <InkLink chevron={false} onClick={() => selection.setAll(false)}>
              None
            </InkLink>
          </span>
        </div>
        <SelectionWell
          categories={cats}
          unit={listUnit([...cats, { bytes: selection.selectedBytes }])}
          totalFiles={selection.selectedFiles}
          totalBytes={selection.selectedBytes}
          selected={selection.selected}
          onToggle={selection.toggle}
        />
        <p className="tnum text-callout text-ink-3">
          {head.more ? `${head.text} · measured in ${fmtDuration(scan.durationMs)}` : `Measured in ${fmtDuration(scan.durationMs)}`}
        </p>
        {!settings.includeBrowserCaches && !cats.some((c) => c.id === "browser") && (
          <p className="text-callout text-ink-3">Browser and Discord caches are not included. Turn them on in the Clean caches page or in Settings.</p>
        )}
        {cats.some((c) => c.id === "dumps") && (
          <InkLink onClick={openReliability} className="self-start">
            Open Reliability Monitor
          </InkLink>
        )}
        <p className="flex gap-2 text-callout text-ink-2">
          <ShieldCheck size={14} className="mt-px shrink-0 text-ok-icon" aria-hidden="true" />
          {CONFIRM_REASSURANCE}
        </p>
      </div>
    );
    footer = (
      <>
        <Button key="again" variant="plain" onClick={scanAgain} className="mr-auto">
          Measure again
        </Button>
        {closeButton("Cancel")}
        <Button key="clean" variant="primary" onClick={onClean} disabled={nothingSelected || engine.running}>
          {`Clean ${head.now}`}
        </Button>
      </>
    );
  }

  return (
    <Modal open={open} onClose={onClose} variant="alert" title={title} subtitle={subtitle} footer={footer} ariaLabel="Clean caches">
      {body}
    </Modal>
  );
}

/**
 * A rejected `startPurge`. Failures of a run that actually started are already surfaced by the
 * engine (inline error state while this modal is open, a toast once it is closed), so only report
 * errors that happened before the run began (e.g. another surface won the race).
 */
function onStartError(runId: number, e: unknown, setMyRun: (id: number | null) => void) {
  const st = getPurgeState();
  if (st.running) {
    setMyRun(st.runId); // someone else's cleanup is in flight: follow its progress instead
    return;
  }
  if (st.lastRunId === runId) return;
  toast(`Cleanup failed: ${e instanceof Error ? e.message : String(e)}`, "crit");
}
