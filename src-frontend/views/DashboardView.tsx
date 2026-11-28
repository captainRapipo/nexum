import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { PageHeader, usePageChrome } from "../components/layout/PageChrome";
import KpiStrip from "../components/telemetry/KpiStrip";
import LiveChart from "../components/telemetry/LiveChart";
import HealthAlertsCard, { hasBanner } from "../components/telemetry/HealthAlertsCard";
import PinnedSensorsCard from "../components/telemetry/PinnedSensorsCard";
import SystemSummaryCard from "../components/telemetry/SystemSummaryCard";
import DriveWearBanners from "../components/telemetry/DriveWearBanners";
import FanList from "../components/telemetry/FanList";
import DrivesCard from "../components/telemetry/DrivesCard";
import { finite, uptimeText } from "../components/telemetry/sensorHelpers";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { useTelemetry } from "../hooks/useTelemetryStream";
import { useNow } from "../hooks/useNow";
import { useHealth } from "../hooks/useHealth";
import { useSettings } from "../hooks/useSettings";
import { cn } from "../lib/format";
import { pickPrimaryGpu, shortCpuName, shortGpuName } from "../lib/format";

/** "AMD Radeon RX 9070 XT" → "Radeon RX 9070 XT" (the maker's name is dropped, the family stays). */
function gpuFamilyName(name: string | null): string | null {
  if (!name) return null;
  const s = name
    .replace(/\((?:R|TM|C)\)/gi, "")
    .replace(/[®™©]/g, "")
    .replace(/^\s*(?:AMD|NVIDIA|Intel)\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s || name.trim();
}

/**
 * Height left for this page inside the scrolling `<main>` (its visible height minus what sits above
 * the page and the page padding below). The Dashboard is given exactly that height, so its bottom
 * row reaches the window edge and the chart row can give way in a short window; when the cards need
 * more than that, they run past it and the page scrolls instead of clipping a card.
 */
function useFillHeight(ref: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest("main");
    if (!el || !main) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const pad = el.parentElement && el.parentElement !== main ? parseFloat(getComputedStyle(el.parentElement).paddingBottom) || 0 : 0;
      const mainPad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      const next = Math.max(0, Math.floor(main.clientHeight - top - pad - mainPad));
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

/**
 * Dashboard (CONTRACT §4.10.3; render `dashboard-1600x960`):
 *   page title · drive banners (while not dismissed)
 *   KPI strip (one divided card)
 *   Load chart (8 columns) | Health + This PC (4 columns)
 *   Pinned sensors | Cooling | Drives (4 + 4 + 4), stretched to the window
 */
export default function DashboardView() {
  const { info } = useSystemInfo();
  const { latest } = useTelemetry();
  const now = useNow(30_000);
  const rootRef = useRef<HTMLDivElement>(null);
  const fill = useFillHeight(rootRef);
  const health = useHealth();
  const { settings } = useSettings();
  // While a drive banner is up, the Health card shows that condition as one line (the banner has the
  // rest), so the chart row may give up more height before the page has to scroll.
  const dismissed = settings?.dismissedAlerts ?? [];
  const bannerUp = health.conditions.some((c) => hasBanner(c, dismissed));

  const cpuShort = info?.cpuName ? shortCpuName(info.cpuName) : null;
  const gpuName = pickPrimaryGpu(info?.gpuNames);
  const bootTs = info?.bootTs;
  const up = finite(bootTs) && bootTs > 0 ? `up ${uptimeText(Math.max(0, (now - bootTs) / 1000))}` : null;
  const ramTotal = finite(latest?.ram?.totalGb) ? latest!.ram.totalGb : finite(info?.ramTotalGb) && info!.ramTotalGb > 0 ? info!.ramTotalGb : null;
  const ram = ramTotal !== null ? `${ramTotal.toFixed(0)} GB memory` : null;

  const subtitle = [cpuShort, gpuName ? shortGpuName(gpuName) : null, up].filter(Boolean).join(" · ") || null;
  const description = [cpuShort, gpuFamilyName(gpuName), ram, up].filter(Boolean).join(" · ") || undefined;
  usePageChrome({ subtitle });

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col" style={fill != null ? { height: fill } : undefined}>
      <PageHeader view="dashboard" description={description} />
      <DriveWearBanners className="mb-(--grid-gap) shrink-0" />

      <section aria-label="Key figures" className="mb-(--grid-gap) shrink-0">
        <KpiStrip />
      </section>

      {/* This row gives way first when a banner or a short window takes height (down to what Health and
          This PC need); the cards below keep their content, and past that the page scrolls. */}
      <div
        className={cn(
          "mb-(--grid-gap) grid h-[340px] shrink grid-cols-12 gap-(--grid-gap) tight:h-[296px]",
          bannerUp ? "min-h-[258px] tight:min-h-[230px]" : "min-h-[300px] tight:min-h-[283px]",
        )}
      >
        <section aria-label="Load" className="col-span-8 min-h-0 min-w-0">
          <LiveChart />
        </section>
        {/* A size container: This PC drops its last row when this column gets short (see SystemSummaryCard). */}
        <div className="col-span-4 flex min-h-0 min-w-0 flex-col gap-(--grid-gap) [container-name:dashside] [container-type:size]">
          <HealthAlertsCard />
          <SystemSummaryCard className="shrink-0 grow" />
        </div>
      </div>

      <div className="grid shrink-0 grow grid-cols-12 gap-(--grid-gap)">
        <PinnedSensorsCard className="col-span-4" />
        <FanList className="col-span-4" />
        <DrivesCard className="col-span-4" />
      </div>
    </div>
  );
}
