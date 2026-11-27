<#
.SYNOPSIS
  CONTRACT §7 items 2 + 7 / MF-8 item 7: every PresentMon copy that ships is Intel's
  unmodified, Intel-signed file. Always enforcing (it does not depend on Nexum's own
  signing state).

.DESCRIPTION
  Searches the given folders for files named like the pinned asset
  (PresentMon-<version>-x64.exe, case-insensitive) and for any other file whose name
  starts with 'PresentMon' and ends in '.exe'. Every match must have the pinned
  SHA-256 from .github/presentmon.json, Authenticode status 'Valid' and a signer subject
  starting with 'CN=Intel Corporation'.

  A changed hash after signing means a signing step re-signed a third-party binary,
  which Nexum never does (docs/SIGNING.md). It would also make the agent's own
  pinned-hash check refuse to start PresentMon (CONTRACT §1.6.1).

  -Require lists folders that must contain at least one copy (for example the portable
  folder, where Nexum.exe resolves resources next to itself). Folders that do not exist
  are skipped unless they are in -Require.

.EXAMPLE
  pwsh .github/scripts/check-presentmon-shipped.ps1 -Path out/portable,build/inspect -Require out/portable
#>
param(
  [Parameter(Mandatory = $true)][string[]] $Path,
  [string[]] $Require = @(),
  [string] $Label = 'PresentMon',
  [string] $Config = (Join-Path $PSScriptRoot '..' 'presentmon.json')
)

$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$expected = $cfg.sha256.ToLowerInvariant()
$failed = 0
$rows = New-Object System.Collections.Generic.List[object]

$roots = @($Path) + @($Require) | Select-Object -Unique
foreach ($root in $roots) {
  $required = $Require -contains $root
  if (-not (Test-Path -LiteralPath $root)) {
    if ($required) { Write-Host "::error::[$Label] required folder '$root' does not exist"; $failed++ }
    else { Write-Host "(skip) $root does not exist" }
    continue
  }
  $found = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force |
    Where-Object { $_.Name -ieq $cfg.asset -or ($_.Name -like 'PresentMon*' -and $_.Extension -ieq '.exe') })
  if ($found.Count -eq 0) {
    if ($required) { Write-Host "::error::[$Label] no $($cfg.asset) under '$root' (bundle.resources must ship it)"; $failed++ }
    else { Write-Host "(none) no PresentMon copy under $root" }
    continue
  }
  foreach ($f in $found) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $f.FullName).Hash.ToLowerInvariant()
    $sig = Get-AuthenticodeSignature -LiteralPath $f.FullName
    $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
    $problems = @()
    if ($f.Name -ine $cfg.asset) { $problems += "unexpected file name (expected $($cfg.asset))" }
    if ($hash -ne $expected) { $problems += "SHA-256 $hash is not the pinned $expected (modified or re-signed?)" }
    if ($sig.Status -ne 'Valid') { $problems += "Authenticode '$($sig.Status)'" }
    if (-not $subject.StartsWith($cfg.signerSubjectPrefix, [StringComparison]::Ordinal)) { $problems += "signer '$subject'" }
    $rel = $f.FullName
    $rows.Add([pscustomobject]@{ File = $rel; Status = [string]$sig.Status; Signer = ($subject -replace ',.*$', ''); Pinned = ($hash -eq $expected) })
    foreach ($p in $problems) { Write-Host "::error::[$Label] $($rel): $p" }
    if ($problems.Count) { $failed++ }
  }
}

$rows | Format-Table -AutoSize -Wrap | Out-String -Width 400 | Write-Host
if ($env:GITHUB_STEP_SUMMARY -and $rows.Count) {
  $md = @("### $Label (third-party, must be Intel's unmodified file)", "", "| File | Authenticode | Signer | Pinned SHA-256 |", "|---|---|---|---|")
  foreach ($r in $rows) { $md += "| ``$($r.File)`` | $($r.Status) | $($r.Signer) | $(if ($r.Pinned) { 'yes' } else { '**NO**' }) |" }
  ($md + "") -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
if ($failed -gt 0) { Write-Host "$failed PresentMon problem(s)."; exit 1 }
Write-Host "[$Label] $($rows.Count) PresentMon cop(y/ies) verified: pinned hash, Valid, Intel-signed."
exit 0
