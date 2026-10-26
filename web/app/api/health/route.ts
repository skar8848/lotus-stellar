import { NextResponse } from "next/server";
import pkg from "../../../package.json";
import { loadConfig } from "@/lib/config";
import { checkHealth, type Health } from "@/lib/health";

// Machine-readable deployment check for agents and monitors (shape documented in content/docs/integrate.md and
// /llms.txt). 200 for "ok" / "degraded", 503 for "down" (RPC or Horizon unreachable). Cached ~15 s per server
// instance so a polling agent cannot turn it into load on the public RPC.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TTL_MS = 15_000;
const g = globalThis as unknown as { __lotusHealth?: { at: number; value: Promise<Health> } };

export async function GET() {
  const now = Date.now();
  if (!g.__lotusHealth || now - g.__lotusHealth.at > TTL_MS) {
    const app = {
      name: "lotus-web",
      version: pkg.version,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null,
      env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    };
    g.__lotusHealth = { at: now, value: checkHealth(loadConfig(), app) };
  }
  let health: Health;
  try {
    health = await g.__lotusHealth.value;
  } catch (e) {
    g.__lotusHealth = undefined;
    return NextResponse.json({ status: "down", error: e instanceof Error ? e.message : String(e) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(health, { status: health.status === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
