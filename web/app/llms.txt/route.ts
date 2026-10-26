import { buildLlmsTxt } from "@/lib/docs";
import { loadAllDocs, originFrom } from "@/lib/docs-server";

// https://llmstxt.org index, generated from web/content/docs/*.md at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  const origin = originFrom(req.headers);
  return new Response(buildLlmsTxt(origin, loadAllDocs(origin)), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
