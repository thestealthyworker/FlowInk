# Parser fixtures

Synthetic alert-email samples matching the real issuer formats documented in
docs/cardledger-build-spec.md §4, reconstructed as
`<subject/from/internaldate header block>\n\n<body>` text files, each paired
with an `*.expected.json` of the correct parser output. Merchants, amounts
and dates are invented; the header/body structure and formatting quirks of
each issuer are preserved exactly, since that shape is what the parser is
tested against.

- `hsbc_2026-07-12` — HTML table format, `HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`
- `uob_2026-06-18` — free-text sentence + legal disclaimer, `unialerts@uobgroup.com`. Foreign currency (USD) — never converted.
- `paylah_2026-09-15` — no-year date, merchant string with a line-wrap artefact, `paylah.alert@dbs.com`

Citi Cash Back has no fixture yet — the card isn't issued (§4, §12 item Citi
card issuance). Add one from a real sample the day it arrives.

Run `pytest tests/` — the merchant/period logic tests run everywhere; the
parser test (`test_parser.py`) additionally hits the real Anthropic API and
needs `ANTHROPIC_API_KEY` set, else it skips.

Add a new fixture pair whenever a bank changes its email format, or
whenever a `parse_failures` row gets fixed — turn the failure into a
regression case (§8).
