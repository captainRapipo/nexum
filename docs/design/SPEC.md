# Nexum component spec (final)

All values are tokens from `tokens.css`, or the Tailwind names in `tailwind-theme.css`, shown in brackets. Sizes are CSS px at 100% scaling. The mocks in `mocks/*.html` are the visual reference, and `tools/lib.js` holds the reference CSS for every component below.

## Global rules

The four rules every component follows:

1. **Crimson (`--brand`, `bg-brand`) has exactly three jobs:**
   - the selected sidebar row,
   - the one primary button of a dialog, sheet or empty state,
   - the logo.

   It never appears on data, charts, values, chips, links, toggles, focus rings or table rows.
2. **Controls are graphite.** This covers toggles, checkboxes, radios, segmented controls, sliders, meters, the focus ring and links. Selection inside content is neutral grey.
3. **Status is icon + word + tint.** Critical is vermilion and always uses the filled octagon plus the word "Critical".
4. **A button that opens a confirmation is secondary and ends with "…".** The crimson commit button lives in the dialog.

## Responsive breakpoints

"Tight" mode applies **below 1400 px width or below 900 px height**. Use `@custom-variant tight` in CSS.

| Element | Regular (≥ 1400 × 900) | Tight |
|---|---|---|
| Sidebar width | 220 | 200 |
| Page padding x | 28 | 24 |
| Large page title | shown on grouped pages | moved into the toolbar (title + subtitle) |
| Page actions | right of large title | into the first card header |
| KPI numerals | 36 / 40 | 30 / 34 |
| S.M.A.R.T. details | floating sheet + scrim | docked inspector 380 px, no scrim |
| Drivers "Category" column | shown (≥ 1440) | hidden |
| Pinned sensors sparkline | shown | hidden |

List pages (Sensors, Drivers) use the toolbar title at every size. They never show a large title.

---

## 1. Window chrome and titlebar

The window uses a unified toolbar with Windows caption buttons. Use `decorations: false` plus a drag region. If the risk in the implementation plan is not accepted, fall back to native decorations.

**Window**
- Minimum size is 1280 × 800. The default is 1600 × 960.
- Background is `--surface-canvas` #F5F5F7. Set this in `tauri.conf.json` `backgroundColor` and in `index.html`.

**Toolbar**
- Height 52 (`--toolbar-h`), background `--surface-toolbar` #FAFAFB, bottom border 1 px `--border-hairline`.
- Padding-left is `--page-pad-x`.
- The whole toolbar is `data-tauri-drag-region`, except its controls.
- Left to right:
  - **Title block.** Tight mode and list pages only:
    - title in `--type-toolbar-title`, 600 15/19;
    - subtitle in `--type-toolbar-subtitle`, 400 11.5/14, `--text-secondary`, max 420 px, with ellipsis.
  - **Status pill** (§4).
  - **Freshness meta**, for example "Updated 1 s ago · 1 Hz". Callout, `--text-secondary`. Hidden in tight mode.
  - Flexible spacer.
  - **Search field**, 210 × 28 (§11). On list pages it becomes "Filter sensors" or "Filter drivers".
  - **Rescan icon button** with tooltip "Rescan (F5)".
  - **Settings icon button.**
  - **Caption buttons.**
- **Icon buttons:** 30 × 28, radius 7, icon 17 px `--icon-primary`. Hover `--surface-hover`, active rgba(0,0,0,.08).
- **Caption buttons:**
  - 46 × 32 each, top-aligned, glyph 14 px stroke 1.4 in `--icon-primary`.
  - Hover background rgba(0,0,0,.05).
  - Close hover is #C42B1C with a white glyph. This is the Windows convention and the only place system red is allowed, because it is chrome and not data.

## 2. Navigation (sidebar source list)

**Sidebar**
- Width 220 (200 in tight mode), background `--surface-sidebar` #EFEFF2, right border 1 px `--border-hairline`, padding 0 10 10.

**Brand row**
- Height 52, aligned with the toolbar.
- Glyph 18 px (`NexumEmblem size={18}`), gap 8, then the outlined wordmark at 11 px tall.

**Group labels**
- Text: Monitor, Hardware, Tools.
- Caption 500 11/14, `--text-tertiary`, padding 0 10 4, margin-top 12.

