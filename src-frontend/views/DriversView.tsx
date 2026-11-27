import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CircuitBoard,
  FileJson,
  FileSpreadsheet,
  FolderOpen,
  HardDriveDownload,
  Layers,
  OctagonAlert,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type { DriverBackupResult, DriverCategory, DriverInfo } from "../types";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { useDriverScan } from "../hooks/useDriverScan";
import { useSystemInfo } from "../hooks/useSystemInfo";
import GlassCard from "../components/layout/GlassCard";
import { Button } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import DriverTable from "../components/drivers/DriverTable";
import DriverFilters from "../components/drivers/DriverFilters";
import DriverDetailPanel from "../components/drivers/DriverDetailPanel";
import StatTile from "../components/drivers/StatTile";
import LedProgress from "../components/cleaner/LedProgress";
import {
  dirnameOf,
  driverSearchText,
  groupDrivers,
  type DriverRow,
  type DriverStatusFilter,
} from "../components/drivers/driverUtils";

const PROBLEM_RULE =
  "Devices for which Windows reports an error code (Device Manager), except 22 (disabled by you) and 45 (not connected).";
const UNSIGNED_RULE = "Drivers without a valid digital signature.";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function fmtRelative(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "Never";
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 45) return "Just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function fmtClock(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
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

type BackupState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "done"; result: DriverBackupResult; tookMs: number }
  | { phase: "error"; message: string };

