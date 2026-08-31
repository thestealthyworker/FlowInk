# FlowInk Dashboard — Design & Build Plan

Companion to `docs/cardledger-build-spec.md` §10 (as amended 2026-08-25) and
`docs/SETUP_STATUS.md`. Covers what goes on top of the existing Next.js
scaffold in `dashboard/`: visual direction, information architecture, the
data-visualisation system, honest-data-state rendering, mobile behaviour,
and a phased build sequence. This document does not change the data model,
RLS policies, or any code — it is the plan for the next agent (or session)
to execute against.

**Grounded against the live project** (`<YOUR_SUPABASE_PROJECT_REF>`,
ap-southeast-1, read-only queries, 2026-08-26): 508 confirmed transactions,
`budgets` genuinely empty, 251 merchants at `confidence='guessed'` (250 —
one is `confirmed`), category distribution skewed hard into `other` (293
of 508 rows — 58%, because `BUS MRT` and similar are misfiled per §10's
backfill notes), all five active/staged payment methods already seeded
including a `manual` row (`method_type='cash'`) for non-card entry, and
`card_dashboard_status()` returning real per-card JSON (HSBC August:
S$0 of a S$1,000 bonus cap with 5 days left; UOB's July statement month
cleared its Tier-3 gate at S$2,265.98 against a S$2,000 threshold). The
scaffold itself (`dashboard/app/`, `dashboard/lib/`) already has
functioning, unstyled pages for exactly the five views plus both AMENDMENT
input surfaces — this plan styles and re-organises what exists rather than
inventing routes from nothing. Existing file paths are cited throughout so
the build sequence can reference real diffs, not hypothetical ones.

**Status as of 2026-08-28 — this is a design plan, not current state; see
`docs/SETUP_STATUS.md` for what's actually live.** Phases D0–D5 below all
shipped 2026-08-26. The home view was then rebuilt again 2026-08-27 (outside
this plan, as its own "Ledger & Ink" visual pass) into a single-page Command
Center with anchor-navigated sections — `/trends` and `/breakdown` as
described in Phase D3 below no longer exist as separate routes, folded into
that one page instead. `/budgets`, `/cards`, `/cards/tier-3`, `/transactions/
new`, and `/triage` are unaffected by that pass and still match this plan's
Phase D2/D3/D4/D5 shape. Read the phases below as the historical record of
what was built and why, not a live route map.

---

## 1. Visual direction — Swiss/International, built as a ledger

### The choice and why

**Direction: Swiss / International Typographic Style**, adapted as a
private financial instrument rather than a poster or a marketing site.
Not "clean minimal" — a specific, load-bearing set of commitments: a
strict grid, a restrained and *functional* palette, typographic hierarchy
carrying meaning that colour alone does not, and flat surfaces that get
depth from structure (grid, hairlines, one deliberate shadow) rather than
from decoration.

This is chosen against the product, not in the abstract:

- **Checked several times a week, often on a phone, sometimes to decide
  whether to buy something in a shop right now.** That is a
  glance-and-decide interface, not a browse-and-explore one. Swiss design's
  entire discipline — one dominant number, a strict hierarchy, no
  ambiguity about what matters most — is built for exactly that read
  pattern. A dashboard-by-numbers grid of equal-weight cards (the banned
  pattern in `design-quality.md`) is precisely wrong here: it forces the
  reader to scan everything to find the one number they came for.
- **The spec's own design principle — "an honest gap beats a confident
  wrong number" — is a typographic problem before it is a data problem.**
  Swiss typography is built around *making distinctions visible through
  structure* (weight, rule, spacing, italics) rather than through
  incidental colour. That is the exact tool needed to make provisional
  vs. confirmed, guessed vs. confirmed-category, and costed vs.
  FX-pending read as different at a glance, not as a tooltip you have to
  hunt for.
- **A private single-user instrument, not a marketing surface.** Swiss
  design's restraint (one accent, not a rainbow; grid discipline, not
  decorative flourish) reads as *serious and trustworthy* for money,
  where a bento-box SaaS-dashboard aesthetic reads as a product trying to
  sell itself to someone. Nobody needs to be sold on their own ledger.

Two required qualities from `design-quality.md`'s ten are done deliberately
rather than left implicit, since Swiss can slide into the banned "flat,
no hierarchy" territory if under-executed: **depth through layering**
(§1.3, one real shadow used once, not zero, not everywhere) and
**grid-breaking composition** (§1.7, the hero total breaks the grid it
sits inside). Combined with hierarchy-through-scale, intentional rhythm,
a real type pairing, and colour used semantically (not decoratively), that
is six of the ten checklist qualities — clear of the four-of-ten bar.

