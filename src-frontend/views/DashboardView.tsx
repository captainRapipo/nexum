import type { ReactNode } from "react";
import { ScrollFade } from "../components/ui";
import KpiStrip from "../components/telemetry/KpiStrip";
import LiveChart from "../components/telemetry/LiveChart";
import HealthAlertsCard from "../components/telemetry/HealthAlertsCard";
import PinnedSensorsCard from "../components/telemetry/PinnedSensorsCard";
import SystemSummaryCard from "../components/telemetry/SystemSummaryCard";
import DriveWearBanners from "../components/telemetry/DriveWearBanners";
import FanList from "../components/telemetry/FanList";
import StorageGauge from "../components/storage/StorageGauge";
import DrivesCard from "../components/storage/DrivesCard";

/**
 * Dashboard (ROADMAP §3 "Dashboard slim-down", §6.5):
 *   Banners: one per drive-wear condition (dismissible)
 *   Left   (~300px): Health alerts · Pinned sensors · Storage gauge
 *   Center (fluid) : KPI strip · live chart
 *   Right  (~360px): 3-line System summary · Drives with life chips · Active cooling
 * Side columns scroll independently with a fade mask (MF-10). Fits a 1280×800 window without horizontal scroll.
 */
export default function DashboardView() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-hidden">
      <DriveWearBanners />
      <div
        className={[
          "grid min-h-0 w-full flex-1",
          "grid-cols-[300px_minmax(0,1fr)_360px] gap-4",
          "max-[1439px]:grid-cols-[268px_minmax(0,1fr)_312px] max-[1439px]:gap-3",
        ].join(" ")}
      >
        <Column label="Health overview">
          <HealthAlertsCard />
          <PinnedSensorsCard />
          <StorageGauge />
        </Column>

        <section aria-label="Live telemetry" className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden max-[1439px]:gap-3">
          <KpiStrip />
          <div className="flex min-h-[300px] flex-1 flex-col">
            <LiveChart />
          </div>
        </section>

        <Column label="System details">
          <SystemSummaryCard />
          <DrivesCard />
          <FanList />
        </Column>
      </div>
    </div>
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-h-0 min-w-0 flex-col">
      <ScrollFade className="h-full pr-1">
        <div className="flex flex-col gap-4 pb-1 max-[1439px]:gap-3 [&>*]:shrink-0">{children}</div>
      </ScrollFade>
    </section>
  );
}
