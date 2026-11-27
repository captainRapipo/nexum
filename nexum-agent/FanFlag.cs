using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace NexumAgent;

/// <summary>
/// The fan-control write-ahead flag <c>%ProgramData%\Nexum\fan-manual.flag</c> and its protected
/// state folder (CONTRACT §1.5.3). The folder ACL follows the lesson of CVE-2021-44226: an elevated
/// process must never write into a folder (or through a link) that a standard user can plant.
/// </summary>
internal static class FanFlag
{
    public const string FlagNone = "none";
    public const string FlagInterrupted = "interrupted";
    public const string FlagPreviousBoot = "previousBoot";

    public const string ModePreset = "preset";
    public const string ModeFanSet = "fanSet";
    public const string ModeOverride = "override";
    public const string ModeFailsafe = "failsafe";

    /// <summary>Two boots are "the same" when their boot timestamps differ by at most this (no BootId available).</summary>
    private const long SameBootToleranceMs = 120_000;

    private static readonly SecurityIdentifier SystemSid = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier AdminsSid = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier UsersSid = new(WellKnownSidType.BuiltinUsersSid, null);

    /// <summary>
    /// Rights that must never be granted to a non-admin SID on the state folder. Includes the raw
    /// GENERIC_ALL (0x10000000) and GENERIC_WRITE (0x40000000) bits, which an ACE can carry unmapped
    /// and which <see cref="FileSystemRights"/> has no named member for.
    /// </summary>
    private const FileSystemRights DangerousRights =
        FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes |
        FileSystemRights.WriteAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles |
        FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership |
        (FileSystemRights)0x10000000 | (FileSystemRights)0x40000000;

    public static string FolderPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Nexum");

    public static string FlagPath => Path.Combine(FolderPath, "fan-manual.flag");

    // ---------------------------------------------------------------------------------------------
    // Boot identity

    /// <summary>Unix ms of the current boot: now − TickCount64.</summary>
    public static long CurrentBootTs() =>
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Environment.TickCount64;

    /// <summary>DWORD BootId from PrefetchParameters, or null when absent/unreadable.</summary>
    public static long? CurrentBootId()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters", writable: false);
            var v = key?.GetValue("BootId");
            return v switch
            {
                int i => (uint)i,
                long l => l,
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    internal static bool IsSameBoot(long? flagBootId, long? flagBootTs, long? currentBootId, long currentBootTs)
    {
        if (flagBootId.HasValue && currentBootId.HasValue) return flagBootId.Value == currentBootId.Value;
        if (!flagBootTs.HasValue) return true; // corrupt / incomplete → treat as same boot (safe side)
        return Math.Abs(flagBootTs.Value - currentBootTs) <= SameBootToleranceMs;
    }

    // ---------------------------------------------------------------------------------------------
    // Start-up check

    /// <summary>
    /// Reads the flag at agent start and returns "none" | "interrupted" | "previousBoot". An elevated
    /// agent deletes a flag from a previous boot; a non-elevated agent never deletes.
    /// </summary>
    public static string CheckAtStart(bool elevated)
    {
        string path = FlagPath;
        FileAttributes attrs;
        try
        {
            if (!File.Exists(path) && !IsLink(path)) return FlagNone;
        }
        catch (Exception ex)
        {
            // Present but unreadable: same boot (safe side).
            Program.Log($"Fan flag check failed: {ex.Message}");
            return FlagInterrupted;
        }

        // Only a flag inside a folder this agent secured can come from Nexum: the agent writes the flag
        // only after EnsureSecureFolder() made the folder admin-only, and a standard user cannot undo
        // that. A flag in a folder that is a link, or that a non-admin controls, was planted (e.g. a
        // standard user pre-created C:\ProgramData\Nexum before the first elevated run) and must not
        // force fans to 100% (or, if corrupt, lock fan control on every boot).
        if (elevated && FolderIsUntrusted(out var why))
        {
            Program.Log($"Ignoring a fan flag that Nexum did not write ({why})");
            try
            {
                if (EnsureSecureFolder(out var err)) File.Delete(path);
                else Program.Log($"Could not secure the Nexum state folder ({err}); fan control stays unavailable");
            }
            catch (Exception ex)
            {
                Program.Log($"Could not delete the untrusted fan flag: {ex.Message}");
            }
            return FlagNone;
        }

        try
        {
            attrs = File.GetAttributes(path);
        }
        catch (Exception ex)
        {
            // Present but unreadable: same boot (safe side).
            Program.Log($"Fan flag check failed: {ex.Message}");
            return FlagInterrupted;
        }

        if ((attrs & FileAttributes.ReparsePoint) != 0)
        {
            Program.Log("Fan flag is a reparse point; treating it as an interrupted session");
            return FlagInterrupted;
        }

        long? bootId = null, bootTs = null;
        try
        {
            string text;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var sr = new StreamReader(fs, Encoding.UTF8))
            {
                var buf = new char[4096];
                int n = sr.ReadBlock(buf, 0, buf.Length);
                text = new string(buf, 0, n);
            }
            using var doc = JsonDocument.Parse(text.Trim());
            var root = doc.RootElement;
            if (root.TryGetProperty("bootTs", out var bt) && bt.ValueKind == JsonValueKind.Number && bt.TryGetInt64(out var bts)) bootTs = bts;
            if (root.TryGetProperty("bootId", out var bi) && bi.ValueKind == JsonValueKind.Number && bi.TryGetInt64(out var bid)) bootId = bid;
        }
        catch (Exception ex)
        {
            // Corrupt counts as "same boot" (safe side), unless the file was last written before this
            // boot began: then it cannot describe this boot, and treating it as interrupted would latch
            // fans at 100% on every boot with no way out.
            if (LastWriteBeforeCurrentBoot(path))
            {
                Program.Log($"Fan flag corrupt ({ex.Message}) but written before this boot; treating it as a previous boot");
                if (elevated) DeleteSecured(path);
                return FlagPreviousBoot;
            }
            Program.Log($"Fan flag unreadable or corrupt ({ex.Message}); treating it as an interrupted session");
            return FlagInterrupted;
        }

        long? currentBootId = CurrentBootId();
        bool sameBoot = IsSameBoot(bootId, bootTs, currentBootId, CurrentBootTs());
        // An incomplete flag (no usable boot identity) is "same boot" by default; its write time can
        // still prove it older than this boot (same reasoning as for a corrupt flag).
        bool incomplete = !bootTs.HasValue && !(bootId.HasValue && currentBootId.HasValue);
        if (sameBoot && incomplete && LastWriteBeforeCurrentBoot(path)) sameBoot = false;

        if (sameBoot)
        {
            Program.Log("Fan flag from this boot found: fan control was interrupted");
            return FlagInterrupted;
        }

        Program.Log("Fan flag from a previous boot found");
        if (elevated) DeleteSecured(path);
        return FlagPreviousBoot;
    }

