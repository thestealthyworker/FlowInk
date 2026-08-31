# Setting up GitHub Actions secrets

**Optional.** This wires up daily statement-PDF reconciliation — the job
that decrypts a bank statement PDF, parses it, and promotes matching
`provisional` transactions (from live alert ingestion) to `confirmed`.
Skip this and alert-sourced transactions simply stay `provisional`
indefinitely — visible in the dashboard as such, not wrong, just never
independently corroborated against a statement. If you're not running
[Gmail ingestion](gmail.md) at all, there's nothing for this to reconcile
against yet either.

## What runs here, and why GitHub Actions specifically

Two workflows, defined in `.github/workflows/`:

- **`ingest-statements.yml`** (JOB-2) — daily, decrypts a password-protected
  statement PDF with `qpdf` and parses it.
- **`reconcile.yml`** (JOB-3) — runs immediately after JOB-2 completes,
  matching parsed statement lines against existing `provisional`
  transactions.

These run in GitHub Actions rather than a Supabase Edge Function because
Supabase's Edge Functions run on Deno and cannot shell out to `qpdf` to
decrypt a password-protected PDF — a genuine runtime constraint, not an
arbitrary choice.

## The seven secrets, and which runtime actually needs which

GitHub Actions is a **separate runtime from Supabase Edge Functions and
cannot read Supabase's secret store** — every value both runtimes need has
to be set twice, once in each store. This is deliberate duplication, not
an oversight to "fix" by trying to unify them (see the "four runtimes,
four stores" section of the main `README.md`).

Set these in your repo's **Settings → Secrets and variables → Actions**:

| Secret | Value | Also needed in Edge Function store? |
|---|---|---|
| `SUPABASE_URL` | `https://<your-project-ref>.supabase.co` | Yes (Supabase injects this automatically for Edge Functions — you don't set it by hand there) |
| `SUPABASE_SERVICE_ROLE_KEY` | From [`supabase.md`](supabase.md) step 2 — **the real secret, bypasses RLS** | Yes (also auto-injected for Edge Functions) |
| `GMAIL_REFRESH_TOKEN` | From [`gmail.md`](gmail.md) | Yes, if using live ingest too |
| `GMAIL_CLIENT_ID` | From [`gmail.md`](gmail.md) | Yes, if using live ingest too |
| `GMAIL_CLIENT_SECRET` | From [`gmail.md`](gmail.md) | Yes, if using live ingest too |
| `ANTHROPIC_API_KEY` | From [`anthropic.md`](anthropic.md) | Yes, if using live ingest too |
| `STATEMENT_PDF_PASSWORD` | See below | No — this one is GitHub-Actions-only |

`HEALTHCHECKS_PING_URL` is also read by `reconcile.yml` if you've set up
[healthchecks.io](healthchecks.md) — add it here too if so.

```
gh secret set SUPABASE_URL --body https://<your-project-ref>.supabase.co
gh secret set SUPABASE_SERVICE_ROLE_KEY --body <your-service-role-key>
gh secret set GMAIL_REFRESH_TOKEN --body <your-refresh-token>
gh secret set GMAIL_CLIENT_ID --body <your-client-id>
gh secret set GMAIL_CLIENT_SECRET --body <your-client-secret>
gh secret set ANTHROPIC_API_KEY --body <your-anthropic-key>
gh secret set STATEMENT_PDF_PASSWORD --body <your-pdf-password>
gh secret set HEALTHCHECKS_PING_URL --body <your-healthchecks-url>
```

`scripts/setup_secrets.sh` sets the first six of these for you
automatically (as a mirror of the Gmail setup flow) if the `gh` CLI is
installed and authenticated when you run it — see [`gmail.md`](gmail.md).
It does **not** set `STATEMENT_PDF_PASSWORD` (see below) or
`HEALTHCHECKS_PING_URL` into the GitHub store; set those by hand if you
need them.

## `STATEMENT_PDF_PASSWORD` — genuinely optional, and specific to your own bank

This is only required if **your own bank's statement PDFs are actually
password-protected.** This project's own reference deployment's
statements happened to open with an empty password, so the job may not
need this secret set at all, depending on your bank. This isn't an
SG-specific quirk to assume applies to you — check your own bank's
statement PDFs directly (try opening one without a password) before
deciding whether to set this.

If your statements are protected, `scripts/ingest_statements.py` reads
`STATEMENT_PDF_PASSWORD` as a comma-separated list of candidate passwords
to try, so you can set more than one if you have statements from multiple
sources with different passwords.

## Two more env vars this project's code reads but does not wire into the workflow by default

`scripts/ingest_statements.py` also reads `STATEMENT_GMAIL_QUERY` (a
custom Gmail search query for finding statement emails, falling back to a
built-in default if unset) and `STATEMENT_SENDER_DOMAINS` (an override of
the sender-domain allowlist used to route statement emails, see
`scripts/lib/senders.py`). **As shipped, neither of these is passed
through by `ingest-statements.yml`'s `env:` block** — the workflow only
forwards the seven secrets listed above. If you need to override either
default, you'll need to add the corresponding line to the workflow file's
`env:` block yourself, in addition to setting the GitHub secret. This is a
real gap between what the code can read and what the shipped workflow
currently passes through — worth knowing before you set one of these
secrets and wonder why it isn't taking effect.

## Why the workflow pins actions to a commit SHA, not a version tag — don't "simplify" this back

If you look at `.github/workflows/ingest-statements.yml` or
`reconcile.yml`, you'll notice the third-party actions (`actions/checkout`,
`actions/setup-python`) are pinned to a full commit SHA with a version
number only in a trailing comment, e.g. `actions/checkout@11d5960a...`
rather than the more familiar `actions/checkout@v4`. This is deliberate,
not an oversight to clean up. `ingest-statements.yml` in particular holds
the service-role key, Gmail refresh token, Anthropic key, and PDF password
simultaneously in its environment — a mutable tag like `@v4` can be
repointed by its maintainer (or, in a supply-chain-attack scenario, by
whoever compromises that maintainer's account) to point at a different,
malicious commit, which would then run with access to all four secrets on
the very next scheduled run, with no change to this repo's own files to
alert you. A commit SHA cannot be silently repointed the same way. If
you're tempted to "simplify" this back to a version tag for readability,
don't — the trailing comment already gives you the human-readable version
number without the risk.

## Verify it

After secrets are set, trigger a manual run from the **Actions** tab
(`workflow_dispatch` is enabled on both workflows specifically for this)
rather than waiting for the daily schedule. Watch the run's logs for
completion, and check the healthchecks.io dashboard (if configured) for a
ping from the `reconcile` job. **Never look for the secret values
themselves in the logs to "verify" they were set correctly** — this
project's own workflows are written to never echo a secret or a decrypted
statement line, since Actions logs persist and are readable by anyone
with repo access; a log that *did* show a secret value would itself be a
problem to fix, not reassurance that setup worked.

## What's next

This is the last setup guide in the sequence — see
`docs/getting-started.md` for what to do once your infrastructure is in
place.
