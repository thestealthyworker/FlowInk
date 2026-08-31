"use client";

import { useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "flowink-theme";
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeChoice, string> = { system: "Auto", light: "Light", dark: "Dark" };

// Manual override sitting alongside prefers-color-scheme (Phase D0
// acceptance: "prefers-color-scheme and a manual data-theme toggle both
// work"). Cycles system -> light -> dark -> system; the root layout's
// inline script applies the stored choice before hydration so there is
// no flash of the wrong theme.
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>("system");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    if (next === "system") {
      document.documentElement.removeAttribute("data-theme");
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      document.documentElement.setAttribute("data-theme", next);
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }

  return (
    <button type="button" className="theme-toggle" onClick={cycle} aria-label={`Theme: ${LABEL[theme]}. Activate to change.`}>
      <span aria-hidden="true">{theme === "dark" ? "◐" : theme === "light" ? "☀" : "◑"}</span>
      <span>{LABEL[theme]}</span>
    </button>
  );
}
