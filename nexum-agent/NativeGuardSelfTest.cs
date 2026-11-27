using System.Reflection;
using System.Runtime.InteropServices;
using NexumAgent.Spec;
using NexumAgent.Tuning;

namespace NexumAgent;

/// <summary>
/// `--selftest` guards for the read-only native surfaces added in 1.1 (no hardware, no driver calls):
/// <list type="bullet">
/// <item>ADL: every P/Invoke into the ADL library in this assembly is declared in <see cref="AdlNative"/>, is on the
/// CONTRACT §1.7.1 whitelist, is a read (no <c>_Set</c> segment) and is restricted to System32;</item>
/// <item>ADL structure layouts match adl_structures.h (a wrong layout would corrupt memory in the elevated agent);</item>
/// <item>the ADL allocation callback never throws, zeroes, tracks sizes and never frees a foreign pointer;</item>
/// <item>SMN: the PCI-bus mutex name is LHM 0.9.6's, and the PawnIO AMDFamily17 wrapper Nexum uses has no write method.</item>
/// </list>
/// Lives outside <c>Tuning/</c> because it uses reflection, which CI forbids there.
/// </summary>
internal static class NativeGuardSelfTest
{
    private static readonly string[] AdlWhitelist =
    {
        "ADL2_Main_Control_Create", "ADL2_Main_Control_Destroy", "ADL2_Adapter_NumberOfAdapters_Get",
        "ADL2_Adapter_AdapterInfo_Get", "ADL2_Adapter_Active_Get", "ADL2_Overdrive_Caps",
        "ADL2_Overdrive8_Init_Setting_Get", "ADL2_Overdrive8_Init_SettingX2_Get",
        "ADL2_Overdrive8_Current_Setting_Get", "ADL2_Overdrive8_Current_SettingX2_Get",
        "ADL2_OverdriveN_CountOfEvents_Get",
    };

    /// <summary>An ADL write entry point has a "_Set" segment not followed by a lowercase letter ("_Setting" is a read).</summary>
    internal static bool IsWriteName(string name)
    {
        for (int i = name.IndexOf("_Set", StringComparison.Ordinal); i >= 0; i = name.IndexOf("_Set", i + 1, StringComparison.Ordinal))
        {
            int next = i + 4;
            if (next >= name.Length || !char.IsAsciiLetterLower(name[next])) return true;
        }
        return false;
    }

    public static void Run(Action<string, bool, string> check)
    {
        void Check(string name, bool ok, string detail = "") => check("native." + name, ok, detail);
        void Eq<T>(string name, T actual, T expected) =>
            Check(name, EqualityComparer<T>.Default.Equals(actual, expected), $"expected <{expected}> got <{actual}>");

        const BindingFlags All = BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

        // ── ADL import surface ──
        var adlDll = typeof(AdlNative).GetMethods(All).Select(m => m.GetCustomAttribute<DllImportAttribute>()?.Value)
                                      .FirstOrDefault(v => v is not null);
        Check("adl.dllFound", adlDll is not null);
        var imports = new List<(Type Type, MethodInfo Method, DllImportAttribute Import)>();
        Type[] types;
        try { types = typeof(NativeGuardSelfTest).Assembly.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t is not null).ToArray()!; }
        foreach (var t in types)
        {
            foreach (var m in t.GetMethods(All))
            {
                var di = m.GetCustomAttribute<DllImportAttribute>();
                if (di is null || adlDll is null) continue;
                if (string.Equals(Path.GetFileNameWithoutExtension(di.Value), Path.GetFileNameWithoutExtension(adlDll), StringComparison.OrdinalIgnoreCase))
                {
                    imports.Add((t, m, di));
                }
            }
        }
        Check("adl.onlyInAdlNative", imports.Count > 0 && imports.All(i => i.Type == typeof(AdlNative)),
            string.Join(", ", imports.Where(i => i.Type != typeof(AdlNative)).Select(i => i.Type.FullName + "." + i.Method.Name)));
        var entryPoints = imports.Select(i => string.IsNullOrEmpty(i.Import.EntryPoint) ? i.Method.Name : i.Import.EntryPoint!).ToList();
        Check("adl.whitelistExact", entryPoints.ToHashSet().SetEquals(AdlWhitelist) && entryPoints.Count == AdlWhitelist.Length,
            string.Join(", ", entryPoints));
        Check("adl.noWriteEntryPoint", entryPoints.All(n => !IsWriteName(n)) && AdlWhitelist.All(n => !IsWriteName(n)),
            string.Join(", ", entryPoints.Where(IsWriteName)));
        Check("adl.system32Only", imports.All(i =>
            i.Method.GetCustomAttribute<DefaultDllImportSearchPathsAttribute>()?.Paths == DllImportSearchPath.System32));
        Check("adl.writeNameRule", IsWriteName("ADL2_Overdrive8_Setting" + "_Set") && IsWriteName("X_Set_Y") && IsWriteName("X_SetY") &&
                                   !IsWriteName("ADL2_Overdrive8_Init_SettingX2_Get") && !IsWriteName("ADL2_Overdrive8_Current_Setting_Get"));

