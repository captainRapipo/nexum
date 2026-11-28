import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, HardDrive, Server, X } from "lucide-react";
import type { DiskTelemetry, DriveHealth, PhysicalDisk } from "../../types";
import { Button, IconButton, Meter, StatCells, StatusIcon, STATUS_CLASS, type StatusTone } from "../ui";
import { toast } from "../feedback/Toast";
import { useTightMode } from "../../hooks/useTightMode";
import { useDriveHistory } from "../../hooks/useDriveHistory";
import { driveHealthView } from "../../lib/status";
import { normSerial } from "../../lib/disks";
import { fmtForecast } from "../../lib/alerts";
import { cn, fmtBytes, fmtClock, fmtCount, maskSerial, toTempUnit } from "../../lib/format";
import { copyText } from "../system/clipboard";
import { isHdd } from "./diskMatch";
import { healthWord, lifeMeterTone, lifePct, needsAttention } from "./driveHealth";
import WearHistory, { spanText } from "./WearHistory";

export interface SmartDrawerProps {
  tele: DiskTelemetry | null;
  disk: PhysicalDisk | null;
  health: DriveHealth;
  tempUnit: "C" | "F";
  /** Timestamp of the telemetry packet the values come from (the "Read HH:MM:SS" meta). */
  readTs?: number | null;
  onClose: () => void;
}

const SOURCE_TEXT: Record<DriveHealth["source"], string> = {
  nvme: "NVMe health log",
  smart: "ATA attributes",
  none: "No S.M.A.R.T. data",
};

const DASH = "—";
const fin = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

function tempText(c: number, unit: "C" | "F"): string {
  return `${toTempUnit(c, unit).toFixed(0)} °${unit}`;
}

