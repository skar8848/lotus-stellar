// Plain-node tests for the docs: Markdown renderer, llms.txt builders, and the content files themselves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlHref, renderMarkdown, renderInline, docTitleAndSummary } from "../lib/markdown.ts";
import { DOCS, buildLlmsFull, buildLlmsTxt, expandPlaceholders, toPage, API_DOCS } from "../lib/docs.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(here, "..", "content", "docs");
const read = (slug: string) => fs.readFileSync(path.join(contentDir, `${slug}.md`), "utf8");
const KNOWN_PLACEHOLDERS = new Set(["origin", "deployment", "bot-accounts"]);

test("inline: code is escaped and never formatted, links are rewritten, html is escaped", () => {
  assert.equal(renderInline("`a**b**<c>`"), "<code>a**b**&lt;c&gt;</code>");
  assert.equal(renderInline("**bold** and *it*"), "<strong>bold</strong> and <em>it</em>");
  assert.equal(renderInline("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
  assert.equal(renderInline("[Concepts](/docs/concepts.md#locked-orders)"), '<a href="/docs/concepts#locked-orders">Concepts</a>');
  assert.match(renderInline("[x](https://stellar.expert/a)"), /target="_blank" rel="noopener noreferrer"/);
  assert.equal(renderInline("[`C123`](https://e.x/c)"), '<a href="https://e.x/c" target="_blank" rel="noopener noreferrer"><code>C123</code></a>');
  // snake_case and lone asterisks stay as they are
  assert.equal(renderInline("max_bins_per_swap a * b"), "max_bins_per_swap a * b");
});

test("htmlHref only rewrites docs pages", () => {
  assert.equal(htmlHref("/docs/faq.md"), "/docs/faq");
  assert.equal(htmlHref("/llms.txt"), "/llms.txt");
  assert.equal(htmlHref("docs/pool-abi.md"), "docs/pool-abi.md");
});

test("blocks: headings with unique ids, code fences, tables, nested lists, comments dropped", () => {
  const md = [
    "## Hello `world`",
    "",
    "<!-- hidden -->",
    "## Hello world",
    "",
    "```rust",
    "fn a() -> i128 { 1 < 2 }",
    "```",
    "",
    "| a | b |",
    "|---|---:|",
    "| `x` | 2 |",
    "",
    "1. one",
    "   - nested",
    "2. two",
    "",
    "> quote",
    "",
    "para line one",
    "line two",
  ].join("\n");
  const { html, headings } = renderMarkdown(md);
  assert.deepEqual(
    headings.map((h) => h.id),
    ["hello-world", "hello-world-1"],
  );
  assert.ok(!html.includes("hidden"));
  assert.match(html, /<pre><code class="language-rust">fn a\(\) -&gt; i128 \{ 1 &lt; 2 \}<\/code><\/pre>/);
  assert.match(html, /<th>a<\/th><th style="text-align:right">b<\/th>/);
  assert.match(html, /<td><code>x<\/code><\/td>/);
  assert.match(html, /<ol><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /<p>para line one line two<\/p>/);
});

test("every manifest page has a source with a title and a summary, and only known placeholders", () => {
  for (const d of DOCS) {
    const src = read(d.slug);
    const { title, summary } = docTitleAndSummary(src);
    assert.ok(title.length > 0, `${d.slug}: title`);
    assert.ok(summary.length > 20, `${d.slug}: summary`);
    for (const m of src.matchAll(/\{\{([a-z0-9-]+)\}\}/g)) assert.ok(KNOWN_PLACEHOLDERS.has(m[1]), `${d.slug}: unknown placeholder ${m[1]}`);
  }
});

test("internal docs links point to existing pages and anchors", () => {
  const slugs = new Set<string>(DOCS.map((d) => d.slug));
  const ids = new Map<string, Set<string>>(DOCS.map((d) => [d.slug, new Set(renderMarkdown(read(d.slug)).headings.map((h) => h.id))]));
  for (const d of DOCS) {
    for (const m of read(d.slug).matchAll(/\]\(\/docs\/([a-z0-9-]+)(?:\.md)?(?:#([a-z0-9-]+))?\)/g)) {
      assert.ok(slugs.has(m[1]), `${d.slug} links to missing page ${m[1]}`);
      if (m[2]) assert.ok(ids.get(m[1])!.has(m[2]), `${d.slug} links to missing anchor ${m[1]}#${m[2]}`);
    }
  }
});

test("no contract id is hard-coded in the docs content (they come from the config)", () => {
  for (const d of DOCS) assert.doesNotMatch(read(d.slug).replace(/^<!--.*-->$/gm, ""), /\bC[A-Z2-7]{55}\b/, `${d.slug} hard-codes a contract id`);
});

test("faq.md keeps every question of docs/faq-judges.md", () => {
  const judges = fs.readFileSync(path.resolve(here, "..", "..", "docs", "faq-judges.md"), "utf8");
  const faq = read("faq");
  for (const m of judges.matchAll(/^## (.+)$/gm)) assert.ok(faq.includes(`## ${m[1]}`), `faq.md is missing: ${m[1]}`);
});

test("placeholders expand, unknown ones stay visible", () => {
  assert.equal(expandPlaceholders("{{origin}}/x {{nope}}", { origin: "https://a.b" }), "https://a.b/x {{nope}}");
});

test("llms.txt: H1, summary, a link per page and per endpoint; llms-full has every page", () => {
  const pages = DOCS.map((d) => toPage(d.slug, expandPlaceholders(read(d.slug), { origin: "https://lotus.test", deployment: "TABLE", "bot-accounts": "BOTS" })));
  const txt = buildLlmsTxt("https://lotus.test/", pages);
  const lines = txt.split("\n");
  assert.equal(lines[0], "# Lotus");
  assert.ok(lines[2].startsWith("> "));
  for (const d of DOCS) assert.ok(txt.includes(`(https://lotus.test/docs/${d.slug}.md): `), d.slug);
  for (const a of API_DOCS) assert.ok(txt.includes(`[${a.method} ${a.path}](https://lotus.test${a.path})`), a.path);
  assert.ok(txt.includes("https://lotus.test/llms-full.txt"));
  const full = buildLlmsFull("https://lotus.test", pages);
  for (const p of pages) assert.ok(full.includes(p.markdown.trim()), p.slug);
  assert.ok(full.includes("TABLE") && full.includes("BOTS"));
  assert.ok(!full.includes("{{"));
});
