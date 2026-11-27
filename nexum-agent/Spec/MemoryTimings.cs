using LibreHardwareMonitor.PawnIo;

namespace NexumAgent.Spec;

/// <summary>
/// Live DDR4 timings from the AMD Zen 1–3 memory controller (UMC) over SMN (CONTRACT §1.4.1).
/// <para>
/// Register map and bit fields: ZenStates-Core by Ivan Rusanov (irusanov), GPL-3.0,
/// <c>Dictionaries/DDR4Dictionary.cs</c> (UMC timing registers 0x50200–0x50218) and
/// <c>Hardware/DRAM/Ddr4Timings.cs</c> (ratio at 0x50200[6:0] ÷ 3, tRFC registers 0x50260/0x50264 and the
/// fine-granularity refresh mode at 0x5012C[18:16]), commit 869b7e82572337e5a673e92230edc92bddf0e44b
/// (https://github.com/irusanov/ZenStates-Core). Nexum is GPL-3.0, so the derived map is compatible; the
/// attribution is listed in licenses/THIRD_PARTY.txt.
/// </para>
/// Reads only: the PawnIO AMDFamily17 module's <c>ioctl_read_smn</c>. Nothing here writes to hardware.
/// </summary>
internal static class MemoryTimings
{
    // ── Exact timingsNote strings (CONTRACT §1.4.1 table) ──
    public const string NoteNotElevated = "Live timings need administrator rights.";
    public const string NoteNoPawnIo = "Live timings need the PawnIO driver.";
    public const string NoteUnsupportedPlatform = "Live timings are only read on AMD Ryzen (Zen 1 to Zen 3) with DDR4.";
    public const string NoteBusBusy = "The PCI bus was busy (another hardware tool?).";
    public const string NoteImplausible = "The memory controller returned implausible values.";
    public const string NoteFailed = "Live timings could not be read.";

    /// <summary>UMC channel stride on Zen 1–3 (channel n registers at n × 0x100000 + 0x50xxx).</summary>
    private const uint ChannelStride = 0x100000;
    private const int Channels = 2; // AM4: two UMCs

    // Registers (ZenStates-Core DDR4Dictionary.cs / Ddr4Timings.cs).
    internal const uint RegRefreshMode = 0x5012C; // FGR [18:16]
    internal const uint RegRatio = 0x50200;       // Ratio [6:0], Cmd2T [10], GDM [11]
    internal const uint RegT1 = 0x50204;          // CL [5:0], RAS [14:8], RCDRD [21:16], RCDWR [29:24]
    internal const uint RegT2 = 0x50208;          // RC [7:0], RP [21:16]
    internal const uint RegT3 = 0x5020C;          // RRDS [4:0], RRDL [12:8], RTP [28:24]
    internal const uint RegT4 = 0x50210;          // FAW [6:0]
    internal const uint RegT5 = 0x50214;          // CWL [5:0], WTRS [12:8], WTRL [22:16]
    internal const uint RegT6 = 0x50218;          // WR [6:0]
    internal const uint RegRfc0 = 0x50260;        // RFC [10:0], RFC2 [21:11], RFC4 [31:22]
    internal const uint RegRfc1 = 0x50264;

    /// <summary>One channel's raw registers (also the input of the self-test vectors).</summary>
    internal readonly record struct UmcRegisters(
        uint RefreshMode, uint Ratio, uint T1, uint T2, uint T3, uint T4, uint T5, uint T6, uint Rfc0, uint Rfc1);

    /// <summary>Result of the once-per-process live read.</summary>
    internal sealed class LiveResult
    {
        public MemoryTimingsDto? Timings;
        /// <summary>MEMCLK in MHz from the UMC ratio (ratio ÷ 3 × 100), or null.</summary>
        public double? MemclkMhz;
        /// <summary>null on success, else the exact timingsNote.</summary>
        public string? Note;
        /// <summary>"Memory timings query failed: …" line for errors, or null.</summary>
        public string? Error;
    }

