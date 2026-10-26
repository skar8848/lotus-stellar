// A tiny Markdown-to-HTML renderer for the /docs pages (no dependency, pure, tested in tests/docs.test.mts).
//
// Supports what web/content/docs/*.md uses: ATX headings (with ids), paragraphs, fenced code blocks, inline code,
// bold, italic, links, blockquotes, unordered / ordered lists (nested by indentation), GFM tables, horizontal rules
// and HTML comments (dropped). Everything is HTML-escaped first: raw HTML in the source is shown as text.
// Links to other docs pages written as `/docs/<slug>.md` (what agents read) point to `/docs/<slug>` in HTML.

export type Heading = { depth: number; text: string; id: string };
export type Rendered = { html: string; headings: Heading[] };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** `/docs/x.md#a` -> `/docs/x#a`; everything else unchanged. */
export function htmlHref(href: string): string {
  return href.replace(/^(\/docs\/[a-z0-9-]+)\.md(?=$|#)/, "$1");
}

function plainText(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

export function renderInline(src: string): string {
  const codes: string[] = [];
  // 1. protect code spans (their content is escaped, never formatted)
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 2. links, before escaping so the url keeps its characters; text and url are escaped individually
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => {
    const href = htmlHref(url);
    const external = /^https?:\/\//.test(href);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    links.push(`<a href="${esc(href)}"${attrs}>${formatEmphasis(esc(text), codes)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = formatEmphasis(esc(s), codes);
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => links[Number(i)]);
  return s;
}

function formatEmphasis(s: string, codes: string[]): string {
  return s
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const isTableSep = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function renderBlocks(lines: string[], headings: Heading[], ids: Map<string, number>): string {
  const out: string[] = [];
  let i = 0;
  const isBlockStart = (l: string) =>
    /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || LIST_RE.test(l) || /^\s*(---|\*\*\*)\s*$/.test(l) || /^\s*<!--/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    // HTML comment (single or multi line): dropped
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes("-->")) i++;
      i++;
      continue;
    }
    // fenced code
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const cls = lang ? ` class="language-${esc(lang)}"` : "";
      out.push(`<pre><code${cls}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const depth = h[1].length;
      const text = plainText(h[2]);
      const base = slugify(text) || "section";
      const n = ids.get(base) ?? 0;
      ids.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      headings.push({ depth, text, id });
      out.push(`<h${depth} id="${id}">${renderInline(h[2])}</h${depth}>`);
      i++;
      continue;
    }
    // horizontal rule
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderBlocks(body, [], ids)}</blockquote>`);
      continue;
    }
    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      const td = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${renderInline(c)}</${tag}>`;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => td("td", r[k] ?? "", k)).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    // list
    const li = line.match(LIST_RE);
    if (li) {
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_RE);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          items.push([m[3]]);
          i++;
          continue;
        }
        if (l.trim() === "") {
          // a blank line ends the list unless the next line continues an item (indented) or starts a sibling
          const next = lines[i + 1];
          const nm = next?.match(LIST_RE);
          if (next !== undefined && ((nm && nm[1].length === baseIndent) || (next.trim() !== "" && indentOf(next) > baseIndent))) {
            items[items.length - 1].push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > baseIndent) {
          items[items.length - 1].push(l.slice(Math.min(indentOf(l), baseIndent + 2)));
          i++;
          continue;
        }
        // lazy paragraph continuation (not a new block)
        if (!isBlockStart(l)) {
          items[items.length - 1][items[items.length - 1].length - 1] += " " + l.trim();
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      const start = ordered && li[2] !== "1." && li[2] !== "1)" ? ` start="${parseInt(li[2], 10)}"` : "";
      out.push(
        `<${tag}${start}>${items
          .map((it) => {
            const [first, ...rest] = it;
            const restHtml = rest.some((r) => r.trim() !== "") ? renderBlocks(rest, headings, ids) : "";
            return `<li>${renderInline(first)}${restHtml}</li>`;
          })
          .join("")}</${tag}>`,
      );
      continue;
    }
    // paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !(para.length > 0 && isBlockStart(lines[i]))) {
      if (lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      para.push(lines[i++].trim());
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

export function renderMarkdown(md: string): Rendered {
  const headings: Heading[] = [];
  const html = renderBlocks(md.replace(/\r\n?/g, "\n").split("\n"), headings, new Map());
  return { html, headings };
}

/** First `# ` heading and first `> ` line of a page: its title and summary. */
export function docTitleAndSummary(md: string): { title: string; summary: string } {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const summary = md.match(/^>\s+(.+)$/m)?.[1]?.trim() ?? "";
  return { title: plainText(title), summary: plainText(summary) };
}
