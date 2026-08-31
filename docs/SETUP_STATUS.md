# Setup status — read this first when picking work back up

Live handover. Every claim below was verified against the running system on
**2026-08-28**, not written from memory. This file has been wrong three times
in this project's history and every time it cost real time — most recently,
this file itself credited `0010`'s trigger with a fix that had silently never
worked (see Traps §3). If you change something, verify it and update this.

Authoritative design: `docs/cardledger-build-spec.md` (note the **AMENDMENT** in
§10 — the dashboard is an input surface, not read-only).
Dashboard design: `docs/DASHBOARD_PLAN.md`.

---

## The system is LIVE

Ingest runs unattended. Nothing is blocking it.

| | |
|---|---|
| Supabase project | `<YOUR_SUPABASE_PROJECT_REF>`, ap-southeast-1, **Free tier** |
| Migrations | 0001–0010, 0013 applied to `main` and live. `0011`–`0012` (merchant aliases + default-privilege hardening) are applied **live** but still sit on the unmerged `feat/merchant-alias-matching` branch (PR #3) |
| Edge Functions | `ingest-alerts`, `heartbeat` — both ACTIVE (unverified this pass — last confirmed 2026-08-26) |
| Cron | ingest every 2 min, heartbeat hourly — both firing and succeeding (unverified this pass) |
| Secrets | 6 of 6 in the Edge Function store, mirrored to GitHub Actions (unverified this pass) |
| Dashboard | Vercel project `flowink`, root `dashboard/`, region `sin1` — set the custom domain after deploying |
| Tests | 81 pytest (3 skipped — need `ANTHROPIC_API_KEY`), 26 deno — both re-run 2026-08-28, all passing |
| Git | `main` has the visual redesign (PR #1, #2, merged 2026-08-27) and the category-propagation fix (PR #4, merged 2026-08-27). PR #3 (merchant-alias matching + triage UI) is open, verified, and deliberately on hold — the operator classified it as an enhancement, not a bug fix, and it must not merge without explicit sign-off |

### Data in the ledger

(Example / illustrative shape — replace with your own numbers once you have
real ingest history; do not treat the figures below as real.)

A few hundred transactions across the tracked period, mostly `confirmed`
with a handful of `provisional` rows from live ingest and any `reversed`
merchant refunds. `is_transfer = false`, non-reversed rows are what "spend"
means — the `spend_transactions` view does **not** filter transfers itself,
so don't sum it raw for a spend figure.
A few hundred merchants, ideally with **0 at `confidence='guessed'`** once
triage is caught up.
`budgets` **empty** until the dashboard is used — it is the only insertion
path.
`parse_failures` **empty** when ingest hasn't errored.

Monthly totals will vary by category mix and card cycle; when comparing
months, use like-for-like (month-to-date vs month-to-date) or a partial
current month will misleadingly read as a spending collapse.

---

## Never exercised with real data

Written, deployed, unit-tested — but not yet survived contact with reality.
Not blocked; reality is on its own schedule.

- [x] **Live alert ingest — WORKING as of 2026-08-26.** 7 real transactions
      ingested unattended (Grab, Luckin Coffee, Shopee, BUS/MRT), all
      `provisional`. Two bugs had to be fixed first, both invisible until real
      mail arrived: Gmail's `label:Parent` does not match nested sub-labels (the
      query is now an OR-set over `Payments/*`), and the model wrapped its JSON
      in markdown fences despite the prompt forbidding it. Note the sequencing
      trap — permanent parse failures advance the watermark, so fixing the
      parser was not enough; the watermark had to be rewound for those messages
      to be reprocessed.
- [ ] **PayLah eVoucher alerts are rejected.** 2 messages fail because `last4`
      is null and the check is mandatory (§4 trap 3, never guess the card). The
      eVoucher format may genuinely not carry a last4 — if so PayLah needs its
      own rule rather than relaxing the general one.
- [ ] **Statement reconciliation** (JOB-2 / JOB-3). Next statement mid-September.
- [ ] **Day-8 Gmail token check — 2 September.** Run `verify_token.py`. If it
      fails, the OAuth consent screen was never actually published to production
      and every scheduled job dies weekly. Still the most likely silent failure.

---

## Operator actions outstanding

- [ ] **Check each issuer is actually sending alerts.** A silently-reverted
      alert threshold on any source means that issuer's spend only appears at
      statement reconciliation, weeks later, and the live budget silently
      understates by that amount every month in between. This is the failure
      §7 named most likely and least visible — verify it against your own
      mailbox periodically, don't assume it from the setup step having run once.
- [ ] **Upgrade Supabase to Pro.** Free pauses after 7 days idle and a paused
      project silently stops every cron schedule. A system whose only job is not
      missing things should not run on a tier that can stop itself.
- [ ] **MFA** on the Supabase account and the Gmail account used for statement alerts.
- [ ] **Supabase spend cap.**
- [ ] **Find the UOB One approval date.** `quarter_anchor_date` is null, so the
      quarterly gate uses a labelled trailing-window approximation. That gate is
      the ~S$312/quarter mechanic.
- [ ] **Citi on issuance**: capture an alert sample, add a `Payments/Citi`
      filter, set `active = true` with real `last4`/`cycle_day`, write the parser
      branch and a fixture. Rules staged at `valid_from = '2099-01-01'`.
- [ ] **Supabase security linter**, and confirm whether the PostgREST
      explicit-grants rule applies to a project created now.
- [ ] **Delete `~/cardledger-app-password.txt`** once saved elsewhere. The app
      password was rotated 2026-08-26 after an agent echoed it to stdout — any
      copy saved before that is stale.

Done and verified: alert thresholds lowered (operator-confirmed); public signup
disabled; operator uid registered in `app_admin`.

---

## Security model — three independent gates

Verified 2026-08-26 against the live project, each with a real hostile case:

1. **Grants.** `anon` holds no table, view or function privileges.
   Unauthenticated requests get `42501 permission denied`, not empty rows —
   refused before RLS is consulted. 0 of 12 functions executable by `anon`.
2. **RLS.** Every policy calls `is_operator()` against an `app_admin` allow-list,
   never `auth.uid() is not null`. A freshly self-registered stranger with a
   valid JWT reads `[]` everywhere and gets `403` on every write. Writes are
   scoped: full CRUD on `budgets`; INSERT on `transactions` gated
   `with check (source = 'manual')`; UPDATE/DELETE limited to manual rows;
   column-level UPDATE on `merchants` limited to
   `category`/`is_transfer`/`confidence`. Bank-sourced history is immutable from
   the browser.
3. **Signup disabled.** No new accounts can be created.

Any one failing still leaves two. Vercel holds **no secrets** — only the Supabase
URL and publishable key, both public by design.

`app_admin` is empty-by-default and fails closed. Postgres auto-grants EXECUTE to
`PUBLIC` on function creation — this project hit that twice (0007, 0008). Check
and revoke on every new function.

---

## Dashboard state

**All of D0–D5 are built.** This file said "D2 to D5 not yet built" from
2026-08-26 until today — they shipped that same day (commit "feat(dashboard):
complete D2-D5 — budgets, trends, cards, manual entry"), the doc was just
never updated after. `/budgets`, `/cards`, `/cards/tier-3`, and
`/transactions/new` are live, functioning routes, not stubs.

**Visual redesign shipped 2026-08-27** (PR #1, #2, "Ledger & Ink"): the home
route (`app/(protected)/page.tsx`) was rebuilt as a single-page Command
Center — Trends and Ledger are now anchor-navigated sections of that one
page, not separate routes (there is no `/trends` or `/breakdown` folder any
more). Chip-based filters, restyled header, and mobile nav shipped with it.
Scope was explicitly visual-only per operator instruction — confirmed by git
history that `/budgets`, `/cards`, `/transactions/new`, and `/triage` were
last touched 2026-08-26, before either redesign commit.

**Triage has a second, separate enhancement** built 2026-08-27 — a
similarity-suggestion banner and inline merchant-alias registration — but it
lives only on the unmerged `feat/merchant-alias-matching` branch (PR #3).
`main`'s `/triage` is still the plain 2026-08-26 version.

108 kB First Load JS against a 150 kB budget; 6.26 kB CSS against 30 kB (as of
2026-08-26 — unverified against the redesigned bundle, re-check before
quoting). No charting library — every mark is hand-built SVG/CSS and the
donut is the only client component.

---

## Known limitations, deliberate

- **UOB business-day shift.** `cycle_day` is 15, but UOB moves to the next
  business day when the 15th is a weekend — Aug 2026 closed on the 16th. One
  fixed number cannot express that. Exactly one loaded transaction is affected
  (`2026-08-16 INTERESTS $37.51` → `uob_one:2026-09` instead of `2026-08`).
  A proper fix needs an SG public-holiday calendar; worth doing before the
  quarterly gate is trusted with real money.
- **Foreign-currency alerts are uncosted** until reconciliation. UOB reports the
  foreign amount with no SGD equivalent, and §4 forbids guessing one.
- **`{method}:pending` period state** is designed and the UI primitive exists,
  but the engine does not emit it yet — deliberately unwired rather than faked.
- **Cinema sits in `other`** because the 11-category vocabulary has no
  entertainment bucket. Correct, not a misfiling.

---

## Traps worth remembering

Three defects here shared one shape: **the work reported success and changed
nothing.**

1. Migrations that had never been applied — an FK violation in the seed aborted
   `db push`, so nothing was ever deployable, and nobody found out because nobody
   ran it.
2. `setup_secrets.sh` continued past a failed Gmail consent and died later on a
   confusing `JSONDecodeError`, hiding Google's real error through two operator
   attempts.
3. Merchant triage updated `merchants.category` while every spend query read
   `transactions.category`. The UI reported success; `other` stayed at 43%
   instead of 23%; 131 rows were stale. **`0010`'s trigger did not actually fix
   this** — it ran `security invoker`, and the dashboard's own RLS policy on
   `transactions` only allows updating `source='manual'` rows, so the
   trigger's own `UPDATE` silently matched zero rows for every bank-sourced
   transaction — true from the moment `0010` shipped (2026-08-26). This file
   said "fixed by a trigger in 0010" and was wrong from day one; nobody
   re-checked live data against the claim. Found the next day, 2026-08-27,
   via an operator report ("Grab still
   shows Other after triage"), root-caused to 11 drifted transactions (7
   alert-sourced, 4 statement-sourced, 0 manual — exactly the RLS boundary),
   fixed in `0013` by making the trigger `security definer`, scoped
   identically to this project's one other such exception (`is_operator()`,
   `0008`, "THE ONE DEVIATION"). Before ever repeating this claim, re-run the
   drift query from `0013`'s own migration file and confirm it returns 0 rows
   — do not trust the claim on its own.

"The command succeeded" and "the number changed" are different claims. Verify the
second.
