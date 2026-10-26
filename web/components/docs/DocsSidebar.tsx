"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, FileText, HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";

export type SidebarItem = { slug: string; label: string };

export function DocsSidebar({ items }: { items: SidebarItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs" className="flex flex-col gap-6 text-sm" data-testid="docs-sidebar">
      <div>
        <Link
          href="/docs"
          className={cn("mb-2 block text-xs font-semibold uppercase tracking-wider transition", pathname === "/docs" ? "text-primary" : "text-mutedfg hover:text-white")}
        >
          Docs
        </Link>
        <ul className="flex flex-col gap-0.5">
          {items.map((it) => {
            const active = pathname === `/docs/${it.slug}`;
            return (
              <li key={it.slug}>
                <Link
                  href={`/docs/${it.slug}`}
                  className={cn(
                    "block rounded-md border-l-2 px-3 py-1.5 transition",
                    active ? "border-primary bg-primary/10 text-white" : "border-transparent text-mutedfg hover:bg-white/5 hover:text-white",
                  )}
                >
                  {it.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-mutedfg">For agents</p>
        <ul className="flex flex-col gap-0.5">
          <li>
            <a href="/llms.txt" className="flex items-center gap-2 rounded-md px-3 py-1.5 text-mutedfg transition hover:bg-white/5 hover:text-white">
              <Bot className="size-3.5" aria-hidden /> llms.txt
            </a>
          </li>
          <li>
            <a href="/llms-full.txt" className="flex items-center gap-2 rounded-md px-3 py-1.5 text-mutedfg transition hover:bg-white/5 hover:text-white">
              <FileText className="size-3.5" aria-hidden /> llms-full.txt
            </a>
          </li>
          <li>
            <a href="/api/health" className="flex items-center gap-2 rounded-md px-3 py-1.5 text-mutedfg transition hover:bg-white/5 hover:text-white">
              <HeartPulse className="size-3.5" aria-hidden /> /api/health
            </a>
          </li>
        </ul>
      </div>
    </nav>
  );
}
