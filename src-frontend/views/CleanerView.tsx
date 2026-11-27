import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Lock, RefreshCw, ShieldCheck, Sparkles, Trash2, Zap } from "lucide-react";
import { DEFAULT_SETTINGS, type TrashCategory } from "../types";
import { useSettings } from "../hooks/useSettings";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { fmtBytes } from "../lib/format";
import GlassCard from "../components/layout/GlassCard";
import { Button, Modal } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import StatTile from "../components/drivers/StatTile";
import CategoryList from "../components/cleaner/CategoryList";
import CleanupSummary from "../components/cleaner/CleanupSummary";
import PurgeProgressPanel from "../components/cleaner/PurgeProgressPanel";
import ScanningState from "../components/cleaner/ScanningState";
import { fileCategories, useCategorySelection, useTrashScan } from "../components/cleaner/useTrashScan";
import { attachPurgeViewer, fmtDuration, getPurgeState, startPurge, usePurgeEngine } from "../components/cleaner/purgeEngine";

const BROWSER_PLACEHOLDER: TrashCategory = {
  id: "browser",
  label: "Browser & App Caches",
  description:
    "Chrome, Edge, Firefox and Discord cache folders. Logins, cookies, history and saved data are never touched. Enable to include in the scan.",
  bytes: 0,
  files: 0,
  enabled: false,
  optional: true,
  requiresAdmin: false,
};

