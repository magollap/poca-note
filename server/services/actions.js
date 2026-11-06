import {
  addChecklistItem,
  createCard,
  deleteChecklistItem,
  patchCard,
  patchChecklistItem,
  softDeleteCard,
} from "../board.js";
import { getRevision, nowIso } from "../db.js";
import { HttpError, localTimeParts, newId, normalizeDate } from "../util.js";
import { generateText } from "./ai.js";

export const ACTION_TYPES = [
  "create",
  "update",
  "complete",
  "delete",
  "subtask",
  "subtask_complete",
  "subtask_update",
  "subtask_delete",
];

const SUBTASK_TYPES = ["subtask_complete", "subtask_update", "subtask_delete"];

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAY_PATTERN = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_PHRASE = new RegExp(
  `\\b(?:(?:due|by|deadline(?:\\s+(?:is|on))?|on|before)\\s+)?(?:` +
    [
      "today|tonight|tomorrow|yesterday",
      `(?:next|this|last|upcoming)\\s+(?:${WEEKDAY_PATTERN})`,
      WEEKDAY_PATTERN,
      "in\\s+\\d{1,2}\\s+(?:days?|weeks?)",
      `(?:${MONTH_PATTERN})\\s+\\d{1,2}(?:st|nd|rd|th)?`,
      "\\d{4}-\\d{2}-\\d{2}",
    ].join("|") +
    `)\\b`,
  "i"
);

function ymdToUtc(ymd) {
  return new Date(`${ymd}T00:00:00Z`);
}

