import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, FileSearch, FolderOpen, Loader2, MonitorCog, RefreshCw, SlidersHorizontal, Wind } from "lucide-react";
import type { TuningProbeSummary, TuningRange, TuningState } from "../../types";
import { useTuningState } from "../../hooks/useTuningState";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { api, errorMessage } from "../../lib/api";
import { onRescanRequest } from "../../lib/nav";
import { cn, fmtClock } from "../../lib/format";
import GlassCard from "../layout/GlassCard";
import { Button, DottedLeaderRow, StatusPill, Unavailable, type StatusTone } from "../ui";
import FanCurveChart from "./FanCurveChart";
import {
  MODE_RULE,
  MODE_TEXT,
  NO_CHANGE_NOTE,
  PANEL_HEADER,
  PROBE_BUTTON,
  PROBE_EXPLAIN,
  fmtRange,
  fmtValue,
  folderOf,
  rangeTitle,
  unavailableFor,
} from "./tuningText";

const MODE_TONE: Record<TuningState["mode"], StatusTone> = {
  factory: "ok",
  custom: "info",
  autoUndervolt: "info",
  unknown: "unknown",
};

/**
 * Cooling → GPU tuning tab (CONTRACT §4.10.1, §1.7, §2.14). READ-ONLY: this panel has no control
 * that changes a value — no sliders, no inputs, no Apply. The only action is the read-only probe.
 * Mounted only while the tab is selected; `useTuningState(true)` polls every 5 s while mounted.
 */
