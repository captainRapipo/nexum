<#
.SYNOPSIS
  CI smoke test for the v1.1 agent surface that can run on a GPU-less runner:
  frame capture (CONTRACT §1.6) and the read-only tuning guard (§1.7.2).

.DESCRIPTION
  Never sends a fan, flush or tuning-write command that could be honoured: the only
  write-shaped command is {"cmd":"tuningProbe","write":true}, which the agent must
  reject WITHOUT calling the tuning code (CONTRACT §1.7.2). Only run this on a
  disposable CI runner (it starts and stops an ETW session named NexumFrames).

  Run 1 (no --presentmon):
    * hello.protocol 3, a 'frameSession' stopped/notChecked right after hello;
    * tuningProbe write:true  -> ack ok:false "The write probe is not available in this version."
    * tuningProbe write:"yes" -> ack ok:false "Invalid command"
    * frames enabled:true     -> frameSession error exeMissing (the agent must not find
                                 PresentMon anywhere else, §1.1) or notElevated.
  Run 2 (--presentmon <pinned exe>), hard kill:
    * frames enabled:true -> starting/running with signature valid, Intel signer, hash match;
    * the agent is killed; the PresentMon child must die with it (Job Object
      KILL_ON_JOB_CLOSE). The ETW session may be orphaned here, on purpose.
  Run 2b (--presentmon), frames never enabled, only when run 2 left an orphaned session:
    * the elevated agent removes the orphan at start (ControlTraceW stop) without spawning PresentMon.
  Run 3 (--presentmon), graceful:
    * frames enabled:true (--stop_existing_session cleans any leftover), then
      frames enabled:false -> ack "Frame capture stopped" + frameSession stopped;
    * shutdown -> exit 0, no PresentMon process left, and 'logman query -ets' shows no
      NexumFrames session (ROADMAP §4.3 gate 3).

.EXAMPLE
  pwsh .github/scripts/smoke-frames.ps1 -Agent build/agent/nexum-agent.exe -PresentMon build/presentmon/PresentMon-2.6.0-x64.exe
#>
param(
  [Parameter(Mandatory = $true)][string] $Agent,
  [Parameter(Mandatory = $true)][string] $PresentMon,
  # Arguments placed before the agent's own, e.g. -Agent dotnet.exe -AgentPrefix nexum-agent.dll
  [string[]] $AgentPrefix = @()
)

$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Agent) { $Agent = (Resolve-Path -LiteralPath $Agent).Path }
$PresentMon = (Resolve-Path -LiteralPath $PresentMon).Path
$pmName = [IO.Path]::GetFileNameWithoutExtension($PresentMon)
$script:failures = New-Object System.Collections.Generic.List[string]

function Fail([string] $msg) { Write-Host "::error::$msg"; $script:failures.Add($msg) }

function Start-Agent([string[]] $AgentArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Agent
  foreach ($a in @($AgentPrefix) + @($AgentArgs)) { $psi.ArgumentList.Add($a) }
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  [pscustomobject]@{
    P       = $p
    Err     = $p.StandardError.ReadToEndAsync()
    Pending = $p.StandardOutput.ReadLineAsync()
    Lines   = New-Object System.Collections.Generic.List[object]
  }
}

function Send($a, [string] $json) {
  Write-Host ">> $json"
  $a.P.StandardInput.WriteLine($json)
  $a.P.StandardInput.Flush()
}

# Reads lines until $Match returns true for a parsed line (returns it) or the timeout passes ($null).
function Wait-Line($a, [scriptblock] $Match, [int] $TimeoutSec) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (-not $a.Pending.Wait(250)) { continue }
    $l = $a.Pending.Result
    if ($null -eq $l) { return $null }                  # EOF
    $a.Pending = $a.P.StandardOutput.ReadLineAsync()
    if (-not $l.Trim()) { continue }
    try { $o = $l | ConvertFrom-Json -ErrorAction Stop } catch { Fail "stdout line is not JSON: $l"; continue }
    $a.Lines.Add($o)
    if ($o.type -notin 'telemetry', 'sensorValues') { Write-Host "<< $($l.Substring(0, [Math]::Min(300, $l.Length)))" }
    if (& $Match $o) { return $o }
  }
  return $null
}

function Stop-Agent($a, [switch] $Kill) {
  if ($Kill) {
    Write-Host "killing agent pid $($a.P.Id)"
    $a.P.Kill()   # the agent only, not its tree: the Job Object must take PresentMon down
    $a.P.WaitForExit(10000) | Out-Null
    return
  }
  Send $a '{"cmd":"shutdown"}'
  $a.P.StandardInput.Close()
  while ($a.Pending.Wait(15000)) {
    if ($null -eq $a.Pending.Result) { break }
    $a.Pending = $a.P.StandardOutput.ReadLineAsync()
  }
  if (-not $a.P.WaitForExit(15000)) { $a.P.Kill(); Fail "agent did not exit after shutdown" }
  elseif ($a.P.ExitCode -ne 0) { Fail "agent exit code $($a.P.ExitCode) after shutdown" }
  Write-Host "--- agent stderr ---"; Write-Host $a.Err.Result; Write-Host "--------------------"
}

