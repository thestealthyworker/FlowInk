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
import { getAccessToken } from "../_shared/gmail.ts";

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

  // WP3 optional-integration detection (design/optional-integrations.md,
  // "Detection: one settings/status source, not five ad hoc checks").
  // heartbeat already runs hourly with access to every Edge Function
  // secret, and is the one place already asserting "is this system still
  // alive" — so it's also the natural writer of a per-integration status
  // row the dashboard can read without holding any of these secrets
  // itself. Best-effort: a failure to WRITE this status must never turn
  // into a failure of heartbeat's actual job (the alarm above).
  try {
    await recordIntegrationStatus(db);
  } catch (err) {
    console.error(`heartbeat: recording integration_status failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return new Response(JSON.stringify({ pinged: pingResult.ok, silentSources, alarmOk }), {
    headers: { "content-type": "application/json" },
  });
});

/**
 * Detects and upserts the current configured/not-configured state of
 * every optional integration this design tracks (gmail, anthropic,
 * healthchecks — statement_ingestion is written separately by
 * scripts/ingest_statements.py, the GitHub Actions runtime that actually
 * knows whether any payment method has a statement sender configured).
 *
 * Detection per design/optional-integrations.md's table:
 *  - gmail: env-var presence AND a successful token refresh — not just
 *    "the var is a non-empty string" (mirrors verify_token.py's Day-8
 *    check). A present-but-wrong secret shows up in `detail`, distinct
 *    from genuinely absent.
 *  - anthropic: env-var presence only. A real API call here every hour
 *    just to check would cost money for a check `_shared/anthropic.ts`'s
 *    own `if (!apiKey) throw` already makes deterministic.
 *  - healthchecks: env-var presence, independent of whether THIS tick's
 *    ping happened to succeed — the dashboard notice this drives
 *    ("no external monitoring configured") is about absence, not
 *    transient failure, which pingSuccess()'s own logging already
 *    surfaces separately.
 */
async function recordIntegrationStatus(db: ReturnType<typeof supabaseAdmin>): Promise<void> {
  const gmail = await checkGmailStatus();
  const anthropicConfigured = Boolean(Deno.env.get("ANTHROPIC_API_KEY"));
  const healthchecksConfigured = Boolean(Deno.env.get("HEALTHCHECKS_PING_URL"));

  const rows = [
    { key: "gmail", configured: gmail.configured, detail: gmail.detail },
    {
      key: "anthropic",
      configured: anthropicConfigured,
      detail: anthropicConfigured ? "ANTHROPIC_API_KEY set" : "ANTHROPIC_API_KEY not configured",
    },
    {
      key: "healthchecks",
      configured: healthchecksConfigured,
      detail: healthchecksConfigured ? "HEALTHCHECKS_PING_URL set" : "HEALTHCHECKS_PING_URL not configured",
    },
  ];

  const { error } = await db.from("integration_status").upsert(
    rows.map((r) => ({ ...r, checked_at: new Date().toISOString() })),
    { onConflict: "key" },
  );
  if (error) throw new Error(`integration_status upsert failed: ${error.message}`);
}

async function checkGmailStatus(): Promise<{ configured: boolean; detail: string }> {
  const hasEnv =
    Boolean(Deno.env.get("GMAIL_REFRESH_TOKEN")) &&
    Boolean(Deno.env.get("GMAIL_CLIENT_ID")) &&
    Boolean(Deno.env.get("GMAIL_CLIENT_SECRET"));
  if (!hasEnv) {
    return { configured: false, detail: "GMAIL_REFRESH_TOKEN / GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set" };
  }
  try {
    await getAccessToken();
    return { configured: true, detail: "token refresh succeeded" };
  } catch (err) {
    // Env vars are present but the OAuth exchange itself failed — a
    // wrong/expired/revoked secret, not an absent one. Reported as "not
    // configured" for the dashboard's purposes (ingestion cannot run
    // either way), but the detail distinguishes the two for anyone
    // reading this table directly, per the absent-vs-broken distinction
    // this whole design package is built around.
    return { configured: false, detail: `token refresh failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
