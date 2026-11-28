// Sidebar (CONTRACT §4.6.1, docs/design/SPEC.md §2): brand row, three nav groups in F-key order and the
// machine-identity card. The selected row is the only crimson in the shell besides the emblem.
// There is no connection line: while sensors work the UI says nothing about how they are read.
import { memo, useMemo } from "react";
import {
  Activity,
  Box,
  Cpu,
  Fan,
  Gamepad2,
  HardDrive,
  LayoutDashboard,
  Lock,
  Monitor,
  ShieldCheck,
  Sparkle,
  type LucideIcon,
} from "lucide-react";
import { FKEY_MAP, NAV_GROUPS, VIEW_ORDER, VIEW_TITLES, type HealthCondition, type ViewId } from "../../types";
import { cn, DASH, pickPrimaryGpu, shortCpuName, shortGpuName } from "../../lib/format";
import { useHealth } from "../../hooks/useHealth";
import { fmtSelfUsage, selfUsageTitle, useSelfUsage } from "../../hooks/useSelfUsage";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { StatusIcon } from "../ui";
import { NexumEmblem, NexumWordmark } from "./NexumEmblem";

export interface SidebarProps {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
}

const VIEW_ICONS: Record<ViewId, LucideIcon> = {
  dashboard: LayoutDashboard,
  sensors: Activity,
  system: Cpu,
  storage: HardDrive,
  cooling: Fan,
  drivers: Box,
  gaming: Gamepad2,
  cleaner: Sparkle,
};

/** Function key shown on a row, from FKEY_MAP (the cleaner row shows the "Clean caches" key, F9). */
function fkeyFor(view: ViewId): string | null {
  for (const [key, action] of Object.entries(FKEY_MAP)) {
    if (action.type === "view" && action.view === view) return key;
    if (action.type === "cleanCaches" && view === "cleaner") return key;
  }
  return null;
}

const ICON_STROKE = 1.75;

/** "Ryzen 7 5700X3D" → "5700X3D", "Core i9-14900K" → "i9-14900K": the footer card is 200 px wide in tight mode. */
function modelCpuName(name: string | null | undefined): string {
  const s = shortCpuName(name);
  if (s === DASH) return s;
  return s.replace(/^Ryzen\s+(?:Threadripper\s+(?:PRO\s+)?|\d\s+(?:PRO\s+)?)/i, "").replace(/^Core\s+(?:Ultra\s+\d\s+)?/i, "") || s;
}

interface DriveBadge {
  count: number;
  crit: boolean;
  title: string;
}

/** Storage badge: drive conditions with severity warn or crit (rule 4), never info. */
function driveBadge(conditions: readonly HealthCondition[]): DriveBadge | null {
  const hits = conditions.filter((c) => c.source === "drive" && (c.severity === "warn" || c.severity === "crit"));
  if (hits.length === 0) return null;
  // A drive can have a health and a temperature condition: count drives, not conditions.
  const drives = new Set(hits.map((c) => c.id.replace(/^[a-z-]+:/, "")));
  const count = drives.size;
  return {
    count,
    crit: hits.some((c) => c.severity === "crit"),
    title: count === 1 ? "1 drive needs attention" : `${count} drives need attention`,
  };
}

function NavBadge({ badge }: { badge: DriveBadge }) {
  return (
    <span
      role="img"
      title={badge.title}
      aria-label={badge.title}
      className={cn(
        "tnum ml-auto inline-flex h-[18px] shrink-0 items-center gap-[3px] rounded-[9px] bg-white pr-1.5 pl-1 text-[11px] leading-none font-semibold",
        badge.crit
          ? "text-crit shadow-[0_0_0_0.5px_var(--color-crit-border)]"
          : "text-warn shadow-[0_0_0_0.5px_var(--color-warn-border)]",
      )}
    >
      <StatusIcon tone={badge.crit ? "crit" : "warn"} size={12} />
      {badge.count}
    </span>
  );
}

interface NavRowProps {
  id: ViewId;
  selected: boolean;
  badge: DriveBadge | null;
  onNavigate: (view: ViewId) => void;
}

