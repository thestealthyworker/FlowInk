import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role client. Bypasses RLS by design — this is the backend
// writer, not the dashboard. Never expose this key outside Edge Function
// / GitHub Actions env. See docs/cardledger-build-spec.md §11.
export function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
