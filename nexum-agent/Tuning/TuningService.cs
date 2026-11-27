using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace NexumAgent.Tuning;

/// <summary>
/// GPU tuning step 0 (CONTRACT §1.7, ROADMAP §5): READ-ONLY AMD Overdrive8 state and probe.
/// <para>
/// Nothing in this class changes GPU settings. It only calls the read entry points declared in
/// <see cref="AdlNative"/> (CONTRACT §1.7.1 whitelist). There is no write path in this version: Program.cs
/// rejects <c>{cmd:"tuningProbe", write:true}</c> without calling into this class, and Rust rejects it before
/// that (CONTRACT §1.7.2, §2.14).
/// </para>
/// One private ADL context per call, destroyed before returning. Buffers ADL allocates through our callback are
/// zeroed, size-tracked and freed by us; a list pointer that did not come from the callback is never read or freed,
/// and a list is never read beyond the bytes the callback actually allocated.
/// </summary>
public static class TuningService
{
    /// <summary>CONTRACT §1.7.2: each call returns within 10 s.</summary>
    private const int TimeoutMs = 10_000;

    /// <summary>One ADL session at a time; a hung session keeps it until the driver returns.</summary>
    private static readonly SemaphoreSlim Session = new(1, 1);

    /// <summary>Kept alive for the whole process: ADL may call it during any call on a context created with it.</summary>
    private static readonly AdlNative.AdlMainMallocCallback Alloc = AllocForAdl;

    /// <summary>Every live callback allocation and its size in bytes.</summary>
    private static readonly ConcurrentDictionary<IntPtr, int> Allocations = new();

    /// <summary>Largest single callback allocation honoured (the OD8 lists are about 1.3 KB).</summary>
    internal const int MaxCallbackBytes = 1 << 20;

    private static readonly byte[] Zeros = new byte[4096];

    /// <summary>
    /// ADL_MAIN_MALLOC_CALLBACK. Runs on a native frame: it must never throw (an exception crossing back into the
    /// driver would end the elevated agent), so every failure returns NULL, which ADL reports as an error code.
    /// </summary>
    internal static IntPtr AllocForAdl(int size)
    {
        IntPtr p = IntPtr.Zero;
        try
        {
            if (size <= 0 || size > MaxCallbackBytes) return IntPtr.Zero;
            p = Marshal.AllocCoTaskMem(size);
            for (int off = 0; off < size; off += Zeros.Length)
            {
                Marshal.Copy(Zeros, 0, p + off, Math.Min(Zeros.Length, size - off));
            }
            Allocations[p] = size;
            return p;
        }
        catch
        {
            if (p != IntPtr.Zero)
            {
                try { Marshal.FreeCoTaskMem(p); } catch { /* ignore */ }
            }
            return IntPtr.Zero;
        }
    }

    /// <summary>Bytes the callback allocated at <paramref name="p"/>, or -1 when it did not come from the callback.</summary>
    internal static int AllocatedBytes(IntPtr p) => p != IntPtr.Zero && Allocations.TryGetValue(p, out int n) ? n : -1;

    /// <summary>Frees a callback allocation. A pointer the callback did not hand out is left alone (never freed with the wrong allocator).</summary>
    internal static bool FreeAdl(IntPtr p)
    {
        if (p == IntPtr.Zero || !Allocations.TryRemove(p, out _)) return false;
        Marshal.FreeCoTaskMem(p);
        return true;
    }

    /// <summary>
    /// Entries that may be read from a driver-returned list: the reported count, capped by <paramref name="max"/> and
    /// by the bytes actually allocated. 0 when the list did not come from our callback. Pure (self-tested).
    /// </summary>
    internal static int ReadableEntries(int reportedCount, int allocatedBytes, int entrySize, int max)
    {
        if (reportedCount <= 0 || allocatedBytes <= 0 || entrySize <= 0) return 0;
        return Math.Min(Math.Min(reportedCount, max), allocatedBytes / entrySize);
    }

    private const int AmdVendorId = 0x1002;

