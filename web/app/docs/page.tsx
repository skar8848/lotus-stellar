import Link from "next/link";
import { ArrowRight, Bot, FileText, HeartPulse, Plug } from "lucide-react";
import { DOCS } from "@/lib/docs";
import { loadAllDocs } from "@/lib/docs-server";

export const metadata = {
  title: "Docs: Lotus",
  description: "Lotus documentation for people and AI agents: concepts, the app, contracts, SDK and MCP integration. Stellar testnet only.",
};

const AGENT_LINKS = [
  { href: "/llms.txt", icon: Bot, title: "/llms.txt", text: "Index for LLMs (llmstxt.org): every page as raw Markdown, plus the API endpoints." },
  { href: "/llms-full.txt", icon: FileText, title: "/llms-full.txt", text: "All pages concatenated in one file, ready to paste into a context window." },
  { href: "/api/health", icon: HeartPulse, title: "/api/health", text: "JSON deployment check: RPC, Horizon, and every pool and vault contract." },
  { href: "/docs/integrate", icon: Plug, title: "SDK and MCP", text: "Quote and build transactions from code or from an AI agent." },
];

export default function DocsIndex() {
  const pages = loadAllDocs("");
  return (
    <div className="max-w-4xl" data-testid="docs-index">
      <header className="mb-10">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">Documentation</p>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Lotus docs</h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-mutedfg">
          Directional liquidity and yield-bearing orders for Stellar. One order, four places to wait. Written for people and for AI agents:
          every page is also served as raw Markdown at <code className="rounded bg-white/5 px-1 py-0.5 text-[0.9em] text-white">/docs/&lt;page&gt;.md</code>.
        </p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs text-primary">
          <span className="size-1.5 rounded-full bg-primary" /> Stellar testnet only. Not audited.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2">
        {DOCS.map((d) => {
          const p = pages.find((x) => x.slug === d.slug);
          return (
            <Link
              key={d.slug}
              href={`/docs/${d.slug}`}
              className="group flex flex-col rounded-xl border border-line bg-card p-5 transition hover:border-primary/40"
              data-testid={`docs-card-${d.slug}`}
            >
              <span className="flex items-center justify-between text-base font-medium text-white group-hover:text-primary">
                {p?.title ?? d.label}
                <ArrowRight className="size-4 text-mutedfg transition group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
              </span>
              {p?.summary && <span className="mt-2 line-clamp-3 text-sm leading-relaxed text-mutedfg">{p.summary}</span>}
            </Link>
          );
        })}
      </section>

      <section className="mt-12">
        <h2 className="mb-4 text-lg font-semibold text-white">For AI agents</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_LINKS.map(({ href, icon: Icon, title, text }) => (
            <a key={href} href={href} className="group flex gap-3 rounded-xl border border-line p-4 transition hover:border-primary/40">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                <span className="block font-mono text-sm text-white group-hover:text-primary">{title}</span>
                <span className="mt-1 block text-sm text-mutedfg">{text}</span>
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
