# Onboarding spec — configuring FlowInk for your own cards

This is the machine-readable spec an AI agent (Claude Code, Codex, or any
similarly capable coding agent) reads to configure a fresh FlowInk
deployment for **your** credit cards and wallets. If you are that agent:
read this whole document before writing anything. If you are the human
who forked this repo and pointed an agent at it: this document is what
the agent is following, and the "What the agent must tell you" section
near the end is what it owes you at the end of a session.

**The one fact that governs everything below:** the agent researching
your cards' reward terms is going to be confidently wrong sometimes. A
wrong cashback rate is not a cosmetic bug — it is spending advice you act
on with real money. This spec exists to bound that risk structurally, not
to trust the agent's diligence. Every reward rule the agent proposes lands
`pending_review` in the database, invisible to every real number the app
shows you, until a human — you — looks at it and approves it. Nothing in
this document, and nothing the validator below does, is a substitute for
that human review. It is scaffolding to make that review fast and honest,
never a way to skip it.

## 0. Where this fits

Two paths write to the same tables (`payment_methods`, `method_rules`,
`method_conditions`) — a human filling in the dashboard's config UI by
hand, and an AI agent following this spec. Neither is a shortcut around
the other's checks: **the single validated write path for a reward rule
is `submit_method_rule()`** (`supabase/migrations/0018_config_review.sql`
— read that migration's header in full before touching any of this; it
is the actual contract, and this document does not restate it, only
builds on it). This spec's validator (`scripts/validate_ai_config.py`)
is the thing that calls `submit_method_rule()`, never you (the agent)
directly, and never a raw `INSERT`.

## 1. What to elicit from the user — a structured interview, not a form-fill

Run this as a conversation, but treat it as gathering exactly these
fields — don't invent fields, don't skip required ones by guessing.

**Once, for the deployment:**
- Country/locale (drives the default currency and, later, date-format
  assumptions elsewhere in the app — not this spec's concern beyond
  recording it).
- Default currency (ISO 4217, e.g. `SGD`, `USD`, `GBP`).

**Per card or wallet the user holds, ask:**
- Issuer and product name (e.g. "UOB", "UOB One").
- Card or wallet type: `credit_card`, `wallet`, `bank`, or `cash`.
- Last 4 digits — or "not issued yet" (`null` is a legitimate,
  first-class answer here; do not ask the user to make one up, and do
  not fabricate one yourself. See `payment_methods_alert_label_key`
  and the `(issuer, last4) where active` uniqueness index — a fabricated
  last4 can collide with a real card later and the failure will look
  like a database bug, not what it actually is).
- Statement cycle vs. calendar cycle, and — only if they know it — which
  day of the month the statement closes. **"I don't know" is a valid,
  expected answer.** Leaving `cycle_day` null is the correct behaviour,
  not a blocker: transactions on that card land in a `'...:pending'`
  period key until the user fills it in later from a real statement (see
  `card_current_period_key()`, `supabase/migrations/0007_rules_engine.sql`).
  Do not ask the user to guess a plausible-sounding day.
- Which email address receives this card's transaction alerts and
  statement emails (usually the same Gmail account for every card, but
  ask — a household may split cards across two mailboxes, and this spec
  only configures routing for one mailbox at a time).
- Whether they want reward-rule research done for this card at all. A
  debit card, a cash wallet, or a card the user doesn't care to optimise
  is legitimately `has_rules = false` — do not research or propose rules
  for a method the user didn't ask you to.

**Do not ask the user to state their card's reward rates from memory and
transcribe them as fact.** A cardholder's own recollection of their
card's terms is exactly the kind of unverified claim this system exists
to distrust — see §2. If the user volunteers "I think it's 5% on
dining," treat that as a lead for your own research, not as a citation.

## 2. What to research, and to what standard

For every card with `has_rules = true`, find the issuer's own published
terms and conditions — the actual PDF or terms page the bank publishes,
not a comparison site, forum post, or your own training-data recollection
of "what this card usually pays." For each distinct reward mechanic
(a tier, a category bonus, a cap, a minimum-spend gate, a crediting
quirk), you need:

