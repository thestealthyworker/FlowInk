// JOB-1 · ingest-alerts. Supabase Cron, every 2 minutes.
// See docs/cardledger-build-spec.md §7 and §8. This is Layer 1 (LIVE) —
// the primary data source. It writes `provisional` rows only; JOB-3
// (reconcile, in GitHub Actions) is what promotes them to `confirmed`.
//
// Batch cap: 20 messages per invocation (Edge Function budget, §2). If the
// watermark query returns more, process 20 and leave the watermark for the
// next tick — backfill drains itself.
//
// Telegram was removed 2026-08-25 (operator decision, §10 AMENDMENT):
// healthchecks.io is now the only out-of-band alarm (_shared/healthchecks.ts).
// Escalations below are split by what they actually mean:
//   - the watermark being held (backlog truncation) is genuine system-down
//     — `/fail`, an immediate alert email.
//   - parse-failure spikes, a single permanently-unparseable message, and a
//     merchant-row write failure are data-quality issues, not system-down
//     — `/log`, recorded but silent. Using `/fail` for routine data-quality
//     noise would train the operator to ignore the alarm.

import { requireCronAuth } from "../_shared/cron_auth.ts";
import { supabaseAdmin } from "../_shared/supabase_admin.ts";
import {
  getAccessToken,
  getLabelNameToId,
  getMessage,
  listMessageIdsPaged,
  senderDomain,
  type GmailMessage,
} from "../_shared/gmail.ts";
import { parseAlert, RetriableError, type ParsedAlert } from "../_shared/anthropic.ts";
import {
  findMerchant,
  normalizeMerchant,
  isUsableMatchPattern,
  type MerchantRow,
} from "../_shared/merchant.ts";
import { calendarMonth, resolvePeriodKey } from "../_shared/period.ts";
import { pingFail, pingLog } from "../_shared/healthchecks.ts";
import { mapWithConcurrency } from "../_shared/concurrency.ts";
import {
  buildLabelClause,
  buildLabelIdToMethod,
  senderDomainIsTrusted,
} from "../_shared/routing.ts";

const BATCH_CAP = 20;
// Gmail fetches are I/O, not CPU (§2 budget note), but each of them still
// costs wall clock, so bound how many run in flight at once rather than
// opening BATCH_CAP sockets simultaneously.
const MESSAGE_FETCH_CONCURRENCY = 5;

// Routes by Gmail label, not by parsing the issuer from the body (§7).
// WP2 (design/ingestion-routing.md): this used to be a hardcoded
// LABEL_TO_METHOD constant here, requiring a source edit and a redeploy to
// add a card. It is now read from `payment_methods.alert_label` at request
// time (see the `methods` query below and `buildLabelIdToMethod`) — the
// same routing decision, sourced from the one place a user can edit
// without touching code.
//
// §4 trap 3 / item 3: routing on last4 + a Payments/* label alone is not
// enough — the label only proves the mail landed under a Gmail filter, and
// a filter can be spoofed by anyone who can get a lookalike domain past
// the recipient's own rules. Cross-check the actual `From` domain against
// an EXACT allowlist per method (now `payment_methods.alert_senders`,
// possibly more than one domain per method) before trusting anything the
// model or the label say. Substring/contains matching is unsafe:
// `unialerts@uobgroup.com.attacker.io` contains "uobgroup.com" and is the
// attacker's own domain, which passes DMARC for itself — see
// `senderDomainIsTrusted` below, and its regression tests in
// `routing_test.ts`.

