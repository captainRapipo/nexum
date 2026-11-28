import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import type { DriverBackupResult, DriverCategory, DriverInfo } from "../types";
import { api } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useDriverScan } from "../hooks/useDriverScan";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { usePageChrome } from "../components/layout/PageChrome";
import { Button, InkLink, ProgressBar, StatusIcon } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import DriverTable from "../components/drivers/DriverTable";
import DriverFilters from "../components/drivers/DriverFilters";
import DriverDetailPanel from "../components/drivers/DriverDetailPanel";
import { dirnameOf, driverSearchText, groupDrivers, type DriverRow, type DriverScope } from "../components/drivers/driverUtils";

const PROBLEM_RULE =
  "Devices for which Windows reports an error code (Device Manager), except 22 (disabled by you) and 45 (not connected).";
const UNSIGNED_RULE = "Drivers without a valid digital signature.";
const BACKUP_WHAT = "Copies every third-party driver package from the Windows driver store (pnputil /export-driver) into Documents\\Nexum.";
const BACKUP_ADMIN = "Backup needs administrator rights. Restart Nexum as administrator for a complete copy.";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function openFolder(path: string) {
  try {
    await api.openExternal(path);
  } catch {
    try {
      await api.openExternal(dirnameOf(path));
    } catch (e) {
      toast(`Could not open folder: ${errMsg(e)}`, "crit");
    }
  }
}

/** Does a grouped row belong to this filter-bar selection? */
function inScope(g: DriverRow, scope: DriverScope): boolean {
  if (scope === "all") return true;
  if (scope === "st:problem") return g.status === "problem";
  if (scope === "st:unsigned") return g.status === "unsigned";
  return g.driver.category === (scope.slice(4) as DriverCategory);
}

type BackupState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "done"; result: DriverBackupResult; tookMs: number }
  | { phase: "error"; message: string };

/**
 * Drivers (F7), a list page (CONTRACT §4.10.3, SPEC §7): full-bleed white, no card. A 44 px filter
 * bar (category filter with counts, "Third-party only", Export list, Back up drivers), the driver
 * table, and a 30 px status bar that carries the totals. A row opens its details in a docked
 * inspector on the right. Read-only: Nexum never installs drivers.
 */
