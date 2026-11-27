import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Layers, Lock, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { DEFAULT_SETTINGS, type TrashCategory } from "../types";
import { api } from "../lib/api";
import { onRescanRequest } from "../lib/nav";
import { useSettings } from "../hooks/useSettings";
import { fmtBytes } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { Button, Modal } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import StatTile from "../components/drivers/StatTile";
import CategoryList from "../components/cleaner/CategoryList";
import CleanupSummary from "../components/cleaner/CleanupSummary";
import PurgeProgressPanel from "../components/cleaner/PurgeProgressPanel";
import ScanningState from "../components/cleaner/ScanningState";
import { useCategorySelection, useTrashScan } from "../components/cleaner/useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "../components/cleaner/purgeEngine";
import { fmtIn, headline, listUnit } from "../components/cleaner/cleanerCopy";

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

/** Mirrors the non-negotiable rules enforced by the Rust cleaner (CONTRACT §3). */
const PROTECTED = [
  "%WINDIR%\\System32 (incl. \\config registry hives), SysWOW64, WinSxS, Prefetch",
  "%ProgramFiles% and %ProgramFiles(x86)%",
  "%ProgramData%\\Nexum and the hardware agent's folder",
  "Documents, Desktop, Pictures, Videos, Music, Downloads, OneDrive",
  "NTUSER.DAT*, UsrClass.dat*, *.regtrans-ms, *.blf",
  "Drive roots and every category root folder itself",
  "Symlinks, junctions and mount points (never followed)",
  "Browser cookies, logins, history, Local Storage and IndexedDB",
];

