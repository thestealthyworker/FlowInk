// Gmail readonly client. Auth flow per docs/cardledger-build-spec.md §7:
// refresh token lives in the Edge Function's own secret store
// (`supabase secrets set`, NOT Vault — Vault is for values Postgres needs).
// Each invocation exchanges it for a 1-hour access token held in memory only.

export interface GmailMessage {
  id: string;
  internalDate: number; // epoch ms
  labelIds: string[];
  subject: string;
  /** Raw `From` header, e.g. `UOB <unialerts@uobgroup.com>`. */
  from: string;
  bodyText: string;
}

export async function getAccessToken(): Promise<string> {
  const refreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN");
  const clientId = Deno.env.get("GMAIL_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET");
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("GMAIL_REFRESH_TOKEN / GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token as string;
}

// Maps Gmail label *names* (e.g. "Payments/UOB") to their label IDs.
// Message list/get responses only carry label IDs, so this lookup is
// needed once per invocation to route by label per §7: "Route by label,
// not by parsing the issuer from the body."
export async function getLabelNameToId(accessToken: string): Promise<Record<string, string>> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail labels.list failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const map: Record<string, string> = {};
  for (const label of json.labels ?? []) {
    map[label.name] = label.id;
  }
  return map;
}

export interface ListPageOptions {
  /** Results per page. Gmail's maximum is 500. */
  pageSize?: number;
  /** Hard cap on pages fetched, so a huge backlog can't blow the wall-clock budget. */
  maxPages?: number;
  /** Hard cap on time spent listing, for the same reason. */
  deadlineMs?: number;
}

export interface ListPageResult {
  /** Message ids in Gmail's order: NEWEST first. The tail is the oldest. */
  ids: string[];
  /**
   * True when the cap was hit before Gmail ran out of pages — i.e. there
   * are older matching messages we have NOT seen. The caller must not
   * advance the watermark in this case: doing so would skip them
   * permanently, since `after:` only ever moves forward.
   */
  truncated: boolean;
  pagesFetched: number;
}

/**
 * Lists every message id matching `query`, paging with `pageToken`.
 *
 * Gmail's messages.list returns NEWEST first and offers no ascending
 * option. Requesting a single page of N and processing "the oldest of
 * those N" therefore skips everything older than the page — with a
 * 50-message backlog and a 30-id page you would process M21..M40, advance
 * the watermark past M40, and lose M1..M20 from every future `after:`
 * query. They would never be inserted, never land in parse_failures, and
 * never be surfaced. Paging to the end of the result set is what makes
 * §7's "Backfillable: move the watermark back and re-run" actually true.
 */
export async function listMessageIdsPaged(
  accessToken: string,
  query: string,
  options: ListPageOptions = {},
): Promise<ListPageResult> {
  const pageSize = Math.min(options.pageSize ?? 500, 500);
  const maxPages = options.maxPages ?? 10;
  const deadlineMs = options.deadlineMs ?? 60_000;
  const startedAt = Date.now();

  const ids: string[] = [];
  let pageToken: string | undefined;
  let pagesFetched = 0;

  while (true) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Gmail messages.list failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    pagesFetched++;

    for (const m of json.messages ?? []) ids.push((m as { id: string }).id);

    pageToken = json.nextPageToken as string | undefined;
    if (!pageToken) return { ids, truncated: false, pagesFetched };
    if (pagesFetched >= maxPages || Date.now() - startedAt >= deadlineMs) {
      return { ids, truncated: true, pagesFetched };
    }
  }
}

/**
 * Extracts the lowercased domain from a `From` header value.
 * Returns null if the header has no parseable address.
 *
 * Deliberately returns the whole domain for EXACT comparison by the
 * caller. Substring matching is not safe here: the domain in
 * `unialerts@uobgroup.com.attacker.io` contains "uobgroup.com", and the
 * attacker's own domain passes DMARC for their own mail.
 */
export function senderDomain(fromHeader: string): string | null {
  const angle = /<([^>]*)>/.exec(fromHeader);
  const address = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).replace(/[>\s]+$/, "");
  return /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

function base64UrlDecode(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new TextDecoder("utf-8").decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function extractParts(payload: GmailPart | undefined): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain" && !text) text = base64UrlDecode(data);
    if (data && part.mimeType === "text/html" && !html) html = base64UrlDecode(data);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return { text, html };
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail messages.get failed: ${res.status} ${await res.text()}`);
  const json = await res.json();

  const headers: { name: string; value: string }[] = json.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

  const { text, html } = extractParts(json.payload);
  const bodyText = text ?? (html ? stripHtml(html) : json.snippet ?? "");

  return {
    id: json.id,
    internalDate: Number(json.internalDate),
    labelIds: json.labelIds ?? [],
    subject: header("subject"),
    from: header("from"),
    bodyText,
  };
}
