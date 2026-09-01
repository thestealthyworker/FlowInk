// The only out-of-band alarm left once Telegram is gone (operator decision,
// 2026-08-25, see docs/architecture.md §2), matching the `heartbeat` job's
// current description in §7: Supabase Cron has no failure alerting of its
// own, and the per-source silence check exists because a bank quietly
// reverting an alert threshold is otherwise invisible to an aggregate
// "did anything ingest today" check. healthchecks.io is a dead-man's-
// switch: it alerts by email when pings *stop*, which is what catches a
// paused project or a silently
// dropped cron schedule that no in-process check could ever see.
//
// Three request shapes, same base URL:
//   POST <url>        -> success ping ("still alive")
//   POST <url>/fail    -> explicit failure, triggers an alert email immediately
//   POST <url>/log     -> informational, recorded but does not alert
//
// Callers choose which one: reserve /fail for genuine system-health
// problems (per-source silence, a held watermark) and use /log for
// data-quality issues (parse-failure spikes, permanently-unparseable
// messages) — using /fail for routine data-quality noise trains the
// operator to ignore the alarm, which defeats the point of having one.
//
// Same requirement the old _shared/telegram.ts called out: "the one
// function responsible for surfacing every failure mode can itself fail
// silently" must not happen here either. So: a short timeout, this never
// throws, and every call returns a result the caller can check instead of
// swallowing it. A missing HEALTHCHECKS_PING_URL logs loudly and returns
// ok: false rather than throwing — a missing alarm URL must not crash the
// function that was trying to report a *different* problem.

const PING_TIMEOUT_MS = 5_000;

export interface HealthcheckPingResult {
  ok: boolean;
  /** Populated when ok === false. Safe to log. */
  error?: string;
}

async function ping(suffix: "" | "/fail" | "/log", body?: string): Promise<HealthcheckPingResult> {
  const baseUrl = Deno.env.get("HEALTHCHECKS_PING_URL");
  if (!baseUrl) {
    const error = "HEALTHCHECKS_PING_URL not configured";
    console.error(`healthchecks.io ping skipped (${suffix || "success"}): ${error}`);
    return { ok: false, error };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}${suffix}`, {
      // POST (rather than GET) whenever there's a body: healthchecks.io
      // stores the POST body (up to 10KB) and shows it in the ping
      // details / alert email. The plain success ping carries nothing
      // worth recording, so it stays a GET, matching the original
      // heartbeat behaviour exactly.
      method: body !== undefined ? "POST" : "GET",
      body,
      signal: controller.signal,
    });
    await res.text().catch(() => {}); // drain so the connection can be released
    if (!res.ok) {
      const error = `healthchecks.io returned HTTP ${res.status}`;
      console.error(`healthchecks.io ping failed (${suffix || "success"}): ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`healthchecks.io ping failed (${suffix || "success"}): ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timeout);
  }
}

/** Success ping — "still alive". No body: healthchecks needs nothing more. */
export function pingSuccess(): Promise<HealthcheckPingResult> {
  return ping("");
}

/**
 * Failure ping — triggers an alert email immediately. Reserve for genuine
 * system-health problems: a source gone silent, a watermark that is being
 * held and will retry forever until resolved. `reason` becomes the ping
 * body, so keep it short and specific — it's what shows up in the alert.
 */
export function pingFail(reason: string): Promise<HealthcheckPingResult> {
  return ping("/fail", reason);
}

/**
 * Informational ping — recorded on the healthchecks.io dashboard but does
 * NOT alert. For data-quality issues (a parse failure, an unparseable
 * message) that are not themselves evidence the system is down.
 */
export function pingLog(detail: string): Promise<HealthcheckPingResult> {
  return ping("/log", detail);
}