function Test-Hello($a) {
  $h = Wait-Line $a { param($o) $o.type -eq 'hello' } 90
  if (-not $h) { Fail "no hello within 90 s"; return $null }
  if ($h.protocol -ne 3) { Fail "hello.protocol is '$($h.protocol)', CONTRACT 1.1.0 expects 3" }
  if ($h.version -ne '1.1.0') { Write-Host "::warning::hello.version is '$($h.version)', CONTRACT 1.1.0 expects '1.1.0'" }
  return $h
}

function Get-PresentMonProcs { @(Get-Process -Name $pmName -ErrorAction SilentlyContinue) }
function Test-EtwSession { [bool]((logman query -ets 2>$null) -match '\bNexumFrames\b') }

if (Get-PresentMonProcs) { Fail "a $pmName process is already running before the test" }

# ---------------------------------------------------------------- run 1
Write-Host "=== run 1: no --presentmon ==="
$a = Start-Agent @()
$h = Test-Hello $a
if ($h) {
  $isAdmin = [bool]$h.isAdmin
  $fs = Wait-Line $a { param($o) $o.type -eq 'frameSession' } 15
  if (-not $fs) { Fail "no frameSession after hello (CONTRACT §1.6.6)" }
  elseif ($fs.state -ne 'stopped' -or $fs.signature.status -ne 'notChecked') {
    Fail "first frameSession must be stopped/notChecked, got $($fs.state)/$($fs.signature.status)"
  }

  Send $a '{"cmd":"tuningProbe","write":true}'
  $ack = Wait-Line $a { param($o) ($o.type -eq 'ack' -and $o.cmd -eq 'tuningProbe') -or $o.type -eq 'tuningProbe' } 20
  if (-not $ack) { Fail "no ack for tuningProbe write:true" }
  elseif ($ack.type -ne 'ack' -or $ack.ok -ne $false -or $ack.message -ne 'The write probe is not available in this version.') {
    Fail "tuningProbe write:true must be rejected with ack ok:false 'The write probe is not available in this version.' (got $($ack | ConvertTo-Json -Compress -Depth 3))"
  }

  Send $a '{"cmd":"tuningProbe","write":"yes"}'
  $ack = Wait-Line $a { param($o) ($o.type -eq 'ack' -and $o.cmd -eq 'tuningProbe') -or $o.type -eq 'tuningProbe' } 20
  if (-not $ack -or $ack.type -ne 'ack' -or $ack.ok -ne $false -or $ack.message -ne 'Invalid command') {
    Fail "tuningProbe with a non-boolean write must get ack ok:false 'Invalid command' (got $($ack | ConvertTo-Json -Compress -Depth 3))"
  }

  Send $a '{"cmd":"frames","enabled":true}'
  $fs = Wait-Line $a { param($o) $o.type -eq 'frameSession' -and $o.state -in 'error', 'starting', 'running' } 20
  $expected = if ($isAdmin) { 'exeMissing' } else { 'notElevated' }
  if (-not $fs) { Fail "no frameSession after frames enabled:true without --presentmon" }
  elseif ($fs.state -ne 'error' -or $fs.code -ne $expected) {
    Fail "without --presentmon the session must fail with '$expected' (got $($fs.state)/$($fs.code)); the agent must never search for PresentMon itself"
  }
  if (Get-PresentMonProcs) { Fail "PresentMon is running although --presentmon was not passed" }
}
Stop-Agent $a

