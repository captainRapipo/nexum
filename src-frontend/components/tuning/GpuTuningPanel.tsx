import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileSearch, FolderOpen, Info, Loader2, RefreshCw } from "lucide-react";
import type { GpuTelemetry, TuningProbeSummary, TuningRange, TuningState } from "../../types";
import { useTuningState } from "../../hooks/useTuningState";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useSettings } from "../../hooks/useSettings";
import { api, errorMessage } from "../../lib/api";
import { onRescanRequest } from "../../lib/nav";
import { cn, fmtClock, toTempUnit } from "../../lib/format";
import GlassCard from "../layout/GlassCard";
import { Button, KeyValueRow, StatusIcon, Tag, Unavailable, UNAVAILABLE_TEXT } from "../ui";
import FanCurveChart from "./FanCurveChart";
import {
  CHANGE_ELSEWHERE_NOTE,
  MODE_RULE,
  MODE_TEXT,
  PANEL_HEADER,
  PANEL_HEADER_BODY,
  PANEL_HEADER_LEAD,
  PROBE_BUTTON,
  PROBE_EXPLAIN,
  fmtRange,
  fmtValue,
  folderOf,
  rangeTitle,
  unavailableFor,
} from "./tuningText";

/** Slot in the Cooling tabs row that receives "Read at … / Refresh" (see CoolingView). */
const TAB_ACTIONS_ID = "nx-cooling-tab-actions";

/**
 * Cooling → GPU tuning tab (CONTRACT §4.10.1, §1.7, §2.14). READ-ONLY: this panel has no control
 * that changes a value: no sliders, no inputs, no Apply. The only action is the read-only probe.
 * Mounted only while the tab is selected; `useTuningState(true)` polls every 5 s while mounted.
 */
export default function GpuTuningPanel() {
  const { state, loading, error, refresh, runProbe } = useTuningState(true);
  const { agent, latest } = useTelemetry();
  const [refreshing, setRefreshing] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(TAB_ACTIONS_ID));
  }, []);

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

  const sensorsUp = !!agent?.running;

  let content: ReactNode;
  if (state == null) {
    if (loading) {
      content = (
        <GlassCard>
          <div className="flex items-center gap-2 py-8 text-body text-ink-2">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Reading GPU tuning data…
          </div>
        </GlassCard>
      );
    } else if (!sensorsUp) {
      content = (
        <GlassCard>
          <div className="py-8 text-center text-callout text-ink-3">{UNAVAILABLE_TEXT.agentOffline}</div>
        </GlassCard>
      );
    } else {
      content = (
        <GlassCard>
          <div className="flex flex-col items-start gap-3 py-6">
            <p className="text-body text-ink">{error ? `Could not read GPU tuning data: ${error}` : "No GPU tuning data yet."}</p>
            <Button size="sm" icon={RefreshCw} loading={refreshing} onClick={() => void doRefresh()}>
              Try again
            </Button>
          </div>
        </GlassCard>
      );
    }
  } else if (!state.supported) {
    content = <UnsupportedState state={state} />;
  } else {
    content = <SupportedState state={state} gpu={pickGpu(latest?.gpus ?? [], latest?.gpu ?? null, state.adapterName)} />;
  }

  const actions = (
    <>
      {state && <span className="tnum whitespace-nowrap text-callout text-ink-2">Read at {fmtClock(state.ts)}</span>}
      <Button
        size="sm"
        icon={<RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />}
        onClick={() => void doRefresh()}
        disabled={refreshing}
        title="Read the values again (F5)"
      >
        Refresh
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-(--grid-gap)">
      {slot ? createPortal(actions, slot) : <div className="flex items-center justify-end gap-3.5">{actions}</div>}

      <div role="note" aria-label={PANEL_HEADER} className="flex items-center gap-3 rounded-lg border border-info-border bg-info-bg px-3.5 py-2.5 text-body text-ink">
        <StatusIcon tone="info" size={18} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{PANEL_HEADER_LEAD}</p>
          <p>
            {PANEL_HEADER_BODY}
            {state?.supported ? ` ${CHANGE_ELSEWHERE_NOTE}` : ""}
          </p>
        </div>
      </div>

      {error && state != null && (
        <p role="alert" className="flex items-center gap-1.5 text-callout text-crit">
          <StatusIcon tone="crit" size={13} />
          Could not refresh: {error}
        </p>
      )}

      {content}

      {!(state?.supported ?? false) && <ProbeCard runProbe={runProbe} disabled={!sensorsUp} />}
      {state?.supported && <NowAndProbe state={state} gpu={pickGpu(latest?.gpus ?? [], latest?.gpu ?? null, state.adapterName)} runProbe={runProbe} disabled={!sensorsUp} />}
    </div>
  );
}