function addDays(ymd, days) {
  const date = ymdToUtc(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(ymd) {
  return ymdToUtc(ymd).getUTCDay();
}

export function todayIn(timezone, now = new Date()) {
  return localTimeParts(now, timezone).date;
}

/** Resolve a natural-language date phrase to YYYY-MM-DD, or null. */
export function resolveDatePhrase(phrase, todayYmd) {
  const text = String(phrase || "").toLowerCase().trim();
  if (!text) return null;

  const iso = text.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return normalizeDate(iso[0]) || null;

  if (/\btoday\b/.test(text) || /\btonight\b/.test(text)) return todayYmd;
  if (/\btomorrow\b/.test(text)) return addDays(todayYmd, 1);
  if (/\byesterday\b/.test(text)) return addDays(todayYmd, -1);

  const relative = text.match(/\bin\s+(\d{1,2})\s+(days?|weeks?)\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const days = /week/.test(relative[2]) ? amount * 7 : amount;
    return addDays(todayYmd, days);
  }

  const weekday = text.match(new RegExp(`\\b(next|this|last|upcoming)?\\s*(${WEEKDAY_PATTERN})\\b`));
  if (weekday) {
    const target = WEEKDAYS[weekday[2]];
    const today = weekdayOf(todayYmd);
    let delta = (target - today + 7) % 7;
    const modifier = weekday[1] || "";
    if (modifier === "next" && delta === 0) delta = 7;
    if (modifier === "last") delta -= 7;
    return addDays(todayYmd, delta);
  }

  const monthDay = text.match(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (monthDay) {
    const month = MONTHS[monthDay[1]];
    const day = Number(monthDay[2]);
    if (!month || day < 1 || day > 31) return null;
    const year = Number(todayYmd.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const normalized = normalizeDate(candidate);
    if (!normalized) return null;
    // A date earlier this year almost certainly means next year.
    return normalized < todayYmd ? normalizeDate(`${year + 1}${normalized.slice(4)}`) : normalized;
  }

  return null;
}

function cleanWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripWrapping(value) {
  let text = cleanWhitespace(value);
  text = text.replace(/^[\s"“”'‘’\-–—:*•]+/, "").replace(/[\s"“”'‘’\-–—:*,]+$/, "");
  text = text.replace(/^(?:the\s+)?(?:card|task|item|todo)\s+/i, "");
  return text.trim();
}

function unquoteFirst(value) {
  const match = String(value || "").match(/^["“'‘](.+?)["”'’](?:\s+|$)/);
  if (match) return { token: match[1], rest: value.slice(match[0].length).trim() };
  return null;
}

function splitTopLevel(value, delimiters) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "“" || char === "‘") {
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      for (const delimiter of delimiters) {
        if (value.slice(i, i + delimiter.length) === delimiter) {
          return [value.slice(0, i), value.slice(i + delimiter.length)];
        }
      }
    }
  }
  return null;
}

const ACTION_START = new RegExp(
  "^(?:then\\s+)?(?:please\\s+)?(?:" +
    [
      "create",
      "add",
      "make",
      "new",
      "start",
      "delete",
      "remove",
      "trash",
      "drop",
      "archive",
      "complete",
      "finish",
      "close",
      "mark",
      "rename",
      "retitle",
      "update",
      "change",
      "set",
      "move",
      "put",
      "shift",
      "append",
      "get\\s+rid\\s+of",
    ].join("|") +
    ")\\b",
  "i"
);

/**
 * Split a request into independent clauses. A paragraph like
 * `Create "A", add a step to "B", and mark "C" as done` has to become three
 * clauses, but quoted titles may contain commas, "and", or newlines, so the
 * scan tracks quotes and brackets instead of splitting blindly.
 */
export function splitClauses(text) {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[•·]/g, "\n");
  const clauses = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let index = 0;

  const push = (end, next) => {
    const piece = cleanWhitespace(normalized.slice(start, end));
    if (piece) clauses.push(piece);
    start = next;
  };

  while (index < normalized.length) {
    const char = normalized[index];
    if (quote) {
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "“") {
      quote = char === "“" ? "”" : '"';
      index += 1;
      continue;
    }
    if (char === "'" || char === "‘") {
      // Only treat an apostrophe as a quote when it opens a word, so
      // "don't rename it" still splits.
      const previous = index === 0 ? " " : normalized[index - 1];
      if (/^['‘]$/.test(char) && /\s/.test(previous)) {
        quote = char === "‘" ? "’" : "'";
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0) {
      if (char === "\n" || char === ";") {
        let end = index;
        while (normalized[end] === "\n" || normalized[end] === ";") end += 1;
        push(index, end);
        index = end;
        continue;
      }
      const rest = normalized.slice(index);
      let width = 0;
      const thenMatch = rest.match(/^\s+then\s+/i);
      const andMatch = rest.match(/^\s+and\s+/i);
      const commaMatch = rest.match(/^,\s+(?:and\s+)?/i);
      const arrowMatch = rest.match(/^\s+(?:->|→)\s*/);
      if (thenMatch) width = thenMatch[0].length;
      else if (andMatch && ACTION_START.test(rest.slice(andMatch[0].length))) {
        width = andMatch[0].length;
      } else if (commaMatch && ACTION_START.test(rest.slice(commaMatch[0].length))) {
        width = commaMatch[0].length;
      } else if (arrowMatch) width = arrowMatch[0].length;
      if (width > 0) {
        push(index, index + width);
        index += width;
        continue;
      }
    }
    index += 1;
  }
  push(normalized.length, normalized.length);
  return clauses;
}

function extractDue(text, todayYmd) {
  const phrase = text.match(DATE_PHRASE);
  if (!phrase) return { dueDate: null, text };
  const dueDate = resolveDatePhrase(phrase[0], todayYmd);
  if (!dueDate) return { dueDate: null, text };
  return { dueDate, text: cleanWhitespace(text.replace(phrase[0], " ")) };
}

function extractPriority(text) {
  const explicit = text.match(/\b(high|low|normal|medium|urgent)\s*priority\b/i) ||
    text.match(/\bpriority\s*(?:is|:)?\s*(high|low|normal|medium|urgent)\b/i);
  if (explicit) {
    const value = explicit[1].toLowerCase();
    const priority = value === "urgent" || value === "high" ? "high" : value === "low" ? "low" : "normal";
    return { priority, text: cleanWhitespace(text.replace(explicit[0], " ")) };
  }
  if (/\burgent\b|\bimportant\b/i.test(text)) {
    return { priority: "high", text: cleanWhitespace(text.replace(/\b(urgent|important)\b/gi, " ")) };
  }
  if (/\bsomeday\b|\bwhenever\b/i.test(text)) {
    return { priority: "low", text: cleanWhitespace(text.replace(/\b(someday|whenever)\b/gi, " ")) };
  }
  return { priority: null, text };
}

function extractColumn(text) {
  const match = text.match(
    /\b(?:in|to|into|under|move\s+to)\s+(?:the\s+)?(to\s*do|todo|doing|in\s+progress|under\s+review|review|done)\b/i
  );
  if (!match) return { column: null, text };
  const raw = match[1].toLowerCase().replace(/\s+/g, "");
  return { column: normalizeColumn(raw), text: cleanWhitespace(text.replace(match[0], " ")) };
}

function scoreTitle(query, title) {
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  if (q === t) return 120;
  if (t.startsWith(q)) return 95;
  if (t.includes(q)) return 80;
  const tokens = q.split(/\s+/).filter((token) => token.length > 1);
  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => t.includes(token)).length;
  if (hits === tokens.length) return 60 + Math.min(20, tokens.length * 3);
  if (hits / tokens.length >= 0.6) return 30 + Math.round((hits / tokens.length) * 20);
  return 0;
}

export function normalizeTaskNo(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|[^\d])(\d{9,10})(?:[^\d]|$)/);
  return match ? match[1] : "";
}

export function resolveCardTarget(cards, rawTarget) {
  const target = stripWrapping(rawTarget);
  if (!target) return null;
  const taskNoMatch = target.match(/^(?:task\s+)?#?(\d{9,10})$/i);
  if (taskNoMatch) {
    const byNumber = cards.find((card) => card.taskNo === taskNoMatch[1]);
    if (byNumber) return byNumber;
  }
  const direct = cards.find((card) => card.id === target || card.id.startsWith(target)) ||
    cards.find((card) => `#${card.id.slice(0, 8)}` === target.toLowerCase());
  if (direct) return direct;

  const scored = cards
    .map((card) => ({ card, score: scoreTitle(target, card.title) }))
    .filter((entry) => entry.score >= 30)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score >= scored[0].score - 5) {
    // Ambiguous: prefer an exact title if one exists, otherwise refuse to guess.
    if (scored[0].score < 120) return null;
  }
  return scored[0].card;
}

/** Find a checklist subtask across every card by its nine digit number. */
export function resolveSubtaskTarget(cards, rawTarget) {
  const target = stripWrapping(rawTarget);
  const match = target.match(/^(?:task\s+)?#?(\d{9,10})$/i);
  if (!match) return null;
  const taskNo = match[1];
  for (const card of cards) {
    for (const item of Array.isArray(card.checklist) ? card.checklist : []) {
      if (item.taskNo === taskNo) return { card, item };
    }
  }
  return null;
}

function buildAction(type, fields) {
  return {
    id: newId(),
    type,
    status: "pending",
    ...fields,
  };
}

function referencedCard(cards, rawTarget, warnings) {
  const card = resolveCardTarget(cards, rawTarget);
  if (!card) {
    const label = stripWrapping(rawTarget);
    if (label) warnings.push(`No card matches “${label}”.`);
    return null;
  }
  return card;
}

function withCard(action, card) {
  return {
    ...action,
    cardId: card.id,
    cardTitle: card.title,
    cardColumn: card.column,
    cardVersion: card.version,
    ...(card.taskNo ? { cardTaskNo: card.taskNo } : {}),
  };
}

function withSubtask(action, card, item) {
  return {
    ...withCard(action, card),
    checklistItemId: item.id,
    checklistText: item.text,
    checklistDone: Boolean(item.done),
    taskNo: item.taskNo || "",
  };
}

function parseSubtask(clause, cards, warnings) {
  const leading = clause.match(
    /^(?:please\s+)?(?:add|append|create)\s+(?:a\s+|an\s+)?(?:subtask|sub-task|sub task|checklist item|checklist|step|item)\b(.*)$/i
  );
  if (!leading) return null;
  let rest = leading[1].trim();
  if (!rest) return null;

  let targetFirst = false;
  const lead = rest.match(/^(?:to|on|for|in)\s+(.+)$/i);
  if (lead) {
    rest = lead[1].trim();
    targetFirst = true;
  }

  let target = "";
  let text = "";

  // `Launch page: review copy` / `Launch page — review copy`
  const colonSplit = splitTopLevel(rest, [":", " — ", " – ", " - "]);
  if (colonSplit && colonSplit[0].trim() && colonSplit[1].trim()) {
    target = colonSplit[0];
    text = colonSplit[1];
  } else {
    // `"Review copy" to "Ship the beta"` (text first) or `to "Ship the beta"` (target first)
    const toSplit = rest.match(/^(.+?)\s+(?:to|on|for)\s+(.+)$/i);
    if (toSplit) {
      if (targetFirst) {
        target = `${rest}`;
      } else {
        text = toSplit[1];
        target = toSplit[2];
      }
    }
  }

  if (!text) {
    const quoted = [...rest.matchAll(/["“'‘]([^"”'’]+)["”'’]/g)].map((match) => match[1]);
    if (quoted.length >= 2) {
      if (targetFirst || quoted[1].toLowerCase().includes("to")) {
        target = quoted[0];
        text = quoted[1];
      } else {
        text = quoted[0];
        target = quoted[1];
      }
    } else if (quoted.length === 1) {
      if (targetFirst) {
        target = target || rest.replace(quoted[0], "").trim() || quoted[0];
        text = quoted[0];
      } else {
        text = quoted[0];
        target = rest.replace(quoted[0], "").replace(/^\s*(?:to|on|for)\s+/i, "").trim();
      }
    }
  }

  if (!target) target = targetFirst ? rest : "";
  target = stripWrapping(target);
  text = stripWrapping(text);
  if (!target || !text || target === text) return null;

  const card = referencedCard(cards, target, warnings);
  const action = buildAction("subtask", { text });
  return card ? withCard(action, card) : { ...action, cardId: null, cardTitle: target, unresolved: true };
}

const SUBTASK_NOUN = "(?:(sub-?task|sub\\s+task|step|checklist\\s+item|checklist|item)\\s+)?";
const TASK_NO_TOKEN = "(#?\\d{9,10})";

const SUBTASK_COMMANDS = [
  {
    type: "subtask_complete",
    patterns: [
      new RegExp(
        `^(?:please\\s+)?(?:mark|set)\\s+(?:the\\s+)?${SUBTASK_NOUN}(?:task\\s+)?${TASK_NO_TOKEN}\\s+(?:as\\s+)?(?:done|complete|completed|finished)$`,
        "i"
      ),
      new RegExp(
        `^(?:please\\s+)?(?:complete|finish|close|check|tick)\\s+(?:off\\s+)?(?:the\\s+)?${SUBTASK_NOUN}(?:task\\s+)?${TASK_NO_TOKEN}$`,
        "i"
      ),
    ],
  },
  {
    type: "subtask_update",
    patterns: [
      new RegExp(
        `^(?:please\\s+)?(?:rename|retitle|update)\\s+(?:the\\s+)?${SUBTASK_NOUN}(?:task\\s+)?${TASK_NO_TOKEN}\\s+to\\s+(.+)$`,
        "i"
      ),
    ],
  },
  {
    type: "subtask_delete",
    patterns: [
      new RegExp(
        `^(?:please\\s+)?(?:delete|remove|drop|trash|archive|get\\s+rid\\s+of)\\s+(?:the\\s+)?${SUBTASK_NOUN}(?:task\\s+)?${TASK_NO_TOKEN}$`,
        "i"
      ),
    ],
  },
];

/**
 * Subtask commands always carry a nine digit number, e.g. "mark subtask Task
 * 261000001 as done". When the number belongs to a card instead, fall through so
 * the card rules handle it.
 */
function parseSubtaskCommand(clause, cards, warnings) {
  for (const command of SUBTASK_COMMANDS) {
    for (const pattern of command.patterns) {
      const match = clause.match(pattern);
      if (!match) continue;
      const noun = match[1];
      const taskNo = normalizeTaskNo(match[2]);
      if (!taskNo) continue;
      const text = command.type === "subtask_update" ? stripWrapping(match[3] || "") : "";
      const resolved = resolveSubtaskTarget(cards, taskNo);
      if (!resolved) {
        if (!noun) return null;
        warnings.push(`No subtask matches Task ${taskNo}.`);
        return {
          ...buildAction(command.type, text ? { text } : {}),
          cardId: null,
          cardTitle: `Task ${taskNo}`,
          taskNo,
          unresolved: true,
        };
      }
      if (command.type === "subtask_update" && !text) return null;
      return withSubtask(buildAction(command.type, text ? { text } : {}), resolved.card, resolved.item);
    }
  }
  return null;
}

function parseComplete(clause, cards, warnings) {
  if (/^(?:create|add|make|new|start|delete|remove|trash|rename|update|change|set|move|put|shift|append)\b/i.test(clause)) {
    return null;
  }
  const patterns = [
    /^(?:please\s+)?(?:mark|set)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished|closed)$/i,
    /^(?:please\s+)?(?:complete|finish|close|do)\s+(?:the\s+)?(?:card\s+|task\s+)?(.+)$/i,
    /^(.+?)\s+(?:is\s+)?(?:done|completed|finished)$/i,
  ];
  for (const pattern of patterns) {
    const match = clause.match(pattern);
    if (!match) continue;
    const target = stripWrapping(match[1]);
    if (!target || /^(?:all|everything|it|this|that)$/i.test(target)) return null;
    const card = referencedCard(cards, target, warnings);
    const action = buildAction("complete", {});
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: target, unresolved: true };
  }
  return null;
}

function parseDelete(clause, cards, warnings) {
  const match = clause.match(
    /^(?:please\s+)?(?:delete|remove|trash|drop|archive|get rid of)\s+(?:the\s+)?(?:card\s+|task\s+)?(.+)$/i
  );
  if (!match) return null;
  const target = stripWrapping(match[1]);
  if (!target) return null;
  const card = referencedCard(cards, target, warnings);
  const action = buildAction("delete", {});
  return card
    ? withCard(action, card)
    : { ...action, cardId: null, cardTitle: target, unresolved: true };
}

function parseUpdate(clause, cards, todayYmd, warnings) {
  let match = clause.match(/^(?:please\s+)?(?:rename|retitle)\s+(.+?)\s+to\s+(.+)$/i);
  if (match) {
    const card = referencedCard(cards, match[1], warnings);
    const title = stripWrapping(match[2]);
    if (!title) return null;
    const action = buildAction("update", { patch: { title } });
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: stripWrapping(match[1]), unresolved: true };
  }

  match = clause.match(
    /^(?:please\s+)?(?:move|put|shift)\s+(.+?)\s+(?:to|into|in)\s+(?:the\s+)?(to\s*do|todo|doing|in\s+progress|under\s+review|review|done)$/i
  );
  if (match) {
    const card = referencedCard(cards, match[1], warnings);
    const raw = match[2].toLowerCase().replace(/\s+/g, "");
    const column = normalizeColumn(raw);
    const action = buildAction("update", { patch: { column } });
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: stripWrapping(match[1]), unresolved: true };
  }

  match = clause.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:the\s+)?(?:due\s*date|due|deadline)\s+(?:of|for|on)?\s*(.+?)\s+to\s+(.+)$/i
  );
  if (match) {
    const card = referencedCard(cards, match[1], warnings);
    const dueDate = resolveDatePhrase(match[2], todayYmd);
    if (!dueDate) return null;
    const action = buildAction("update", { patch: { dueDate } });
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: stripWrapping(match[1]), unresolved: true };
  }

  match = clause.match(
    /^(?:please\s+)?(?:set|change|update)\s+(?:the\s+)?priority\s+(?:of|for|on)?\s*(.+?)\s+to\s+(?:priority\s+)?(low|normal|medium|high|urgent)$/i
  );
  if (match) {
    const card = referencedCard(cards, match[1], warnings);
    const raw = match[2].toLowerCase();
    const priority = raw === "high" || raw === "urgent" ? "high" : raw === "low" ? "low" : "normal";
    const action = buildAction("update", { patch: { priority } });
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: stripWrapping(match[1]), unresolved: true };
  }

  match = clause.match(
    /^(?:please\s+)?(?:add|set|update|append)\s+(?:a\s+)?notes?\s+(?:to|on|for)\s+(.+?)\s*[:\-–—]\s*(.+)$/i
  );
  if (match) {
    const card = referencedCard(cards, match[1], warnings);
    const notes = String(match[2] || "").trim();
    if (!notes) return null;
    const action = buildAction("update", { patch: { notes } });
    return card
      ? withCard(action, card)
      : { ...action, cardId: null, cardTitle: stripWrapping(match[1]), unresolved: true };
  }

  return null;
}

