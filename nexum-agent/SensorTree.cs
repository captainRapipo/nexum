using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;
using static NexumAgent.SensorUtil;

namespace NexumAgent;

/// <summary>
/// The Sensors-view protocol (CONTRACT §1.3): the full LHM tree with stable ids and dense indices,
/// per-tick values, LHM session Min/Max and an agent-side session average. All members must be
/// called while holding <see cref="TelemetryService.SyncRoot"/>.
/// </summary>
internal sealed class SensorTree
{
    private static readonly Regex CountOrCycles = new("count|cycles", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex Hours = new("hours", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly HashSet<string> StaticDataNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Total Space", "Capacity", "Total Memory", "GPU Memory Total",
    };

    private static readonly string[] StaticTempFragments = { "Limit", "Threshold", "Warning Temperature", "Critical Temperature" };

    private sealed class Entry
    {
        public required ISensor Sensor { get; init; }
        public required string Id { get; init; }
        public required int Decimals { get; init; }
        public required double Scale { get; init; }
        /// <summary>CPU temperature/power/clock/voltage read as 0 or a fixed placeholder without the sensor driver.</summary>
        public required bool NeedsDriver { get; init; }
        public double Sum;
        public long Count;
    }

    private readonly List<IHardware> _hwOrder = new();
    private readonly List<ISensor[]> _sensorOrder = new();
    private List<Entry> _entries = new();
    private int _rev;
    private SensorTreeMessage? _tree;

    public long SessionStartTs { get; private set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public SensorTreeMessage? Current => _tree;

    public int Rev => _rev;

    /// <summary>
    /// Compares the live hardware/sensor set with the last tree (by object identity, in order) and
    /// rebuilds it with rev+1 when the set or order changed. Returns true when a new tree was built.
    /// </summary>
    public bool Sync(IReadOnlyList<IHardware> all)
    {
        var sensors = new List<ISensor[]>(all.Count);
        foreach (var hw in all) sensors.Add(SensorsOf(hw));

        if (_tree is not null && SameShape(all, sensors)) return false;

        Rebuild(all, sensors);
        return true;
    }

    private bool SameShape(IReadOnlyList<IHardware> all, List<ISensor[]> sensors)
    {
        if (all.Count != _hwOrder.Count) return false;
        for (int i = 0; i < all.Count; i++)
        {
            if (!ReferenceEquals(all[i], _hwOrder[i])) return false;
            var a = sensors[i];
            var b = _sensorOrder[i];
            if (a.Length != b.Length) return false;
            for (int j = 0; j < a.Length; j++)
            {
                if (!ReferenceEquals(a[j], b[j])) return false;
            }
        }
        return true;
    }

    private void Rebuild(IReadOnlyList<IHardware> all, List<ISensor[]> sensors)
    {
        var previous = _entries.ToDictionary(e => e.Id, e => (e.Sum, e.Count), StringComparer.Ordinal);
        bool driverOk = Program.SensorDriverOk;

        var entries = new List<Entry>();
        var nodes = new List<HardwareNodeDto>(all.Count);
        var seenSensorIds = new HashSet<string>(StringComparer.Ordinal);

        for (int i = 0; i < all.Count; i++)
        {
            var hw = all[i];
            var hwId = SafeId(hw);
            string? parentId = null;
            try { parentId = hw.Parent is null ? null : SafeId(hw.Parent); } catch { /* ignore */ }
            if (string.IsNullOrEmpty(parentId)) parentId = null;

            var node = new HardwareNodeDto
            {
                Id = hwId,
                ParentId = parentId,
                Kind = HardwareKind(hw.HardwareType),
                Name = SafeName(hw),
            };

            foreach (var s in sensors[i])
            {
                if (s is null) continue;
                var meta = Describe(s);
                if (meta is null) continue; // LHM type not in the contract table
                var id = SafeId(s);
                if (id.Length == 0 || !seenSensorIds.Add(id)) continue;

                TelemetryService.DisableHistory(s);

                bool needsDriver = hw.HardwareType == HardwareType.Cpu &&
                                   s.SensorType is SensorType.Temperature or SensorType.Power or SensorType.Clock or SensorType.Voltage;
                var entry = new Entry
                {
                    Sensor = s,
                    Id = id,
                    Decimals = meta.Value.Decimals,
                    Scale = meta.Value.Scale,
                    NeedsDriver = needsDriver,
                };
                if (previous.TryGetValue(id, out var acc))
                {
                    entry.Sum = acc.Sum;
                    entry.Count = acc.Count;
                }

                bool hidden = ReadValue(entry, driverOk) is null;
                node.Sensors.Add(new SensorMetaDto
                {
                    Id = id,
                    Idx = entries.Count,
                    HwId = hwId,
                    Name = s.Name ?? "",
                    Kind = meta.Value.Kind,
                    Unit = meta.Value.Unit,
                    Decimals = meta.Value.Decimals,
                    Static = meta.Value.Static,
                    DefaultHidden = hidden,
                });
                entries.Add(entry);
            }
            nodes.Add(node);
        }

        _hwOrder.Clear();
        _hwOrder.AddRange(all);
        _sensorOrder.Clear();
        _sensorOrder.AddRange(sensors);
        _entries = entries;
        _rev++;
        _tree = new SensorTreeMessage { Rev = _rev, SessionStartTs = SessionStartTs, Hardware = nodes };
        Program.Log($"Sensor tree rev {_rev}: {nodes.Count} hardware nodes, {entries.Count} sensors");
    }

    /// <summary>A copy of the current tree with the current sessionStartTs (after a reset-all).</summary>
    public SensorTreeMessage? CurrentWithSession() =>
        _tree is null ? null : new SensorTreeMessage { Rev = _tree.Rev, SessionStartTs = SessionStartTs, Hardware = _tree.Hardware };

    /// <summary>Adds the current value of every sensor to its session average (call once per telemetry tick).</summary>
    public void Accumulate()
    {
        bool driverOk = Program.SensorDriverOk;
        foreach (var e in _entries)
        {
            var v = ReadRaw(e, driverOk);
            if (!v.HasValue) continue;
            e.Sum += v.Value;
            e.Count++;
        }
    }

    public SensorValuesMessage BuildValues(long ts)
    {
        int n = _entries.Count;
        var value = new double?[n];
        var min = new double?[n];
        var max = new double?[n];
        var avg = new double?[n];
        bool driverOk = Program.SensorDriverOk;
        for (int i = 0; i < n; i++)
        {
            var e = _entries[i];
            value[i] = ReadValue(e, driverOk);
            if (e.NeedsDriver && !driverOk) continue;
            float? lo = null, hi = null;
            try { lo = e.Sensor.Min; hi = e.Sensor.Max; } catch { /* ignore */ }
            min[i] = Convert(e, lo);
            max[i] = Convert(e, hi);
            avg[i] = e.Count > 0 ? Round(e.Sum / e.Count * e.Scale, e.Decimals) : null;
        }
        return new SensorValuesMessage { Ts = ts, Rev = _rev, Value = value, Min = min, Max = max, Avg = avg };
    }

    /// <summary>
    /// Resets LHM Min/Max and the agent average. <paramref name="ids"/> null = every sensor and a new
    /// session start. Unknown ids are ignored. Returns the number of sensors reset.
    /// </summary>
    public int Reset(IReadOnlyCollection<string>? ids)
    {
        HashSet<string>? wanted = ids is null ? null : new HashSet<string>(ids, StringComparer.Ordinal);
        int n = 0;
        foreach (var e in _entries)
        {
            if (wanted is not null && !wanted.Contains(e.Id)) continue;
            try
            {
                e.Sensor.ResetMin();
                e.Sensor.ResetMax();
            }
            catch (Exception ex)
            {
                Program.LogThrottled($"reset:{e.Id}", $"Reset failed for {e.Id}: {ex.Message}");
            }
            e.Sum = 0;
            e.Count = 0;
            n++;
        }
        if (wanted is null) SessionStartTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return n;
    }

    // ---------------------------------------------------------------------------------------------

    private static double? ReadRaw(Entry e, bool driverOk)
    {
        if (e.NeedsDriver && !driverOk) return null;
        float? v;
        try { v = e.Sensor.Value; } catch { return null; }
        var f = Finite(v);
        return f.HasValue ? f.Value : null;
    }

    private static double? ReadValue(Entry e, bool driverOk)
    {
        var raw = ReadRaw(e, driverOk);
        return raw.HasValue ? Round(raw.Value * e.Scale, e.Decimals) : null;
    }

    private static double? Convert(Entry e, float? v)
    {
        var f = Finite(v);
        return f.HasValue ? Round(f.Value * e.Scale, e.Decimals) : null;
    }

    internal readonly record struct SensorDescription(string Kind, string Unit, int Decimals, double Scale, bool Static);

    /// <summary>LHM SensorType → wire kind/unit/decimals (CONTRACT §1.3 table); null when the type is not in the table.</summary>
    internal static SensorDescription? Describe(ISensor s) => Describe(s.SensorType, s.Name ?? "");

    internal static SensorDescription? Describe(SensorType type, string name)
    {
        bool countLike = CountOrCycles.IsMatch(name);
        switch (type)
        {
            case SensorType.Voltage: return new("voltage", "V", 3, 1, false);
            case SensorType.Current: return new("current", "A", 2, 1, false);
            case SensorType.Power: return new("power", "W", 1, 1, false);
            case SensorType.Clock: return new("clock", "MHz", 0, 1, false);
            case SensorType.Temperature:
                return new("temperature", "°C", 1, 1, StaticTempFragments.Any(f => name.Contains(f, StringComparison.OrdinalIgnoreCase)));
            case SensorType.Load: return new("load", "%", 1, 1, false);
            case SensorType.Frequency: return new("frequency", "Hz", 0, 1, false);
            case SensorType.Fan: return new("fan", "RPM", 0, 1, false);
            case SensorType.Flow: return new("flow", "L/h", 0, 1, false);
            case SensorType.Control: return new("control", "%", 0, 1, false);
            case SensorType.Level: return new("level", "%", 1, 1, false);
            case SensorType.Factor: return new("factor", "", 2, 1, false);
            case SensorType.Data:
                return countLike
                    ? new("data", "", 0, 1, StaticDataNames.Contains(name.Trim()))
                    : new("data", "GB", 1, 1, StaticDataNames.Contains(name.Trim()));
            case SensorType.SmallData:
                return new("smallData", countLike ? "" : "MB", 0, 1, StaticDataNames.Contains(name.Trim()));
            case SensorType.Throughput: return new("throughput", "MB/s", 2, 1d / BytesPerMiB, false);
            case SensorType.TimeSpan: return new("timeSpan", Hours.IsMatch(name) ? "h" : "s", 0, 1, false);
            case SensorType.Timing: return new("timing", "ns", 2, 1, true);
            case SensorType.Energy: return new("energy", "mWh", 0, 1, false);
            case SensorType.Noise: return new("noise", "dBA", 0, 1, false);
            case SensorType.Conductivity: return new("conductivity", "µS/cm", 1, 1, false);
            case SensorType.Humidity: return new("humidity", "%", 0, 1, false);
            default: return null;
        }
    }

    internal static string HardwareKind(HardwareType t) => t switch
    {
        HardwareType.Motherboard => "motherboard",
        HardwareType.SuperIO => "superio",
        HardwareType.Cpu => "cpu",
        HardwareType.Memory => "memory",
        HardwareType.GpuNvidia => "gpuNvidia",
        HardwareType.GpuAmd => "gpuAmd",
        HardwareType.GpuIntel => "gpuIntel",
        HardwareType.Storage => "storage",
        HardwareType.Network => "network",
        HardwareType.Cooler => "cooler",
        HardwareType.EmbeddedController => "embeddedController",
        HardwareType.Psu => "psu",
        HardwareType.Battery => "battery",
        HardwareType.PowerMonitor => "powerMonitor",
        _ => "other",
    };
}
