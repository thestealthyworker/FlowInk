# Setting up Supabase

**Required.** This is the database, the auth system, and the scheduler
everything else in FlowInk depends on. Do this first — see
[`docs/getting-started.md`](../getting-started.md) for how it fits with
everything else.

By the end of this guide you will have: a Supabase project, its schema
applied, its two extra extensions enabled, public signup disabled, and
your own account registered as the operator so the dashboard shows you
data instead of nothing.

## 1. Create an account and a project

1. Go to [supabase.com](https://supabase.com) and sign up (GitHub sign-in
   is the fastest path if you already have a GitHub account, which you
   need anyway to fork/clone this repo).
2. From the dashboard, create a **New project**. You'll be asked for:
   - **Name** — anything, e.g. `flowink`.
   - **Database password** — generate one and save it somewhere (a
     password manager). You won't need it for anything in this repo (the
     app talks to Supabase over its REST API and service-role key, not a
     direct Postgres connection), but Supabase requires you to set one,
     and you may want direct `psql` access later.
   - **Region** — pick whichever Supabase region is physically closest to
     you or to wherever your scheduled jobs will run. This project's own
     reference deployment used `ap-southeast-1` (Singapore) because its
     operator and bank accounts are there — that's not a requirement for
     your deployment, just what the shipped example happens to use. Pick
     your own; nothing in the schema or code assumes a particular region.
   - **Pricing plan** — the Free tier works for evaluating this project.
     Note before you commit to it long-term: **a Free-tier project pauses
     itself after roughly a week of inactivity, and a paused project
     silently stops every scheduled job** (Gmail ingest, the heartbeat,
     everything). For a system whose entire point is not missing things,
     that is a real gap, not a hypothetical one. If you're running this
     for real, upgrading to a paid plan removes that failure mode. This
     is worth deciding deliberately rather than discovering the hard way
     when your dashboard has been silently empty for two weeks.
3. Wait for project provisioning to finish (a minute or two).

## 2. Get your project ref, URL, and keys

Once the project is ready, you need three things from it. All three are
in **Project Settings → API** (the exact left-nav wording may vary slightly
by Supabase console version — look for "API" or "API Keys" under Settings):

- **Project ref** — a short id in your project's URL, e.g.
  `abcdefghijklmnop`. You'll use this constantly (`SUPABASE_PROJECT_REF`
  below), including as part of your project's URL: `https://<ref>.supabase.co`.
- **Project URL** — `https://<ref>.supabase.co`. This becomes
  `NEXT_PUBLIC_SUPABASE_URL` for the dashboard and `SUPABASE_URL` for
  every other runtime.
- **Publishable (anon) key** — a long public-safe token. This becomes
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. It's meant to be public — it
  ships in the browser bundle — so don't treat it as a secret, but also
  don't assume that means it's harmless: it's what Row Level Security
  (RLS) exists to constrain (more on that below).
- **Service role key** — a second, much more powerful token that
  **bypasses RLS entirely**. This is a real secret. It's used only by the
  Edge Functions and GitHub Actions jobs, never by the dashboard, never
  in a browser. Keep it out of git, out of chat transcripts, out of
  anywhere it could be logged.

You can also fetch the publishable key from the CLI once you've linked
the project (step 3 below):

```
supabase projects api-keys --project-ref <your-project-ref>
```

## 3. Install the Supabase CLI and link your project