function parseCreate(clause, todayYmd) {
  let match = clause.match(
    /^(?:please\s+)?(?:create|add|make|new|start)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:card|task|item|to-?do)\b\s*(?:called|named|titled|for|:)?\s*(.+)$/i
  );
  if (!match) {
    match = clause.match(
      /^(?:please\s+)?(?:create|add|make)\s+(.+?)\s+(?:to|in|into|under)\s+(?:the\s+)?(to\s*do|todo|doing|in\s+progress|under\s+review|review|done)$/i
    );
    if (match) {
      const raw = match[2].toLowerCase().replace(/\s+/g, "");
      const column = normalizeColumn(raw);
      const title = stripWrapping(match[1]);
      if (!title) return null;
      return buildAction("create", { title, column, notes: "", priority: "normal", dueDate: "", checklist: [] });
    }
    match = clause.match(/^(?:please\s+)?(?:create|add|make)\s+(.+)$/i);
    if (!match) return null;
    if (/\b(?:to|into|for|on|from|with|about|of)\b/i.test(match[1]) && match[1].length > 40) return null;
  }

  let rest = match[1];
  const due = extractDue(rest, todayYmd);
  rest = due.text;
  const priority = extractPriority(rest);
  rest = priority.text;

  let column = "todo";
  const columnHit = extractColumn(rest);
  if (columnHit.column) {
    column = columnHit.column;
    rest = columnHit.text;
  }

  let notes = "";
  const notesSplit = splitTopLevel(rest, [": ", " — ", " – "]);
  if (notesSplit && notesSplit[1].trim().length > 2) {
    rest = notesSplit[0];
    notes = notesSplit[1].trim();
  }

  const title = stripWrapping(rest).replace(/^(?:the|a|an)\s+/i, "").slice(0, 500);
  if (!title) return null;

  return buildAction("create", {
    title,
    column,
    notes,
    priority: priority.priority || "normal",
    dueDate: due.dueDate || "",
    checklist: [],
  });
}

