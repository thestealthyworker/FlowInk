import { type NextRequest } from "next/server";
import { updateSession } from "./lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every path except static assets and Next internals.
     * robots.txt is intentionally excluded too: it must be reachable
     * without a session so crawlers actually see the disallow-all rule
     * instead of a redirect loop to /login. icon.svg and apple-icon.png
     * are the app-router icon convention's generated routes (favicon.ico
     * has no file here, but the exclusion is kept in case one is added
     * later) — a browser or OS favicon cache must be able to fetch them
     * without a session, or it gets an HTML /login redirect instead of
     * image bytes and silently shows no icon at all.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|robots.txt).*)",
  ],
};
