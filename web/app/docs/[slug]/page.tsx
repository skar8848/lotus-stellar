import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, FileCode2 } from "lucide-react";
import { DOCS, isDocSlug } from "@/lib/docs";
import { loadDoc, originFrom } from "@/lib/docs-server";
import { renderMarkdown } from "@/lib/markdown";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  if (!isDocSlug(slug)) return { title: "Docs: Lotus" };
  const page = loadDoc(slug, "");
  return page ? { title: `${page.title}: Lotus docs`, description: page.summary } : { title: "Docs: Lotus" };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  if (!isDocSlug(slug)) notFound();
  const page = loadDoc(slug, originFrom(await headers()));
  if (!page) notFound();

  // The H1 and the summary blockquote are rendered as the page header; the rest is the body.
  const body = page.markdown.replace(/^#\s+.+\n+/m, "").replace(/^>\s+.+\n+/m, "");
  const { html, headings } = renderMarkdown(body);
  const toc = headings.filter((h) => h.depth === 2);
  const idx = DOCS.findIndex((d) => d.slug === slug);
  const prev = idx > 0 ? DOCS[idx - 1] : null;
  const next = idx < DOCS.length - 1 ? DOCS[idx + 1] : null;

  return (
    <div className="flex gap-10">
      <article className="min-w-0 max-w-3xl flex-1" data-testid="docs-article">
        <header className="mb-8 border-b border-line pb-6">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-mutedfg">
            <Link href="/docs" className="hover:text-white">
              Docs
            </Link>
            <span>/</span>
            <span className="text-white">{page.label}</span>
            <a
              href={`/docs/${slug}.md`}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 transition hover:border-primary/40 hover:text-primary"
              title="The raw Markdown of this page, for LLMs and agents"
              data-testid="docs-raw-link"
            >
              <FileCode2 className="size-3.5" aria-hidden /> View as Markdown
            </a>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">{page.title}</h1>
          {page.summary && <p className="mt-3 text-base leading-relaxed text-mutedfg">{page.summary}</p>}
        </header>
        <div className="lotus-prose" dangerouslySetInnerHTML={{ __html: html }} />
        <footer className="mt-12 grid grid-cols-2 gap-3 border-t border-line pt-6 text-sm">
          {prev ? (
            <Link href={`/docs/${prev.slug}`} className="group rounded-lg border border-line p-3 transition hover:border-primary/40">
              <span className="flex items-center gap-1 text-xs text-mutedfg">
                <ArrowLeft className="size-3" aria-hidden /> Previous
              </span>
              <span className="text-white group-hover:text-primary">{prev.label}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/docs/${next.slug}`} className="group rounded-lg border border-line p-3 text-right transition hover:border-primary/40">
              <span className="flex items-center justify-end gap-1 text-xs text-mutedfg">
                Next <ArrowRight className="size-3" aria-hidden />
              </span>
              <span className="text-white group-hover:text-primary">{next.label}</span>
            </Link>
          ) : (
            <span />
          )}
        </footer>
      </article>
      {toc.length > 1 && (
        <aside className="hidden w-52 shrink-0 xl:block">
          <div className="sticky top-24 text-sm">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-mutedfg">On this page</p>
            <ul className="flex flex-col gap-1 border-l border-line">
              {toc.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className="-ml-px block border-l border-transparent py-0.5 pl-3 text-mutedfg transition hover:border-primary hover:text-white">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </div>
  );
}
