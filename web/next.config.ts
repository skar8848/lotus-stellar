import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a second dev server (e.g. the :3200 test server) run next to another
  // `next dev` in this folder: Next takes an exclusive lock on <distDir>/lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The app reads ../deployments/*.json at request time (see lib/config.ts), so we keep the
  // classic dynamic-rendering model rather than cache components.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
