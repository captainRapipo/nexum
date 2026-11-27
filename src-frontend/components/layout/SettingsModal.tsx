import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bell,
  Cpu,
  Eraser,
  ExternalLink,
  Gamepad2,
  Info,
  Power,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  Thermometer,
} from "lucide-react";
import {
  CPU_DEFAULT_LIMIT_C,
  DEFAULT_ALERT_SETTINGS,
  GPU_HOTSPOT_CRIT_DEFAULT_C,
  GPU_MEM_JUNCTION_CRIT_DEFAULT_C,
  RECYCLE_AGE_OPTIONS,
  SENSOR_LOG_INTERVALS_MS,
  type AlertSettings,
  type CpuLimitInfo,
  type Settings,
} from "../../types";
import { api, errorMessage, isTauri, PAWNIO_URL } from "../../lib/api";
import { cn, fmtRelative } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useHealthAlerts } from "../../hooks/useHealthAlerts";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { Button } from "../ui/Button";
import { DottedLeaderRow } from "../ui/DottedLeaderRow";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { StatusPill } from "../ui/StatusPill";
import { Toggle } from "../ui/Toggle";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const POLL_OPTIONS = [
  { value: 500, label: "500 ms" },
  { value: 1000, label: "1000 ms" },
  { value: 2000, label: "2000 ms" },
  { value: 5000, label: "5000 ms" },
] as const;

const UNIT_OPTIONS = [
  { value: "C" as const, label: "°C" },
  { value: "F" as const, label: "°F" },
];

/** [NEW 1.1] CSV log interval (CONTRACT §2.9): 1 / 2 / 5 / 10 s. */
const LOG_INTERVAL_OPTIONS = SENSOR_LOG_INTERVALS_MS.map((ms) => ({ value: ms, label: `${ms / 1000} s` }));

/** [NEW 1.1] Recycle Bin age (CONTRACT §3.2). Segmented needs a primitive value: -1 stands for null ("All"). */
const RECYCLE_ALL = -1;
const RECYCLE_OPTIONS = RECYCLE_AGE_OPTIONS.map((d) => ({
  value: d ?? RECYCLE_ALL,
  label: d == null ? "All" : d === 1 ? "1 day" : `${d} days`,
  title: d == null ? "Every item in the Recycle Bin" : `Only items deleted more than ${d === 1 ? "1 day" : `${d} days`} ago`,
}));

/** Fields edited in this dialog. Only these are saved, so labels / pins changed elsewhere are never overwritten. */
const SETTING_KEYS = [
  "launchOnStartup",
  "minimizeToTray",
  "pollIntervalMs",
  "includeBrowserCaches",
  "confirmBeforePurge",
  "tempUnit",
  "startMinimized",
  "hideUnusedSensors",
  "fpsCaptureEnabled",
  "sensorLogIntervalMs",
  "recycleMinAgeDays",
  "alerts",
] as const satisfies ReadonlyArray<keyof Settings>;

const DRIVER_CHOICE_TEXT: Record<Settings["sensorDriverChoice"], string> = {
  undecided: "Not chosen yet",
  pawnio: "Use PawnIO",
  none: "No kernel driver",
};

/** Frame-capture consent text (same facts as the Gaming view's opt-in card, CONTRACT §4.10.1). */
const FPS_CONSENT =
  "Nexum can measure frame rate and frame times with Intel PresentMon, which reads Windows performance events (ETW). Nothing is injected into games and no game files or processes are touched.";
const FPS_JAVELIN = "Start Nexum before launching games that use EA Javelin anti-cheat: frame capture must already be running when they start.";
const FPS_UNTESTED = "Compatibility with individual games' anti-cheat has not been tested yet. Off by default.";

/** Alert threshold bounds (CONTRACT §2.2 AlertSettings). */
const ALERT_BOUNDS = {
  cpuTempC: { min: 60, max: 105 },
  gpuHotspotC: { min: 70, max: 115 },
  gpuMemJunctionC: { min: 70, max: 115 },
  freeSpacePct: { min: 1, max: 50 },
  sustainSec: { min: 10, max: 600 },
} as const;

function clampInt(v: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, v)));
}

