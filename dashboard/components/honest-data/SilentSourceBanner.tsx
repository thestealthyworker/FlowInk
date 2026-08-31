// Silent-source state (§4, §7 item 4): a persistent status strip for "no
// alerts from this method in >72h", the same check `heartbeat` already
// runs externally (supabase/functions/_shared/healthchecks.ts). Built as
// a reusable primitive in Phase D1 per the plan's own component list; NOT
// wired into any page yet because the read it needs — a per-method
// last-seen timestamp — doesn't exist in lib/data/* until Phase D5's
// ingest-health addition. Rendering ahead of the data existing would mean
// fabricating the very silence this component exists to report honestly.
export function SilentSourceBanner({
  methodDisplayName,
  hoursSinceLastAlert,
  sinceDate,
}: {
  methodDisplayName: string;
  hoursSinceLastAlert: number;
  sinceDate: string;
}) {
  const days = Math.floor(hoursSinceLastAlert / 24);

  return (
    <div className="silent-source-banner" role="status">
      <svg
        className="silent-source-banner__icon"
        width="18"
        height="18"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M8 1.5 15 14H1L8 1.5Z"
          fill="none"
          stroke="var(--color-serious)"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M8 6.5v3.2M8 11.8v.1" stroke="var(--color-serious)" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <p>
        No {methodDisplayName} alerts in {days} day{days === 1 ? "" : "s"} — spend since {sinceDate} may be missing.
      </p>
    </div>
  );
}
