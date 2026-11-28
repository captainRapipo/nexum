import { useEffect, useState } from "react";
import { Gamepad2, Info } from "lucide-react";
import { FPS_WINDOW_OPTIONS } from "../types";
import { useFrames } from "../hooks/useFrames";
import { useSettings } from "../hooks/useSettings";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { errorMessage } from "../lib/api";
import { fmtFps } from "../lib/frames";
import { onRescanRequest } from "../lib/nav";
import GlassCard from "../components/layout/GlassCard";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import { EmptyState, Segmented } from "../components/ui";
import { toast } from "../components/feedback/Toast";
import FrameCaptureOptIn, { AntiCheatNote } from "../components/gaming/FrameCaptureOptIn";
import FrameSessionBar from "../components/gaming/FrameSessionBar";
import FpsHero from "../components/gaming/FpsHero";
import FrametimeChart, { FRAMETIME_CHART_MAX_POINTS } from "../components/gaming/FrametimeChart";
import BusyBars, { busyScaleText } from "../components/gaming/BusyBars";
import PresentInfo from "../components/gaming/PresentInfo";
import TargetPicker from "../components/gaming/TargetPicker";
import ExcludesEditor from "../components/gaming/ExcludesEditor";
import WhilePlaying, { whilePlayingMeta } from "../components/gaming/WhilePlaying";
import { KNOWN_LIMITS, NO_TARGET_TEXT, OPT_IN_TITLE, PAGE_DESCRIPTION } from "../components/gaming/gamingText";

const WINDOW_OPTIONS = FPS_WINDOW_OPTIONS.map((n) => ({ value: n, label: `${n} s`, title: `Statistics over the last ${n} seconds` }));

/** `No game detected.` + `Start a game, or pick an app below.`: the two sentences of NO_TARGET_TEXT. */
const NO_TARGET_SPLIT = NO_TARGET_TEXT.indexOf(". ") + 1;
const NO_TARGET_TITLE = NO_TARGET_TEXT.slice(0, NO_TARGET_SPLIT - 1);
const NO_TARGET_BODY = NO_TARGET_TEXT.slice(NO_TARGET_SPLIT + 1);

/**
 * Gaming (F8): frame rate and frame times of the running game, measured with Intel's signed
 * PresentMon over ETW (CONTRACT §1.6, §4.10.1, §4.10.3). Opt-in; all data comes through useFrames().
 */
