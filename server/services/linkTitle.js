import dns from "node:dns/promises";
import net from "node:net";
import { HttpError, isHttpUrl, nowIso, sha256 } from "../util.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 4;

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
  };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10));
      } catch {
        return "";
      }
    })
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function cleanTitle(value) {
  const text = decodeEntities(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : "";
}

function parseMeta(html) {
  const meta = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const re = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match;
    while ((match = re.exec(tag))) {
      attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
    }
    const key = (attrs.property || attrs.name || "").toLowerCase();
    const content = attrs.content || "";
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  return meta;
}

export function extractTitle(html, url) {
  const meta = parseMeta(html);
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  const title =
    cleanTitle(meta.get("og:title")) ||
    cleanTitle(meta.get("twitter:title")) ||
    cleanTitle(meta.get("title")) ||
    cleanTitle(titleTag);
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  const siteName = cleanTitle(meta.get("og:site_name")) || host;
  return { title: title || "", siteName };
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

async function assertSafeTarget(url, config) {
  if (!config.allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
      throw new HttpError(422, "That host is not allowed");
    }
    if (net.isIP(host)) {
      if (isPrivateIp(host)) throw new HttpError(422, "Private network addresses are not allowed");
    } else {
      let addresses;
      try {
        addresses = await dns.lookup(host, { all: true, verbatim: true });
      } catch {
        throw new HttpError(422, "That host could not be resolved");
      }
      if (addresses.some((entry) => isPrivateIp(entry.address))) {
        throw new HttpError(422, "Private network addresses are not allowed");
      }
    }
  }
}

async function readLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function fetchPage(rawUrl, config) {
  if (!isHttpUrl(rawUrl)) throw new HttpError(400, "Link must be an http(s) URL");
  let current = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeTarget(current, config);
    let response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          "user-agent": "poca-note/1.0 (link title lookup)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "en-US,en;q=0.8",
        },
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new HttpError(422, "The page took too long to respond");
      }
      throw new HttpError(422, "The page could not be reached");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new HttpError(422, "The page redirected without a destination");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new HttpError(422, `The page responded with HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return { html: "", finalUrl: current.href };
    }
    const html = await readLimited(response, config.maxBytes);
    return { html, finalUrl: current.href };
  }
  throw new HttpError(422, "Too many redirects");
}

export async function lookupLinkTitle(db, rawUrl, config) {
  const url = String(rawUrl || "").trim();
  if (!isHttpUrl(url)) throw new HttpError(400, "Link must be an http(s) URL");
  if (url.length > 2000) throw new HttpError(400, "Link is too long");
  const key = sha256(url);
  const cached = db.prepare("SELECT * FROM link_titles WHERE url_key = ?").get(key);
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) {
    return {
      url: cached.url,
      finalUrl: cached.final_url || cached.url,
      title: cached.title || "",
      siteName: cached.site_name || "",
      cached: true,
    };
  }

  const { html, finalUrl } = await fetchPage(url, config);
  const extracted = extractTitle(html, finalUrl);
  let host = "";
  try {
    host = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  const result = {
    url,
    finalUrl,
    title: extracted.title || host,
    siteName: extracted.siteName || host,
    cached: false,
  };
  db.prepare(
    `INSERT INTO link_titles (url_key, url, final_url, title, site_name, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(url_key) DO UPDATE SET
       url = excluded.url, final_url = excluded.final_url, title = excluded.title,
       site_name = excluded.site_name, fetched_at = excluded.fetched_at`
  ).run(key, result.url, result.finalUrl, result.title, result.siteName, nowIso());
  return result;
}