export function parseActionsByRules({ text, cards = [], now = new Date(), timezone = "UTC" }) {
  const today = todayIn(timezone, now);
  const actions = [];
  const warnings = [];
  for (const clause of splitClauses(text)) {
    const action =
      parseSubtask(clause, cards, warnings) ||
      parseSubtaskCommand(clause, cards, warnings) ||
      parseUpdate(clause, cards, today, warnings) ||
      parseComplete(clause, cards, warnings) ||
      parseDelete(clause, cards, warnings) ||
      parseCreate(clause, today);
    if (action) actions.push(action);
  }
  return { actions, warnings };
}

export function describeActions(actions) {
  const counts = {};
  for (const action of actions) counts[action.type] = (counts[action.type] || 0) + 1;
  const labels = {
    create: "create",
    update: "update",
    complete: "complete",
    delete: "delete",
    subtask: "add subtask to",
    subtask_complete: "complete subtask",
    subtask_update: "rename subtask",
    subtask_delete: "delete subtask",
  };
  const parts = Object.entries(counts).map(([type, count]) => `${labels[type]} ${count}`);
  if (!parts.length) return "No actions";
  return parts.join(" · ").replace(/^./, (char) => char.toUpperCase());
}

const PLANNER_SYSTEM = [
  "You are poca-note's board action planner.",
  "Convert the user's request into a strict JSON plan. Return JSON only — no prose, no code fences.",
  'The JSON shape is {"summary": string, "actions": Action[]}.',
  "Every card and every checklist subtask has a unique nine digit number shown as Task 261000001 (YYMM + five digit sequence).",
  "Allowed actions:",
  '{"type":"create","title":"...","column":"todo|doing|review|done","notes":"...","priority":"low|normal|high","dueDate":"YYYY-MM-DD or null","checklist":["..."]}',
  '{"type":"update","taskNo":"261000001","cardId":"...","patch":{"title":"?","notes":"?","dueDate":"?","priority":"?","column":"?"}}',
  '{"type":"complete","taskNo":"261000001","cardId":"..."}',
  '{"type":"delete","taskNo":"261000001","cardId":"..."}',
  '{"type":"subtask","taskNo":"261000001","cardId":"...","text":"..."}',
  '{"type":"subtask_complete","taskNo":"261000001","checklistItemId":"..."}',
  '{"type":"subtask_update","taskNo":"261000001","checklistItemId":"...","text":"new text"}',
  '{"type":"subtask_delete","taskNo":"261000001","checklistItemId":"..."}',
  "Rules:",
  "- Prefer taskNo when the user references a number; Task 261000001 identifies cards and subtasks.",
  "- The user may write '#261000001' or 'Task 261000001'; both mean the same number.",
  "- Only reference numbers or ids listed in the board. Never invent them.",
  "- Use subtask_* actions for operations on a checklist subtask and card actions for whole cards.",
  "- Prefer few, precise actions over many speculative ones.",
  "- Keep titles under 200 characters and do not include due dates or priorities inside the title.",
  "- Do not delete or complete cards or subtasks the user did not name.",
].join("\n");

