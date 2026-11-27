import { useEffect, useState } from "react";
import { Activity, Cpu, Crosshair, Gamepad2, ListX } from "lucide-react";
import { FPS_WINDOW_OPTIONS } from "../types";
import { useFrames } from "../hooks/useFrames";
import { useSettings } from "../hooks/useSettings";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { errorMessage } from "../lib/api";
import { onRescanRequest } from "../lib/nav";
import GlassCard from "../components/layout/GlassCard";
import { Segmented } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import FrameCaptureOptIn, { AntiCheatNote } from "../components/gaming/FrameCaptureOptIn";
import FrameSessionBar from "../components/gaming/FrameSessionBar";
import FpsHero from "../components/gaming/FpsHero";
import FrametimeChart, { FRAMETIME_CHART_MAX_POINTS } from "../components/gaming/FrametimeChart";
import BusyBars from "../components/gaming/BusyBars";
import PresentInfo from "../components/gaming/PresentInfo";
import TargetPicker from "../components/gaming/TargetPicker";
import ExcludesEditor from "../components/gaming/ExcludesEditor";
import { KNOWN_LIMITS, NO_TARGET_TEXT } from "../components/gaming/gamingText";

const WINDOW_OPTIONS = FPS_WINDOW_OPTIONS.map((n) => ({ value: n, label: `${n} s`, title: `Statistics over the last ${n} seconds` }));

/**
 * Gaming (F8): frame rate and frame times of the running game, measured by the agent with Intel's
 * signed PresentMon over ETW (CONTRACT §1.6, §4.10.1). Opt-in; all data comes through useFrames().
 */
export default function GamingView() {
  const frames = useFrames();
  const { enabled, session, target, stats, statsFresh, frametimes, setEnabled, setTarget, setWindow, setExcludes, listPresenting } =
    frames;
  const { settings } = useSettings();
  const { agent } = useTelemetry();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [windowBusy, setWindowBusy] = useState(false);

  // F5 on Gaming refreshes the presenting list (CONTRACT §4.6).
  useEffect(() => onRescanRequest("gaming", () => setRefreshSignal((n) => n + 1)), []);

  const running = session?.state === "running";
  const hasTarget = target != null && target.reason !== "none" && target.pid != null;
  const liveStats = hasTarget && statsFresh && stats != null && stats.pid === target.pid ? stats : null;
  const waitingText = hasTarget ? `Waiting for frames from ${target.process ?? `PID ${target.pid}`}…` : "Waiting for frames…";

  const changeWindow = async (sec: number) => {
    if (windowBusy || sec === settings.fpsWindowSec) return;
    setWindowBusy(true);
    try {
      await setWindow(sec);
    } catch (e) {
      toast(`Could not change the window: ${errorMessage(e)}`, "crit");
    } finally {
      setWindowBusy(false);
    }
  };

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Gaming</h1>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Frame rate and frame times of the running game, read from Windows performance events by Intel PresentMon.
        </p>
      </div>
      {enabled && (
        <div className="flex items-center gap-2">
          <span className="label-caps">Window</span>
          <Segmented
            size="sm"
            ariaLabel="Statistics window"
            value={settings.fpsWindowSec}
            options={WINDOW_OPTIONS}
            onChange={(v) => void changeWindow(v)}
            disabled={windowBusy}
          />
        </div>
      )}
    </div>
  );

  if (!enabled) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <FrameCaptureOptIn setEnabled={setEnabled} />
      </div>
    );
  }

  const picker = (
    <TargetPicker
      target={target}
      listPresenting={listPresenting}
      setTarget={setTarget}
      refreshSignal={refreshSignal}
      running={running}
    />
  );

  const excludesCard = (
    <GlassCard title="Ignored apps" icon={ListX}>
      <ExcludesEditor excludes={settings.fpsExcludes} setExcludes={setExcludes} />
    </GlassCard>
  );

  const targetLabel = hasTarget
    ? `${target.process ?? `PID ${target.pid}`}${target.windowTitle ? ` · ${target.windowTitle}` : ""}`
    : null;
  const chartFrames = Math.min(frametimes.length, FRAMETIME_CHART_MAX_POINTS);

  return (
    <div className="flex flex-col gap-4">
      {header}
      <FrameSessionBar session={session} setEnabled={setEnabled} agentRunning={!!agent?.running} />

      {hasTarget ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <GlassCard
              title="Frame rate"
              icon={Gamepad2}
              accent="teal"
              actions={
                <span className="num max-w-[360px] truncate text-[11.5px] text-slate-400" title={targetLabel ?? undefined}>
                  {targetLabel}
                </span>
              }
            >
              <FpsHero stats={liveStats} waitingText={waitingText} />
            </GlassCard>
            <GlassCard
              title="Frame times"
              icon={Activity}
              actions={
                <span className="num text-[11px] text-slate-500">
                  {chartFrames > 0 ? `${chartFrames.toLocaleString("en-US")} frames` : ""}
                </span>
              }
            >
              <FrametimeChart frametimes={frametimes} className="h-[300px]" />
              <p className="mt-1 text-[11px] text-slate-500">
                Lower is smoother. Spikes above a dashed line are frames slower than that refresh rate.
              </p>
            </GlassCard>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <GlassCard title="Target" icon={Crosshair}>
              <div className="flex flex-col gap-4">
                {picker}
                <PresentInfo target={target} stats={liveStats} />
              </div>
            </GlassCard>
            <GlassCard title="CPU busy vs GPU busy" icon={Cpu}>
              <BusyBars stats={liveStats} />
            </GlassCard>
            {excludesCard}
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <GlassCard title="Target" icon={Crosshair} accent="teal">
            <div className="flex max-w-[560px] flex-col gap-4 py-2">
              <div className="flex items-start gap-3">
                <Gamepad2 size={22} className="mt-0.5 shrink-0 text-slate-500" aria-hidden="true" />
                <p className="text-[13px] leading-relaxed text-slate-300">
                  {running || session?.state === "starting" ? NO_TARGET_TEXT : "Frame capture is not running yet."}
                </p>
              </div>
              {picker}
            </div>
          </GlassCard>
          <div className="flex min-w-0 flex-col gap-4">
            {excludesCard}
            <AntiCheatNote />
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-500">{KNOWN_LIMITS}</p>
    </div>
  );
}
