import { ChevronRight, HardDrive, Server } from "lucide-react";
import type { AgentStatus, DiskTelemetry, DriveHealth, PhysicalDisk } from "../../types";
import { Meter, StatusPill, Unavailable } from "../ui";
import { driveHealthView, resolveUnavailable } from "../../lib/status";
import { cn, fmtBytes, fmtCount, fmtTemp } from "../../lib/format";
import { isHdd, mediaLabels } from "./diskMatch";
import { healthWord, lifeMeterTone, lifePct } from "./driveHealth";

export interface DriveEntry {
  key: string;
  /** Windows physical disk; null for a sensor-only drive that matched no PhysicalDisk. */
  disk: PhysicalDisk | null;
  tele: DiskTelemetry | null;
  /** Classifier result (DiskTelemetry.health, or the unmatched "unknown" health). */
  health: DriveHealth;
}

export interface DriveTableProps {
  entries: readonly DriveEntry[];
  /** Volume label per drive letter ("F:" → "Games"), for the line under the model. */
  volumeLabels: ReadonlyMap<string, string>;
  tempUnit: "C" | "F";
  agent: AgentStatus | null;
  /** DiskTelemetry.id of the drive whose details are open (neutral selected row). */
  selectedId: string | null;
  onOpen: (teleId: string) => void;
  /** Tight mode: the Power-on and Written columns are hidden and the life meter is shorter. */
  tight?: boolean;
}

function fmtTb(tb: number | null | undefined): string | null {
  if (tb == null || !Number.isFinite(tb)) return null;
  return `${tb >= 100 ? tb.toFixed(0) : tb.toFixed(1)} TB`;
}

const TH = "h-7 whitespace-nowrap border-b border-hairline px-2.5 text-left text-[11px] font-semibold text-ink-2 first:pl-3 last:pr-3";
const TD = "whitespace-nowrap border-b border-divider px-2.5 first:pl-3 last:pr-3 group-last:border-b-0";

/**
 * The "Physical drives" table (CONTRACT §4.10.3, SPEC §7): one row per drive so wear compares down
 * one column. The health chip, its tone and the meter tone all come from the drive classifier
 * (`DiskTelemetry.health`) through `driveHealthView`; Windows' own status is shown only in the
 * details. A row opens the S.M.A.R.T. details of its drive.
 */
export default function DriveTable({ entries, volumeLabels, tempUnit, agent, selectedId, onOpen, tight = false }: DriveTableProps) {
  const smartReason = resolveUnavailable(agent, "admin");
  return (
    <table className="tnum w-full border-collapse text-[13px] leading-none">
      <caption className="sr-only">Physical drives with remaining life, temperature and health</caption>
      <thead>
        <tr>
          <th scope="col" className={TH}>Drive</th>
          <th scope="col" className={TH}>Life left</th>
          <th scope="col" className={cn(TH, "text-right")}>Temp</th>
          {!tight && <th scope="col" className={cn(TH, "text-right")}>Power-on</th>}
          {!tight && <th scope="col" className={cn(TH, "text-right")}>Written</th>}
          <th scope="col" className={TH}>Health</th>
          <th scope="col" className={cn(TH, "w-9")}>
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <DriveRow
            key={e.key}
            entry={e}
            volumeLabels={volumeLabels}
            tempUnit={tempUnit}
            smartReason={smartReason}
            selected={e.tele != null && e.tele.id === selectedId}
            onOpen={onOpen}
            tight={tight}
          />
        ))}
      </tbody>
    </table>
  );
}

function DriveRow({
  entry,
  volumeLabels,
  tempUnit,
  smartReason,
  selected,
  onOpen,
  tight,
}: {
  entry: DriveEntry;
  volumeLabels: ReadonlyMap<string, string>;
  tempUnit: "C" | "F";
  smartReason: ReturnType<typeof resolveUnavailable>;
  selected: boolean;
  onOpen: (teleId: string) => void;
  tight: boolean;
}) {
  const { disk, tele, health } = entry;
  const name = disk?.model?.trim() || tele?.name || "Unknown drive";
  const view = driveHealthView(health);
  const life = lifePct(tele);
  const letters = disk?.volumes ?? [];
  const role = disk?.isSystemDisk
    ? "System"
    : letters.map((l) => volumeLabels.get(l.trim().toUpperCase()) ?? "").filter(Boolean).join(", ");
  const meta = [
    ...mediaLabels(disk, tele?.name),
    disk ? fmtBytes(disk.sizeBytes, 0) : null,
    letters.length > 0 ? letters.join(" ") : null,
    role || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = isHdd(disk, tele?.id) ? Server : HardDrive;
  const open = tele ? () => onOpen(tele.id) : undefined;
  const written = fmtTb(tele?.tbw);
  const cell = cn(TD, tight ? "h-12" : "h-[52px]", selected && "bg-selected first:rounded-l-lg last:rounded-r-lg");

  return (
    <tr
      className={cn("group", open && "hover:[&>td]:bg-hover", selected && "hover:[&>td]:bg-selected")}
      onClick={open}
    >
      <td className={cell}>
        <div className="flex min-w-0 items-center gap-[11px]">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]">
            <Icon size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <b className="block truncate font-medium leading-[18px] text-ink" title={name}>
              {name}
            </b>
            <span className="block truncate text-callout text-ink-2">{meta || "No details reported"}</span>
          </div>
        </div>
      </td>
      <td className={cell}>
        {life != null ? (
          <div className="flex items-center gap-2.5" title={`Remaining rated life. ${view.label}: ${health.reason}`}>
            <div className={cn("shrink-0", tight ? "w-16" : "w-[110px]")}>
              <Meter value={life} tone={lifeMeterTone(view.tone)} height={5} label={`${name} life left`} />
            </div>
            <b className="min-w-[34px] text-right font-semibold text-ink">{life}%</b>
          </div>
        ) : !tele || health.source === "none" ? (
          <Unavailable compact reason={smartReason} />
        ) : (
          <span className="text-ink-2" title="This drive does not report a wear counter.">
            No wear counter
          </span>
        )}
      </td>
      <td className={cn(cell, "text-right text-ink")}>
        {tele?.tempC != null ? fmtTemp(tele.tempC, tempUnit).replace("°", " °") : <Unavailable compact reason={smartReason} />}
      </td>
      {!tight && (
        <td className={cn(cell, "text-right text-ink")}>
          {tele?.powerOnHours != null ? `${fmtCount(tele.powerOnHours)} h` : <Unavailable compact reason={smartReason} />}
        </td>
      )}
      {!tight && (
        <td className={cn(cell, "text-right text-ink")}>
          {written ?? (tele && health.source !== "none" ? <span className="text-ink-3">—</span> : <Unavailable compact reason={smartReason} />)}
        </td>
      )}
      <td className={cell}>
        <StatusPill tone={view.tone} title={`${view.label}. ${health.reason}`}>
          {healthWord(health)}
        </StatusPill>
      </td>
      <td className={cn(cell, "w-9 text-right")}>
        <button
          type="button"
          disabled={!open}
          onClick={(ev) => {
            ev.stopPropagation();
            open?.();
          }}
          title={open ? "S.M.A.R.T. details" : "No S.M.A.R.T. data for this drive"}
          aria-label={open ? `S.M.A.R.T. details for ${name}` : `No S.M.A.R.T. data for ${name}`}
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-ink-3 hover:bg-hover disabled:opacity-40"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}
