#!/usr/bin/env bash
# One-time Edge Function secret provisioning (spec §7, §12 0A).
#
# The Gmail refresh token is minted and piped straight into `supabase secrets
# set`. It is never echoed, never written to disk, and never passes through an
# agent transcript — the exposure that forced a Supabase PAT rotation on
# 2026-08-25 is exactly what this avoids.
#
# Telegram was removed on 2026-08-25 (operator decision): warnings live on the
# dashboard instead. That deleted the only public unauthenticated endpoint in
# the system, and made healthchecks.io load-bearing rather than optional —
# see the note above HEALTHCHECKS_PING_URL below.
#
# Usage:  bash scripts/setup_secrets.sh
#
# Prerequisites:
#   - ~/cardledger-auth/client_secret.json  (the published OAuth desktop client)
#   - supabase CLI logged in, repo linked to the project
#   - a browser on this machine (Google consent is interactive)
#   - a healthchecks.io ping URL (free tier)

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF to your Supabase project ref, e.g. export SUPABASE_PROJECT_REF=<YOUR_SUPABASE_PROJECT_REF>}"
AUTH_DIR="$HOME/cardledger-auth"
SUPABASE_BIN="${SUPABASE_BIN:-$HOME/.local/bin/supabase}"
VENV_PY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.venv/bin/python"

die() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }
note() { printf '\n>> %s\n' "$1"; }

[ -f "$AUTH_DIR/client_secret.json" ] || die "missing $AUTH_DIR/client_secret.json"
[ -x "$SUPABASE_BIN" ] || die "supabase CLI not found at $SUPABASE_BIN"
[ -x "$VENV_PY" ] || die "venv python not found at $VENV_PY"

# ---------------------------------------------------------------------------
# 1. Secrets we can generate ourselves.
#
# SETUP_STATUS.md previously told the operator to invent this by hand. A
# human-chosen string is the wrong default for a value guarding an
# internet-reachable endpoint whose only other control is a shared-secret
# compare.
# ---------------------------------------------------------------------------
CRON_SHARED_SECRET="$(openssl rand -base64 32)"
note "Generated CRON_SHARED_SECRET (32 bytes, not printed)"

# ---------------------------------------------------------------------------
# 2. Gmail refresh token via interactive consent.
#
# access_type=offline + prompt=consent is what makes Google return a refresh
# token rather than only an access token. Scope is gmail.readonly and nothing
# more (§11). The token is captured into a shell variable and never touches
# the filesystem.
# ---------------------------------------------------------------------------
note "Opening the Google consent screen in your browser."
note "Sign in as the Gmail account you dedicated to statement alerts and accept the unverified-app warning."

# ---------------------------------------------------------------------------
# Run the consent flow with stdout (the JSON payload — the only place the
# token ever appears) and stderr (diagnostics / Google's real error message)
# captured separately, so both a non-zero exit AND an empty-but-successful
# result are caught explicitly instead of relying on `set -e` alone to
# propagate a failure out of a command substitution.
#
# The stderr capture uses a temp file rather than a shell variable only
# because bash has no variable-only way to capture two streams separately
# without one. The refresh token is never written there: only the final
# `print(json.dumps(...))` line in the Python block ever emits it, and that
# goes to stdout/$GMAIL_CREDS, not stderr. The redaction pass below is a
# second line of defence in case an unexpected traceback ever echoes part of
# a long credential string.
# ---------------------------------------------------------------------------
consent_stderr_file="$(mktemp)"

set +e
GMAIL_CREDS="$(
  cd "$AUTH_DIR" && "$VENV_PY" - 2>"$consent_stderr_file" <<'PY'
import json, sys
try:
    from google_auth_oauthlib.flow import InstalledAppFlow
except ImportError:
    sys.exit("google-auth-oauthlib not installed: "
             "run pip install google-auth-oauthlib inside the repo's venv")

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", SCOPES)
creds = flow.run_local_server(port=8080, access_type="offline", prompt="consent")

if not creds.refresh_token:
    sys.exit("No refresh token returned. The consent screen may already have a "
             "grant for this client: revoke it at "
             "https://myaccount.google.com/permissions and re-run.")

granted = set(creds.scopes or [])
if granted != set(SCOPES):
    sys.exit(f"Scope mismatch. Expected exactly {SCOPES}, got {sorted(granted)}.")

# Only this line reaches stdout, and it is consumed directly by the caller.
print(json.dumps({
    "refresh_token": creds.refresh_token,
    "client_id": creds.client_id,
    "client_secret": creds.client_secret,
}))
PY
)"
consent_status=$?
set -e

if [ "$consent_status" -ne 0 ]; then
  note "Gmail consent step failed (exit $consent_status). The real error, from Google or the script, is:"
  sed -e 's/[A-Za-z0-9_-]\{40,\}/<redacted>/g' "$consent_stderr_file" >&2
  rm -f "$consent_stderr_file"
  die "Aborting on the error above — diagnose that, don't just re-run. See docs/SETUP_STATUS.md."
fi
rm -f "$consent_stderr_file"

[ -n "$GMAIL_CREDS" ] || die "Gmail consent step exited 0 but printed nothing to stdout — this should not happen; treat it as a bug in scripts/setup_secrets.sh rather than re-running."

