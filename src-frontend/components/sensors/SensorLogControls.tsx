import { useState } from "react";
import { FileSpreadsheet, FolderOpen, Square } from "lucide-react";
import { SENSOR_LOG_INTERVALS_MS } from "../../types";
import { errorMessage } from "../../lib/api";
import { cn, fmtCount } from "../../lib/format";
import { useSensorLog } from "../../hooks/useSensorLog";
import { useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { STATUS_CLASS } from "../ui/tones";
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
 * "Log to CSV" control group of the Sensors view (CONTRACT §4.10.2, §2.9). Rust samples and writes the
 * file; this only starts/stops it and shows the status. The column set and interval are fixed at start.
 */
export function SensorLogControls({ selectedIds, disabled }: SensorLogControlsProps) {
  const { status, start, stop, openFolder } = useSensorLog();
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

  const onOpenFolder = () => {
    openFolder().catch((e: unknown) => toast(`Could not open the folder: ${errorMessage(e)}`, "warn"));
  };

  return (
    <div
      role="group"
      aria-label="Log to CSV"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line/70 py-2.5"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        <FileSpreadsheet size={13} aria-hidden="true" className="text-slate-500" />
        Log to CSV
      </span>
      <Segmented
        value={interval}
        options={INTERVAL_OPTIONS}
        onChange={onInterval}
        size="sm"
        ariaLabel="Log interval"
        disabled={active || disabled}
      />
      {active ? (
        <Button
          size="sm"
          variant="ghost"
          icon={Square}
          loading={busy === "stop"}
          onClick={() => void onStop()}
          title="Stop writing the CSV file"
        >
          Stop log
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon={FileSpreadsheet}
          loading={busy === "start"}
          disabled={disabled}
          onClick={() => void onStart()}
          title={`${scope}. Select rows first to log only those.`}
        >
          Start log
        </Button>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-3 text-[11.5px]">
        {active ? (
          <span className="num flex min-w-0 items-center gap-1.5 truncate text-slate-300" title={status.path ?? undefined}>
            <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-teal" />
            <span className="truncate">
              Logging {fmtCount(status.sensorCount)} sensors · {fmtCount(status.rows)} rows
            </span>
          </span>
        ) : status.error ? (
          <span className={cn("min-w-0 truncate", STATUS_CLASS.crit.text)} title={status.error}>
            {status.error}
          </span>
        ) : status.path ? (
          <span className="min-w-0 truncate text-slate-500" title={status.path}>
            Last log: {fileName(status.path)} · {fmtCount(status.totalRows)} rows
          </span>
        ) : (
          <span className="min-w-0 truncate text-slate-500">{scope}.</span>
        )}
        {(active || status.path) && (
          <Button
            size="sm"
            variant="ghost"
            icon={FolderOpen}
            onClick={onOpenFolder}
            title={`Open ${status.folder}`}
            className="shrink-0"
          >
            Open folder
          </Button>
        )}
      </div>
    </div>
  );
}

function fileName(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export default SensorLogControls;
