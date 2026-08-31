// Merchant normalisation and lookup. Per docs/cardledger-build-spec.md §4
// parser trap 5: raw merchant strings carry line-wrap artefacts and
// corporate-suffix noise ("N.N.HARBOURLIGHT BISTRO PTE. LT D.").
// Normalise before matching: collapse whitespace, strip punctuation and
// corporate suffixes, uppercase. Match on the normalised form.

const CORPORATE_SUFFIXES = [
  "PTE LTD",
  "PTE. LTD",
  "PTE",
  "LTD",
  "LLC",
  "GMBH",
  "INC",
  "CO",
  "LT D", // observed line-wrap artefact from the PayLah sample
];

/**
 * Minimum alphanumeric characters a normalised merchant string must have
 * before it may be used as a `merchants.match_pattern`.
 *
 * Normalisation strips every non-alphanumeric character, so a
 * punctuation-only merchant string ("...", "&", "--") normalises to "".
 * An empty (or one/two-character) pattern is a catch-all: it matches
 * every merchant string, so that row would silently become the default
 * classification — and its `is_transfer` flag would remove every
 * unmatched transaction from spend totals. Reject rather than store.
 */
export const MIN_MATCH_PATTERN_LENGTH = 3;

/**
 * Minimum length of a whitespace-delimited, all-digit token before it is
 * treated as a per-transaction reference number (bus/MRT ride id, POS
 * terminal serial, ZIP code) rather than part of the merchant's name, and
 * stripped. Real historical backfill data: "BUS/MRT 833948420 SINGAPORE"
 * is a different string on every ride (9-digit ride id) — 34 rides in the
 * backfill dataset normalised to 34 distinct merchants before this rule,
 * 1 after. Threshold is 4, not lower, specifically so short numeric
 * *name* components survive: "HH @ 602 TAMPINES" (3 digits) and
 * "7-ELEVEN" (1 digit) must not be mangled into a useless pattern — see
 * merchant_test.ts for both as regression cases.
 */
const MIN_STRIPPED_DIGIT_RUN_LENGTH = 4;

/**
 * Known merchant-name truncation artefacts caused by a fixed-width source
 * field cutting a name off mid-word. Not a general de-truncation engine —
 * that would risk merging genuinely different merchants that happen to
 * share a prefix (e.g. a truncated "CAT" must never absorb "CATERING").
 * Each entry here is a specific, verified pair: HSBC's statement export
 * truncates "SHENG SIONG SUPERMARKET" to "SHENG SIONG SUPERMARKE" (missing
 * the final "T"; confirmed against 17 HSBC-sourced rows in the backfill
 * dataset, all with the identical truncated spelling), while UOB's export
 * of the same merchant is untruncated (9 rows). Left unfixed, the same
 * grocery store split into two merchants (17 + 9 = 26 transactions) across
 * two buckets. Applied to the whitespace-delimited prefix, after digit-run
 * and trailing-locale stripping, before corporate-suffix stripping.
 */
const KNOWN_TRUNCATIONS: Record<string, string> = {
  "SHENG SIONG SUPERMARKE": "SHENG SIONG SUPERMARKET",
};

function stripDigitRunTokens(s: string): string {
  return s
    .split(" ")
    .filter((tok) => !(/^[0-9]+$/.test(tok) && tok.length >= MIN_STRIPPED_DIGIT_RUN_LENGTH))
    .join(" ");
}

function stripTrailingLocaleCode(s: string): string {
  // Statement exports append a trailing "SG" (ISO country code) after
  // "SINGAPORE" as a separate locale field, not part of the merchant's
  // name (observed on ~50 distinct HSBC/UOB merchant strings in the
  // backfill dataset, always immediately after "SINGAPORE"). Scoped to
  // that exact two-token tail so a merchant whose own name happens to end
  // in "SG" without a preceding "SINGAPORE" token is left alone.
  const tokens = s.split(" ");
  const n = tokens.length;
  if (n >= 2 && tokens[n - 1] === "SG" && tokens[n - 2] === "SINGAPORE") {
    return tokens.slice(0, n - 1).join(" ");
  }
  return s;
}

function canonicalizeKnownTruncations(s: string): string {
  for (const [truncated, full] of Object.entries(KNOWN_TRUNCATIONS)) {
    if (s === truncated) return full;
    if (s.startsWith(truncated + " ")) return full + s.slice(truncated.length);
  }
  return s;
}

export function normalizeMerchant(raw: string): string {
  let s = raw.toUpperCase();
  s = s.replace(/[^A-Z0-9\s]/g, " "); // strip punctuation
  s = s.replace(/\s+/g, " ").trim();
  s = stripDigitRunTokens(s);
  s = stripTrailingLocaleCode(s);
  s = canonicalizeKnownTruncations(s);
  // Loop to a fixed point: stacked suffixes (e.g. "...PTE LT D" once the
  // line-wrap artefact "LT\nD" is folded back into "LT D") need more than
  // one pass, or the outer suffix ("PTE") is left behind.
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of CORPORATE_SUFFIXES) {
      const re = new RegExp(`\\s${suffix}$`);
      const next = s.replace(re, "");
      if (next !== s) {
        s = next;
        stripped = true;
        break;
      }
    }
  }
  return s.trim();
}

/** True if a normalised string is specific enough to be a match pattern. */
export function isUsableMatchPattern(normalized: string): boolean {
  return normalized.replace(/\s/g, "").length >= MIN_MATCH_PATTERN_LENGTH;
}

export interface MerchantRow {
  id: number;
  match_pattern: string;
  display_name: string;
  category: string;
  hsbc_eligible: boolean | null;
  is_transfer: boolean;
  confidence: string;
}

/**
 * Word-boundary match against the in-memory merchant list, longest
 * pattern first.
 *
 * Both sides are already normalised to `[A-Z0-9 ]` with single spaces,
 * so padding with spaces gives an exact whole-token-sequence match:
 * "TIKTOK SHOP" matches "TIKTOK SHOP SELLER" but "CAT" does not match
 * "CATERING". A bare `includes()` matched mid-token, which combined with
 * an empty pattern matched literally everything.
 *
 * Patterns that fail `isUsableMatchPattern` are ignored defensively, so
 * any catch-all row already written to the table cannot classify anything.
 */
export function findMerchant(merchants: MerchantRow[], normalizedRaw: string): MerchantRow | null {
  const haystack = ` ${normalizedRaw} `;
  const candidates = merchants
    .filter((m) => isUsableMatchPattern(m.match_pattern) && haystack.includes(` ${m.match_pattern} `))
    .sort((a, b) => b.match_pattern.length - a.match_pattern.length);
  return candidates[0] ?? null;
}
