"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./env";

// Browser-side client. Uses the publishable key only — RLS (Task 1) is
// what makes this safe to ship to the client, not any secrecy of this
// key. Never import the service role key here or anywhere in this app.
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}