- The exact threshold, rate, or cap value, in the card's stated units.
- The categories or merchants it applies to, and any real-world
  exclusions the T&C states (hotel restaurants excluded from "dining,"
  transit excluded from "commute," etc. — see
  `docs/reference-example-sg.md` for what this looks like done
  thoroughly on a real card).
- A citation: **a URL to the issuer's terms page or PDF, plus the clause
  or section if the document has one.** "I know this card" is not a
  citation. A comparison-site summary is not a citation — go to the
  primary source it's summarizing. If you cannot find a real,
  dereferenceable URL for a claim, you do not have a citation for it,
  full stop — see §5 for what to do next, which is **not** to write a
  plausible-looking source anyway.

**The validator's citation check is a syntax check only — it does not
verify anything.** It confirms a citation carries a real-looking
`http(s)://` URL and is not a known placeholder host; it never fetches
the URL, never confirms it resolves, and never confirms the page says
what the rule claims. Passing that check means "this looks like a
citation," not "this citation was verified" — the actual verification
(does this URL really say what I'm claiming) is entirely on you, during
research, before you write it down. Never represent a rule as "cited"
or "sourced" to the user in a way that implies more than that; say what
you actually did ("found in UOB's published T&C at this URL") rather
than a word that could be read as "verified by the system."

**A rule you cannot cite is not a rule you should quietly drop, either.**
If you're confident a bonus category exists but can't pin the exact
rate, still propose the rule with your best understanding, an empty
`source_citations` array, and a low `ai_confidence` — that is a real
signal to the reviewer ("the agent thinks this exists but couldn't
verify it"), which is more useful than silence. What you must never do
is fabricate a URL, invent a clause number, or round a low-confidence
guess up into a confident-sounding rate with no citation attached.

## 3. What the agent must emit

A single JSON document, one object per row you're proposing — this is
close to a direct serialisation of the `payment_methods` /
`method_rules` row shapes, deliberately: your job is to produce rows,
not a different representation the validator has to reinterpret.

The worked example below is for onboarding a brand-new card, so it
populates every `payment_methods[]` field. **If you are instead
proposing a change for a card that already exists, include `id` plus
only the fields you are actually setting or changing — never every
field you happen to know, and never a re-guessed value for a field you
didn't mean to touch.** See §3's note below on why: for an existing
row, restating a field with a value that drifts from what's on record
reads as a proposed change to it, and three of these fields cannot be
changed through this path at all.

```jsonc
{
  "deployment": {
    "country": "SG",              // ISO 3166-1 alpha-2
    "default_currency": "SGD"     // ISO 4217, ^[A-Z]{3}$
  },
  "payment_methods": [
    {
      "id": "uob_one",                    // text primary key you choose: lowercase, snake_case,
                                           // stable (other rules reference it by this exact string)
      "display_name": "UOB One",
      "issuer": "UOB",
      "last4": "6549",                    // exactly 4 digits, or null ("not issued yet")
      "method_type": "credit_card",       // 'credit_card' | 'wallet' | 'bank' | 'cash'
      "period_type": "statement",         // 'calendar' | 'statement'
      "cycle_day": null,                  // 1..31, or null if unknown — never guessed
      "reward_type": "cashback",          // 'cashback' | 'miles' | null (null only if has_rules=false)
      "has_rules": true,
      "active": true,                     // false = staged, not yet live (card not issued yet)
      "currency": "SGD",                  // ISO 4217, this method's home currency
      "alert_label": "Payments/UOB",      // Gmail label routing alerts to this card, or null
      "alert_senders": ["uobgroup.com"],  // exact From-header domain(s), or null — see §6
      "statement_senders": ["uobgroup.com"],
      "aggregation_window": 3,            // integer >=2: consecutive periods a cross-period
                                           // tier must ALL clear, or null (see §4, primitive #9)
      "aggregation_anchor_date": null,    // first day of the first such window, or null (unknown —
                                           // never guessed; see 0015's comment on this column for
                                           // why a wrong guess here is worse than leaving it null)
      "reward_unit": "cashback_sgd_additional"  // free-text label for what reward_tracks[].accrued
                                                 // means to a human — e.g. "cashback_sgd_additional",
                                                 // "miles_best_partner_equivalent_2.5to1"
    }
  ],
  "rules": [
    {
      "method_id": "uob_one",             // must match a payment_methods[].id above, or an
                                           // existing DB row — never a dangling reference
      "rule_type": "tier",                // 'min_spend' | 'tier' | 'category_rate' | 'cap' | 'txn_count'
                                           // NEVER 'quarterly_gate' — legacy, unsupported, see §4
      "categories": null,                 // null = applies to all categories, or a list drawn
                                           // from exactly: groceries, dining, petrol, commute,
                                           // transport, bills, online, retail, healthcare,
                                           // household, other
      "threshold": 600,                   // CURRENCY UNITS of spend (dollars, not cents) — the
                                           // spend level a tier/min_spend gate requires
      "rate": null,                       // see the unit warning in §4 — omit or null for
                                           // reward_form='fixed_payout' tier rows
      "cap_amount": null,
      "payout": 60,                       // CURRENCY UNITS — flat reward amount for reward_form='fixed_payout'
      "txn_min": 10,                      // integer minimum transaction count, or null
      "priority": 10,                     // integer, higher evaluated first; default 0 if unsure
      "valid_from": "2025-07-01",         // required, ISO date
      "valid_to": null,                   // ISO date or null ("still in effect")
      "notes": "Tier 1. Flat S$60/quarter.",  // human-readable; first sentence becomes the UI label
      "cap_basis": null,                  // 'reward' | 'spend' — REQUIRED on rule_type='cap', else null
      "reward_form": "fixed_payout",      // 'rate' | 'fixed_payout', or null (defaults to 'rate')
      "gate_scope": null,                 // 'tier_only' | 'all_rewards' — only meaningful on
                                           // min_spend/txn_count rows
      "credit_block_size": null,          // CURRENCY UNITS — post-processing crediting transform
      "credit_floor": null,               // CURRENCY UNITS, paired with credit_block_size
      "estimate_caveat": null,            // free text shown whenever this row is matched, for an
                                           // assumption the ingest pipeline can't confirm (e.g.
                                           // "assumes contactless — alert data can't confirm this")
      "condition_key": null,              // e.g. 'ega' — a label matched against method_conditions,
                                           // which ONLY an operator populates (see §4). If you set
                                           // this, say so plainly to the user: the rule will read
                                           // as "condition not met" every month until they do.
      "source_citations": [               // ALWAYS an array, even when empty. Never omitted.
        { "title": "UOB One Card T&C ver 2.1", "url": "https://www.uob.com.sg/...", "quote": "..." }
      ],
      "ai_rationale": "UOB One T&C clause 3.2: flat S$60 cashback once monthly spend and 10 transactions both clear S$600.",
      "ai_confidence": 0.85               // 0.0..1.0, REQUIRED. See §5 — MUST be <= 0.2 if
                                           // source_citations is empty (the validator enforces this;
                                           // it will not silently accept a high number with no source).
    }
  ]
}
```

Emit real SQL or call `submit_method_rule()` yourself? **No — never.**
Emit only this JSON, and hand it to the validator
(`python3 scripts/validate_ai_config.py your_config.json`). The
validator is the one thing with a database credential in this flow; you
are not, and should not try to be.

**`payment_methods` rows are not gated the way `method_rules` rows are,
and that is a deliberate, disclosed scope boundary, not an oversight —
but it only applies to a genuinely NEW method, and only to fields other
than the anti-spoofing routing controls.** The identity fields above
(issuer, last4, cycle day, currency, routing) are what the *user* told
you directly in the interview — not an independent claim you researched
and could be wrong about the way a reward rate can be — so for a
`payment_methods[]` row whose `id` does not already exist, the validator
writes it straight through (idempotently, keyed on `id`) once it passes
schema validation, without a review-queue step.

**For a row whose `id` already exists, this is narrower.** `last4`,
`alert_senders`, and `statement_senders` are this app's anti-spoofing
controls — the ingest pipeline reads them to decide whether an email is
genuine (§6). The validator refuses to change any of them on an
already-existing method through this path, full stop: it is not that
you need a citation or higher confidence, it is that this path may
never touch them once set. If research or the interview surfaces a
change to one of these on a card you've already onboarded, say so
plainly to the user and point them at `/config` — a human sets a
routing domain on their own authority, an AI never does. Every other
field on an existing row (`display_name`, `cycle_day`, `active`, and so
on) still writes straight through the same as a new row, and
`reward_type` on an existing row is never taken from your submission at
all (see §4's note on this) — the validator uses the value already on
record and treats a claimed change as its own finding, not a silent
relabel.

Every `method_rules` row referencing a method still goes through the
full five-stage gate and `pending_review` regardless of how the method
itself was created. As of this writing, the schema has no
`submit_payment_method()`-style function analogous to `submit_method_rule()`
— `0018_config_review.sql` only built that discipline for reward rules;
the validator itself is what enforces the narrower rule above for
payment methods, in Python, ahead of the write. If this ever needs its
own validated write path (a future work package, not this one), build
it the same way: one function, one place status is decided, never a
raw `INSERT` from more than one call site.

**When you're proposing a change for a card you already onboarded,
submit only the fields you are actually setting or changing** — not a
full restatement of every field you already know, and never a re-guess
of a value (`reward_type` above all) just to "complete" the object.
Restating a field you didn't mean to change, with a value that drifts
even slightly from what's on record, reads to the validator as a
proposed change to that field, and for the three protected fields above
it blocks the entire row. The worked example in the next section is a
brand-new card and therefore populates every field; an update to an
existing one should carry `id` plus only the fields that changed.

## 4. Mapping research onto the rule primitives — and the unit trap

`method_rules` has exactly the columns above; `evaluate_period()`
(`supabase/migrations/0015_generic_rules_engine.sql`) is what actually
reads them. Before proposing a rule, be certain which primitive you're
using — read `docs/architecture.md` §6 for the full description of
`cap_basis` / `reward_form` / `gate_scope` / `credit_block_size` /
`credit_floor` / `estimate_caveat` / `condition_key`. This spec adds only
what that document doesn't need to say for a human, because a human
doesn't get this wrong the way a model does:

### `rate` is the single most dangerous field in this schema

`evaluate_period()` computes `reward = matched_spend * rate` identically
for every card, cashback or miles. What that number *means* depends
entirely on `payment_methods.reward_type` for the card the rule belongs
to — the engine does not know or care; only a human reading the output
does. Get this wrong and every downstream figure is wrong by orders of
magnitude, silently, because nothing in the schema stops a syntactically
valid but nonsensical rate from being stored.

**For a card that already exists, `reward_type` is not yours to set.**
The validator uses the value already recorded in `payment_methods` for
every `rate` plausibility check above, regardless of what this
submission's `payment_methods[]` entry claims — a relabelled
`reward_type` must never be able to walk an implausible `rate` past the
check that exists to catch it. If you believe a card's reward
programme genuinely changed, say so explicitly to the user rather than
just emitting a different value; the validator surfaces a claimed
change here as its own finding, it does not silently apply it. This
only applies once a card has an existing row — a brand-new card has no
recorded value yet, so your `reward_type` is all there is.

- **`reward_type = 'cashback'`**: `rate` is a **fraction of spend**,
  strictly between 0 and 1. Eight percent cashback is `0.08`. It is
  **never** `8`. A cashback `rate` above roughly `0.30` (30%) is
  virtually certain to be a decimal-point or percent-vs-fraction error —
  the validator's semantic stage rejects it outright rather than
  guessing which one you meant.
- **`reward_type = 'miles'`**: `rate` is **miles (or points) earned per
  one unit of the card's currency spent** — "miles per dollar," commonly
  written "mpd" on the card's own marketing. `4.0` means 4 miles per
  SGD spent; this is *not* a fraction and routinely exceeds 1. HSBC
  Revolution's real base and bonus rates are `0.4` and `4.0`/`8.0`
  respectively (`load_example_data_singapore()`,
  `supabase/migrations/0018_config_review.sql`) — notice the base rate
  *is* below 1 while the bonus rates aren't; there is no single
  "plausible range" shortcut here, which is exactly why this needs a
  citation, not a guess.
- `threshold`, `payout`, `cap_amount` (when `cap_basis = 'spend'`),
  `credit_block_size`, and `credit_floor` are **always currency units**
  (dollars), on every card, regardless of `reward_type`. Never reward
  units, never cents.
- `cap_amount` when `cap_basis = 'reward'` is denominated in **the same
  unit `reward_accrued` is** — dollars of cashback for a cashback card,
  a raw miles/points count for a miles card. Do not convert a
  miles-denominated cap into a dollar-equivalent; the engine never does
  that conversion either, and doing it yourself just relocates the unit
  error one field over.
- A `tier` row with `reward_form = 'fixed_payout'`: sanity-check your own
  proposal before submitting it — `payout` should be a small fraction of
  `threshold` (every real example in this codebase is roughly 10%; see
  `load_example_data_singapore()`). If your `payout` is close to or
  larger than `threshold`, you have very likely transposed the two
  values or misread which figure the T&C states in which unit. The
  validator rejects this; catching it yourself first saves a round trip.

### When a mechanic doesn't fit — say so, don't approximate

Not every real card mechanic is expressible in this primitive set, and
this codebase already has two honestly-documented examples of exactly
that (`docs/reference-example-sg.md`, "Not modelled at all" /
"A live quirk found on the reference deployment"):

- **UOB One's pro-rated first-quarter payout** for a card that only
  clears its tier threshold in the quarter's second or third month —
  never implemented, because no evaluator primitive here expresses
  "pro-rate a flat payout against partial quarter coverage."
- **A statement close date that shifts to the next business day** when
  the nominal `cycle_day` falls on a weekend — a single fixed
  `cycle_day` integer cannot express a calendar-aware shift, and this
  codebase does not implement one.

If you find a mechanic like this — a rotating category that changes
without an operator update, a per-merchant sub-cap distinct from the
card's overall cap, a reward that depends on transaction sequence rather
than aggregate spend — **do not approximate it with the nearest
primitive and call it done.** `payment_methods.rule_overrides` exists in
the schema but ships **intentionally inert** — `NULL` on every row, with
zero override keys `evaluate_period()` checks for
(`supabase/migrations/0015_generic_rules_engine.sql`'s comment on that
column is explicit: don't add a speculative key here for a mechanic
nothing in this codebase has actually implemented support for). Do not
invent override semantics to fill that gap. Instead: **emit no rule for
that mechanic**, and say so plainly in your summary to the user — name
the mechanic, name the card, and say it is not currently expressible by
this engine, the same way this codebase's own docs already do for the
two cases above. An honest gap beats a wrong number every time.

## 5. The confidence gate — never dressed up

`source_citations` and `ai_confidence` are not decoration; the review
queue (`dashboard/components/config/RuleReviewCard.tsx`) renders them as
the entire basis for a human's decision. Two rules, enforced by the
validator, not by convention:

1. **Empty `source_citations` is not an error — a fabricated one is.**
   If you found nothing to cite, emit `"source_citations": []`. Do not
   invent a title with no URL, and do not cite a URL you didn't actually
   verify resolves to the claim you're making.
2. **A claim with no real citation gets a low confidence, mechanically,
   not just as a norm.** The validator treats any rule whose citations
   don't include at least one real `http(s)://` URL as uncited, and
   **rejects the submission outright** if `ai_confidence` is above `0.2`
   in that state — "I'm 95% sure and I have no source" is exactly the
   failure mode this whole system exists to prevent, so it is refused
   rather than passed through with a loud label. Lower your stated
   confidence to honestly reflect an unverified guess, or go find the
   citation; there is no third option.

`ai_confidence` is rendered to the reviewer as a plain **low / medium /
high** label (`dashboard/lib/derive/ruleCopy.ts`'s `confidenceLabel()`),
never a bare number — calibrate your value with that in mind: below
`0.4` reads as low, `0.4`–`0.75` as medium, above that as high.

## 6. Email routing config

Once a card's `payment_methods` row exists with `alert_label` /
`alert_senders` / `statement_senders` set
(`supabase/migrations/0014_ingestion_routing_as_data.sql`), the live
ingest pipeline can route that card's alert and statement emails
automatically. Full setup mechanics (Google Cloud OAuth, minting a
refresh token, the day-8 token-expiry trap) are
`docs/setup/gmail.md` — this spec only covers the config-shape part:

- **`alert_label`**: the Gmail label the user's mail filters apply to
  this card's transaction-alert emails. Suggest the
  `Payments/<Issuer>` convention this codebase already uses (e.g.
  `Payments/UOB`) unless the user already has their own labelling
  scheme — don't force the convention on someone who's already
  organised their mailbox differently.
- **`alert_senders`** / **`statement_senders`**: the exact From-header
  domain(s) for that card's alert and statement emails respectively
  (`text[]`, not a single string — a bank's alert and statement mail
  can legitimately come from different subdomains, and a bank
  occasionally needs more than one candidate domain — see
  `citi_cashback`'s two statement domains in `0014`'s backfill). **Do
  not guess a domain you have not actually seen in a real email.** A
  wrong-but-plausible-looking domain here is worse than leaving it
  `null` — `null`/`{}` is treated identically as "not yet configured,
  reject rather than silently pass" by the ingest pipeline itself (see
  `0014`'s column comments), whereas a guessed wrong domain either
  matches nothing (silent gap) or, worse, if it happens to be real,
  routes another sender's mail into this card's ledger.
- **Gmail label setup itself is the user's job, not something this
  spec's JSON can do.** Tell the user, plainly, to create the nested
  label in Gmail (Settings → Labels, or via a filter that auto-applies
  it) and set up a filter that applies it to mail from the domain(s)
  above — walk them through `docs/setup/gmail.md` §10 ("Set up Gmail
  labels for alert routing") rather than re-explaining it here. Point
  out the nested-label trap that document documents: searching
  `label:Payments` matches **zero** messages if the real filters apply
  `Payments/UOB` etc. — those are separate labels to Gmail's search
  syntax, not a hierarchy.

## 7. What the agent must tell the user, plainly, every time

**You did not configure anything. A human did, by approving it.** After
running the validator, your summary to the user must say, in effect:

> I've proposed N reward rules across M cards, researched from the
> issuer's published terms where I could find them. [X of them have no
> source I could verify — see below.] None of this is live yet. Go to
> `/config` in the dashboard and review each one before it affects any
> number you see — I cannot approve my own proposals, and you shouldn't
> treat this as done until you have.

Never report "I've set up your cards" or "cashback tracking is now
configured" as if the job is finished — it isn't, by design, until the
review step happens. If the validator rejected anything (see the next
section), say exactly what was rejected and why, in terms the user can
act on ("UOB One's Tier 1 rule was rejected: implied payout is 1000% of
threshold, which is almost certainly a transposed threshold/payout
pair — I could not find UOB's real Tier 1 numbers, please supply the
correct ones or point me at the T&C page"), not a generic "some rules
failed validation."

## 8. The validator

`scripts/validate_ai_config.py your_config.json` runs the five-stage
check described in this repo's engineering notes and this document
above, then — only for whatever survives all five stages — calls
`submit_method_rule()` (never a raw `INSERT`) so every proposed rule
lands `pending_review`, exactly as `0018_config_review.sql` guarantees
regardless of what this JSON claims about confidence or authorship. See
that script's own `--help` and module docstring for the full report
format, and `tests/test_rules_validator.py` for the validator's own test
suite, including the deliberately-bad inputs it's built to catch.
