# Nexum final direction: rationale

## The direction

Nexum should feel like a well-made Mac utility running on Windows: white, quiet and exact. It takes the round's "Pro" direction, which won, and grafts on the best ideas from the "Native" and "Swiss" directions:

- macOS large titles on grouped pages, and the same title moved into the unified toolbar when the window is small;
- big tabular numbers;
- full-bleed, zebra-striped data tables, as in Activity Monitor;
- white cards on a #F5F5F7 canvas;
- graphite controls;
- one crimson accent.

There is no glow, no neon, no glass and no gradient anywhere in the UI. Depth comes only from soft card shadows.

## Red brand vs red status

The two reds are kept apart in four independent ways:

1. **Separate jobs.** Crimson `#C8102E` is used for exactly three things:
   - the selected sidebar row;
   - the single primary button of a dialog, sheet or empty state;
   - the logo.

   Nothing else is crimson. Links are ink with a grey chevron, as in System Settings. Toggles, checkboxes, segments, sliders, meters and the focus ring are graphite. Selected rows and cards are neutral grey. On the Clean caches screen, the page button "Clean 2.22 GB…" is secondary because it opens a confirmation; the only crimson button is the dialog's commit.
2. **Separate form.** Brand red is always a solid fill with white text. Status is always a pale tint with dark text and an icon.
3. **Separate hue.**
   - Crimson sits at a hue of 350°.
   - Critical is vermilion at 8°: `#D9381E` for the icon and `#B3260F` for text.
   - The colour distance between them (ΔE76) is 17.9 for normal vision, 15.2 for deuteranopia (deutan) and 21.3 for protanopia (protan).
4. **Shape and word come first.** Every status has its own shape and always shows its word:

   | Status | Shape |
   |---|---|
   | Checking | dashed ring |
   | Optimal | outline check |
   | Attention | outline triangle |
   | Critical | **filled** octagon |
   | Partial sensors | half circle |

   `renders/status-pill-1600x960.png` proves the states stay distinct in greyscale and in simulated deuteranopia and protanopia, using the colour-vision-deficiency (CVD) model of Machado (2009). The sidebar badge keeps its amber on a white capsule, even on the crimson selected row.

## Navigation: sidebar, not toolbar tabs

The app has 8 destinations plus a global health state. A macOS source list holds them at 1280 px without crowding. The groups (Monitor, Hardware, Tools) explain the app at a glance, and the F-key hints run in visual order from F1 to F9.

Machine identity (host, CPU and GPU, admin state, agent link) moves to a footer card in the sidebar. That retires both the old header strip and the status footer and frees the full height for data.

## Typography

**Inter** (OFL, already bundled through @fontsource) is used for all text and all numbers, with `tabular-nums` and `cv05` (an l with a tail).

- SF Pro is not used, because Apple's licence forbids it on Windows.
- **JetBrains Mono** is used only for identifiers.
- **Segoe UI Variable** is the system fallback.

The type scale is in `tokens.css`. Body text is 13/20, the same as macOS.

## Density

The renders (rows include the group headers) show:

| View | 1600 × 960 | 1280 × 800 |
|---|---|---|
| Sensors | 33 rows | 27 rows |
| Drivers | 33 rows | 27 rows |

All tables use 24 px rows, zebra striping, a bold current value, and the unit shown once.

The Dashboard fits at 1280 × 800 because the large title moves into the toolbar below 1400 × 900.

## Charts

| Series | Colour | Contrast on white |
|---|---|---|
| CPU | navy `#1E4FC2` | 7.1:1 |
| GPU | teal `#0E97A6` | 3.5:1 |
| RAM | violet `#B06CF0` | 3.4:1 |
| VRAM | graphite `#5B5B61`, dashed | 6.7:1 |

The worst colour distance (ΔE76) across **all** pairs, not only neighbouring lines, is 16.6 for protan, 23.5 for deutan and 25.4 for tritan.

- Every multi-series line is labelled at its end with its live value.
- The tooltip appears only on hover.
- Single-series charts use an ink line.

The theme was run in real ECharts 5.6.0, the app's own copy: `renders/echarts-check.png`.

## Contrast

`contrast.txt` checks 97 pairs: text on every surface (including hover, selected and zebra rows), status on its tints, and control boundaries under WCAG 2.2 rule 1.4.11 (`#86868B`, from 3.2:1 to 3.6:1). All 97 pass.

Two fixes since round 1:

- The F-key hint on the selected row is now `#FFE5EA` at 4.94:1. It was `#FFBCC7` at 3.72:1.
- Tertiary text is now `#646469`, so it passes on hover and on selection.

## Logo

The mark is "the bond": one continuous trace draws the N and joins two nodes.

- **At 64 px and above** it sits on a white tile. The 1024 px version was refined: the stroke is thinner (2.8 → 2.3 units) and the nodes smaller (radius 2.75 → 2.05), so it reads as a precise trace rather than a molecule.
- **At 16 to 64 px** (the ICO and the taskbar) it uses a solid crimson tile with a white trace, because a white tile almost disappears on a light Windows taskbar.
- The wordmark is NEXUM outlined from Inter SemiBold with opentype.js, then adjusted: tracking +9 %, width +3 %, and a shortened E arm.
- There are mono (`currentColor`) and dark (GitHub) lockups.

### Trademark and similarity check (preliminary, not legal clearance)

I compared the mark by eye with Apple, Adobe, Netflix, Nexon, Google Nexus, CPUID, HWiNFO, Razer, ASUS and MSI, and none is close. The nearest consumer mark is the Netflix N, which is a folded ribbon on black, not a monoline trace with nodes.

I also ran a web search of USPTO records (via Justia) for "N" marks with circle terminals. Two of them need an attorney's look before the stable 1.0 release:

- **A registered stylized "N" made of two parallel lines, each ending in a circle** (USPTO 73735882, reported live). This is the closest found. Its goods were not shown in the search result.
  [justia](https://trademarks.justia.com/737/35/n-73735882.html)
- **An "N" with two dots, listed for computer hardware and software design.** It is wavy-line, not monoline.
  [justia](https://trademark.justia.com/904/59/n-90459210.html)

Other node or circuit N artwork turned up only on stock-logo marketplaces, for example on [Creative Market](https://creativemarket.com/bintank/6091146-Network-N-Letter-Logo). That is unregistered, but it shows the form is common. Nexum's mark is distinct from these because:

- it has a diagonal N;
- it has exactly two nodes, at opposite corners, and no node on the stems;
- it is crimson.

A real clearance means a USPTO Trademark Search and an EUIPO TMview design search (Vienna code 27.05.01 + 26.01), plus a word-mark search for NEXUM in class 9. **This has not been done and needs the owner or an attorney.**

## Not in this round

- Dark mode. The tokens are semantic, so a `:root[data-theme="dark"]` block can be added later.
- Settings modal mocks.
- The Mainboard, SPD, Graphics and OS tabs of System. These follow the same grammar as the CPU and Memory tabs.