function boardPrompt(cards, today) {
  const lines = [];
  for (const card of cards.slice(0, 120)) {
    const label = card.taskNo ? `Task ${card.taskNo}` : `#${card.id.slice(0, 8)}`;
    const meta = [label, card.column];
    if (card.dueDate) meta.push(`due ${card.dueDate}`);
    if (card.priority && card.priority !== "normal") meta.push(card.priority);
    lines.push(`- ${meta.join(" | ")} | ${card.title}`);
    for (const item of (Array.isArray(card.checklist) ? card.checklist : []).slice(0, 20)) {
      const itemLabel = item.taskNo ? `Task ${item.taskNo}` : `#${item.id.slice(0, 8)}`;
      lines.push(
        `  - ${itemLabel} | subtask of ${label}${item.done ? " | done" : ""} | ${item.text}`
      );
    }
  }
  return [`Today is ${today}.`, "Board:", ...(lines.length ? lines : ["- (empty board)"])].join("\n");
}

function parseJsonPlan(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeColumn(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, "");
  if (text === "done") return "done";
  if (text === "review" || text === "underreview") return "review";
  if (text === "doing" || text === "inprogress") return "doing";
  return "todo";
}

function normalizePriority(value) {
  const text = String(value || "").toLowerCase();
  if (text === "high" || text === "urgent") return "high";
  if (text === "low") return "low";
  return "normal";
}

function resolveLlmSubtask(cards, raw) {
  const itemId = String(raw.checklistItemId || "").trim();
  if (itemId) {
    for (const card of cards) {
      const item = (card.checklist || []).find((entry) => entry.id === itemId);
      if (item) return { card, item };
    }
  }
  return resolveSubtaskTarget(cards, raw.taskNo || raw.checklistItemId || raw.cardId || "");
}