    private static readonly object CacheGate = new();
    private static LiveResult? _cache;

    /// <summary>
    /// The live read, done once per agent process (first call) and cached, including the failure
    /// (CONTRACT §1.4.1). Blocking (≤ ~2.5 s when another tool holds the PCI bus); call from the spec thread.
    /// </summary>
    public static LiveResult GetLive(string cpuVendor, int family, string memoryType)
    {
        lock (CacheGate)
        {
            return _cache ??= ReadLive(cpuVendor, family, memoryType);
        }
    }

    /// <summary>Why live timings are skipped, before touching any driver; null = go ahead.</summary>
    internal static string? Precondition(string cpuVendor, int family, string memoryType, bool isAdmin, bool driverOk)
    {
        if (cpuVendor != "AMD" || family is not (0x17 or 0x19) || memoryType != "DDR4") return NoteUnsupportedPlatform;
        if (!isAdmin) return NoteNotElevated;
        if (!driverOk) return NoteNoPawnIo;
        return null;
    }

    private static LiveResult ReadLive(string cpuVendor, int family, string memoryType)
    {
        var pre = Precondition(cpuVendor, family, memoryType, Program.IsAdmin, Program.SensorDriverOk);
        if (pre is not null) return new LiveResult { Note = pre };

        AmdFamily17? smn = null;
        try
        {
            smn = new AmdFamily17();
            for (int ch = 0; ch < Channels; ch++)
            {
                uint baseAddr = (uint)ch * ChannelStride;
                UmcRegisters regs;
                using (var lease = PciBusGuard.AcquireWithRetry())
                {
                    if (!lease.Acquired) return new LiveResult { Note = NoteBusBusy };
                    // Populated check first (one read), then the rest of the batch under the same lease.
                    uint t1 = smn.ReadSmn(baseAddr | RegT1);
                    if (!IsPopulated(t1)) continue;
                    regs = new UmcRegisters(
                        RefreshMode: smn.ReadSmn(baseAddr | RegRefreshMode),
                        Ratio: smn.ReadSmn(baseAddr | RegRatio),
                        T1: t1,
                        T2: smn.ReadSmn(baseAddr | RegT2),
                        T3: smn.ReadSmn(baseAddr | RegT3),
                        T4: smn.ReadSmn(baseAddr | RegT4),
                        T5: smn.ReadSmn(baseAddr | RegT5),
                        T6: smn.ReadSmn(baseAddr | RegT6),
                        Rfc0: smn.ReadSmn(baseAddr | RegRfc0),
                        Rfc1: smn.ReadSmn(baseAddr | RegRfc1));
                }

                var (timings, memclk) = Decode(regs);
                if (!IsPlausible(timings))
                {
                    Program.Log($"Memory timings: channel {ch} implausible (CL {timings.Cl}, RAS {timings.Ras}); discarded");
                    return new LiveResult { Note = NoteImplausible };
                }
                return new LiveResult { Timings = timings, MemclkMhz = memclk };
            }
            // No channel looked populated: the controller answered, but with nothing usable.
            return new LiveResult { Note = NoteImplausible };
        }
        catch (Exception ex)
        {
            Program.Log($"Memory timings read failed: {ex}");
            return new LiveResult { Note = NoteFailed, Error = $"Memory timings query failed: {ex.Message}" };
        }
        finally
        {
            try { smn?.Close(); } catch { /* best effort */ }
        }
    }

    /// <summary>CONTRACT §1.4.1: a channel is populated if its timing register is neither 0 nor all ones.</summary>
    internal static bool IsPopulated(uint t1) => t1 != 0 && t1 != 0xFFFFFFFF;

    /// <summary>CONTRACT §1.4.1: CL in 8..40 and tRAS ≥ CL.</summary>
    internal static bool IsPlausible(MemoryTimingsDto t) =>
        t.Cl is >= 8 and <= 40 && t.Ras is int ras && ras >= t.Cl.Value;

