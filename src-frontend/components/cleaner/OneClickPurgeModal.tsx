import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { DEFAULT_SETTINGS } from "../../types";
import { useSettings } from "../../hooks/useSettings";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { Button, Modal } from "../ui";
import { fmtBytes } from "../../lib/format";
import { toast } from "../feedback/Toast";
import ScanningState from "./ScanningState";
import CategoryList from "./CategoryList";
import PurgeProgressPanel from "./PurgeProgressPanel";
import CleanupSummary from "./CleanupSummary";
import { fileCategories, useCategorySelection, useTrashScan } from "./useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "./purgeEngine";

export interface OneClickPurgeModalProps {
  open: boolean;
  onClose: () => void;
  /** Skip confirmation: purge the default selection as soon as the dry-run scan completes. */
  autoStart?: boolean;
}

/**
 * 1-Click Deep Purge: dry-run scan → "X GB Ready to Purge" with per-category toggles →
 * purge with live `purge-progress` overlay → CleanupSummary.
 */
export default function OneClickPurgeModal({ open, onClose, autoStart = false }: OneClickPurgeModalProps) {
  const { settings: rawSettings } = useSettings();
  const settings = rawSettings ?? DEFAULT_SETTINGS;
  const { info } = useSystemInfo();
  const { agent } = useTelemetry();
  const isAdmin = agent?.isAdmin ?? info?.isAdmin ?? true;

  const engine = usePurgeEngine();
  const scanner = useTrashScan();
  const selection = useCategorySelection(scanner.scan);
  const [flushStandby, setFlushStandby] = useState<boolean>(settings.flushStandbyOnPurge);
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
    // Auto-start: purge the backend's default selection immediately.
    const defaults = fileCategories(res).filter((c) => c.enabled);
    if (defaults.length === 0 && !s.flushStandbyOnPurge) return;
    if (getPurgeState().running) return;
    const runId = getPurgeState().runId + 1;
    setMyRun(runId);
    startPurge(defaults, s.flushStandbyOnPurge, "1-Click").catch((e: unknown) => onStartError(runId, e, setMyRun));
  }, [rescan]);

  // Fresh session every time the modal opens.
  useEffect(() => {
    if (!open) return;
    resetOverrides();
    setFlushStandby(settingsRef.current.flushStandbyOnPurge);
    const st = getPurgeState();
    if (st.running) {
      // A purge is already in flight (started elsewhere / modal re-opened): show its progress.
      setMyRun(st.runId);
      return;
    }
    setMyRun(null);
    void runScan();
    return () => reset();
  }, [open]);

  // Adopt any purge that is running while the modal is open (e.g. started from the Cleaner page).
  useEffect(() => {
    if (open && engine.running && myRun !== engine.runId) setMyRun(engine.runId);
  }, [open, engine.running, engine.runId, myRun]);

  const onPurge = useCallback(() => {
    if (engine.running) return;
    const cats = selection.selectedCategories;
    if (cats.length === 0 && !flushStandby) return;
    if (getPurgeState().running) return; // double-click before re-render
    const runId = getPurgeState().runId + 1;
    setMyRun(runId);
    startPurge(cats, flushStandby, "1-Click").catch((e: unknown) => onStartError(runId, e, setMyRun));
  }, [engine.running, selection.selectedCategories, flushStandby]);

  const scanAgain = useCallback(() => {
    setMyRun(null);
    resetOverrides();
    void rescan(settingsRef.current.includeBrowserCaches);
  }, [rescan, resetOverrides]);

  /* ------------------------------------------------------------------ view state */

  const purging = engine.running;
  const finished = myRun !== null && !engine.running && engine.lastRunId === myRun;
  const result = finished ? engine.lastResult : null;
  const purgeError = finished && !engine.lastResult ? engine.error : null;

  const cats = scanner.scan?.categories ?? [];
  const nothingSelected = selection.selectedCategories.length === 0 && !flushStandby;

  let body: ReactNode;
  let footer: ReactNode = null;
  let subtitle: string = "Safe dry-run first — protected system paths are never touched.";

  if (purging) {
    body = <PurgeProgressPanel engine={engine} />;
    subtitle = "You can close this window — the purge keeps running in the background.";
  } else if (result) {
    body = <CleanupSummary result={result} onDone={onClose} secondary={{ label: "Scan again", onClick: scanAgain }} />;
    subtitle = `Completed in ${fmtDuration(result.durationMs)}`;
  } else if (purgeError) {
    body = (
      <ErrorState
        title="Purge failed"
        message={purgeError}
        onRetry={scanAgain}
        retryLabel="Scan again"
      />
    );
  } else if (scanner.phase === "error") {
    body = (
      <ErrorState title="Scan failed" message={scanner.error ?? "Unknown error"} onRetry={scanAgain} retryLabel="Retry scan" />
    );
  } else if (scanner.phase !== "ready" || !scanner.scan) {
    body = <ScanningState title={autoStart ? "Analyzing — purge starts automatically…" : undefined} />;
  } else {
    const scan = scanner.scan;
    body = (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col items-center text-center">
          <div className="font-mono text-[46px] font-semibold leading-none tracking-tight text-gold drop-shadow-[0_0_18px_rgba(212,163,89,0.35)]">
            {fmtBytes(selection.selectedBytes, 2)}
          </div>
          <div className="mt-2 text-[13px] font-semibold uppercase tracking-[0.28em] text-ink">Ready to Purge</div>
          <div className="mt-1.5 font-mono text-[11px] text-muted">
            {selection.selectedFiles.toLocaleString()} files selected · {fmtBytes(scan.totalBytes)} found in{" "}
            {fmtDuration(scan.durationMs)}
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px]">
          <span className="uppercase tracking-[0.18em] text-muted">Categories</span>
          <div className="flex gap-3">
            <button type="button" className="text-silver transition hover:text-gold" onClick={() => selection.setAll(true)}>
              Select all
            </button>
            <button type="button" className="text-silver transition hover:text-gold" onClick={() => selection.setAll(false)}>
              None
            </button>
          </div>
        </div>

        <CategoryList
          compact
          categories={cats}
          selected={selection.selected}
          onToggle={selection.toggle}
          flushStandby={flushStandby}
          onToggleStandby={setFlushStandby}
          isAdmin={isAdmin}
        />

        {!settings.includeBrowserCaches && !cats.some((c) => c.id === "browser") && (
          <p className="text-[11px] text-muted">
            Browser &amp; app caches are excluded — enable them on the Cleaner page or in Settings.
          </p>
        )}
      </div>
    );
    footer = (
      <div className="flex w-full items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11.5px] text-muted">
          <ShieldCheck size={14} className="text-teal" />
          Cookies, logins &amp; personal files are never touched.
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={scanAgain}>
            Rescan
          </Button>
          <Button variant="gold" icon={<Zap size={15} />} onClick={onPurge} disabled={nothingSelected || engine.running}>
            {`Purge ${fmtBytes(selection.selectedBytes)}`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="1-Click Deep Purge"
      subtitle={subtitle}
      icon={<Zap size={17} />}
      footer={footer ?? undefined}
      width={640}
      ariaLabel="1-Click Deep Purge"
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
    setMyRun(st.runId); // someone else's purge is in flight: follow its progress instead
    return;
  }
  if (st.lastRunId === runId) return;
  toast(`Purge failed: ${e instanceof Error ? e.message : String(e)}`, "crit");
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
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-rose/40 bg-rose/10 text-rose">
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
