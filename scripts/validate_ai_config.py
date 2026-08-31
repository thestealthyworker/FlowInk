#!/usr/bin/env python3
"""WP7: validate (and, unless --dry-run, submit) an AI-emitted onboarding
config against the five-stage checker in scripts/lib/rules_validator.py.

This is the one entrypoint docs/onboarding-spec.md tells an AI-assisted
setup agent to run — it is never told to write SQL or call
submit_method_rule() itself. See that spec for the full JSON shape this
expects, and rules_validator.py's module docstring for why each of the
five stages exists and runs in the order it does.

Usage:

    export SUPABASE_URL=https://xxxx.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=...          # service_role — see
                                                    # 0018_config_review.sql's
                                                    # header for why this
                                                    # key can never make a
                                                    # rule land 'active'
    python3 scripts/validate_ai_config.py path/to/config.json

    # Validate only — every check runs, but nothing is written:
    python3 scripts/validate_ai_config.py --dry-run path/to/config.json

Exit code is 0 only if every payment_method-level check passed and at
least one rule was accepted (or there were zero rules to begin with —
a payment-methods-only submission is a legitimate run). A run with any
rejected rule still exits 0 if at least one rule succeeded and no
payment_method-level reject fired: partial success is reported in full,
not treated as a hard failure, so an agent driving this from a terminal
can read the report and go fix the specific rejected rules rather than
having the whole batch treated as a crash. Exit code is 1 if every rule
was rejected, or any payment_method itself failed validation.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lib.rules_validator import SupabaseRulesClient, format_report, run_validator  # noqa: E402
from lib.supabase_rest import SupabaseREST  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("config_path", type=Path, help="Path to the AI-emitted config JSON (docs/onboarding-spec.md §3).")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Run all five stages but never call submit_method_rule()/preview_method_rule() or write "
             "payment_methods — reports what WOULD happen. Stages 4b/5 (the real DB round trip) are "
             "reported as not run, since they need a live database to mean anything.",
    )
    args = parser.parse_args(argv)

    try:
        config = json.loads(args.config_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: could not read/parse {args.config_path}: {exc}", file=sys.stderr)
        return 2

    client = SupabaseRulesClient(SupabaseREST())
    report = run_validator(config, client, submit=not args.dry_run)

    print(format_report(report))

    if not report.ok():
        return 1
    if report.rule_outcomes and not report.accepted_rules:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
