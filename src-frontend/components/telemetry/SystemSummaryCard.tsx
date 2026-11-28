import { Card, InkLink, KeyValueRow } from "../ui";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { requestNavigate } from "../../lib/nav";
import { cn, fmtBoardName, pickPrimaryGpu } from "../../lib/format";

/** "Microsoft Windows 11 Pro" + "24H2" → "Windows 11 Pro 24H2". */
function windowsName(caption: string | undefined, displayVersion: string | undefined): string {
  const name = (caption ?? "").replace(/^\s*Microsoft\s+/i, "").trim();
  const ver = (displayVersion ?? "").trim();
  if (!name) return "—";
  return ver && !name.includes(ver) ? `${name} ${ver}` : name;
}

/** Trademark marks and doubled spaces removed; the maker's name stays ("AMD Radeon RX 9070 XT"). */
function cleanName(name: string | null | undefined): string {
  const s = (name ?? "")
    .replace(/\((?:R|TM|C)\)/gi, "")
    .replace(/[®™©]/g, "")
    .replace(/\s+\d+-Core\s+Processor.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s || "—";
}

/**
 * "This PC" (CONTRACT §4.10.3): motherboard, processor, graphics and (regular mode only) Windows as
 * key-value rows, with a link to the System view. Uptime is shown once per view, in the page title.
 */
export default function SystemSummaryCard({ className }: { className?: string }) {
  const { info } = useSystemInfo();

  const board = info ? fmtBoardName(info.motherboard?.manufacturer, info.motherboard?.product) || "—" : "—";
  const cpu = cleanName(info?.cpuName);
  const gpu = cleanName(pickPrimaryGpu(info?.gpuNames));
  const windows = windowsName(info?.os?.caption, info?.os?.displayVersion);

  return (
    <Card
      title="This PC"
      actions={
        <InkLink onClick={() => requestNavigate("system")} title="Open System (F3)">
          System
        </InkLink>
      }
      // A little tighter than the standard card (14 px top, 6 px under the last row), as in the design.
      className={cn("min-h-0 [--card-pad-y:14px]", className)}
    >
      <div className="-my-2 flex flex-col">
        <KeyValueRow label="Motherboard" value={board} />
        <KeyValueRow label="Processor" value={cpu} />
        <KeyValueRow label="Graphics" value={gpu} />
        {/* Regular mode only, and only while the column is tall enough for the Health card above
            to show a whole condition (an app banner or a drive banner takes height from this row). */}
        <KeyValueRow label="Windows" value={windows} className="tight:hidden [@container_dashside_(max-height:327px)]:hidden" />
      </div>
    </Card>
  );
}
