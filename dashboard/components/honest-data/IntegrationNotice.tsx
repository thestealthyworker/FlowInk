import type { ReactNode } from "react";

// WP3 degraded-state notices (design/optional-integrations.md). Reuses
// SilentSourceBanner.tsx's visual language on purpose — same persistent
// status-strip shape, same triangle glyph for anything serious enough to
// warrant one, same "weight and structure carry the distinction, never
// colour alone" rule this app's honest-data component family already
// commits to (app/styles/honest-data.css's own header comment). This file
// generalises that one banner into three tones so every optional
// integration's absence gets a consistent, honest rendering instead of
// each page inventing its own.
//
// These notices are deliberately NOT dismissable — an app that lets the
// operator permanently silence "your spend totals are incomplete" is
// worse than one that keeps saying so, per the task's own framing: an app
// that looks fine while under-reporting spend is worse than one that
// admits the gap.

export type IntegrationNoticeTone = "serious" | "notice" | "calm";

export function IntegrationNotice({ tone, children }: { tone: IntegrationNoticeTone; children: ReactNode }) {
  return (
    <div className={`integration-notice integration-notice--${tone}`} role="status">
      <NoticeIcon tone={tone} />
      <div className="integration-notice__body">{children}</div>
    </div>
  );
}

function NoticeIcon({ tone }: { tone: IntegrationNoticeTone }) {
  if (tone === "calm") {
    // A plain info circle, muted — this state is expected, not a warning.
    return (
      <svg className="integration-notice__icon" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--color-ink-muted)" strokeWidth="1.3" />
        <path d="M8 7v4.2M8 4.8v.1" stroke="var(--color-ink-muted)" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  // Same triangle glyph as SilentSourceBanner.tsx, tone-coloured — a real
  // gap (serious) reads the same way this app already renders one.
  const color = tone === "serious" ? "var(--color-serious)" : "var(--color-warning)";
  return (
    <svg className="integration-notice__icon" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.5v3.2M8 11.8v.1" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Gmail absent: the primary "only Supabase is configured" case. `context`
 * changes only which page's role the copy explains — the underlying fact
 * (automatic ingestion is off, spend totals may be incomplete) is stated
 * either way, per the task's honesty requirement.
 */
export function GmailNotConfiguredNotice({ context }: { context: "home" | "manual-entry" }) {
  return (
    <IntegrationNotice tone="notice">
      {context === "manual-entry" ? (
        <p>
          <strong>Automatic ingestion isn&rsquo;t set up yet.</strong> Record transactions here until it is — right now
          this is your primary way to track spend, not just the cash/bank-transfer fallback it&rsquo;s built for.
        </p>
      ) : (
        <p>
          <strong>Automatic ingestion isn&rsquo;t set up yet.</strong> Card alerts aren&rsquo;t being read, so the
          totals below reflect only what&rsquo;s been entered manually — actual spend is likely higher.{" "}
          <a href="/transactions/new">Add a transaction</a> to keep the ledger current until Gmail is connected.
        </p>
      )}
    </IntegrationNotice>
  );
}

/** healthchecks.io absent: a real, not cosmetic, degradation — losing the
 * only out-of-band "is anything still running" signal. Copy matches
 * design/optional-integrations.md verbatim. */
export function HealthchecksNotConfiguredNotice() {
  return (
    <IntegrationNotice tone="serious">
      <p>
        <strong>No external monitoring configured.</strong> If ingestion silently stops, nothing will tell you.
      </p>
    </IntegrationNotice>
  );
}

/** Statement ingestion absent: a calm, expected state when live alert
 * ingestion is running but nothing independently corroborates it — not an
 * error, but still stated plainly rather than left for the operator to
 * infer from every transaction quietly staying provisional. */
export function StatementIngestionCalmNotice() {
  return (
    <IntegrationNotice tone="calm">
      <p>
        Statement reconciliation isn&rsquo;t set up. Transactions from card alerts stay <em>provisional</em> here —
        nothing independently confirms them against a statement. That&rsquo;s expected in this configuration, not an
        error.
      </p>
    </IntegrationNotice>
  );
}