Install the [Supabase CLI](https://supabase.com/docs/guides/cli) (via
Homebrew, npm, or a direct binary download — check the current install
instructions on that page, since the CLI's own distribution mechanism has
changed over time and this guide won't guess at it).

```
supabase login
cd <your clone of this repo>
supabase link --project-ref <your-project-ref>
```

`supabase login` opens a browser to authorize the CLI. `supabase link`
associates your local checkout with the remote project so the next
commands know where to push.

## 4. Enable the extensions this project needs

FlowInk's scheduled jobs (the 2-minute alert ingest, the hourly heartbeat)
run via Supabase's Postgres-native cron, which depends on two Postgres
extensions that are not on by default:

- **`pg_cron`** — schedules the recurring jobs.
- **`pg_net`** — lets a scheduled job make an HTTP call (to invoke an Edge
  Function) from inside Postgres.

Enable both from **Database → Extensions** in the Supabase dashboard
(search for `pg_cron` and `pg_net`, toggle each on). The migrations in
this repo do not enable these for you — they're project-level
infrastructure, not schema, so they're a manual console step.

**Needs a real-world check:** the exact console path for enabling
extensions, and the current recommended way to wire a `pg_cron` schedule
to invoke an Edge Function with a bearer token held in Supabase Vault,
both change as Supabase's own product surface evolves — this project's
own source (`supabase/functions/_shared/cron_auth.ts`,
`docs/cardledger-build-spec.md` §12) explicitly says to confirm the
current pattern against live Supabase docs before wiring the cron
schedule, and calls out that older approaches using `pgjwt` or `pgsodium`
are deprecated. Don't copy a pattern from an old tutorial; check Supabase's
current docs for "Cron" / "scheduling Edge Functions" at setup time.

## 5. Apply the database schema

With the CLI linked, push every migration in `supabase/migrations/`:

```
supabase db push
```

This applies all migration files in filename order. The numbering in this
repo has an intentional gap (`0011`/`0012` are absent — they belong to a
feature branch not merged into this history) — that's expected, not a
sign anything is missing; the CLI applies whatever files are present, in
order, regardless of numeric gaps.

### Verifying your migrations actually applied — don't skip this

This is the single most important verification step in this whole guide,
because the failure mode is silent by design: **a migration can abort
partway through and `db push` can report a failure that's easy to miss in
scrollback, or — worse — a prior partial failure can leave your project in
a state where later pushes look clean while the underlying schema is
wrong.** This exact thing happened during this project's own development:
a foreign-key violation aborted `db push` on a live deployment, and nobody
found out because nobody re-ran or checked afterward. Read this project's
own reflection on it: *"the command succeeded" and "the number changed"
are different claims — verify the second.*

After `supabase db push` finishes, confirm it two ways:

```
supabase migration list
```

This should show every migration file in `supabase/migrations/` as
applied remotely, with no gaps between what's local and what's marked
applied on the server.

Then, independently, query the database directly (via the SQL Editor in
the Supabase dashboard, or `psql`):

```sql
select version from supabase_migrations.schema_migrations
order by version desc limit 5;
```

The most recent version listed should match the highest-numbered
migration file in your checkout (`0016` as of this writing). If it
doesn't — if the CLI reports success but this query shows an older
version, or if `db push` printed an error you scrolled past — stop and
diagnose before doing anything else. Re-running `db push` against a
partially-applied migration is often fine (Postgres DDL in a single
migration file runs in one transaction, so a genuine mid-migration failure
usually means nothing from that file committed) but confirm it, don't
assume it.

## 6. Register yourself as the operator

FlowInk is a single-operator system: every table's Row Level Security
policy checks a small allow-list (`app_admin`), never just "is this
request authenticated at all" — because Supabase's signup endpoint is
public, and a policy that only checked "authenticated" would grant access
to anyone who self-registers, not just you. Until your own user id is in
that allow-list, `is_operator()` returns `false` for everyone, including
you — every page loads, but shows no data. That's deliberate fail-closed
behaviour, not a bug: see the full runbook and reasoning at the top of
`supabase/migrations/0008_dashboard_rls.sql`, reproduced here because it's
the exact sequence you need:

1. Deploy the dashboard (see [`vercel.md`](vercel.md)) and sign in once
   via the magic-link form at `/login`. This creates a real row in
   `auth.users` with a real uid — it doesn't exist before your first
   sign-in.
2. Look up that uid — Supabase Studio's **Authentication → Users** page
   shows it next to your email, or query it directly:

   ```sql
   select id, email from auth.users where email = 'you@example.com';
   ```

3. Insert it into the allow-list, once, via the SQL Editor (never via a
   table the dashboard itself can write — a self-service allow-list would
   defeat the whole point of having one):

   ```sql
   insert into app_admin (user_id)
   select id from auth.users where email = 'you@example.com'
   on conflict (user_id) do nothing;
   ```

4. Reload the dashboard. You should now see data (or, on a fresh
   deployment with nothing entered yet, an empty state that explains
   itself rather than nothing at all).

If you still see no data after this, re-check step 2/3 for a typo'd
email, and confirm the query in step 3 actually matched a row (an
`insert ... select` from a `where` clause that matches nothing inserts
zero rows silently — no error).

## 7. Disable public signup — required, not optional

This is a blocking step, not a footnote. Supabase's signup endpoint is
public by default. If you skip this, **anyone who finds your Supabase
project URL can create an account** — and while RLS means a self-registered
stranger reads `[]` everywhere and gets `403` on every write (they're not
in `app_admin`), you should not rely on that as your only line of defence
against unwanted signups accumulating in your user table.

Go to **Authentication → Providers** (or **Authentication → Sign In / Sign
Up**, depending on your console version — look for the toggle governing
whether new users can register) and turn off public sign-ups, leaving only
magic-link sign-in for accounts that already exist (i.e., you, once you've
signed in the first time in step 6 above).

**Needs a real-world check:** the exact label and location of this toggle
in the Supabase dashboard is not verified against a live console as part
of writing this guide — Supabase's auth settings UI has been reorganized
before. If the wording above doesn't match what you see, look for
anything governing new-user registration under Authentication settings;
the goal is unambiguous — no new account should be creatable after this
step — even if the exact click path has moved.

**Verify it worked** before moving on: from a private/incognito browser
window (so you're not using your own signed-in session), try to sign up
for a new account at your dashboard's `/login` page, or hit the Supabase
auth signup endpoint directly. It should be rejected. Don't take "I
toggled the setting" as proof; confirm the endpoint actually refuses.

## 8. The security-linter and function-privilege gap — check this on every new function

If you ever write your own Postgres function (a new rule for your own
card, say), there's a Postgres behaviour that has bitten this project
twice already and will bite you too if you don't know about it:
**PostgreSQL automatically grants `EXECUTE` on a newly created function to
the `PUBLIC` pseudo-role**, independently of any `ALTER DEFAULT PRIVILEGES`
statement you might have run to try to prevent it. Revoking a privilege
from named roles (`anon`, `authenticated`) does nothing to this separate
`PUBLIC` grant — every role, including `anon`, is implicitly a member of
`PUBLIC`. The only statement that actually closes this is one that targets
`PUBLIC` itself:

```sql
revoke execute on all functions in schema public from public;
```

This project's migrations already do this (see the "DEFENCE IN DEPTH"
section of `supabase/migrations/0007_rules_engine.sql` for the full story
of how this was discovered, verified with `has_function_privilege()`, and
fixed), and re-issue the default-privileges version for future migrations
too — but that fix does not automatically cover functions *you* add later
in a migration that doesn't explicitly revoke. **Every new function needs
its own explicit `revoke ... from public` line. This is not automatic**,
no matter how many times a prior migration revoked it for the functions
that existed at the time.

Before considering any schema change done, run Supabase's built-in
security linter (**Database → Security Advisor** or **Advisors** in the
dashboard — naming varies by console version) and confirm it reports
clean.

## What's next

With Supabase set up, you have a working database and auth system, but no
deployed dashboard yet to actually use it — that's [`vercel.md`](vercel.md).
Everything after that (Gmail, Anthropic, healthchecks.io, GitHub Actions)
is optional and layered on top; see
[`docs/getting-started.md`](../getting-started.md) for the recommended
order.
