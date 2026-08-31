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
}

// Loosely typed: card_period_status()'s jsonb shape differs per card
// (§9 dispatcher in supabase/migrations/0007_rules_engine.sql) and is
// deliberately not re-modelled 1:1 here. Callers narrow what they need.
export interface CardPeriodStatus {
  method_id: string;
  has_rules?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface CardDashboardStatusRow {
  method_id: string;
  display_name: string;
  status: CardPeriodStatus;
}