export default function GamingView() {
  const frames = useFrames();
  const { enabled, session, target, stats, statsFresh, frametimes, setEnabled, setTarget, setWindow, setExcludes, listPresenting } =
    frames;
  const { settings } = useSettings();
  const { agent, history } = useTelemetry();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [windowBusy, setWindowBusy] = useState(false);

  // F5 on Gaming refreshes the presenting list (CONTRACT §4.6).
  useEffect(() => onRescanRequest("gaming", () => setRefreshSignal((n) => n + 1)), []);

  const running = session?.state === "running";
  const hasTarget = target != null && target.reason !== "none" && target.pid != null;
  const liveStats = hasTarget && statsFresh && stats != null && stats.pid === target.pid ? stats : null;
  const processName = hasTarget ? (target.process ?? `PID ${target.pid}`) : null;
  const waitingText = processName ? `Waiting for frames from ${processName}…` : "Waiting for frames…";

  usePageChrome({
    subtitle: !enabled
      ? OPT_IN_TITLE
      : processName
        ? liveStats?.fpsAvg != null
          ? `${processName} · ${fmtFps(liveStats.fpsAvg)} fps`
          : processName
        : "No game detected",
  });

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

  if (!enabled) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader view="gaming" description={PAGE_DESCRIPTION} />
        <FrameCaptureOptIn setEnabled={setEnabled} />
      </div>
    );
  }

  const windowControl = (
    <>
      <span id="nx-fps-window-label">Window</span>
      <Segmented
        size="sm"
        ariaLabel="Statistics window"
        value={settings.fpsWindowSec}
        options={WINDOW_OPTIONS}
        onChange={(v) => void changeWindow(v)}
        disabled={windowBusy}
      />
    </>
  );

  const targetCard = (className?: string) => (
    <GlassCard
      title="Target"
      className={className}
      actions={
        <button
          type="button"
          onClick={() => setRefreshSignal((n) => n + 1)}
          disabled={!running}
          title="Read the list of apps again"
          className="rounded-xs text-callout text-ink-2 hover:underline disabled:text-ink-disabled disabled:no-underline"
        >
          Refreshes with F5
        </button>
      }
    >
      <TargetPicker target={target} listPresenting={listPresenting} setTarget={setTarget} refreshSignal={refreshSignal} running={running} />
      <ExcludesEditor
        excludes={settings.fpsExcludes}
        setExcludes={setExcludes}
        className="mt-3 border-t border-divider pt-3 tight:mt-2 tight:pt-2"
      />
    </GlassCard>
  );

  const chartFrames = Math.min(frametimes.length, FRAMETIME_CHART_MAX_POINTS);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader view="gaming" description={PAGE_DESCRIPTION} />
      <div className="flex min-h-0 flex-1 flex-col gap-(--grid-gap)">
        <FrameSessionBar session={session} setEnabled={setEnabled} agentRunning={!!agent?.running} trailing={windowControl} />

        {hasTarget ? (
          <>
            <div className="grid shrink-0 grid-cols-12 gap-(--grid-gap)">
              <GlassCard className="col-span-8" bodyClassName="flex flex-col">
                <FpsHero target={target} stats={liveStats} waitingText={waitingText} frametimes={frametimes} windowSec={settings.fpsWindowSec} />
              </GlassCard>
              {targetCard("col-span-4")}
            </div>

            <div className="grid min-h-[300px] flex-1 grid-cols-12 gap-(--grid-gap)">
              <GlassCard
                className="col-span-8"
                bodyClassName="flex flex-col"
                title={
                  <span className="flex items-center gap-1.5">
                    Frame times
                    <span role="img" tabIndex={0} aria-label={KNOWN_LIMITS} title={KNOWN_LIMITS} className="hidden rounded-xs text-ink-3 tight:inline-flex">
                      <Info size={13} aria-hidden="true" />
                    </span>
                  </span>
                }
                subtitle={
                  chartFrames > 0
                    ? `Last ${chartFrames.toLocaleString("en-US")} frames · lower and flatter is smoother`
                    : "Lower and flatter is smoother"
                }
                actions={<PresentInfo target={target} stats={liveStats} />}
              >
                <FrametimeChart frametimes={frametimes} className="min-h-[180px] flex-1" />
              </GlassCard>

              <div className="col-span-4 flex min-h-0 min-w-0 flex-col gap-(--grid-gap)">
                <GlassCard title="CPU vs GPU busy" actions={<span className="tnum">{busyScaleText(liveStats)}</span>}>
                  <BusyBars stats={liveStats} />
                </GlassCard>
                <GlassCard className="flex-1" title="While playing" actions={<span className="tnum">{whilePlayingMeta(settings.fpsWindowSec)}</span>}>
                  <WhilePlaying history={history} windowSec={settings.fpsWindowSec} tempUnit={settings.tempUnit} />
                </GlassCard>
              </div>
            </div>

            <p className="flex shrink-0 items-center gap-1.5 text-callout text-ink-3 tight:hidden">
              <Info size={13} className="shrink-0" aria-hidden="true" />
              {KNOWN_LIMITS}
            </p>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
            <EmptyState
              icon={<Gamepad2 size={34} strokeWidth={1.75} className="text-icon-2" aria-hidden="true" />}
              title={
                running || session?.state === "starting"
                  ? NO_TARGET_TITLE
                  : session?.state === "error"
                    ? "Frame capture stopped"
                    : "Frame capture is not running yet"
              }
              body={
                running || session?.state === "starting"
                  ? NO_TARGET_BODY
                  : session?.state === "error"
                    ? "Use Try again above, or turn frame capture off."
                    : undefined
              }
            >
              {targetCard("text-left")}
              <AntiCheatNote className="mt-4" />
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