function normalizeLlmAction(raw, cards, today) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").toLowerCase();
  if (!ACTION_TYPES.includes(type)) return null;

  if (type === "create") {
    const title = stripWrapping(raw.title).slice(0, 500);
    if (!title) return null;
    const dueDate = raw.dueDate ? resolveDatePhrase(String(raw.dueDate), today) || normalizeDate(String(raw.dueDate)) : null;
    return buildAction("create", {
      title,
      column: normalizeColumn(raw.column),
      notes: String(raw.notes || "").slice(0, 20_000),
      priority: normalizePriority(raw.priority),
      dueDate: dueDate || "",
      checklist: Array.isArray(raw.checklist)
        ? raw.checklist.map((item) => stripWrapping(item)).filter(Boolean).slice(0, 20)
        : [],
    });
  }

  if (SUBTASK_TYPES.includes(type)) {
    const text = type === "subtask_update" ? stripWrapping(raw.text) : "";
    const resolved = resolveLlmSubtask(cards, raw);
    if (!resolved) {
      return {
        ...buildAction(type, text ? { text } : {}),
        cardId: null,
        cardTitle: String(raw.taskNo || raw.checklistText || raw.cardTitle || ""),
        taskNo: normalizeTaskNo(raw.taskNo || raw.checklistItemId || raw.cardId),
        unresolved: true,
      };
    }
    if (type === "subtask_update" && !text) return null;
    return withSubtask(buildAction(type, text ? { text } : {}), resolved.card, resolved.item);
  }

  const card =
    (raw.taskNo ? cards.find((entry) => entry.taskNo === normalizeTaskNo(raw.taskNo)) : null) ||
    cards.find((entry) => entry.id === raw.cardId) ||
    resolveCardTarget(cards, raw.cardId || raw.taskNo);
  if (!card) {
    return {
      ...buildAction(type, type === "subtask" ? { text: stripWrapping(raw.text) } : type === "update" ? { patch: raw.patch || {} } : {}),
      cardId: null,
      cardTitle: String(raw.cardTitle || raw.taskNo || raw.cardId || ""),
      ...(normalizeTaskNo(raw.taskNo || raw.cardId) ? { taskNo: normalizeTaskNo(raw.taskNo || raw.cardId) } : {}),
      unresolved: true,
    };
  }

  const base = withCard(buildAction(type, {}), card);
  if (type === "subtask") {
    const text = stripWrapping(raw.text);
    if (!text) return null;
    return { ...base, text };
  }
  if (type === "update") {
    const patch = {};
    if (raw.patch && typeof raw.patch === "object") {
      if (raw.patch.title !== undefined) patch.title = stripWrapping(raw.patch.title).slice(0, 500);
      if (raw.patch.notes !== undefined) patch.notes = String(raw.patch.notes).slice(0, 20_000);
      if (raw.patch.column !== undefined) patch.column = normalizeColumn(raw.patch.column);
      if (raw.patch.priority !== undefined) patch.priority = normalizePriority(raw.patch.priority);
      if (raw.patch.dueDate !== undefined) {
        patch.dueDate = raw.patch.dueDate
          ? normalizeDate(String(raw.patch.dueDate)) || resolveDatePhrase(String(raw.patch.dueDate), today) || null
          : null;
      }
    }
    if (!Object.keys(patch).length) return null;
    return { ...base, patch };
  }
  return base;
}

function offlinePlan({ text, cards, today }) {
  const firstLine = String(text)
    .split(/\n+/)
    .map((line) => cleanWhitespace(line))
    .find(Boolean) || "New card";
  const stripped = firstLine
    .replace(/^(?:please\s+)?(?:create|add|make|new|start)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:card|task|item|to-?do)\b\s*(?:called|named|titled|for|:)?\s*/i, "")
    .trim();
  const base = stripped || firstLine;
  const due = extractDue(base, today);
  const priority = extractPriority(due.text);
  const title = stripWrapping(priority.text).slice(0, 160) || stripWrapping(base).slice(0, 160) || "New card";
  return {
    actions: [
      buildAction("create", {
        title,
        column: "todo",
        notes: String(text).slice(0, 4000),
        priority: priority.priority || "normal",
        dueDate: due.dueDate || "",
        checklist: [],
      }),
    ],
    warnings: [
      "No model is available, so this plan uses the offline fallback: one card is created from your request.",
    ],
    source: "offline",
  };
}

/**
 * Turn a free-text prompt into a reviewable plan. Rules run first because they
 * are instant and deterministic; a language model is only asked when the rules
 * recognize nothing.
 */
