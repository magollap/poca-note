#!/usr/bin/env node
/**
 * Render docs/architecture.md into a self-contained, Claude-styled HTML page.
 *
 *   npm run docs
 *   node scripts/render-docs.mjs [input.md] [output.html]
 *
 * The renderer is intentionally dependency-free. It supports the subset of
 * Markdown used by the architecture document: headings, paragraphs, ordered
 * and unordered lists, fenced code, tables, blockquotes, horizontal rules,
 * inline code, bold, italic, strikethrough, and links.
 *
 * `renderMarkdown` and `buildDocument` are exported so tests can exercise the
 * conversion without writing files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ inline */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(value) {
  const raw = String(value || "").replace(/&amp;/g, "&");
  if (raw.startsWith("#")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Strip inline Markdown for heading ids and the document title. */
function plainText(value) {
  return String(value)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(value) {
  return plainText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function renderInline(value) {
  let text = escapeHtml(value);
  const code = [];
  text = text.replace(/`([^`]+)`/g, (_, snippet) => {
    const token = `\u0000CODE${code.length}\u0000`;
    code.push(`<code>${snippet}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const url = safeHref(href);
    if (!url) return match;
    return `<a href="${escapeHtml(url)}">${label}</a>`;
  });

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => code[Number(index)] || "");
  return text;
}

