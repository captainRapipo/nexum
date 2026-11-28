import { useMemo } from "react";
import { Card, InkLink, Meter, StatusPill } from "../ui";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { useTightMode } from "../../hooks/useTightMode";
import { joinDisks } from "../../lib/disks";
import { driveHealthView } from "../../lib/status";
import { requestNavigate } from "../../lib/nav";
import { clamp, cn, fmtBytes, fmtClock } from "../../lib/format";
import { NOT_AVAILABLE_TEXT, type DiskTelemetry, type DriveHealth, type PhysicalDisk, type Volume } from "../../types";
import { finite } from "./sensorHelpers";

const EMPTY_TEL: DiskTelemetry[] = [];

/** Health used when a physical drive has no telemetry match (CONTRACT §1.1.3 join rule step 3). */
const UNMATCHED_HEALTH: DriveHealth = {
  state: "unknown",
  label: "Health unknown",
  reason: "The drive or its USB bridge does not report S.M.A.R.T. data",
  source: "none",
};

/** "C:" for a letter given as "C", "C:" or "C:\". */
function letterOf(v: string | null | undefined): string {
  const m = /^[A-Za-z]/.exec((v ?? "").trim());
  return m ? `${m[0].toUpperCase()}:` : "";
}

interface Row {
  key: string;
  disk: PhysicalDisk;
  tele: DiskTelemetry | null;
  health: DriveHealth;
  letter: string;
  freeBytes: number | null;
}

/**
 * "Drives" (CONTRACT §4.10.3): one row per physical drive with its letter tile, model, status chip
 * from the drive classifier, a life meter (amber only for a drive that needs attention), "NN% life
 * left" and free space; the footer shows when S.M.A.R.T. was last read and the total free space.
 * Health always comes from `DiskTelemetry.health`: a drive that cannot be read is "Unknown", never good.
 */
export default function DrivesCard({ className }: { className?: string }) {
  const { volumes, disks, info } = useSystemInfo();
  const { latest } = useTelemetry();
  const tight = useTightMode();
  const tele = latest?.disks ?? EMPTY_TEL;

  const rows = useMemo<Row[]>(() => {
    const byLetter = new Map<string, Volume>();
    for (const v of volumes ?? []) byLetter.set(letterOf(v.letter), v);
    return joinDisks(disks ?? [], tele)
      .map(({ disk, tele: t }) => {
        const letters = (disk.volumes ?? []).map(letterOf).filter(Boolean);
        let free: number | null = null;
        for (const l of letters) {
          const v = byLetter.get(l);
          if (v) free = (free ?? 0) + v.freeBytes;
        }
        return { key: `${disk.deviceId}:${disk.serial}`, disk, tele: t, health: t?.health ?? UNMATCHED_HEALTH, letter: letters[0] ?? "", freeBytes: free };
      })
      .sort((a, b) => Number(b.disk.isSystemDisk) - Number(a.disk.isSystemDisk) || Number(a.disk.deviceId) - Number(b.disk.deviceId));
  }, [disks, tele, volumes]);

  const totals = useMemo(() => {
    let free = 0;
    let total = 0;
    for (const v of volumes ?? []) {
      if (v.driveType !== "Fixed" || !(v.totalBytes > 0)) continue;
      free += v.freeBytes;
      total += v.totalBytes;
    }
    return total > 0 ? { free, total } : null;
  }, [volumes]);

  const readAt = latest && tele.length > 0 ? fmtClock(latest.ts, false) : null;
  const isAdmin = info?.isAdmin ?? true;

  return (
    <Card
      title="Drives"
      actions={
        <InkLink onClick={() => requestNavigate("storage")} title="Open Storage (F4)">
          Storage
        </InkLink>
      }
      footer={
        !tight && (readAt || totals) ? (
          <>
            <span className="tnum">{readAt ? `S.M.A.R.T. read ${readAt}` : "S.M.A.R.T. not read"}</span>
            {totals && (
              <span className="tnum">
                <span className="font-medium text-ink">{fmtBytes(totals.free, totals.free >= 1024 ** 4 ? 2 : 1)}</span> free of {fmtBytes(totals.total)}
              </span>
            )}
          </>
        ) : undefined
      }
      className={className}
    >
      {rows.length === 0 ? (
        <p className="text-callout text-ink-3">Reading drives…</p>
      ) : (
        <ul className="-mt-[9px] flex flex-col" aria-label="Physical drives">
          {rows.map((r) => (
            <DriveRow key={r.key} row={r} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One word for the chip: the classifier's label, or "Unknown" when the drive cannot be read. */
function chipText(h: DriveHealth): string {
  return h.state === "unknown" ? "Unknown" : h.label || "Unknown";
}

function DriveRow({ row, isAdmin }: { row: Row; isAdmin: boolean }) {
  const { disk, tele, health, letter, freeBytes } = row;
  const view = driveHealthView(health);
  const life = finite(tele?.healthPct) ? Math.round(clamp(tele!.healthPct!, 0, 100)) : null;
  const model = disk.model?.trim() || tele?.name || "Drive";
  const worn = health.state === "attention" || health.state === "replace" || health.state === "failing";
  const lifeLine =
    life !== null
      ? `${life}% life left`
      : disk.mediaType === "HDD"
        ? "HDD · no wear counter"
        : !isAdmin
          ? "Life not read without administrator"
          : tele
            ? "No wear counter"
            : NOT_AVAILABLE_TEXT;
  const open = () => requestNavigate(tele ? { view: "storage", focus: tele.id } : { view: "storage" });
  return (
    <li className="border-b border-divider last:border-b-0">
      <button
        type="button"
        onClick={open}
        title={`${letter ? `${letter} ` : ""}${model}\n${view.label}${health.reason ? `. ${health.reason}` : ""}\nOpen in Storage`}
        className="focus-inset grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-[3px] py-[9px] text-left tight:py-[7px]"
      >
        <span
          aria-hidden="true"
          className="row-span-3 mt-px flex size-[30px] items-center justify-center self-start rounded-[8px] bg-inset text-[12px] font-semibold leading-none text-ink shadow-[inset_0_0_0_0.5px_var(--color-hairline)]"
        >
          {letter || "—"}
        </span>
        <span className="truncate text-[13px] font-medium leading-[17px] text-ink">{model}</span>
        <StatusPill tone={view.tone}>{chipText(health)}</StatusPill>
        <Meter
          value={life ?? 0}
          height={4}
          tone={worn ? "warn" : undefined}
          className={cn("col-span-2", life === null && "invisible")}
          label={life !== null ? `${model}: ${life}% life left` : undefined}
        />
        <span className="col-span-2 flex justify-between gap-3 whitespace-nowrap text-callout text-ink-2 tnum">
          <span className="truncate">{lifeLine}</span>
          {freeBytes !== null && <span>{fmtBytes(freeBytes)} free</span>}
        </span>
      </button>
    </li>
  );
}
