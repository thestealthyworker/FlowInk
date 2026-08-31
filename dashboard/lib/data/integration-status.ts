import type { SupabaseClient } from "@supabase/supabase-js";

// WP3 optional-integration detection (design/optional-integrations.md,
// "Detection: one settings/status source, not five ad hoc checks"). This
// is the ONE read every degraded-state UI surface goes through, rather
// than each page guessing at Gmail/Anthropic/healthchecks presence on its
// own. The dashboard never holds any of these secrets itself — it only
// ever reads a status row a service-role job (heartbeat, for gmail /
// anthropic / healthchecks; scripts/ingest_statements.py, for
// statement_ingestion) already wrote, via the same is_operator()-scoped
// RLS policy every other read in this app goes through
// (0016_integration_status.sql).
//
// A fresh deployment where the relevant job hasn't run yet (heartbeat's
// first tick hasn't fired, or ingest_statements.py has never run) has NO
// row for that key. That is treated identically to "not configured" —
// deliberately: this app must degrade gracefully by default, not assume
// configured-but-unproven. The cost of a rare false-positive "not
// configured yet" banner in the minutes before the first heartbeat tick
// is far lower than the cost of staying silent about a real gap.

export type IntegrationKey = "gmail" | "anthropic" | "healthchecks" | "statement_ingestion";

export interface IntegrationStatusRow {
  key: IntegrationKey;
  configured: boolean;
  detail: string | null;
  checked_at: string;
}

export interface IntegrationStatus {
  gmail: IntegrationStatusRow | null;
  anthropic: IntegrationStatusRow | null;
  healthchecks: IntegrationStatusRow | null;
  statementIngestion: IntegrationStatusRow | null;
}

const EMPTY_STATUS: IntegrationStatus = {
  gmail: null,
  anthropic: null,
  healthchecks: null,
  statementIngestion: null,
};

export async function getIntegrationStatus(supabase: SupabaseClient): Promise<IntegrationStatus> {
  const { data, error } = await supabase.from("integration_status").select("*");
  // Fails open to "nothing configured" rather than throwing: a read
  // failure here (RLS misconfigured, table not migrated yet on an older
  // deployment) must not take down the whole dashboard over a status
  // indicator — the honest-but-conservative default is to show the
  // degraded-state banners, not to crash the page that would otherwise
  // explain why data might be missing.
  if (error) {
    console.error(`getIntegrationStatus: read failed, defaulting to unconfigured: ${error.message}`);
    return EMPTY_STATUS;
  }

  const byKey = new Map((data ?? []).map((row) => [row.key as IntegrationKey, row as IntegrationStatusRow]));
  return {
    gmail: byKey.get("gmail") ?? null,
    anthropic: byKey.get("anthropic") ?? null,
    healthchecks: byKey.get("healthchecks") ?? null,
    statementIngestion: byKey.get("statement_ingestion") ?? null,
  };
}

/** True only when a status row exists AND explicitly says configured. No
 * row, or configured === false, both read as "not configured" — see the
 * module comment above on why absence defaults conservatively. */
export function isConfigured(row: IntegrationStatusRow | null): boolean {
  return row?.configured === true;
}
