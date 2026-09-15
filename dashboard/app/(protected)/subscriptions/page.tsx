import Link from "next/link";
import { formatMoney } from "@/components/honest-data/MoneyFigure";
import { PeriodPicker } from "@/components/subscriptions/PeriodPicker";
import { ConfirmSubmitButton } from "@/components/ui/ConfirmSubmitButton";
import { deleteSpendSmoothingAction, saveSpendSmoothingAction } from "@/lib/actions/smoothing";
import {
  buildSmoothedScheduleRows,
  getSmoothableTransaction,
  getSpendSmoothingForTransaction,
  listSpendSmoothing,
  type SmoothedScheduleStatus,
} from "@/lib/data/smoothing";
import { calendarMonthLabel, currentCalendarMonth } from "@/lib/date";
import { createClient } from "@/lib/supabase/server";

const STATUS_LABEL: Record<SmoothedScheduleStatus, string> = {
  active: "Active",
  ending_soon: "Ending soon",
  ended: "Ended",
};

const STATUS_FILTERS: Array<{ value: SmoothedScheduleStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "ending_soon", label: "Ending soon" },
  { value: "ended", label: "Ended" },
];

function buildHref(status: string): string {
  return status === "all" ? "/subscriptions" : `/subscriptions?status=${status}`;
}

