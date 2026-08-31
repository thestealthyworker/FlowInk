// Both cron-driven Edge Functions (ingest-alerts, heartbeat — nudge and
// merchant-triage were removed along with Telegram, 2026-08-25, §10
// AMENDMENT) are invoked by Supabase Cron via pg_cron -> pg_net with a
// bearer token pulled from Vault. This checks that token so the function
// can't be hit by anyone who finds the URL. See
// docs/cardledger-build-spec.md §7 JOB-1 and §12 item 9 — confirm the
// current pg_cron -> Edge Function pattern against live Supabase docs
// before wiring the cron job itself; this check is deliberately
// transport-agnostic (just "does the bearer match").
//
// Note that pg_net sends this secret as a bearer token, NOT as a JWT, so
// every function is deployed with verify_jwt = false (supabase/config.toml)
// and this check is the only gate. It is fail-closed: a missing
// CRON_SHARED_SECRET rejects rather than allows.

import { secretEquals } from "./secret_compare.ts";

export async function requireCronAuth(req: Request): Promise<Response | null> {
  const expected = Deno.env.get("CRON_SHARED_SECRET");
  if (!expected) {
    return new Response("CRON_SHARED_SECRET not configured", { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!(await secretEquals(token, expected))) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}
