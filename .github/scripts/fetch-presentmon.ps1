<#
.SYNOPSIS
  CONTRACT §7 item 7: download the pinned Intel PresentMon console exe at build time
  and refuse to continue unless it is exactly the pinned, Intel-signed file.

.DESCRIPTION
  Reads .github/presentmon.json (the only place the URL and hash live), downloads the
  release asset into build/presentmon/ (gitignored, never committed) and checks:
    * SHA-256 equals the pinned value;
    * Get-AuthenticodeSignature Status is 'Valid';
    * the signer certificate subject starts with 'CN=Intel Corporation'.
  Any failure deletes the download and exits 1, so tauri-build (which validates
  bundle.resources) never sees an unverified file.

  An existing file at the destination is re-verified instead of downloaded again;
  a file that fails verification is deleted and downloaded once more.

  This is build-time only. Nexum itself never downloads anything (MF-11): the exe is
  shipped in the installer and the elevated agent re-checks hash and signature before
  every spawn (CONTRACT §1.6.1).

.EXAMPLE
  pwsh .github/scripts/fetch-presentmon.ps1
#>
param(
  [string] $Config = (Join-Path $PSScriptRoot '..' 'presentmon.json'),
  [string] $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
foreach ($k in 'version', 'asset', 'url', 'sha256', 'signerSubjectPrefix', 'dest') {
  if (-not $cfg.$k) { throw "presentmon.json: missing '$k'" }
}
$expected = $cfg.sha256.ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') { throw "presentmon.json: sha256 is not 64 hex characters" }
$prefix = 'https://github.com/GameTechDev/PresentMon/releases/download/'
if (-not $cfg.url.StartsWith($prefix, [StringComparison]::Ordinal)) {
  throw "presentmon.json: url must be an official GameTechDev/PresentMon release asset ($prefix...)"
}
if ((Split-Path $cfg.url -Leaf) -ne $cfg.asset -or (Split-Path $cfg.dest -Leaf) -ne $cfg.asset) {
  throw "presentmon.json: url, asset and dest must name the same file ($($cfg.asset))"
}

$dest = Join-Path $RepoRoot $cfg.dest
$dir = Split-Path $dest -Parent
New-Item -ItemType Directory -Force $dir | Out-Null

function Test-PresentMon([string] $file) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($hash -ne $expected) { return "SHA-256 $hash does not match the pinned $expected" }
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid') { return "Authenticode status is '$($sig.Status)' ($($sig.StatusMessage)), expected 'Valid'" }
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
  if (-not $subject.StartsWith($cfg.signerSubjectPrefix, [StringComparison]::Ordinal)) {
    return "signer subject '$subject' does not start with '$($cfg.signerSubjectPrefix)'"
  }
  Write-Host "PresentMon $($cfg.version): SHA-256 $hash (pinned), Authenticode Valid"
  Write-Host "  signer: $subject"
  Write-Host "  issuer: $($sig.SignerCertificate.Issuer)"
  return $null
}

if (Test-Path -LiteralPath $dest) {
  $problem = Test-PresentMon $dest
  if (-not $problem) { Write-Host "Using the verified file already at $($cfg.dest)"; exit 0 }
  Write-Host "::warning::existing $($cfg.dest) failed verification ($problem); downloading again"
  Remove-Item -LiteralPath $dest -Force
}

$tmp = "$dest.download"
$ok = $false
for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
  try {
    Write-Host "Downloading $($cfg.url) (attempt $attempt)"
    Invoke-WebRequest -Uri $cfg.url -OutFile $tmp -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 120
    $ok = $true
  } catch {
    Write-Host "::warning::download attempt $attempt failed: $($_.Exception.Message)"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    if ($attempt -lt 3) { Start-Sleep -Seconds (5 * $attempt) }
  }
}
if (-not $ok) { Write-Host "::error::could not download PresentMon $($cfg.version)"; exit 1 }

$problem = Test-PresentMon $tmp
if ($problem) {
  Remove-Item -LiteralPath $tmp -Force
  Write-Host "::error::PresentMon $($cfg.version) rejected: $problem"
  exit 1
}
Move-Item -LiteralPath $tmp -Destination $dest -Force
Write-Host "PresentMon $($cfg.version) verified -> $($cfg.dest) ($((Get-Item -LiteralPath $dest).Length) bytes)"

if ($env:GITHUB_STEP_SUMMARY) {
  @(
    "### PresentMon (third-party, Intel-signed, shipped unmodified)", "",
    "| File | SHA-256 | Authenticode | Signer |", "|---|---|---|---|",
    "| ``$($cfg.dest)`` | ``$expected`` | Valid | $($cfg.signerSubjectPrefix) |", ""
  ) -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
exit 0