export async function planActions({ db, config, tenantId, prompt, now = new Date() }) {
  const text = String(prompt || "").trim();
  if (text.length < 3) throw new HttpError(400, "Describe the change in a few words.");
  if (text.length > 4000) throw new HttpError(400, "That request is too long (4,000 characters max).");

  let timezone = config.reports?.defaultTimezone || "UTC";
  try {
    const settings = db
      .prepare("SELECT timezone FROM report_settings WHERE tenant_id = ?")
      .get(tenantId);
    if (settings?.timezone) timezone = settings.timezone;
  } catch {
    // fall back to the configured default when settings are unavailable
  }
  const today = todayIn(timezone, now);
  const board = db
    .prepare(
      `SELECT id, task_no, column_key, title, due_date, priority, version, notes
       FROM cards WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY column_key, position`
    )
    .all(tenantId);
  const checklistRows = db
    .prepare(
      `SELECT ci.id, ci.card_id, ci.task_no, ci.text, ci.done
       FROM checklist_items ci
       JOIN cards c ON c.id = ci.card_id
       WHERE ci.tenant_id = ? AND c.deleted_at IS NULL
       ORDER BY ci.position, ci.created_at`
    )
    .all(tenantId);
  const checklistByCard = new Map();
  for (const row of checklistRows) {
    if (!checklistByCard.has(row.card_id)) checklistByCard.set(row.card_id, []);
    checklistByCard.get(row.card_id).push({
      id: row.id,
      taskNo: row.task_no || "",
      text: row.text,
      done: Boolean(row.done),
    });
  }
  const cards = board.map((row) => ({
    id: row.id,
    taskNo: row.task_no || "",
    column: row.column_key,
    title: row.title,
    dueDate: row.due_date || "",
    priority: row.priority,
    version: Number(row.version),
    notes: row.notes || "",
    checklist: checklistByCard.get(row.id) || [],
  }));

  const rules = parseActionsByRules({ text, cards, now, timezone });
  if (rules.actions.length) {
    return {
      summary: describeActions(rules.actions),
      source: "rules",
      actions: rules.actions,
      warnings: rules.warnings,
      provider: null,
      model: null,
      prompt: text,
    };
  }

  let llm = null;
  try {
    llm = await generateText({
      config,
      system: PLANNER_SYSTEM,
      prompt: `${boardPrompt(cards, today)}\n\nRequest:\n"""\n${text}\n"""\n\nReturn the JSON plan only.`,
      maxTokens: 1200,
      temperature: 0.1,
    });
  } catch {
    llm = null;
  }

  if (llm?.content) {
    const parsed = parseJsonPlan(llm.content);
    if (parsed && Array.isArray(parsed.actions)) {
      const actions = parsed.actions
        .map((action) => normalizeLlmAction(action, cards, today))
        .filter(Boolean)
        .slice(0, 20);
      if (actions.length) {
        return {
          summary: cleanWhitespace(parsed.summary) || describeActions(actions),
          source: "llm",
          actions,
          warnings: actions.filter((action) => action.unresolved).map(
            (action) => `No card matches “${action.cardTitle}”.`
          ),
          provider: llm.provider,
          model: llm.model,
          prompt: text,
        };
      }
    }
  }

  const fallback = offlinePlan({ text, cards, today });
  return {
    summary: describeActions(fallback.actions),
    source: "offline",
    actions: fallback.actions,
    warnings: fallback.warnings,
    provider: "offline",
    model: "local-template",
    prompt: text,
  };
}

