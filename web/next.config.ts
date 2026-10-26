import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a second dev server (e.g. the :3200 test server) run next to another
  // `next dev` in this folder: Next takes an exclusive lock on <distDir>/lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // hosted builds copy the public deployment files into ./deployments (scripts/copy-deployments.mjs)
  // + the docs Markdown (web/content/docs), read with fs at request time by lib/docs-server.ts
  outputFileTracingIncludes: { "/**": ["./deployments/*.json", "./content/docs/*.md"] },
  // /docs/<slug>.md serves the raw Markdown of a docs page (for LLMs and agents); the page itself is /docs/<slug>.
  async rewrites() {
    return { beforeFiles: [{ source: "/docs/:slug([a-z0-9-]+)\\.md", destination: "/api/docs/:slug" }], afterFiles: [], fallback: [] };
  },
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
