using LibreHardwareMonitor.Hardware;

namespace NexumAgent;

/// <summary>Null-safe sensor lookup and numeric sanitising shared by all mappers.</summary>
internal static class SensorUtil
{
    public const double BytesPerMiB = 1024d * 1024d;

    /// <summary>Hardware and all nested SubHardware, depth-first. Never throws.</summary>
    public static IEnumerable<IHardware> Flatten(IEnumerable<IHardware>? roots)
    {
        if (roots is null) yield break;
        var stack = new Stack<IHardware>();
        foreach (var r in roots.Reverse())
        {
            if (r is not null) stack.Push(r);
        }

        while (stack.Count > 0)
        {
            var hw = stack.Pop();
            yield return hw;
            IHardware[]? subs = null;
            try { subs = hw.SubHardware; } catch { /* hardware disappeared */ }
            if (subs is null) continue;
            for (int i = subs.Length - 1; i >= 0; i--)
            {
                if (subs[i] is not null) stack.Push(subs[i]);
            }
        }
    }

    public static ISensor[] SensorsOf(IHardware hw)
    {
        try { return hw.Sensors ?? Array.Empty<ISensor>(); }
        catch { return Array.Empty<ISensor>(); }
    }

    /// <summary>First sensor of <paramref name="type"/> whose name equals one of
    /// <paramref name="names"/>, honouring the order of <paramref name="names"/> as priority.</summary>
    public static ISensor? Find(IHardware hw, SensorType type, params string[] names)
    {
        var sensors = SensorsOf(hw);
        foreach (var name in names)
        {
            foreach (var s in sensors)
            {
                if (s is null || s.SensorType != type) continue;
                if (string.Equals(s.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase)) return s;
            }
        }
        return null;
    }

    /// <summary>Like <see cref="Find"/> but only returns a sensor that currently has a finite value.</summary>
    public static float? FindValue(IHardware hw, SensorType type, params string[] names)
    {
        var sensors = SensorsOf(hw);
        foreach (var name in names)
        {
            foreach (var s in sensors)
            {
                if (s is null || s.SensorType != type) continue;
                if (!string.Equals(s.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase)) continue;
                var v = Finite(s.Value);
                if (v.HasValue) return v;
            }
        }
        return null;
    }

    /// <summary>Like <see cref="FindValue"/> but ignores readings ≤ 0 (unreadable temps/power report 0 without ring-0 access).</summary>
    public static float? FindPositive(IHardware hw, SensorType type, params string[] names)
    {
        var sensors = SensorsOf(hw);
        foreach (var name in names)
        {
            foreach (var s in sensors)
            {
                if (s is null || s.SensorType != type) continue;
                if (!string.Equals(s.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase)) continue;
                var v = Finite(s.Value);
                if (v.HasValue && v.Value > 0) return v;
            }
        }
        return null;
    }

    /// <summary>Like <see cref="FindPositive"/> but returns the sensor itself (for Min/Max access).</summary>
    public static ISensor? FindPositiveSensor(IHardware hw, SensorType type, params string[] names)
    {
        var sensors = SensorsOf(hw);
        foreach (var name in names)
        {
            foreach (var s in sensors)
            {
                if (s is null || s.SensorType != type) continue;
                if (!string.Equals(s.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase)) continue;
                var v = Finite(s.Value);
                if (v.HasValue && v.Value > 0) return s;
            }
        }
        return null;
    }

    public static float? FirstPositive(IHardware hw, SensorType type)
    {
        foreach (var s in OfType(hw, type))
        {
            var v = Finite(s.Value);
            if (v.HasValue && v.Value > 0) return v;
        }
        return null;
    }

    public static float? Positive(float? v) => v.HasValue && v.Value > 0 ? Finite(v) : null;
    /// <summary>First sensor of a type whose name contains any fragment (case-insensitive) and has a finite value.</summary>
    public static float? FindValueContaining(IHardware hw, SensorType? type, params string[] fragments)
    {
        foreach (var s in SensorsOf(hw))
        {
            if (s is null) continue;
            if (type.HasValue && s.SensorType != type.Value) continue;
            var name = s.Name ?? "";
            foreach (var f in fragments)
            {
                if (name.Contains(f, StringComparison.OrdinalIgnoreCase))
                {
                    var v = Finite(s.Value);
                    if (v.HasValue) return v;
                    break;
                }
            }
        }
        return null;
    }

    public static IEnumerable<ISensor> OfType(IHardware hw, SensorType type) =>
        SensorsOf(hw).Where(s => s is not null && s.SensorType == type).OrderBy(s => s.Index);

    public static float? FirstValue(IHardware hw, SensorType type)
    {
        foreach (var s in OfType(hw, type))
        {
            var v = Finite(s.Value);
            if (v.HasValue) return v;
        }
        return null;
    }

    public static float? Finite(float? v) =>
        v.HasValue && !float.IsNaN(v.Value) && !float.IsInfinity(v.Value) ? v : null;

    public static double? Finite(double? v) =>
        v.HasValue && !double.IsNaN(v.Value) && !double.IsInfinity(v.Value) ? v : null;

    /// <summary>Round to <paramref name="digits"/> decimals; NaN/Infinity/null → null.</summary>
    public static double? Round(double? v, int digits = 1)
    {
        var f = Finite(v);
        return f.HasValue ? Math.Round(f.Value, digits, MidpointRounding.AwayFromZero) : null;
    }

    public static double? Round(float? v, int digits = 1) => Round(v.HasValue ? (double)v.Value : null, digits);

    /// <summary>Non-nullable variant for fields the contract types as plain numbers.</summary>
    public static double RoundOr(double? v, double fallback = 0, int digits = 1) => Round(v, digits) ?? fallback;

    public static double? Clamp(double? v, double min, double max) =>
        v.HasValue ? Math.Clamp(v.Value, min, max) : null;

    public static string SafeName(IHardware hw)
    {
        try { return (hw.Name ?? "").Trim(); } catch { return ""; }
    }

    public static string SafeId(IHardware hw)
    {
        try { return hw.Identifier?.ToString() ?? ""; } catch { return ""; }
    }

    public static string SafeId(ISensor s)
    {
        try { return s.Identifier?.ToString() ?? ""; } catch { return ""; }
    }
}