    /// <summary>Bits [hi:lo] of <paramref name="v"/> (ZenStates-Core Utils.BitSlice).</summary>
    internal static uint Bits(uint v, int hi, int lo) => (uint)((v >> lo) & ((1UL << (hi - lo + 1)) - 1));

    /// <summary>Pure decode of one channel (ZenStates-Core DDR4Dictionary.cs / Ddr4Timings.cs bit fields).</summary>
    internal static (MemoryTimingsDto Timings, double? MemclkMhz) Decode(UmcRegisters r)
    {
        // tRFC register pair: ZenStates picks the first unless both differ and the first holds the reset pattern.
        uint rfcReg = r.Rfc0 != r.Rfc1 ? (r.Rfc0 != 0x21060138 ? r.Rfc0 : r.Rfc1) : r.Rfc0;
        int? rfc = null;
        if (rfcReg != 0)
        {
            uint rfc1 = Bits(rfcReg, 10, 0), rfc2 = Bits(rfcReg, 21, 11), rfc4 = Bits(rfcReg, 31, 22);
            // Report the tRFC of the refresh mode in use: FGR 0 = 1x, 1/5 = 2x, 2/6 = 4x (DDR4 MR3 A8:A6 encoding).
            rfc = Bits(r.RefreshMode, 18, 16) switch
            {
                1 or 5 => (int)rfc2,
                2 or 6 => (int)rfc4,
                _ => (int)rfc1,
            };
            if (rfc == 0) rfc = null;
        }

        var t = new MemoryTimingsDto
        {
            Cl = (int)Bits(r.T1, 5, 0),
            Ras = (int)Bits(r.T1, 14, 8),
            RcdRd = (int)Bits(r.T1, 21, 16),
            RcdWr = (int)Bits(r.T1, 29, 24),
            Rc = (int)Bits(r.T2, 7, 0),
            Rp = (int)Bits(r.T2, 21, 16),
            Rrds = (int)Bits(r.T3, 4, 0),
            Rrdl = (int)Bits(r.T3, 12, 8),
            Rtp = (int)Bits(r.T3, 28, 24),
            Faw = (int)Bits(r.T4, 6, 0),
            Cwl = (int)Bits(r.T5, 5, 0),
            Wtrs = (int)Bits(r.T5, 12, 8),
            Wtrl = (int)Bits(r.T5, 22, 16),
            Wr = (int)Bits(r.T6, 6, 0),
            Rfc = rfc,
            CommandRate = Bits(r.Ratio, 10, 10) == 1 ? "2T" : "1T",
            GearDown = Bits(r.Ratio, 11, 11) == 1,
        };

        uint ratio = Bits(r.Ratio, 6, 0);
        double? memclk = ratio > 0 ? Math.Round(ratio / 3.0 * 100.0, 0, MidpointRounding.AwayFromZero) : null;
        return (t, memclk);
    }

    /// <summary>SPD fallback: the first DIMM's JEDEC cycles mapped to <see cref="MemoryTimingsDto"/>.</summary>
    internal static MemoryTimingsDto FromSpd(SpdCyclesDto c) => new()
    {
        Cl = c.Cl,
        RcdRd = c.Rcd, // JEDEC has one tRCD for reads and writes
        RcdWr = c.Rcd,
        Rp = c.Rp,
        Ras = c.Ras,
        Rc = c.Rc,
        Rfc = c.Rfc,
        Rrds = c.Rrds,
        Rrdl = c.Rrdl,
        Faw = c.Faw,
        Wtrs = c.Wtrs,
        Wtrl = c.Wtrl,
        Wr = c.Wr,
        Rtp = null,  // not an SPD field on DDR4
        Cwl = null,  // not an SPD field
        CommandRate = null,
        GearDown = null,
    };
}
