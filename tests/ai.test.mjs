import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_FORMATS,
  AI_LENGTHS,
  AI_TONES,
  aiStatus,
  buildPrompt,
  generateContent,
} from "../server/services/ai.js";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

test("prompt building carries the brief, format, tone, and length", () => {
  const prompt = buildPrompt({
    brief: "Launch the AI actions panel for a small studio",
    format: "email",
    tone: "direct",
    length: "short",
  });
  assert.match(prompt, /Launch the AI actions panel/);
  assert.match(prompt, /ready-to-send email/i);
  assert.match(prompt, /direct/);
  assert.match(prompt, /under 200 words/i);
  assert.match(prompt, /Markdown only/);
  assert.deepEqual(AI_FORMATS, ["brief", "summary", "email", "social", "notes", "plan"]);
  assert.deepEqual(AI_TONES, ["practical", "warm", "direct", "playful", "formal"]);
  assert.deepEqual(AI_LENGTHS, ["short", "medium", "long"]);
});

test("offline generation returns deterministic formatted Markdown with a title", async () => {
  const config = testConfig();
  config.ai.provider = "offline";
  const result = await generateContent({
    config,
    brief: "Plan the launch of AI board actions. The audience is a small studio.",
    format: "plan",
    tone: "practical",
    length: "short",
  });
  assert.equal(result.provider, "offline");
  assert.equal(result.fallback, true);
  assert.match(result.content, /^# /);
  assert.match(result.content, /## Summary/);
  assert.match(result.content, /## Suggested next steps/);
  assert.match(result.content, /Offline preview/);
});

test("auto mode falls back to offline when no provider is reachable", async () => {
  const config = testConfig();
  config.ai.provider = "auto";
  config.ai.ollama.url = "http://127.0.0.1:1";
  const result = await generateContent({
    config,
    brief: "Write a concise summary of the AI actions launch.",
    format: "summary",
    tone: "direct",
    length: "short",
  });
  assert.equal(result.provider, "offline");
  assert.equal(result.fallback, true);
  assert.ok(Array.isArray(result.attempts));
});

test("aiStatus reports offline mode and configuration flags", async () => {
  const config = testConfig();
  config.ai.provider = "offline";
  config.ai.ollama.url = "http://127.0.0.1:1";
  const status = await aiStatus(config, { force: true });
  assert.equal(status.mode, "offline");
  assert.equal(status.effective, "offline");
  assert.equal(status.anthropic.configured, false);
  assert.equal(status.openai.configured, false);
  assert.equal(status.ollamaReachable, false);
});

test("the Anthropic adapter parses text blocks and strips Markdown fences", async (t) => {
  const config = testConfig();
  config.ai.provider = "anthropic";
  config.ai.anthropic.apiKey = "test-key";
  config.ai.ollama.url = "http://127.0.0.1:1";

  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (href.includes("api.anthropic.com")) {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "```markdown\n# Claude Output\n\nHello there.\n```" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await generateContent({
    config,
    brief: "Write a short note about task numbers.",
    format: "notes",
    tone: "practical",
    length: "short",
  });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, config.ai.anthropic.model);
  assert.equal(result.content, "# Claude Output\n\nHello there.");
  assert.equal(captured.model, config.ai.anthropic.model);
  assert.match(captured.system, /poca-note/);
  assert.equal(captured.messages[0].role, "user");
});

test("the Ollama adapter disables thinking so content is not empty", async (t) => {
  const config = testConfig();
  config.ai.provider = "ollama";
  config.ai.ollama.url = "http://ollama.test";
  config.ai.ollama.model = "qwen3.5:4b";

  const originalFetch = globalThis.fetch;
  let chatBody = null;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen3.5:4b" }] }), { status: 200 });
    }
    if (href.endsWith("/api/chat")) {
      chatBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ message: { role: "assistant", content: "# Local Output\n\nDone." } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await generateContent({
    config,
    brief: "Write a short launch note for the AI actions panel.",
    format: "brief",
    tone: "direct",
    length: "short",
  });
  assert.equal(result.provider, "ollama");
  assert.equal(result.content, "# Local Output\n\nDone.");
  assert.equal(chatBody.think, false, "thinking models must run with think:false");
  assert.equal(chatBody.stream, false);
  assert.equal(chatBody.model, "qwen3.5:4b");
});

test("the AI HTTP route persists tenant-scoped runs and validates briefs", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });
  await app.login();

  const short = await app.call("/api/ai/generate", {
    method: "POST",
    body: { brief: "short" },
  });
  assert.equal(short.status, 400);

  const generated = await app.call("/api/ai/generate", {
    method: "POST",
    body: {
      brief: "Write a warm note announcing the new AI board actions for the studio.",
      format: "email",
      tone: "warm",
      length: "short",
    },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.data.run.provider, undefined);
  assert.equal(generated.data.run.model, undefined);
  assert.equal(generated.data.provider, undefined);
  assert.equal(generated.data.model, undefined);
  assert.equal(generated.data.attempts, undefined);
  assert.match(generated.data.run.content, /^# /);

  const runs = await app.call("/api/ai/runs");
  assert.equal(runs.status, 200);
  assert.equal(runs.data.runs.length, 1);
  assert.equal(runs.data.runs[0].tone, "warm");
  assert.equal(runs.data.runs[0].format, "email");
  assert.equal(runs.data.runs[0].provider, undefined);
  assert.equal(runs.data.runs[0].model, undefined);

  const status = await app.call("/api/ai/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.ready, false);
  assert.equal(status.data.mode, "offline");
  assert.equal(status.data.effective, undefined);
  assert.equal(status.data.ollama, undefined);
  assert.equal(status.data.anthropic, undefined);
});
