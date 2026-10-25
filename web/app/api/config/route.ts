import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";

// Public deployment config (no secrets: loadConfig() keeps public keys only), re-read from
// ../deployments at request time. The client polls this so a strategy file written while the
// app is running (e.g. a second Lotus pool) shows up without a rebuild or a reload.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(loadConfig(), { headers: { "Cache-Control": "no-store" } });
}
