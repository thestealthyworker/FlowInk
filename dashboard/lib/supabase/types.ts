// Hand-written types for the tables/view/RPCs this dashboard actually
// touches (Task 2: "a typed data layer for the queries the real UI will
// need"). Not a full `supabase gen types` codegen dump — deliberately
// scoped to the read/write surface Task 1's migration actually grants,
// so a type existing here is a promise the query is also allowed to run.
//
// Category vocabulary mirrors supabase/functions/_shared/categories.ts —
// kept in sync by hand since this project is TS on the Edge Function side
// and there is no shared package between the two runtimes.
export const CATEGORIES = [
  "groceries",
  "dining",
  "petrol",
  "commute",
  "transport",
  "bills",
  "online",
  "retail",
  "healthcare",
  "household",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export type TxnStatus = "provisional" | "confirmed" | "disputed" | "reversed";
export type TxnSource = "alert" | "statement" | "manual";

export interface Transaction {
  id: string;
  method_id: string;
  txn_date: string; // date
  posted_date: string | null;
  merchant_raw: string;
  merchant_id: number | null;
  amount: string; // numeric(12,2) comes back as a string over PostgREST
  currency: string;
  fx_amount: string | null;
  mcc: string | null;
  category: Category | null;
  is_transfer: boolean;
  status: TxnStatus;
  source: TxnSource;
  source_ref: string | null;
  period_key: string;
  calendar_month: string; // 'YYYY-MM'
  reconciled_with: string | null;
  created_at: string;
}

export interface ManualTransactionInput {
  method_id: string;
  txn_date: string;
  merchant_raw: string;
  amount: number;
  currency: string;
  category: Category;
  is_transfer: boolean;
}

export interface Merchant {
  id: number;
  match_pattern: string;
  display_name: string;
  category: Category;
  known_mcc: string | null;
  hsbc_eligible: boolean | null;
  is_transfer: boolean;
  confidence: "guessed" | "confirmed";
  created_at: string;
}

// The only merchant columns the dashboard is granted UPDATE on
// (supabase/migrations/0008_dashboard_rls.sql — column-level grant).
// Sending any other key is rejected by Postgres, not just by this type.
export interface MerchantTriageUpdate {
  category?: Category;
  is_transfer?: boolean;
  confidence?: "guessed" | "confirmed";
}

export interface Budget {
  id: number;
  category: Category;
  period: string; // 'YYYY-MM' or 'default'
  monthly_cap: string;
  alert_at: string;
}

export interface BudgetInput {
  category: Category;
  period: string;
  monthly_cap: number;
  alert_at?: number;
}

export interface PaymentMethod {
  id: string;
  display_name: string;
  issuer: string;
  last4: string | null;
  method_type: "credit_card" | "wallet" | "bank" | "cash";
  period_type: "calendar" | "statement";
  cycle_day: number | null;
  reward_type: "cashback" | "miles" | null;
  has_rules: boolean;
  active: boolean;
  // ISO 4217 home currency (0014_ingestion_routing_as_data.sql) — used to
  // render a wallet/no-rules method's own figures without assuming SGD.
  currency: string;
}

// ============ card_period_status() / card_dashboard_status() contract ============
// WP4 cutover (0017_repoint_card_period_status.sql): card_period_status()
// now returns evaluate_period()'s self-describing shape (0015_generic_
// rules_engine.sql, as amended by 27c9ad5), with `group` assembled
// server-side from evaluate_period_group() whenever has_group is true —
// never a per-card flat shape a client has to shape-sniff to interpret.
// Still loosely typed at the edges ([key: string]: unknown on each level)
// since this is a hand-written mirror of a jsonb contract, not codegen —
// but every field the dashboard actually reads is named and typed here so
// a card renderer never has to guess a key exists.

export interface CardPeriodThreshold {
  value: number;
  reached: boolean;
  is_current_tier: boolean;
  payout: number | null;
  // null once reached; otherwise the remaining spend gap (>=0, 0.00 when
  // spend already clears the threshold and only txn_min is unmet — see
  // txn_min below, which is what explains that case).
  gap: number | null;
  // Exposed (27c9ad5 QA fix) so a client can compute its own transaction
  // shortfall (txn_min - spend.txn_count) instead of a tier reading as an
  // unexplained "gap: 0.00, reached: false".
  txn_min: number;
}

export interface CardPeriodCap {
  basis: "reward" | "spend";
  amount: number;
  remaining: number | null;
  exhausted: boolean;
}

export interface CardRewardTrack {
  kind: "tier" | "category_rate";
  label: string;
  reward_form: "rate" | "fixed_payout";
  unit: string | null;
  accrued: number;
  // tier tracks only:
  thresholds?: CardPeriodThreshold[];
  gap_to_next?: number;
  // category_rate tracks only:
  categories?: string[] | null;
  threshold?: number | null;
  threshold_met?: boolean;
  matched_spend?: number;
  rate?: number | null;
  // Spend that fell outside this row's own cap-basis-'spend' cap (present
  // on the capped bonus row) or was routed IN to this row from a sibling
  // capped row (present on the base rate row) — 27c9ad5's fix for the
  // overflow reward that used to be invisible in reward_tracks[].
  overflow_spend?: number;
  note?: string;
  cap?: CardPeriodCap | null;
}

export interface CardGate {
  kind: "min_spend" | "txn_count" | string;
  cleared: boolean;
  required: number;
  actual: number;
  scope: "tier_only" | "all_rewards";
}

export interface CardPeriodBlockingMember {
  period_key: string;
  spend: number;
  txn_count: number;
  spend_short: number;
  txn_short: number;
}

export interface CardPeriodGroup {
  method_id: string;
  group_period_key: string;
  window: number;
  grouping: "anchor_aligned" | "anchor_unknown_trailing_window";
  anchor_unknown: boolean;
  // Each member is itself an evaluate_period() shape (or an {error} one) —
  // never recursively grouped (each member's own `group` is always null).
  members: CardPeriodStatus[];
  still_achievable_tier: { threshold: number; payout: number } | null;
  confirmed_tier: { threshold: number; payout: number } | null;
  forfeited: boolean;
  blocking_members: CardPeriodBlockingMember[];
  at_risk: boolean;
  approx_payout_at_stake: number | null;
}

export interface CardPeriodCrediting {
  block_size: number;
  floor: number;
  credited: number;
  accrued_uncredited: number;
}

export interface CardPeriodStatus {
  method_id: string;
  display_name?: string;
  has_rules?: boolean;
  note?: string;
  error?: string;
  active?: boolean;
  currency?: string;
  period?: {
    key: string;
    start: string;
    end: string;
    is_current: boolean;
    days_left: number;
    kind: "calendar" | "statement";
  };
  spend?: { total: number; txn_count: number };
  gates?: CardGate[];
  reward_tracks?: CardRewardTrack[];
  // Raw, pre-crediting total — the category_rate tracks' total ONLY. A
  // tier track's fixed_payout is a separate cross-period figure and is
  // deliberately NOT folded in here (0015's own long comment on this) —
  // so sum(reward_tracks[].accrued) equals this field only for a card
  // with no tier track; a card with one (uob_one) will always show a
  // higher track sum by exactly that tier's payout, and that is correct,
  // not a bug.
  reward_accrued?: number;
  cap?: CardPeriodCap | null;
  crediting?: CardPeriodCrediting | null;
  group?: CardPeriodGroup | null;
  has_group?: boolean;
  aggregation_window?: number | null;
  at_risk?: { value: boolean; reasons: string[] };
  estimate_caveats?: string[];
  [key: string]: unknown;
}

export interface CardDashboardStatusRow {
  method_id: string;
  display_name: string;
  status: CardPeriodStatus;
}