export default function DriversView() {
  const { drivers: rawDrivers, loading, error, lastScan, rescan } = useDriverScan();
  const { info } = useSystemInfo();
  const drivers: DriverInfo[] = useMemo(() => rawDrivers ?? [], [rawDrivers]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [scope, setScope] = useState<DriverScope>("all");
  const [thirdPartyOnly, setThirdPartyOnly] = useState(false);
  const [selected, setSelected] = useState<DriverRow | null>(null);
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const [backup, setBackup] = useState<BackupState>({ phase: "idle" });
  const [showOutput, setShowOutput] = useState(false);
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-render every second while a backup runs (elapsed timer) and every 30 s for the "scanned" time.
  useEffect(() => {
    const ms = backup.phase === "running" ? 1000 : 30000;
    const t = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [backup.phase]);

  usePageChrome({
    subtitle: "Installed drivers · read-only",
    search: { value: query, onChange: setQuery, placeholder: "Filter drivers", ariaLabel: "Filter drivers by device, provider, version, INF or hardware ID" },
  });

  /* ----------------------------------------------------------------- grouping & filtering */

  /** Identical rows (same device name, version and provider) collapse into one: "Processor × 16". */
  const groups = useMemo(() => groupDrivers(drivers), [drivers]);

  // Keep the selected row in sync after a rescan (or close it if the device disappeared).
  useEffect(() => {
    if (!selected) return;
    const next = groups.find((g) => g.key === selected.key) ?? null;
    if (next !== selected) setSelected(next);
  }, [groups, selected]);

  const searchIndex = useMemo(() => groups.map((g) => ({ g, text: g.members.map(driverSearchText).join(" ") })), [groups]);

  const { filtered, counts } = useMemo(() => {
    const terms = deferredQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let pool = terms.length ? searchIndex.filter((x) => terms.every((t) => x.text.includes(t))).map((x) => x.g) : groups;
    if (thirdPartyOnly) pool = pool.filter((g) => g.members.some((m) => !m.isInbox));

    const c: Partial<Record<DriverScope, number>> = { all: pool.length, "st:problem": 0, "st:unsigned": 0 };
    for (const g of pool) {
      if (g.status === "problem") c["st:problem"] = (c["st:problem"] ?? 0) + 1;
      if (g.status === "unsigned") c["st:unsigned"] = (c["st:unsigned"] ?? 0) + 1;
      const key: DriverScope = `cat:${g.driver.category}`;
      c[key] = (c[key] ?? 0) + 1;
    }
    return { filtered: pool.filter((g) => inScope(g, scope)), counts: c };
  }, [groups, searchIndex, deferredQuery, thirdPartyOnly, scope]);

  /* ---------------------------------------------------------------- totals (status bar) */

  const totals = useMemo(() => {
    let problems = 0;
    let unsigned = 0;
    // The same three-way split as the Status column and the filter bar: a device with an error code
    // counts as "needs attention" (whatever its signature), an unsigned driver without one as "unsigned".
    for (const d of drivers) {
      if (d.status === "problem") problems++;
      else if (d.status === "unsigned") unsigned++;
    }
    return { total: drivers.length, problems, unsigned };
  }, [drivers]);

  const scanDate: Date | null = useMemo(() => {
    if (lastScan) return lastScan;
    if (info?.lastDriverScan) {
      const d = new Date(info.lastDriverScan);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }, [lastScan, info?.lastDriverScan]);

  /* -------------------------------------------------------------------- actions */

  const onRescan = useCallback(() => {
    try {
      const r = rescan() as unknown;
      if (r && typeof (r as Promise<unknown>).then === "function") {
        (r as Promise<unknown>).catch((e) => toast(`Driver scan failed: ${errMsg(e)}`, "crit"));
      }
    } catch (e) {
      toast(`Driver scan failed: ${errMsg(e)}`, "crit");
    }
  }, [rescan]);

  const onExport = useCallback(
    async (format: "json" | "csv") => {
      if (exporting) return;
      setExporting(format);
      try {
        const path = await api.exportDrivers(format);
        toast(`Driver list exported as ${format.toUpperCase()}`, "ok", {
          detail: path,
          action: { label: "Open folder", onClick: () => void openFolder(dirnameOf(path)) },
        });
      } catch (e) {
        toast(`Export failed: ${errMsg(e)}`, "crit");
      } finally {
        if (mounted.current) setExporting(null);
      }
    },
    [exporting],
  );

  const onBackup = useCallback(async () => {
    if (backup.phase === "running") return;
    const startedAt = Date.now();
    setBackup({ phase: "running", startedAt });
    setShowOutput(false);
    try {
      const result = await api.backupDrivers();
      const tookMs = Date.now() - startedAt;
      if (mounted.current) setBackup({ phase: "done", result, tookMs });
      if (result.success) {
        toast("Driver backup completed", "ok", {
          detail: result.path,
          action: { label: "Open folder", onClick: () => void openFolder(result.path) },
        });
      } else {
        toast("Driver backup finished with errors", "warn", { detail: result.path });
      }
    } catch (e) {
      const message = errMsg(e);
      if (mounted.current) setBackup({ phase: "error", message });
      toast(`Driver backup failed: ${message}`, "crit");
    }
  }, [backup.phase]);

  const isAdmin = info?.isAdmin ?? true;
  const selectedKey = selected ? selected.key : null;
  const closeDetail = useCallback(() => setSelected(null), []);
  const dismissBackup = useCallback(() => {
    setBackup({ phase: "idle" });
    setShowOutput(false);
  }, []);

  /* -------------------------------------------------------------------- render */

  const scanned = scanDate ? fmtDateTime(scanDate) : null;
  const scannedText = loading ? "scanning…" : scanned ? `scanned ${scanned.charAt(0).toLowerCase()}${scanned.slice(1)}` : "not scanned yet";
  const firstScan = loading && drivers.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-content">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DriverFilters
          scope={scope}
          onScope={setScope}
          counts={counts}
          thirdPartyOnly={thirdPartyOnly}
          onThirdPartyOnly={setThirdPartyOnly}
          exporting={exporting}
          onExport={(f) => void onExport(f)}
          canExport={drivers.length > 0}
          backingUp={backup.phase === "running"}
          onBackup={() => void onBackup()}
          backupTitle={isAdmin ? BACKUP_WHAT : `${BACKUP_WHAT} ${BACKUP_ADMIN}`}
        />

        {/* A rescan over an existing list: a thin bar, the rows stay readable. */}
        {loading && drivers.length > 0 && <ProgressBar value={null} indeterminate label="Scanning device drivers" className="shrink-0 rounded-none" />}

        {error && (
          <div role="alert" className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-crit-border bg-crit-bg px-(--page-pad-x) py-1.5 text-callout">
            <StatusIcon tone="crit" size={17} />
            <span className="min-w-0 flex-1 text-ink-2">
              <b className="font-semibold text-ink">The driver scan failed.</b> {String(error)}
            </span>
            <Button size="sm" onClick={onRescan} disabled={loading}>
              Try again
            </Button>
          </div>
        )}

        {backup.phase !== "idle" && (
          <BackupStrip backup={backup} isAdmin={isAdmin} showOutput={showOutput} onToggleOutput={() => setShowOutput((v) => !v)} onRetry={() => void onBackup()} onDismiss={dismissBackup} />
        )}

        <DriverTable rows={filtered} selectedKey={selectedKey} onSelect={setSelected} loading={loading} />

        {/* Status bar (SPEC §3, §7): the totals that used to be tiles, and the read-only promise. */}
        <footer className="flex h-[30px] shrink-0 items-center gap-4 whitespace-nowrap border-t border-hairline bg-toolbar px-(--page-pad-x) text-callout text-ink-2">
          <span className="flex min-w-0 items-center gap-1.5 tnum">
            {firstScan ? (
              <span>Scanning device drivers…</span>
            ) : (
              <>
                <span title="Every device driver Windows lists. Identical devices share one row.">
                  {totals.total} {totals.total === 1 ? "driver" : "drivers"}
                </span>
                <span aria-hidden="true">·</span>
                <span title={PROBLEM_RULE}>
                  {totals.problems} {totals.problems === 1 ? "needs" : "need"} attention
                </span>
                <span aria-hidden="true">·</span>
                <span title={UNSIGNED_RULE}>{totals.unsigned} unsigned</span>
                {filtered.length !== groups.length && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span title="Rows after the filter. Identical devices share one row.">
                      {filtered.length} of {groups.length} rows shown
                    </span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="truncate">{scannedText}</span>
              </>
            )}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <Lock size={13} aria-hidden="true" className="text-ink-3" />
            Nexum never installs drivers.
          </span>
        </footer>
      </div>

      <DriverDetailPanel driver={selected?.driver ?? null} members={selected?.members} onClose={closeDetail} />
    </div>
  );
}

/** Progress and result of "Back up drivers", as a strip under the filter bar. */
function BackupStrip({
  backup,
  isAdmin,
  showOutput,
  onToggleOutput,
  onRetry,
  onDismiss,
}: {
  backup: Exclude<BackupState, { phase: "idle" }>;
  isAdmin: boolean;
  showOutput: boolean;
  onToggleOutput: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (backup.phase === "running") {
    return (
      <div className="shrink-0 border-b border-hairline bg-toolbar">
        <div className="flex min-h-11 items-center gap-2.5 px-(--page-pad-x) py-1.5 text-callout text-ink-2">
          <span className="min-w-0 flex-1 truncate">
            <b className="font-semibold text-ink">Copying driver packages…</b> This can take a few minutes on a PC with many drivers.
            {!isAdmin && ` ${BACKUP_ADMIN}`}
          </span>
          <span className="shrink-0 tnum">{fmtElapsed(Date.now() - backup.startedAt)}</span>
        </div>
        <ProgressBar value={null} indeterminate label="Driver backup" className="rounded-none" />
      </div>
    );
  }

  if (backup.phase === "error") {
    return (
      <div role="alert" className="flex min-h-11 shrink-0 items-center gap-2.5 border-b border-crit-border bg-crit-bg px-(--page-pad-x) py-1.5 text-callout">
        <StatusIcon tone="crit" size={17} />
        <span className="min-w-0 flex-1 text-ink-2">
          <b className="font-semibold text-ink">The driver backup failed.</b> {backup.message}
        </span>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
        <Button size="sm" variant="plain" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }

  const ok = backup.result.success;
  return (
    <div className={ok ? "shrink-0 border-b border-ok-border bg-ok-bg" : "shrink-0 border-b border-warn-border bg-warn-bg"}>
      <div role="status" className="flex min-h-11 items-center gap-2.5 px-(--page-pad-x) py-1.5 text-callout">
        <StatusIcon tone={ok ? "ok" : "warn"} size={17} />
        <span className="min-w-0 flex-1 truncate text-ink-2">
          <b className="font-semibold text-ink">{ok ? "Backup complete" : "Backup finished with errors"}</b>
          <span className="tnum"> in {(backup.tookMs / 1000).toFixed(1)} s</span>
          {backup.result.path && (
            <span className="ml-2 font-mono text-[11.5px]" title={backup.result.path}>
              {backup.result.path}
            </span>
          )}
        </span>
        {backup.result.path && (
          <InkLink chevron={false} onClick={() => void openFolder(backup.result.path)}>
            Open folder
          </InkLink>
        )}
        {backup.result.output && (
          <InkLink chevron={false} onClick={onToggleOutput} aria-expanded={showOutput}>
            {showOutput ? "Hide log" : "Show log"}
          </InkLink>
        )}
        <Button size="sm" variant="plain" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {showOutput && backup.result.output && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all border-t border-divider bg-content px-(--page-pad-x) py-2.5 font-mono text-[11px] leading-4 text-ink-2">
          {backup.result.output}
        </pre>
      )}
    </div>
  );
}