/** The live telemetry entry of the adapter the tuning data belongs to. */
function pickGpu(gpus: readonly GpuTelemetry[], primary: GpuTelemetry | null, adapterName: string | null): GpuTelemetry | null {
  const name = (adapterName ?? "").trim().toLowerCase();
  if (name) {
    const hit = gpus.find((g) => g.name.trim().toLowerCase() === name) ?? gpus.find((g) => g.name.toLowerCase().includes(name) || name.includes(g.name.toLowerCase()));
    if (hit) return hit;
  }
  return gpus.find((g) => g.vendor === "amd") ?? primary;
}

/* ------------------------------------------------------------------ */

function UnsupportedState({ state }: { state: TuningState }) {
  return (
    <GlassCard title="GPU tuning">
      <div className="flex flex-col gap-2 pb-1">
        <Unavailable reason={unavailableFor(state.reason)} />
        <p className="text-body text-ink">{state.message}</p>
        {state.adapterName && <p className="text-callout text-ink-2">Adapter: {state.adapterName}</p>}
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

const TH = "h-[26px] border-b border-hairline text-[11px] font-semibold text-ink-2";
const TD = "h-[31px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-divider group-last:border-b-0";

function NumberRows({ rows }: { rows: RowSpec[] }) {
  return (
    <table className="tnum w-full table-fixed border-collapse text-[13px] leading-none">
      <caption className="sr-only">GPU tuning values, read-only</caption>
      <colgroup>
        <col />
        <col className="w-[130px]" />
        <col className="w-[170px]" />
        <col className="w-[100px]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={cn(TH, "text-left")}>Setting</th>
          <th scope="col" className={cn(TH, "text-right")}>Current</th>
          <th scope="col" className={cn(TH, "text-right")}>Range</th>
          <th scope="col" className={cn(TH, "text-right")}>Default</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const title = rangeTitle(r.label, r.range, r.unit, r.signed);
          const changed = r.cap && r.current != null && r.range?.default != null && r.current !== r.range.default;
          return (
            <tr key={r.label} className="group" title={r.cap ? title : undefined}>
              <th scope="row" className={cn(TD, "text-left font-normal text-ink")}>
                {r.label}
              </th>
              {r.cap ? (
                <>
                  <td className={cn(TD, "text-right font-semibold text-ink")}>
                    {changed && (
                      <Tag title="Differs from the default (changed in AMD Software)." className="mr-2 align-middle">
                        Changed
                      </Tag>
                    )}
                    {fmtValue(r.current, r.unit, r.signed)}
                  </td>
                  <td className={cn(TD, "text-right text-ink-2")}>{fmtRange(r.range, r.unit, r.signed)}</td>
                  <td className={cn(TD, "text-right text-ink-2")}>{r.range?.default == null ? "—" : fmtValue(r.range.default, r.unit, r.signed)}</td>
                </>
              ) : (
                <td colSpan={3} className={cn(TD, "text-right")}>
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

function SupportedState({ state }: { state: TuningState; gpu: GpuTelemetry | null }) {
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
    <div className="grid grid-cols-12 gap-(--grid-gap)">
      <GlassCard
        title={state.adapterName ?? "AMD Radeon GPU"}
        className="col-span-7"
        actions={<Tag title={MODE_RULE}>{MODE_TEXT[state.mode]}</Tag>}
      >
        <NumberRows rows={rows} />
        <div className="mt-2.5 grid grid-cols-2 gap-x-7">
          <KeyValueRow
            label="Auto Undervolt"
            value={caps.autoUndervolt ? onOff(current.autoUndervolt) : <Unavailable reason="unsupported" compact />}
          />
          <KeyValueRow label="Zero RPM" value={caps.zeroRpm ? onOff(current.zeroRpm) : <Unavailable reason="unsupported" compact />} />
          <KeyValueRow
            label="Power mode"
            hint={
              <span className="text-ink-3" title="Raw driver value; AMD does not document its meaning.">
                (raw)
              </span>
            }
            value={state.powerMode ?? "—"}
          />
          <KeyValueRow
            label="VPU recoveries since boot"
            value={state.vpuRecoveryCount == null ? "—" : String(state.vpuRecoveryCount)}
          />
          <KeyValueRow label="Overdrive version" value={state.odVersion == null ? "—" : `OD${state.odVersion}`} />
        </div>
      </GlassCard>

      <GlassCard title="GPU fan curve" actions="Temperature → fan speed" className="col-span-5" bodyClassName="flex flex-col">
        {curve && curve.length > 0 ? (
          <>
            <FanCurveChart points={curve} tempRange={ranges.fanCurveTempC} pctRange={ranges.fanCurvePct} />
            <div className="tnum mt-3 grid grid-cols-5 gap-2">
              {curve.map((p, i) => (
                <div
                  key={i}
                  className="rounded-lg bg-inset py-2 text-center text-[13px] font-semibold leading-[17px] text-ink"
                  title={`${rangeTitle(`Point ${i + 1} temperature`, ranges.fanCurveTempC, "°C")}\n${rangeTitle(`Point ${i + 1} speed`, ranges.fanCurvePct, "%")}`}
                >
                  {p.tempC} °C
                  <span className="block text-callout font-normal text-ink-2">{p.pct}%</span>
                </div>
              ))}
            </div>
            <p className="mt-2.5 flex items-center gap-2 text-callout text-ink-2">
              <Info size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
              {current.zeroRpm ? "Zero RPM is on: the fan may stop below the first point." : "Read-only view of the curve set in the driver."}
            </p>
          </>
        ) : (
          <div className="py-6">
            <Unavailable reason="unsupported" />
          </div>
        )}
      </GlassCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NowCell({ label, value, unit }: { label: string; value: string | null; unit: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px] border-l border-divider px-4 [&:nth-child(3n+1)]:border-l-0 [&:nth-child(3n+1)]:pl-0">
      <span className="text-caption font-medium text-ink-2">{label}</span>
      {value != null ? (
        <b className="tnum text-[20px] font-semibold leading-6 tracking-[-0.015em] text-ink">
          {value}
          <small className="ml-[3px] text-[12px] font-medium tracking-normal text-ink-3">{unit}</small>
        </b>
      ) : (
        <span className="flex h-6 items-center text-body">
          <Unavailable reason="unsupported" compact />
        </span>
      )}
    </div>
  );
}

/** "Now" (live readings of the same adapter, from telemetry) beside the probe card. */
function NowAndProbe({
  gpu,
  runProbe,
  disabled,
}: {
  state: TuningState;
  gpu: GpuTelemetry | null;
  runProbe: () => Promise<TuningProbeSummary>;
  disabled: boolean;
}) {
  const { settings } = useSettings();
  const unit = settings?.tempUnit ?? "C";
  const n = (v: number | null | undefined, digits = 0) =>
    typeof v === "number" && Number.isFinite(v) ? (digits === 0 ? Math.round(v).toLocaleString("en-US") : v.toFixed(digits)) : null;
  const t = (c: number | null | undefined, digits: number) => (typeof c === "number" && Number.isFinite(c) ? toTempUnit(c, unit).toFixed(digits) : null);
  return (
    <div className="grid grid-cols-12 gap-(--grid-gap)">
      <GlassCard title="Now" actions="Live readings of this card" className="col-span-7">
        {gpu ? (
          <div className="grid grid-cols-3 gap-y-3.5">
            <NowCell label="GPU clock" value={n(gpu.coreClockMhz)} unit="MHz" />
            <NowCell label="Memory clock" value={n(gpu.memClockMhz)} unit="MHz" />
            <NowCell label="Board power" value={n(gpu.powerW)} unit="W" />
            <NowCell label="Edge temp" value={t(gpu.tempC, 0)} unit={`°${unit}`} />
            <NowCell label="Hot spot" value={t(gpu.hotspotTempC, 1)} unit={`°${unit}`} />
            <NowCell label="Memory junction" value={t(gpu.memJunctionTempC, 1)} unit={`°${unit}`} />
          </div>
        ) : (
          <div className="py-2 text-body">
            <Unavailable reason={disabled ? "agentOffline" : "unsupported"} />
          </div>
        )}
      </GlassCard>
      <ProbeCard runProbe={runProbe} disabled={disabled} className="col-span-5" />
    </div>
  );
}

function ProbeCard({ runProbe, disabled, className }: { runProbe: () => Promise<TuningProbeSummary>; disabled: boolean; className?: string }) {
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

  const failed = error ?? (result && !result.ok ? result.message : null);

  return (
    <GlassCard title="Read-only probe" className={className} bodyClassName="flex flex-col">
      <p className="mb-3.5 text-body text-ink-2">{PROBE_EXPLAIN}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button icon={FileSearch} loading={busy} disabled={disabled} title={disabled ? UNAVAILABLE_TEXT.agentOffline : undefined} onClick={() => void run()}>
          {PROBE_BUTTON}
        </Button>
        {busy && <span className="text-callout text-ink-2">Reading the driver tables (up to 15 s)…</span>}
      </div>
      {failed && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-callout text-crit">
          <StatusIcon tone="crit" size={13} className="mt-0.5" />
          <span className="min-w-0 break-words">{failed}</span>
        </p>
      )}
      {result?.ok && result.path && (
        <p role="status" className="mt-3 break-all text-callout text-ink">
          Saved the probe report to <span className="font-mono text-[11.5px]">{result.path}</span>.
        </p>
      )}
      <div className="mt-auto pt-3.5">
        <div className="flex min-h-7 items-center justify-between gap-3 border-t border-divider pt-2 text-body">
        <span className="text-ink-2">Last probe</span>
        {result?.ok && result.path ? (
          <Button size="sm" variant="plain" icon={FolderOpen} onClick={() => void openFolder(result.path ?? "")}>
            Open folder
          </Button>
        ) : (
          <span className="tnum font-medium text-ink">{result ? `Ran at ${fmtClock(result.ranTs)}` : "None this session"}</span>
        )}
        </div>
      </div>
    </GlassCard>
  );
}
