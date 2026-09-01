// Single place that reads the two permitted env vars (see
// docs/architecture.md §10, security model). Fails fast and loudly at
// startup rather than letting a missing var surface as a confusing
// downstream Supabase client error — required config must be validated
// at the boundary, not discovered at first use.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. This dashboard reads ` +
        `exactly two env vars (NEXT_PUBLIC_SUPABASE_URL, ` +
        `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) — see .env.local.example.`
    );
  }
  return value;
}

export const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
export const SUPABASE_PUBLISHABLE_KEY = requireEnv(
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
);
