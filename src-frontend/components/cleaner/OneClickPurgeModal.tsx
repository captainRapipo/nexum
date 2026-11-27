import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { DEFAULT_ON_CATEGORIES, DEFAULT_SETTINGS } from "../../types";
import { api } from "../../lib/api";
import { useSettings } from "../../hooks/useSettings";
import { Button, Modal } from "../ui";
import { toast } from "../feedback/Toast";
import ScanningState from "./ScanningState";
import CategoryList from "./CategoryList";
import PurgeProgressPanel from "./PurgeProgressPanel";
import CleanupSummary from "./CleanupSummary";
import { availableCategories, useCategorySelection, useTrashScan } from "./useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "./purgeEngine";
import { headline, listUnit } from "./cleanerCopy";

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
 * "Clean caches" (F9 / top bar / tray): measure → "Reclaimable caches" headline with per-category
 * toggles → live progress via `purge-progress` → CleanupSummary with the audit log link.
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
    const res = await rescan(s.includeBrowserCaches);
    if (!res || !autoStartRef.current) return;
    // Quick path: only the default-on ids that can run in this session (CONTRACT §3.1).
    const quick = availableCategories(res).filter((c) => (DEFAULT_ON_CATEGORIES as readonly string[]).includes(c.id));
    if (quick.length === 0) return;
    if (getPurgeState().running) return;
    const runId = getPurgeState().runId + 1;
    setMyRun(runId);
    startPurge(quick, "Quick clean").catch((e: unknown) => onStartError(runId, e, setMyRun));
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

  // Adopt any cleanup that is running while the modal is open (e.g. started from the Cleaner page).
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
    startPurge(cats, "Clean caches").catch((e: unknown) => onStartError(runId, e, setMyRun));
  }, [engine.running, selection.selectedCategories]);

  const scanAgain = useCallback(() => {
    setMyRun(null);
    resetOverrides();
    void rescan(settingsRef.current.includeBrowserCaches);
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

  let body: ReactNode;
  let footer: ReactNode = null;
  let subtitle = "Measured first. Protected system paths and personal files are never touched.";

  if (running) {
    body = <PurgeProgressPanel engine={engine} />;
    subtitle = "You can close this window. The cleanup keeps running in the background.";
  } else if (result) {
    body = <CleanupSummary result={result} onDone={onClose} secondary={{ label: "Measure again", onClick: scanAgain }} />;
    subtitle = `Finished in ${fmtDuration(result.durationMs)}`;
  } else if (runError) {
    body = <ErrorState title="Cleanup failed" message={runError} onRetry={scanAgain} retryLabel="Measure again" />;
  } else if (scanner.phase === "error") {
    body = <ErrorState title="Measuring failed" message={scanner.error ?? "Unknown error"} onRetry={scanAgain} retryLabel="Try again" />;
  } else if (scanner.phase !== "ready" || !scanner.scan) {
    body = <ScanningState title={autoStart ? "Measuring. Cleaning starts automatically…" : undefined} />;
  } else {
    const scan = scanner.scan;
    body = (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center text-center">
          <div className="text-[12px] font-semibold uppercase tracking-[0.24em] text-muted">Reclaimable caches</div>
          <div className="mt-2 font-mono text-[40px] font-semibold leading-none tracking-tight text-ink">{head.now}</div>
          {head.more && <div className="mt-2 font-mono text-[12px] text-silver">now · {head.more} more as administrator</div>}
          <div className="mt-1 font-mono text-[11px] text-muted">
            {selection.selectedFiles.toLocaleString("en-US")} files selected · measured in {fmtDuration(scan.durationMs)}
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px]">
          <span className="uppercase tracking-[0.18em] text-muted">Categories</span>
          <div className="flex gap-3">
            <button type="button" className="text-silver transition hover:text-ink" onClick={() => selection.setAll(true)}>
              Select all
            </button>
            <button type="button" className="text-silver transition hover:text-ink" onClick={() => selection.setAll(false)}>
              None
            </button>
          </div>
        </div>

        <CategoryList
          compact
          categories={cats}
          unit={listUnit(cats)}
          selected={selection.selected}
          onToggle={selection.toggle}
          onOpenReliabilityMonitor={openReliability}
        />

        {!settings.includeBrowserCaches && !cats.some((c) => c.id === "browser") && (
          <p className="text-[11px] text-muted">Browser and Discord caches are not included. Turn them on in the Cleaner page or in Settings.</p>
        )}
      </div>
    );
    footer = (
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          <ShieldCheck size={14} className="text-teal" />
          Cookies, logins and personal files are never touched.
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={scanAgain}>
            Measure again
          </Button>
          <Button variant="teal" icon={<Sparkles size={15} />} onClick={onClean} disabled={nothingSelected || engine.running}>
            {`Clean ${head.now}`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Clean caches"
      subtitle={subtitle}
      icon={<Sparkles size={17} />}
      footer={footer ?? undefined}
      width={640}
      ariaLabel="Clean caches"
    >
      {body}
    </Modal>
  );
}

/**
 * A rejected `startPurge`. Failures of a run that actually started are already surfaced by the
 * engine (inline ErrorState while this modal is open, a toast once it is closed), so only report
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

function ErrorState({
  title,
  message,
  onRetry,
  retryLabel,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-crit/40 bg-crit/10 text-rose-400">
        <AlertTriangle size={22} />
      </div>
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      <p className="max-w-md break-words text-[12.5px] text-muted">{message}</p>
      <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
