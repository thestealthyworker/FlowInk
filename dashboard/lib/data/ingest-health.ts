import type { SupabaseClient } from "@supabase/supabase-js";
import type { PaymentMethod, Transaction } from "../supabase/types";

const STALE_HOURS = 72;

export interface SilentSource {
  methodId: string;
  displayName: string;
  lastSeenAt: string;
  hoursSinceLastAlert: number;
}

/** Per-method last-seen alert-sourced transaction (§4 "Silent source" /
 * §6 D5 / §7 item 4) — the one genuinely new read this plan calls for, not
 * a restyle of an existing query. Mirrors the same >72h staleness window
 * `heartbeat` already runs externally
 * (supabase/functions/_shared/healthchecks.ts) — this is the redundant,
 * human-visible half of that check, not a replacement for it.
 *
 * Only a method with at least one PRIOR alert-sourced row is eligible to
 * be reported silent: a method that has never produced an alert (the
 * live-ingest-debugging state as of 2026-08-26 — zero `source='alert'`
 * rows exist anywhere yet) has no established baseline to go silent FROM,
 * and flagging it would fabricate an alarm this data cannot actually
 * support (§4's own honesty rule, applied to absence rather than to a
 * present figure). Once real alert rows land, this starts reporting on
 * its own — nothing here needs to change.
 */
export async function getSilentSources(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<SilentSource[]> {
  const { data: methods, error: methodsError } = await supabase
    .from("payment_methods")
    .select("*")
    .eq("active", true)
    .neq("method_type", "cash");
  if (methodsError) throw methodsError;

  const eligible = (methods ?? []) as PaymentMethod[];
  if (eligible.length === 0) return [];

  const { data: rows, error } = await supabase
    .from("transactions")
    .select("method_id, created_at")
    .eq("source", "alert")
    .in(
      "method_id",
      eligible.map((m) => m.id)
    )
    .order("created_at", { ascending: false });
  if (error) throw error;

  const lastSeenByMethod = new Map<string, string>();
  for (const row of (rows ?? []) as Array<Pick<Transaction, "method_id" | "created_at">>) {
    if (!lastSeenByMethod.has(row.method_id)) lastSeenByMethod.set(row.method_id, row.created_at);
  }

  const silent: SilentSource[] = [];
  for (const method of eligible) {
    const lastSeenAt = lastSeenByMethod.get(method.id);
    if (!lastSeenAt) continue; // no baseline yet — not reportable as "silent"

    const hours = (now.getTime() - new Date(lastSeenAt).getTime()) / (1000 * 60 * 60);
    if (hours >= STALE_HOURS) {
      silent.push({
        methodId: method.id,
        displayName: method.display_name,
        lastSeenAt,
        hoursSinceLastAlert: hours,
      });
    }
  }

  return silent;
}
