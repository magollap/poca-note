const FORMAT_INSTRUCTIONS = {
  brief:
    "a structured project brief with: a one-line summary, Overview, Goals, Audience, Scope (in/out), Risks & assumptions, Next steps, and Open questions.",
  summary:
    "a concise executive summary with a TL;DR, 3–5 key points, and a short 'What happens next' list.",
  email:
    "a ready-to-send email with a Subject line, greeting, 2–4 short body paragraphs, a clear ask, and a sign-off placeholder.",
  social:
    "a social post with a strong opening hook, 2–3 short paragraphs or bullets, and a small set of relevant hashtags.",
  notes:
    "meeting notes with a one-line context, Decisions, Action items as a Markdown table (Action, Owner, Due), and Open questions.",
  plan:
    "an action plan with phases, a sequenced checklist, owners/placeholders, and success criteria.",
};

const TONE_INSTRUCTIONS = {
  practical: "practical, plain-spoken, and specific",
  warm: "warm, human, and encouraging",
  direct: "direct, crisp, and no-nonsense",
  playful: "light and playful without being silly",
  formal: "formal and precise",
};

const LENGTH_INSTRUCTIONS = {
  short: "Keep it under 200 words.",
  medium: "Aim for 300–500 words.",
  long: "Aim for 700–1000 words, with useful detail.",
};

const SYSTEM_PROMPT = [
  "You are poca-note's AI skills assistant for a small, focused team.",
  "Turn a short brief into polished, useful, formatted content.",
  "Return GitHub-flavored Markdown only — no HTML, no code fences around the whole answer, no preamble.",
  "Start with a single H1 title. Use short paragraphs, bullets, and tables when they genuinely help.",
  "Stay grounded in the brief. Do not invent facts, names, metrics, or commitments. If something is unknown, mark it as a placeholder in square brackets.",
  "Keep the author's intent and voice; improve structure and clarity without padding.",
].join(" ");

export const AI_FORMATS = Object.keys(FORMAT_INSTRUCTIONS);
export const AI_TONES = Object.keys(TONE_INSTRUCTIONS);
export const AI_LENGTHS = Object.keys(LENGTH_INSTRUCTIONS);

export function buildPrompt({ brief, format, tone, length }) {
  const formatInstruction = FORMAT_INSTRUCTIONS[format] || FORMAT_INSTRUCTIONS.brief;
  const toneInstruction = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.practical;
  const lengthInstruction = LENGTH_INSTRUCTIONS[length] || LENGTH_INSTRUCTIONS.medium;
  return [
    "Brief:",
    '"""',
    brief,
    '"""',
    "",
    `Produce ${formatInstruction}`,
    `Write it in a ${toneInstruction} tone. ${lengthInstruction}`,
    "",
    "Requirements:",
    "- Use a single H1 title that reflects the brief.",
    "- Prefer concrete language over generic filler.",
    "- Include a short list of next actions when the deliverable is a plan, brief, summary, or notes.",
    "- Use [placeholders] for facts that were not provided.",
    "- Output Markdown only.",
  ].join("\n");
}

function stripFences(content) {
  let text = String(content || "").trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

async function callAnthropic(config, { system, prompt, maxTokens, temperature }) {
  const { apiKey, model } = config.ai.anthropic;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}: ${text.slice(0, 240)}`);
  }
  const data = JSON.parse(text);
  const content = (data.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!content) throw new Error("Anthropic returned an empty response");
  return { content: stripFences(content), model };
}

async function callOllama(config, { system, prompt, maxTokens, temperature }) {
  const { url, model } = config.ai.ollama;
  const response = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      // Qwen 3.5 models otherwise spend the whole token budget on reasoning
      // and return empty content. Content quality is enough without it.
      think: false,
      keep_alive: "10m",
      options: { temperature, num_predict: maxTokens },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${text.slice(0, 240)}`);
  }
  const data = JSON.parse(text);
  const content = String(data.message?.content || "").trim();
  if (!content) throw new Error("Ollama returned an empty response");
  return { content: stripFences(content), model };
}

async function callOpenAI(config, { system, prompt, maxTokens, temperature }) {
  const { baseUrl, apiKey, model } = config.ai.openai;
  if (!baseUrl) throw new Error("OPENAI_BASE_URL is not configured");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LLM ${response.status}: ${text.slice(0, 240)}`);
  }
  const data = JSON.parse(text);
  const content = String(data.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("LLM returned an empty response");
  return { content: stripFences(content), model };
}

function titleCase(value) {
  const words = String(value || "")
    .replace(/[.!?,;:]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  const kept = [];
  let length = 0;
  for (const word of words) {
    if (length + word.length > 82) break;
    kept.push(word.charAt(0).toUpperCase() + word.slice(1));
    length += word.length + 1;
  }
  return kept.join(" ");
}

function offlineContent({ brief, format, tone, length }) {
  const firstSentence =
    brief.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] || "Untitled brief";
  const title = titleCase(firstSentence.replace(/[.!?]+$/, "")) || "Working Note";
  const sentences = brief
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 12)
    .slice(0, 8);
  const context = sentences.length ? sentences : [brief.trim()];
  const next = [
    "Confirm the audience and the decision this content needs to support.",
    "Fill in the [placeholders] with real names, dates, and numbers.",
    "Review with the team and move the card to Doing.",
  ];
  return [
    `# ${title}`,
    "",
    `_Offline preview (${tone}, ${length}). Configure Anthropic or Ollama for fully generated content._`,
    "",
    "## Summary",
    "",
    context[0],
    "",
    "## Key points",
    "",
    ...context.slice(1).map((line) => `- ${line}`),
    "",
    "## Suggested next steps",
    "",
    ...next.map((line) => `- ${line}`),
    "",
    "## Open questions",
    "",
    "- Who is the primary reader?",
    "- What does success look like in one week?",
  ].join("\n");
}