function requirePlannedCard(db, tenantId, action) {
  if (!action.cardId) return null;
  const row = db
    .prepare(
      `SELECT id, task_no, title, version, column_key FROM cards
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
    )
    .get(action.cardId, tenantId);
  return row || null;
}

function requirePlannedSubtask(db, tenantId, action) {
  const byId = String(action.checklistItemId || "").trim();
  const byNo = normalizeTaskNo(action.taskNo || action.checklistItemId || "");
  if (byId) {
    const row = db
      .prepare(
        `SELECT ci.id, ci.card_id, ci.task_no, ci.text, ci.done
         FROM checklist_items ci
         JOIN cards c ON c.id = ci.card_id
         WHERE ci.id = ? AND ci.tenant_id = ? AND c.deleted_at IS NULL`
      )
      .get(byId, tenantId);
    if (row) return row;
  }
  if (!byNo) return null;
  return (
    db
      .prepare(
        `SELECT ci.id, ci.card_id, ci.task_no, ci.text, ci.done
         FROM checklist_items ci
         JOIN cards c ON c.id = ci.card_id
         WHERE ci.task_no = ? AND ci.tenant_id = ? AND c.deleted_at IS NULL`
      )
      .get(byNo, tenantId) || null
  );
}

/** Execute a plan. Every action is re-validated against the live board. */
export function applyPlan({ db, tenantId, plan }) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  if (!actions.length) throw new HttpError(400, "This plan has no actions to apply.");

  const results = [];
  let revision = getRevision(db, tenantId);
  // Actions inside one plan may touch the same card (add a subtask, then
  // complete it). Track the version our own writes produced so those chain,
  // while the first write for a card still enforces the planned version and
  // therefore still catches edits made from another device.
  const chainedVersions = new Map();
  const expectedVersion = (action, card) => chainedVersions.get(card.id) ?? action.cardVersion ?? card.version;
  const rememberVersions = (card) => {
    if (card?.id) chainedVersions.set(card.id, card.version);
  };

  for (const action of actions) {
    const result = {
      id: action.id,
      type: action.type,
      title: action.title || action.cardTitle || action.text || action.checklistText || "",
      ok: false,
      message: "",
    };
    try {
      if (action.type === "create") {
        const created = createCard(db, tenantId, {
          title: action.title,
          column: action.column || "todo",
          notes: action.notes,
          priority: action.priority,
          dueDate: action.dueDate || undefined,
        });
        revision = created.revision;
        result.card = created.card;
        for (const item of Array.isArray(action.checklist) ? action.checklist : []) {
          const added = addChecklistItem(db, tenantId, created.card.id, { text: item });
          revision = added.revision;
          result.card = added.card;
        }
        result.ok = true;
        result.message = `Created “${created.card.title}”.`;
      } else if (action.type === "update") {
        const card = requirePlannedCard(db, tenantId, action);
        if (!card) throw new HttpError(404, "That card no longer exists.");
        const patched = patchCard(db, tenantId, card.id, {
          ...action.patch,
          version: expectedVersion(action, card),
        });
        revision = patched.revision;
        rememberVersions(patched.card);
        result.card = patched.card;
        result.ok = true;
        result.message = `Updated “${patched.card.title}”.`;
      } else if (action.type === "complete") {
        const card = requirePlannedCard(db, tenantId, action);
        if (!card) throw new HttpError(404, "That card no longer exists.");
        if (card.column === "done") {
          result.ok = true;
          result.message = `“${card.title}” was already done.`;
        } else {
          const patched = patchCard(db, tenantId, card.id, {
            column: "done",
            version: expectedVersion(action, card),
          });
          revision = patched.revision;
          rememberVersions(patched.card);
          result.card = patched.card;
          result.ok = true;
          result.message = `Completed “${patched.card.title}”.`;
        }
      } else if (action.type === "delete") {
        const card = requirePlannedCard(db, tenantId, action);
        if (!card) throw new HttpError(404, "That card no longer exists.");
        const removed = softDeleteCard(db, tenantId, card.id);
        revision = removed.revision;
        result.ok = true;
        result.message = `Moved “${card.title}” to trash.`;
      } else if (action.type === "subtask_complete") {
        const item = requirePlannedSubtask(db, tenantId, action);
        if (!item) throw new HttpError(404, "That subtask no longer exists.");
        const card = requirePlannedCard(db, tenantId, { cardId: action.cardId || item.card_id });
        if (!card) throw new HttpError(404, "That card no longer exists.");
        result.taskNo = item.task_no || action.taskNo || "";
        if (item.done) {
          result.ok = true;
          result.message = `“${item.text}” was already done.`;
        } else {
          const patched = patchChecklistItem(db, tenantId, item.id, { done: true });
          revision = patched.revision;
          rememberVersions(patched.card);
          result.card = patched.card;
          result.ok = true;
          result.message = `Completed “${item.text}” on “${patched.card.title}”.`;
        }
      } else if (action.type === "subtask_update") {
        const item = requirePlannedSubtask(db, tenantId, action);
        if (!item) throw new HttpError(404, "That subtask no longer exists.");
        const text = stripWrapping(action.text);
        if (!text) throw new HttpError(400, "A subtask needs some text.");
        const patched = patchChecklistItem(db, tenantId, item.id, { text });
        revision = patched.revision;
        rememberVersions(patched.card);
        result.card = patched.card;
        result.taskNo = item.task_no || action.taskNo || "";
        result.ok = true;
        result.message = `Renamed “${item.text}” to “${text}” on “${patched.card.title}”.`;
      } else if (action.type === "subtask_delete") {
        const item = requirePlannedSubtask(db, tenantId, action);
        if (!item) throw new HttpError(404, "That subtask no longer exists.");
        const removed = deleteChecklistItem(db, tenantId, item.id);
        revision = removed.revision;
        rememberVersions(removed.card);
        result.card = removed.card;
        result.taskNo = item.task_no || action.taskNo || "";
        result.ok = true;
        result.message = `Removed “${item.text}” from “${removed.card.title}”.`;
      } else if (action.type === "subtask") {
        const card = requirePlannedCard(db, tenantId, action);
        if (!card) throw new HttpError(404, "That card no longer exists.");
        const text = stripWrapping(action.text);
        if (!text) throw new HttpError(400, "A subtask needs some text.");
        const added = addChecklistItem(db, tenantId, card.id, { text });
        revision = added.revision;
        rememberVersions(added.card);
        result.card = added.card;
        result.ok = true;
        result.message = `Added “${text}” to “${added.card.title}”.`;
      } else {
        throw new HttpError(400, `Unknown action type: ${action.type}`);
      }
    } catch (error) {
      result.ok = false;
      result.message =
        error instanceof HttpError ? error.message : error?.message || "Could not apply this action.";
    }
    results.push(result);
  }

  const applied = results.filter((entry) => entry.ok).length;
  const failed = results.length - applied;
  return {
    revision: getRevision(db, tenantId) || revision,
    applied,
    failed,
    partial: applied > 0 && failed > 0,
    results,
  };
}

export function saveActionRun(db, { tenantId, userId, prompt, plan, status = "planned", result = null, error = null }) {
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO ai_action_runs
       (id, tenant_id, user_id, prompt, source, status, plan, result, error, created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    userId || null,
    prompt,
    plan.source || "rules",
    status,
    JSON.stringify(plan).slice(0, 200_000),
    result ? JSON.stringify(result).slice(0, 200_000) : null,
    error ? String(error).slice(0, 2000) : null,
    createdAt,
    status === "applied" ? createdAt : null
  );
  return id;
}

export function updateActionRun(db, tenantId, runId, { status, result, error }) {
  db.prepare(
    `UPDATE ai_action_runs
       SET status = ?, result = ?, error = ?, applied_at = ?
     WHERE id = ? AND tenant_id = ?`
  ).run(
    status,
    result ? JSON.stringify(result).slice(0, 200_000) : null,
    error ? String(error).slice(0, 2000) : null,
    status === "applied" ? nowIso() : null,
    runId,
    tenantId
  );
}

export function serializeActionRun(row, { includePlan = true } = {}) {
  const plan = safeParse(row.plan);
  return {
    id: row.id,
    prompt: row.prompt,
    source: row.source,
    status: row.status,
    summary: plan?.summary || "",
    actions: includePlan ? plan?.actions || [] : [],
    actionCount: plan?.actions?.length || 0,
    result: safeParse(row.result),
    error: row.error,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function listActionRuns(db, tenantId, limit = 12) {
  return db
    .prepare(
      `SELECT * FROM ai_action_runs WHERE tenant_id = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(tenantId, Math.min(Math.max(Number(limit) || 12, 1), 50))
    .map((row) => serializeActionRun(row, { includePlan: false }));
}

export function getActionRun(db, tenantId, runId) {
  const row = db
    .prepare("SELECT * FROM ai_action_runs WHERE id = ? AND tenant_id = ?")
    .get(runId, tenantId);
  return row ? serializeActionRun(row) : null;
}
