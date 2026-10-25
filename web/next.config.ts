import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /app reads ../deployments/*.json at request time (see lib/config.ts), so we keep the
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
