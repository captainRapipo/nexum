import ThermalLoadCard from "../components/telemetry/ThermalLoadCard";
import HardwareSnapshotGrid from "../components/telemetry/HardwareSnapshotGrid";
import KpiStrip from "../components/telemetry/KpiStrip";
import StackedLiveChart from "../components/telemetry/StackedLiveChart";
import FanList from "../components/telemetry/FanList";
import StorageGauge from "../components/storage/StorageGauge";
import SegmentedDriveBar from "../components/storage/SegmentedDriveBar";
import BiosDetailsCard from "../components/drivers/BiosDetailsCard";
import DriverStatusList from "../components/drivers/DriverStatusList";

/**
 * Dashboard — START.md §2.2 three-column command grid.
 *   Left   (~300px): Thermal & Load Index · Storage & Junk gauge · 2×2 hardware snapshot
 *   Center (fluid) : 5-card KPI strip · live stacked telemetry chart
 *   Right  (~360px): System & BIOS · primary drive LED bar · cooling list · driver status
 * Below 1440px the side rails narrow so the grid fits a 1280×800 window without horizontal scroll.
 * Each column scrolls independently when its content exceeds the viewport height.
 */
export default function DashboardView() {
  return (
    <div className="h-full min-h-0 w-full min-w-0 overflow-hidden">
      <div
        className={[
          "grid h-full min-h-0 w-full",
          "grid-cols-[300px_minmax(0,1fr)_360px] gap-4",
          "max-[1439px]:grid-cols-[268px_minmax(0,1fr)_312px] max-[1439px]:gap-3",
        ].join(" ")}
      >
        {/* Left — health & quick KPIs */}
        <section
          aria-label="Health overview"
          className="nexum-scroll flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pb-1 pr-1 max-[1439px]:gap-3 [&>*]:shrink-0"
        >
          <ThermalLoadCard />
          <StorageGauge />
          <HardwareSnapshotGrid />
        </section>

        {/* Center — live telemetry command */}
        <section
          aria-label="Live telemetry"
          className="nexum-scroll flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pb-1 max-[1439px]:gap-3"
        >
          <KpiStrip />
          <div className="flex min-h-[340px] flex-1 flex-col">
            <StackedLiveChart />
          </div>
        </section>

        {/* Right — BIOS metadata, storage, cooling, drivers */}
        <section
          aria-label="System details"
          className="nexum-scroll flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pb-1 pr-1 max-[1439px]:gap-3 [&>*]:shrink-0"
        >
          <BiosDetailsCard />
          <SegmentedDriveBar />
          <FanList />
          <DriverStatusList />
        </section>
      </div>
    </div>
  );
}
