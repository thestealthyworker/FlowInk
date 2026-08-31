"use client";

import { useState } from "react";

// A destructive-action pattern used by every delete form in the app
// (budgets, manual transactions) — "designed active states," not a bare
// button (docs/DASHBOARD_PLAN.md §6 D2 acceptance). First click arms the
// button and swaps its label; the button only becomes a real submit once
// armed, so a second, deliberate click is required to actually delete
// anything. Blurring disarms it, so a stray click elsewhere can't leave a
// row one accidental tap away from deletion.
export function ConfirmSubmitButton({
  label,
  confirmLabel,
}: {
  label: string;
  confirmLabel: string;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <button
      type={armed ? "submit" : "button"}
      className="confirm-btn"
      data-armed={armed || undefined}
      onClick={(event) => {
        if (!armed) {
          event.preventDefault();
          setArmed(true);
        }
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