**DECISION POINT — light as the primary theme.** Per the operator's own
rule, dark is not the default; the product has to earn it. Reasoning
here: Swiss typographic tradition is paper-and-ink at its root, and a
white/cream surface with near-black ink reads better in the actual use
context this product names — daylight, a shop's fluorescent lighting, a
quick glance where the phone screen needs to compete with ambient light,
not a dim room. Dark mode is fully specified below (not an afterthought,
not an inversion filter) for the times that context doesn't hold. If the
operator's actual use is mostly evening/at-home, this call should flip —
flag it back if so; it's a five-minute change since both palettes are
already validated.

### Palette — OKLCH tokens

Chrome/ink/status/categorical tokens are taken **directly from the
dataviz skill's validated reference instance**
(`references/palette.md`), not re-derived. That is a deliberate choice,
not laziness: those neutrals already read as paper-and-ink (the reference
palette's own aesthetic is close to Swiss restraint before any branding is
added), and reusing them means every chart automatically shares the exact
surface the surrounding app chrome sits on — the dataviz skill's "read as
one system" requirement applied to the whole app, not just the charts.
Distinctiveness lives instead in typography, the accent colour, and the
depth/rhythm decisions below — where it actually earns its keep. The
categorical eight and the status four are re-validated below, not
eyeballed (`node scripts/validate_palette.js`, run against this plan):

```
Light (surface #fcfcfb): ALL CHECKS PASS
  worst adjacent CVD ΔE 9.1 (protan) · worst normal-vision ΔE 19.6
  contrast WARN on 3 slots (aqua/yellow/magenta) — relief required:
  ship direct labels or the table view, never those slots as fill-only

Dark (surface #1a1a19): ALL CHECKS PASS
  worst adjacent CVD ΔE 8.4 (protan) · worst normal-vision ΔE 19.3
  contrast: all 8 slots clear 3:1
```

```css
:root {
  /* ---- surfaces & ink (shared 1:1 with the chart system) ---- */
  --color-page:        oklch(98.1% 0.003 95);   /* #f9f9f7 */
  --color-surface:     oklch(99.1% 0.002 95);   /* #fcfcfb — cards sit one step lighter than the page */
  --color-surface-sunk: oklch(95.3% 0.006 90);  /* inset wells: table zebra, input fields */
  --color-ink:         oklch(15.9% 0 0);        /* #0b0b0b */
  --color-ink-secondary: oklch(35.6% 0.006 75); /* #52514e */
  --color-ink-muted:   oklch(58.9% 0.004 75);   /* #898781 */
  --color-hairline:    oklch(89.7% 0.006 90);   /* #e1e0d9 */
  --color-baseline:    oklch(78.4% 0.006 90);   /* #c3c2b7 — axis/rule */

  /* ---- brand accent: deliberately NOT in the categorical or status hue families ---- */
  --color-accent:      oklch(30% 0.085 262);    /* deep navy-indigo, ~#1c2b52 */
  --color-accent-ink:  oklch(98% 0 0);

  /* ---- status (fixed, reserved — never reused for a category) ---- */
  --color-good:     oklch(56% 0.17 142);  /* #0ca30c */
  --color-warning:  oklch(80% 0.15 78);   /* #fab219 */
  --color-serious:  oklch(69% 0.13 40);   /* #ec835a */
  --color-critical: oklch(52% 0.16 25);   /* #d03b3b */

  /* ---- categorical (fixed order — see §3 mapping table) ---- */
  --series-1: oklch(56% 0.15 254);  /* blue */
  --series-2: oklch(60% 0.16 40);   /* orange */
  --series-3: oklch(63% 0.14 162);  /* aqua */
  --series-4: oklch(72% 0.15 75);   /* yellow */
  --series-5: oklch(69% 0.12 5);    /* magenta */
  --series-6: oklch(45% 0.13 142);  /* green */
  --series-7: oklch(38% 0.12 292);  /* violet */
  --series-8: oklch(56% 0.17 25);   /* red */

  /* ---- spacing (8px base, denser than a marketing clamp — this is an app, not a hero section) ---- */
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem;
  --space-4: 1rem; --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem;
  --space-section: clamp(2rem, 1.6rem + 1.5vw, 3.5rem);

  /* ---- type scale ---- */
  --text-xs: 0.75rem; --text-sm: 0.8125rem; --text-base: clamp(0.9375rem, 0.9rem + 0.15vw, 1rem);
  --text-lg: 1.125rem; --text-xl: 1.5rem;
  --text-hero: clamp(2.75rem, 1.9rem + 3.8vw, 4.75rem); /* the one big number */

  --duration-fast: 120ms; --duration-normal: 260ms;
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --color-page: oklch(9% 0 0);          /* #0d0d0d */
    --color-surface: oklch(15.8% 0.002 75); /* #1a1a19 */
    --color-surface-sunk: oklch(20% 0.004 75);
    --color-ink: oklch(100% 0 0);
    --color-ink-secondary: oklch(80.6% 0.008 90); /* #c3c2b7 */
    --color-ink-muted: oklch(58.9% 0.004 75);
    --color-hairline: oklch(22.4% 0.004 75); /* #2c2c2a */
    --color-baseline: oklch(28.9% 0.006 75); /* #383835 */
    --color-accent: oklch(68% 0.09 262);
    --series-1: oklch(60% 0.16 254); --series-2: oklch(55% 0.15 40);
    --series-3: oklch(58% 0.13 162); --series-4: oklch(64% 0.14 70);
    --series-5: oklch(62% 0.13 8);   --series-6: oklch(45% 0.13 142);
    --series-7: oklch(66% 0.14 292); --series-8: oklch(64% 0.16 25);
  }
}
:root[data-theme="dark"] { /* identical block, mirrored — see artifact rules on why both scopes are needed */ }
```