Deno.serve(async (req) => {
  const authError = await requireCronAuth(req);
  if (authError) return authError;

  const db = supabaseAdmin();

  const { data: state, error: stateErr } = await db
    .from("ingest_state")
    .select("watermark")
    .eq("stream", "alerts")
    .single();
  if (stateErr) return new Response(`ingest_state read failed: ${stateErr.message}`, { status: 500 });
  const watermark: number = state.watermark;

  // WP2: alert_label / alert_senders were LABEL_TO_METHOD / SENDER_DOMAINS
  // module constants until this change — now fetched here alongside the
  // other per-method fields, so routing config lives in one editable place
  // (payment_methods) instead of a source file that needs a redeploy. A
  // failure reading this table fails the whole request closed (the
  // existing `return new Response(..., 500)` below) rather than falling
  // back to any cached or default routing table — never fail open.
  const { data: methods, error: methodsErr } = await db
    .from("payment_methods")
    .select("id, last4, period_type, cycle_day, active, alert_label, alert_senders");
  if (methodsErr) return new Response(`payment_methods read failed: ${methodsErr.message}`, { status: 500 });

  const { data: merchantRows, error: merchantErr } = await db
    .from("merchants")
    .select("id, match_pattern, display_name, category, hsbc_eligible, is_transfer, confidence");
  if (merchantErr) return new Response(`merchants read failed: ${merchantErr.message}`, { status: 500 });
  const merchants = merchantRows as MerchantRow[];

  // WP3 optional-integration guard (design/optional-integrations.md,
  // "Gmail absent" / "Anthropic absent"): a fresh deployment that has
  // only configured Supabase so far must not crash here. Without this,
  // getAccessToken() below throws on missing env vars, which Supabase
  // Cron logs as a failed invocation every 2 minutes forever with no
  // user-visible signal. Absent-by-choice degrades gracefully — this is
  // "not set up yet", not a system failure, so no healthchecks ping.
  if (!Deno.env.get("GMAIL_REFRESH_TOKEN") || !Deno.env.get("GMAIL_CLIENT_ID") || !Deno.env.get("GMAIL_CLIENT_SECRET")) {
    return new Response(JSON.stringify({ skipped: "Gmail not configured" }), {
      headers: { "content-type": "application/json" },
    });
  }
  // Anthropic is only actually needed once a message is found to parse,
  // but checking it here — rather than letting every message in today's
  // batch fail identically inside parseAlert() — turns N identical
  // parse_failures rows per tick into one clear, distinct response body
  // and a single /log ping instead of a wall of indistinguishable
  // failures accumulating forever.
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    await escalateLog("ingest-alerts: ANTHROPIC_API_KEY not configured — skipping this tick.");
    return new Response(JSON.stringify({ skipped: "ANTHROPIC_API_KEY not configured" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const accessToken = await getAccessToken();
  const labelNameToId = await getLabelNameToId(accessToken);
  const labelIdToMethod = buildLabelIdToMethod(methods, labelNameToId);

  // Small overlap on the `after:` boundary (Gmail's after: is date/second
  // granularity, not exclusive-of-watermark) — de-duped by internalDate
  // filtering below and by the transactions unique constraint either way.
  const afterSeconds = Math.floor((watermark - 60_000) / 1000);
  // Gmail's `label:Parent` does NOT match messages in nested sub-labels — they
  // are separate labels, not a queryable hierarchy. The spec (§7) specifies
  // `label:Payments`, which was wrong: verified 2026-08-26 against the live
  // mailbox, `label:Payments` matched 0 messages while `label:Payments/UOB`
  // matched 10 and `label:Payments/PayLah` matched 2. The filters were correct
  // all along; this query could never see what they labelled, and it failed
  // silently — no error, no parse_failure, watermark simply never advancing.
  //
  // Build the OR-set from the fetched payment_methods rows (buildLabelClause,
  // _shared/routing.ts) so a new card's alert_label cannot be configured and
  // forgotten here — this query and labelIdToMethod above are now built
  // from the exact same source.
  const labelClause = buildLabelClause(methods);
  const query = `{${labelClause}} after:${Math.max(afterSeconds, 0)}`;

  // Generous paging limits: real volume here is ~100 txns/month (§8 cost
  // note), so a backlog since watermark that needs more than this to
  // enumerate is itself the anomaly. Keep it well above realistic traffic
  // so `truncated` in practice signals "something is wrong", not
  // "business as usual".
  const listResult = await listMessageIdsPaged(accessToken, query, {
    pageSize: 500,
    maxPages: 20,
    deadlineMs: 45_000,
  });

  if (listResult.truncated) {
    // §7 / gmail.ts: `ids` only ever contains a NEWEST-first prefix of the
    // full result set. When paging is cut off before exhausting it, every
    // message we have NOT fetched is strictly OLDER than everything we
    // did fetch (each subsequent page is older than the last). There is
    // therefore no subset of what we hold that is safe to advance the
    // watermark past — any advancement would make the still-unseen older
    // mail permanently unreachable via `after:`, since `after:` only ever
    // moves forward. Do not process, do not advance, escalate loudly: this
    // is a genuine anomaly at this system's expected volume, not routine
    // backfill.
    // The watermark is being held — zero messages processed this tick,
    // specifically to avoid skipping older unseen mail. That is exactly
    // the "genuinely transient failure that will retry forever until
    // resolved" case: system-down, not a data-quality issue. `/fail`.
    await escalateFail(
      `ingest-alerts: backlog since the last watermark exceeds ${listResult.pagesFetched} pages ` +
        `(${listResult.ids.length} candidate ids) — did not process anything this tick to avoid ` +
        `skipping older unseen mail. The watermark is being held: investigate before this repeats, ` +
        `either the watermark is stuck or mail volume spiked unexpectedly.`,
    );
    return new Response(
      JSON.stringify({ processed: 0, inserted: 0, skippedNotATransaction: 0, failed: 0, truncated: true }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Oldest-first: `ids` is newest-first, so reverse before capping to
  // BATCH_CAP. Complete result set here (truncated === false), so any
  // prefix we don't process this tick is still safely reachable by the
  // unmoved watermark next tick.
  const oldestFirstIds = listResult.ids.slice().reverse();

  const fetchedMessages = await mapWithConcurrency(
    oldestFirstIds,
    MESSAGE_FETCH_CONCURRENCY,
    (id) => getMessage(accessToken, id),
  );
  const batch = fetchedMessages
    .filter((msg) => msg.internalDate > watermark)
    .slice(0, BATCH_CAP);

  let lastGoodWatermark = watermark;
  let inserted = 0;
  let skippedNotATransaction = 0;
  let failed = 0;

  for (const msg of batch) {
    const outcome = await processMessage(db, merchants, methods, labelIdToMethod, msg);

    if (outcome.kind === "transient_failure") {
      // Do NOT advance past this message — the same input must be
      // retried, per §8: "Do not advance the watermark past a failure."
      failed++;
      break;
    }

    if (outcome.kind === "permanent_failure") {
      // §8 validation failures / unrecognised routing are deterministic:
      // the same input yields the same rejection forever. Recording it and
      // moving on (rather than the old `break`) is what stops one bad
      // message from pinning the watermark and burning an Anthropic call
      // every two minutes indefinitely.
      failed++;
      lastGoodWatermark = msg.internalDate;
      // Data-quality, not system-down: the watermark still advances past
      // this message, so nothing is being held. `/log`.
      await escalateLog(
        `ingest-alerts: permanently rejected message ${msg.id} and moved past it (will not retry). ` +
          `Reason: ${outcome.reason}`,
      );
      continue;
    }

    if (outcome.kind === "not_a_transaction") {
      skippedNotATransaction++;
      lastGoodWatermark = msg.internalDate;
      continue;
    }

    inserted++;
    lastGoodWatermark = msg.internalDate;
  }

  if (lastGoodWatermark !== watermark) {
    // Guard against regression, not just against a no-op: the condition is
    // on the CURRENTLY STORED value being less than what we're about to
    // write, not on it still equalling what we read at the top of this
    // invocation. That distinction matters for two overlapping invocations
    // (a slow run still in flight when the next cron tick fires) — if the
    // other one already advanced the watermark further than this run's
    // result, `.lt()` skips the write instead of regressing it. `.eq()`
    // against the originally-read value would instead just silently no-op
    // in that same race without telling us, which is also safe but hides
    // the race; `.lt()` against the target value is the correct guard
    // either way this run's own result compares to what's stored now.
    const { error: casErr } = await db
      .from("ingest_state")
      .update({ watermark: lastGoodWatermark, updated_at: new Date().toISOString() })
      .eq("stream", "alerts")
      .lt("watermark", lastGoodWatermark);
    if (casErr) {
      console.error(`ingest_state watermark update failed: ${casErr.message}`);
    }
  }

  if (failed > 0) {
    const { count } = await db
      .from("parse_failures")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= 3) {
      // A spike, not a hang — the pipeline is still running, just producing
      // bad output. Data-quality signal, `/log`.
      await escalateLog(
        `ingest-alerts: ${count} unresolved parse_failures in the last 24h. A bank has probably changed its email format — check parse_failures.`,
      );
    }
  }

  return new Response(
    JSON.stringify({ processed: batch.length, inserted, skippedNotATransaction, failed }),
    { headers: { "content-type": "application/json" } },
  );
});

type PaymentMethodRow = {
  id: string;
  last4: string | null;
  period_type: "calendar" | "statement";
  cycle_day: number | null;
  active: boolean;
  alert_label: string | null;
  alert_senders: string[] | null;
};

type ProcessOutcome =
  | { kind: "inserted" }
  | { kind: "not_a_transaction" }
  | { kind: "permanent_failure"; reason: string }
  | { kind: "transient_failure"; reason: string };

/**
 * Handles a single message end to end. Wrapped by the caller in nothing —
 * this function itself never throws; every failure path, expected or not,
 * is captured here and turned into a `parse_failures` row plus a
 * classified outcome, per item 2: an uncaught throw previously escaped
 * `Deno.serve` before the watermark write and without any `recordFailure`,
 * so it retried forever with no trace and no alert.
 */
async function processMessage(
  db: ReturnType<typeof supabaseAdmin>,
  merchants: MerchantRow[],
  methods: PaymentMethodRow[],
  labelIdToMethod: Record<string, string>,
  msg: GmailMessage,
): Promise<ProcessOutcome> {
  try {
    const methodId = msg.labelIds.map((id) => labelIdToMethod[id]).find(Boolean);
    if (!methodId) {
      await recordFailure(db, msg.id, msg.bodyText, null, "no recognised Payments/* sub-label on this message");
      return { kind: "permanent_failure", reason: "unrecognised label" };
    }

    const method = methods.find((m) => m.id === methodId && m.active);
    if (!method) {
      await recordFailure(db, msg.id, msg.bodyText, null, `payment_methods row for '${methodId}' missing or inactive`);
      return { kind: "permanent_failure", reason: `payment_methods row for '${methodId}' missing or inactive` };
    }

    // §4 trap 3 / item 3: the label identifies the issuer, not the sender.
    // Cross-check the From header's exact domain before trusting anything
    // routed off it. Missing config for a method (e.g. citi_cashback,
    // sender not yet confirmed — alert_senders is NULL for it) is treated
    // the same as a mismatch — an unverifiable sender is not a verified
    // one. `senderDomainIsTrusted` (_shared/routing.ts) is the array-aware
    // generalisation of what used to be a single `===` here; see its
    // doc comment and routing_test.ts for why this is not weaker.
    const expectedDomains = method.alert_senders;
    const actualDomain = senderDomain(msg.from);
    if (!senderDomainIsTrusted(actualDomain, expectedDomains)) {
      const expectedDesc = expectedDomains && expectedDomains.length > 0
        ? expectedDomains.join(", ")
        : "(none configured)";
      const reason = `sender domain '${actualDomain ?? "(unparseable)"}' does not match a confirmed sender for '${methodId}' ('${expectedDesc}') — possible spoof or unconfigured method`;
      await recordFailure(db, msg.id, msg.bodyText, null, reason);
      return { kind: "permanent_failure", reason };
    }

    let parsed: ParsedAlert;
    try {
      parsed = await parseAlert({
        subject: msg.subject,
        from: msg.from,
        bodyText: msg.bodyText,
        emailReceivedIso: new Date(msg.internalDate).toISOString(),
      });
    } catch (err) {
      if (err instanceof RetriableError) {
        const reason = `Anthropic API error after retries: ${err.message}`;
        await recordFailure(db, msg.id, msg.bodyText, null, reason);
        return { kind: "transient_failure", reason };
      }
      // PermanentParseError (unusable model output) and anything else
      // unexpected from the parser: deterministic at temperature 0, so
      // retrying is pointless — but the failure mode itself is
      // unanticipated, so still don't advance blindly past it silently
      // without a record. Per §8, only RetriableError should hold the
      // watermark; everything else here is treated as permanent.
      const reason = `parser call failed: ${err instanceof Error ? err.message : String(err)}`;
      await recordFailure(db, msg.id, msg.bodyText, null, reason);
      return { kind: "permanent_failure", reason };
    }

    if (parsed.txn_type === "not_a_transaction") {
      return { kind: "not_a_transaction" };
    }

    const rejection = validate(parsed, method.last4);
    if (rejection) {
      await recordFailure(db, msg.id, msg.bodyText, JSON.stringify(parsed), rejection);
      return { kind: "permanent_failure", reason: rejection };
    }

    // validate() above guarantees merchant_raw is a non-empty string and
    // currency is a strict ISO 4217-shaped code — safe to use without the
    // non-null assertions the previous version relied on.
    const merchantRaw = parsed.merchant_raw as string;
    const normalized = normalizeMerchant(merchantRaw);
    let merchant = findMerchant(merchants, normalized);

    if (!merchant) {
      if (!isUsableMatchPattern(normalized)) {
        // Item 6: a punctuation-only or too-short merchant string
        // normalises to something that would match everything. Never
        // write it as a match_pattern — the DB's length>=3 check would
        // reject it anyway, but guard client-side so this is a deliberate
        // skip, not a caught constraint violation. The transaction still
        // gets inserted below with merchant_id/category left null rather
        // than silently becoming (or matching) a global catch-all.
        console.error(
          `ingest-alerts: merchant_raw '${merchantRaw}' normalised to an unusable pattern ('${normalized}') — skipping merchant creation, leaving this transaction uncategorised.`,
        );
      } else {
        const isTransferHint = parsed.txn_type === "transfer" || parsed.txn_type === "topup";
        const { data: created, error: createErr } = await db
          .from("merchants")
          .upsert(
            {
              match_pattern: normalized,
              display_name: merchantRaw,
              category: "other",
              confidence: "guessed",
              is_transfer: isTransferHint,
            },
            { onConflict: "match_pattern", ignoreDuplicates: false },
          )
          .select()
          .single();
        if (createErr) {
          // Item 5: previously swallowed entirely — no log, no failure
          // record, no alert. The transaction below still proceeds
          // (uncategorised is better than dropped, per §8's "a gap is
          // visible... a wrong number silently corrupts"), but the error
          // itself must not vanish, or the merchant never reaches triage
          // and nobody ever finds out why.
          console.error(`ingest-alerts: merchant creation failed for '${normalized}': ${createErr.message}`);
          // Degraded, not down: the transaction still inserts (uncategorised
          // rather than dropped). `/log`.
          await escalateLog(
            `ingest-alerts: failed to create merchant row for '${normalized}' (message ${msg.id}): ` +
              `${createErr.message}. Transaction will insert uncategorised.`,
          );
        } else if (created) {
          merchant = created as MerchantRow;
          merchants.push(merchant);
        }
      }
    }

    const txnDate = parsed.txn_date as string;
    const periodKey = resolvePeriodKey(methodId, method.period_type, method.cycle_day, txnDate);

    // Item 4: `??` only falls through on null/undefined, so a merchant row
    // that legitimately has is_transfer = false (the common case) would
    // permanently override a "transfer"/"topup" parse-time hint on every
    // future transaction against that merchant. OR them: either signal is
    // sufficient to flag a transfer, per §4 trap 4 ("set is_transfer at
    // parse time rather than waiting on merchant classification").
    const isTransferHint = parsed.txn_type === "transfer" || parsed.txn_type === "topup";
    const isTransfer = isTransferHint || (merchant?.is_transfer ?? false);

    const { error: insertErr } = await db.from("transactions").insert({
      method_id: methodId,
      txn_date: txnDate,
      merchant_raw: merchantRaw,
      merchant_id: merchant?.id ?? null,
      amount: parsed.amount,
      currency: parsed.currency,
      category: merchant?.category ?? null,
      is_transfer: isTransfer,
      status: "provisional",
      source: "alert",
      source_ref: msg.id,
      period_key: periodKey,
      calendar_month: calendarMonth(txnDate),
    });

    if (insertErr && insertErr.code !== "23505") { // 23505 = unique_violation, already ingested
      const reason = `insert failed: ${insertErr.message}`;
      await recordFailure(db, msg.id, msg.bodyText, JSON.stringify(parsed), reason);
      // An insert failure that is not "already ingested" is not
      // deterministic in the way a validation rejection is (RLS
      // misconfiguration, transient DB issue, etc.) — hold the watermark.
      return { kind: "transient_failure", reason };
    }

    return { kind: "inserted" };
  } catch (err) {
    // Safety net: any unanticipated throw (a bug, a null we didn't guard,
    // a network blip in a call not already wrapped) still becomes a
    // parse_failures row instead of an uncaught exception that skips the
    // watermark write entirely and leaves zero trace. Treated as
    // transient/holding, since we don't know whether it's safe to skip.
    const reason = `unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    try {
      await recordFailure(db, msg.id, msg.bodyText, null, reason);
    } catch (recordErr) {
      console.error(`ingest-alerts: recordFailure itself failed: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`);
    }
    return { kind: "transient_failure", reason };
  }
}

function validate(parsed: ParsedAlert, methodLast4: string | null): string | null {
  if (typeof parsed.amount !== "number" || !Number.isFinite(parsed.amount) || parsed.amount <= 0) {
    return "amount absent, non-numeric, zero or negative";
  }
  // §4 trap 1: UOB reports foreign currency, never guess SGD. A missing
  // currency must not be allowed to fall through to the transactions
  // table's `default 'SGD'` — that is exactly the silent guess §4 forbids
  // in bold. Require a real ISO 4217-shaped code from the model instead.
  if (typeof parsed.currency !== "string" || !/^[A-Z]{3}$/.test(parsed.currency)) {
    return "currency missing or not a 3-letter ISO 4217 code";
  }
  // The system prompt explicitly tells the model to return null rather
  // than infer a merchant — null is an expected, not exceptional, output.
  // Reject it here (recorded, not thrown) instead of letting a bare `!`
  // assertion crash normalizeMerchant() downstream.
  if (typeof parsed.merchant_raw !== "string" || parsed.merchant_raw.trim().length === 0) {
    return "merchant_raw missing or empty";
  }
  if (!parsed.txn_date || Number.isNaN(Date.parse(parsed.txn_date))) {
    return "txn_date missing or unparseable";
  }
  const txnDate = new Date(parsed.txn_date);
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  if (txnDate.getTime() > now.getTime()) return "txn_date is in the future";
  if (txnDate.getTime() < ninetyDaysAgo.getTime()) return "txn_date is more than 90 days past";
  // §4 trap 3 / item 3: last4 is now mandatory, not merely checked when
  // present. A null last4 previously sailed through validation and left
  // routing resting entirely on the Gmail label (itself now cross-checked
  // against the sender domain, but that is a second, independent control
  // — this one must not be weakened back to "checked only if present").
  if (!parsed.last4 || parsed.last4 !== methodLast4) {
    return `last4 '${parsed.last4 ?? "null"}' does not match the routed card's last4 '${methodLast4}' — new or fraudulent card?`;
  }
  if (parsed.confidence === "low") return "parser confidence was low";
  return null;
}

async function recordFailure(
  db: ReturnType<typeof supabaseAdmin>,
  sourceRef: string,
  rawBody: string,
  modelOutput: string | null,
  reason: string,
) {
  await db.from("parse_failures").upsert(
    { source_ref: sourceRef, raw_body: rawBody, model_output: modelOutput, reason },
    { onConflict: "source_ref", ignoreDuplicates: true },
  );
}

/**
 * Fires a healthchecks.io `/fail` ping — an immediate alert email — and
 * makes sure a delivery failure itself is visible (Edge Function logs)
 * rather than disappearing. Reserve for genuine system-down conditions
 * (see _shared/healthchecks.ts and the file header above).
 */
async function escalateFail(reason: string): Promise<void> {
  const result = await pingFail(reason);
  if (!result.ok) {
    console.error(`ingest-alerts: healthchecks /fail ping did not send: ${result.error}`);
  }
}

/**
 * Fires a healthchecks.io `/log` ping — recorded, no alert. For
 * data-quality issues that are not themselves evidence the system is
 * down; using `/fail` here would train the operator to ignore the alarm.
 */
async function escalateLog(reason: string): Promise<void> {
  const result = await pingLog(reason);
  if (!result.ok) {
    console.error(`ingest-alerts: healthchecks /log ping did not send: ${result.error}`);
  }
}
