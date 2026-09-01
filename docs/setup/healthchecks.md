# Setting up healthchecks.io

**Optional** — the app works without it. But read this before deciding to
skip it: what you lose is the only independent alarm that tells you when
automated ingestion has silently stopped. A dashboard banner can't tell
you ingestion died, because a dead pipeline gives you no reason to open
the dashboard in the first place. This is a five-minute, free-tier setup
that closes a real blind spot, not busywork.

## Why this exists

Supabase's own scheduled jobs (`pg_cron`) have no built-in failure
alerting and no heartbeat of their own — a skipped run is not retried, and
a paused project (see the Free-tier note in [`supabase.md`](supabase.md))
silently stops every schedule with nothing inside Supabase to tell you.
healthchecks.io is a dead-man's-switch: it works the other way around —
your app pings it on every successful run, and *healthchecks.io* alerts
you by email the moment those pings stop arriving. Because it's external
to Supabase, it still works when Supabase itself is the thing that broke.

## 1. Sign up and create a check

1. Go to [healthchecks.io](https://healthchecks.io) and sign up (the free
   tier is enough for this project's needs — a small number of checks,
   pinged hourly).
2. Create a new check (often called "Add Check" or similar). Name it
   something recognizable, e.g. `flowink-heartbeat`.
3. Set the expected **period** and **grace time** to match how often
   FlowInk's heartbeat job runs — hourly, per `supabase/functions/heartbeat`
   — so healthchecks.io knows how long a missed ping means something's
   actually wrong versus just late.

**Needs a real-world check:** exact field names and defaults on
healthchecks.io's check-creation form are not verified against a live
console as part of writing this guide; the goal (a check that expects a
ping roughly every hour) is unambiguous even if the exact form layout has
moved.

## 2. Get the ping URL

Each check has a unique ping URL, shown on the check's detail page, in the
form:

```
https://hc-ping.com/<your-check-uuid>
```

This is the value you need — not an API key, not a login, just this one
URL. Copy it.

## 3. Understand the three endpoint shapes this project uses

FlowInk's code already implements a specific, consistent convention
across all three shapes of ping, worth understanding rather than treating
as an opaque URL — see `supabase/functions/_shared/healthchecks.ts` for
the canonical implementation (mirrored in `scripts/lib/healthchecks.py`
for the Python runtime):

| Request | What it means | When this project sends it |
|---|---|---|
| `POST <url>` | Success ping — "still alive." | Every successful heartbeat / job run. |
| `POST <url>/fail` | Explicit failure — triggers an alert email **immediately**. | Reserved for genuine system-health problems: a data source gone silent, a watermark stuck and retrying forever. |
| `POST <url>/log` | Informational — recorded on the healthchecks.io dashboard but does **not** alert. | Data-quality issues (a parse failure, an unparseable message) that aren't themselves evidence the whole system is down. |

The distinction between `/fail` and `/log` matters beyond bookkeeping:
using `/fail` for routine data-quality noise trains you to ignore the
alarm, which defeats the entire point of having one. This project's own
code already draws that line correctly — you don't need to configure
anything for this distinction to work, just understand why an occasional
`/log` entry isn't cause for alarm the way a `/fail` email is.

## 4. Store the ping URL

`HEALTHCHECKS_PING_URL` is read by the Supabase Edge Function `heartbeat`
and, if you've set up statement reconciliation, by the GitHub Actions
`reconcile` job too — two separate secret stores, same value:

```
# Edge Function store:
supabase secrets set --project-ref <your-project-ref> HEALTHCHECKS_PING_URL=https://hc-ping.com/<your-check-uuid>

# GitHub Actions store (only needed if you're using statement reconciliation — see github-actions.md):
gh secret set HEALTHCHECKS_PING_URL --body https://hc-ping.com/<your-check-uuid>
```

If you use `scripts/setup_secrets.sh` for the Gmail setup flow, it prompts
for this value (via the `HEALTHCHECKS_PING_URL` environment variable) and
sets it as part of that same run — and, like the app as a whole, treats it
as optional: if you leave it unset, the script prints a note that it's
skipping the value and continues rather than refusing to proceed. If it
*is* set, the script only validates that it looks like an
`https://hc-ping.com/...` URL before pushing it. If you don't want
healthchecks.io at all, just leave `HEALTHCHECKS_PING_URL` unset when you
run the script — no placeholder value needed.

## 5. Verify it

Wait for the `heartbeat` Edge Function to run once (it's on an hourly
schedule), then check the healthchecks.io dashboard for that check — it
should show a recent successful ping, not a "Late" or "Down" status. If
nothing arrives after an hour and a half or so, check the Edge Function's
own logs in the Supabase dashboard for errors, and confirm
`HEALTHCHECKS_PING_URL` is actually set in the Edge Function secret store
(not just the GitHub Actions one, if you set them separately).

## What happens if you skip this

The dashboard will show a persistent, non-dismissable notice — *"No
external monitoring configured. If ingestion silently stops, nothing will
tell you"* — wherever the app's "honest data" surfaces make integration
gaps visible (see `dashboard/components/honest-data/IntegrationNotice.tsx`).
This is deliberate: the app would rather keep telling you about this gap
than let you forget it exists. Skipping healthchecks.io is a legitimate
choice, not a wrong one, but it should be an informed one.

## What's next

Once you've decided your live ingestion setup (or lack of it), the last
two pieces are [Vercel](vercel.md) (if you haven't deployed the dashboard
yet) and [GitHub Actions secrets](github-actions.md) (for statement-PDF
reconciliation).