    private static void DeleteSecured(string path)
    {
        try
        {
            if (EnsureSecureFolder(out _)) File.Delete(path);
        }
        catch (Exception ex)
        {
            Program.Log($"Could not delete the previous-boot fan flag: {ex.Message}");
        }
    }

    /// <summary>True when the flag's last-write time is clearly before the current boot started.</summary>
    private static bool LastWriteBeforeCurrentBoot(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            long written = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds();
            return written < CurrentBootTs() - SameBootToleranceMs;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Elevated start-up check: the state folder is a reparse point, or its owner/DACL is not the one
    /// <see cref="EnsureSecureFolder"/> sets (so a non-admin could have written the flag).
    /// </summary>
    private static bool FolderIsUntrusted(out string why)
    {
        why = "";
        try
        {
            var dir = new DirectoryInfo(FolderPath);
            if (!dir.Exists) return false;
            if ((dir.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                why = "state folder is a reparse point";
                return true;
            }
            if (!IsCompliant(dir))
            {
                why = "state folder is not admin-only";
                return true;
            }
            return false;
        }
        catch (Exception ex)
        {
            // Cannot even read the folder's security: an admin can always read an admin-only folder it
            // secured, so this folder is not one Nexum secured.
            why = $"state folder security unreadable: {ex.Message}";
            return true;
        }
    }

    private static bool IsLink(string path)
    {
        try { return new FileInfo(path).LinkTarget is not null; }
        catch { return false; }
    }

    // ---------------------------------------------------------------------------------------------
    // Folder ACL

    /// <summary>
    /// Creates or repairs <see cref="FolderPath"/> (elevated only). Returns false when the folder or the
    /// flag path is a reparse point, or when its owner/DACL cannot be made safe.
    /// </summary>
    public static bool EnsureSecureFolder(out string error)
    {
        error = "";
        try
        {
            var dir = new DirectoryInfo(FolderPath);
            if (!dir.Exists)
            {
                dir.Create(BuildSecurity());
                dir.Refresh();
            }

            if ((dir.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                error = "state folder is a reparse point";
                return false;
            }

            if (!IsCompliant(dir))
            {
                Program.Log("Resetting owner and permissions of the Nexum state folder");
                dir.SetAccessControl(BuildSecurity());
                dir.Refresh();
                if (!IsCompliant(dir))
                {
                    error = "state folder permissions could not be secured";
                    return false;
                }
            }

            var flag = new FileInfo(FlagPath);
            if ((flag.Exists || flag.LinkTarget is not null) && (flag.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                error = "flag path is a reparse point";
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    private static DirectorySecurity BuildSecurity()
    {
        var ds = new DirectorySecurity();
        ds.SetOwner(AdminsSid);
        ds.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        ds.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        ds.AddAccessRule(new FileSystemAccessRule(AdminsSid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        ds.AddAccessRule(new FileSystemAccessRule(UsersSid, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, inherit, PropagationFlags.None, AccessControlType.Allow));
        return ds;
    }

    private static bool IsCompliant(DirectoryInfo dir)
    {
        var sec = dir.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (sec.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !owner.Equals(AdminsSid)) return false;
        if (!sec.AreAccessRulesProtected) return false;

        bool systemFull = false, adminsFull = false;
        foreach (FileSystemAccessRule rule in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.IdentityReference is not SecurityIdentifier sid) return false;
            bool privileged = sid.Equals(SystemSid) || sid.Equals(AdminsSid);
            if (rule.AccessControlType == AccessControlType.Allow)
            {
                if (!privileged && (rule.FileSystemRights & DangerousRights) != 0) return false;
                if ((rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl)
                {
                    if (sid.Equals(SystemSid)) systemFull = true;
                    if (sid.Equals(AdminsSid)) adminsFull = true;
                }
            }
        }
        return systemFull && adminsFull;
    }

    // ---------------------------------------------------------------------------------------------
    // Write / delete (elevated only)

    /// <summary>
    /// Writes the flag (write-through) via a temporary file in the secured folder and an atomic replace,
    /// so a planted hard link or symlink at the flag path is replaced, never written through.
    /// </summary>
    public static bool Write(string mode, out string error)
    {
        error = "";
        if (!EnsureSecureFolder(out error)) return false;

        string tmp = Path.Combine(FolderPath, $"fan-manual.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
        try
        {
            var content = JsonSerializer.Serialize(new FlagContent
            {
                Pid = Environment.ProcessId,
                BootTs = CurrentBootTs(),
                BootId = CurrentBootId(),
                Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Mode = mode,
                AgentVersion = Program.AgentVersion,
            }) + "\n";
            var bytes = new UTF8Encoding(false).GetBytes(content);
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(flushToDisk: true);
            }
            File.Move(tmp, FlagPath, overwrite: true);
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignore */ }
            return false;
        }
    }

    public static bool Exists()
    {
        try { return File.Exists(FlagPath); } catch { return false; }
    }

    public static void Delete()
    {
        try
        {
            if (File.Exists(FlagPath) || IsLink(FlagPath))
            {
                File.Delete(FlagPath);
                Program.Log("Fan flag deleted (BIOS fan control restored)");
            }
        }
        catch (Exception ex)
        {
            Program.Log($"Could not delete the fan flag: {ex.Message}");
        }
    }

    private sealed class FlagContent
    {
        [System.Text.Json.Serialization.JsonPropertyName("v")] public int V => 1;
        [System.Text.Json.Serialization.JsonPropertyName("pid")] public int Pid { get; init; }
        [System.Text.Json.Serialization.JsonPropertyName("bootTs")] public long BootTs { get; init; }
        [System.Text.Json.Serialization.JsonPropertyName("bootId")] public long? BootId { get; init; }
        [System.Text.Json.Serialization.JsonPropertyName("ts")] public long Ts { get; init; }
        [System.Text.Json.Serialization.JsonPropertyName("mode")] public string Mode { get; init; } = ModePreset;
        [System.Text.Json.Serialization.JsonPropertyName("agentVersion")] public string AgentVersion { get; init; } = "";
    }
}

/// <summary>Flag persistence used by <see cref="FanSafety"/> (a seam for the self-test).</summary>
internal interface IFanFlagStore
{
    bool EnsureSecureFolder(out string error);
    bool Write(string mode, out string error);
    void Delete();
}

/// <summary>The real store: <c>%ProgramData%\Nexum\fan-manual.flag</c>.</summary>
internal sealed class FileFanFlagStore : IFanFlagStore
{
    public bool EnsureSecureFolder(out string error) => FanFlag.EnsureSecureFolder(out error);
    public bool Write(string mode, out string error) => FanFlag.Write(mode, out error);
    public void Delete() => FanFlag.Delete();
}