**Item**
- Height 28 (`--nav-item-h`), radius 7, padding 0 10, gap 9.
- Label 500 13 `--text-primary`. Icon 16 `--icon-secondary`.
- F-key hint: 500 11 `--text-tertiary`, tabular, right-aligned.
- The order is monotonic F1 to F9:
  - Monitor: Dashboard F1, Sensors F2, System F3.
  - Hardware: Storage F4, Cooling F6, Drivers F7.
  - Tools: Gaming F8, Clean caches F9.
  - F5 is Rescan, in the toolbar.
- States:

| State | Background | Text and icon | F-key hint |
|---|---|---|---|
| Hover | rgba(0,0,0,.04) | unchanged | unchanged |
| Active | rgba(0,0,0,.07) | unchanged | unchanged |
| Selected | `--nav-selected-bg` crimson | white | `--nav-selected-key` #FFE5EA (4.94:1) |
| Focus-visible | — | — | focus ring inset 2 px graphite, plus 1 px white inside on the selected row |

**Badge**
- Shown on rows with an active drive condition (Storage).
- Capsule 18 px tall, padding 0 6 0 4, radius 9.
- Background `--badge-bg` white, ring 0.5 px `--status-warn-border`.
- Contents: status icon 12 px plus a count in 600 11 `--status-warn-fg`.
- The badge keeps its status colours on the crimson selected row.
- Use the critical palette with the octagon for crit conditions.

**Footer card (machine identity)**
- Sits at the bottom, margin-top auto, padding 11 12, radius 10.
- Background `--surface-sidebar-card`, ring 0.5 px hairline.
- Lines:
  - hostname 600 12.5;
  - "5700X3D · RX 9070 XT";
  - shield + "Administrator", or lock + "Standard user";
  - green dot + "Agent linked · 1 Hz".
- All lines except the hostname are callout `--text-secondary`.
- This replaces `StatusFooter` and `HeaderStrip`.

## 3. Toolbar and page header

**Large title (grouped pages, regular mode)**
- Title: `--type-title-1` 600 26/32, tracking −2.1 %.
- Subtitle: body `--text-secondary`, margin-top 3.
- Block margin-bottom 18.
- Actions sit right-aligned on the title baseline.

**Tabs row (System, Cooling)**
- Large segmented control (§13), left-aligned.
- Actions on the right: "Read at 19:33" in callout tertiary, then secondary buttons.
- Margin-bottom 16.

**List-page filter bar**
- Height 44, background `--surface-content`, bottom hairline, padding 0 `--page-pad-x`, gap 14.
- Contents: segmented control, checkboxes and toggles, spacer, then small buttons.

**Status bar (list pages)**
- Height 30, top hairline, background `--surface-toolbar`.
- Callout `--text-secondary`: counts on the left, key hints or a note on the right.

## 4. Status pill (header)

**Geometry**
- Capsule 26 tall, padding 0 8, radius 999, border 1 px, gap 6.
- Contents: icon 15, label 600 12, " · " separator, summary 500 12, chevron 12 at 70 % opacity.

| State | Background | Border | Text | Icon | Glyph |
|---|---|---|---|---|---|
| Checking | `--surface-card` | `--border-subtle` | `--text-secondary` | `--text-tertiary` | dashed ring |
| Optimal | `--status-ok-bg` | `--status-ok-border` | `--status-ok-fg` | `--status-ok-icon` | outline check circle |
| Attention | `--status-warn-bg` | `--status-warn-border` | `--status-warn-fg` | `--status-warn-icon` | outline triangle |
| Critical | `--status-crit-bg` | `--status-crit-border` | `--status-crit-fg` | `--status-crit-icon` | **filled** octagon |
| Partial sensors | `--status-unknown-bg` | `--status-unknown-border` | `--status-unknown-fg` | `--status-unknown-icon` | half-filled circle |

**States**
- Hover: background darkens 4 % (multiply rgba(0,0,0,.04)).
- Focus-visible: focus ring.
- Pressed or open: chevron rotates 180°.

**Click-open popover**
- Width 440, radius 12, `--shadow-popover`, padding 12 14.
- Header: "N active conditions" in headline, plus "evaluated HH:MM:SS" in callout tertiary.
- One row per condition: icon 16, title in headline, action button small secondary on the right, detail in callout secondary.
- Footer: the rules in callout tertiary.
- Esc closes it.

