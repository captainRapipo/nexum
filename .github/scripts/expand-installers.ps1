<#
.SYNOPSIS
  MF-8: unpack Nexum's installers so CI can check every file they put on disk.

.DESCRIPTION
  For each installer under -InstallerDir:
    * NSIS setup .exe -> extracted with 7-Zip into <Dest>/nsis-<name>/. This includes
      $PLUGINSDIR (System.dll, nsDialogs.dll, ... and Tauri's NSIS plugins), which the
      installer drops into %TEMP% at install time ("temp installer files").
    * .msi -> administrative image (msiexec /a) into <Dest>/msi-<name>/ (files only,
      nothing is installed or registered).
  With -Install, each NSIS installer is also run silently into <Dest>/installed-<name>/
  so the generated uninstall.exe can be checked, and is then uninstalled again.
  Only use -Install on a disposable CI runner.

  The script never fails the job on its own: extraction problems are warnings.
  The Authenticode / forbidden-driver checks run on the output folder afterwards.
#>
param(
  [Parameter(Mandatory = $true)][string] $InstallerDir,
  [Parameter(Mandatory = $true)][string] $Dest,
  [switch] $Install
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null
$Dest = (Resolve-Path $Dest).Path

$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if (-not $sevenZip -and (Test-Path 'C:\Program Files\7-Zip\7z.exe')) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }

$installers = @(Get-ChildItem -LiteralPath $InstallerDir -File | Where-Object { $_.Extension -in '.exe', '.msi' })
if ($installers.Count -eq 0) { Write-Host "::warning::no installers found in $InstallerDir"; exit 0 }

foreach ($i in $installers) {
  $name = [IO.Path]::GetFileNameWithoutExtension($i.Name) -replace '[^A-Za-z0-9._-]', '_'
  if ($i.Extension -ieq '.msi') {
    $target = Join-Path $Dest "msi-$name"
    New-Item -ItemType Directory -Force $target | Out-Null
    $log = Join-Path $Dest "msi-$name.log"
    $p = Start-Process msiexec.exe -ArgumentList @('/a', "`"$($i.FullName)`"", '/qn', "TARGETDIR=`"$target`"", '/l*v', "`"$log`"") -Wait -PassThru
    if ($p.ExitCode -ne 0) { Write-Host "::warning::msiexec /a $($i.Name) exited $($p.ExitCode) (log: $log)" }
    else { Write-Host "MSI admin image: $($i.Name) -> $target ($(@(Get-ChildItem $target -Recurse -File).Count) files)" }
    continue
  }

  # Treat every other .exe in the installer folder as an NSIS installer.
  if ($sevenZip) {
    $target = Join-Path $Dest "nsis-$name"
    & $sevenZip x -y -bso0 -bsp0 "-o$target" $i.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "::warning::7-Zip could not extract $($i.Name) (exit $LASTEXITCODE)" }
    else { Write-Host "NSIS contents: $($i.Name) -> $target ($(@(Get-ChildItem $target -Recurse -File -Force).Count) files)" }
  } else {
    Write-Host "::warning::7-Zip not found; NSIS installer contents of $($i.Name) not inspected"
  }

  if ($Install) {
    $installDir = Join-Path $Dest "installed-$name"
    # NSIS: /S silent, /D= install dir (must be last, unquoted).
    $p = Start-Process $i.FullName -ArgumentList @('/S', "/D=$installDir") -PassThru
    if (-not $p.WaitForExit(300000)) {
      try { $p.Kill() } catch {}
      Write-Host "::warning::silent install of $($i.Name) timed out after 300 s"
      continue
    }
    if (-not (Test-Path (Join-Path $installDir 'uninstall.exe'))) {
      # The installer may ignore /D= (e.g. a perMachine default); look in Program Files.
      $fallback = Join-Path $env:ProgramFiles 'Nexum'
      if (Test-Path (Join-Path $fallback 'uninstall.exe')) { $installDir = $fallback }
    }
    if ($p.ExitCode -ne 0 -or -not (Test-Path $installDir)) {
      Write-Host "::warning::silent install of $($i.Name) exited $($p.ExitCode); install image not inspected"
      continue
    }
    Write-Host "Installed $($i.Name) -> $installDir ($(@(Get-ChildItem $installDir -Recurse -File).Count) files)"
    # Keep a copy of the install image for the checks, then uninstall.
    $image = Join-Path $Dest "image-$name"
    Copy-Item $installDir $image -Recurse -Force
    $uninst = Join-Path $installDir 'uninstall.exe'
    if (Test-Path $uninst) {
      # _?= runs the uninstaller in place and waits for it.
      $u = Start-Process $uninst -ArgumentList @('/S', "_?=$installDir") -PassThru
      if (-not $u.WaitForExit(300000)) { try { $u.Kill() } catch {}; Write-Host "::warning::uninstall timed out" }
    } else {
      Write-Host "::warning::no uninstall.exe in the install image of $($i.Name)"
    }
  }
}
exit 0