export default function GpuTuningPanel() {
  const { state, loading, error, refresh, runProbe } = useTuningState(true);
  const { agent } = useTelemetry();
  const [refreshing, setRefreshing] = useState(false);

  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // F5 while this tab is visible re-reads the state (CONTRACT §4.6).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => onRescanRequest("cooling", () => void refreshRef.current()), []);

  let content: ReactNode;
  if (state == null) {
    if (loading) {
      content = (
        <div className="flex items-center gap-2 py-12 text-[12.5px] text-muted">
          <Loader2 size={14} className="animate-spin text-teal" aria-hidden="true" />
          Reading GPU tuning data…
        </div>
      );
    } else if (!agent?.running) {
      content = (
        <div className="py-10">
          <Unavailable reason="agentOffline" />
        </div>
      );
    } else {
      content = (
        <div className="flex flex-col items-start gap-3 py-10">
          <p className="text-[13px] text-slate-300">{error ? `Could not read GPU tuning data: ${error}` : "No GPU tuning data yet."}</p>
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={refreshing} onClick={() => void doRefresh()}>
            Try again
          </Button>
        </div>
      );
    }
  } else if (!state.supported) {
    content = <UnsupportedState state={state} />;
  } else {
    content = <SupportedState state={state} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan/25 bg-cyan/[0.04] px-4 py-2.5">
        <p className="flex min-w-0 items-center gap-2 text-[12.5px] text-slate-200">
          <Eye size={15} className="shrink-0 text-cyan" aria-hidden="true" />
          {PANEL_HEADER}
        </p>
        <div className="flex items-center gap-2">
          {state && (
            <span className="text-[11px] text-slate-500">
              Read at <span className="num text-slate-300">{fmtClock(state.ts)}</span>
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />}
            onClick={() => void doRefresh()}
            disabled={refreshing}
            title="Read the values again (F5)"
          >
            Refresh
          </Button>
        </div>
      </div>

      {error && state != null && (
        <p role="alert" className="text-[12px] text-rose-400">
          Could not refresh: {error}
        </p>
      )}

      {content}

      <ProbeCard runProbe={runProbe} disabled={!agent?.running} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnsupportedState({ state }: { state: TuningState }) {
  return (
    <GlassCard title="GPU tuning" icon={MonitorCog}>
      <div className="flex flex-col gap-2 py-4">
        <Unavailable reason={unavailableFor(state.reason)} />
        <p className="text-[13px] text-slate-300">{state.message}</p>
        {state.adapterName && <p className="text-[12px] text-slate-500">Adapter: {state.adapterName}</p>}
      </div>
    </GlassCard>
  );
}

interface RowSpec {
  label: string;
  cap: boolean;
  current: number | null;
  range: TuningRange | null;
  unit: string;
  signed?: boolean;
}

function NumberRows({ rows }: { rows: RowSpec[] }) {
  return (
    <table className="w-full text-[12.5px]">
      <caption className="sr-only">GPU tuning values, read-only</caption>
      <thead>
        <tr className="text-left">
          <th scope="col" className="label-caps pb-1.5 font-semibold">
            Setting
          </th>
          <th scope="col" className="label-caps pb-1.5 text-right font-semibold">
            Current
          </th>
          <th scope="col" className="label-caps pb-1.5 text-right font-semibold">
            Range
          </th>
          <th scope="col" className="label-caps pb-1.5 text-right font-semibold">
            Default
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const title = rangeTitle(r.label, r.range, r.unit, r.signed);
          const changed = r.cap && r.current != null && r.range?.default != null && r.current !== r.range.default;
          return (
            <tr key={r.label} className="border-t border-line" title={r.cap ? title : undefined}>
              <th scope="row" className="py-2 pr-3 text-left font-normal text-slate-400">
                {r.label}
              </th>
              {r.cap ? (
                <>
                  <td className="num py-2 text-right text-ink">
                    {fmtValue(r.current, r.unit, r.signed)}
                    {changed && (
                      <span
                        className="ml-2 rounded border border-cyan/35 px-1 text-[10px] font-semibold uppercase tracking-wider text-cyan"
                        title="Differs from the default (changed in AMD Software)."
                      >
                        Changed
                      </span>
                    )}
                  </td>
                  <td className="num py-2 text-right text-slate-300">{fmtRange(r.range, r.unit, r.signed)}</td>
                  <td className="num py-2 text-right text-slate-400">
                    {r.range?.default == null ? "—" : fmtValue(r.range.default, r.unit, r.signed)}
                  </td>
                </>
              ) : (
                <td colSpan={3} className="py-2 text-right">
                  <Unavailable reason="unsupported" />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function onOff(v: boolean | null): string {
  return v == null ? "—" : v ? "On" : "Off";
}

function SupportedState({ state }: { state: TuningState }) {
  const { caps, ranges, current } = state;
  // RDNA4 (Navi 48) reports OD8_GFXCLK_FMAX as an offset (range −500 … +1000, default 0), not an
  // absolute clock: a negative minimum means the value is an offset and is labelled and signed as such.
  const gfxOffset = (ranges.gfxClockMaxMhz?.min ?? 0) < 0;
  const memOffset = (ranges.memClockMaxMhz?.min ?? 0) < 0;
  const rows: RowSpec[] = [
    { label: "Power limit", cap: caps.powerLimit, current: current.powerPct, range: ranges.powerPct, unit: "%", signed: true },
    {
      label: gfxOffset ? "GPU clock offset" : "GPU max clock",
      cap: caps.gfxClockMax,
      current: current.gfxClockMaxMhz,
      range: ranges.gfxClockMaxMhz,
      unit: "MHz",
      signed: gfxOffset,
    },
    {
      label: memOffset ? "Memory clock offset" : "Memory max clock",
      cap: caps.memClockMax,
      current: current.memClockMaxMhz,
      range: ranges.memClockMaxMhz,
      unit: "MHz",
      signed: memOffset,
    },
  ];
  if (caps.voltageOffset) {
    rows.push({ label: "Voltage offset", cap: true, current: current.voltageOffsetMv, range: ranges.voltageOffsetMv, unit: "mV", signed: true });
  }
  const curve = caps.fanCurve ? current.fanCurve : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <GlassCard
        title={state.adapterName ?? "AMD Radeon GPU"}
        icon={MonitorCog}
        accent="gold"
        actions={
          <StatusPill tone={MODE_TONE[state.mode]} title={MODE_RULE}>
            {MODE_TEXT[state.mode]}
          </StatusPill>
        }
      >
        <div className="flex flex-col gap-4">
          <NumberRows rows={rows} />
          <div className="grid gap-x-6 sm:grid-cols-2">
            <DottedLeaderRow
              label="Auto Undervolt"
              value={caps.autoUndervolt ? onOff(current.autoUndervolt) : <Unavailable reason="unsupported" compact />}
            />
            <DottedLeaderRow
              label="Zero RPM"
              value={caps.zeroRpm ? onOff(current.zeroRpm) : <Unavailable reason="unsupported" compact />}
            />
            <DottedLeaderRow
              label="Power mode"
              value={state.powerMode ?? "—"}
              hint={<span className="text-[10.5px] text-slate-600" title="Raw driver value; AMD does not document its meaning.">(raw)</span>}
            />
            <DottedLeaderRow
              label="VPU recoveries since boot"
              value={state.vpuRecoveryCount == null ? "—" : String(state.vpuRecoveryCount)}
            />
            <DottedLeaderRow label="Overdrive version" value={state.odVersion == null ? "—" : `OD${state.odVersion}`} />
          </div>
          <p className="flex items-center gap-2 text-[11.5px] text-slate-500">
            <SlidersHorizontal size={12} aria-hidden="true" className="shrink-0" />
            {NO_CHANGE_NOTE} Change these values in AMD Software.
          </p>
        </div>
      </GlassCard>

      <GlassCard title="GPU fan curve" icon={Wind}>
        {curve && curve.length > 0 ? (
          <>
            <FanCurveChart points={curve} tempRange={ranges.fanCurveTempC} pctRange={ranges.fanCurvePct} />
            <div className="mt-2 grid grid-cols-5 gap-1 text-center">
              {curve.map((p, i) => (
                <div
                  key={i}
                  className="rounded-md border border-line bg-black/20 py-1"
                  title={`${rangeTitle(`Point ${i + 1} temperature`, ranges.fanCurveTempC, "°C")}\n${rangeTitle(`Point ${i + 1} speed`, ranges.fanCurvePct, "%")}`}
                >
                  <div className="num text-[11.5px] text-slate-200">{p.tempC}°</div>
                  <div className="num text-[11px] text-slate-500">{p.pct}%</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {current.zeroRpm ? "Zero RPM is on: the fans may stop below the first point." : "Read-only view of the curve set in the driver."}
            </p>
          </>
        ) : (
          <div className="py-8">
            <Unavailable reason="unsupported" />
          </div>
        )}
      </GlassCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProbeCard({ runProbe, disabled }: { runProbe: () => Promise<TuningProbeSummary>; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TuningProbeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runProbe());
    } catch (e) {
      setResult(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (path: string) => {
    try {
      await api.openExternal(folderOf(path));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <GlassCard title="Read-only probe" icon={FileSearch}>
      <div className="flex flex-col gap-3">
        <p className="max-w-[760px] text-[12px] leading-snug text-slate-400">{PROBE_EXPLAIN}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="teal"
            icon={FileSearch}
            loading={busy}
            disabled={disabled}
            title={disabled ? "Hardware agent offline" : undefined}
            onClick={() => void run()}
          >
            {PROBE_BUTTON}
          </Button>
          {busy && <span className="text-[11.5px] text-muted">Reading the driver tables (up to 15 s)…</span>}
        </div>
        {result && (
          <div
            role="status"
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-[12px]",
              result.ok ? "border-line bg-white/[0.025] text-slate-200" : "border-crit/45 bg-crit/[0.07] text-rose-300",
            )}
          >
            <span className="min-w-0 flex-1 break-all">
              {result.ok && result.path ? `Saved the probe report to ${result.path}.` : result.message}
            </span>
            {result.ok && result.path && (
              <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void openFolder(result.path ?? "")}>
                Open folder
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-rose-400">
            {error}
          </p>
        )}
      </div>
    </GlassCard>
  );
}
