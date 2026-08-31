"use server";

import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";

export interface AuthActionState {
  error?: string;
}

// Generic on purpose: an unknown email and a wrong password must produce
// the exact same user-facing text, or the form becomes an oracle for
// which accounts exist.
const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const RATE_LIMITED_MESSAGE = "Too many attempts. Wait a few minutes and try again.";

// Email + password, not magic link (operator decision, UX not security —
// this is a single-user private app with public signup disabled, so both
// mechanisms are equally secure; password just removes the email
// round-trip). There is exactly one account and it already exists in
// Supabase Auth plus the app_admin allow-list — this action only ever
// signs that account in, it never creates one.
export async function signIn(
  _prevState: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const nextParam = String(formData.get("next") ?? "/");
  // Only ever follow a same-origin relative path — nextParam rides through
  // a hidden form field originally seeded from our own middleware redirect,
  // but treat it as untrusted input anyway rather than trust the source.
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  if (!email || !password) {
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    if (error.code === "over_request_rate_limit") {
      return { error: RATE_LIMITED_MESSAGE };
    }
    // Covers invalid_credentials (unknown email or wrong password) and
    // anything else Supabase might return — same message either way, both
    // to avoid enumeration and to avoid leaking internal error detail.
    return { error: INVALID_CREDENTIALS_MESSAGE };
  }

  redirect(next);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
