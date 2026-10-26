import { loadDoc, originFrom } from "@/lib/docs-server";
import { isDocSlug } from "@/lib/docs";

// Raw Markdown of one docs page. Public URL: /docs/<slug>.md (rewritten here in next.config.ts).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  const slug = raw.replace(/\.md$/, "");
  const page = isDocSlug(slug) ? loadDoc(slug, originFrom(req.headers)) : null;
  if (!page) return new Response(`No docs page "${slug}". Index: /llms.txt\n`, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(page.markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
