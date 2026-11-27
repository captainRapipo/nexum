using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent.Spec;

/// <summary>
/// SPD JEDEC data per DIMM (CONTRACT §1.4.1) from LHM 0.9.6 <c>DimmMemory</c> nodes (<c>/memory/dimm/&lt;n&gt;</c>,
/// RAMSPDToolkit; needs elevation + PawnIO). The <c>SensorType.Timing</c> sensors are the JEDEC minimum times in ns,
/// named like <c>"tAA (CAS Latency Time)"</c>; the key is the name's first word (<c>tAA</c>). No serial numbers.
/// </summary>
internal static class SpdReader
{
    /// <summary>Keys of <c>SpdInfo.timingsNs</c>, in wire order (types.ts <c>SpdTimingKey</c>).</summary>
    internal static readonly string[] TimingKeys =
    {
        "tAA", "tRCD", "tRP", "tRAS", "tRC", "tRFC1", "tRFC2", "tRFC4", "tFAW",
        "tRRD_S", "tRRD_L", "tCCD_L", "tWR", "tWTR_S", "tWTR_L",
    };

    /// <summary>One LHM DIMM node, captured under the hardware lock.</summary>
    internal sealed class DimmFacts
    {
        public string Name = "";
        public Dictionary<string, double?> TimingsNs = new();
        public double? TempC;
    }

    /// <summary>Call while holding the hardware lock. Cheap: reads cached sensor values only.</summary>
    public static List<DimmFacts> Capture(IEnumerable<IHardware> all)
    {
        var list = new List<DimmFacts>();
        foreach (var hw in all)
        {
            if (hw.HardwareType != HardwareType.Memory) continue;
            if (!SafeId(hw).StartsWith("/memory/dimm/", StringComparison.OrdinalIgnoreCase)) continue;

            var f = new DimmFacts { Name = SafeName(hw) };
            foreach (var key in TimingKeys) f.TimingsNs[key] = null;
            foreach (var s in SensorsOf(hw))
            {
                if (s is null) continue;
                var name = (s.Name ?? "").Trim();
                if (s.SensorType == SensorType.Timing)
                {
                    var key = KeyOf(name);
                    if (key is not null && f.TimingsNs.ContainsKey(key))
                    {
                        var v = Finite(s.Value);
                        f.TimingsNs[key] = v is > 0 ? Math.Round(v.Value, 3) : null;
                    }
                }
                else if (s.SensorType == SensorType.Temperature && f.TempC is null
                         && name.StartsWith("DIMM #", StringComparison.OrdinalIgnoreCase))
                {
                    // The module thermal sensor (LHM SpdThermalSensor "DIMM #n"); the limit sensors have other names.
                    var v = Finite(s.Value);
                    if (v is > 0 and < 150) f.TempC = Math.Round(v.Value, 1);
                }
            }
            list.Add(f);
        }
        return list;
    }

    /// <summary>"tRRD_S (Activate to Activate Delay Time)" → "tRRD_S"; the LHM name without the description.</summary>
    internal static string? KeyOf(string sensorName)
    {
        var s = sensorName.Trim();
        int cut = s.IndexOfAny(new[] { ' ', '(' });
        var key = cut < 0 ? s : s[..cut];
        return key.Length > 0 ? key : null;
    }

    /// <summary>CONTRACT §1.4.1: tCK = 2000 / MT/s ns; cycles = ceil(ns / tCK − 0.025) (JEDEC 2.5% guard band).</summary>
    internal static int? Cycles(double? ns, int? jedecSpeedMts)
    {
        if (ns is not > 0 || jedecSpeedMts is not > 0) return null;
        double tck = 2000.0 / jedecSpeedMts.Value;
        // Round the quotient to 1e-9 first so float noise (13.75f / 0.625 = 22.000000001) cannot add a cycle.
        double q = Math.Round(ns.Value / tck, 9);
        return (int)Math.Ceiling(q - 0.025);
    }

