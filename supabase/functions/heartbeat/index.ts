// JOB-6 · heartbeat. Supabase Cron, hourly.
// See docs/cardledger-build-spec.md §7. Supabase Cron has no failure
// alerting and no heartbeat of its own — this pings an external dead-man's
// switch (healthchecks.io) every hour, and separately asserts that every
// active payment method has seen at least one alert-sourced transaction
// in the last 72 hours. A bank quietly reverting its alert threshold is
// the most likely real-world failure and is invisible in an aggregate
// check, so this checks per-source, not just "did anything ingest".
//
// Telegram was removed 2026-08-25 (operator decision, §10 AMENDMENT):
// warnings and triage move to the web dashboard (Phase 5, not yet built).
// healthchecks.io is now the only out-of-band alarm, so the per-source
// silence check below fires a `/fail` ping (immediate alert email)
// instead of a Telegram message — see _shared/healthchecks.ts.

import { requireCronAuth } from "../_shared/cron_auth.ts";
import { supabaseAdmin } from "../_shared/supabase_admin.ts";
import { pingFail, pingSuccess } from "../_shared/healthchecks.ts";

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  // The hourly "still alive" ping — unchanged from before Telegram was
  // removed. pingSuccess() logs its own failure internally; the result is
  // still surfaced in the response body below rather than swallowed.
  const pingResult = await pingSuccess();

  const db = supabaseAdmin();

  // Only methods that actually receive alert email can be "silent". `manual`
  // (cash / bank / GIRO, added in 0009) has no inbox and no Gmail label, so it
  // can never produce an alert-sourced transaction — including it would hold
  // this alarm on permanently. An alarm that is always red is an alarm the
  // operator learns to ignore, and with Telegram gone this is the ONLY
  // out-of-band failure signal the system has (§7 JOB-6). Retired and
  // not-yet-issued cards are already excluded by `active = true`.
  const NON_ALERTING_METHODS = ["manual"];

  const { data: methods, error: methodsErr } = await db
    .from("payment_methods")
    .select("id, display_name, active, method_type")
    .eq("active", true)
    .not("id", "in", `(${NON_ALERTING_METHODS.join(",")})`);
  if (methodsErr) return new Response(`payment_methods read failed: ${methodsErr.message}`, { status: 500 });

  const since = new Date(Date.now() - SEVENTY_TWO_HOURS_MS).toISOString();
  const silentSources: string[] = [];

  for (const method of methods ?? []) {
    const { count, error: countErr } = await db
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("method_id", method.id)
      .eq("source", "alert")
      .gte("created_at", since);
    if (countErr) continue;
    if ((count ?? 0) === 0) silentSources.push(method.display_name);
  }

  let alarmOk = true;
  if (silentSources.length > 0) {
    // §7 JOB-6: "if any of the four labels has seen zero mail in 72 hours,
    // warn." This is the case the spec calls the most likely real-world
    // failure, so it gets `/fail` — an immediate alert email — not `/log`.
    // A short body naming the quiet source(s) rides along in the POST body,
    // which healthchecks.io records and includes in the alert.
    const result = await pingFail(
      `heartbeat: no alert-sourced transactions in 72h from: ${silentSources.join(", ")}. ` +
        `Could be genuinely no spend, or a bank quietly reverted its alert threshold — worth a manual check.`,
    );
    alarmOk = result.ok;
    if (!result.ok) {
      // healthchecks.io is now the channel of last resort for "not missing
      // things" (§1, §7 JOB-6) — a failed ping here must at least land in
      // Edge Function logs, not disappear. (pingFail already logs
      // internally too; this is the caller-side check the helper's API is
      // designed to require.)
      console.error(`heartbeat: silent-source /fail ping did not send: ${result.error}`);
    }
  }

  return new Response(JSON.stringify({ pinged: pingResult.ok, silentSources, alarmOk }), {
    headers: { "content-type": "application/json" },
  });
});
