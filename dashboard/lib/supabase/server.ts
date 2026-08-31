import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./env";

// Server-side client for Server Components, Server Actions and Route
// Handlers. Reads/writes the session via cookies. Still the publishable
// key only — every query this client makes is subject to the same RLS
// policies as the browser client, because it authenticates as the same
// signed-in user via the session cookie, not as a privileged role.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component that can't set cookies (no
          // response to attach them to). Safe to ignore here because
          // middleware.ts refreshes the session on every request that
          // matters for auth state — see docs/cardledger-build-spec.md
          // §10: "the middleware redirect is UX, not security", but
          // session refresh still needs to happen somewhere, and
          // middleware is the somewhere.
        }
      },
    },
  });
}
