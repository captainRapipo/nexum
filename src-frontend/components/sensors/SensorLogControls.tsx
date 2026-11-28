import { useState } from "react";
import { FileText, Square } from "lucide-react";
import { SENSOR_LOG_INTERVALS_MS } from "../../types";
import { errorMessage } from "../../lib/api";
import { fmtCount } from "../../lib/format";
import { useSensorLog } from "../../hooks/useSensorLog";
import { useSettings } from "../../hooks/useSettings";
import { Button, InkLink, Segmented, StatusIcon } from "../ui";
import { toast } from "../feedback/Toast";

/** Rust accepts at most this many explicit ids (CONTRACT §2.9). */
const MAX_LOG_IDS = 500;

const INTERVAL_OPTIONS = SENSOR_LOG_INTERVALS_MS.map((ms) => ({
  value: ms,
  label: `${ms / 1000} s`,
  title: `Write one row every ${ms / 1000} s`,
}));

export interface SensorLogControlsProps {
  /** Sensor ids of the selected rows; empty → the default set (every non-static, non-hidden sensor). */
  selectedIds: readonly string[];
  disabled: boolean;
}

/**
 * "Log to CSV" group of the Sensors filter bar (CONTRACT §4.10.2, §2.9): the interval and the
 * Start log / Stop log button. Rust samples and writes the file; this only starts and stops it. The
 * column set and interval are fixed at start. The running status is shown by `SensorLogStatusLine`.
 */
export function SensorLogControls({ selectedIds, disabled }: SensorLogControlsProps) {
  const { status, start, stop } = useSensorLog();
  const { settings, update } = useSettings();
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);

  const active = status.active;
  const interval = active
    ? status.intervalMs
    : SENSOR_LOG_INTERVALS_MS.includes(settings.sensorLogIntervalMs)
      ? settings.sensorLogIntervalMs
      : SENSOR_LOG_INTERVALS_MS[0];
  const ids = selectedIds.length > 0 ? selectedIds.slice(0, MAX_LOG_IDS) : null;
  const scope = ids
    ? `Logs the ${fmtCount(ids.length)} selected sensor${ids.length === 1 ? "" : "s"}${selectedIds.length > MAX_LOG_IDS ? ` (first ${MAX_LOG_IDS})` : ""}`
    : "Logs every sensor that is not hidden";

  const onInterval = (ms: number) => {
    if (active || ms === settings.sensorLogIntervalMs) return;
    update({ sensorLogIntervalMs: ms }).catch((e: unknown) => toast(`Could not save: ${errorMessage(e)}`, "crit"));
  };

  const onStart = async () => {
    setBusy("start");
    try {
      await start({ intervalMs: interval, ids: ids ? [...ids] : null });
    } catch (e) {
      toast(`Could not start the log: ${errorMessage(e)}`, "warn");
    } finally {
      setBusy(null);
    }
  };

  const onStop = async () => {
    setBusy("stop");
    try {
      await stop();
    } catch (e) {
      toast(`Could not stop the log: ${errorMessage(e)}`, "warn");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="group" aria-label="Log to CSV" className="flex shrink-0 items-center gap-2">
      <span className="text-body text-ink-2 tight:hidden" title="How often a row is written to the CSV file">
        Log every
      </span>
      <Segmented value={interval} options={INTERVAL_OPTIONS} onChange={onInterval} size="sm" ariaLabel="Log interval" disabled={active || disabled} />
      {active ? (
        <Button size="sm" icon={Square} loading={busy === "stop"} onClick={() => void onStop()} title="Stop writing the CSV file">
          Stop log
        </Button>
      ) : (
        <Button
          size="sm"
          icon={FileText}
          loading={busy === "start"}
          disabled={disabled}
          onClick={() => void onStart()}
          title={`Log to CSV. ${scope}. Select rows first to log only those.`}
        >
          Start log
        </Button>
      )}
    </div>
  );
}

/**
 * Status of the CSV log for the Sensors status bar: `Logging <n> sensors · <rows> rows` while it
 * runs, the error that stopped it, or the last file; plus `Open folder`. Renders nothing before the
 * first log of this session.
 */
export function SensorLogStatusLine() {
  const { status, openFolder } = useSensorLog();
  if (!status.active && !status.error && !status.path) return null;

  const onOpenFolder = () => {
    openFolder().catch((e: unknown) => toast(`Could not open the folder: ${errorMessage(e)}`, "warn"));
  };

  return (
    <span className="flex min-w-0 items-center gap-2">
      {status.active ? (
        <span className="flex min-w-0 items-center gap-1.5 text-ink" title={status.path ?? undefined}>
          <span aria-hidden="true" className="size-1.5 shrink-0 animate-led-pulse rounded-full bg-control-on" />
          <span className="truncate tnum">
            Logging {fmtCount(status.sensorCount)} sensors · {fmtCount(status.rows)} rows
          </span>
        </span>
      ) : status.error ? (
        <span className="flex min-w-0 items-center gap-1.5 text-crit" title={status.error}>
          <StatusIcon tone="crit" size={13} />
          <span className="truncate">{status.error}</span>
        </span>
      ) : (
        <span className="min-w-0 truncate tnum" title={status.path ?? undefined}>
          Last log: {fileName(status.path ?? "")} · {fmtCount(status.totalRows)} rows
        </span>
      )}
      {(status.active || status.path) && (
        <InkLink chevron={false} onClick={onOpenFolder} title={`Open ${status.folder}`} className="shrink-0">
          Open folder
        </InkLink>
      )}
    </span>
  );
}

function fileName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export default SensorLogControls;
