import test from "node:test";
import assert from "node:assert/strict";
import { extractTitle, lookupLinkTitle } from "../server/services/linkTitle.js";
import { testConfig, testDb, seedTenant, startFixture } from "./helpers.mjs";

test("title extraction prefers og:title, then twitter:title, then <title>", () => {
  assert.equal(
    extractTitle('<meta property="og:title" content="OG &amp; Title"><title>Tag</title>', "https://example.com").title,
    "OG & Title"
  );
  assert.equal(
    extractTitle('<meta name="twitter:title" content="Twitter Title"><title>Tag</title>', "https://example.com").title,
    "Twitter Title"
  );
  assert.equal(extractTitle("<title>  Plain   &mdash; title </title>", "https://example.com").title, "Plain — title");
  assert.equal(extractTitle("<p>nothing</p>", "https://www.example.com/path").title, "");
  assert.equal(extractTitle("<p>nothing</p>", "https://www.example.com/path").siteName, "example.com");
});

test("site name falls back to the host and strips www", () => {
  const result = extractTitle('<meta property="og:site_name" content="Fixture Works">', "https://www.example.com");
  assert.equal(result.siteName, "Fixture Works");
  assert.equal(extractTitle("", "https://www.example.com").siteName, "example.com");
});

test("lookup follows redirects, strips markup, and caches for 24 hours", async (t) => {
  const fixture = await startFixture();
  const config = testConfig();
  config.linkFetch.allowPrivate = true;
  const db = testDb(config);
  seedTenant(db);
  t.after(async () => {
    await fixture.close();
    db.close();
  });

  const direct = await lookupLinkTitle(db, fixture.url("/page"), config.linkFetch);
  assert.equal(direct.title, "Fixture & Page");
  assert.equal(direct.siteName, "Fixture Works");
  assert.equal(direct.cached, false);

  const redirected = await lookupLinkTitle(db, fixture.url("/redirect"), config.linkFetch);
  assert.equal(redirected.title, "Fixture & Page");
  assert.match(redirected.finalUrl, /\/page$/);

  const cached = await lookupLinkTitle(db, fixture.url("/page"), config.linkFetch);
  assert.equal(cached.cached, true);
  assert.equal(fixture.hits.get("/page"), 2, "second /page lookup should be served from cache");
});

test("non-HTML responses fall back to the hostname", async (t) => {
  const fixture = await startFixture();
  const config = testConfig();
  config.linkFetch.allowPrivate = true;
  const db = testDb(config);
  seedTenant(db);
  t.after(async () => {
    await fixture.close();
    db.close();
  });

  const result = await lookupLinkTitle(db, fixture.url("/json"), config.linkFetch);
  assert.equal(result.title, "127.0.0.1");
  assert.equal(result.siteName, "127.0.0.1");
});

test("private targets are blocked unless explicitly allowed", async (t) => {
  const fixture = await startFixture();
  const db = testDb(testConfig());
  seedTenant(db);
  t.after(async () => {
    await fixture.close();
    db.close();
  });

  await assert.rejects(
    () => lookupLinkTitle(db, fixture.url("/page"), { ...testConfig().linkFetch, allowPrivate: false }),
    (error) => error.status === 422
  );

  await assert.rejects(
    () => lookupLinkTitle(db, "http://localhost:1/", { ...testConfig().linkFetch, allowPrivate: false }),
    (error) => error.status === 422
  );
});

test("invalid and oversized schemes are rejected before any fetch", async (t) => {
  const db = testDb(testConfig());
  seedTenant(db);
  t.after(() => db.close());
  const linkFetch = testConfig().linkFetch;

  await assert.rejects(() => lookupLinkTitle(db, "ftp://example.com", linkFetch), (error) => error.status === 400);
  await assert.rejects(() => lookupLinkTitle(db, "javascript:alert(1)", linkFetch), (error) => error.status === 400);
  await assert.rejects(() => lookupLinkTitle(db, "", linkFetch), (error) => error.status === 400);
  await assert.rejects(
    () => lookupLinkTitle(db, `https://example.com/${"a".repeat(2100)}`, linkFetch),
    (error) => error.status === 400
  );
});