const RULES = [
  "Crash dumps: the 5 newest and anything less than 30 days old are kept.",
  "Windows Update downloads are skipped while an update is waiting to install or restart.",
  "Delivery Optimization is cleared only through Windows' own cmdlet.",
  "Browser and Discord caches are skipped while that app is open.",
  "Every cleanup writes a log of each file it deleted or skipped.",
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function CleanerView() {
  const { settings: rawSettings, update } = useSettings();
  const settings = rawSettings ?? DEFAULT_SETTINGS;

  const engine = usePurgeEngine();
  const scanner = useTrashScan();
  const { rescan } = scanner;
  const includeBrowser = settings.includeBrowserCaches;
  const forced = useMemo(() => ({ browser: includeBrowser }), [includeBrowser]);
  const selection = useCategorySelection(scanner.scan, forced);

  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Run id whose summary is pinned on this page until dismissed. */
  const [summaryRun, setSummaryRun] = useState<number | null>(null);

  useEffect(() => attachPurgeViewer(), []);

  // Any cleanup running while this page is visible (e.g. from the Clean caches modal) gets its summary here too.
  useEffect(() => {
    if (engine.running) setSummaryRun(engine.runId);
  }, [engine.running, engine.runId]);

  // Measure on mount and whenever the browser-cache setting flips.
  useEffect(() => {
    void rescan(includeBrowser);
  }, [includeBrowser, rescan]);

  // F5 while on the Cleaner re-measures (CONTRACT §4.6), unless a cleanup is running.
  useEffect(
    () =>
      onRescanRequest("cleaner", () => {
        if (!getPurgeState().running) void rescan(includeBrowser);
      }),
    [includeBrowser, rescan],
  );

  // Re-measure after any cleanup so the numbers reflect reality.
  const lastSeenRun = useRef<number | null>(engine.lastRunId);
  useEffect(() => {
    if (engine.lastRunId !== null && engine.lastRunId !== lastSeenRun.current && !engine.running) {
      lastSeenRun.current = engine.lastRunId;
      void rescan(includeBrowser);
    }
  }, [engine.lastRunId, engine.running, includeBrowser, rescan]);

  const categories = useMemo(() => {
    const list = scanner.scan?.categories ?? [];
    if (list.some((c) => c.id === "browser")) return list;
    // Keep the browser row visible (as a toggle bound to the setting) even when the backend omitted it.
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
    startPurge(selectedCats, "Cleaner").catch((e: unknown) => {
      // A run that started reports its own failure; only errors raised before the run began need surfacing.
      if (getPurgeState().lastRunId !== runId && !getPurgeState().running) toast(`Cleanup failed: ${errMsg(e)}`, "crit");
    });
  }, [selectedCats]);

  const onCleanClick = () => {
    if (nothingSelected || engine.running) return;
    if (settings.confirmBeforePurge) setConfirmOpen(true);
    else runClean();
  };

  const sessionFreed = engine.history.reduce((a, h) => a + h.result.freedBytes, 0);
  const sessionFiles = engine.history.reduce((a, h) => a + h.result.filesDeleted, 0);
  const showSummary =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult !== null;
  const runFailed =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult === null && engine.error;

  const scanning = scanner.phase === "scanning" || (scanner.phase === "idle" && !scanner.scan);
  const showFooter = !engine.running && !showSummary;
  const unit = listUnit(categories);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Cache cleanup</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Measures reclaimable caches first, then deletes only what you select. Files in use are skipped, never forced.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={14} className={scanner.phase === "scanning" ? "animate-spin" : undefined} />}
          onClick={() => void rescan(includeBrowser)}
          disabled={scanner.phase === "scanning" || engine.running}
          title="Measure again (F5)"
        >
          Measure again
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Selected"
          value={scanner.scan ? head.now : "…"}
          accent="teal"
          icon={<Sparkles size={15} />}
          sub={`${selection.selectedFiles.toLocaleString("en-US")} files in ${selectedCats.length} ${selectedCats.length === 1 ? "category" : "categories"}`}
        />
        <StatTile
          label="Reclaimable caches"
          value={scanner.scan ? fmtBytes(scanner.scan.totalBytes, 2) : "…"}
          accent="cyan"
          icon={<Layers size={15} />}
          title="Sum of every category that can run in this session"
          sub={
            scanner.scan
              ? head.more
                ? `${head.more} more as administrator`
                : `Measured in ${fmtDuration(scanner.scan.durationMs)}`
              : "Measuring…"
          }
        />
        <StatTile
          label="Freed this session"
          value={fmtBytes(sessionFreed, 2)}
          accent="purple"
          icon={<Sparkles size={15} />}
          sub={`${sessionFiles.toLocaleString("en-US")} files removed`}
        />
        <StatTile
          label="Cleanups run"
          value={engine.history.length}
          accent="silver"
          icon={<History size={15} />}
          sub={engine.history[0] ? `Last at ${fmtTime(engine.history[0].at)}` : "None yet"}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <GlassCard
          title={engine.running ? "Cleaning…" : showSummary ? "Cleanup finished" : "Reclaimable caches"}
          icon={<Layers size={15} />}
          accent="teal"
          actions={
            !engine.running && !showSummary && scanner.scan ? (
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-silver transition hover:text-ink" onClick={() => selection.setAll(true)}>
                  Select all
                </button>
                <button type="button" className="text-silver transition hover:text-ink" onClick={() => selection.setAll(false)}>
                  None
                </button>
              </div>
            ) : undefined
          }
        >
          {engine.running ? (
            <PurgeProgressPanel engine={engine} />
          ) : showSummary && engine.lastResult ? (
            <CleanupSummary result={engine.lastResult} onDone={() => setSummaryRun(null)} />
          ) : (
            <div className="flex flex-col gap-4">
              {runFailed && (
                <div className="rounded-lg border border-crit/40 bg-crit/[0.07] px-3 py-2.5 text-[12.5px] text-rose-300">
                  Cleanup failed: {engine.error}
                </div>
              )}
              {scanner.phase === "error" && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-crit/40 bg-crit/[0.07] px-3 py-2.5 text-[12.5px] text-rose-300">
                  <span>Measuring failed: {scanner.error}</span>
                  <Button variant="danger" size="sm" onClick={() => void rescan(includeBrowser)}>
                    Retry
                  </Button>
                </div>
              )}

              {scanning && !scanner.scan ? (
                <ScanningState />
              ) : (
                <div className={scanner.phase === "scanning" ? "pointer-events-none opacity-60 transition-opacity" : undefined}>
                  <CategoryList
                    categories={categories}
                    unit={unit}
                    selected={selection.selected}
                    onToggle={onToggle}
                    disabled={scanner.phase === "scanning"}
                    onOpenReliabilityMonitor={openReliability}
                    extraNotes={{ browser: "Same switch as Settings › Include browser caches" }}
                  />
                </div>
              )}
            </div>
          )}
        </GlassCard>

        <div className="flex flex-col gap-5">
          <GlassCard title="Session history" icon={<History size={15} />} accent="purple">
            {engine.history.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-muted">No cleanups yet this session.</div>
            ) : (
              <ul className="nx-scroll flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1">
                {engine.history.map((h) => (
                  <li key={h.id} className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[15px] font-semibold text-ink">{fmtBytes(h.result.freedBytes)}</span>
                      <span className="font-mono text-[10.5px] text-muted">
                        {fmtTime(h.at)} · {fmtDuration(h.result.durationMs)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                      <span className="truncate" title={h.categories.join(", ")}>
                        {h.source} · {h.categories.length} {h.categories.length === 1 ? "category" : "categories"}
                      </span>
                      <span className="shrink-0 font-mono">
                        {h.result.filesDeleted.toLocaleString("en-US")} deleted · {h.result.filesSkipped.toLocaleString("en-US")} skipped
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>

          <GlassCard title="Safety rules" icon={<ShieldCheck size={15} />} accent="teal">
            <p className="text-[12px] leading-relaxed text-muted">
              Nexum deletes only <span className="text-silver">inside</span> the listed cache folders, measures and cleans with the
              same rules, and handles every file individually. These locations are never touched:
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {PROTECTED.map((p) => (
                <li key={p} className="flex items-start gap-2 text-[11.5px] text-silver">
                  <Lock size={11} className="mt-[3px] shrink-0 text-teal" />
                  <span className="font-mono text-[11px] leading-snug">{p}</span>
                </li>
              ))}
            </ul>
            <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
              {RULES.map((r) => (
                <li key={r} className="text-[11px] leading-snug text-muted">
                  {r}
                </li>
              ))}
            </ul>
          </GlassCard>
        </div>
      </div>

      {/* Sticky "Ready to clean" footer (MF-10): the action never sits below the fold. */}
      {showFooter && (
        <div className="sticky bottom-0 z-20 -mx-1 mt-1">
          {/* glass-strong: near-opaque, so the scrolled list does not show through the footer text. */}
          <div className="glass-strong flex flex-wrap items-center justify-between gap-4 border border-teal/25 px-5 py-3 shadow-[0_-12px_32px_rgba(0,0,0,0.55)]">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">Ready to clean</div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[24px] font-semibold leading-tight text-ink">{scanner.scan ? head.now : "…"}</span>
                {head.more && <span className="font-mono text-[12px] text-silver">now · {head.more} more as administrator</span>}
              </div>
              <div className="text-[11px] text-muted">
                {selectedCats.length} {selectedCats.length === 1 ? "category" : "categories"}
                {settings.confirmBeforePurge ? " · asks before deleting" : ""}
              </div>
            </div>
            <Button
              variant="teal"
              icon={<Sparkles size={16} />}
              onClick={onCleanClick}
              disabled={nothingSelected || engine.running || !scanner.scan}
            >
              {`Clean ${head.now}`}
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Clean the selected caches?"
        subtitle="The selected files are deleted permanently. Files in use are skipped."
        icon={<Sparkles size={17} />}
        width={460}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="teal" icon={<Sparkles size={15} />} onClick={runClean}>
              {`Clean ${head.now}`}
            </Button>
          </div>
        }
      >
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {selectedCats.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3">
              <span className="text-silver">{c.label}</span>
              <span className="font-mono text-ink">{fmtIn(c.bytes, head.unit)}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