/* ------------------------------------------------------------------- blocks */

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function renderTable(lines) {
  const header = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const rows = body
    .map(
      (cells) =>
        `<tr>${header
          .map((_, index) => `<td>${renderInline(cells[index] ?? "")}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

function renderList(lines) {
  const root = { indent: -1, ordered: false, items: [] };
  const stack = [root];

  for (const line of lines) {
    const match = LIST_ITEM.exec(line);
    if (!match) {
      const last = stack[stack.length - 1];
      const item = last.items[last.items.length - 1];
      if (item) item.text += ` ${line.trim()}`;
      continue;
    }
    const indent = match[1].replace(/\t/g, "    ").length;
    const ordered = /\d+\./.test(match[2]);
    const text = match[3];

    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();

    let top = stack[stack.length - 1];
    if (indent > top.indent && top !== root) {
      const parentItem = top.items[top.items.length - 1];
      const nested = { indent, ordered, items: [] };
      parentItem.children.push(nested);
      stack.push(nested);
      top = nested;
    } else if (top === root || indent === top.indent) {
      if (top.ordered !== ordered && top !== root && indent === top.indent) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (top === root) {
        top.ordered = ordered;
      }
    }

    top.items.push({ text, children: [] });
  }

  function emit(node) {
    const tag = node.ordered ? "ol" : "ul";
    const items = node.items
      .map((item) => {
        const children = item.children.map(emit).join("");
        return `<li>${renderInline(item.text)}${children}</li>`;
      })
      .join("");
    return `<${tag}>${items}</${tag}>`;
  }

  return emit(root);
}

/* ------------------------------------------------------------------ render */

export function renderMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const headings = [];
  const usedIds = new Map();
  let index = 0;

  const uniqueId = (value) => {
    const base = slugify(value) || "section";
    const count = usedIds.get(base) || 0;
    usedIds.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }

    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] || "";
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
      html.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = uniqueId(text);
      headings.push({ level, text: plainText(text), id });
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().replace(/[\s-*_]/g, "") === "") {
      html.push("<hr />");
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(tableLines));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n")).html}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const listLines = [];
      while (
        index < lines.length &&
        (LIST_ITEM.test(lines[index]) || /^\s{2,}\S/.test(lines[index]))
      ) {
        listLines.push(lines[index]);
        index += 1;
      }
      html.push(renderList(listLines));
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !LIST_ITEM.test(lines[index]) &&
      !(lines[index].includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${paragraph.map(renderInline).join("<br />\n")}</p>`);
  }

  return { html: html.join("\n"), headings };
}

/* ----------------------------------------------------------------- template */

function buildToc(headings) {
  const items = headings.filter((heading) => heading.level === 2);
  return items
    .map(
      (heading) =>
        `<li><a href="#${heading.id}" data-toc-link="${heading.id}">${escapeHtml(
          heading.text
        )}</a></li>`
    )
    .join("");
}

export function buildDocument({ markdown, title, subtitle, kicker = "Architecture", meta = [] }) {
  const { html, headings } = renderMarkdown(markdown);
  const toc = buildToc(headings);
  const metaChips = meta
    .map((item) => `<span class="chip">${escapeHtml(item)}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en" data-doc="architecture">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(subtitle)}" />
<meta name="color-scheme" content="light" />
<style>
  :root {
    --paper: #faf9f5;
    --paper-2: #f3f0e9;
    --card: #ffffff;
    --ink: #1f1e1d;
    --ink-2: #3d3a36;
    --muted: #6b6862;
    --faint: #918d84;
    --rule: #e5e1d8;
    --rule-strong: #d6d1c4;
    --accent: #d97757;
    --accent-strong: #c25e3f;
    --accent-soft: #f6e6df;
    --green: #3f7d5c;
    --gold: #b8892f;
    --code-bg: #f3f0e9;
    --code-ink: #3a3631;
    --shadow: 0 18px 50px rgba(31, 30, 29, 0.08);
    --font-serif: "Copernicus", "Tiempos Headline", "Iowan Old Style", "Palatino Linotype",
      Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
    --font-sans: "Styrene B", "Styrene", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI",
      Helvetica, Arial, sans-serif;
    --font-mono: "Berkeley Mono", "SFMono-Regular", ui-monospace, SFMono-Regular, Menlo,
      Consolas, "Liberation Mono", monospace;
    --max: 78ch;
  }

  * { box-sizing: border-box; }

  html { scroll-behavior: smooth; }

  body {
    margin: 0;
    background:
      radial-gradient(900px 420px at 8% -8%, rgba(217, 119, 87, 0.10), transparent 60%),
      radial-gradient(700px 380px at 100% 0%, rgba(184, 137, 47, 0.08), transparent 55%),
      var(--paper);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 16.5px;
    line-height: 1.72;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  a { color: var(--accent-strong); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { color: var(--accent); }

  .hero {
    max-width: 1180px;
    margin: 0 auto;
    padding: 72px 32px 36px;
    border-bottom: 1px solid var(--rule);
  }

  .kicker {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent-strong);
    margin-bottom: 18px;
  }

  .kicker::before {
    content: "";
    width: 26px;
    height: 1px;
    background: var(--accent);
  }

  .hero h1 {
    font-family: var(--font-serif);
    font-weight: 500;
    font-size: clamp(2.4rem, 5vw, 4rem);
    line-height: 1.06;
    letter-spacing: -0.025em;
    margin: 0 0 18px;
    max-width: 20ch;
  }

  .hero p {
    max-width: 62ch;
    margin: 0;
    color: var(--muted);
    font-size: 1.08rem;
    line-height: 1.65;
  }

  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }

  .chip {
    font-family: var(--font-mono);
    font-size: 11.5px;
    letter-spacing: 0.02em;
    color: var(--ink-2);
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 5px 11px;
  }

  .layout {
    max-width: 1180px;
    margin: 0 auto;
    padding: 40px 32px 96px;
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    gap: 56px;
    align-items: start;
  }

  .toc {
    position: sticky;
    top: 28px;
    max-height: calc(100vh - 56px);
    overflow: auto;
    padding-right: 12px;
    scrollbar-width: thin;
  }

  .toc-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--faint);
    margin: 0 0 12px;
  }

  .toc ol {
    list-style: none;
    margin: 0;
    padding: 0;
    counter-reset: toc;
  }

  .toc li { margin: 0; }

  .toc a {
    display: block;
    padding: 4px 0 4px 12px;
    border-left: 2px solid transparent;
    color: var(--muted);
    font-size: 13.5px;
    line-height: 1.4;
    text-decoration: none;
    transition: color 120ms ease, border-color 120ms ease;
  }

  .toc a:hover { color: var(--ink); border-left-color: var(--rule-strong); }
  .toc a.is-active { color: var(--accent-strong); border-left-color: var(--accent); font-weight: 600; }

  article { max-width: var(--max); min-width: 0; }

  article > h1 { display: none; }

  article h2 {
    font-family: var(--font-serif);
    font-weight: 500;
    font-size: clamp(1.7rem, 3vw, 2.15rem);
    line-height: 1.18;
    letter-spacing: -0.015em;
    margin: 64px 0 16px;
    padding-top: 26px;
    border-top: 1px solid var(--rule);
  }

  article h2:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }

  article h3 {
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: 1.28rem;
    line-height: 1.3;
    letter-spacing: -0.01em;
    margin: 38px 0 10px;
    color: var(--ink);
  }

  article h4 {
    font-family: var(--font-sans);
    font-size: 0.98rem;
    font-weight: 700;
    margin: 28px 0 8px;
  }

  article p { margin: 0 0 16px; color: var(--ink-2); }

  article strong { color: var(--ink); font-weight: 650; }

  article em { color: var(--ink-2); }

  article ul, article ol { margin: 0 0 18px; padding-left: 1.35em; color: var(--ink-2); }
  article li { margin: 5px 0; }
  article li > ul, article li > ol { margin: 6px 0 6px; }

  article code {
    font-family: var(--font-mono);
    font-size: 0.86em;
    background: var(--code-bg);
    color: var(--code-ink);
    border: 1px solid var(--rule);
    border-radius: 5px;
    padding: 0.12em 0.38em;
    white-space: nowrap;
  }

  article pre {
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 12px;
    padding: 18px 20px;
    overflow-x: auto;
    margin: 0 0 22px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
  }

  article pre code {
    background: none;
    border: 0;
    padding: 0;
    font-size: 13px;
    line-height: 1.62;
    white-space: pre;
    color: var(--code-ink);
  }

  .table-wrap {
    margin: 0 0 24px;
    overflow-x: auto;
    border: 1px solid var(--rule);
    border-radius: 12px;
    background: var(--card);
    box-shadow: var(--shadow);
  }

  table { width: 100%; border-collapse: collapse; font-size: 14px; line-height: 1.5; }

  thead th {
    text-align: left;
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--paper-2);
    padding: 11px 14px;
    border-bottom: 1px solid var(--rule-strong);
    white-space: nowrap;
  }

  tbody td {
    padding: 11px 14px;
    border-bottom: 1px solid var(--rule);
    vertical-align: top;
    color: var(--ink-2);
  }

  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:nth-child(even) td { background: rgba(243, 240, 233, 0.42); }

  table code { white-space: nowrap; }

  blockquote {
    margin: 0 0 20px;
    padding: 4px 0 4px 18px;
    border-left: 3px solid var(--accent);
    color: var(--muted);
  }

  blockquote p:last-child { margin-bottom: 0; }

  hr {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 34px 0;
  }

  .doc-footer {
    max-width: 1180px;
    margin: 0 auto;
    padding: 28px 32px 64px;
    border-top: 1px solid var(--rule);
    color: var(--faint);
    font-size: 13px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: space-between;
  }

  .doc-footer code { font-family: var(--font-mono); font-size: 12px; }

  @media (max-width: 1020px) {
    .layout { grid-template-columns: 1fr; gap: 0; padding-top: 24px; }
    .toc { display: none; }
    .hero { padding-top: 52px; }
  }

  @media (max-width: 620px) {
    body { font-size: 16px; }
    .hero, .layout, .doc-footer { padding-left: 20px; padding-right: 20px; }
    article h2 { margin-top: 48px; }
    .table-wrap { border-radius: 8px; }
  }

  @media print {
    body { background: #fff; font-size: 11.5pt; }
    .hero { padding-top: 0; }
    .layout { display: block; padding: 0; max-width: none; }
    .toc, .doc-footer { display: none; }
    article { max-width: none; }
    article h2 { page-break-after: avoid; }
    article pre, .table-wrap, blockquote { page-break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <header class="hero">
    <div class="kicker">${escapeHtml(kicker)}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>
    <div class="chips">${metaChips}</div>
  </header>

  <div class="layout">
    <nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ol>${toc}</ol>
    </nav>
    <article>
${html}
    </article>
  </div>

  <footer class="doc-footer">
    <span>poca-note architecture · generated from <code>docs/architecture.md</code></span>
    <span>Re-render with <code>npm run docs</code></span>
  </footer>

  <script>
    (function () {
      if (!("IntersectionObserver" in window)) return;
      var links = Array.prototype.slice.call(document.querySelectorAll("[data-toc-link]"));
      var byId = {};
      links.forEach(function (link) { byId[link.getAttribute("data-toc-link")] = link; });
      var headings = Array.prototype.slice.call(document.querySelectorAll("article h2[id]"));
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (link) { link.classList.remove("is-active"); });
          var active = byId[entry.target.id];
          if (active) active.classList.add("is-active");
        });
      }, { rootMargin: "0px 0px -70% 0px", threshold: 0 });
      headings.forEach(function (heading) { observer.observe(heading); });
    })();
  </script>
</body>
</html>
`;
}

export function renderArchitectureDocument(markdown) {
  return buildDocument({
    markdown,
    title: "poca-note — System Architecture",
    subtitle:
      "A tenant-scoped, keyboard-first personal Kanban with AI skills, board actions, and scheduled reports.",
    kicker: "System architecture",
    meta: ["Version 1.0", "Node >= 22.13", "SQLite / PostgreSQL", "React 18 + Vite 6"],
  });
}

/* --------------------------------------------------------------------- main */

async function main() {
  const input = path.resolve(process.argv[2] || path.join(ROOT, "docs", "architecture.md"));
  const output = path.resolve(process.argv[3] || path.join(ROOT, "docs", "architecture.html"));
  const markdown = fs.readFileSync(input, "utf8");
  const html = renderArchitectureDocument(markdown);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, html, "utf8");
  console.log(
    `Rendered ${path.relative(ROOT, input)} → ${path.relative(ROOT, output)} (${(
      Buffer.byteLength(html) / 1024
    ).toFixed(1)} KiB)`
  );
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  await main();
}
