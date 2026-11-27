import { Cpu, FileWarning, Folder, Globe, MemoryStick, RefreshCcw, Trash2 } from "lucide-react";
import type { TrashCategory, TrashCategoryId } from "../../types";
import { Toggle } from "../ui";
import { cn, fmtBytes } from "../../lib/format";

const ICONS: Record<TrashCategoryId, typeof Folder> = {
  temp: Folder,
  recycle: Trash2,
  "wu-cache": RefreshCcw,
  shader: Cpu,
  browser: Globe,
  logs: FileWarning,
  standby: MemoryStick,
};

const STANDBY_FALLBACK: TrashCategory = {
  id: "standby",
  label: "RAM Standby List",
  description: "Flush cached standby memory pages to free RAM before gaming or heavy workloads.",
  bytes: 0,
  files: 0,
  enabled: false,
  optional: true,
  requiresAdmin: true,
};

export interface CategoryListProps {
  categories: TrashCategory[];
  selected: Set<TrashCategoryId>;
  onToggle: (id: TrashCategoryId, on: boolean) => void;
  flushStandby: boolean;
  onToggleStandby: (on: boolean) => void;
  isAdmin: boolean;
  disabled?: boolean;
  /** Tighter rows for the modal. */
  compact?: boolean;
  /** Optional extra note rendered under a specific category (e.g. "bound to settings"). */
  notes?: Partial<Record<TrashCategoryId, string>>;
}

function Badge({ children, tone }: { children: string; tone: "gold" | "purple" | "rose" | "muted" }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider",
        tone === "gold" && "border-gold/40 bg-gold/10 text-gold",
        tone === "purple" && "border-purple/45 bg-purple/15 text-[#c084fc]",
        tone === "rose" && "border-rose/40 bg-rose/10 text-rose",
        tone === "muted" && "border-line bg-white/5 text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** Dry-run results per category with selection toggles, sizes, file counts and badges. */
export default function CategoryList({
  categories,
  selected,
  onToggle,
  flushStandby,
  onToggleStandby,
  isAdmin,
  disabled,
  compact,
  notes,
}: CategoryListProps) {
  const files = categories.filter((c) => c.id !== "standby");
  const standby = categories.find((c) => c.id === "standby") ?? STANDBY_FALLBACK;
  const maxBytes = Math.max(1, ...files.map((c) => c.bytes || 0));
  const rows = [...files, standby];

  return (
    <ul className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
      {rows.map((c) => {
        const isStandby = c.id === "standby";
        const on = isStandby ? flushStandby : selected.has(c.id);
        const Icon = ICONS[c.id] ?? Folder;
        const adminBlocked = c.requiresAdmin && !isAdmin;
        const share = isStandby ? 0 : ((c.bytes || 0) / maxBytes) * 100;

        return (
          <li
            key={c.id}
            className={cn(
              "group relative overflow-hidden rounded-xl border transition-colors",
              compact ? "px-3 py-2.5" : "px-4 py-3",
              on ? "border-gold/30 bg-gold/[0.045]" : "border-line bg-white/[0.015]",
            )}
          >
            {/* size share underlay */}
            {!isStandby && (
              <span
                aria-hidden
                className={cn("absolute inset-y-0 left-0 transition-[width] duration-500", on ? "bg-gold/[0.06]" : "bg-white/[0.02]")}
                style={{ width: `${share}%` }}
              />
            )}
            <div className="relative flex items-center gap-3">
              <span
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-lg border",
                  compact ? "h-8 w-8" : "h-9 w-9",
                  on ? "border-gold/45 text-gold" : "border-line text-muted",
                  isStandby && on && "border-purple/50 text-[#c084fc]",
                )}
              >
                <Icon size={compact ? 15 : 16} />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("text-[13px] font-semibold", on ? "text-ink" : "text-silver")}>{c.label}</span>
                  {c.optional && <Badge tone="purple">Optional</Badge>}
                  {c.requiresAdmin && <Badge tone={adminBlocked ? "rose" : "gold"}>{adminBlocked ? "Needs admin" : "Admin"}</Badge>}
                </div>
                {!compact && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{c.description}</div>}
                {compact && <div className="truncate text-[11px] text-muted" title={c.description}>{c.description}</div>}
                {notes?.[c.id] && <div className="mt-0.5 text-[10.5px] text-cyan/80">{notes[c.id]}</div>}
              </div>

              <div className="shrink-0 text-right">
                {isStandby ? (
                  <div className="font-mono text-[12px] text-[#c084fc]">RAM</div>
                ) : (
                  <>
                    <div className={cn("font-mono text-[14px] font-semibold", on ? "text-gold" : "text-silver")}>
                      {fmtBytes(c.bytes || 0)}
                    </div>
                    <div className="font-mono text-[10.5px] text-muted">
                      {(c.files || 0).toLocaleString()} {c.files === 1 ? "file" : "files"}
                    </div>
                  </>
                )}
              </div>

              <div className="shrink-0 pl-1">
                <Toggle
                  checked={on}
                  disabled={disabled}
                  ariaLabel={isStandby ? `Flush ${c.label}` : `Include ${c.label}`}
                  onChange={(v: boolean) => (isStandby ? onToggleStandby(v) : onToggle(c.id, v))}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

