import type { Metadata } from "next";
import { JetBrains_Mono, Petrona, Public_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// "Ledger & Ink" design system (redesign/visuals): Public Sans carries every
// heading, label, and body copy; JetBrains Mono carries every money figure
// and date, nothing else — tabular figures are the "audited ledger" signal.
// Petrona (italic serif) is new: reserved exclusively for the narrative
// "aside" voice (Command Center KPI commentary, budget call-outs) — never
// UI chrome, labels, or numbers. next/font self-hosts all three at build
// time — no runtime request to Google, so the CSP's "no third-party
// script" posture needs no special case.
const publicSans = Public_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-public-sans",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

const petrona = Petrona({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["italic", "normal"],
  display: "swap",
  variable: "--font-petrona",
});

// Belt-and-suspenders with next.config.ts's X-Robots-Tag header and
// public/robots.txt (§10): this is a per-page <meta name="robots"> tag,
// the header is a response header, robots.txt is the crawl-time
// disallow. Three independent mechanisms, none of which is the real
// security control — RLS (Task 1) is.
export const metadata: Metadata = {
  title: "FlowInk",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

// Runs before hydration to set data-theme from a stored preference,
// avoiding a flash of the wrong theme. Absence of the attribute means
// "system" — prefers-color-scheme decides, per app/styles/tokens.css.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("flowink-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script below sets data-theme
    // from localStorage before hydration runs, deliberately diverging from
    // the server-rendered markup (which knows nothing of the visitor's
    // stored preference) — the same documented escape hatch used for any
    // client-only theme toggle. Scoped to this one attribute on <html>,
    // not a blanket suppression.
    <html
      lang="en"
      className={`${publicSans.variable} ${jetbrainsMono.variable} ${petrona.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* eslint-disable-next-line react/no-danger */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