**Rules**
- Text = label + " · " + summary (CONTRACT §5.3).
- The `title` attribute and `aria-label` include the conditions.

## 5. KPI card (strip)

**Strip**
- One card, cells divided by 1 px `--divider`, using `grid repeat(auto-fit, minmax(150px,1fr))`, 5 or 6 cells.

**Cell**
- Padding 14 18 12 (tight: 12 14 10).
- Label: 500 12.5/17 `--text-secondary`, preceded by an 8 px series dot (graphite for VRAM; `--series-neutral` for fan and FPS).
- Value: `--type-display` 600 36/40, tracking −3 %, tabular. The unit is 500 16 `--text-secondary` with a 3 px gap.
- Meta: callout `--text-secondary`, single line, ellipsis.
- Sparkline: 22 px, series colour, 8 % area.
- Unavailable: value "—" in `--text-tertiary`, and the meta becomes `<Unavailable>`.

**States**
- Clickable cells (FPS goes to Gaming) get hover `--surface-hover` and a focus ring.

## 6. Card and section

**Card**
- Background `--surface-card`, radius 14, `--shadow-card`, no border.
- Padding 16 20 (`--card-pad-y` / `--card-pad-x`).

**Card header**
- Min-height 22, margin-bottom 12.
- Title: `--type-title-2` 600 15/20.
- Right side holds one of: a callout meta, a link (§9), a tag, or a small button.

**Footer line (optional)**
- `margin-top:auto`, top divider, callout. Used to end cards at a meaningful summary instead of whitespace.

**Inner well**
- `--surface-inset`, radius 10.

**Grids**
- 12 columns, gap 16.
- Dashboard rows: KPI strip, then 8 + 4, then 4 + 4 + 4. The bottom row stretches to the window, and every card ends at content or a footer line.

**Selected card** (preset tiles, drive cards)
- Inset 1 px `--selected-outline` (ink) plus a 3 px `--selected-ring` (8 % black).
- Never crimson, never a 2 px black border.

## 7. Table (dense, full-bleed)

**Container**
- Content background `--surface-content` white. No card, no inset.
- `table-layout: fixed`.
- Columns get their widths on the `th`, and hidden columns use `display:none` on both `th` and `td`.

**Header**
- Height 28, 600 11 `--text-secondary`, bottom 1 px `--border-hairline`, sticky.
- Sort chevron 11 px.

**Rows**
- Height 24 (`--row-h-dense`), 400 12.5/24, tabular.
- Zebra: even rows `--surface-row-alt` #F7F7F9.
- No per-row borders.
- First and last cells pad to `--page-pad-x`. Other cells pad 0 12.
- Numbers right-aligned. Identifiers (INF, hardware ID, hex) in JetBrains Mono 11.5.

**Row states**

| State | Treatment |
|---|---|
| Hover | `--surface-hover` |
| Selected | `--surface-selected` (neutral 7 % black, no bar, never tinted red) |
| Focus | inset focus ring |

**Status cells**
- Chips (§21).
- An OK row shows a quiet 13 px green check plus "OK" in `--text-secondary`, so long lists stay calm.

**Drivers specifics**
- Problems are sorted first.
- Identical devices are grouped as "× 16" in `--text-tertiary`.
- The Age column is `--text-tertiary`.
- Category is hidden below 1440.
- INF appears only in the detail panel.
- The status bar reads "Nexum never installs drivers."

## 8. Tree-table (Sensors)

**Structure**
- This is the §7 table plus indentation of 16 px per level.
- Chevron 12 `--text-tertiary`.
- Hardware rows: 600, with a 15 px icon.
- Group rows: 600 12 `--text-secondary`, written as "Temperatures · °C 6". The unit shows once per group and the count is tertiary.

**Columns**

| Sensor | Value | Min | Max | Avg | Limit | Last 60 s |
|---|---|---|---|---|---|---|
| flex | 112 | 76 | 76 | 76 | 72 | 168 |

In tight mode the widths change to 68 / 60 / 120.

**Value cell**
- `--type-table-value` 600 12.5, `--text-primary`, with the unit once in `--text-tertiary` 400.

**Min, Max and Avg**
- 400 `--text-secondary`, number only, no unit.

**Limit**
- `--text-tertiary`. Blank when no limit is known.