extract_gmail_field() {
  # $1: field name (refresh_token | client_id | client_secret). Reads
  # $GMAIL_CREDS via stdin (never as an argv value, so it never shows up in
  # `ps`), and fails with a message naming the field rather than a bare
  # traceback.
  local field="$1"
  "$VENV_PY" -c "
import json, sys
field = '$field'
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    sys.exit(f\"could not parse Gmail consent output as JSON while reading '{field}': {exc}\")
try:
    print(data[field])
except KeyError:
    sys.exit(f\"Gmail consent output JSON is missing the '{field}' field\")
" <<<"$GMAIL_CREDS"
}

GMAIL_REFRESH_TOKEN="$(extract_gmail_field refresh_token)"
GMAIL_CLIENT_ID="$(extract_gmail_field client_id)"
GMAIL_CLIENT_SECRET="$(extract_gmail_field client_secret)"
unset GMAIL_CREDS

note "Refresh token captured, scope verified as gmail.readonly only."

# ---------------------------------------------------------------------------
# 3. Secrets only the operator can supply. Read silently — never echoed.
#
# HEALTHCHECKS_PING_URL is REQUIRED, not optional. With Telegram gone there is
# no other out-of-band failure signal. Supabase Cron has no failure alerting
# and no heartbeat: skipped runs are not retried and a paused project silently
# stops every schedule (§7 JOB-6). A dashboard banner cannot tell you ingest
# died, because a dead pipeline gives you no reason to open the dashboard.
# healthchecks.io is external, so it still fires when Supabase itself is the
# thing that broke.
# ---------------------------------------------------------------------------
read -r -s -p "ANTHROPIC_API_KEY (input hidden): " ANTHROPIC_API_KEY; echo

# No default: this is per-project. Export HEALTHCHECKS_PING_URL before running,
# e.g. HEALTHCHECKS_PING_URL="https://hc-ping.com/<your-check-uuid>".
: "${HEALTHCHECKS_PING_URL:=}"
note "Using healthchecks ping URL ending ...${HEALTHCHECKS_PING_URL##*-}"

[ -n "$ANTHROPIC_API_KEY" ]     || die "ANTHROPIC_API_KEY is required"
[ -n "$HEALTHCHECKS_PING_URL" ] || die "HEALTHCHECKS_PING_URL is required — it is the only failure alarm left"

case "$HEALTHCHECKS_PING_URL" in
  https://hc-ping.com/*) ;;
  *) die "that does not look like a healthchecks.io ping URL" ;;
esac

# ---------------------------------------------------------------------------
# 4. Push to the Edge Function secret store.
#
# Edge Function runtime secrets go here, NOT in Vault. Vault holds only what
# Postgres itself needs — the bearer token pg_cron uses via pg_net (§12).
# ---------------------------------------------------------------------------
note "Writing secrets to the Edge Function store..."
"$SUPABASE_BIN" secrets set --project-ref "$PROJECT_REF" \
  GMAIL_REFRESH_TOKEN="$GMAIL_REFRESH_TOKEN" \
  GMAIL_CLIENT_ID="$GMAIL_CLIENT_ID" \
  GMAIL_CLIENT_SECRET="$GMAIL_CLIENT_SECRET" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  CRON_SHARED_SECRET="$CRON_SHARED_SECRET" \
  HEALTHCHECKS_PING_URL="$HEALTHCHECKS_PING_URL" \
  >/dev/null

note "Edge Function secrets set."

# ---------------------------------------------------------------------------
# 5. GitHub Actions is a separate runtime and cannot read Supabase secrets.
#    Duplication across stores is correct here, not a smell (§11).
# ---------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  note "Mirroring the subset GitHub Actions needs into repo Secrets..."
  SERVICE_ROLE_KEY="$("$SUPABASE_BIN" projects api-keys --project-ref "$PROJECT_REF" -o json \
    | "$VENV_PY" -c 'import json,sys;print(next(k["api_key"] for k in json.load(sys.stdin) if k["name"]=="service_role"))')"

  gh secret set SUPABASE_URL              --body "https://${PROJECT_REF}.supabase.co" >/dev/null
  gh secret set SUPABASE_SERVICE_ROLE_KEY --body "$SERVICE_ROLE_KEY"                  >/dev/null
  gh secret set GMAIL_REFRESH_TOKEN       --body "$GMAIL_REFRESH_TOKEN"               >/dev/null
  gh secret set GMAIL_CLIENT_ID           --body "$GMAIL_CLIENT_ID"                   >/dev/null
  gh secret set GMAIL_CLIENT_SECRET       --body "$GMAIL_CLIENT_SECRET"               >/dev/null
  gh secret set ANTHROPIC_API_KEY         --body "$ANTHROPIC_API_KEY"                 >/dev/null
  unset SERVICE_ROLE_KEY
  note "GitHub Secrets set."
  note "STATEMENT_PDF_PASSWORD is NOT set — your May-Aug statements opened with an"
  note "empty password, so JOB-2 may not need it. Set it by hand if a future"
  note "statement is genuinely password-protected."
else
  note "gh not found — skipping GitHub Secrets. Set them manually per README."
fi

unset GMAIL_REFRESH_TOKEN GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET \
      ANTHROPIC_API_KEY CRON_SHARED_SECRET

cat <<'EOF'

Done. Next:

  1. Verify the token works and the scope is correct:
       .venv/bin/python scripts/verify_token.py

  2. DELETE ~/cardledger-auth once verify_token.py passes. That directory's
     client_secret.json plus a live grant is enough to mint new tokens against
     the whole mailbox.

  3. Re-run verify_token.py on day 8. If it fails, the OAuth consent screen was
     never actually published to "In production" and every scheduled job will
     die weekly (§7). This is the single most likely silent failure in the
     system.

Function deploy and cron wiring are handled separately — ask Claude to run them.
EOF
