<#
.SYNOPSIS
  MF-8 / CONTRACT §7.2: list every Portable Executable (and .msi) under the given
  folders with its Authenticode status.

.DESCRIPTION
  Smart App Control only runs code that is signed or predicted safe, and Microsoft
  says to sign "all binaries, such as exe, dll, temp installer files, scripts, and
  uninstallers". This script finds every PE by its header (MZ + "PE\0\0"), not by
  file extension, so renamed or extension-less binaries are caught too.

  Without -Enforce it only reports: files that are not 'Valid' become GitHub
  warnings. With -Enforce any file that is not 'Valid' is an error and the script
  exits 1. It also exits 1 with -Enforce when no file was found at all.

.EXAMPLE
  pwsh .github/scripts/check-authenticode.ps1 -Label "portable" -Path out/portable
  pwsh .github/scripts/check-authenticode.ps1 -Label "signed release" -Path signed -Enforce
#>
param(
  [Parameter(Mandatory = $true)][string[]] $Path,
  [string] $Label = "binaries",
  [switch] $Enforce
)

$ErrorActionPreference = 'Stop'

function Test-IsPe([string] $file) {
  try {
    $fs = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
    try {
      if ($fs.Length -lt 64) { return $false }
      $br = New-Object System.IO.BinaryReader($fs)
      if ($br.ReadUInt16() -ne 0x5A4D) { return $false }          # "MZ"
      $fs.Seek(0x3C, 'Begin') | Out-Null
      $peOffset = $br.ReadInt32()
      if ($peOffset -lt 0 -or $peOffset + 4 -gt $fs.Length) { return $false }
      $fs.Seek($peOffset, 'Begin') | Out-Null
      return ($br.ReadUInt32() -eq 0x00004550)                      # "PE\0\0"
    } finally { $fs.Dispose() }
  } catch { return $false }
}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($p in $Path) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Host "(skip) $p does not exist"; continue }
  $base = (Resolve-Path -LiteralPath $p).Path
  $items = if ((Get-Item -LiteralPath $p).PSIsContainer) {
    Get-ChildItem -LiteralPath $p -Recurse -File -Force
  } else { Get-Item -LiteralPath $p }
  foreach ($f in $items) {
    $isMsi = $f.Extension -ieq '.msi'
    if (-not $isMsi -and -not (Test-IsPe $f.FullName)) { continue }
    $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
    $rel = $f.FullName
    if ($rel.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
      $rel = (Split-Path $base -Leaf) + $rel.Substring($base.Length)
    }
    $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
    $cn = if ($subject -match 'CN=([^,]+)') { $Matches[1] } else { $subject }
    $rows.Add([pscustomobject]@{
      File   = $rel
      Status = [string]$sig.Status
      Signer = $cn
      Bytes  = $f.Length
    })
  }
}

Write-Host "Authenticode report: $Label ($($rows.Count) file(s), enforce=$([bool]$Enforce))"
$rows | Sort-Object File | Format-Table -AutoSize -Wrap | Out-String -Width 400 | Write-Host

if ($env:GITHUB_STEP_SUMMARY) {
  $md = @("### Authenticode: $Label", "", "| File | Status | Signer |", "|---|---|---|")
  foreach ($r in ($rows | Sort-Object File)) {
    $icon = if ($r.Status -eq 'Valid') { 'Valid' } else { "**$($r.Status)**" }
    $md += "| ``$($r.File)`` | $icon | $($r.Signer) |"
  }
  if ($rows.Count -eq 0) { $md += "| (no PE files found) | | |" }
  $md += ""
  $md -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}

$bad = @($rows | Where-Object { $_.Status -ne 'Valid' })
$level = if ($Enforce) { 'error' } else { 'warning' }
foreach ($b in $bad) {
  Write-Host "::${level}::[$Label] not validly signed ($($b.Status)): $($b.File)"
}

if ($rows.Count -eq 0) {
  Write-Host "::${level}::[$Label] no PE files found under: $($Path -join ', ')"
  if ($Enforce) { exit 1 }
  exit 0
}
if ($Enforce -and $bad.Count -gt 0) {
  Write-Host "$($bad.Count) of $($rows.Count) file(s) are not 'Valid'. Smart App Control would block them."
  exit 1
}
Write-Host "$($rows.Count - $bad.Count) of $($rows.Count) file(s) Valid."
exit 0
