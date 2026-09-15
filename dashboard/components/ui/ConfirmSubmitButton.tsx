"use client";

import { useState } from "react";

// A destructive-action pattern used by every delete form in the app
// (budgets, manual transactions, smoothing schedules) — "designed active
// states," not a bare button. First click arms the button and swaps its
// label; the button only becomes a real submit once armed, so a second,
// deliberate click is required to actually delete anything. Blurring
// disarms it, so a stray click elsewhere can't leave a row one accidental
// tap away from deletion. `className` adds a variant on top of the shared
// .confirm-btn (e.g. the subscriptions list's icon-only ×), and
// `ariaLabel` names an icon-only button for assistive tech.
export function ConfirmSubmitButton({
  label,
  confirmLabel,
  className,
  ariaLabel,
}: {
  label: string;
  confirmLabel: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);

  return (
    <button
      type={armed ? "submit" : "button"}
      className={className ? `confirm-btn ${className}` : "confirm-btn"}
      aria-label={ariaLabel}
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