// One page, reached from the Ledger's per-row icon (?transaction=<id>,
// unflagged opens this blank, already-flagged opens it pre-filled for
// editing) and from the Add menu directly (no transaction param — just
// the filterable list). Deliberately not a table or a /cards-style tile
// grid: a subscription doesn't carry enough at-a-glance detail to earn a
// heavy card, so it's a compact row list with the same rhythm as the
// Ledger. A malformed ?transaction= value reads as "not found"
// (lib/data/smoothing.ts's isTransactionId), never a query error.
export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ transaction?: string; status?: string }>;
}) {
  const { transaction: transactionId, status: statusParam } = await searchParams;
  const supabase = await createClient();
  const referenceMonth = currentCalendarMonth();

  const [allSchedules, txn, existingSchedule] = await Promise.all([
    listSpendSmoothing(supabase),
    transactionId ? getSmoothableTransaction(supabase, transactionId) : Promise.resolve(null),
    transactionId ? getSpendSmoothingForTransaction(supabase, transactionId) : Promise.resolve(null),
  ]);
  const schedules = buildSmoothedScheduleRows(allSchedules, referenceMonth);

  const activeStatus: SmoothedScheduleStatus | "all" =
    statusParam === "active" || statusParam === "ending_soon" || statusParam === "ended" ? statusParam : "all";
  const filteredSchedules = activeStatus === "all" ? schedules : schedules.filter((s) => s.status === activeStatus);
  const counts = {
    all: schedules.length,
    active: schedules.filter((s) => s.status === "active").length,
    ending_soon: schedules.filter((s) => s.status === "ending_soon").length,
    ended: schedules.filter((s) => s.status === "ended").length,
  };

  return (
    <div className="subscriptions-page">
      <header className="page-header">
        <p className="page-header__eyebrow">Add</p>
        <h1>Subscriptions</h1>
        <p>
          Every lump-sum payment you&rsquo;ve flagged, smoothed across months for reporting. The real transaction is
          never touched.
        </p>
      </header>

      {transactionId && (
        <section aria-labelledby="split-form-heading" className="page-section subscriptions-txn-context">
          <h2 id="split-form-heading" style={{ margin: "0 0 var(--space-3)", fontSize: "var(--text-sm)", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--color-ink-muted)" }}>
            {existingSchedule ? "Edit smoothing period" : "Set smoothing period"}
          </h2>

          {!txn ? (
            <p>
              Transaction not found. Find the charge you want to split in the <Link href="/#ledger">Ledger</Link> and
              click its icon.
            </p>
          ) : txn.currency !== "SGD" ? (
            <p>
              This transaction is in {txn.currency}, not SGD — it&rsquo;s still uncosted pending FX reconciliation, so
              it can&rsquo;t be smoothed yet.
            </p>
          ) : (
            <>
              <p style={{ margin: "0 0 var(--space-4)" }}>
                <span className="money-figure" style={{ fontSize: "1.2rem" }}>
                  {formatMoney(Number(txn.amount), txn.currency)}
                </span>{" "}
                — {txn.merchant_raw}, {txn.txn_date}
              </p>
              <form action={saveSpendSmoothingAction} className="entry-form entry-form--grid">
                <input type="hidden" name="transaction_id" value={txn.id} />

                <label htmlFor="label">Label</label>
                <input
                  id="label"
                  name="label"
                  type="text"
                  required
                  defaultValue={existingSchedule?.label ?? txn.merchant_raw}
                  className="entry-form__full"
                />

                <PeriodPicker defaultMonths={existingSchedule?.months} />

                <label htmlFor="start_month">Start month</label>
                <input id="start_month" name="start_month" type="month" required defaultValue={existingSchedule?.start_month ?? txn.calendar_month} />

                <label className="entry-form__checkbox entry-form__full">
                  <input type="checkbox" name="is_subscription" defaultChecked={existingSchedule?.is_subscription ?? true} />
                  This is a subscription — track it and call out when it&rsquo;s ending
                </label>

                <button type="submit" className="entry-form__submit entry-form__full">
                  Save split
                </button>
              </form>

              {existingSchedule && (
                <form action={deleteSpendSmoothingAction} style={{ marginTop: "var(--space-3)" }}>
                  <input type="hidden" name="id" value={existingSchedule.id} />
                  <ConfirmSubmitButton label="Remove this split" confirmLabel="Confirm remove?" />
                </form>
              )}
            </>
          )}
        </section>
      )}

      <section aria-labelledby="all-subs-heading" className="page-section">
        <h2 id="all-subs-heading">All subscriptions</h2>
        <div className="li-ledger-controls" style={{ margin: "var(--space-3) 0 var(--space-4)" }}>
          {STATUS_FILTERS.map((f) => (
            <Link key={f.value} href={buildHref(f.value)} className={`li-chip${activeStatus === f.value ? " active" : ""}`}>
              {f.label} ({counts[f.value]})
            </Link>
          ))}
        </div>

        {filteredSchedules.length === 0 ? (
          <div className="empty-state">
            <p>
              {schedules.length === 0
                ? "Nothing smoothed yet. Find a subscription or lump-sum bill in the Ledger and click its icon."
                : "Nothing matches this filter."}
            </p>
          </div>
        ) : (
          filteredSchedules.map((s) => (
            <div key={s.id} className="sub-row">
              {/* Two named groups instead of five flat siblings: at
                  >=640px both are `display: contents` (see
                  subscriptions.css), so desktop's original five-column
                  grid sees the same leaves it always did. Below 640px
                  they become the row's two real stacked lines. */}
              <div className="sub-row__primary">
                <span className="sub-row__name">
                  <Link href={`/subscriptions?transaction=${s.transactionId}`}>{s.label}</Link>
                  {!s.isSubscription && <span className="sub-row__tag">One-off</span>}
                </span>
                <span className="money-figure">{formatMoney(s.monthlyAmount, s.currency)}/mo</span>
              </div>
              <div className="sub-row__secondary">
                <span className="sub-row__meta">
                  {calendarMonthLabel(s.startMonth)} → {calendarMonthLabel(s.endMonth)}
                </span>
                <span className="subscription-status" data-status={s.status}>
                  {STATUS_LABEL[s.status]}
                  {s.status !== "ended" && s.monthsRemaining <= 1 && ` · ${s.monthsRemaining === 0 ? "this month" : "next month"}`}
                </span>
              </div>
              <form action={deleteSpendSmoothingAction} className="sub-row__remove">
                <input type="hidden" name="id" value={s.id} />
                <ConfirmSubmitButton label="×" confirmLabel="×" className="sub-remove-btn" ariaLabel={`Remove ${s.label} from smoothing`} />
              </form>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