if (-not $h -or -not $isAdmin) {
  Write-Host "::warning::agent not elevated on this runner; frame capture runs 2-3 skipped"
} else {
  # ------------------------------------------------------------ run 2
  Write-Host "=== run 2: --presentmon, frames on, hard kill ==="
  $a = Start-Agent @('--presentmon', $PresentMon)
  $started = $false
  if (Test-Hello $a) {
    Send $a '{"cmd":"frames","enabled":true}'
    $fs = Wait-Line $a { param($o) $o.type -eq 'frameSession' -and $o.state -in 'error', 'starting', 'running' } 30
    if (-not $fs) { Fail "no frameSession after frames enabled:true" }
    elseif ($fs.state -eq 'error') {
      Fail "frame capture failed with the pinned Intel exe: $($fs.code) - $($fs.message)"
    } else {
      $started = $true
      $sig = $fs.signature
      if ($sig.status -ne 'valid' -or $sig.sha256Match -ne $true -or $sig.signer -notlike 'Intel Corporation*') {
        Fail "trust check result is wrong for the pinned exe: $($sig | ConvertTo-Json -Compress)"
      }
      if (-not $fs.childPid) { Fail "frameSession $($fs.state) without childPid" }
      if ($fs.sessionName -ne 'NexumFrames') { Fail "sessionName is '$($fs.sessionName)', expected NexumFrames" }
      $run = Wait-Line $a { param($o) $o.type -eq 'frameSession' -and $o.state -ne 'starting' } 10
      Write-Host "session after 10 s: $(if ($run) { "$($run.state) $($run.code)" } else { 'still starting (no presenting app on a headless runner)' })"
      if ($run -and $run.state -eq 'error') { Fail "frame session error: $($run.code) - $($run.message)" }
      if (-not (Get-PresentMonProcs)) { Fail "frameSession says $($fs.state) but no $pmName process exists" }
    }
  }
  Stop-Agent $a -Kill
  if ($started) {
    Start-Sleep -Seconds 3
    $left = Get-PresentMonProcs
    if ($left) {
      Fail "PresentMon survived a hard kill of the agent (Job Object KILL_ON_JOB_CLOSE missing): pid $($left.Id -join ', ')"
      $left | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Write-Host "ETW session NexumFrames after the hard kill: $(if (Test-EtwSession) { 'present (orphan, expected; run 2b must clean it)' } else { 'gone' })"
  }

  # ------------------------------------------------------------ run 2b
  # An elevated agent start with frame capture left off must remove the orphan itself (ControlTraceW stop,
  # CONTRACT §1.6.6), without starting PresentMon.
  if ($started -and (Test-EtwSession)) {
    Write-Host "=== run 2b: --presentmon, frames never enabled, orphaned session from run 2 ==="
    $a = Start-Agent @('--presentmon', $PresentMon)
    if (Test-Hello $a) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      while ((Test-EtwSession) -and $sw.Elapsed.TotalSeconds -lt 15) { Start-Sleep -Milliseconds 500 }
      if (Test-EtwSession) { Fail "the orphaned NexumFrames session survived an elevated agent start (CONTRACT §1.6.6 leftover session fallback)" }
      else { Write-Host "orphaned NexumFrames session removed at agent start" }
      if (Get-PresentMonProcs) { Fail "PresentMon is running although frame capture was never enabled in run 2b" }
    }
    Stop-Agent $a
  }

  # ------------------------------------------------------------ run 3
  Write-Host "=== run 3: --presentmon, frames on, frames off, shutdown ==="
  $a = Start-Agent @('--presentmon', $PresentMon)
  if (Test-Hello $a) {
    Send $a '{"cmd":"frames","enabled":true}'
    $fs = Wait-Line $a { param($o) $o.type -eq 'frameSession' -and $o.state -in 'error', 'starting', 'running' } 30
    if (-not $fs -or $fs.state -eq 'error') { Fail "run 3: frame capture did not start ($($fs.code) $($fs.message))" }
    Start-Sleep -Seconds 2
    $mark = $a.Lines.Count
    Send $a '{"cmd":"frames","enabled":false}'
    $ack = Wait-Line $a { param($o) $o.type -eq 'ack' -and $o.cmd -eq 'frames' -and $o.message -ne 'Frame capture started' -and $o.message -ne 'Frame capture is already on' } 20
    if (-not $ack -or $ack.ok -ne $true -or $ack.message -ne 'Frame capture stopped') {
      Fail "frames enabled:false must ack ok:true 'Frame capture stopped' (got $($ack | ConvertTo-Json -Compress))"
    }
    $st = $null
    if ($a.Lines.Count -gt $mark) {
      # GetRange, not @($a.Lines)[$mark..$n]: slicing a List[object] of PSCustomObjects
      # throws "Argument types do not match" in PowerShell 7.
      $st = $a.Lines.GetRange($mark, $a.Lines.Count - $mark) | Where-Object { $_.type -eq 'frameSession' -and $_.state -eq 'stopped' } | Select-Object -Last 1
    }
    if (-not $st) { $st = Wait-Line $a { param($o) $o.type -eq 'frameSession' -and $o.state -eq 'stopped' } 10 }
    if (-not $st) { Fail "no frameSession stopped after frames enabled:false" }
  }
  Stop-Agent $a
  Start-Sleep -Seconds 2
  $left = Get-PresentMonProcs
  if ($left) { Fail "PresentMon still running after shutdown: pid $($left.Id -join ', ')"; $left | Stop-Process -Force -ErrorAction SilentlyContinue }
  if (Test-EtwSession) {
    Fail "ETW session NexumFrames still exists after a clean stop (ROADMAP §4.3 gate 3)"
    logman stop NexumFrames -ets 2>$null | Out-Null
  } else { Write-Host "logman query -ets: no NexumFrames session (gate 3 OK on this runner)" }
}

if ($script:failures.Count) {
  Write-Host "$($script:failures.Count) smoke failure(s):"
  $script:failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host "Frame capture / tuning guard smoke test OK."
exit 0