export default function DriversView() {
  const { drivers: rawDrivers, loading, error, lastScan, rescan } = useDriverScan();
  const { info } = useSystemInfo();
  const drivers: DriverInfo[] = useMemo(() => rawDrivers ?? [], [rawDrivers]);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [category, setCategory] = useState<DriverCategory | "all">("all");
  const [status, setStatus] = useState<DriverStatusFilter>("all");
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

  // Re-render every second while a backup runs (elapsed timer) and every 30s for "last scan" relative time.
  useEffect(() => {
    const ms = backup.phase === "running" ? 1000 : 30000;
    const t = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [backup.phase]);

  /* ----------------------------------------------------------------- grouping & filtering */

  /** Identical rows (same device name, version and provider) collapse into one: "Processor × 16". */
  const groups = useMemo(() => groupDrivers(drivers), [drivers]);

  // Keep the selected row in sync after a rescan (or close it if the device disappeared).
  useEffect(() => {
    if (!selected) return;
    const next = groups.find((g) => g.key === selected.key) ?? null;
    if (next !== selected) setSelected(next);
  }, [groups, selected]);

  const searchIndex = useMemo(
    () => groups.map((g) => ({ g, text: g.members.map(driverSearchText).join(" ") })),
    [groups],
  );

  const { filtered, categoryCounts, statusCounts } = useMemo(() => {
    const terms = deferredQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const bySearch = terms.length ? searchIndex.filter((x) => terms.every((t) => x.text.includes(t))).map((x) => x.g) : groups;

    const catCounts: Record<string, number> = {};
    const stCounts: Record<DriverStatusFilter, number> = { all: 0, ok: 0, unsigned: 0, problem: 0 };
    for (const g of bySearch) {
      const cat = g.driver.category;
      if (status === "all" || g.status === status) catCounts[cat] = (catCounts[cat] ?? 0) + 1;
      if (category === "all" || cat === category) {
        stCounts.all++;
        stCounts[g.status]++;
      }
    }
    const out = bySearch.filter(
      (g) => (category === "all" || g.driver.category === category) && (status === "all" || g.status === status),
    );
    return { filtered: out, categoryCounts: catCounts, statusCounts: stCounts };
  }, [groups, searchIndex, deferredQuery, category, status]);

  const totalForChips = useMemo(
    () => Object.values(categoryCounts).reduce((a, b) => a + b, 0),
    [categoryCounts],
  );

  /* ---------------------------------------------------------------- summary KPIs */

  const kpi = useMemo(() => {
    let problems = 0;
    let unsigned = 0;
    let inbox = 0;
    for (const d of drivers) {
      if (d.status === "problem") problems++;
      if (!d.signed) unsigned++;
      if (d.isInbox) inbox++;
    }
    const categories = new Set(drivers.map((d) => d.category)).size;
    return { total: drivers.length, problems, unsigned, inbox, categories };
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

  const backupCard = (
    <GlassCard title="Driver backup" icon={<Archive size={15} />} accent="purple">
      <div className="space-y-3 text-[12.5px]">
        <p className="leading-relaxed text-muted">
          Exports every third-party driver package from the driver store (
          <span className="font-mono text-silver">pnputil /export-driver</span>) into{" "}
          <span className="font-mono text-silver">Documents\Nexum</span>.
        </p>
        {!isAdmin && (
          <div className="flex items-start gap-2 rounded-md border border-warn/35 bg-warn/[0.06] px-3 py-2 text-warn">
            <ShieldAlert size={14} className="mt-0.5 shrink-0" />
            <span>Backup needs administrator rights. Restart Nexum as administrator for a complete export.</span>
          </div>
        )}

        {backup.phase === "idle" && (
          <Button variant="ghost" size="sm" icon={<HardDriveDownload size={14} />} onClick={() => void onBackup()}>
            Start backup
          </Button>
        )}

        {backup.phase === "running" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-silver">Exporting driver packages…</span>
              <span className="font-mono text-silver">{fmtElapsed(Date.now() - backup.startedAt)}</span>
            </div>
            <LedProgress tone="teal" segments={28} height={8} />
            <p className="text-[11px] text-muted">This can take a few minutes on systems with many drivers.</p>
          </div>
        )}

        {backup.phase === "error" && (
          <div className="space-y-2">
            <div className="rounded-md border border-crit/40 bg-crit/[0.07] px-3 py-2 text-rose-300">{backup.message}</div>
            <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void onBackup()}>
              Try again
            </Button>
          </div>
        )}

        {backup.phase === "done" && (
          <div className="space-y-2">
            <div
              className={cn(
                "rounded-md border px-3 py-2",
                backup.result.success ? "border-ok/35 bg-ok/[0.07] text-ok" : "border-warn/35 bg-warn/[0.07] text-warn",
              )}
            >
              <div className="font-semibold">
                {backup.result.success ? "Backup complete" : "Backup finished with errors"}
                <span className="ml-2 font-mono text-[11px] font-normal opacity-80">{(backup.tookMs / 1000).toFixed(1)}s</span>
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-silver">{backup.result.path || "—"}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {backup.result.path && (
                <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} onClick={() => void openFolder(backup.result.path)}>
                  Open folder
                </Button>
              )}
              {backup.result.output && (
                <Button variant="ghost" size="sm" onClick={() => setShowOutput((v) => !v)}>
                  {showOutput ? "Hide log" : "Show log"}
                </Button>
              )}
            </div>
            {showOutput && backup.result.output && (
              <pre className="nx-scroll max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas-0/80 p-3 font-mono text-[10.5px] leading-relaxed text-muted">
                {backup.result.output}
              </pre>
            )}
          </div>
        )}
      </div>
    </GlassCard>
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Drivers</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Every signed PnP driver with provider, version, release date and signature. Read-only inventory.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} className={loading ? "animate-spin" : undefined} />}
            onClick={onRescan}
            disabled={loading}
            title="Rescan drivers (F5)"
          >
            {loading ? "Scanning…" : "Rescan"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FileJson size={14} />}
            onClick={() => void onExport("json")}
            disabled={exporting !== null || drivers.length === 0}
          >
            {exporting === "json" ? "Exporting…" : "Export JSON"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FileSpreadsheet size={14} />}
            onClick={() => void onExport("csv")}
            disabled={exporting !== null || drivers.length === 0}
          >
            {exporting === "csv" ? "Exporting…" : "Export CSV"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<HardDriveDownload size={14} />}
            onClick={() => void onBackup()}
            disabled={backup.phase === "running"}
          >
            {backup.phase === "running" ? "Backing up…" : "Back up drivers"}
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Total drivers"
          value={loading && drivers.length === 0 ? "…" : kpi.total}
          accent="teal"
          icon={<Layers size={15} />}
          sub={`${kpi.categories} categories · ${kpi.inbox} in-box`}
        />
        <StatTile
          label="Problems"
          value={loading && drivers.length === 0 ? "…" : kpi.problems}
          accent="silver"
          valueTone={kpi.problems > 0 ? "crit" : undefined}
          title={PROBLEM_RULE}
          icon={<OctagonAlert size={15} />}
          sub={kpi.problems > 0 ? "Windows reports a device error" : "No device errors reported"}
        />
        <StatTile
          label="Unsigned"
          value={loading && drivers.length === 0 ? "…" : kpi.unsigned}
          accent="silver"
          valueTone={kpi.unsigned > 0 ? "warn" : undefined}
          title={UNSIGNED_RULE}
          icon={<ShieldAlert size={15} />}
          sub={kpi.unsigned > 0 ? "No valid digital signature" : "All drivers signed"}
        />
        <StatTile
          label="Last scan"
          value={<span className="text-[20px]">{fmtRelative(scanDate)}</span>}
          accent="cyan"
          icon={<RefreshCw size={15} />}
          sub={fmtClock(scanDate)}
        />
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-crit/40 bg-crit/[0.07] px-4 py-3 text-[13px] text-rose-300">
          <AlertTriangle size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">Driver scan failed: {String(error)}</span>
          <Button variant="danger" size="sm" onClick={onRescan} disabled={loading}>
            Retry
          </Button>
        </div>
      )}

      {/* Table: full width (BIOS & OS moved to System → OS & Security) */}
      <GlassCard
        title="Driver inventory"
        icon={<CircuitBoard size={15} />}
        accent="teal"
        actions={
          <span className="font-mono text-[11px] text-muted" title="Rows shown / all rows (identical devices are grouped)">
            {filtered.length} / {groups.length}
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <DriverFilters
            query={query}
            onQuery={setQuery}
            category={category}
            onCategory={setCategory}
            status={status}
            onStatus={setStatus}
            categoryCounts={categoryCounts}
            statusCounts={statusCounts}
            total={totalForChips}
          />
          {loading && drivers.length > 0 && <LedProgress tone="teal" height={3} segments={60} />}
          <DriverTable rows={filtered} selectedKey={selectedKey} onSelect={setSelected} loading={loading} />
          <p className="text-[11.5px] text-muted">
            Nexum never installs drivers. Open a device's detail panel for its maker's support page.
          </p>
        </div>
      </GlassCard>

      {backupCard}

      <DriverDetailPanel driver={selected?.driver ?? null} members={selected?.members} onClose={closeDetail} />
    </div>
  );
}