/** Same rules as Rust's sanitization: every member on its own, malformed → its default. */
function sanitizeAlerts(a: Partial<AlertSettings> | null | undefined): AlertSettings {
  const d = DEFAULT_ALERT_SETTINGS;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const nullable = (v: unknown, b: { min: number; max: number }) => (num(v) ? clampInt(v, b.min, b.max) : null);
  return {
    desktopNotifications: typeof a?.desktopNotifications === "boolean" ? a.desktopNotifications : d.desktopNotifications,
    cpuTempC: nullable(a?.cpuTempC, ALERT_BOUNDS.cpuTempC),
    gpuHotspotC: nullable(a?.gpuHotspotC, ALERT_BOUNDS.gpuHotspotC),
    gpuMemJunctionC: nullable(a?.gpuMemJunctionC, ALERT_BOUNDS.gpuMemJunctionC),
    freeSpacePct: num(a?.freeSpacePct) ? clampInt(a.freeSpacePct, 1, 50) : d.freeSpacePct,
    sustainSec: num(a?.sustainSec) ? clampInt(a.sustainSec, 10, 600) : d.sustainSec,
  };
}

const sameAlerts = (a: AlertSettings | undefined, b: AlertSettings | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function cpuLimitText(info: CpuLimitInfo, override: number | null): string {
  if (override != null) return `Your limit: ${override} °C (attention from ${override - 5} °C).`;
  if (info.source === "table")
    return `${info.model ? `Ryzen ${info.model}` : "This CPU"}: ${info.limitC} °C, AMD's maximum operating temperature (attention from ${info.warnC} °C).`;
  if (info.source === "user") return `Limit for this CPU: ${info.limitC} °C (your setting).`;
  return `This CPU model is not in Nexum's table; using a conservative ${CPU_DEFAULT_LIMIT_C} °C limit.`;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-white/[0.015] px-4 py-3">
      <h3 className="mb-2 flex items-center gap-2">
        <span className="text-teal">{icon}</span>
        <span className="label-caps">{title}</span>
      </h3>
      <div className="divide-y divide-white/[0.05] [&>*]:py-2.5 [&>*:first-child]:pt-1 [&>*:last-child]:pb-1">{children}</div>
    </section>
  );
}