**Hot rows**
- 14 px status icon before the value.
- Value and limit in `--status-warn-fg` or `--status-crit-fg`.
- Sensor name at weight 500.
- No row tint.

**Other markers**
- Pinned: 12 px pin glyph in tertiary after the name.
- Rename: an inline field replaces the name, 22 px tall, and uses the §11 field style.

**Density**
- 33 rows at 1600 × 960 and 27 at 1280 × 800, measured in the renders.

## 9. Link

- 500 12 (or 13 inline) `--link-fg` ink, followed by a 13 px chevron in `--link-chevron`.
- Hover: underline at 1 px offset 2.
- Focus: focus ring with radius 4.
- **Never red, never blue.** Blue belongs to the info status only.

## 10. Sparkline

- An SVG polyline, stroke 1.25 to 1.5 px with non-scaling stroke.
- Optional area at 6 to 8 %.
- Colour:
  - in tables and pinned sensors, `--series-neutral` #8E8E95;
  - in KPI cells, the series colour.
- Heights: tables 14, pinned 18, KPI 22, fan cards 30.
- A sparkline never takes a status colour.
- When every point is null, render nothing (CONTRACT §4.7).

## 11. Text field and search

- Height 28, radius 6, background `--control-bg` white.
- Border: inset 1 px `--control-border` #86868B (3.3 to 3.6:1).
- Padding 0 9. Leading icon 14 `--text-tertiary`. Placeholder `--text-tertiary`. Trailing `kbd`.
- Focus: focus ring outside the border, and the border becomes `--focus-color`.
- Invalid: border `--status-crit-icon`, plus a message below in callout `--status-crit-fg` with the octagon icon.
- Disabled: `--surface-disabled`, border rgba(0,0,0,.12), text `--text-disabled`.
- Monospace inputs (for example "name.exe") use `--font-mono` 12.

## 12. Buttons

Shared: label 500 13, icon 15, gap 6, nowrap.

| Variant | Size | Background | Text | Border / shadow | Hover | Active | Disabled |
|---|---|---|---|---|---|---|---|
| **Primary** | 28 (lg 32), pad 0 12 (lg 16), r 7 (lg 8) | `--brand` | white | `--shadow-primary` | `--brand-hover` | `--brand-pressed` | `--surface-disabled`, text `--text-disabled`, no shadow |
| **Secondary** (default) | same | white | `--text-primary` | `--shadow-control` (1 px 14 % ring) | bg #F7F7F9 | bg #EFEFF2 | same as primary disabled |
| **Destructive** | same | white | `--status-crit-fg` | `--shadow-control` | bg `--status-crit-bg` | — | same |
| **Ghost / plain** | same, pad 0 8 | transparent | `--text-primary` | none | `--surface-hover` | rgba(0,0,0,.08) | text `--text-disabled` |
| **Small** | 24, pad 0 10, r 6, 12 px, icon 13 | per variant | | | | | |

Rules:

- **Focus:** `--focus-ring` on every variant. On primary, the 1 px white gap separates the ring from the crimson.
- **Primary is used at most once per view.** Allowed places:
  - the default button of a dialog or sheet ("Clean 2.22 GB", "Done");
  - the empty-state call to action ("Turn on frame capture").
- **Destructive** is reserved for irreversible removals outside the confirmed cleanup flow, for example "Delete log".
- **Mapping from today's variants:** `gold` → primary, `teal` → secondary, `ghost` → plain, `danger` → destructive. Keep the old names as aliases.

## 13. Segmented control