const NavRow = memo(function NavRow({ id, selected, badge, onNavigate }: NavRowProps) {
  const Icon = VIEW_ICONS[id];
  const key = fkeyFor(id);
  const ctrl = `Ctrl+${VIEW_ORDER.indexOf(id) + 1}`;
  const label = VIEW_TITLES[id];
  // F9 does not open this page: it opens the quick cleanup dialog (CONTRACT §4.6).
  const title =
    id === "cleaner" ? `${label} (${ctrl}). ${key ?? "F9"} opens the quick cleanup.` : key ? `${label} (${key} or ${ctrl})` : `${label} (${ctrl})`;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      title={title}
      onClick={() => onNavigate(id)}
      className={cn(
        "mb-px flex h-(--nav-item-h) w-full items-center gap-[9px] rounded-md px-2.5 text-left text-[13px] leading-none font-medium whitespace-nowrap",
        "transition-colors duration-(--dur-instant)",
        selected ? "focus-inset-on-brand bg-brand text-white" : "group/nav focus-inset text-ink hover:bg-hover active:bg-selected",
      )}
    >
      <Icon size={16} strokeWidth={ICON_STROKE} aria-hidden="true" className={cn("shrink-0", selected ? "text-white" : "text-icon-2")} />
      {/* Own line height: with the row's leading of 1 the truncation box would clip descenders. */}
      <span className="min-w-0 truncate leading-[18px]">{label}</span>
      {badge && <NavBadge badge={badge} />}
      {key && (
        // On the pressed row (7 % darker) the tertiary grey would drop to 4.39:1: the hint takes the secondary grey there.
        <span
          aria-hidden="true"
          className={cn(
            "tnum text-[11px] font-medium",
            badge ? "ml-2" : "ml-auto",
            selected ? "text-brand-key" : "text-ink-3 group-active/nav:text-ink-2",
          )}
        >
          {key}
        </span>
      )}
    </button>
  );
});

/** Machine identity: hostname, CPU · GPU, administrator state and Nexum's own usage. */
function FooterCard() {
  const { info } = useSystemInfo();
  const { latest, agent } = useTelemetry();
  const usage = useSelfUsage();

  const cpuFull = info?.cpuName || latest?.cpu.name || null;
  const gpuFull = pickPrimaryGpu(info?.gpuNames) ?? latest?.gpu?.name ?? null;
  const hardware = [cpuFull ? modelCpuName(cpuFull) : null, gpuFull ? shortGpuName(gpuFull) : null].filter(Boolean).join(" · ");
  // The core reports its own elevation; before it answers, the sensor side's hello is the next best source.
  const isAdmin = info ? info.isAdmin : agent?.phase === "running" ? agent.isAdmin : null;

  return (
    <div className="mt-auto shrink-0 rounded-lg bg-sidebar-card px-3 py-[11px] shadow-[0_0_0_0.5px_var(--color-hairline)]">
      <div className="flex items-center gap-[7px] text-[12.5px] leading-[17px] font-semibold text-ink">
        <Monitor size={15} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-icon-2" />
        <span className="min-w-0 truncate" title={info?.hostname || undefined}>
          {info?.hostname || DASH}
        </span>
      </div>
      <div className="mt-[3px] truncate text-callout text-ink-2" title={[cpuFull, gpuFull].filter(Boolean).join(" · ") || undefined}>
        {hardware || DASH}
      </div>
      {isAdmin != null && (
        <div
          className="mt-[3px] flex items-center gap-1.5 text-callout text-ink-2"
          title={
            isAdmin
              ? "Nexum runs with administrator rights."
              : "Nexum runs without administrator rights: some sensors, fan control and some cache cleanup are unavailable."
          }
        >
          {isAdmin ? (
            <ShieldCheck size={14} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-icon-2" />
          ) : (
            <Lock size={14} strokeWidth={ICON_STROKE} aria-hidden="true" className="shrink-0 text-icon-2" />
          )}
          <span className="truncate">{isAdmin ? "Administrator" : "Standard user"}</span>
        </div>
      )}
      {/* 11 px so the whole line fits the 200 px sidebar of tight mode. */}
      <div className="tnum mt-[3px] truncate text-[11px] leading-[17px] text-ink-2" title={selfUsageTitle(usage)}>
        {fmtSelfUsage(usage)}
      </div>
    </div>
  );
}

export function Sidebar({ view, onNavigate }: SidebarProps) {
  const health = useHealth();
  // The health context ticks every second: keep the badge object stable for the memoised rows.
  const fresh = driveBadge(health.conditions);
  const badgeKey = fresh ? `${fresh.count}:${fresh.crit ? 1 : 0}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- badgeKey carries everything the badge shows
  const badge = useMemo(() => fresh, [badgeKey]);

  return (
    <aside className="flex min-h-0 w-(--sidebar-w) shrink-0 flex-col border-r border-hairline bg-sidebar px-2.5 pb-2.5 select-none">
      <div className="flex h-(--toolbar-h) shrink-0 items-center gap-2 px-2.5">
        <NexumEmblem size={18} />
        <NexumWordmark height={11} className="text-ink" />
      </div>

      <nav aria-label="Views" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {NAV_GROUPS.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`nav-group-${group.id}`} className="mt-3 shrink-0">
            <div id={`nav-group-${group.id}`} className="px-2.5 pb-1 text-caption font-medium text-ink-3">
              {group.label}
            </div>
            {group.views.map((id) => (
              <NavRow
                key={id}
                id={id}
                selected={id === view}
                badge={id === "storage" ? badge : null}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      <FooterCard />
    </aside>
  );
}

export default Sidebar;