/** Mirrors the non-negotiable deny-list enforced by the Rust cleaner (CONTRACT §3). */
const PROTECTED = [
  "%WINDIR%\\System32 (incl. \\config registry hives)",
  "%WINDIR%\\SysWOW64 and %WINDIR%\\WinSxS",
  "%ProgramFiles% and %ProgramFiles(x86)%",
  "Documents, Desktop, Pictures, Videos, Music, Downloads, OneDrive",
  "NTUSER.DAT*, UsrClass.dat*, *.regtrans-ms, *.blf",
  "Drive roots and every category root folder itself",
  "Symlinks, junctions and mount points (never followed)",
  "Browser cookies, logins, history, Local Storage & IndexedDB",
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
  const { info } = useSystemInfo();
  const { agent } = useTelemetry();
  const isAdmin = agent?.isAdmin ?? info?.isAdmin ?? true;

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

  // Any purge running while this page is visible (e.g. from the 1-Click modal) gets its summary here too.
  useEffect(() => {
    if (engine.running) setSummaryRun(engine.runId);
  }, [engine.running, engine.runId]);

  // Scan on mount and whenever the browser-cache setting flips.
  useEffect(() => {
    void rescan(includeBrowser);
  }, [includeBrowser, rescan]);

  // Re-scan after any purge (from here or the 1-Click modal) so the numbers reflect reality.
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
    // Keep the browser row visible (as a bound toggle) even when the backend omitted it.
    const idx = list.findIndex((c) => c.id === "standby");
    const out = [...list];
    out.splice(idx === -1 ? out.length : idx, 0, BROWSER_PLACEHOLDER);
    return out;
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

  const onToggleStandby = useCallback(
    (on: boolean) => {
      Promise.resolve(update({ flushStandbyOnPurge: on })).catch((e: unknown) =>
        toast(`Could not save setting: ${errMsg(e)}`, "crit"),
      );
    },
    [update],
  );

  const flushStandby = settings.flushStandbyOnPurge;
  const selectedCats = selection.selectedCategories;
  const nothingSelected = selectedCats.length === 0 && !flushStandby;

  const runPurge = useCallback(() => {
    setConfirmOpen(false);
    // Already running (e.g. a double-click on the confirm button): the progress panel is showing it.
    if (getPurgeState().running) return;
    const runId = getPurgeState().runId + 1;
    setSummaryRun(runId);
    startPurge(selectedCats, flushStandby, "Cleaner").catch((e: unknown) => {
      // A run that started reports its own failure (inline here, or a toast if this page was left);
      // only errors raised before the run began need surfacing.
      if (getPurgeState().lastRunId !== runId && !getPurgeState().running) toast(`Purge failed: ${errMsg(e)}`, "crit");
    });
  }, [selectedCats, flushStandby]);

  const onPurgeClick = () => {
    if (nothingSelected || engine.running) return;
    if (settings.confirmBeforePurge) setConfirmOpen(true);
    else runPurge();
  };

  const sessionFreed = engine.history.reduce((a, h) => a + h.result.freedBytes, 0);
  const sessionFiles = engine.history.reduce((a, h) => a + h.result.filesDeleted, 0);
  const showSummary =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult !== null;
  const purgeFailed =
    summaryRun !== null && !engine.running && engine.lastRunId === summaryRun && engine.lastResult === null && engine.error;

  const scanning = scanner.phase === "scanning" || (scanner.phase === "idle" && !scanner.scan);

  return (
    <div className="flex flex-col gap-5">

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.22em] text-gold/80">Module D · Deep Purge Engine</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">Cleaner</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Dry-run first, then purge exactly what you selected. Locked files are skipped, never forced.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} className={scanner.phase === "scanning" ? "animate-spin" : undefined} />}
            onClick={() => void rescan(includeBrowser)}
            disabled={scanner.phase === "scanning" || engine.running}
          >
            Rescan
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Selected"
          value={scanner.scan ? fmtBytes(selection.selectedBytes, 2) : "…"}
          accent="gold"
          tintValue
          icon={<Zap size={15} />}
          sub={`${selection.selectedFiles.toLocaleString()} files in ${selectedCats.length} categories`}
        />
        <StatTile
          label="Reclaimable"
          value={scanner.scan ? fmtBytes(scanner.scan.totalBytes, 2) : "…"}
          accent="teal"
          icon={<Trash2 size={15} />}
          sub={scanner.scan ? `Scanned in ${fmtDuration(scanner.scan.durationMs)}` : "Scanning…"}
        />
        <StatTile
          label="Freed this session"
          value={fmtBytes(sessionFreed, 2)}
          accent="purple"
          icon={<Sparkles size={15} />}
          sub={`${sessionFiles.toLocaleString()} files removed`}
        />
        <StatTile
          label="Purges run"
          value={engine.history.length}
          accent="cyan"
          icon={<History size={15} />}
          sub={engine.history[0] ? `Last at ${fmtTime(engine.history[0].at)}` : "None yet"}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <GlassCard
          title={engine.running ? "Purging…" : showSummary ? "Purge Complete" : "Dry-Run Results"}
          icon={<Trash2 size={15} />}
          accent="gold"
          actions={
            !engine.running && !showSummary && scanner.scan ? (
              <div className="flex gap-3 text-[11px]">
                <button type="button" className="text-silver transition hover:text-gold" onClick={() => selection.setAll(true)}>
                  Select all
                </button>
                <button type="button" className="text-silver transition hover:text-gold" onClick={() => selection.setAll(false)}>
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
              {purgeFailed && (
                <div className="rounded-lg border border-rose/35 bg-rose/[0.07] px-3 py-2.5 text-[12.5px] text-rose">
                  Purge failed: {engine.error}
                </div>
              )}
              {scanner.phase === "error" && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-rose/35 bg-rose/[0.07] px-3 py-2.5 text-[12.5px] text-rose">
                  <span>Scan failed: {scanner.error}</span>
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
                    selected={selection.selected}
                    onToggle={onToggle}
                    flushStandby={flushStandby}
                    onToggleStandby={onToggleStandby}
                    isAdmin={isAdmin}
                    disabled={scanner.phase === "scanning"}
                    notes={{
                      browser: "Bound to Settings · Include browser caches",
                      standby: "Bound to Settings · Flush standby list on purge",
                    }}
                  />
                </div>
              )}

              <div className="mt-1 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-gold/25 bg-gold/[0.04] px-4 py-3.5">
                <div>
                  <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted">Ready to purge</div>
                  <div className="font-mono text-[26px] font-semibold leading-tight text-gold">
                    {fmtBytes(selection.selectedBytes, 2)}
                  </div>
                  <div className="text-[11px] text-muted">
                    {flushStandby ? "+ RAM standby list flush" : "RAM standby flush off"}
                    {settings.confirmBeforePurge ? " · confirmation on" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onPurgeClick}
                  disabled={nothingSelected || engine.running || !scanner.scan}
                  className="group relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-gold/70 bg-gradient-to-b from-gold/25 to-gold/10 px-7 py-3.5 text-[15px] font-semibold uppercase tracking-[0.14em] text-gold shadow-[0_0_28px_rgba(212,163,89,0.28),inset_0_1px_0_rgba(255,255,255,0.12)] transition hover:from-gold/35 hover:to-gold/15 hover:shadow-[0_0_38px_rgba(212,163,89,0.42)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                >
                  <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 skew-x-[-20deg] bg-white/10 opacity-0 transition-all duration-700 group-hover:left-[120%] group-hover:opacity-100" />
                  <Zap size={18} />
                  Purge Selected
                </button>
              </div>
            </div>
          )}
        </GlassCard>

        <div className="flex flex-col gap-5">
          <GlassCard title="Session History" icon={<History size={15} />} accent="purple">
            {engine.history.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-muted">No purges yet this session.</div>
            ) : (
              <ul className="nx-scroll flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1">
                {engine.history.map((h) => (
                  <li key={h.id} className="rounded-lg border border-line bg-white/[0.02] px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[15px] font-semibold text-gold">{fmtBytes(h.result.freedBytes)}</span>
                      <span className="font-mono text-[10.5px] text-muted">
                        {fmtTime(h.at)} · {fmtDuration(h.result.durationMs)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                      <span className="truncate" title={h.categories.join(", ")}>
                        {h.source} · {h.categories.length} {h.categories.length === 1 ? "category" : "categories"}
                        {h.flushStandby ? " + standby" : ""}
                      </span>
                      <span className="shrink-0 font-mono">
                        {h.result.filesDeleted.toLocaleString()} del · {h.result.filesSkipped.toLocaleString()} skip
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>

          <GlassCard title="Safety Guardrails" icon={<ShieldCheck size={15} />} accent="teal">
            <p className="text-[12px] leading-relaxed text-muted">
              Nexum only deletes <span className="text-silver">inside</span> the enumerated cache roots, uses the same
              enumerator for the dry run and the purge, and handles every file individually. These locations are on an
              immutable deny-list:
            </p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {PROTECTED.map((p) => (
                <li key={p} className="flex items-start gap-2 text-[11.5px] text-silver">
                  <Lock size={11} className="mt-[3px] shrink-0 text-teal" />
                  <span className="font-mono text-[11px] leading-snug">{p}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-muted">
              Prefetch: only <span className="font-mono">*.pf</span> older than 30 days. CBS logs: only rotated logs older
              than 30 days.
            </p>
          </GlassCard>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm deep purge"
        subtitle="This permanently deletes the selected cache and temp files."
        icon={<Zap size={17} />}
        width={460}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="gold" icon={<Zap size={15} />} onClick={runPurge}>
              {`Purge ${fmtBytes(selection.selectedBytes)}`}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-[12.5px]">
          <ul className="flex flex-col gap-1">
            {selectedCats.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-silver">{c.label}</span>
                <span className="font-mono text-gold">{fmtBytes(c.bytes)}</span>
              </li>
            ))}
            {flushStandby && (
              <li className="flex items-center justify-between gap-3">
                <span className="text-silver">RAM Standby List</span>
                <span className="font-mono text-[#c084fc]">flush</span>
              </li>
            )}
          </ul>
          {fileCategories(scanner.scan).some((c) => selection.selected.has(c.id) && c.requiresAdmin) && !isAdmin && (
            <p className="rounded-md border border-gold/30 bg-gold/[0.06] px-3 py-2 text-[11.5px] text-gold/90">
              Some selected categories need Administrator rights; files Nexum cannot access will be skipped.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
