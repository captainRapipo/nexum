# Nexum design system (1.2)

The light theme in white with one crimson accent that Nexum has used since version 1.2. These files are the design
package as it was delivered; they are reference material and are **not edited** to follow later decisions. Where they
and [`CONTRACT.md`](../../CONTRACT.md) disagree, the contract wins (§4.6.1 shell, §4.7 primitives, §4.9 tokens,
§4.10.3 views).

| File | What it is |
| --- | --- |
| [`SPEC.md`](SPEC.md) | Every component: sizes, tokens, states, the responsive ("tight") rules. |
| [`RATIONALE.md`](RATIONALE.md) | Why it looks this way: the four colour rules, accessibility, the logo, the trademark note. |
| [`tokens.css`](tokens.css) | All design tokens as CSS variables, with comments. |
| [`contrast.txt`](contrast.txt) | Computed contrast ratio of every text and background pair. |
| [`logo/`](logo/) | Logo sources (SVG) and the GitHub social preview image. |

## Where the design lives in the code

| Package file (named in the documents) | In this repository |
| --- | --- |
| `tailwind-theme.css` | [`src-frontend/styles/nexum.css`](../../src-frontend/styles/nexum.css) (the Tailwind v4 `@theme`) |
| `echarts-theme.ts` | [`src-frontend/components/ui/echartsTheme.ts`](../../src-frontend/components/ui/echartsTheme.ts) |
| `logo/NexumEmblem.tsx` | `src-frontend/components/layout/NexumEmblem.tsx` |
| `logo/tauri-icons/*`, `logo/icon.ico` | `src-tauri/icons/*` (the app and installer icons) |
| `logo/app-icon.svg` | [`app-icon.svg`](../../app-icon.svg) in the repository root, and [`logo/app-icon.svg`](logo/app-icon.svg) |
| `mocks/*.html`, `renders/*.png` | Not in the repository. They were the acceptance targets during the 1.2 round; the screenshots in [`docs/screenshots/`](../screenshots/) show the result. |

## Decided differently from the package

These are deliberate (CONTRACT §4.9, "Deliberate differences from the design package"):

1. Nexum keeps the native Windows title bar: no custom caption buttons and no drag region in the toolbar.
2. The sidebar footer has no "linked" line. Its fourth line is Nexum's own CPU and memory use. Nothing in the app says
   how sensors are read (the package's "Agent linked · 1 Hz" in `SPEC.md` is not built).
3. The toolbar field exists only on pages with a filter (Sensors, Drivers). There is no global search.
4. The focus ring is an outline with the same look (a box-shadow ring is lost under a component's own shadow and in
   Windows high-contrast mode).
5. The legacy colour name `gold` maps to graphite, never to the brand colour. Crimson needs an explicit primary button.
6. Tooltips are native `title` attributes.
7. The toolbar title size token is `toolbar-title` (the package's `--text-toolbar` collides with the `toolbar` colour).
8. Light theme only. The package has no dark theme, and 1.2 has none.
9. The bundled Inter subset has no `cv05` feature, so the alternate "l" the package asks for is not rendered. Tabular
   figures work.

## Logo files

| File | Use |
| --- | --- |
| [`logo/lockup.svg`](logo/lockup.svg), [`logo/lockup-dark.svg`](logo/lockup-dark.svg) | Mark and wordmark, for light and dark backgrounds. The README header uses both through `<picture>`. |
| [`logo/lockup-mono.svg`](logo/lockup-mono.svg), [`logo/mono.svg`](logo/mono.svg) | One colour (`currentColor`). |
| [`logo/glyph.svg`](logo/glyph.svg), [`logo/glyph-small.svg`](logo/glyph-small.svg) | The mark alone (the small version is drawn on a 16 px grid, for small sizes). |
| [`logo/wordmark.svg`](logo/wordmark.svg) | The wordmark alone (outlined from Inter SemiBold; no font needed). |
| [`logo/app-icon.svg`](logo/app-icon.svg), [`logo/app-icon-small.svg`](logo/app-icon-small.svg) | The app icon: white tile at 64 px and above, crimson tile below. |
| [`logo/favicon.svg`](logo/favicon.svg) | The browser-preview favicon. |
| [`logo/social-preview.png`](logo/social-preview.png) | 1280 × 640 image for GitHub → Settings → General → Social preview. It has to be uploaded by hand; GitHub has no API for it. |

Brand colour: Nexum Crimson `#C8102E` (on dark backgrounds `#EF3C5A`). It has three jobs in the app and no others:
the selected sidebar row, the one primary button of a screen, and the logo.

**Trademark.** The mark has close prior art (`RATIONALE.md`, "Trademark and similarity check"). A clearance opinion is
wanted before the first stable release.
