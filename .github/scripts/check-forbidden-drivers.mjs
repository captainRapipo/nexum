#!/usr/bin/env node
// MF-3 / CONTRACT §7.1: Nexum never ships WinRing0 (CVE-2020-14979, flagged by
// Microsoft Defender), InpOut or the OpenHardwareMonitor kernel driver. Hardware
// access goes through the separately installed, vendor-signed PawnIO driver only.
//
// Fails if any of these file names appears anywhere under the given directories
// (agent publish output, Tauri bundle output, portable folder, extracted installers):
//   WinRing0*.sys   inpout*.sys   OpenHardwareMonitorLib.sys
//
// Usage: node .github/scripts/check-forbidden-drivers.mjs <dir> [<dir> ...]
// Missing directories are reported and skipped; at least one must exist.

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  /^winring0.*\.sys$/i,
  /^inpout.*\.sys$/i,
  /^openhardwaremonitorlib\.sys$/i,
];

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: check-forbidden-drivers.mjs <dir> [<dir> ...]");
  process.exit(2);
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield { full, name: e.name };
  }
}

let scanned = 0;
let roots = 0;
const hits = [];
for (const d of dirs) {
  if (!existsSync(d) || !statSync(d).isDirectory()) {
    console.log(`(skip) ${d} does not exist`);
    continue;
  }
  roots++;
  for (const f of walk(d)) {
    scanned++;
    if (FORBIDDEN.some((re) => re.test(f.name))) hits.push(f.full);
  }
}

if (!roots) {
  console.error("check-forbidden-drivers: none of the given directories exist");
  process.exit(2);
}
if (hits.length) {
  for (const h of hits) console.log(`::error::forbidden kernel driver in build output (MF-3): ${h}`);
  console.log("Nexum must never ship WinRing0, InpOut or the OpenHardwareMonitor driver. Use PawnIO (installed separately).");
  process.exit(1);
}
console.log(`MF-3 forbidden-driver check OK: ${scanned} files in ${roots} folder(s), no WinRing0*.sys / inpout*.sys / OpenHardwareMonitorLib.sys.`);