        // ── adl_structures.h layouts (Windows x64) ──
        Eq("adl.adapterInfoSize", Marshal.SizeOf<AdlNative.AdapterInfo>(), 1572);
        Eq("adl.adapterInfo.bus", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.iBusNumber)), 264);
        Eq("adl.adapterInfo.vendor", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.iVendorID)), 276);
        Eq("adl.adapterInfo.name", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.strAdapterName)), 280);
        Eq("adl.adapterInfo.present", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.iPresent)), 792);
        Eq("adl.adapterInfo.pnp", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.strPNPString)), 1312);
        Eq("adl.adapterInfo.osIndex", (int)Marshal.OffsetOf<AdlNative.AdapterInfo>(nameof(AdlNative.AdapterInfo.iOSDisplayIndex)), 1568);
        Eq("adl.singleInitSize", Marshal.SizeOf<AdlNative.ADLOD8SingleInitSetting>(), AdlNative.SingleInitSettingSize);
        Eq("adl.singleInitSize16", AdlNative.SingleInitSettingSize, 16);
        Eq("adl.od8Names", AdlNative.Od8SettingNames.Length, AdlNative.OD8_COUNT);

        // ── ADL allocation callback ──
        Eq("adl.alloc.zero", TuningService.AllocForAdl(0), IntPtr.Zero);
        Eq("adl.alloc.negative", TuningService.AllocForAdl(-5), IntPtr.Zero);
        Eq("adl.alloc.huge", TuningService.AllocForAdl(TuningService.MaxCallbackBytes + 1), IntPtr.Zero);
        Eq("adl.alloc.max", TuningService.AllocForAdl(int.MaxValue), IntPtr.Zero);
        IntPtr p = TuningService.AllocForAdl(5000);
        bool zeroed = p != IntPtr.Zero;
        if (p != IntPtr.Zero)
        {
            var bytes = new byte[5000];
            Marshal.Copy(p, bytes, 0, bytes.Length);
            zeroed = bytes.All(b => b == 0);
        }
        Check("adl.alloc.zeroed", zeroed);
        Eq("adl.alloc.tracked", TuningService.AllocatedBytes(p), 5000);
        Check("adl.alloc.free", TuningService.FreeAdl(p) && TuningService.AllocatedBytes(p) == -1 && !TuningService.FreeAdl(p));
        IntPtr foreign = Marshal.AllocHGlobal(16);
        try
        {
            Check("adl.alloc.foreignNotFreed", !TuningService.FreeAdl(foreign) && TuningService.AllocatedBytes(foreign) == -1);
        }
        finally
        {
            Marshal.FreeHGlobal(foreign);
        }
        Check("adl.alloc.nullFree", !TuningService.FreeAdl(IntPtr.Zero));
        Eq("adl.read.full", TuningService.ReadableEntries(77, 77 * 16, 16, 512), 77);
        Eq("adl.read.shortAlloc", TuningService.ReadableEntries(77, 10 * 16 + 15, 16, 512), 10);
        Eq("adl.read.cap", TuningService.ReadableEntries(9000, 1 << 20, 4, 512), 512);
        Eq("adl.read.foreign", TuningService.ReadableEntries(77, -1, 16, 512), 0);
        Eq("adl.read.zeroCount", TuningService.ReadableEntries(0, 1232, 16, 512), 0);
        Eq("adl.read.negativeCount", TuningService.ReadableEntries(-3, 1232, 16, 512), 0);

        // ── SMN (live DDR4 timings) ──
        Eq("smn.mutexName", PciBusGuard.MutexName, @"Global\Access_PCI");
        var pawnMethods = typeof(LibreHardwareMonitor.PawnIo.AmdFamily17).GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.DeclaredOnly)
                                                                          .Select(m => m.Name).ToList();
        Check("smn.pawnReadOnly", pawnMethods.Contains("ReadSmn") &&
                                  !pawnMethods.Any(n => n.Contains("Write", StringComparison.OrdinalIgnoreCase)),
            string.Join(", ", pawnMethods));
    }
}
