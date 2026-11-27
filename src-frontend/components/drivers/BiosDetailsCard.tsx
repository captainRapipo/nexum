import { useMemo } from "react";
import { CircuitBoard } from "lucide-react";
import { DottedLeaderRow, StatusPill } from "../ui";
import { GlassCard } from "../layout/GlassCard";
import { useSystemInfo } from "../../hooks/useSystemInfo";
import { useTelemetry } from "../../hooks/useTelemetryStream";
import { fmtUptime, pickPrimaryGpu } from "../../lib/format";

const MAX_LEN = 34;

/** Trim noisy OEM strings ("To Be Filled By O.E.M.", "System Product Name", "Default string"). */
function clean(s: string | null | undefined): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/^(to be filled by o\.?e\.?m\.?|system product name|default string|not applicable|none|n\/a|0+)$/i.test(t)) return "";
  return t;
}

function ellipsize(s: string, max = MAX_LEN): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Strip trademark noise and redundant prefixes for compact display. */
function compactName(s: string): string {
  const t = s
    .replace(/\((r|tm|c)\)/gi, "")
    .replace(/[®™]/g, "")
    .replace(/\b(Corporation|Corp|Co\.?,? ?Ltd|Inc|Technology|Computer|International)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,.]+$/, "")
    .trim();
  return BRAND_ALIASES[t.toLowerCase()] ?? t;
}

/** Common long OEM names → the brand people actually recognise. */
const BRAND_ALIASES: Record<string, string> = {
  asustek: "ASUS",
  "micro-star": "MSI",
  gigabyte: "Gigabyte",
  "hewlett-packard": "HP",
  "american megatrends": "AMI",
};

function fmtBiosDate(d: string): string {
  if (!d) return "";
  // Expect YYYY-MM-DD; fall back to the raw string.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

interface Row {
  label: string;
  value: string;
  className?: string;
}

export default function BiosDetailsCard() {
  const { info } = useSystemInfo();
  const { latest } = useTelemetry();

  const rows = useMemo<Row[]>(() => {
    const dash = "—";
    if (!info) {
      return ["Motherboard", "BIOS", "BIOS Mode", "OS Build", "GPU", "Architecture", "Secure Boot", "TPM"].map(
        (label) => ({ label, value: dash, className: "text-muted" }),
      );
    }

    const mbMaker = compactName(clean(info.motherboard?.manufacturer));
    const mbProduct = clean(info.motherboard?.product);
    const motherboard = [mbMaker, mbProduct].filter(Boolean).join(" ") || dash;

    const biosVer = clean(info.bios?.version);
    const biosDate = fmtBiosDate(clean(info.bios?.releaseDate));
    const bios = [biosVer, biosDate ? `(${biosDate})` : ""].filter(Boolean).join(" ") || dash;

    const mode = info.bios?.mode ?? "Unknown";

    const caption = clean(info.os?.caption).replace(/^Microsoft\s+/i, "");
    const display = clean(info.os?.displayVersion);
    const build = clean(info.os?.build);
    const osBuild = [caption, display, build ? `· ${build}` : ""].filter(Boolean).join(" ") || dash;

    const gpuName = compactName(clean(latest?.gpu?.name) || clean(pickPrimaryGpu(info.gpuNames))) || dash;

    const arch = clean(info.os?.architecture) || dash;

    let secureBoot = "Unknown";
    let secureBootCls = "text-muted";
    if (info.secureBoot === true) {
      secureBoot = "Enabled";
      secureBootCls = "text-teal";
    } else if (info.secureBoot === false) {
      secureBoot = "Disabled";
      secureBootCls = "text-gold";
    }

    let tpm = "Unknown";
    let tpmCls = "text-muted";
    if (info.tpm) {
      if (info.tpm.present) {
        const v = clean(info.tpm.version);
        // WMI SpecVersion looks like "2.0, 0, 1.59" — keep the leading spec number.
        const spec = v ? v.split(",")[0].trim() : "";
        tpm = spec ? `TPM ${spec} Present` : "Present";
        tpmCls = spec.startsWith("2") ? "text-teal" : "text-gold";
      } else {
        tpm = "Not detected";
        tpmCls = "text-rose";
      }
    }

    return [
      { label: "Motherboard", value: ellipsize(motherboard) },
      { label: "BIOS", value: ellipsize(bios) },
      {
        label: "BIOS Mode",
        value: mode,
        className: mode === "UEFI" ? "text-teal" : mode === "Legacy" ? "text-gold" : "text-muted",
      },
      { label: "OS Build", value: ellipsize(osBuild) },
      { label: "GPU", value: ellipsize(gpuName) },
      { label: "Architecture", value: arch },
      { label: "Secure Boot", value: secureBoot, className: secureBootCls },
      { label: "TPM", value: tpm, className: tpmCls },
    ];
  }, [info, latest?.gpu?.name]);

  const vendor = info ? compactName(clean(info.bios?.vendor)) : "";

  return (
    <GlassCard
      title="System & BIOS"
      icon={<CircuitBoard size={14} />}
      accent="silver"
      actions={
        info ? (
          <StatusPill tone="info">UP {fmtUptime(info.uptimeSecs)}</StatusPill>
        ) : null
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <DottedLeaderRow
            key={r.label}
            label={r.label}
            value={r.value}
            valueClassName={`font-mono ${r.className ?? "text-ink"}`}
          />
        ))}
      </div>
      {vendor && (
        <div className="mt-2.5 border-t border-line pt-2 text-[9.5px] uppercase tracking-[0.22em] text-muted">
          Firmware · <span className="text-silver">{ellipsize(vendor, 40)}</span>
        </div>
      )}
    </GlassCard>
  );
}
