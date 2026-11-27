# Agent memory soak test (MF-7)

**Goal:** prove the hardware agent does not grow in memory over a long session. LibreHardwareMonitor keeps one day of
per-sensor history by default; Nexum sets `ValuesTimeWindow = TimeSpan.Zero` for every sensor (ROADMAP MF-7,
CONTRACT §1.1.1). This test checks that fix on real hardware.

**Pass:** the agent's working set grows by **less than 10 MB** between the baseline and the end of a **24 h** run.

This is a manual test, not a CI job: it needs real sensors and a full day.

## Safety

The test sends **read-only** commands only: `interval`, `sensorStream` and `spec`, and finally `shutdown`.
**Never send `fanPreset`, `fanSet` or any other write command** in this test, and do not run it while the Nexum app is
open (only one agent should talk to the hardware).

## Procedure

1. Build the agent. On a PC with Smart App Control on, run the managed DLL through the signed `dotnet.exe` instead of a
   freshly built `.exe`:

   ```powershell
   dotnet build nexum-agent/NexumAgent.csproj -c Release
   ```

2. Open an **elevated** PowerShell 7 window (so the run matches the real app: all sensors, PawnIO if installed) in the
   repository root, and paste the script below. It starts the agent, turns on the sensor stream (the heaviest read
   path), asks for the system spec once an hour, samples the working set every 5 minutes into a CSV, and stops after
   24 hours.

   ```powershell
   $hours    = 24
   $csv      = "$env:TEMP\nexum-soak-$(Get-Date -Format yyyyMMdd-HHmm).csv"
   $dll      = Resolve-Path 'nexum-agent/bin/Release/net8.0-windows/nexum-agent.dll'
   $psi      = [System.Diagnostics.ProcessStartInfo]::new((Get-Command dotnet).Source, "`"$dll`"")
   $psi.RedirectStandardInput  = $true
   $psi.RedirectStandardOutput = $true
   $psi.RedirectStandardError  = $true
   $psi.UseShellExecute        = $false
   $p = [System.Diagnostics.Process]::Start($psi)
   # Drain stdout/stderr so the agent never blocks on a full pipe.
   $null = $p.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
   $null = $p.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
   $p.StandardInput.WriteLine('{"cmd":"interval","ms":1000}')
   $p.StandardInput.WriteLine('{"cmd":"sensorStream","on":true}')
   'utc,minutes,workingSetMb,privateMb,handles' | Set-Content $csv
   $start = Get-Date
   while (((Get-Date) - $start).TotalHours -lt $hours -and -not $p.HasExited) {
     $p.Refresh()
     $min = [int]((Get-Date) - $start).TotalMinutes
     '{0:o},{1},{2:N1},{3:N1},{4}' -f (Get-Date).ToUniversalTime(), $min,
       ($p.WorkingSet64 / 1MB), ($p.PrivateMemorySize64 / 1MB), $p.HandleCount | Add-Content $csv
     if ($min % 60 -lt 5) { $p.StandardInput.WriteLine('{"cmd":"spec"}') }
     Start-Sleep -Seconds 300
   }
   if (-not $p.HasExited) {
     $p.StandardInput.WriteLine('{"cmd":"shutdown"}'); $p.StandardInput.Close()
     if (-not $p.WaitForExit(15000)) { $p.Kill() }
   }
   "Samples: $csv"
   ```

   Keep the PC awake (power plan: never sleep) and use it normally, including some gaming or other heavy load, so
   sensors change and hardware appears and disappears (for example USB devices, a GPU that idles to zero-RPM).

3. Evaluate:

   ```powershell
   $rows     = Import-Csv $csv | ForEach-Object { [pscustomobject]@{ m = [int]$_.minutes; ws = [double]$_.workingSetMb } }
   $baseline = ($rows | Where-Object { $_.m -ge 10 -and $_.m -le 30 } | Measure-Object ws -Average).Average
   $final    = ($rows | Select-Object -Last 3 | Measure-Object ws -Average).Average
   "baseline {0:N1} MB  final {1:N1} MB  growth {2:N1} MB  => {3}" -f $baseline, $final, ($final - $baseline),
     $(if ($final - $baseline -lt 10) { 'PASS' } else { 'FAIL' })
   ```

   The baseline is the average of the samples from minute 10 to 30 (after start-up and JIT warm-up); the final value is
   the average of the last three samples (the last 15 minutes).

## Recording the result

Add a row to the table below in the PR that touches the agent's sensor handling. Do not record hostnames, serial numbers
or other personal details; describe the hardware generically.

| Date | Agent version | Hardware (generic) | Elevated / PawnIO | Baseline MB | Final MB | Growth MB | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |
