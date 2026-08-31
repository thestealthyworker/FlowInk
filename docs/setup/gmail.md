# Setting up Gmail ingestion

**Optional.** Skip this entirely and FlowInk still works — you add
transactions by hand on `/transactions/new`, which is a fully supported,
permanent way to use the app, not a degraded stopgap (see
`docs/getting-started.md`'s required-vs-optional table). Come back to this
guide whenever you want automatic capture from bank alert emails.

This is the single most trap-laden integration in this system. Every trap
below has actually happened during this project's development — not
hypothetical caution, things that broke a working pipeline. Read the whole
guide before running anything, especially the section on the OAuth consent
screen's publishing status: it is the single most likely silent failure
in the entire system, and it looks completely fine for exactly seven days
before it doesn't.

## What this gives you, and why read-only

FlowInk reads your own bank alert emails (from Gmail, via the Gmail API)
and asks Anthropic to extract structured transaction data from them. It
never reads your bank credentials and never logs into a bank portal — it
only ever reads mail you already receive. The Gmail OAuth scope this
project requests is **`gmail.readonly` and nothing more**
(`scripts/setup_secrets.sh:85`, `docs/cardledger-build-spec.md` §11).

This matters beyond "less scope is safer" as a platitude: `gmail.readonly`
cannot send mail, cannot modify or delete anything in your mailbox, and
cannot touch any other Google service. If the refresh token this guide has
you mint were ever leaked, the blast radius is "someone can read your
mail" — bad, but bounded — not "someone can act as you." Don't be tempted
to request a broader scope for convenience (e.g. to also label or archive
processed messages); it would make the token strictly more dangerous to
leak for no functional benefit this project needs.

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
   and sign in with the Google account whose mail you want FlowInk to
   read. (Consider using a dedicated Gmail account for this rather than
   your primary personal one — see the note on account scope below.)
2. Create a new project (the project picker is in the top nav; **New
   Project**). Name it anything, e.g. `flowink`.

**Needs a real-world check:** Google Cloud Console's exact navigation
(where "New Project" lives, what the project picker looks like) is not
verified against a live console as part of writing this guide — Google
reorganizes this console periodically. The goal is unambiguous (create a
project you'll enable the Gmail API inside); the click path may have
moved slightly from what's described here.

## 2. Enable the Gmail API

Within your new project, go to **APIs & Services → Library**, search for
"Gmail API", and enable it.

**Needs a real-world check:** same caveat as above — the exact console
path for enabling an API has changed over the life of Google Cloud
Console. Look for an API library / marketplace search; "Gmail API" is an
unambiguous, stable name to search for even if the surrounding navigation
has moved.

## 3. Configure the OAuth consent screen — read this section fully before clicking anything

This is where the load-bearing trap in this whole integration lives, and
it needs to be understood as one connected risk, not two separate steps.

Go to **APIs & Services → OAuth consent screen**. You'll set up:

- **User type**: External (unless you have a Google Workspace org and
  want Internal — External is what a personal Gmail account needs).
- **App name, support email, developer contact**: anything reasonable —
  this app is never reviewed or listed publicly, since you're the only
  user.
- **Scopes**: add exactly `https://www.googleapis.com/auth/gmail.readonly`.
  Nothing else. See the "why read-only" section above for why this isn't
  just tidiness.
- **Test users**: while the app is in "Testing" publishing status (the
  default for a new consent screen), add your own Gmail address here as a
  test user, or the consent flow will refuse you entirely.

### The trap: "Testing" status silently expires your refresh token after 7 days

**A Google Cloud OAuth consent screen starts in "Testing" publishing
status. While it's in Testing, any refresh token you mint through it stops
working after roughly 7 days — silently, from the token's perspective.**
The pipeline works perfectly all week, then every scheduled job starts
failing on day 8, with no obvious cause from inside this codebase, because
from Google's side nothing is wrong — the grant simply expired by design.

This is precisely the kind of trap that only surfaces after you've
finished setup, moved on, and stopped watching closely — the moment a
guide, rather than someone who remembers doing this before, needs to warn
you explicitly rather than let you find it the hard way.

**The fix: publish your OAuth consent screen to "Production."** Since this
app is for your own personal use and requests only `gmail.readonly`, it's
fine for it to stay in **unverified** app status — Google's app
verification review is a separate, heavier process for apps requesting
sensitive scopes or seeking public distribution, and you don't need it
here. "Production" publishing status and "verified" app status are
different things; you need the former, not the latter, for this to work
past day 7.

When you publish to Production and later run the consent flow (next
section), Google will show an interstitial warning that the app is
unverified ("Google hasn't verified this app"). **This warning is expected
and safe to click through** for your own app requesting your own
read-only access to your own mailbox — accept it (there's usually an
"Advanced" or "Continue" link to proceed past the warning screen).

**Do not skip publishing to Production and assume Testing status is fine
"for now."** There is no visible symptom of this misconfiguration until
day 8, by which point the setup session is long over and the failure will
look unrelated to anything you did.

## 4. Create OAuth client credentials

Go to **APIs & Services → Credentials → Create Credentials → OAuth client
ID**. Choose **Desktop app** as the application type (not Web application
— the consent flow this project uses runs a local server on your own
machine, matching a desktop-app client, not a hosted redirect).

Download the resulting `client_secret.json`. Save it somewhere outside
this git repository — this project's own `.gitignore` is written to catch
`client_secret*.json` and similar patterns, but don't rely on that as your
only safeguard. A common, working convention (matching this project's own
scripts) is `~/cardledger-auth/client_secret.json`.

## 5. Mint a refresh token

This is the step that actually produces the long-lived credential
(`GMAIL_REFRESH_TOKEN`) every runtime needs. There are two ways to do it:

### Option A: this repo's own script (recommended)

`scripts/setup_secrets.sh` runs the whole consent flow interactively,
captures the result, and pushes it straight into your Supabase Edge
Function secret store (and mirrors the GitHub Actions subset if `gh` is
installed and authenticated) — without ever writing the token to disk or
echoing it to your terminal. Read the script itself before running it;
its own header comments explain exactly what it does and why, in more
detail than is worth duplicating here. In short:

```
export SUPABASE_PROJECT_REF=<your-project-ref>
bash scripts/setup_secrets.sh
```

It expects `~/cardledger-auth/client_secret.json` to already exist (step 4
above), the Supabase CLI logged in and linked (see
[`supabase.md`](supabase.md)), and a browser available on the same
machine for the interactive Google consent step.

**If you fork or modify this script, preserve how it fails.** The current
version deliberately captures the Google consent step's stdout and stderr
separately and checks both a non-zero exit code *and* an empty-but-successful
result explicitly, rather than trusting `set -e` alone to propagate a
failure out of a command substitution. An earlier version of this script
didn't do that: it continued past a failed Gmail consent step and died
several lines later on a confusing, unrelated-looking `JSONDecodeError`
from a Python one-liner deep in the middle of the script — with Google's
actual error (an unpublished consent screen, a scope mismatch, whatever it
actually was) never shown at all, costing real debugging time across more
than one attempt. If you ever see a `JSONDecodeError` (or any error that
doesn't obviously relate to Google/OAuth) partway through this script,
**don't debug the JSON parsing** — the real failure is almost certainly
upstream, in the consent step itself, and the symptom you're looking at is
this class of bug reappearing. The current script's own header comments
document the fix; keep that structure if you change it.

### Option B: understand the mechanism, if you're writing your own variant

If you ever write your own script instead of using this repo's, the
mechanism that actually mints a refresh token (rather than only a
short-lived access token) is two OAuth parameters, and **both are
required**:

- `access_type=offline` — tells Google you want a token you can use
  without the user present again later (i.e., a refresh token at all, not
  just this session's access token).
- `prompt=consent` — forces Google to show the consent screen and issue a
  fresh grant even if this Google account has authorized this OAuth client
  before. Without this, if a grant already exists for this client/account
  pair, Google may silently skip issuing a new refresh token at all —
  **omitting either parameter is a silent failure**: the flow completes,
  you get an access token, and there's simply no refresh token in the
  response, with no obvious error pointing at why. `scripts/setup_secrets.sh`
  guards against exactly this (it checks `creds.refresh_token` is
  non-empty and fails loudly with a specific message — "revoke the
  existing grant at https://myaccount.google.com/permissions and re-run" —
  rather than silently accepting an incomplete result).

## 6. Verify the token before trusting it

Don't assume the consent flow worked just because it exited without an
error. This repo ships a diagnostic script for exactly this:

```
.venv/bin/python scripts/verify_token.py
```

(Set up the venv first if you haven't: `python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt` — check `scripts/requirements.txt` for the exact dependency list, `requests` at minimum.)

This mints an access token from the refresh token, confirms the granted
scope is *exactly* `gmail.readonly` (not a superset, not something drifted
by a misconfigured client), and lists one message under `label:Payments`
to confirm the API call itself works end-to-end. A clean run prints
`verify_token: OK`.

If `~/cardledger-auth` still has `client_secret.json` and a
`refresh_token.txt` in it, the script reads from there by default. Once
you've moved the values into your secret stores (next section) and
deleted that directory, run it with the same three values exported as
environment variables instead — the script's own docstring documents
this fallback, and it's exactly what you'll use for the day-8 check
below, since by then the local auth directory should already be gone.

## 7. Store the credentials in the right runtimes

`scripts/setup_secrets.sh` does this for you if you used it. If you're
setting values by hand, you need **`GMAIL_REFRESH_TOKEN`,
`GMAIL_CLIENT_ID`, and `GMAIL_CLIENT_SECRET` in two separate places**:

- **Supabase Edge Function secrets** (for the live 2-minute alert ingest):
  ```
  supabase secrets set --project-ref <your-project-ref> \
    GMAIL_REFRESH_TOKEN=... GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=...
  ```
- **GitHub Actions repo Secrets** (for the daily statement-reconciliation
  job — see [`github-actions.md`](github-actions.md)) — only needed if
  you're also setting up statement-PDF reconciliation.

These are two independent secret stores. Setting the value in one does
nothing for the other — this project deliberately never unifies them (see
[`github-actions.md`](github-actions.md) for the full "four runtimes, four
stores" reasoning). It's an easy thing to do once and forget the second
store exists.

## 8. Delete the local credentials once verified

Once `verify_token.py` passes and the values are in your secret store(s),
**delete `~/cardledger-auth`** (or wherever you saved `client_secret.json`).
That file plus a live grant is enough to mint new tokens against your
whole mailbox on its own — it should not persist on your machine longer
than it takes to get the values into Supabase/GitHub.

## 9. The day-8 check — put this on a calendar, don't leave it as a mental note

This is the single most important follow-up step in this entire setup
guide, and it is exactly the kind of thing that's trivially easy to skip
because nothing looks wrong on days 1 through 7.

**Seven-plus days after you first minted your refresh token, run
`verify_token.py` again**, using the environment-variable fallback (since
your local `client_secret.json` should be deleted by now):

```
GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=... \
  .venv/bin/python scripts/verify_token.py
```

(Use the same values you stored in Supabase — you can read them back with
`supabase secrets set` having no read equivalent, so keep a copy in your
password manager, or re-derive from `client_secret.json` if you haven't
deleted it yet at this point in the process.)

If this fails, the OAuth consent screen was never actually published to
Production (step 3), and every scheduled job that depends on Gmail will
die weekly from here on, silently, until you fix it. **Set an actual
calendar reminder for this now**, not a mental note — this project's own
operational history is one of exactly this check being the thing that
gets forgotten once setup "feels done."

## 10. Set up Gmail labels for alert routing

FlowInk routes incoming bank alert emails to the right card by matching a
Gmail label on the message, using a search query built from an OR-set
across every configured card's label (see
`supabase/functions/_shared/gmail.ts`, `supabase/functions/ingest-alerts/index.ts`).
This repo ships with routing configured for its reference example's four
cards, using nested labels under a `Payments/` parent — e.g. `Payments/UOB`,
`Payments/HSBC`, `Payments/PayLah`, `Payments/Citi` (see the
`payment_methods.alert_label` column, set in
`supabase/migrations/0014_ingestion_routing_as_data.sql`). If you're using
your own cards, add your own nested label per card and set the matching
`alert_label` value on that card's `payment_methods` row.

**The nested-label trap:** Gmail's label search does not treat a parent
label as matching its children. Searching `label:Payments` matches
**zero** messages if your actual filters apply the nested labels
(`Payments/UOB`, etc.) — those are functionally separate labels to Gmail's
search syntax, not a hierarchy `label:Payments` can search across. This
project hit this directly: `label:Payments` matched 0 messages in the live
mailbox while `label:Payments/UOB` matched 10 and `label:Payments/PayLah`
matched 2 — the Gmail filters themselves were correctly applying the
nested labels; only the search query was wrong. The fix already shipped in
this codebase is to build the query as an explicit OR-set over every
configured method's specific nested label, never a bare parent-label
search — if you're adding routing for a new card, follow that same
pattern rather than assuming a parent label will catch everything under
it.

Set up Gmail filters (Settings → Filters and Blocked Addresses → Create a
new filter, matching on the sender domain for each bank) that apply the
matching nested label automatically to incoming alert emails, so ingestion
has something to search for.

## What's next

With Gmail configured, the ingest pipeline can read alert emails, but it
still needs an LLM to turn the email text into structured transaction
data — that's [`anthropic.md`](anthropic.md), and it's what actually makes
ingestion do something rather than just read mail it can't parse.