export function aiConfiguration(config) {
  return {
    mode: config.ai.provider,
    anthropic: {
      configured: Boolean(config.ai.anthropic.apiKey),
      model: config.ai.anthropic.model,
    },
    ollama: {
      url: config.ai.ollama.url,
      model: config.ai.ollama.model,
    },
    openai: {
      configured: Boolean(config.ai.openai.baseUrl && config.ai.openai.apiKey),
      model: config.ai.openai.model,
    },
  };
}

const ollamaProbes = new Map();

export async function probeOllama(config, { force = false } = {}) {
  const key = config.ai.ollama.url;
  const cached = ollamaProbes.get(key);
  if (!force && cached && Date.now() - cached.at < 15_000) return cached;
  let probe;
  try {
    const response = await fetch(`${key}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = (data.models || []).map((model) => model.name);
    probe = { at: Date.now(), reachable: true, models };
  } catch {
    probe = { at: Date.now(), reachable: false, models: [] };
  }
  ollamaProbes.set(key, probe);
  return probe;
}

export async function aiStatus(config, options) {
  const probe = await probeOllama(config, options);
  const configInfo = aiConfiguration(config);
  let effective = "offline";
  if (config.ai.provider === "anthropic" && configInfo.anthropic.configured) effective = "anthropic";
  else if (config.ai.provider === "ollama" && probe.reachable) effective = "ollama";
  else if (config.ai.provider === "openai" && configInfo.openai.configured) effective = "openai";
  else if (config.ai.provider === "offline") effective = "offline";
  else if (config.ai.provider === "auto") {
    if (configInfo.anthropic.configured) effective = "anthropic";
    else if (probe.reachable) effective = "ollama";
    else if (configInfo.openai.configured) effective = "openai";
  }
  return {
    ...configInfo,
    effective,
    ollamaReachable: probe.reachable,
    ollamaModels: probe.models,
    fallbackAvailable: true,
  };
}

/**
 * Run a prompt through the configured provider chain. `content` is null when
 * the only available provider is the offline template (callers that need text
 * provide their own deterministic fallback).
 */
export async function generateText({
  config,
  system,
  prompt,
  maxTokens = 2400,
  temperature = 0.4,
}) {
  const attempts = [];
  const order = [];
  const mode = config.ai.provider;
  const probe = await probeOllama(config);
  const info = aiConfiguration(config);

  if (mode === "anthropic") order.push("anthropic");
  else if (mode === "ollama") order.push("ollama");
  else if (mode === "openai") order.push("openai");
  else if (mode === "offline") order.push("offline");
  else {
    if (info.anthropic.configured) order.push("anthropic");
    if (probe.reachable) order.push("ollama");
    if (info.openai.configured) order.push("openai");
    order.push("offline");
  }

  const options = { system, prompt, maxTokens, temperature };

  for (const provider of order) {
    try {
      if (provider === "anthropic") {
        if (!info.anthropic.configured) throw new Error("ANTHROPIC_API_KEY is not configured");
        const result = await callAnthropic(config, options);
        return {
          content: result.content,
          provider: "anthropic",
          model: result.model,
          fallback: false,
          attempts,
        };
      }
      if (provider === "ollama") {
        if (!probe.reachable) throw new Error("Ollama is not reachable");
        const result = await callOllama(config, options);
        return {
          content: result.content,
          provider: "ollama",
          model: result.model,
          fallback: false,
          attempts,
        };
      }
      if (provider === "openai") {
        if (!info.openai.configured) throw new Error("OpenAI-compatible endpoint is not configured");
        const result = await callOpenAI(config, options);
        return {
          content: result.content,
          provider: "openai",
          model: result.model,
          fallback: false,
          attempts,
        };
      }
      if (provider === "offline") {
        return {
          content: null,
          provider: "offline",
          model: "local-template",
          fallback: true,
          attempts,
        };
      }
    } catch (error) {
      attempts.push({ provider, error: error.message });
      if (mode !== "auto") break;
    }
  }

  const detail = attempts.map((attempt) => `${attempt.provider}: ${attempt.error}`).join("; ");
  const error = new Error(`No language model could generate content. ${detail}`);
  error.status = 502;
  throw error;
}

export async function generateContent({ config, brief, format, tone, length }) {
  const prompt = buildPrompt({ brief, format, tone, length });
  const result = await generateText({ config, system: SYSTEM_PROMPT, prompt });
  if (result.provider === "offline") {
    return {
      content: offlineContent({ brief, format, tone, length }),
      provider: "offline",
      model: "local-template",
      fallback: true,
      attempts: result.attempts,
    };
  }
  return result;
}
