import { buildLlmsFull } from "@/lib/docs";
import { loadAllDocs, originFrom } from "@/lib/docs-server";

// Every docs page concatenated (raw Markdown, placeholders filled from the live config).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = originFrom(req.headers);
  return new Response(buildLlmsFull(origin, loadAllDocs(origin)), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
