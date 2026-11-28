# Changelog

What changed in each Nexum version, newest first.

The section of a version is also what the app shows under "what changed" when it offers that version as an update
(`.github/scripts/updater-manifest.mjs` copies it into the update manifest as plain text). So:

* one `## X.Y.Z` heading per version; preview builds (`X.Y.Z-preview.N`) use the section of `X.Y.Z`;
* `###` sub-headings, `-` bullets and short, plain sentences; at most 4000 characters per section, no tables or images;
* the UI copy rules apply (CONTRACT §4.8), and a release tag does not build without a section for its version.

## 1.2.0

### New look

- A clean light design in white with one crimson accent. A sidebar replaces the top bar; every page has a title, a short
  description and the same toolbar with the status pill, Rescan and Settings.
- Status is always an icon and a word, never colour alone. Numbers use tabular figures so they do not jump.
- A compact layout for small windows (1280 x 800).

### Updates from inside the app

- Nexum can now check GitHub for a newer version and install it for you. It asks once, at first start. Until you
  answer, it does not go online at all.
- "Check automatically" looks once a day and shows a small "Update available" button in the toolbar. Nothing is ever
  downloaded or installed until you click Install update.
- Every download is checked against Nexum's signing key before anything runs.
- Settings > Updates has the switch, a "Check now" button and the choice to get preview versions.

### Plainer words

- When sensors work, Nexum says nothing about how it reads them. If reading stops, Nexum restarts it by itself. Only
  if that does not help, one message appears: "Nexum can't read sensors right now." with a "Try again" button.
- Values that cannot be read show a dash with the hint "Not available right now".

## 1.1.0

- Gaming: opt-in frame-rate capture with Intel PresentMon (rendered FPS, P1 and P0.1 lows, frame-time chart, CPU busy
  versus GPU busy). Nothing is injected into games.
- Sensors: log any sensors to a CSV file every 1, 2, 5 or 10 seconds.
- Health alerts that also work while the window is hidden, with opt-in desktop notifications and a tray tooltip.
- Storage: a daily wear history per drive and a forecast of the months until 10% life remains.
- System: live DDR4 timings, memory, fabric and controller clocks, PCIe links, and Save report (.txt or .html).
- Cooling: a read-only view of AMD Radeon tuning ranges and current values.
- Clean caches: "Show files" lists the 50 largest items of a category, and the Recycle Bin can be limited by age.

## 1.0.0

- First public version: Dashboard, Sensors, System, Storage, Cooling, Drivers and Clean caches.
- One drive-health model everywhere, a S.M.A.R.T. details drawer, fan presets with a thermal override and a crash
  fail-safe, a driver inventory with export and backup, and a cache cleanup with a dry run and an audit log.