    /// <summary>
    /// <c>{cmd:"tuningGet"}</c>. Blocking (≤ 10 s), thread-safe, never throws (failures become
    /// <c>supported:false</c> / <c>reason:"adlError"</c>).
    /// </summary>
    public static TuningStateMessage GetState(bool isAdmin)
    {
        try
        {
            if (!isAdmin) return TuningStateMessage.Unsupported("notElevated", TuningStateMessage.MsgNotElevated);
            var snap = RunSession(withTables: false);
            return snap.State;
        }
        catch (Exception ex)
        {
            Program.Log($"Tuning state failed: {ex}");
            return TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError(ex.GetType().Name));
        }
    }

    /// <summary>
    /// <c>{cmd:"tuningProbe", write:false}</c>. Same guarantees as <see cref="GetState"/>. Read-only by construction:
    /// it records the raw caps, Init/Current tables, the VPU-recovery count and plausibility checks.
    /// </summary>
    public static TuningProbeMessage ProbeReadOnly(bool isAdmin)
    {
        var msg = new TuningProbeMessage();
        try
        {
            if (!isAdmin)
            {
                var st = TuningStateMessage.Unsupported("notElevated", TuningStateMessage.MsgNotElevated);
                msg.Report.State = st;
                msg.Report.Errors.Add(st.Message);
                msg.Ok = false;
                msg.Message = st.Message;
                return msg;
            }

            var snap = RunSession(withTables: true);
            msg.Report = snap.Report ?? new TuningProbeReport();
            msg.Report.State = snap.State;
            bool anything = msg.Report.Adapters.Count > 0 || msg.Report.InitTable.Count > 0 || msg.Report.CurrentTable.Count > 0;
            msg.Ok = anything;
            msg.Message = anything ? TuningProbeMessage.MsgOk : snap.State.Message;
            return msg;
        }
        catch (Exception ex)
        {
            Program.Log($"Tuning probe failed: {ex}");
            var st = TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError(ex.GetType().Name));
            msg.Report.State = st;
            msg.Report.Errors.Add($"Probe failed: {ex.Message}");
            msg.Ok = false;
            msg.Message = TuningProbeMessage.MsgNothingRead;
            return msg;
        }
    }

    // ---------------------------------------------------------------------------------------------

    private sealed class Snapshot
    {
        public TuningStateMessage State = new();
        public TuningProbeReport? Report;
    }

    /// <summary>Runs one ADL session on a worker thread and waits at most <see cref="TimeoutMs"/> in total.</summary>
    private static Snapshot RunSession(bool withTables)
    {
        var deadline = Environment.TickCount64 + TimeoutMs;
        if (!Session.Wait(TimeoutMs))
        {
            return Timeout(withTables);
        }

        Snapshot? result = null;
        Exception? error = null;
        var worker = new Thread(() =>
        {
            try { result = ReadAll(withTables); }
            catch (Exception ex) { error = ex; }
            finally { Session.Release(); }
        })
        { IsBackground = true, Name = "tuning-adl", Priority = ThreadPriority.BelowNormal };
        try
        {
            worker.Start();
        }
        catch
        {
            Session.Release();
            throw;
        }

        int remaining = (int)Math.Max(0, deadline - Environment.TickCount64);
        if (!worker.Join(remaining)) return Timeout(withTables);
        if (error is not null) throw error;
        return result ?? Timeout(withTables);
    }

    private static Snapshot Timeout(bool withTables)
    {
        Program.Log("Tuning: the ADL session did not finish within 10 s");
        var s = new Snapshot { State = TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError("timeout")) };
        if (withTables) s.Report = new TuningProbeReport { Errors = { "The ADL session did not finish within 10 s." } };
        return s;
    }

    private readonly record struct Adapter(int Index, string Name, int Bus, int VendorId, bool? Active);

    /// <summary>The whole read: context, adapters, caps, OD8 tables, VPU count. Context destroyed before returning.</summary>
    private static Snapshot ReadAll(bool withTables)
    {
        var snap = new Snapshot();
        var report = withTables ? new TuningProbeReport() : null;
        snap.Report = report;

        IntPtr ctx;
        int rc;
        try
        {
            rc = AdlNative.ADL2_Main_Control_Create(Alloc, 1, out ctx);
        }
        catch (DllNotFoundException)
        {
            snap.State = TuningStateMessage.Unsupported("adlMissing", TuningStateMessage.MsgAdlMissing);
            report?.Errors.Add("ADL library not found in System32.");
            return snap;
        }
        catch (EntryPointNotFoundException)
        {
            snap.State = TuningStateMessage.Unsupported("adlMissing", TuningStateMessage.MsgAdlMissing);
            report?.Errors.Add("ADL2_Main_Control_Create not exported by the installed ADL library.");
            return snap;
        }
        catch (BadImageFormatException)
        {
            snap.State = TuningStateMessage.Unsupported("adlMissing", TuningStateMessage.MsgAdlMissing);
            report?.Errors.Add("The installed ADL library could not be loaded.");
            return snap;
        }
        if (rc != AdlNative.ADL_OK || ctx == IntPtr.Zero)
        {
            snap.State = TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError(Code(rc)));
            report?.Errors.Add($"ADL2_Main_Control_Create returned {rc}.");
            return snap;
        }

        try
        {
            var adapters = Enumerate(ctx, report);
            if (report is not null)
            {
                report.Adapters = adapters
                    .Select(a => new ProbeAdapter { Index = a.Index, Name = a.Name, BusNumber = a.Bus, Active = a.Active, VendorId = a.VendorId })
                    .ToList();
            }

            // AMD GPUs, one entry per bus number, in ADL order (LHM enumerates ADL in the same order, deduplicated by bus).
            var amd = adapters.Where(a => a.VendorId == AmdVendorId && a.Bus > -1)
                              .GroupBy(a => a.Bus)
                              .Select(g => g.OrderByDescending(a => a.Active == true).First())
                              .ToList();
            if (amd.Count == 0)
            {
                snap.State = TuningStateMessage.Unsupported("noAmdGpu", TuningStateMessage.MsgNoAmdGpu);
                return snap;
            }

            // The first active AMD GPU that reports Overdrive 8; else the first active one; else the first one.
            var caps = amd.Select(a => (Adapter: a, Caps: OverdriveCaps(ctx, a.Index))).ToList();
            var pick = caps.FirstOrDefault(c => c.Adapter.Active == true && c.Caps.Version == 8);
            if (pick.Adapter == default) pick = caps.FirstOrDefault(c => c.Adapter.Active == true);
            if (pick.Adapter == default) pick = caps[0];
            int gpuIndex = amd.IndexOf(pick.Adapter);
            int? odVersion = pick.Caps.Rc == AdlNative.ADL_OK ? pick.Caps.Version : null;
            if (report is not null)
            {
                report.OdVersion = odVersion;
                if (pick.Caps.Rc != AdlNative.ADL_OK) report.Errors.Add($"ADL2_Overdrive_Caps returned {pick.Caps.Rc}.");
            }

            var init = ReadInit(ctx, pick.Adapter.Index, report);
            if (init.Rc != AdlNative.ADL_OK || init.Table is null)
            {
                bool notOd8 = odVersion is not 8;
                snap.State = notOd8
                    ? TuningStateMessage.Unsupported("odUnsupported", TuningStateMessage.MsgOdUnsupported, pick.Adapter.Name, odVersion, gpuIndex)
                    : TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError(Code(init.Rc)), pick.Adapter.Name, odVersion, gpuIndex);
                snap.State.VpuRecoveryCount = VpuCount(ctx, pick.Adapter.Index);
                if (report is not null) report.VpuRecoveryCount = snap.State.VpuRecoveryCount;
                return snap;
            }
            if (report is not null)
            {
                report.CapsBits = init.Caps;
                report.InitTable = init.Table.Select((e, i) => new ProbeInitEntry
                {
                    Index = i, FeatureName = FeatureName(i), Min = e.minValue, Max = e.maxValue, DefaultValue = e.defaultValue,
                }).ToList();
            }

            var current = ReadCurrent(ctx, pick.Adapter.Index, report);
            if (report is not null && current.Table is not null)
            {
                report.CurrentTable = current.Table.Select((v, i) => new ProbeCurrentEntry { Index = i, FeatureName = FeatureName(i), Value = v }).ToList();
            }

            int? vpu = VpuCount(ctx, pick.Adapter.Index);
            if (report is not null) report.VpuRecoveryCount = vpu;

            if (init.Caps == 0)
            {
                snap.State = TuningStateMessage.Unsupported("odUnsupported", TuningStateMessage.MsgOdUnsupported, pick.Adapter.Name, odVersion, gpuIndex);
                snap.State.VpuRecoveryCount = vpu;
            }
            else if (current.Rc != AdlNative.ADL_OK || current.Table is null)
            {
                snap.State = TuningStateMessage.Unsupported("adlError", TuningStateMessage.MsgAdlError(Code(current.Rc)), pick.Adapter.Name, odVersion, gpuIndex);
                snap.State.VpuRecoveryCount = vpu;
            }
            else
            {
                snap.State = BuildState(init.Caps, init.Table, current.Table);
                snap.State.AdapterName = pick.Adapter.Name;
                snap.State.GpuIndex = gpuIndex;
                snap.State.OdVersion = odVersion;
                snap.State.VpuRecoveryCount = vpu;
            }

            if (report is not null) report.Checks = Checks(init.Caps, init.Table, current.Table);
            return snap;
        }
        finally
        {
            try { AdlNative.ADL2_Main_Control_Destroy(ctx); }
            catch (Exception ex) { Program.Log($"Tuning: ADL context destroy failed: {ex.Message}"); }
        }
    }

    private static string Code(int rc) => rc.ToString(CultureInfo.InvariantCulture);

    private static string? FeatureName(int index) =>
        index >= 0 && index < AdlNative.Od8SettingNames.Length ? AdlNative.Od8SettingNames[index] : null;

    private static readonly Regex UdidVendor = new(@"PCI_VEN_([0-9A-Fa-f]{1,4})&", RegexOptions.Compiled);

    private static List<Adapter> Enumerate(IntPtr ctx, TuningProbeReport? report)
    {
        var list = new List<Adapter>();
        int rc = AdlNative.ADL2_Adapter_NumberOfAdapters_Get(ctx, out int n);
        if (rc != AdlNative.ADL_OK || n <= 0 || n > 256)
        {
            report?.Errors.Add($"ADL2_Adapter_NumberOfAdapters_Get returned {rc} ({n} adapters).");
            return list;
        }

        int size = Marshal.SizeOf<AdlNative.AdapterInfo>();
        IntPtr buf = Marshal.AllocCoTaskMem(size * n);
        try
        {
            // Zero the buffer so unused strings read as empty.
            for (int i = 0; i < size * n; i += 8)
            {
                if (i + 8 <= size * n) Marshal.WriteInt64(buf, i, 0);
                else for (int j = i; j < size * n; j++) Marshal.WriteByte(buf, j, 0);
            }
            rc = AdlNative.ADL2_Adapter_AdapterInfo_Get(ctx, buf, size * n);
            if (rc != AdlNative.ADL_OK)
            {
                report?.Errors.Add($"ADL2_Adapter_AdapterInfo_Get returned {rc}.");
                return list;
            }
            for (int i = 0; i < n; i++)
            {
                var info = Marshal.PtrToStructure<AdlNative.AdapterInfo>(buf + i * size);
                // ADL's iVendorID is unreliable on Windows; the UDID carries PCI_VEN_xxxx (as LHM does).
                // The UDID itself (device instance path) is never reported.
                int vendor = info.iVendorID;
                var m = UdidVendor.Match(info.strUDID ?? "");
                if (m.Success) vendor = int.Parse(m.Groups[1].Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                else if (vendor == 1002) vendor = AmdVendorId;

                bool? active = null;
                try
                {
                    if (AdlNative.ADL2_Adapter_Active_Get(ctx, info.iAdapterIndex, out int st) == AdlNative.ADL_OK) active = st != 0;
                }
                catch (EntryPointNotFoundException) { /* older driver */ }

                list.Add(new Adapter(info.iAdapterIndex, (info.strAdapterName ?? "").Trim(), info.iBusNumber, vendor, active));
            }
        }
        finally
        {
            Marshal.FreeCoTaskMem(buf);
        }
        return list;
    }

    private static (int Rc, int Supported, int Enabled, int Version) OverdriveCaps(IntPtr ctx, int adapterIndex)
    {
        try
        {
            int rc = AdlNative.ADL2_Overdrive_Caps(ctx, adapterIndex, out int s, out int e, out int v);
            return (rc, s, e, v);
        }
        catch (EntryPointNotFoundException)
        {
            return (-8, 0, 0, 0);
        }
    }

    private static int? VpuCount(IntPtr ctx, int adapterIndex)
    {
        try
        {
            int rc = AdlNative.ADL2_OverdriveN_CountOfEvents_Get(ctx, adapterIndex, AdlNative.ADL_ODN_EVENTCOUNTER_VPURECOVERY, out int count);
            return rc == AdlNative.ADL_OK && count >= 0 ? count : null;
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }
    }

    /// <summary>Upper bound on table entries we accept from the driver (OD8_COUNT is 77 in the current headers).</summary>
    private const int MaxFeatures = 512;

    private static (int Rc, int Caps, AdlNative.ADLOD8SingleInitSetting[]? Table) ReadInit(IntPtr ctx, int adapterIndex, TuningProbeReport? report)
    {
        try
        {
            IntPtr list = IntPtr.Zero;
            try
            {
                int caps = 0, count = AdlNative.OD8_COUNT;
                int rc = AdlNative.ADL2_Overdrive8_Init_SettingX2_Get(ctx, adapterIndex, ref caps, ref count, ref list);
                if (rc != AdlNative.ADL_OK || list == IntPtr.Zero || count <= 0)
                {
                    report?.Errors.Add($"ADL2_Overdrive8_Init_SettingX2_Get returned {rc} ({count} features).");
                    return (rc != AdlNative.ADL_OK ? rc : -1, caps, null);
                }
                int allocated = AllocatedBytes(list);
                if (allocated < 0)
                {
                    report?.Errors.Add("ADL2_Overdrive8_Init_SettingX2_Get returned a list that Nexum did not allocate; it was not read.");
                    list = IntPtr.Zero; // never freed with the wrong allocator
                    return (-1, caps, null);
                }
                count = ReadableEntries(count, allocated, AdlNative.SingleInitSettingSize, MaxFeatures);
                if (count == 0) return (-1, caps, null);
                var table = new AdlNative.ADLOD8SingleInitSetting[count];
                for (int i = 0; i < count; i++)
                {
                    table[i] = Marshal.PtrToStructure<AdlNative.ADLOD8SingleInitSetting>(list + i * AdlNative.SingleInitSettingSize);
                }
                return (rc, caps, table);
            }
            finally
            {
                FreeAdl(list);
            }
        }
        catch (EntryPointNotFoundException)
        {
            report?.Errors.Add("ADL2_Overdrive8_Init_SettingX2_Get is not exported; using ADL2_Overdrive8_Init_Setting_Get.");
            return ReadInitLegacy(ctx, adapterIndex, report);
        }
    }

    /// <summary>
    /// typedef struct ADLOD8InitSetting { int count; int overdrive8Capabilities; ADLOD8SingleInitSetting od8SettingTable[OD8_COUNT]; }.
    /// Caller-allocated: an oversized zeroed buffer with count = OD8_COUNT.
    /// </summary>
    private static (int Rc, int Caps, AdlNative.ADLOD8SingleInitSetting[]? Table) ReadInitLegacy(IntPtr ctx, int adapterIndex, TuningProbeReport? report)
    {
        int bytes = 8 + MaxFeatures * AdlNative.SingleInitSettingSize;
        IntPtr buf = Marshal.AllocCoTaskMem(bytes);
        try
        {
            for (int i = 0; i < bytes; i += 4) Marshal.WriteInt32(buf, i, 0);
            Marshal.WriteInt32(buf, 0, AdlNative.OD8_COUNT);
            int rc;
            try { rc = AdlNative.ADL2_Overdrive8_Init_Setting_Get(ctx, adapterIndex, buf); }
            catch (EntryPointNotFoundException) { report?.Errors.Add("No Overdrive8 Init entry point is exported."); return (-8, 0, null); }
            if (rc != AdlNative.ADL_OK)
            {
                report?.Errors.Add($"ADL2_Overdrive8_Init_Setting_Get returned {rc}.");
                return (rc, 0, null);
            }
            int count = Math.Clamp(Marshal.ReadInt32(buf, 0), 0, AdlNative.OD8_COUNT);
            int caps = Marshal.ReadInt32(buf, 4);
            var table = new AdlNative.ADLOD8SingleInitSetting[count];
            for (int i = 0; i < count; i++)
            {
                table[i] = Marshal.PtrToStructure<AdlNative.ADLOD8SingleInitSetting>(buf + 8 + i * AdlNative.SingleInitSettingSize);
            }
            return (rc, caps, table);
        }
        finally
        {
            Marshal.FreeCoTaskMem(buf);
        }
    }

    private static (int Rc, int[]? Table) ReadCurrent(IntPtr ctx, int adapterIndex, TuningProbeReport? report)
    {
        try
        {
            IntPtr list = IntPtr.Zero;
            try
            {
                int count = AdlNative.OD8_COUNT;
                int rc = AdlNative.ADL2_Overdrive8_Current_SettingX2_Get(ctx, adapterIndex, ref count, ref list);
                if (rc != AdlNative.ADL_OK || list == IntPtr.Zero || count <= 0)
                {
                    report?.Errors.Add($"ADL2_Overdrive8_Current_SettingX2_Get returned {rc} ({count} features).");
                    return (rc != AdlNative.ADL_OK ? rc : -1, null);
                }
                int allocated = AllocatedBytes(list);
                if (allocated < 0)
                {
                    report?.Errors.Add("ADL2_Overdrive8_Current_SettingX2_Get returned a list that Nexum did not allocate; it was not read.");
                    list = IntPtr.Zero; // never freed with the wrong allocator
                    return (-1, null);
                }
                count = ReadableEntries(count, allocated, sizeof(int), MaxFeatures);
                if (count == 0) return (-1, null);
                var table = new int[count];
                Marshal.Copy(list, table, 0, count);
                return (rc, table);
            }
            finally
            {
                FreeAdl(list);
            }
        }
        catch (EntryPointNotFoundException)
        {
            report?.Errors.Add("ADL2_Overdrive8_Current_SettingX2_Get is not exported; using ADL2_Overdrive8_Current_Setting_Get.");
            int bytes = 4 + MaxFeatures * 4;
            IntPtr buf = Marshal.AllocCoTaskMem(bytes);
            try
            {
                for (int i = 0; i < bytes; i += 4) Marshal.WriteInt32(buf, i, 0);
                Marshal.WriteInt32(buf, 0, AdlNative.OD8_COUNT);
                int rc;
                try { rc = AdlNative.ADL2_Overdrive8_Current_Setting_Get(ctx, adapterIndex, buf); }
                catch (EntryPointNotFoundException) { report?.Errors.Add("No Overdrive8 Current entry point is exported."); return (-8, null); }
                if (rc != AdlNative.ADL_OK)
                {
                    report?.Errors.Add($"ADL2_Overdrive8_Current_Setting_Get returned {rc}.");
                    return (rc, null);
                }
                int count = Math.Clamp(Marshal.ReadInt32(buf, 0), 0, AdlNative.OD8_COUNT);
                var table = new int[count];
                Marshal.Copy(buf + 4, table, 0, count);
                return (rc, table);
            }
            finally
            {
                Marshal.FreeCoTaskMem(buf);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Pure mapping (unit-tested by --selftest)

    /// <summary>Maps the OD8 tables to the CONTRACT §1.7.3 state (supported:true). Pure.</summary>
    internal static TuningStateMessage BuildState(int capsBits, IReadOnlyList<AdlNative.ADLOD8SingleInitSetting> init, IReadOnlyList<int> current)
    {
        bool Has(int bit) => (capsBits & bit) == bit;
        bool InInit(int i) => i >= 0 && i < init.Count;
        double? Cur(int i) => i >= 0 && i < current.Count ? current[i] : null;
        TuningRangeDto? Range(int i, bool cap) => cap && InInit(i)
            ? new TuningRangeDto { Min = init[i].minValue, Max = init[i].maxValue, Step = 1, Default = init[i].defaultValue }
            : null;

        var caps = new TuningCapsDto
        {
            PowerLimit = Has(AdlNative.ADL_OD8_POWER_LIMIT),
            AutoUndervolt = Has(AdlNative.ADL_OD8_AUTO_UV_ENGINE),
            FanCurve = Has(AdlNative.ADL_OD8_FAN_CURVE),
            ZeroRpm = Has(AdlNative.ADL_OD8_FAN_ZERO_RPM_CONTROL),
            VoltageOffset = Has(AdlNative.ADL_OD8_ODVOLTAGE_LIMIT),
            GfxClockMax = Has(AdlNative.ADL_OD8_GFXCLK_LIMITS),
            MemClockMax = Has(AdlNative.ADL_OD8_UCLK_MAX),
        };

        var ranges = new TuningRangesDto
        {
            PowerPct = Range(AdlNative.OD8_POWER_PERCENTAGE, caps.PowerLimit),
            VoltageOffsetMv = Range(AdlNative.OD8_OD_VOLTAGE, caps.VoltageOffset),
            GfxClockMaxMhz = Range(AdlNative.OD8_GFXCLK_FMAX, caps.GfxClockMax),
            MemClockMaxMhz = Range(AdlNative.OD8_UCLK_FMAX, caps.MemClockMax),
            FanCurveTempC = FanRange(init, caps.FanCurve, speed: false),
            FanCurvePct = FanRange(init, caps.FanCurve, speed: true),
        };

        List<FanCurvePointDto>? curve = null;
        if (caps.FanCurve)
        {
            curve = new List<FanCurvePointDto>(5);
            for (int p = 0; p < 5; p++)
            {
                var t = Cur(AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p);
                var s = Cur(AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p + 1);
                if (t is null || s is null) { curve = null; break; }
                curve.Add(new FanCurvePointDto { TempC = t.Value, Pct = s.Value });
            }
        }

        var cur = new TuningCurrentDto
        {
            PowerPct = caps.PowerLimit ? Cur(AdlNative.OD8_POWER_PERCENTAGE) : null,
            AutoUndervolt = caps.AutoUndervolt && Cur(AdlNative.OD8_AUTO_UV_ENGINE_CONTROL) is double uv ? uv != 0 : null,
            ZeroRpm = caps.ZeroRpm && Cur(AdlNative.OD8_FAN_ZERORPM_CONTROL) is double z ? z != 0 : null,
            VoltageOffsetMv = caps.VoltageOffset ? Cur(AdlNative.OD8_OD_VOLTAGE) : null,
            GfxClockMaxMhz = caps.GfxClockMax ? Cur(AdlNative.OD8_GFXCLK_FMAX) : null,
            MemClockMaxMhz = caps.MemClockMax ? Cur(AdlNative.OD8_UCLK_FMAX) : null,
            FanCurve = curve,
        };

        // isFactory: every capped current value equals its default (features whose default is null are ignored).
        bool factory = true;
        void Cmp(double? value, TuningRangeDto? range)
        {
            if (value is null || range?.Default is null) return;
            if (value.Value != range.Default.Value) factory = false;
        }
        Cmp(cur.PowerPct, ranges.PowerPct);
        Cmp(cur.VoltageOffsetMv, ranges.VoltageOffsetMv);
        Cmp(cur.GfxClockMaxMhz, ranges.GfxClockMaxMhz);
        Cmp(cur.MemClockMaxMhz, ranges.MemClockMaxMhz);
        if (caps.ZeroRpm && cur.ZeroRpm is bool zr && InInit(AdlNative.OD8_FAN_ZERORPM_CONTROL))
        {
            if (zr != (init[AdlNative.OD8_FAN_ZERORPM_CONTROL].defaultValue != 0)) factory = false;
        }
        if (caps.AutoUndervolt && cur.AutoUndervolt is bool au && InInit(AdlNative.OD8_AUTO_UV_ENGINE_CONTROL))
        {
            if (au != (init[AdlNative.OD8_AUTO_UV_ENGINE_CONTROL].defaultValue != 0)) factory = false;
        }

        string? powerMode = Has(AdlNative.ADL_OD8_OPTIMIZED_GPU_POWER_MODE) && Cur(AdlNative.OD8_OPTIMZED_POWER_MODE) is double pm
            ? ((int)pm).ToString(CultureInfo.InvariantCulture)
            : null;

        return new TuningStateMessage
        {
            Supported = true,
            Reason = null,
            Message = TuningStateMessage.MsgSupported,
            Caps = caps,
            Ranges = ranges,
            Current = cur,
            IsFactory = factory,
            Mode = cur.AutoUndervolt == true ? "autoUndervolt" : factory ? "factory" : "custom",
            PowerMode = powerMode,
        };
    }

    /// <summary>Fan-curve range: min of the five points' minimums, max of their maximums; default null (CONTRACT §1.7.3).</summary>
    private static TuningRangeDto? FanRange(IReadOnlyList<AdlNative.ADLOD8SingleInitSetting> init, bool cap, bool speed)
    {
        if (!cap) return null;
        int? min = null, max = null;
        for (int p = 0; p < 5; p++)
        {
            int i = AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p + (speed ? 1 : 0);
            if (i >= init.Count) return null;
            min = min is null ? init[i].minValue : Math.Min(min.Value, init[i].minValue);
            max = max is null ? init[i].maxValue : Math.Max(max.Value, init[i].maxValue);
        }
        return min is null || max is null ? null : new TuningRangeDto { Min = min.Value, Max = max.Value, Step = 1, Default = null };
    }

    /// <summary>Plausibility checks for the probe report (ROADMAP §5.3 questions). Pure.</summary>
    internal static List<string> Checks(int capsBits, IReadOnlyList<AdlNative.ADLOD8SingleInitSetting> init, IReadOnlyList<int>? current)
    {
        var list = new List<string>();
        list.Add(capsBits != 0
            ? $"Overdrive8 capability bits reported: 0x{capsBits:X}."
            : "Overdrive8 reported no capability bits.");

        int badRanges = 0, badDefaults = 0, outOfRange = 0;
        var outIdx = new List<int>();
        for (int i = 0; i < init.Count; i++)
        {
            var e = init[i];
            if ((capsBits & e.featureID) == 0 || e.featureID == 0) continue; // feature not offered
            if (e.minValue > e.maxValue) badRanges++;
            else if (e.defaultValue < e.minValue || e.defaultValue > e.maxValue) badDefaults++;
            if (current is not null && i < current.Count && e.minValue <= e.maxValue
                && (current[i] < e.minValue || current[i] > e.maxValue))
            {
                outOfRange++;
                outIdx.Add(i);
            }
        }
        list.Add(badRanges == 0 ? "Every offered range has min <= max." : $"{badRanges} offered range(s) have min > max.");
        list.Add(badDefaults == 0 ? "Every offered default lies inside its range." : $"{badDefaults} offered default(s) lie outside their range.");
        if (current is null) list.Add("The current table could not be read.");
        else list.Add(outOfRange == 0
            ? "Every offered current value lies inside its range."
            : $"{outOfRange} offered current value(s) lie outside their range (indices {string.Join(", ", outIdx)}).");

        if ((capsBits & AdlNative.ADL_OD8_FAN_CURVE) != 0 && current is not null && current.Count > AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 9)
        {
            bool ordered = true;
            for (int p = 1; p < 5; p++)
            {
                int t0 = current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * (p - 1)], t1 = current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p];
                int s0 = current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * (p - 1) + 1], s1 = current[AdlNative.OD8_FAN_CURVE_TEMPERATURE_1 + 2 * p + 1];
                if (t1 < t0 || s1 < s0) ordered = false;
            }
            list.Add(ordered ? "The current fan curve is non-decreasing." : "The current fan curve is not non-decreasing.");
        }

        if ((capsBits & AdlNative.ADL_OD8_GFXCLK_LIMITS) != 0 && init.Count > AdlNative.OD8_GFXCLK_FMAX
            && init[AdlNative.OD8_GFXCLK_FMAX].minValue < 0)
        {
            var g = init[AdlNative.OD8_GFXCLK_FMAX];
            list.Add($"OD8_GFXCLK_FMAX has a negative minimum ({g.minValue} to {g.maxValue}, default {g.defaultValue}): " +
                     "on this GPU it behaves like a clock offset in MHz, not an absolute maximum clock.");
        }

        bool stopTemp = init.Count > AdlNative.OD8_FAN_ZERO_RPM_STOP_TEMPERATURE
                        && init[AdlNative.OD8_FAN_ZERO_RPM_STOP_TEMPERATURE] is var st
                        && st.featureID != 0 && (capsBits & st.featureID) != 0;
        list.Add(stopTemp
            ? "A zero-RPM stop temperature is exposed (OD8_FAN_ZERO_RPM_STOP_TEMPERATURE)."
            : "No zero-RPM stop temperature is exposed; only the on/off switch can be offered.");
        list.Add("Not answerable read-only: whether a write takes effect, survives a reboot, or which temperature the OD8 fan curve follows.");
        return list;
    }
}
