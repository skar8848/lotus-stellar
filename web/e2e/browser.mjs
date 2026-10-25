// Launch headless Chromium with Playwright. The playwright package may expect a browser build
// that is not in the local cache (~/Library/Caches/ms-playwright); fall back to the newest cached one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

function findCachedChromium() {
  const root = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const base = path.join(root, d, "chrome-mac-arm64");
    try {
      const app = fs.readdirSync(base).find((f) => f.endsWith(".app"));
      if (!app) continue;
      const bin = path.join(base, app, "Contents", "MacOS", app.replace(/\.app$/, ""));
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function launch(opts = {}) {
  let exe = chromium.executablePath();
  if (!fs.existsSync(exe)) exe = findCachedChromium() ?? exe;
  return chromium.launch({ headless: true, executablePath: exe, ...opts });
}

export const BASE_URL = process.env.BASE_URL || "http://localhost:3200";