- Track `--seg-track` #E8E8EC, padding 2, radius 8, gap 2.
- Segment: height 22, padding 0 10, radius 6, 500 12, `--text-primary`.
- Large variant (view tabs): height 26, padding 0 14, 13 px.
- **Selected:** `--seg-selected-bg` graphite #2C2C2E, white 600 text, shadow 0 1 2 rgba(0,0,0,.18). The selected fill is 11.4:1 against the track and the label 13.9:1 on the fill, so the state does not rely on a white-on-grey difference.
- Hover (unselected): rgba(0,0,0,.05).
- Focus: focus ring on the segment.
- Counts inside segments use `--text-tertiary` (selected: #C4C4CA).

## 14. Toggle (switch)

- 32 × 18, radius 9.
- **Off:** white track, inset 1 px `--control-border`, 12 px knob filled `--control-border`, inset 3. The off state is outlined and hollow.
- **On:** track `--control-on` #2C2C2E, 14 px white knob with shadow 0 1 2 rgba(0,0,0,.3), inset 2. The on state is filled.
- Transition: knob translates over `--dur-fast` with `--ease-standard`.
- Focus: ring. Disabled: 40 % opacity, plus a reason in the `title`.
- Label to the right: body, gap 7.

**Checkbox**
- 15 × 15, radius 4.
- Off: inset 1 px `--control-border`.
- On: `--control-on` fill with a white 1.8 px check.

**Radio**
- 15 round.
- Off: inset 1 px `--control-border`.
- On: inset 4.5 px `--control-on`.

## 15. Slider

- Track 4 px `--slider-track`, radius 2. Fill `--control-on`.
- Thumb: 16 round, white, ring 1 px `--control-border`, shadow 0 1 3 rgba(0,0,0,.2).
- Ends labelled underneath in callout tertiary, tabular.
- Disabled (BIOS-controlled): fill `--gray-400`, thumb ring `--gray-300`, plus a hint such as "Set a preset to change".
- Keyboard: arrows move 1 %, Page Up and Page Down move 10 %. Focus ring on the thumb.

## 16. Tabs

View tabs are the large segmented control (§13). There are no underline tabs. Panels mount only while they are selected (Cooling GPU tuning, CONTRACT §4.10.2).

## 17. Banner

**In-page banner**
- Radius 10, border 1 px `--status-*-border`, background `--status-*-bg`, padding 10 14, gap 12.
- Icon 18 `--status-*-icon`.
- Text: title 600 body, then detail in callout `--text-secondary`.
- Actions: small secondary buttons, then a plain "Dismiss".

**App-level banner (limited mode, fan fail-safe)**
- Full-bleed under the toolbar, min-height 44, padding 6 `--page-pad-x`.
- Same tints, but only a bottom border.
- Fan fail-safe comes first, then limited mode.

| Kind | Tint | Icon |
|---|---|---|
| Info | info | info circle (limited mode uses lock) |
| Warn | warn | triangle |
| Crit | crit | filled octagon |

Crit banners never carry a crimson button. Their action is secondary.

## 18. Dialog (alert)

This follows the NSAlert pattern.

**Scrim**
- `position: fixed; inset: 0` over the **whole window, sidebar and toolbar included**.
- `--surface-scrim` rgba(29,29,31,.30).

**Panel**
- Width 468, centred, radius 16, `--shadow-sheet`, padding 22 22 18.

**Contents, top to bottom**
1. App icon, 56 px, from `icon-128.png`.
2. Title 600 16/21.
3. Body in `--text-secondary`, margin-bottom 14.
4. Optional summary well (`--surface-inset`, radius 10, rows 32 tall).
5. Optional reassurance line with a green shield.
6. Buttons right-aligned, gap 8, min-width 96. Cancel is secondary, the default is primary crimson.

**Behaviour**
- Enter triggers the default button and Esc cancels.
- Focus is trapped and starts on Cancel for destructive flows.
- Motion: fade and scale from .98, `--dur-slow`.

## 19. Drawer / sheet / inspector (S.M.A.R.T.)

**Regular mode: floating sheet**
- `top:12; right:12`, width 520, height fits content up to 100vh − 24, radius 16, `--shadow-sheet`, over the full-window scrim.
- Header: 38 px icon well, title 600 16, meta in callout with ellipsis, close ×.
- Footer: `--surface-toolbar`, top divider. Contents: "Copy as text" (secondary), "Windows reports: Healthy" in callout, "Done" (primary).

**Tight mode: docked inspector**
- Fixed right, below the toolbar, width 380 (`--inspector-w`), left hairline, no radius, no scrim.
- The content area reflows (`padding-right` = 380 + gutter).
- "Done" is hidden and × closes.

**S.M.A.R.T. content**
1. Life hero: warn tint well, 34 px number, word and icon, a meter using `--meter-fill-warn`, and the projection ("about **42 months** until 10 % life").
2. Health log table: ID (mono) | Attribute | Value | Threshold | status icon. Zebra rows of 25 px.
3. Wear history: a 74 px single-series chart plus the rate ("−4.7 points a month").

## 20. Empty state

- Centred in the content area, max-width 640.
- Contents, top to bottom:
  1. Icon tile 72 (radius 18, card shadow, 34 px icon).
  2. Title 600 22/28.
  3. Body 14/21 `--text-secondary`, `text-wrap: balance`.
  4. Secondary note in callout tertiary.
  5. One primary button, large.
  6. Optionally, three "what you'll get" tiles (card, radius 10, padding 14).
- Used by Gaming with capture off, by an empty Sensors tree (the cause comes from `<Unavailable>`) and by search with no results (no button).

## 21. Chips and tags

**Status chip**
- 20 tall, radius 10, padding 0 8 0 5, 600 11.
- Icon 13 plus a word.
- Tint and text come from the `--status-*` tokens.

**The grammar**
- The same words everywhere: **Good / Worn / Failing / Unknown**, plus Info.
- Driver codes: "Code 28 · no driver" uses warn. "Code 45 · not connected" and Code 22 use unknown (neutral).

**Neutral tag** (PWM, Admin, Optional, BIOS auto, GPU-bound, Factory settings)
- 18 tall, radius 5, `--tag-bg`, 600 10.5 `--text-secondary`.
- A tag never conveys health.

## 22. Unavailable "—" state

- An em dash plus a 12 px lock icon in `--text-tertiary`.
- In the full variant, a callout cause follows, using the exact CONTRACT §4.7 texts (for example "Needs administrator").
- The compact variant shows only the dash and the lock, with the cause in `title` and `aria-label`.
- A large value slot (KPI, hero) shows the "—" at display size in `--text-tertiary`, with the full `<Unavailable>` in the meta line.

## 23. Tooltip

- White background, radius 8, `--shadow-popover`, padding 6 9, callout `--text-primary`, max-width 280.
- Appears after 400 ms delay, at `--dur-fast`.
- Status-rule tooltips list the rule in `--text-secondary` below the title.

**Chart tooltip (ECharts)**
- Axis trigger, shown **only on hover**: never frozen, never part of the default render.
- White, radius 10, tabular values, crosshair rgba(0,0,0,.22).

## 24. Focus ring

- `--focus-ring`: 0 0 0 1 px white, then 0 0 0 3 px `--focus-color` graphite #2C2C2E. That is 2 px of graphite with a 1 px white gap.
- Inside rows and list items, use `--focus-ring-inset` (inset 2 px).
- Contrast is 13.9:1 on cards and 12.8:1 on canvas.
- Show it only for `:focus-visible`.
- Never crimson, so a focused data row can never read as an alarm.

## 25. Charts (ECharts theme `echarts-theme.ts`)

**Series**

| Series | Colour | Line |
|---|---|---|
| CPU | navy #1E4FC2 | solid, plus 7 % area |
| GPU | teal #0E97A6 | solid |
| RAM | violet #B06CF0 | solid |
| VRAM | graphite #5B5B61 | dashed 4 3 |
| Single series (frame times, I/O, wear, fan curve) | ink #3A3A3E | solid |

**Separation**
- All pairs are CVD-checked: worst protan ΔE 16.6, deutan 23.5, tritan 25.4.

**Axes and lines**
- Line width 1.75, no symbols.
- Gridlines #ECECEF solid. The axis line is the x-axis only, #C9C9CE.
- Labels: Inter 500 11 `--text-tertiary`.
- Reference lines: dashed 4 4 #B9B9BF, labelled at the end ("60 Hz · 16.7").

**Labels**
- Multi-series charts label every line end: a 10 px swatch, then the value in 600 ink, then the name in secondary (`nexumLine()` endLabel plus `labelLayout.moveOverlap`).
- Grid right margin is 92.
- There is no legend row.

**Behaviour**
- Animation off for live data.
- Updates at most once per animation frame. Rendering pauses while `document.hidden`.

## 26. Motion

| Duration | Value | Used for |
|---|---|---|
| Hover / press | 80 ms | |
| Fast | 140 ms | toggles, segments, pill state |
| Base | 220 ms | popover, inspector |
| Slow | 300 ms | sheet, dialog |

- Ease: `cubic-bezier(.2,0,0,1)`.
- 1 Hz sensor text never animates.
- `prefers-reduced-motion` sets everything to 0.
