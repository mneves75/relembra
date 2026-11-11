# Design: "Instrumento"

The landing page (`site/`) is a measuring instrument. Every memory is a line measured in bytes,
every wake has a byte budget, every claim has a number. This file documents the shipped system;
`site/assets/site.css` is the source of truth.

## Colour

Dark only, OKLCH, one accent. Tokens in `:root`:

| Token | Value | Use |
|---|---|---|
| `--ground` | `oklch(0.16 0.01 250)` | page ground (graphite) |
| `--raised` | `oklch(0.21 0.012 250)` | code blocks, the rendered memory line, the session panel |
| `--line` | `oklch(0.32 0.012 250)` | hairlines: section rules, row rules, panel borders |
| `--tick` | `oklch(0.44 0.012 250)` | minor ticks, control borders (never behind text) |
| `--ink` | `oklch(0.95 0.005 250)` | headings, primary text, pressed segment |
| `--ink-2` | `oklch(0.76 0.01 250)` | secondary text, major ticks, hatches |
| `--signal` | `oklch(0.74 0.17 55)` | the live measurement, focus rings, the primary action |
| `--signal-hi` | `oklch(0.8 0.15 55)` | primary action hover |

Measured contrast: `--ink-2` is 9.05:1 on `--ground` and 8.25:1 on `--raised`; `--signal` is
8.0:1 on `--ground`, and `--ground` text on a `--signal` fill is 8.0:1. No green, no yellow, no
gradient blends, no glass, no glow. Text selection, caret, scrollbar and focus ring come from the
palette.

## Type

Two SIL OFL 1.1 variable fonts, self-hosted as woff2 (latin and latin-ext) in
`site/assets/fonts/` with their licence texts.

- **Instrument Sans** (wght 400–700, wdth 75–100): all display and text. Headings use
  `font-stretch: 85%` (h1 `clamp(2rem, 1.1rem + 3.3vw, 4rem)`, h2 `clamp(1.75rem, 1.2rem + 1.9vw,
  2.75rem)`, h3 `1.375rem` at 90%). Body is 1rem / 1.55.
- **Martian Mono** (wght 100–800, wdth 75–112.5): real data only (bytes, ids, code, table
  numerals), set at `font-stretch: 87.5%`. Never for prose.

The smallest text is 14 px (`max(0.875em, 0.875rem)` on code). Numerals are tabular everywhere.

## Motif: the ruler tick

1px lines at regular intervals, drawn as hard-stop repeating gradients (stripes, never a blend).
Every one names `in srgb` (`repeating-linear-gradient(90deg in srgb, …)`): with oklch stops the
default interpolation is OKLab, and Firefox then draws no stripe at all; a hard stop looks the same
in either space.

- `--ticks-minor`: every 8px; `--ticks-major`: every 80px.
- Section dividers: a 10px tick band on each section's top hairline, and on the footer's.
- The hero ruler: 28 minor ticks (10 bytes each), majors at 70, 140, 210 and 280. The minor
  ticks are one solid 1px layer each (`var(--minor) calc(100% * k / 28)`), not a repeating
  gradient: a period of the width / 28 is fractional, and WebKit then skips ticks.
- The wake budget slider's track; the gauge under it.
- The proof table's row rules (a 4px tick strip at each row's foot).
- List bullets: a 10px horizontal tick; install steps hang off a 1px vertical rule.
- `--hatch` (135°, 1px every 6px): a refusal, a locked drawer, a tombstone, a wake row left out,
  an unsupported carrier. Every hatch has its meaning in text beside it, never colour alone.

No other ornament: no cards as page structure, no bento grid, no icon tiles.

## Shape

Square corners, `--radius: 2px` at most. Buttons (`.btn`) are 44px-tall rectangles with a 1px
`--tick` border; `.btn--primary` is filled with `--signal` and set in `--ground`. Disabled buttons
take a dashed `--line` border. The segmented control (`.seg`) joins buttons inside one 1px border;
the pressed one is filled with `--ink`. Hairline rules separate content instead of boxes.

## Layout

`.wrap` is `min(1240px, 100% - 2 * var(--gutter))` with `--gutter: clamp(20px, 4vw, 48px)`.
Sections pad `clamp(48px, 5vw, 72px)` top and bottom. Three demos sit in one row from 1024px
(`.trio`), stacked below; install and "what ships" are 7/5 splits from 1024px. The demo panels
are container-query containers (`.demo`): from 560px the drawers and the erase actions go into a
row.

## Components

- **The instrument** (`.inst`): label, auto-sizing textarea, ruler with a scale, the byte count
  in `--signal`, the guard's verdict (`aria-live`), the rendered `<memory …>` line, then the
  primary save action and three example buttons.
- **Demo panel** (`.panel` + `.demo`): heading, at most two sentences, then the working demo under
  a hairline.
- **Command** (`.cmd`): a `--raised` code block with a copy button beside it.
- **Proof table** (`.proof`): what / how / result; results in mono, right-aligned; the eval
  candidates as a second row group with PASS (solid border) and FAIL (dashed) stamps. Below 640px
  each row becomes a two-line grid.
- **Facts** (`.facts`): a definition list of term / detail rows on hairlines.
- **FAQ** (`.qa`): native `<details>`, the marker a drawn plus/minus from two 1px lines.

## Motion

One authored moment: as the hero's byte count passes 140, the textarea's letterforms condense
from wdth 100 toward 75 at 280, and the ruler's ticks fill in orange toward the end. Fills move
by `clip-path`. Everything else is still. Every transition sits inside
`@media (prefers-reduced-motion: no-preference)`; with reduced motion the state changes without
moving.

## Language

Every text node is a `<span lang="pt-BR">` / `<span lang="en">` pair in that order; the inactive
language is hidden by CSS. The inline bootstrap picks `?lang=`, then the saved choice, then the
browser's language.
