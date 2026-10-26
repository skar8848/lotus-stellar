import "./docs.css";
import Link from "next/link";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { DOCS } from "@/lib/docs";

export const metadata = { title: "Docs: Lotus" };

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 gap-10 px-4 py-8 lg:py-12">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-24">
          <DocsSidebar items={DOCS.map((d) => ({ slug: d.slug, label: d.label }))} />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {/* phone / tablet: the pages as a horizontal strip */}
        <div className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1 lg:hidden" data-testid="docs-strip">
          {DOCS.map((d) => (
            <Link key={d.slug} href={`/docs/${d.slug}`} className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-mutedfg hover:text-white">
              {d.label}
            </Link>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}
