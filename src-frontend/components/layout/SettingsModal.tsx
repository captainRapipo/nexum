import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Cpu, Info, Power, RotateCcw, Save, Settings as SettingsIcon, Sparkles, Thermometer } from "lucide-react";
import type { Settings } from "../../types";
import { api, errorMessage, isTauri } from "../../lib/api";
import { fmtRelative } from "../../lib/format";
import { useSettings } from "../../hooks/useSettings";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { Button } from "../ui/Button";
import { DottedLeaderRow } from "../ui/DottedLeaderRow";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { StatusPill } from "../ui/StatusPill";
import { Toggle } from "../ui/Toggle";
import { useNow } from "./HeaderStrip";

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

const SETTING_KEYS: Array<keyof Settings> = [
  "launchOnStartup",
  "minimizeToTray",
  "pollIntervalMs",
  "includeBrowserCaches",
  "confirmBeforePurge",
  "flushStandbyOnPurge",
  "tempUnit",
  "startMinimized",
];

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

function FieldRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
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

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { settings, update } = useSettings();
  const { agent, latest } = useTelemetry();
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

  const dirty = useMemo(() => SETTING_KEYS.some((k) => draft[k] !== settings[k]), [draft, settings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await update(draft);
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

  const lastPacketTs = latest?.ts ?? agent?.lastPacketTs ?? null;
  const agentTone = agent == null ? "info" : agent.running ? "ok" : "warn";
  const agentLabel = agent == null ? "Unknown" : agent.running ? "Running" : "Stopped";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="System Settings"
      subtitle="Startup, telemetry and Deep Purge preferences"
      icon={SettingsIcon}
      size="lg"
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-[12px]">
            {saveError ? (
              <span className="text-rose-400" role="alert">
                {saveError}
              </span>
            ) : dirty ? (
              <span className="text-gold/90">Unsaved changes</span>
            ) : (
              <span className="text-muted">All changes saved</span>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="gold" icon={Save} onClick={() => void handleSave()} loading={saving} disabled={!dirty}>
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
              description="Keep monitoring in the background when the window is closed."
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
          </Section>
        </div>

        <div className="flex flex-col gap-3">
          <Section icon={<Sparkles size={14} aria-hidden="true" />} title="Deep Purge">
            <Toggle
              label="Include browser & app caches"
              description="Chrome, Edge, Firefox and Discord caches. Logins and cookies are kept."
              checked={draft.includeBrowserCaches}
              onChange={(v) => set("includeBrowserCaches", v)}
            />
            <Toggle
              label="Confirm before purge"
              description="When off, F9 starts the purge immediately."
              checked={draft.confirmBeforePurge}
              onChange={(v) => set("confirmBeforePurge", v)}
            />
            <Toggle
              label="Flush RAM standby list"
              description="Free cached standby memory after a purge (administrator)."
              checked={draft.flushStandbyOnPurge}
              onChange={(v) => set("flushStandbyOnPurge", v)}
            />
          </Section>

          <Section icon={<Cpu size={14} aria-hidden="true" />} title="Hardware Agent">
            <div className="flex items-center justify-between gap-3">
              <StatusPill tone={agentTone} pulse={agent?.running}>
                {agentLabel}
              </StatusPill>
              <Button
                variant="teal"
                size="sm"
                icon={RotateCcw}
                onClick={() => void handleRestart()}
                loading={restarting}
              >
                Restart Agent
              </Button>
            </div>
            <div>
              <DottedLeaderRow label="Privileges" value={agent == null ? "—" : agent.isAdmin ? "Administrator" : "Limited"} valueClassName={agent && !agent.isAdmin ? "text-gold" : undefined} />
              <DottedLeaderRow label="Last packet" value={lastPacketTs ? fmtRelative(lastPacketTs, now) : "—"} />
              {agent?.message && <p className="mt-1.5 break-words font-mono text-[10.5px] leading-relaxed text-slate-500">{agent.message}</p>}
              {restartMsg && (
                <p className={restartMsg.ok ? "mt-1.5 text-[11.5px] text-teal" : "mt-1.5 text-[11.5px] text-rose-400"} role="status">
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
