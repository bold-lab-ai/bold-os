# AGENTS.md — building a BOLD talk

Instructions for a coding agent asked to make slides for a BOLD research talk, usually from a paper. Read this whole file before writing a slide.

The template is `bold-slides.html`, next to this file (live: `https://bold-lab-ai.github.io/bold-os/assets/skills/presenting/bold-slides.html`). It is one self-contained HTML file: inline CSS, about 70 lines of vanilla JavaScript for navigation, and the Google Fonts stylesheet as its only external resource. No framework, no build step.

## Start

1. Copy `bold-slides.html` into the working folder as the talk's file (for example next to the paper's `.tex`). Do not edit the template in place.
2. Ask the speaker for, or find: the talk length, the event and session, the authors and affiliations, and the source of truth (the paper version to use). If two versions of the paper exist, use the newer one and say which.
3. Read the paper's source (`.tex`), not only the PDF. Tables and numbers come from there.
4. Agree the slide list with the speaker before filling slides. A 15-minute research talk is usually 12–16 content slides plus a title and section dividers.

## Structure

- Title slide: `<section class="slide s-title dark">`.
- Section dividers: `<section class="slide dark divider">` with `Part N of M`, the part name, and one italic line.
- Content slides: `<section class="slide">` → `.slide-inner` → `.kicker` → `<h2>` title → content.
- Every slide needs a unique, readable `id` (`problem`, `termination`, `results-table`). It is the slide's URL fragment and the deck returns to it on refresh.
- A typical arc: Introduction (background, the problem, the hypothesis or intuition, implications) → Method (preliminaries, overview, one slide per component, the formal version after the intuitive one) → Results (one slide per experiment) → Conclusions and limitations.

The template's slides are **layouts**, not parts of a talk. Build each slide by copying the layout that fits its content, then replace the text. Delete the layouts you don't use, and do not leave the template's instructional text in the talk.

## Layouts

| Layout (slide `id`) | Use for |
|---|---|
| Title (`title`) | the opening slide: short name, full title, authors, venue |
| Section divider (`divider`) | the start of each part of the talk |
| One column (`one-column`) | an argument in words: a definition, a hypothesis, a short list, an optional `.callout` |
| Two columns (`two-columns`) | text beside a figure, table or diagram (`.split`, with `.center`, `.wide-left`, `.wide-right`) |
| Three columns (`three-columns`) | parallel items with aligned parts (`.cards`, `--n` from 2 to 4), with a `.remark` under them |
| Table (`table`) | a full-width table, e.g. a paper's results table verbatim |
| Figure (`figure`) | one full-width figure with a caption |
| Figure and numbers (`figure-numbers`) | a figure plus the two to four numbers read off it (`.keynums`) |
| Bars and table (`bars-table`) | a headline comparison as bars, with the full table beside it |
| Equations (`equations`) | a numbered stack of labelled equations with a symbol list (`dl.dl`) |
| Definition and worked example (`definition-example`) | a `.def` box beside an example laid out by position (`table.grid`) |
| List and box (`list-box`) | takeaways (`.rows`) beside a bordered list such as limitations (`.box`) |

## Type scale

Every piece of text takes exactly one role. Do not set font sizes ad hoc.

| Role | Markup | Style |
|---|---|---|
| Title | `.slide h2` | EB Garamond 800, 2.3rem |
| Heading | `h3`, `.heading` | EB Garamond 700, 1.25rem |
| Body | `.lede`, `.body`, `li`, `dd` | EB Garamond 400, 1.1rem |
| Small | `.small`, `.caption` | EB Garamond 400, 0.9rem, muted |
| Label | `.kicker`, `.label` | Cabin 500, 0.68rem, uppercase |
| Data | table cells | Cabin 0.74rem, tabular figures |
| Math | `.eq`, `.v` | EB Garamond, italic variables |

A label that contains math must keep its case: use `class="label math"`. Uppercasing turns `α`, `μ`, `s_t` into `A`, `M`, `S_T`, which changes the meaning.

## Components

| Need | Use |
|---|---|
| Text beside a figure or table | `.split` (`.wide-left`, `.wide-right`, `.center`) |
| A figure | `<figure class="fig">` + `.caption` |
| A table from the paper | `.rt-wrap > table.rt` (`td.group` + `rowspan`, `tr.first`, `tr.hl`, `.pm` for ±) |
| A worked example by position | `.grid-wrap > table.grid` (`td.on`, `.solid`, `.ok`, `.no`, `.warn`, `.off`, `.mark`) |
| One equation | `.eq` with `.lbl` naming it in words |
| A definition before first use | `.def` |
| Parallel items with aligned parts | `.cards` (`--n` columns) of `.card`, five children each |
| Notation | `dl.dl` |
| Two to four numbers read off a figure | `.keynums` |
| One quantity across a few methods | `.bars` |
| Takeaways | `.rows` |
| Limitations, open questions | `.box` |

## Content rules

These come from building real BOLD talks and from the speaker's corrections. Follow them unless the speaker says otherwise.

- **Titles describe.** Name the slide's role or state the measured quantity and its conditions: "Termination function", "Observation compression at matched success". Not slogans, not "Up to 8× better!".
- **Report measurements, not verdicts.** Write "the spread across seeds falls to ±0.03", not "a stable head start". Mark speculation ("could"). Say where a number comes from when it is read off a figure rather than a table.
- **Paper tables verbatim.** When a result is a table in the paper, the slide shows that table: same rows, columns, values, `±` formatting, headers, bold entries and caption. Parse it from the `.tex` (find `\label{tab:…}`, read to `\end{tabular}`, convert `{\pm}`, `\times`, `\mathbf{}` mechanically); never retype numbers. A plot or highlight bars may sit beside a table, never replace it. Resolve `Section~\ref{}` in captions to the real section number.
- **Intuition before formalism.** Introduce a component in words or with a concrete example, then give its math on the next slide.
- **Define every symbol before it is used,** usually on a Preliminaries slide. Show what each quantity predicts (write `π(a | s)`, not `π(· | s)`).
- **Check claims against the paper's current version.** If a draft and the latest version differ (losses, notation, numbers, authors), the latest wins. Do not carry forward a statement you have not re-read.
- **Colour carries meaning or nothing.** Navy is the single accent. `--good`, `--warn`, `--bad` only encode agree/disagree, teacher/student and the like.
- **No speaker notes** in the file.

## Figures

- Use the paper's figures (its `figs/` folder). Inspect each image before placing it.
- Embed images as `data:` URIs so the deck is one portable file. Images in a folder from a downloaded zip carry the macOS quarantine flag and may not load in the browser.
- Size images with `width:100%; height:auto; max-height:…; object-fit:contain`. `width:auto` inside a grid column can collapse to zero width in Firefox.
- Diagrams you draw yourself (inline SVG) are illustrations: label them as such in the caption, and use the paper's real sizes and names where they exist.

## Verify before handing back

1. The file parses as HTML and every `<section class="slide">` has a unique `id`.
2. Render every slide at 1440×900 in the browser the speaker will present with (Firefox if unsure: `firefox -headless -screenshot <file>#<id> -window-size 1440,900`). Check that nothing overflows a slide, no table scrolls sideways, and no label has been uppercased into wrong math.
3. Every number on a slide traces to the paper's table, text or figure. Spot-check against the `.tex`.
4. Report to the speaker what changed, what you could not verify, and which numbers are read off figures.

Controls, for reference: arrows, Space, Page Up/Down, Home/End; **F** toggles full screen.
