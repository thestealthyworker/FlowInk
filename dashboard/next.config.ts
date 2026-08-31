import type { NextConfig } from "next";

// This dashboard sits at a public, guessable URL in front of a complete
// personal financial ledger (docs/cardledger-build-spec.md §10 "The
// security question this raises"). RLS is the real control; these headers
// are the belt on top of it, keeping the app out of search indexes and
// off crawlers entirely rather than relying on obscurity.
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, noarchive, nosnippet",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
