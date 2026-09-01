# Deploying the dashboard to Vercel

Deploying to Vercel is how you get a hosted URL for the dashboard rather
than running it locally with `npm run dev`. Do this after
[Supabase setup](supabase.md) — you need the project URL and publishable
key from that step before you can fill in Vercel's env vars.

## 1. Push this repo to your own GitHub account

Vercel deploys from a GitHub (or GitLab/Bitbucket) repository you own or
have access to. If you're working from a fork or your own clone of this
project, make sure it's pushed to GitHub before continuing.

## 2. Create the Vercel project

1. Go to [vercel.com](https://vercel.com), sign up or sign in (GitHub
   sign-in is the simplest path — it also handles the repo-access
   authorization for you).
2. **Add New → Project**, and import the GitHub repository.
3. **Set the Root Directory to `dashboard/`.** This is essential and easy
   to miss — the Next.js app lives in the `dashboard/` subdirectory of
   this repo, not the repo root. Vercel's project setup screen has a
   "Root Directory" field (sometimes under an "Edit" link next to the
   detected framework) — set it to `dashboard`.
4. Vercel should auto-detect Next.js as the framework once the Root
   Directory is set correctly; leave the build command and output
   directory at their defaults unless you have a specific reason to
   change them.

**Needs a real-world check:** the exact wording and location of the Root
Directory field in Vercel's current project-import UI is not verified
against a live console as part of writing this guide. The goal (Vercel
building from `dashboard/`, not the repo root) is unambiguous even if the
field's exact location has moved.

## 3. Set the region

This repo's `dashboard/vercel.json` pins `regions: ["sin1"]` (Singapore) —
that's a choice this project's own reference deployment made because its
operator and the Supabase project it talks to are both in Singapore.
**Change this to whichever Vercel region is closest to your own Supabase
project's region**, not copied verbatim — a mismatched region just adds
avoidable latency between your dashboard and your database, it doesn't
break anything, but there's no reason to inherit a choice made for a
different deployment. Edit the `regions` array in `dashboard/vercel.json`
before or after your first deploy; Vercel picks it up on the next deploy
either way.

## 4. Set the environment variables — exactly two, and only two

This is the part worth stating loudly, because the instinct when setting
up a project's environment variables is often to over-provision "just in
case." **Don't.** In Vercel's project settings, under **Environment
Variables**, set exactly these two:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your publishable/anon key>
```

Both values came from [`supabase.md`](supabase.md) step 2. Set them for
all environments you plan to use (Production at minimum; Preview too if
you want preview deployments to work against the same database).

**No service role key. No Anthropic key. No Gmail credentials. Nothing
else, under any name, belongs in this Vercel project — ever.** This isn't
an incomplete list waiting to grow; it's the complete list, permanently,
by design (`dashboard/README.md`'s own framing, which this guide is
consistent with). The reason isn't that other secrets wouldn't fit in
Vercel's env var system — it's that the dashboard is the one runtime in
this whole architecture designed to hold zero secrets. Both values above
are meant to be public: anything prefixed `NEXT_PUBLIC_` ships directly in
the browser bundle, visible to anyone who opens your site's dev tools.
Row Level Security — not secrecy of these two values — is what actually
controls who can read or write your data (see [`supabase.md`](supabase.md)
step 6–7 on the operator allow-list and disabling signup). Putting a
service-role key or an Anthropic key here would put a real secret into a
runtime that ships code to arbitrary browsers.

## 5. Deploy

Trigger the deploy (Vercel does this automatically on import, and on every
push to your default branch after that). Watch the build log.

### Why the build fails without the env vars set — this is by design

If `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is
missing, **`npm run build` aborts** during static page generation with an
error like `Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL`.
This is deliberate fail-closed behaviour
(`dashboard/lib/supabase/env.ts`), not a bug to work around — the
dashboard is built to refuse to produce a build that would silently run
without knowing which Supabase project to talk to, rather than deploying
something broken that fails confusingly at runtime instead. If your Vercel
build fails with that message, the fix is setting the two env vars
correctly in Vercel's project settings (step 4), not patching the code.

## 6. First sign-in and operator registration

Once deployed, visit your Vercel URL and sign in at `/login` — **this is
an email + password form, not a magic link.** It only works if you
already created the operator account by hand in Supabase Studio
(**Authentication → Users → Add user**) *before* this point: see
[`supabase.md`](supabase.md) step 6, which you should have already done
as part of Supabase setup. If you skipped it, sign-in will fail with
"Invalid email or password" — go do that first, there is nothing wrong
with this Vercel deploy.

Once you can sign in, if you haven't yet registered yourself as the
operator in Supabase (the `app_admin` table — also covered in
[`supabase.md`](supabase.md) step 6), every page will load but show no
data — that's expected fail-closed behaviour, not a broken deploy.

## What's next

At this point you have a fully working, deployed FlowInk instance backed
by manual transaction entry. Everything else in `docs/setup/` — Gmail,
Anthropic, healthchecks.io, GitHub Actions — is additive automation on top
of what already works. See `docs/getting-started.md` for the recommended
order if you want to add any of it.