### Typography — the pairing and why

Two families, both `next/font/google` (self-hosted at build time by
Next.js — no runtime request to Google, satisfying the CSP "no
third-party script" spirit without a special-case exception):

- **Archivo** (variable, weights 500/700/900, including an Expanded
  width for the hero figure's label) — a grotesque with real Swiss-poster
  character: squared terminals, high x-height, a genuine Black/Expanded
  cut for headings. Carries every heading, label, nav item, and body copy.
- **IBM Plex Mono** (weights 400/600) — every money figure and every
  date, nothing else. Tabular by construction, so columns of amounts
  align without `font-variant-numeric` gymnastics, and the monospace
  grid reads as *audited* — a deliberate signal that this number came
  from a machine-verified ledger, not a rounded estimate. This is also
  where the provisional/confirmed distinction physically lives (§4):
  confirmed amounts sit upright in Plex Mono; provisional amounts sit in
  Plex Mono *italic* with a dashed underline — same face, different
  posture, so the eye catches the difference without needing a legend.

Neither is Inter, Roboto, Arial, or Space Grotesk — the explicitly banned
and explicitly over-used defaults. `font-display: swap` on both; preload
only Archivo 700 and Plex Mono 400 (the two weights the hero and category
bars render on first paint); everything else loads deferred.

Inside chart SVGs specifically (axis ticks, tooltips, legend text), stay
on the *system* sans per the dataviz skill's own rule — Archivo is the
app's UI sans and doubles as that role, so no exception is needed, but
money **values** inside charts (bar-end labels, tooltip amounts) still use
Plex Mono, matching the rest of the app.

### Spacing rhythm

8px base unit, four-step scale (`--space-1` .. `--space-12`) for
component-internal spacing, one `clamp()`-based `--space-section` for
the gap between major page sections. Deliberately **tighter** than the
`coding-style.md` example clamp (`4rem → 10rem`) — that scale is tuned
for a marketing hero section; this is a data-dense app opened for 20
seconds at a time, and over-generous whitespace here would push the
budget hero and the card strip apart across a mobile scroll, which is
exactly the wrong shape for a glance-and-decide tool.

### Depth and layering

Swiss surfaces are flat by tradition; depth is added surgically, not
uniformly, to avoid both banned extremes ("flat, no hierarchy" and
"uniform shadows everywhere"):

- **Layer 0 — page plane** (`--color-page`). Never receives a border or
  shadow.
- **Layer 1 — surface cards** (`--color-surface`, 1px `--color-hairline`
  border, 0 shadow). Every ordinary card: category bars, the trend chart,
  the leaderboard, card-status tiles.
- **Layer 2 — the hero card only.** The current-month total-spend card on
  the home view gets one deliberate offset hard shadow —
  `box-shadow: 4px 4px 0 var(--color-ink)` (a solid Swiss-poster "sticker"
  shadow, not a blurred drop-shadow) — and is allowed to overlap the grid
  column beside it by `--space-4`, breaking the strict column rule once,
  on purpose, for the one number that earns it (the grid-breaking
  composition requirement from `design-quality.md`).
- **Layer 3 — transient overlays** (the budget-planning drawer, the
  triage detail sheet). These are the only places a soft, larger blurred
  shadow plus a scrim appears — motion: slide-up on mobile (`transform:
  translateY`), fade+scale on desktop (`transform: scale`, `opacity`),
  both compositor-only, both skipped under `prefers-reduced-motion`.

One motion moment on load: category bar fills animate their `width` via a
`transform: scaleX()` (not literal `width`, per the performance rule)
from 0 to their value, staggered 40ms per row — the one well-orchestrated
reveal `frontend-design` calls for, standing in for the "money being
counted" metaphor, and nowhere else does anything animate on its own.

---

## 2. Information architecture

Priority order follows §1's goal ordering and §10's view ordering
exactly: **budgets and total spend first**, card optimisation second, the
rest of the dashboard supporting both. The existing route scaffold
(`dashboard/app/(protected)/`) already matches this shape — `page.tsx`
(home), `budgets/`, `transactions/new/`, `triage/` all exist as
unstyled-but-functional pages. This plan adds three routes for views 2,
4, 5 and restructures `page.tsx` into the actual view-1 layout instead of
its current "prove RLS works" placeholder (its own code comment says as
much).

```
/                    View 1 — This month           (restructure existing page.tsx)
/budgets             Input surface — budget planning (restyle existing budgets/page.tsx)
/trends              View 2 — Over time              (new)
/breakdown           View 3 — Where it went           (new)
/cards               View 4 — Card optimisation       (new)
/cards/tier-3        View 5 — The Tier 3 record       (new, nested under /cards)
/transactions/new    Input surface — manual entry     (restyle existing)
/triage              Merchant triage                  (restyle existing)
```

### What earns the top of the screen

On `/`, in strict order:

1. **The hero number**: this month's total confirmed spend vs. total
   budget cap, with days-elapsed/days-remaining and a projected month-end
   figure directly beneath it in `--color-ink-secondary`. "Total budget
   cap" is **derived** — `sum(monthly_cap)` across every category budget
   row for the current period, since the schema has no standalone
   "overall" budget row. **DECISION POINT**: confirm this derived-sum
   approach is what's wanted, versus adding an explicit
   `category = 'total'` sentinel row — the fixed 11-category vocabulary
   doesn't include `'total'`, so a sentinel would need a vocabulary
   change; derivation needs none and is the recommendation.
2. **Category bars against their caps**, sorted by proximity to cap
   (closest-to-breach first, not alphabetical, not by raw spend) — the
   one piece of information-scent that actually matters when deciding
   whether to spend right now.
3. **A one-line card strip**: each active card's period-progress as a
   compact inline gauge (not the full `/cards` detail), so "is UOB safe
   this quarter" is visible without navigating away, per §1's "secondary
   but not absent" framing.
4. Below the fold: this period's manual entries, a link into `/triage`
   showing the outstanding count, and a link into `/breakdown` for
   today's context.

Budgets get a **persistent nav position**, not a buried settings page —
consistent with the amendment's framing that planning is an interactive,
frequent activity, not a one-time setup step. Given `budgets` is
currently empty, `/` must render a first-run state (§4) rather than a
broken 0/0 progress bar; this is not a hypothetical edge case here, it is
the actual current state of the production database.

### Navigation shape

Desktop/tablet (≥768px): a left rail, Swiss-grid-aligned, listing the five
views in priority order plus the two input surfaces as a visually distinct
"Add" group at the bottom of the rail (different visual weight — outlined,
not filled — signalling "these write, everything above only reads").

Mobile (<768px): a bottom tab bar with four items — **This month, Trends,
Where, Cards** — plus a floating action button for manual entry (the
single most likely on-the-go action) and a badge-counted `/triage` entry
reachable from the home view's below-the-fold link rather than a fifth
tab (five bottom-tab items is already tight on a 320px screen; triage is
a weekly chore, not a several-times-a-week glance). **This is a shape
change across breakpoints, not a reflow** — flagged as a real design
commitment in §6, not a free reflow of the same component.

---

## 3. The data-visualisation system

Following the `dataviz` skill's procedure in order: form, then colour
assignment, then the validator, then marks, then interaction, then the
accessibility pass.

### Category → colour mapping

The fixed 11-category vocabulary exceeds the categorical system's 8-slot
structural cap (`references/color-formula.md`: "8 hues, fixed order...
a 9th series is never a generated hue"). Rather than force an ordering
fight, **8 categories carry direct chart identity; the remaining 3 fold
into a shared neutral "Other/misc" bucket** for chart purposes only —
every category still gets a first-class row in tables, the triage list,
and the budgets page, where identity is carried by the text label, not
by hue.

| Slot | Hue | Category | Slot | Hue | Category |
|---|---|---|---|---|---|
| 1 | blue | bills | 5 | magenta | retail |
| 2 | orange | dining | 6 | green | commute |
| 3 | aqua | groceries | 7 | violet | online |
| 4 | yellow | petrol | 8 | red | transport |
| — | neutral gray + texture | healthcare, household, other/uncategorised (chart display only) | | | |

Chosen by current real-world volume and card-reward relevance, not
alphabetically: `other` is currently 58% of all transactions because of
the known mis-triage (`BUS MRT` sits in `other`, not `transport` — §10
backfill notes), so `other`'s share should **shrink** sharply once
`/triage` is worked through, at which point this bucket becomes what it's
meant to be — the genuine long tail, not a data-quality symptom.
**Slot order is preserved from the validated reference instance** (blue,
orange, aqua, yellow, magenta, green, violet, red) — that order is the
CVD-safety mechanism itself, not cosmetic, so categories are assigned to
*existing validated slots*, never re-ordered to "look nicer" per
category name.

Category colour **never doubles as a status signal.** Whether a category
is over/under/near its cap is conveyed by the status palette
(good/warning/serious/critical) applied to the *fill portion* of its bar,
completely independent of which categorical hue that category's legend
chip uses elsewhere (§ marks below). A bar for "dining" that's over
budget turns critical-red regardless of dining's assigned identity hue
being nowhere near red.

### View 1 — category bar against cap (the core mark)

A horizontal bar, not a gauge or donut — magnitude against a single
threshold reads fastest as a filled track. Per-category, left-to-right:

```
[label: category name, dotted underline if confidence='guessed' anywhere in it]
[track: --color-surface-sunk, full width, 4px rounded ends]
  [fill: solid, status colour by % of cap — good <alert_at, warning
         alert_at–100%, critical ≥100% — 4px rounded end anchored left]
  [overage: past 100%, a 45° diagonal texture in critical red rather
            than letting the bar simply run longer — the overage is
            visually a *different kind of thing*, not more of the same]
[value, right-aligned, Plex Mono: "S$412 / S$350"]
```

`alert_at` is read directly from the `budgets` row (not hardcoded 0.8),
so a category the operator tuned to warn earlier does so in the chart,
not just in the (now-removed) Telegram nudge.

### View 2 — over time

**Rolling 12-month total**: a single-line chart, 2px, categorical slot-1
blue, 8px markers at each month, thin baseline grid. Any month containing
an FX-pending (uncosted) transaction gets a second, thinner dashed
"shadow" line sitting slightly above the solid one for that point only,
with a small superscript marker — visually "this figure is a floor, not
the true number" without inventing a guessed total.

**Per-category trend**: explicitly **not** one chart with 8–11 overlapping
lines (the "spaghetti chart" anti-pattern the dataviz skill calls out) —
a small-multiples grid instead, one compact sparkline per category, each
in that category's assigned hue, sharing a y-axis scale so relative
magnitude is honestly comparable across the grid. "Which categories are
drifting up" is answered by sorting the grid by slope, not by reading
line crossings.

### View 3 — where it went

**Category breakdown for the selected period**: reuses the exact bar
component from View 1, unfiltered by a cap (a plain magnitude bar, sorted
descending).

**Merchant leaderboard**: horizontal bars, single neutral hue (this is a
nominal ranking of one series — "spend by merchant" — not an identity
comparison, so per the color-formula's categorical/ordinal distinction it
takes one slot, not eight). Each row: merchant display name, bar, amount,
transaction count, and — the honesty marker — a small dotted "?" badge
next to any merchant still at `confidence='guessed'`, linking straight
into `/triage` filtered to that merchant.

**Payment method split**: a single stacked bar (not a donut — 4–5
segments read faster as a bar than as pie wedges, and stacked segments
get the mandatory 2px surface gap between them per the mark spec). Uses
categorical slots for the active methods; the retired `dbs_posb_platinum`
segment renders at reduced opacity with a dashed border — "this exists in
history, it will never grow again."

### View 4 — card optimisation

Per active card, a composite gauge, not a generic progress bar — this is
the one place the dataviz method's mark specs get extended for a
domain-specific shape:

- A **dual-segment fill**: base-rate spend and bonus-rate spend in two
  visually distinct fills within the same track (base: muted
  `--color-surface-sunk` tone; bonus: the card's own accent, e.g. UOB's
  tier colour), so "how much of this is actually earning the good rate"
  is visible without a second chart.
- **Tick marks** at each tier threshold (S$600 / 1,000 / 2,000 for UOB)
  along the track, with the currently-active tier's tick in `--color-ink`
  and the others muted.
- For UOB specifically, **three small pills above the bar**, one per
  statement month in the current quarter — filled (cleared), hollow
  (pending), or an × in critical red (forfeited) — making the
  all-or-nothing quarterly gate legible as a shape, not a paragraph of
  text. Grounded against real RPC output: the July 2026 statement month
  cleared its gate at S$2,265.98 spend against a S$2,000 Tier-3
  threshold with `gate_cleared: true` — that state renders as a filled
  pill.
- HSBC's bonus-rate assumption is asterisked inline — "assumes contactless
  — unconfirmed until reconciliation" — directly beside the bonus segment,
  never as a buried footnote, since §5 states this is genuinely
  unknowable from alert data alone.
- Citi renders as a greyed "ghost" card with a single line — "not yet
  issued" — rather than being hidden, so the operator sees the system is
  aware of the card, not that it silently forgot.

### View 5 — the Tier 3 record

Reuses the View 2 monthly-total chart exactly, with two additions: a
fixed horizontal reference line at S$2,000 labelled "Tier 3 threshold",
and the single lowest month in the trailing window called out with a
direct label (amount + month), since that lowest month is the entire
answer to "is committing to Tier 3 safe" — the spec's own framing for why
this view exists at all.

### Accessibility pass (applies to every chart above)

A legend is present wherever ≥2 series appear on one chart (never for
the single-line 12-month total — its title names the series); a table
view exists behind a toggle for every chart, satisfying the relief
requirement the palette validator flagged for the 3 sub-3:1 slots (aqua,
yellow, magenta) — those three are never the *only* way to read a value.
Dark mode is the palette's own dark step-set, re-validated against the
`#1a1a19` surface, not a filter. The 45°/135° hand-drawn texture fill
activates for the overage marks and the retired-card segment under
`prefers-contrast: more`, print, and `forced-colors`, matching the
skill's "never decorative, never on by default" rule everywhere else.

---

## 4. Honest-data states

This is the spec's central principle made visual. Six distinct states,
six distinct — and consistent — renderings, reused identically everywhere
a number appears (hero figure, bars, leaderboard rows, tables):

| State | Trigger | Rendering |
|---|---|---|
| **Confirmed** | `status='confirmed'` | Default. Upright Plex Mono, solid fill. No badge — the *absence* of a marker is the signal, so good data doesn't compete visually with the data that needs attention. |
| **Provisional** | `status='provisional'` | Italic Plex Mono, dashed underline on the figure; in a bar/area fill, a lighter tone with diagonal hatch instead of solid. A small clock glyph beside any total that includes provisional rows, with the confirmed/provisional split shown as two numbers, never pre-summed into one figure the reader can't take apart. |
| **FX-pending** | `currency != 'SGD'` | Never enters a total (the data layer already filters `.eq("currency","SGD")` in `lib/data/spend.ts` — this is a rendering decision layered on an existing exclusion, not a new one). Surfaced in a separate "pending conversion" tray beneath the main total: currency + foreign amount + "excluded above, pending statement" — never a guessed SGD figure, per §4's own rule. |
| **`{method}:pending` period key** | Engine cannot confidently resolve a transaction's card period (e.g. the cycle-day/public-holiday-shift ambiguity noted in `SETUP_STATUS.md`'s "Known loose ends" for the 2026-08-16 UOB transaction) | **Not yet emitted by the rules engine today** — this is a forward-looking design requirement, not a state currently in the data. When it exists, render as a distinct "pending assignment" line item in the card view, excluded from the period's spend/tier maths, with a manual-override control. Flagged as a DECISION POINT in §7 — building the dashboard's rendering ahead of the engine emitting the state is fine; the engine change itself is out of this plan's scope. |
| **`confidence='guessed'` category** | `merchants.confidence='guessed'` | Dotted underline under the category name, everywhere that category label is rendered for that merchant — bars, leaderboard, transaction rows, triage list. Tap/hover: "guessed — confirm in triage" with a direct link. 250 of 251 merchants are in this state today; this is not a rare edge case to handle gracefully, it is the majority case to design for as the default. |
| **Silent source** | A payment-method label has produced zero alert-sourced rows in >72h (the same check `heartbeat` already runs — `supabase/functions/_shared/healthchecks.ts`) | A persistent status strip at the top of `/`, not just an out-of-band healthchecks.io email: "No HSBC alerts in 4 days — spend since [date] may be missing." Requires a new small read (per-method last-seen timestamp from `ingest_state` or a derived `max(created_at)` per `method_id`) not yet present in `lib/data/*` — flagged in §6 and §7. |

### Empty states

`budgets` is empty in production right now — this is not a hypothetical
first-run scenario to design defensively for "just in case," it is the
literal current state of the database this plan will be tested against.
`/` must detect zero budget rows for the current period and render a
first-run panel in the hero's position — "No budgets set for
[category/September 2026]" with a direct call-to-action into `/budgets`
— rather than a 0/0 progress bar or a silently-blank hero. Once at least
one budget row exists for the current period, the panel stops appearing
permanently (not per-session-dismissed) — it is a state, not a tip.

The manual-entry and triage pages already handle their own empty states
correctly in the existing scaffold ("No manual entries this month yet.",
"No merchants awaiting triage.") — these need restyling to match the
system, not new logic.

---

## 5. Mobile

Breakpoints per the operator's testing rules: 320, 375, 768, 1024, 1440,
1920. Test hero, category bars, and both themes at each.

**320–375 (the "in a shop" viewport) prioritises exactly one decision:**
can this purchase happen inside budget right now. Above the fold, in
order: the hero total-vs-cap number, the single category bar closest to
its cap (not all eleven — one), and the single card status closest to a
threshold or period end. Everything else — the full category grid, the
trend chart, the leaderboard — sits below a scroll, reachable but not
competing for the first three seconds of attention. The bottom-tab nav
(§2) keeps thumb-reach navigation available without consuming vertical
space the hero needs.

**768–1024**: category bars and the card strip move into a 2-column
layout; the trend chart gets its own row.

**1024+**: the full Swiss 12-column grid activates — left rail nav, hero
spanning 8 columns with its grid-breaking overlap, a 4-column supporting
rail for the card strip and the FX-pending tray.

No horizontal scroll anywhere except inside a chart or table's own
`overflow-x: auto` container (the small-multiples sparkline grid on a
320px screen scrolls horizontally as a strip, each sparkline sized to
roughly half the viewport so two are always partially visible as a scroll
affordance). Touch targets on every actionable element (bar rows linking
to triage, budget cap inputs, the manual-entry FAB) meet a 44px minimum
hit area regardless of visual size.

---

## 6. Build sequence

Each phase ships independently and leaves the app in a working, deployed
state — no phase depends on a later one existing to be usable. Phases are
lettered separately from the build spec's Phase 1–5 numbering (this
entire plan lives inside build-spec Phase 5) to avoid collision.

### Phase D0 — Design system foundation
Tokens (§1) into `dashboard/app/globals.css`; `next/font/google` set up
for Archivo + IBM Plex Mono with correct preload/`display:swap`; base
layout shell (`app/(protected)/layout.tsx`) carrying the nav shape for
both breakpoint regimes, applied to the *existing* unstyled pages so
nothing regresses visually mid-build.
**Acceptance**: both themes render correctly (`prefers-color-scheme` and
a manual `data-theme` toggle both work per the artifact-style dual-scope
pattern); Lighthouse contrast check passes on all text/background pairs;
the five existing pages inherit correct surfaces/type with zero visual
regression from their current (bare-HTML) state.

### Phase D1 — Home view + honest-state primitives
Restructure `app/(protected)/page.tsx` into the View 1 layout (§2's
priority order); build the shared confidence-state components (§4) as
reusable primitives (`ProvisionalAmount`, `GuessedCategoryLabel`,
`FxPendingTray`) since every later view consumes them; wire the
first-run empty state for `budgets`.
**Acceptance**: home view matches the IA priority order exactly; the
first-run panel is verified against the actual empty `budgets` table
(not a mocked empty state); the hero card's grid-breaking shadow and
overlap render correctly at 1024+ and gracefully collapse to a normal
card at 320–768; mobile 320 shows only the three above-the-fold elements
named in §5.

### Phase D2 — Budget planning
Restyle `/budgets`; add the amendment's specific interactive-planning
requirement not yet built anywhere in the scaffold: a per-category
historical-actuals sparkline beside the cap input, updating live as a
candidate cap is typed, drawing the last six months of actuals against
that candidate line so the comparison the amendment calls for is visible
in the same view as the input, not a separate report.
**Acceptance**: setting a cap for a category with historical data shows
the six-month sparkline immediately on selecting that category, before
any value is typed; deleting a budget row is confirmed with a destructive
action pattern (not a bare button, per the "designed active states"
checklist item).

### Phase D3 — Trends, breakdown, triage
Views 2 and 3 (`/trends`, `/breakdown`, new routes) built against
`lib/data/spend.ts`'s existing `getTwelveMonthTrend`,
`getMonthlySpendByCategory`, `getMerchantLeaderboard`,
`getPaymentMethodSplit` — no new data-layer functions needed for these
two views, only presentation. Restyle `/triage` with the badge-count nav
entry and the leaderboard's "?" deep-link target.
**Acceptance**: every chart's categorical palette passes
`validate_palette.js` in both modes (already true by construction, since
§3 uses the pre-validated reference slots — re-run as a regression check,
not a discovery step); a table view exists behind a toggle on every
chart; small-multiples category grid is keyboard-navigable and has visible
focus states.

### Phase D4 — Card optimisation + Tier 3 record
`/cards` and `/cards/tier-3`, new routes, consuming the existing
`getCardDashboardStatus` RPC wrapper in `lib/data/cards.ts` — the
composite gauge (§3) is new presentation work only; `card_dashboard_status()`
already returns everything the gauge needs (`spend`, `cap_amount`,
`tier_hit`, `gate_cleared`, quarter pill state, `gap_to_next`,
`days_left`).
**Acceptance**: rendered card state matches a hand-checked figure against
a live RPC call — e.g. HSBC's August 2026 period shows S$0 spend against
a S$1,000 cap with 5 days left and an `unused_bonus_cap_headroom` risk
flag, and UOB's July 2026 statement month shows its gate cleared at
S$2,265.98 against the S$2,000 tier-3 threshold — both verifiable
directly against `card_dashboard_status()` output at build time.

### Phase D5 — Manual entry polish, silent-source banner, final pass
Restyle `/transactions/new`; add the silent-source status strip (§4),
which needs one new small read against `ingest_state` (or a derived
per-`method_id` `max(created_at)` over `transactions` — a
`lib/data/ingest-health.ts`-shaped addition, the one new data-layer
function this whole plan requires); full responsive pass at all six
breakpoints with Playwright screenshots per the operator's testing
priority order (visual regression first, then accessibility, then
performance, then cross-browser); an axe scan; a Lighthouse run against
`/` and `/cards`; bundle-size check against the operator's App-page
budget (<300kb JS gzipped, <50kb CSS) — this app is closer to that
budget than a landing page's, since it ships two font families and
several chart components, so this is a real check, not a formality.
**Acceptance**: Vercel deployment confirmed on Root Directory `dashboard`,
function region `sin1`; `robots.txt` disallow-all and `X-Robots-Tag:
noindex` present (already specified in `next.config.ts` per the existing
scaffold — verify, don't re-add); an unauthenticated REST call against
the publishable key returns empty on every table per the build spec's own
Phase 5 acceptance bar (this is the build spec's check, restated here
because the visual work must not regress it); all six breakpoints pass
visual regression with no horizontal overflow; both themes score
equivalently on the Lighthouse accessibility pass.

---

## 7. Risks and open questions

Flagged rather than silently decided, per the instruction to surface
judgment calls:

1. **Derived total budget vs. an explicit sentinel row** (§2). Recommend
   derived `sum(monthly_cap)`; flag if an explicit "overall cap
   independent of category sum" is actually wanted — that needs a
   vocabulary or schema change this plan does not propose.
2. **The 8-colour categorical cap folds healthcare, household, and
   other/uncategorised into one neutral bucket** (§3). This is a
   presentation-layer choice, reversible without a data change, but
   worth a look once `/triage` has been worked through and the real
   long-tail shape of `other` becomes visible — the fold list chosen now
   is based on *current* (mis-triaged) volume, which will shift.
3. **`{method}:pending` period-key state is designed but not yet
   emittable** (§4) — the rules engine doesn't currently produce this
   state; SETUP_STATUS's cycle-day/public-holiday note is the closest
   existing analogue. Recommend shipping Phase D4 without it and adding
   the rendering once (if) the engine gains that capability, rather than
   blocking the dashboard on an engine change outside this plan's scope.
4. **The silent-source banner is a genuinely new read**, not a restyle
   (§6 Phase D5) — small, but it's the one place this plan asks for new
   data-layer code rather than pure presentation on existing queries.
   Worth confirming it's wanted in the dashboard itself given
   healthchecks.io already alarms externally — the recommendation here
   is redundancy is correct for this specific failure mode (§7 item 6 of
   the build spec calls a silently-reverted alert threshold "the most
   likely real-world failure and invisible in an aggregate check" — the
   dashboard is where a human would actually look).
5. **Light as the primary theme** (§1) — flagged explicitly per the
   operator's own "don't default to dark" rule. If actual usage skews
   evening/at-home rather than in-shop-daylight, this should flip; both
   palettes are already fully specified either way.
6. **Monospace numerals for every money figure** (§1) is a deliberate,
   distinctive choice tied to the "audited ledger" feel — flag if a more
   conventional tabular sans is preferred; it's a font-token change, not
   a structural one.
7. **Bottom-tab mobile nav vs. left-rail desktop nav is a shape change
   across breakpoints**, not a single reflowing component (§2) — more
   implementation surface than one universal nav component, called out
   so it isn't scoped as smaller than it is.
8. **Vercel config verification, not creation** — `dashboard/next.config.ts`
   and the Vercel project already appear to exist from the concurrent
   security-foundation work; Phase D5's acceptance criteria re-verify the
   `sin1` region, Root Directory, and `noindex` headers rather than
   assuming this plan needs to configure them from scratch. If that
   agent's work lands differently than observed here, D5 is where the
   mismatch surfaces.