    internal static SpdInfoDto Build(DimmFacts f, int? jedecSpeedMts, string matchedBy)
    {
        var ns = new Dictionary<string, double?>();
        foreach (var key in TimingKeys) ns[key] = f.TimingsNs.TryGetValue(key, out var v) ? v : null;
        int? C(string key) => Cycles(ns[key], jedecSpeedMts);
        return new SpdInfoDto
        {
            JedecSpeedMts = jedecSpeedMts,
            TimingsNs = ns,
            Cycles = new SpdCyclesDto
            {
                Cl = C("tAA"),
                Rcd = C("tRCD"),
                Rp = C("tRP"),
                Ras = C("tRAS"),
                Rc = C("tRC"),
                Rfc = C("tRFC1"),
                Faw = C("tFAW"),
                Rrds = C("tRRD_S"),
                Rrdl = C("tRRD_L"),
                Wr = C("tWR"),
                Wtrs = C("tWTR_S"),
                Wtrl = C("tWTR_L"),
            },
            TempC = f.TempC,
            MatchedBy = matchedBy,
        };
    }

    /// <summary>
    /// Joins LHM DIMM nodes to <c>Win32_PhysicalMemory</c> rows (CONTRACT §1.4.1) and returns, per row, the index
    /// of its node (or -1) and how it was matched. <c>Ok == false</c> means the modules could not be matched.
    /// Rule: if every node name contains exactly one distinct part number (trimmed, case-insensitive) that occurs
    /// once among the rows, join by part number; else if the counts are equal, join by order; else nothing.
    /// </summary>
    internal static (bool Ok, int[] NodeForRow, string MatchedBy) Join(IReadOnlyList<string> nodeNames, IReadOnlyList<string> rowPartNumbers)
    {
        var none = Enumerable.Repeat(-1, rowPartNumbers.Count).ToArray();
        if (nodeNames.Count == 0) return (true, none, "order");

        var parts = rowPartNumbers.Select(p => (p ?? "").Trim()).ToList();
        var unique = parts
            .Where(p => p.Length > 0)
            .GroupBy(p => p, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() == 1)
            .Select(g => g.Key)
            .ToList();

        var byPart = new int[parts.Count];
        Array.Fill(byPart, -1);
        bool allMatched = unique.Count > 0;
        for (int n = 0; n < nodeNames.Count && allMatched; n++)
        {
            var distinct = parts
                .Where(p => p.Length > 0 && nodeNames[n].Contains(p, StringComparison.OrdinalIgnoreCase))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (distinct.Count != 1 || !unique.Contains(distinct[0], StringComparer.OrdinalIgnoreCase))
            {
                allMatched = false;
                break;
            }
            int row = parts.FindIndex(p => string.Equals(p, distinct[0], StringComparison.OrdinalIgnoreCase));
            if (byPart[row] >= 0) { allMatched = false; break; }
            byPart[row] = n;
        }
        if (allMatched) return (true, byPart, "partNumber");

        if (nodeNames.Count == parts.Count)
        {
            return (true, Enumerable.Range(0, parts.Count).ToArray(), "order");
        }
        return (false, none, "order");
    }

    /// <summary>Fills <c>dimms[].spd</c>. Returns an errors line when the modules could not be matched, else null.</summary>
    public static string? Apply(List<DimmFacts> nodes, List<DimmSpecDto> dimms)
    {
        if (nodes.Count == 0 || dimms.Count == 0) return null;
        var (ok, map, matchedBy) = Join(nodes.Select(n => n.Name).ToList(), dimms.Select(d => d.PartNumber).ToList());
        if (!ok) return "SPD query failed: could not match modules to slots";
        for (int i = 0; i < dimms.Count; i++)
        {
            if (map[i] < 0) continue;
            var f = nodes[map[i]];
            // A node without any JEDEC timing (e.g. SPD page switch failed) carries no SPD data.
            if (f.TimingsNs.Values.All(v => v is null)) continue;
            dimms[i].Spd = Build(f, dimms[i].SpeedMts, matchedBy);
        }
        return null;
    }
}
