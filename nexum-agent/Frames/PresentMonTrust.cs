using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Win32.SafeHandles;

namespace NexumAgent.Frames;

/// <summary>
/// CONTRACT §1.6.1: the executable trust check that runs before every PresentMon spawn (capture and
/// terminate calls alike). The returned handle keeps the file open with read-only sharing until the
/// caller has created the process, so the verified file cannot be replaced in between.
/// </summary>
internal static class PresentMonTrust
{
    public const string BackendVersion = "2.6.0";
    public const string SessionName = "NexumFrames";

    /// <summary>SHA-256 of the pinned, unmodified Intel-signed PresentMon-2.6.0-x64.exe (ROADMAP V1, .github/presentmon.json).</summary>
    public const string PinnedSha256 = "b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af";

    private const string IntelSubject = "CN=Intel Corporation";
    private const long MaxExeBytes = 64L * 1024 * 1024;

    internal sealed class Result : IDisposable
    {
        public bool Ok { get; init; }
        /// <summary>FrameSessionCode on failure: "exeMissing" | "signatureInvalid".</summary>
        public string? Code { get; init; }
        public FrameSignature Signature { get; init; } = FrameSignature.NotChecked;
        public string Path { get; init; } = "";
        /// <summary>Open (share read only) while Ok; disposed by the caller after CreateProcess returned.</summary>
        public SafeFileHandle? Handle { get; init; }
        /// <summary>Log detail (never shown in the UI).</summary>
        public string Detail { get; init; } = "";

        public void Dispose() => Handle?.Dispose();
    }