function tbText(n: number): string {
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} TB`;
}

function minutesText(n: number): string {
  if (n >= 120) return `${fmtCount(Math.round(n / 60))} h ${Math.round(n % 60)} min`;
  return `${fmtCount(n)} min`;
}

interface SmartRow {
  /** Attribute number as the drive's log orders it (hex), for orientation only. */
  id: string;
  name: string;
  /** null = the drive does not report it. */
  value: string | null;
  threshold: string | null;
  /** Row state; null = a counter with no limit, so no icon. Always shown as icon + hover text. */
  status: Extract<StatusTone, "ok" | "warn" | "crit"> | null;
  /** The rule behind `status`. */
  rule?: string;
}

/**
 * The health log as rows. Each status mirrors a trigger of the drive classifier (CONTRACT §1.1.3)
 * or a limit the drive itself reports; the drive's overall state still comes only from
 * `DiskTelemetry.health`.
 */
function smartRows(t: DiskTelemetry, source: DriveHealth["source"], unit: "C" | "F"): SmartRow[] {
  const rows: SmartRow[] = [];
  const count = (n: number | null | undefined) => (fin(n) ? fmtCount(n) : null);

  if (source !== "smart" || t.criticalWarning != null) {
    const cw = t.criticalWarning;
    rows.push({
      id: "01",
      name: "Critical warning",
      value: cw == null ? null : cw === 0 ? "None" : `0x${cw.toString(16).toUpperCase().padStart(2, "0")}`,
      threshold: null,
      status: cw == null ? null : cw === 0 ? "ok" : (cw & 0x1d) !== 0 ? "crit" : "warn",
      rule: "Any warning bit set by the drive needs attention.",
    });
  }

  const warnC = t.warningTempC;
  const critC = t.criticalTempC;
  const limits = fin(warnC) && fin(critC) ? `${toTempUnit(warnC, unit).toFixed(0)} / ${tempText(critC, unit)}` : fin(warnC) ? tempText(warnC, unit) : fin(critC) ? tempText(critC, unit) : null;
  rows.push({
    id: source === "smart" ? "C2" : "02",
    name: source === "smart" ? "Temperature" : "Composite temperature",
    value: fin(t.tempC) ? tempText(t.tempC, unit) : null,
    threshold: limits,
    status: !fin(t.tempC) || limits == null ? null : fin(critC) && t.tempC >= critC ? "crit" : fin(warnC) && t.tempC >= warnC ? "warn" : "ok",
    rule: "Compared with the warning and critical temperatures the drive reports.",
  });

  if (source !== "smart" || t.availableSparePct != null) {
    const sp = t.availableSparePct;
    const th = t.availableSpareThresholdPct;
    rows.push({
      id: "03",
      name: "Available spare",
      value: fin(sp) ? `${fmtCount(sp)} %` : null,
      threshold: fin(th) ? `≥ ${fmtCount(th)} %` : null,
      status: !fin(sp) || !fin(th) || th <= 0 ? null : sp < th ? "crit" : "ok",
      rule: "Failing when the spare falls below the drive's own threshold.",
    });
  }

  if (source !== "smart" || t.percentageUsed != null) {
    const pu = t.percentageUsed;
    rows.push({
      id: "05",
      name: "Percentage used",
      value: fin(pu) ? `${fmtCount(pu)} %` : null,
      threshold: "100 %",
      status: !fin(pu) ? null : pu >= 90 ? "crit" : pu >= 50 ? "warn" : "ok",
      rule: "Worn from 50% of the rated write endurance, replace soon from 90%.",
    });
  }

  if (source === "smart" || t.reallocatedSectors != null || t.pendingSectors != null || t.uncorrectableSectors != null) {
    const sector = (id: string, name: string, n: number | null): SmartRow => ({
      id,
      name,
      value: count(n),
      threshold: "0",
      status: !fin(n) ? null : n > 0 ? "warn" : "ok",
      rule: "Any sector counted here needs attention.",
    });
    rows.push(sector("05", "Reallocated sectors", t.reallocatedSectors));
    rows.push(sector("C5", "Pending sectors", t.pendingSectors));
    rows.push(sector("C6", "Uncorrectable sectors", t.uncorrectableSectors));
  }

  const nv = source !== "smart";
  rows.push({ id: nv ? "06" : "F2", name: "Data read", value: fin(t.dataReadTb) ? tbText(t.dataReadTb) : null, threshold: null, status: null });
  rows.push({ id: nv ? "07" : "F1", name: "Data written", value: fin(t.tbw) ? tbText(t.tbw) : null, threshold: null, status: null });
  rows.push({ id: nv ? "0B" : "0C", name: "Power cycles", value: count(t.powerCycles), threshold: null, status: null });
  rows.push({ id: nv ? "0C" : "09", name: "Power-on hours", value: count(t.powerOnHours), threshold: null, status: null });

  if (nv || t.unsafeShutdowns != null) {
    rows.push({ id: "0D", name: "Unsafe shutdowns", value: count(t.unsafeShutdowns), threshold: null, status: null });
  }
  if (nv || t.mediaErrors != null) {
    rows.push({
      id: "0E",
      name: "Media and data integrity errors",
      value: count(t.mediaErrors),
      threshold: "0",
      status: !fin(t.mediaErrors) ? null : t.mediaErrors > 0 ? "warn" : "ok",
      rule: "Any media error needs attention.",
    });
  }
  if (nv || t.errorLogEntries != null) {
    rows.push({
      id: "0F",
      name: "Error log entries",
      value: count(t.errorLogEntries),
      threshold: null,
      status: t.errorLogEntries === 0 ? "ok" : null,
      rule: "No entries in the drive's error log.",
    });
  }
  if (nv || t.warningTempMinutes != null) {
    rows.push({
      id: "10",
      name: "Warning temperature time",
      value: fin(t.warningTempMinutes) ? minutesText(t.warningTempMinutes) : null,
      threshold: null,
      status: t.warningTempMinutes === 0 ? "ok" : null,
      rule: "Never above its warning temperature.",
    });
  }
  if (nv || t.criticalTempMinutes != null) {
    rows.push({
      id: "11",
      name: "Critical temperature time",
      value: fin(t.criticalTempMinutes) ? minutesText(t.criticalTempMinutes) : null,
      threshold: null,
      status: !fin(t.criticalTempMinutes) ? null : t.criticalTempMinutes > 0 ? "warn" : "ok",
      rule: "Time spent above the critical temperature needs attention.",
    });
  }
  return rows;
}

const STATUS_WORD: Record<NonNullable<SmartRow["status"]>, string> = { ok: "OK", warn: "Attention", crit: "Critical" };

function isoStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Plain text of the details. The serial is masked and the PC name is never included (CONTRACT §0 privacy). */
function buildSmartText(a: {
  name: string;
  tele: DiskTelemetry;
  disk: PhysicalDisk | null;
  health: DriveHealth;
  rows: SmartRow[];
  forecast: string | null;
  readTs: number | null;
}): string {
  const line = (k: string, v: string) => `${k.padEnd(20)}${v}`;
  const serial = normSerial(a.disk?.serial) ?? normSerial(a.tele.serial);
  const out = [
    `S.M.A.R.T. details: ${a.name}`,
    line("Source", SOURCE_TEXT[a.health.source]),
    ...(a.disk ? [line("Size", fmtBytes(a.disk.sizeBytes, 0))] : []),
    ...(a.disk && a.disk.volumes.length > 0 ? [line("Volumes", a.disk.volumes.join(" "))] : []),
    ...(serial ? [line("Serial", maskSerial(serial))] : []),
    line("Health", `${a.health.label}${a.health.reason ? ` (${a.health.reason})` : ""}`),
    line("Windows reports", a.disk?.healthStatus ?? DASH),
    ...(a.forecast ? [line("Wear forecast", a.forecast)] : []),
    ...(a.readTs ? [line("Read", isoStamp(a.readTs))] : []),
    "",
    `${"ID".padEnd(4)}${"Attribute".padEnd(34)}${"Value".padEnd(14)}${"Threshold".padEnd(14)}Status`,
    ...a.rows.map(
      (r) =>
        `${r.id.padEnd(4)}${r.name.padEnd(34)}${(r.value ?? "Not reported").padEnd(14)}${(r.threshold ?? DASH).padEnd(14)}${r.status ? STATUS_WORD[r.status] : ""}`.trimEnd(),
    ),
  ];
  return out.join("\n") + "\n";
}

/** Top edge of the page area: the docked inspector starts below the toolbar and any app banner. */
function useMainTop(active: boolean): number {
  const [top, setTop] = useState(52);
  useLayoutEffect(() => {
    if (!active) return;
    const main = document.getElementById("nexum-main") ?? document.querySelector("main");
    if (!main) return;
    const update = () => setTop(Math.max(0, Math.round(main.getBoundingClientRect().top)));
    update();
    window.addEventListener("resize", update);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(main);
    return () => {
      window.removeEventListener("resize", update);
      ro?.disconnect();
    };
  }, [active]);
  return top;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const HERO_TONE: Record<StatusTone, string> = {
  ok: "border-hairline bg-inset",
  unknown: "border-unknown-border bg-unknown-bg",
  info: "border-hairline bg-inset",
  warn: "border-warn-border bg-warn-bg",
  crit: "border-crit-border bg-crit-bg",
};

/**
 * S.M.A.R.T. details of one drive (CONTRACT §4.10.3, SPEC §19): a floating sheet over a
 * whole-window scrim in regular mode, a docked 380 px inspector without scrim in tight mode.
 * Content: life hero with the wear forecast, the health log, the wear history.
 */
export default function SmartDrawer({ tele, disk, health, tempUnit, readTs = null, onClose }: SmartDrawerProps) {
  const tight = useTightMode();
  const top = useMainTop(tight);
  const panelRef = useRef<HTMLElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const serial = tele?.serial && tele.serial.trim() ? tele.serial : null;
  const wear = useDriveHistory(serial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The sheet is modal: move focus into it and give it back on close. The docked inspector is not.
  useEffect(() => {
    if (tight) return;
    const before = document.activeElement as HTMLElement | null;
    (doneRef.current ?? closeRef.current)?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, [tight]);

  if (typeof document === "undefined") return null;

  const view = driveHealthView(health);
  const name = disk?.model?.trim() || tele?.name || "Drive";
  const life = lifePct(tele);
  const rows = tele ? smartRows(tele, health.source, tempUnit) : [];
  const forecast = serial && wear.history ? fmtForecast(wear.history.forecast) : null;
  const span = wear.history ? spanText(wear.history.points) : null;
  const rawSerial = normSerial(disk?.serial) ?? normSerial(tele?.serial);
  const maskedSerial = rawSerial ? maskSerial(rawSerial) : null;
  const meta = [
    "S.M.A.R.T.",
    SOURCE_TEXT[health.source],
    disk ? fmtBytes(disk.sizeBytes, 0) : null,
    disk && disk.volumes.length > 0 ? disk.volumes.join(" ") : null,
    maskedSerial ? `SN ${maskedSerial}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const Icon = isHdd(disk, tele?.id) ? Server : HardDrive;
  const tone = STATUS_CLASS[view.tone];
  const advice = needsAttention(health) ? "Back up important files and plan a replacement." : null;
  const heroTitle = health.state === "unknown" ? health.label : life != null ? `${healthWord(health)} · ${life}% life left` : healthWord(health);
  // The reason often starts with the same "44% life left" the title carries: keep only what it adds.
  const heroDetail =
    life != null && health.reason
      ? health.reason
          .split(" · ")
          .filter((part) => part.trim().toLowerCase() !== `${life}% life left`)
          .join(" · ")
          .replace(/^./, (c) => c.toUpperCase())
      : health.reason;

  const doCopy = async () => {
    if (!tele) return;
    try {
      await copyText(buildSmartText({ name, tele, disk, health, rows, forecast, readTs }));
      toast("S.M.A.R.T. details copied as text", "ok");
    } catch {
      toast("Could not copy to the clipboard", "warn");
    }
  };

  const trapTab = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (tight || e.key !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const th = "h-[26px] border-b border-hairline text-left text-[11px] font-semibold text-ink-2 first:pl-1.5 last:pr-1.5";
  const td = cn("overflow-hidden text-ellipsis whitespace-nowrap border-b border-divider first:pl-1.5 last:pr-1.5", tight ? "h-[23px]" : "h-[25px]");

  const body: ReactNode = (
    <>
      <div className={cn("rounded-lg border", tight ? "px-3 py-2.5" : "px-4 py-3.5", HERO_TONE[view.tone])} title={`${view.label}. ${health.reason}`}>
        <div className="flex min-w-0 items-center gap-4">
          <div className={cn("tnum shrink-0 font-semibold leading-none tracking-[-0.03em] text-ink", tight ? "text-[28px]" : "text-[34px]")}>
            {life != null ? (
              <>
                {life}
                <small className="ml-0.5 text-[15px] font-medium tracking-normal text-ink-2">%</small>
              </>
            ) : (
              <span className="text-ink-3">{DASH}</span>
            )}
          </div>
          <div className="min-w-0">
            <div className={cn("flex min-w-0 items-center gap-1.5 text-headline", tone.text)}>
              <StatusIcon tone={view.tone} size={15} />
              <span className="min-w-0 truncate">{heroTitle}</span>
            </div>
            {heroDetail && (!tight || life == null) && <div className="mt-1 text-callout text-ink-2">{heroDetail}</div>}
          </div>
        </div>
        {life != null && (
          <div className="mt-3">
            <Meter value={life} tone={lifeMeterTone(view.tone)} height={5} className="bg-fill/[0.07]!" label="Life left" />
          </div>
        )}
        {(forecast || advice) && (
          <div className="mt-2 text-callout text-ink">
            {forecast ? `${forecast.endsWith(".") ? forecast : `${forecast}.`} ` : ""}
            {advice}
          </div>
        )}
      </div>

      <SectionLabel meta={readTs ? `Read ${fmtClock(readTs)}` : undefined}>Health log</SectionLabel>
      {rows.length === 0 ? (
        <p className="text-callout text-ink-2">This drive does not report S.M.A.R.T. data.</p>
      ) : (
        <table className="tnum mt-1 w-full table-fixed border-collapse text-[12.5px] leading-none">
          <caption className="sr-only">Health log of {name}</caption>
          <colgroup>
            <col className={tight ? "w-[26px]" : "w-[30px]"} />
            <col />
            <col className={tight ? "w-[64px]" : "w-[76px]"} />
            <col className={tight ? "w-[74px]" : "w-[86px]"} />
            <col className="w-[26px]" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={th}>ID</th>
              <th scope="col" className={th}>Attribute</th>
              <th scope="col" className={cn(th, "text-right")}>Value</th>
              <th scope="col" className={cn(th, "text-right")}>Threshold</th>
              <th scope="col" className={th}>
                <span className="sr-only">Status</span>
              </th>
            </tr>
          </thead>
          <tbody className="[&>tr:nth-child(even)>td]:bg-row-alt">
            {rows.map((r) => (
              <tr key={`${r.id}-${r.name}`}>
                <td className={cn(td, "font-mono text-[11px] text-ink-3")}>{r.id}</td>
                <td className={cn(td, "text-ink")} title={r.name}>
                  {r.name}
                </td>
                <td
                  className={cn(
                    td,
                    "text-right",
                    r.value == null ? "text-ink-3" : r.status === "warn" ? "font-semibold text-warn" : r.status === "crit" ? "font-semibold text-crit" : "text-ink",
                  )}
                  title={r.value == null ? "Not reported by this drive" : undefined}
                >
                  {r.value ?? DASH}
                </td>
                <td className={cn(td, "text-right text-ink-3")}>{r.threshold ?? DASH}</td>
                <td className={cn(td, "pl-1")}>
                  {r.status && r.value != null && (
                    <span role="img" aria-label={STATUS_WORD[r.status]} title={`${STATUS_WORD[r.status]}. ${r.rule ?? ""}`} className="block">
                      <StatusIcon tone={r.status} size={14} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tele && (tele.tempC != null || tele.tempMinC != null || tele.tempMaxC != null) && (
        <div
          className={cn(
            "tnum mt-2.5 grid items-center gap-x-2 rounded-lg bg-inset px-2.5 py-1.5 text-[12.5px]",
            tight ? "grid-cols-[minmax(0,1fr)_repeat(4,46px)]" : "grid-cols-[minmax(0,1fr)_repeat(4,58px)]",
          )}
          title="Min and max since Nexum started. Average is in the Sensors view."
        >
          <span className="row-span-2 text-callout text-ink-2">{tight ? "Temperature" : "Temperature this session"}</span>
          {["Now", "Min", "Max", "Avg"].map((h) => (
            <span key={h} className="text-right text-caption text-ink-3">
              {h}
            </span>
          ))}
          <StatCells
            value={tele.tempC ?? null}
            min={tele.tempMinC ?? null}
            max={tele.tempMaxC ?? null}
            avg={null}
            meta={{ unit: "°C", decimals: 0, kind: "temperature" }}
            tempUnit={tempUnit}
          />
        </div>
      )}

      {serial && (
        <>
          <SectionLabel meta={span ?? undefined}>Wear history</SectionLabel>
          <WearHistory history={wear.history} loading={wear.loading} error={wear.error} reload={wear.reload} compact={tight} />
        </>
      )}
    </>
  );

  const header = (
    <div className={cn("flex shrink-0 items-start gap-3 border-b border-divider", tight ? "px-4 pb-3 pt-3.5" : "px-5 pb-3.5 pt-[18px]")}>
      <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-inset text-icon-2 shadow-[inset_0_0_0_0.5px_var(--color-hairline)]">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[16px] font-semibold leading-[21px] tracking-[-0.01em] text-ink" title={name}>
          {name}
        </h2>
        <p className="mt-0.5 truncate text-callout text-ink-2" title={meta}>
          {meta}
        </p>
      </div>
      <IconButton ref={closeRef} icon={X} label="Close" onClick={onClose} className="-mr-1.5 -mt-1" />
    </div>
  );

  const footer = (
    <div className={cn("flex shrink-0 items-center gap-2.5 border-t border-divider bg-toolbar", tight ? "px-4 py-2.5" : "px-5 py-3")}>
      <Button icon={Copy} onClick={() => void doCopy()} disabled={!tele} title="Copy these details as plain text. The serial number is masked.">
        Copy as text
      </Button>
      <span className="flex-1" />
      <span
        className="truncate text-callout text-ink-2"
        title="Windows' own drive status, shown for information. Nexum's health state comes from the drive's S.M.A.R.T. data."
      >
        Windows reports: {disk?.healthStatus ?? DASH}
      </span>
      {!tight && (
        <Button ref={doneRef} variant="primary" onClick={onClose} className="min-w-[64px]">
          Done
        </Button>
      )}
    </div>
  );

  if (tight) {
    return createPortal(
      <aside
        ref={panelRef}
        aria-label={`S.M.A.R.T. details for ${name}`}
        style={{ top }}
        className="fixed bottom-0 right-0 z-30 flex w-(--inspector-w) flex-col border-l border-hairline bg-card animate-fade-in"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3">{body}</div>
        {footer}
      </aside>,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-scrim animate-fade-in" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`S.M.A.R.T. details for ${name}`}
        onKeyDown={trapTab}
        className="absolute right-3 top-3 flex max-h-[calc(100vh-24px)] w-(--sheet-w) max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-sheet bg-card shadow-sheet animate-dialog-in"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-[18px] pt-4">{body}</div>
        {footer}
      </aside>
    </div>,
    document.body,
  );
}

function SectionLabel({ children, meta }: { children: string; meta?: string }) {
  return (
    <div className="mb-1 mt-4 flex items-baseline justify-between gap-3">
      <h3 className="text-headline text-ink">{children}</h3>
      {meta && <span className="tnum text-callout text-ink-3">{meta}</span>}
    </div>
  );
}