function FieldRow({ label, description, children }: { label: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[13px] text-slate-200">{label}</div>
        {description && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  description?: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  unit: string;
  /** Nullable fields: empty input = automatic, shown as this placeholder. */
  autoPlaceholder?: string;
}

/** Integer setting with a unit; out-of-range values are clamped when the field loses focus. */
function NumberField({ label, description, value, onChange, min, max, unit, autoPlaceholder }: NumberFieldProps) {
  const id = useId();
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const nullable = autoPlaceholder != null;

  const commit = (raw: string) => {
    const t = raw.trim();
    if (t === "") {
      if (nullable) onChange(null);
      else setText(value == null ? "" : String(value));
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setText(value == null ? "" : String(value));
      return;
    }
    const c = clampInt(n, min, max);
    setText(String(c));
    onChange(c);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] text-slate-200">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          placeholder={autoPlaceholder}
          title={`${min} to ${max} ${unit}${nullable ? ". Leave empty for the automatic value." : ""}`}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          }}
          className="num h-7 w-[84px] rounded-md border border-line bg-canvas-0/70 px-2 text-right text-[12.5px] text-ink outline-none transition placeholder:text-muted/70 focus:border-teal/50 focus:shadow-[0_0_0_3px_rgba(45,212,191,0.12)]"
        />
        <span className="w-6 text-[11.5px] text-muted">{unit}</span>
      </div>
    </div>
  );
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { settings, update } = useSettings();
  const { agent, latest } = useTelemetry();
  const { snapshot: alertSnapshot } = useHealthAlerts();
  // Only tick while visible; the closed dialog stays mounted for its exit animation.
  const now = useNow(open ? 1000 : 3_600_000);

  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState<string>(__NEXUM_VERSION__);

  // Fresh draft each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setSaveError(null);
    setRestartMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on open
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAppVersion()
      .then((v) => {
        if (!cancelled && v) setVersion(v);
      })
      .catch(() => {
        // keep build-time version
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(
    () => SETTING_KEYS.some((k) => (k === "alerts" ? !sameAlerts(draft.alerts, settings.alerts) : draft[k] !== settings[k])),
    [draft, settings],
  );

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const alerts = draft.alerts ?? DEFAULT_ALERT_SETTINGS;
  const setAlert = <K extends keyof AlertSettings>(key: K, value: AlertSettings[K]) =>
    setDraft((d) => ({ ...d, alerts: { ...(d.alerts ?? DEFAULT_ALERT_SETTINGS), [key]: value } }));

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const patch: Partial<Settings> = {};
      for (const k of SETTING_KEYS) (patch as Record<string, unknown>)[k] = draft[k];
      patch.alerts = sanitizeAlerts(draft.alerts);
      await update(patch);
      onClose();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    setRestartMsg(null);
    try {
      await api.restartAgent();
      setRestartMsg({ ok: true, text: "Restart requested. The agent reconnects in a few seconds." });
    } catch (err) {
      setRestartMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setRestarting(false);
    }
  };

  const handleElevate = async () => {
    try {
      await api.restartAsAdmin();
    } catch (err) {
      setRestartMsg({ ok: false, text: errorMessage(err) });
    }
  };

  const lastPacketTs = latest?.ts ?? agent?.lastPacketTs ?? null;
  const agentTone = agent == null ? "unknown" : agent.running ? "ok" : "warn";
  const agentLabel = agent == null ? "Unknown" : agent.running ? "Running" : "Stopped";
  const driver = agent?.sensorDriver ?? null;
  const driverText =
    driver == null
      ? "—"
      : driver.kind === "none"
        ? "Not installed"
        : `PawnIO ${driver.version ?? "(version unknown)"}${agent?.limitedReasons.includes("pawnIoOutdated") ? ` · needs ${driver.minVersion} or newer` : ""}`;

  const spaceCrit = Math.max(1, Math.floor((alerts.freeSpacePct ?? DEFAULT_ALERT_SETTINGS.freeSpacePct) / 2));
  const hsCrit = alerts.gpuHotspotC ?? GPU_HOTSPOT_CRIT_DEFAULT_C;
  const mjCrit = alerts.gpuMemJunctionC ?? GPU_MEM_JUNCTION_CRIT_DEFAULT_C;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      subtitle="Startup, telemetry, alerts, frame capture and cache cleanup preferences"
      icon={SettingsIcon}
      size="xl"
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-[12px]">
            {saveError ? (
              <span className="text-rose-400" role="alert">
                {saveError}
              </span>
            ) : dirty ? (
              <span className="text-warn">Unsaved changes</span>
            ) : (
              <span className="text-muted">All changes saved</span>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="teal" icon={Save} onClick={() => void handleSave()} loading={saving} disabled={!dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-3">
          <Section icon={<Power size={14} aria-hidden="true" />} title="Startup & Tray">
            <Toggle
              label="Launch Nexum on Windows startup"
              description="Task Scheduler entry with highest privileges, so no UAC prompt at boot."
              checked={draft.launchOnStartup}
              onChange={(v) => set("launchOnStartup", v)}
            />
            <Toggle
              label="Start minimized"
              description="Open straight to the system tray."
              checked={draft.startMinimized}
              onChange={(v) => set("startMinimized", v)}
            />
            <Toggle
              label="Minimize to system tray"
              description="Keep monitoring in the background when the window is closed. The tray tooltip shows your pinned sensors."
              checked={draft.minimizeToTray}
              onChange={(v) => set("minimizeToTray", v)}
            />
          </Section>

          <Section icon={<Thermometer size={14} aria-hidden="true" />} title="Telemetry">
            <div>
              <div className="text-[13px] text-slate-200">Poll interval</div>
              <p className="mb-2 mt-0.5 text-[11.5px] leading-snug text-muted">How often the hardware agent samples sensors.</p>
              <Segmented
                ariaLabel="Poll interval"
                size="sm"
                value={draft.pollIntervalMs}
                options={POLL_OPTIONS}
                onChange={(v) => set("pollIntervalMs", v)}
                className="w-full justify-between [&>button]:flex-1"
              />
            </div>
            <FieldRow label="Temperature unit">
              <Segmented
                ariaLabel="Temperature unit"
                size="sm"
                value={draft.tempUnit}
                options={UNIT_OPTIONS}
                onChange={(v) => set("tempUnit", v)}
              />
            </FieldRow>
            <Toggle
              label="Hide unused sensors"
              description="Sensors view: hide sensors with no reading, and fans or voltages that never reported a value."
              checked={draft.hideUnusedSensors}
              onChange={(v) => set("hideUnusedSensors", v)}
            />
            <FieldRow
              label="Sensor log interval"
              description="One CSV row per interval, saved to Documents\Nexum\Logs. Start a log from the Sensors view or the tray menu."
            >
              <Segmented
                ariaLabel="Sensor log interval"
                size="sm"
                value={draft.sensorLogIntervalMs}
                options={LOG_INTERVAL_OPTIONS}
                onChange={(v) => set("sensorLogIntervalMs", v)}
              />
            </FieldRow>
          </Section>

          <Section icon={<Bell size={14} aria-hidden="true" />} title="Alerts & notifications">
            <Toggle
              label="Windows notifications"
              description="Notify when an alert starts or becomes critical while Nexum is in the background. At most one per alert every 30 minutes. Off by default."
              checked={alerts.desktopNotifications}
              onChange={(v) => setAlert("desktopNotifications", v)}
            />
            <NumberField
              label="CPU temperature limit"
              description={cpuLimitText(alertSnapshot.cpuLimit, alerts.cpuTempC)}
              value={alerts.cpuTempC}
              onChange={(v) => setAlert("cpuTempC", v)}
              min={ALERT_BOUNDS.cpuTempC.min}
              max={ALERT_BOUNDS.cpuTempC.max}
              unit="°C"
              autoPlaceholder={alertSnapshot.cpuLimit.source === "user" ? "Auto" : `Auto (${alertSnapshot.cpuLimit.limitC})`}
            />
            <NumberField
              label="GPU hot spot, critical"
              description={`Attention from ${hsCrit - 10} °C. Edge sensor only: attention 85 °C, critical 95 °C.`}
              value={alerts.gpuHotspotC}
              onChange={(v) => setAlert("gpuHotspotC", v)}
              min={ALERT_BOUNDS.gpuHotspotC.min}
              max={ALERT_BOUNDS.gpuHotspotC.max}
              unit="°C"
              autoPlaceholder={`Auto (${GPU_HOTSPOT_CRIT_DEFAULT_C})`}
            />
            <NumberField
              label="GPU memory, critical"
              description={`Memory junction temperature. Attention from ${mjCrit - 10} °C.`}
              value={alerts.gpuMemJunctionC}
              onChange={(v) => setAlert("gpuMemJunctionC", v)}
              min={ALERT_BOUNDS.gpuMemJunctionC.min}
              max={ALERT_BOUNDS.gpuMemJunctionC.max}
              unit="°C"
              autoPlaceholder={`Auto (${GPU_MEM_JUNCTION_CRIT_DEFAULT_C})`}
            />
            <NumberField
              label="Low free space"
              description={`Attention below this share of a fixed drive; critical below ${spaceCrit}%.`}
              value={alerts.freeSpacePct}
              onChange={(v) => setAlert("freeSpacePct", v ?? DEFAULT_ALERT_SETTINGS.freeSpacePct)}
              min={ALERT_BOUNDS.freeSpacePct.min}
              max={ALERT_BOUNDS.freeSpacePct.max}
              unit="%"
            />
            <NumberField
              label="Sustained for"
              description="A temperature must stay at or above its threshold this long before an alert starts."
              value={alerts.sustainSec}
              onChange={(v) => setAlert("sustainSec", v ?? DEFAULT_ALERT_SETTINGS.sustainSec)}
              min={ALERT_BOUNDS.sustainSec.min}
              max={ALERT_BOUNDS.sustainSec.max}
              unit="s"
            />
            <p className="text-[11.5px] leading-snug text-muted">
              Drive wear alerts follow the drive's own health report and have no threshold to set. Temperatures here are in °C.
            </p>
          </Section>
        </div>

        <div className="flex flex-col gap-3">
          <Section icon={<Gamepad2 size={14} aria-hidden="true" />} title="Frame capture">
            <Toggle
              label="Measure frame rate in games"
              description={FPS_CONSENT}
              checked={draft.fpsCaptureEnabled}
              onChange={(v) => set("fpsCaptureEnabled", v)}
            />
            <div className="space-y-1.5 text-[11.5px] leading-snug text-muted">
              <p>{FPS_JAVELIN}</p>
              <p>{FPS_UNTESTED}</p>
            </div>
          </Section>

          <Section icon={<Eraser size={14} aria-hidden="true" />} title="Cache cleanup">
            <Toggle
              label="List browser and Discord caches"
              description="Chrome, Edge, Firefox and Discord caches. Logins, cookies and history are kept. F9 never cleans them without asking."
              checked={draft.includeBrowserCaches}
              onChange={(v) => set("includeBrowserCaches", v)}
            />
            <Toggle
              label="Confirm before cleaning"
              description="When off, F9 cleans temporary files, the Windows Update cache and error reports right away."
              checked={draft.confirmBeforePurge}
              onChange={(v) => set("confirmBeforePurge", v)}
            />
            <div>
              <div className="text-[13px] text-slate-200">Recycle Bin items to clean</div>
              <p className="mb-2 mt-0.5 text-[11.5px] leading-snug text-muted">
                Like Windows Storage Sense: keep recently deleted items. The Recycle Bin is never cleaned unless you select it.
              </p>
              <Segmented
                ariaLabel="Recycle Bin age"
                size="sm"
                value={draft.recycleMinAgeDays ?? RECYCLE_ALL}
                options={RECYCLE_OPTIONS}
                onChange={(v) => set("recycleMinAgeDays", v === RECYCLE_ALL ? null : v)}
                className="w-full justify-between [&>button]:flex-1"
              />
            </div>
          </Section>

          <Section icon={<Activity size={14} aria-hidden="true" />} title="Sensor driver">
            <div>
              <DottedLeaderRow label="Installed" value={driverText} />
              <DottedLeaderRow label="Your choice" value={DRIVER_CHOICE_TEXT[settings.sensorDriverChoice] ?? "—"} />
              <p className="mt-1.5 text-[11.5px] leading-snug text-muted">
                PawnIO is a signed kernel driver from its own website. It gives Nexum CPU, motherboard and fan sensors. Nexum
                never installs or removes it.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" icon={ExternalLink} onClick={() => void api.openExternal(PAWNIO_URL)}>
                  Get PawnIO
                </Button>
                {settings.sensorDriverChoice !== "undecided" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Show the sensor driver choice again the next time it applies"
                    onClick={() => void update({ sensorDriverChoice: "undecided" }).catch(() => undefined)}
                  >
                    Ask me again
                  </Button>
                )}
              </div>
            </div>
          </Section>

          <Section icon={<Cpu size={14} aria-hidden="true" />} title="Hardware Agent">
            <div className="flex items-center justify-between gap-3">
              <StatusPill tone={agentTone} pulse={agent?.running} title={agent?.message}>
                {agentLabel}
              </StatusPill>
              <Button variant="teal" size="sm" icon={RotateCcw} onClick={() => void handleRestart()} loading={restarting}>
                Restart agent
              </Button>
            </div>
            <div>
              <DottedLeaderRow
                label="Privileges"
                value={agent == null ? "—" : agent.isAdmin ? "Administrator" : "Not elevated"}
                valueClassName={agent && !agent.isAdmin ? "text-warn" : undefined}
              />
              <DottedLeaderRow label="Last packet" value={lastPacketTs ? fmtRelative(lastPacketTs, now) : "—"} />
              {agent?.protocol != null && <DottedLeaderRow label="Agent protocol" value={String(agent.protocol)} />}
              {agent?.message && <p className="mt-1.5 break-words font-mono text-[10.5px] leading-relaxed text-slate-500">{agent.message}</p>}
              {agent && !agent.isAdmin && (
                <div className="mt-2">
                  <Button variant="ghost" size="sm" icon={ShieldCheck} onClick={() => void handleElevate()}>
                    Restart as administrator
                  </Button>
                </div>
              )}
              {restartMsg && (
                <p className={cn("mt-1.5 text-[11.5px]", restartMsg.ok ? "text-teal" : "text-rose-400")} role="status">
                  {restartMsg.text}
                </p>
              )}
            </div>
          </Section>

          <Section icon={<Info size={14} aria-hidden="true" />} title="About">
            <div>
              <DottedLeaderRow label="Nexum version" value={`v${version}`} valueClassName="text-teal" />
              <DottedLeaderRow label="Runtime" value={isTauri ? "Native (Tauri)" : "Browser preview"} />
              <DottedLeaderRow label="Build" value={import.meta.env.DEV ? "Development" : "Release"} />
            </div>
          </Section>
        </div>
      </div>
    </Modal>
  );
}

export default SettingsModal;
