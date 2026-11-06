import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDocument,
  renderArchitectureDocument,
  renderMarkdown,
  slugify,
} from "../scripts/render-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_MD = path.join(ROOT, "docs", "architecture.md");
const DOC_HTML = path.join(ROOT, "docs", "architecture.html");

test("the architecture document covers the full system", () => {
  const markdown = fs.readFileSync(DOC_MD, "utf8");

  assert.match(markdown, /^# poca-note — System Architecture/m);

  const required = [
    "## 5. Process model and boot sequence",
    "## 6. Configuration",
    "## 7. Storage architecture",
    "## 8. Identity, tenancy, and authorization",
    "## 11. HTTP interface",
    "## 12. Realtime synchronization",
    "## 13. AI subsystem",
    "## 14. Reports subsystem",
    "## 16. Frontend architecture",
    "## 17. Tooling and operations",
    "## 19. Security posture",
    "## 20. Constraints, scaling, and failure modes",
  ];

  for (const heading of required) {
    assert.ok(markdown.includes(heading), `missing section: ${heading}`);
  }

  // The document should stay a system reference, not drift into a task plan.
  assert.doesNotMatch(markdown, /^- \[ \] /m);
});

test("renderMarkdown converts the document primitives", () => {
  const source = [
    "# Title",
    "",
    "A **bold** and *italic* line with `code` and a [link](https://example.com).",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "```js",
    "const x = 1 < 2;",
    "```",
    "",
    "> quoted",
  ].join("\n");

  const { html, headings } = renderMarkdown(source);

  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/">link<\/a>/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.deepEqual(headings, [{ level: 1, text: "Title", id: "title" }]);
});

test("renderMarkdown escapes unsafe links and HTML", () => {
  const { html } = renderMarkdown(
    '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[ok](#anchor)'
  );

  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /href="#anchor"/);
});

test("slugify matches the hand-written table of contents anchors", () => {
  assert.equal(slugify("1. Purpose and scope"), "1-purpose-and-scope");
  assert.equal(slugify("8. Identity, tenancy, and authorization"), "8-identity-tenancy-and-authorization");
  assert.equal(slugify("20. Constraints, scaling, and failure modes"), "20-constraints-scaling-and-failure-modes");
});

test("buildDocument produces a self-contained Claude-styled page", () => {
  const html = buildDocument({
    markdown: "# Doc\n\n## Section\n\nBody.",
    title: "Doc",
    subtitle: "A subtitle",
    meta: ["v1"],
  });

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /data-doc="architecture"/);
  assert.match(html, /--font-serif: "Copernicus"/);
  assert.match(html, /--accent: #d97757/);
  assert.match(html, /<nav class="toc"/);
  assert.match(html, /data-toc-link="section"/);
  assert.ok(!/<link[^>]+stylesheet/i.test(html), "should not depend on external stylesheets");
  assert.ok(!/<script[^>]+src=/i.test(html), "should not depend on external scripts");
});

test("the committed HTML is in sync with the Markdown", () => {
  const markdown = fs.readFileSync(DOC_MD, "utf8");
  const expected = renderArchitectureDocument(markdown);
  const actual = fs.readFileSync(DOC_HTML, "utf8");

  assert.equal(
    actual,
    expected,
    "docs/architecture.html is stale — run `npm run docs`"
  );
});