    /// <summary>
    /// A path Nexum may run: fully qualified, on a local drive letter (no UNC / device paths, so no
    /// network share is ever touched), no quotes (it is quoted on the command line).
    /// </summary>
    internal static bool IsAcceptablePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1024) return false;
        if (path.IndexOf('"') >= 0 || path.IndexOf('\0') >= 0) return false;
        if (path.Length < 4 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\') return false;
        if (!System.IO.Path.IsPathFullyQualified(path)) return false;
        return path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
    }

    public static Result Check(string? path)
    {
        if (!IsAcceptablePath(path))
        {
            return new Result { Code = "exeMissing", Path = path ?? "", Detail = "no acceptable --presentmon path" };
        }

        SafeFileHandle handle = FrameNative.CreateFile(path!, FrameNative.GENERIC_READ, FrameNative.FILE_SHARE_READ, IntPtr.Zero,
            FrameNative.OPEN_EXISTING, FrameNative.FILE_ATTRIBUTE_NORMAL | FrameNative.FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int err = Marshal.GetLastWin32Error();
            handle.Dispose();
            // 2 = not found, 3 = path not found: the resource is missing. Anything else (sharing violation
            // because something holds it open for writing, access denied) means it cannot be trusted now.
            bool missing = err is 2 or 3;
            return new Result
            {
                Code = missing ? "exeMissing" : "signatureInvalid",
                Signature = missing ? FrameSignature.NotChecked : new FrameSignature { Status = "invalid" },
                Path = path!,
                Detail = $"open failed (win32 {err})",
            };
        }

        bool keep = false;
        try
        {
            if (!FrameNative.GetFileInformationByHandle(handle, out var info))
            {
                return Invalid(path!, null, null, $"file information unavailable (win32 {Marshal.GetLastWin32Error()})");
            }
            if ((info.dwFileAttributes & (FrameNative.FILE_ATTRIBUTE_REPARSE_POINT | FrameNative.FILE_ATTRIBUTE_DIRECTORY)) != 0)
            {
                return Invalid(path!, null, null, "reparse point or directory");
            }
            long size = ((long)info.nFileSizeHigh << 32) | info.nFileSizeLow;
            if (size <= 0 || size > MaxExeBytes)
            {
                return Invalid(path!, false, null, $"unexpected size {size}");
            }

            // 3. Pinned hash, read through the same handle (positional reads; the file pointer is untouched).
            string hash = HashHex(handle, size);
            if (!string.Equals(hash, PinnedSha256, StringComparison.OrdinalIgnoreCase))
            {
                return Invalid(path!, false, null, $"SHA-256 mismatch ({hash})");
            }

            // 4. Authenticode through the same handle, no UI, no revocation, cache-only URL retrieval.
            var (wvt, subject, signerCn) = VerifyAuthenticode(path!, handle);
            if (wvt != 0)
            {
                return Invalid(path!, true, signerCn, $"WinVerifyTrust 0x{wvt:X8}");
            }
            bool intel = subject is not null &&
                         (subject == IntelSubject || subject.StartsWith(IntelSubject + ",", StringComparison.Ordinal));
            if (!intel)
            {
                return new Result
                {
                    Code = "signatureInvalid",
                    Signature = new FrameSignature { Status = "untrusted", Signer = signerCn, Sha256Match = true },
                    Path = path!,
                    Detail = $"unexpected signer '{subject}'",
                };
            }

            keep = true;
            return new Result
            {
                Ok = true,
                Signature = new FrameSignature { Status = "valid", Signer = signerCn, Sha256Match = true },
                Path = path!,
                Handle = handle,
                Detail = "valid",
            };
        }
        catch (Exception ex)
        {
            return Invalid(path!, null, null, $"trust check failed: {ex.Message}");
        }
        finally
        {
            if (!keep) handle.Dispose();
        }
    }

    private static Result Invalid(string path, bool? shaMatch, string? signer, string detail) => new()
    {
        Code = "signatureInvalid",
        Signature = new FrameSignature { Status = "invalid", Signer = signer, Sha256Match = shaMatch },
        Path = path,
        Detail = detail,
    };

    private static string HashHex(SafeFileHandle handle, long size)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long offset = 0;
        while (offset < size)
        {
            int read = RandomAccess.Read(handle, buffer, offset);
            if (read <= 0) break;
            sha.AppendData(buffer, 0, read);
            offset += read;
        }
        if (offset != size) throw new IOException("short read");
        return Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant();
    }

    /// <summary>Returns (WinVerifyTrust result, leaf signer subject, leaf signer CN).</summary>
    private static (int Result, string? Subject, string? SignerCn) VerifyAuthenticode(string path, SafeFileHandle handle)
    {
        IntPtr pathPtr = Marshal.StringToHGlobalUni(path);
        IntPtr fileInfoPtr = IntPtr.Zero;
        bool addRef = false;
        try
        {
            handle.DangerousAddRef(ref addRef);
            var fileInfo = new FrameNative.WINTRUST_FILE_INFO
            {
                cbStruct = (uint)Marshal.SizeOf<FrameNative.WINTRUST_FILE_INFO>(),
                pcwszFilePath = pathPtr,
                hFile = handle.DangerousGetHandle(),
                pgKnownSubject = IntPtr.Zero,
            };
            fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf<FrameNative.WINTRUST_FILE_INFO>());
            Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);

            var data = new FrameNative.WINTRUST_DATA
            {
                cbStruct = (uint)Marshal.SizeOf<FrameNative.WINTRUST_DATA>(),
                dwUIChoice = FrameNative.WTD_UI_NONE,
                fdwRevocationChecks = FrameNative.WTD_REVOKE_NONE,
                dwUnionChoice = FrameNative.WTD_CHOICE_FILE,
                pFile = fileInfoPtr,
                dwStateAction = FrameNative.WTD_STATEACTION_VERIFY,
                dwProvFlags = FrameNative.WTD_CACHE_ONLY_URL_RETRIEVAL | FrameNative.WTD_REVOCATION_CHECK_NONE,
            };
            var action = FrameNative.WINTRUST_ACTION_GENERIC_VERIFY_V2;
            int result = FrameNative.WinVerifyTrust(FrameNative.INVALID_HANDLE_VALUE, ref action, ref data);

            string? subject = null;
            string? cn = null;
            try
            {
                if (data.hWVTStateData != IntPtr.Zero)
                {
                    IntPtr prov = FrameNative.WTHelperProvDataFromStateData(data.hWVTStateData);
                    IntPtr sgnr = prov == IntPtr.Zero ? IntPtr.Zero : FrameNative.WTHelperGetProvSignerFromChain(prov, 0, false, 0);
                    IntPtr provCert = sgnr == IntPtr.Zero ? IntPtr.Zero : FrameNative.WTHelperGetProvCertFromChain(sgnr, 0);
                    // CRYPT_PROVIDER_CERT { DWORD cbStruct; PCCERT_CONTEXT pCert; ... }: pCert sits at pointer alignment.
                    IntPtr certContext = provCert == IntPtr.Zero ? IntPtr.Zero : Marshal.ReadIntPtr(provCert, IntPtr.Size);
                    if (certContext != IntPtr.Zero)
                    {
                        using var cert = new X509Certificate2(certContext); // duplicates the context
                        subject = cert.Subject;
                        cn = cert.GetNameInfo(X509NameType.SimpleName, forIssuer: false);
                        if (string.IsNullOrEmpty(cn)) cn = null;
                    }
                }
            }
            finally
            {
                data.dwStateAction = FrameNative.WTD_STATEACTION_CLOSE;
                FrameNative.WinVerifyTrust(FrameNative.INVALID_HANDLE_VALUE, ref action, ref data);
            }
            return (result, subject, cn);
        }
        finally
        {
            if (fileInfoPtr != IntPtr.Zero) Marshal.FreeHGlobal(fileInfoPtr);
            Marshal.FreeHGlobal(pathPtr);
            if (addRef) handle.DangerousRelease();
        }
    }
}
