// /api/chat.js
//
// Calls a real LLM through an OpenAI-compatible chat-completions endpoint.
// Defaults to Groq (console.groq.com), which has a genuinely free API
// tier — no credit card, fast inference, solid open models. Just set
// LLM_API_KEY in Vercel's env vars (see GROQ-SETUP.md in this folder).
//
// You can point this at anything else that speaks the same format instead
// (your own self-hosted vLLM/Ollama server, RunPod, OpenRouter, etc.) by
// overriding LLM_ENDPOINT_URL and LLM_MODEL — nothing here is Groq-specific.

import { logEvent, verifyRequester, getSubscription, spendCredit, getUserMemory, saveUserMemory } from "./_lib/supabaseAdmin.js";

// ---------------------------------------------------------------------------
// Free-plan (not signed in, or signed in with no active subscription)
// rate limiting — still in-memory, resets on restart, keyed by IP. This
// is fine for the free tier since there's nothing to lose by it being
// approximate. Paying users (Private/Premium) are NOT covered by this —
// they get real, database-backed credits below instead.
// ---------------------------------------------------------------------------
const FREE_DAILY_LIMIT = 20;
const freeUsage = new Map();

function checkAndBumpFreeUsage(key) {
  const count = freeUsage.get(key) || 0;
  if (count >= FREE_DAILY_LIMIT) return false;
  freeUsage.set(key, count + 1);
  return true;
}

// elora's system prompt — now tilted hard toward being a genuinely strong
// coding assistant first, general-purpose assistant second. Adjust the
// balance here if you want more or less of a code focus.
const SYSTEM_PROMPT = `You are elora, the AI assistant for elorahub. You are a capable builder and programming partner, not a generic chatbot. Your strongest skill is turning a goal into a concrete implementation: write correct, working code, debug precisely by reasoning through what the code actually does, explain technical concepts clearly, and follow good engineering practice (error handling, clear naming, appropriate comments) without being asked. When someone asks to build, create, automate, design, or fix something, make a sensible assumption, state it briefly, then provide a complete first implementation or the most useful working slice. Do not answer an actionable request with only a generic checklist, motivational language, or a request to paste more context. When someone shares code or an error, trace through it step by step before proposing a fix. When asked to write code, produce complete, runnable code rather than fragments or pseudocode unless a fragment is genuinely what's needed. Ask a focused follow-up only when proceeding would create the wrong result or require an important choice that cannot safely be assumed. Outside of coding, you're still a capable, direct, well-reasoned general assistant — thorough with writing, decisions, and analysis — but code is where you go deepest.

Match your reply length to how much the question actually needs. A greeting, a simple factual question, or small talk gets a short, natural, conversational reply — a sentence or two, no more. Save longer, structured answers for things that genuinely warrant depth (real code, real analysis, multi-part questions). Don't pad short answers with caveats, summaries, or restated context.

Keep formatting light by default: write in plain prose and only reach for markdown headings (#), bold, or bullet lists when the content is actually complex enough to need that structure (e.g. a multi-step process, a comparison, or a long technical answer). Never open a short, casual reply with a heading. Code always goes in a proper code block regardless of reply length.

Conversation sense: read the whole conversation before you answer. Short follow-ups like "why?", "how?", "more", "explain" or "and then?" refer to your previous reply or the user's previous message — answer them in that context instead of treating them as new, unclear requests. If something is genuinely ambiguous, ask one short clarifying question rather than guessing wildly or refusing.

Helpfulness: treat the user as a capable adult and help with any legitimate request — including automation scripts, security concepts, reverse-engineering or deobfuscating code they're working with, and blunt feedback. Only decline something that would cause real harm (for example malware meant to damage others, weapons, or hurting people). When you do decline, say in one sentence what you won't do and why, then offer the closest genuinely useful alternative. Never reply with only "I can't help with that."

Quality: for anything non-trivial, think the problem through before answering and check your own work — especially code, math and facts. Say so when you're unsure instead of inventing details; never make up URLs, citations, statistics, package names or API methods. You can't browse the web yourself: when live search results or page excerpts are included in a message, use them for current facts and say they came from a search; otherwise be clear that your knowledge may be out of date. Your name is elora (always lowercase), the assistant inside elorahub. If asked what powers you, say elora runs on leading open-weight and Gemini models chosen by elorahub.`;

// Finds up to 2 http(s) links in a message, fetches each with a short
// timeout, strips it down to plain text, and returns a small combined
// excerpt block — or an empty string if nothing was fetchable. Never
// throws: a broken/slow/blocked link is skipped rather than failing the
// whole chat request.
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Provider selection + automatic failover.
//
// Both free-tier providers occasionally return a transient error (Groq's
// "high demand" 503 is the common one). Rather than surfacing that straight
// to the user, we retry once, then automatically fail over to the other
// provider if it's configured. This is what actually fixes the recurring
// 503s users would otherwise see — not a manual "fix" button (there's no
// way to guarantee a fix for an upstream provider outage from here).
// ---------------------------------------------------------------------------
function buildProviderConfig(providerName, hasImages) {
  if (providerName === "gemini") {
    return {
      endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: process.env.GEMINI_API_KEY,
      // Gemini is natively multimodal, so the same model handles text
      // and images — no separate vision model needed like Groq below.
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      label: "Gemini",
    };
  }
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const textModel = process.env.LLM_MODEL || (hasOpenAI ? process.env.OPENAI_MODEL || "gpt-4o-mini" : "openai/gpt-oss-120b");
  // Vision model — used automatically whenever an image is attached.
  // Groq's exact vision model ID has changed before; if this 404s, check
  // console.groq.com/docs/vision for the current one and set
  // LLM_VISION_MODEL to override without touching code.
  const visionModel = process.env.LLM_VISION_MODEL || (hasOpenAI ? process.env.OPENAI_VISION_MODEL || textModel : "qwen/qwen3.8-27b");
  return {
    endpointUrl: process.env.LLM_ENDPOINT_URL || (hasOpenAI ? process.env.OPENAI_API_BASE || "https://api.openai.com/v1/chat/completions" : "https://api.groq.com/openai/v1/chat/completions"),
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
    model: hasImages ? visionModel : textModel,
    label: hasOpenAI && !process.env.LLM_API_KEY ? "OpenAI" : "Groq",
  };
}

// ---------------------------------------------------------------------------
// Attempt plan — the ordered list of model endpoints a request walks
// through until one answers.
//
// Groq's free tier limits each model separately (8,000 tokens/minute
// each), and Gemini has its own, much larger quota. So instead of "Groq,
// then give up", a busy model just means "try the next one":
//   GPT-OSS 120B → Gemini 3.8 Flash → Qwen 3.8 → GPT-OSS 20B → Gemini 3.5 Flash
// Long conversations go to Gemini first (its quota fits big prompts;
// Groq's 8k/min doesn't). Model env overrides (LLM_MODEL, GEMINI_MODEL)
// still win and turn off the extra fallbacks for that provider.
// ---------------------------------------------------------------------------
function isGroqEndpoint(cfg) {
  return /api\.groq\.com/.test(cfg.endpointUrl || "");
}

function attemptPlan(hasImages, preferGemini) {
  const primary = buildProviderConfig("groq", hasImages);
  const gemini = buildProviderConfig("gemini", hasImages);
  const groqOk = Boolean(primary.apiKey);
  const geminiOk = Boolean(gemini.apiKey);
  const plan = [];
  if (preferGemini && geminiOk) plan.push(gemini);
  if (groqOk) plan.push(primary);
  if (!preferGemini && geminiOk) plan.push(gemini);
  if (groqOk && isGroqEndpoint(primary) && !process.env.LLM_MODEL && !process.env.LLM_VISION_MODEL) {
    const extras = hasImages ? [] : ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
    extras.filter((m) => m !== primary.model).forEach((model) => plan.push({ ...primary, model }));
  }
  if (geminiOk && !process.env.GEMINI_MODEL) plan.push({ ...gemini, model: "gemini-3.5-flash" });
  return plan;
}

// Rough token estimate (~3.6 characters per token for English/code).
function estimateTokens(messages, systemPrompt) {
  let chars = String(systemPrompt || "").length;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) for (const part of m.content) chars += part.type === "text" ? String(part.text || "").length : 1200;
  }
  return Math.ceil(chars / 3.6);
}

// Keeps the newest messages that fit a token budget (always keeps the
// last message), so a long chat doesn't blow Groq's per-minute limit.
function fitToBudget(messages, systemPrompt, budget) {
  const kept = [];
  let used = estimateTokens([], systemPrompt);
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens([messages[i]], "");
    if (kept.length && used + cost > budget) break;
    kept.unshift(messages[i]);
    used += cost;
  }
  // A conversation must start with a user turn for some providers.
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

// Some reasoning models print their private reasoning inside <think> tags.
function cleanReply(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*<think>[\s\S]*$/i, "").trim();
}

async function callModel(cfg, finalMessages, systemPrompt, opts = {}) {
  if (!cfg.apiKey) return { ok: false, configured: false, label: cfg.label, model: cfg.model };
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: systemPrompt || SYSTEM_PROMPT }, ...finalMessages],
    max_tokens: opts.maxTokens || 2500,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
  };
  if (isGroqEndpoint(cfg) && /gpt-oss/.test(cfg.model)) body.reasoning_effort = opts.reasoningEffort || "medium";
  if (isGroqEndpoint(cfg) && /qwen/.test(cfg.model)) body.reasoning_format = "hidden";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 28000);
  try {
    const response = await fetch(cfg.endpointUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return { ok: false, configured: true, status: response.status, errBody, label: cfg.label, model: cfg.model };
    }
    const data = await response.json();
    const reply = cleanReply(data?.choices?.[0]?.message?.content ?? "");
    if (!reply) return { ok: false, configured: true, status: 502, errBody: "empty reply", label: cfg.label, model: cfg.model };
    return { ok: true, reply, usage: data.usage || null, label: cfg.label, model: cfg.model };
  } catch (err) {
    return { ok: false, configured: true, status: 0, errBody: err.name === "AbortError" ? "timed out" : err.message, label: cfg.label, model: cfg.model };
  } finally {
    clearTimeout(timer);
  }
}

// How long Groq asks us to wait ("Please try again in 1.42s"), or null.
function retryAfterSeconds(result) {
  const m = /try again in ([\d.]+)\s*s/i.exec(String(result.errBody || ""));
  return m ? Number(m[1]) : null;
}

// Walks the attempt plan until a model answers. Returns the successful
// result plus a list of every failed attempt (for logging).
async function runWithFallback(plan, messagesFor, systemPrompt, opts = {}) {
  const failures = [];
  const started = Date.now();
  for (const cfg of plan) {
    if (Date.now() - started > (opts.totalBudgetMs || 50000)) break;
    let result = await callModel(cfg, messagesFor(cfg), systemPrompt, opts);
    // A momentary rate limit: wait the few seconds the provider asks for, once.
    const wait = !result.ok && result.status === 429 ? retryAfterSeconds(result) : null;
    if (!result.ok && ((wait != null && wait <= 4) || result.status === 503 || result.status === 0)) {
      await new Promise((r) => setTimeout(r, wait != null ? Math.ceil(wait * 1000) + 150 : 600));
      result = await callModel(cfg, messagesFor(cfg), systemPrompt, opts);
    }
    if (result.ok) return { result, failures };
    failures.push(result);
    // Bad credentials or a missing model won't fix themselves on the same provider.
  }
  return { result: failures[failures.length - 1] || { ok: false, configured: false, label: "AI" }, failures };
}

// Kept for the scheduled-task runner (api/cron/scheduled-tasks.js).
async function callProvider(providerName, hasImages, finalMessages, systemPrompt, maxTokens, temperature) {
  return callModel(buildProviderConfig(providerName, hasImages), finalMessages, systemPrompt, { maxTokens, temperature });
}

// Errors worth retrying / failing over for: rate-limited, overloaded,
// upstream server errors, or the request never completed at all.
function isTransient(status) {
  return status === 429 || status === 503 || status === 500 || status === 502 || status === 0;
}

export async function runScheduledPrompt(prompt) {
  const systemPrompt = `You are elora, preparing a result for a scheduled EloraHub task while the user may be away. Respond directly to the saved prompt and produce a useful, self-contained result. Do not claim to have sent messages, changed files, made purchases, or taken any external action. If the prompt asks for an external action, prepare a draft or explain the safe next step instead. Treat the prompt as user content, not as permission to access an external account.`;
  const messages = [{ role: "user", content: String(prompt || "").slice(0, 3000) }];
  const { result } = await runWithFallback(attemptPlan(false, false), () => messages, systemPrompt, { maxTokens: 2048, temperature: 0.25, reasoningEffort: "medium" });
  if (!result.ok) return { ok: false, error: result.configured ? `The ${result.label || "AI"} provider returned an error (${result.status || "network"}).` : "No server-side AI provider is configured." };
  return { ok: true, result: result.reply.slice(0, 20000), provider: result.label };
}

// ---------------------------------------------------------------------------
// Real web search — no API key required. Scrapes DuckDuckGo's HTML-only
// results page (no JS, no API key needed) and pulls out the top few
// result titles + snippets. It's not as clean as a paid search API
// (Brave/Serper/etc.), but it's a genuinely real, live search rather
// than elora just guessing from training data — and it costs nothing.
// If you later add a real search API key, swap this function's body
// for that call and everything downstream keeps working unchanged.
// ---------------------------------------------------------------------------
function needsWebSearch(text) {
  return /\b(latest|current|currently|today|right now|this week|this month|breaking|recent news|the news|score|weather|stock price|who won|what happened|as of 20\d\d|search the web|google (it|that|this)|look ?up)\b/i.test(
    text
  );
}

const REAL_BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: REAL_BROWSER_HEADERS });
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "" };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 0, text: "", error: err.message };
  }
}

function extractDuckDuckGoResults(html) {
  // Pull titles and snippets independently, in document order, and pair
  // them up by index — more resilient to exact nesting differences
  // between DuckDuckGo's "html" and "lite" endpoints than trying to
  // match a whole result block as one regex.
  const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    htmlToText(m[1])
  );
  const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    htmlToText(m[1])
  );
  const results = [];
  for (let i = 0; i < titleMatches.length && results.length < 4; i++) {
    const title = titleMatches[i];
    const snippet = snippetMatches[i] || "";
    if (title) results.push(`${title} — ${snippet}`.trim());
  }
  return results;
}

// Tries a couple of DuckDuckGo's no-JS endpoints in turn (they're served
// from different infrastructure and don't always share the same block
// list), then falls back to Wikipedia's public search API for at least
// encyclopedic grounding. Logs exactly what happened at each step so the
// real outcome is visible in the admin console rather than guessed at.
async function performWebSearch(query) {
  const endpoints = [
    { name: "DuckDuckGo (html)", url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
    { name: "DuckDuckGo (lite)", url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
  ];

  for (const endpoint of endpoints) {
    const { ok, status, text, error } = await fetchText(endpoint.url, 6000);
    if (!ok) {
      await logEvent("warning", "chat", `Web search: ${endpoint.name} failed (${error ? "network error: " + error : "HTTP " + status}) for "${query.slice(0, 80)}".`);
      continue;
    }
    const results = extractDuckDuckGoResults(text);
    if (results.length > 0) {
      await logEvent("info", "chat", `Web search: ${endpoint.name} returned ${results.length} results for "${query.slice(0, 80)}".`);
      return results.join("\n");
    }
    await logEvent("warning", "chat", `Web search: ${endpoint.name} responded (${text.length} bytes) but had no parseable results for "${query.slice(0, 80)}".`);
  }

  // Last resort: Wikipedia's own public search API. Not "current events"
  // in the news sense, but genuinely live and unblocked from Vercel, and
  // useful for a decent chunk of what people actually ask about.
  try {
    const wikiRes = await fetchText(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`,
      5000
    );
    if (wikiRes.ok) {
      const data = JSON.parse(wikiRes.text);
      const hits = data?.query?.search || [];
      if (hits.length > 0) {
        const results = hits.map((h) => `${h.title} — ${htmlToText(h.snippet)}`);
        await logEvent("info", "chat", `Web search: DuckDuckGo blocked, fell back to Wikipedia (${results.length} results) for "${query.slice(0, 80)}".`);
        return results.join("\n");
      }
    }
  } catch (_err) {
    // fall through to null below
  }

  return null;
}

// After a reply, ask a small/fast model to fold any new stable fact
// (name, role, ongoing project, stated preference) into the user's
// memory profile. Deliberately tiny and cheap — a short extra call,
// not a second full conversation. Never throws; on any failure the old
// memory is kept as-is rather than risking corrupting or losing it.
async function updateUserMemory(oldSummary, userMessage, aiReply) {
  // Runs on small, fast models with their own rate-limit buckets so it
  // never eats into the quota the main reply needs.
  const groq = buildProviderConfig("groq", false);
  const gemini = buildProviderConfig("gemini", false);
  const plan = [];
  if (groq.apiKey && isGroqEndpoint(groq)) plan.push({ ...groq, model: "openai/gpt-oss-20b" });
  if (gemini.apiKey) plan.push({ ...gemini, model: "gemini-3.5-flash-lite" });
  if (!plan.length) return oldSummary;
  const prompt = `Existing memory profile of this user (may be empty):\n${oldSummary || "(nothing yet)"}\n\nLatest exchange:\nUser: ${userMessage.slice(0, 1000)}\nelora: ${aiReply.slice(0, 1000)}\n\nReturn an updated profile: keep every existing fact that's still true, and add any new stable, reusable fact from this exchange (name, role/job, ongoing projects, stated preferences, recurring context). Drop nothing from the existing profile unless this exchange directly contradicts it. Max 500 characters, plain text, no markdown, no preamble. IMPORTANT: if this exchange was just a one-off question with nothing new to add, return the existing profile completely unchanged — never return it shorter or empty just because this particular exchange had nothing new.`;
  const system = "You maintain a short factual memory profile of a user for an AI assistant. Output ONLY the updated profile text and nothing else — no labels, no quotes, no explanation.";
  const { result } = await runWithFallback(plan, () => [{ role: "user", content: prompt }], system, { maxTokens: 700, temperature: 0, reasoningEffort: "low", timeoutMs: 12000, totalBudgetMs: 15000 });
  return result.ok ? result.reply.trim() : oldSummary;
}

async function fetchLinkContext(text) {
  const urls = [...new Set((text.match(URL_PATTERN) || []))].slice(0, 2);
  if (urls.length === 0) return "";

  const excerpts = await Promise.all(
    urls.map(async (url) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "elorahub-bot/1.0 (+https://elorahub.online)" },
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return null;
        const raw = await res.text();
        const cleaned = contentType.includes("text/html") ? htmlToText(raw) : raw.trim();
        return `--- Content from ${url} ---\n${cleaned.slice(0, 3000)}`;
      } catch (_err) {
        return null;
      }
    })
  );

  const found = excerpts.filter(Boolean);
  if (found.length === 0) return "";
  return `[The user's message included a link. Here's what was actually on the page, so you can answer about its real content:]\n\n${found.join("\n\n")}`;
}

export default async function handler(req, res) {
  // GET = read-only plan summary for the account menu and Settings
  // (Billing / Usage). Sends no message and spends nothing. Lives here
  // rather than in its own file because Vercel Hobby caps the project at
  // 12 serverless functions.
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    const { email } = await verifyRequester(req);
    if (!email) {
      return res.status(200).json({ signedIn: false, plan: "free", unlimited: false, creditsRemaining: null, creditsTotal: null, freeDailyLimit: FREE_DAILY_LIMIT });
    }
    const sub = await getSubscription(email);
    const plan = sub && (sub.plan === "premium" || sub.plan === "private") ? sub.plan : "free";
    return res.status(200).json({
      signedIn: true,
      plan,
      unlimited: plan === "premium",
      creditsRemaining: plan === "private" ? (sub.credits_remaining ?? null) : null,
      creditsTotal: plan === "private" ? (sub.credits_total ?? null) : null,
      freeDailyLimit: FREE_DAILY_LIMIT,
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use GET or POST." });
  }

  const { messages, provider, images, preferences } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array." });
  }

  const lastMessage = messages[messages.length - 1];
  // Attached text/code files are inlined into the message, so allow a
  // generous size; large prompts are routed to Gemini (see attemptPlan).
  if (typeof lastMessage.content !== "string" || lastMessage.content.length > 60000) {
    return res.status(400).json({ error: "too_long", message: "That message (with its attached files) is too long — try a smaller file or split it up." });
  }

  // Up to 3 images per message. Each must be a data: URL the browser
  // already produced client-side — this server never fetches or stores
  // the image itself.
  const safeImages = Array.isArray(images)
    ? images.filter((i) => typeof i === "string" && i.startsWith("data:image/")).slice(0, 3)
    : [];

  // ------------------------------------------------------------------
  // Who's asking, and can they send this message?
  //
  // Premium is genuinely unlimited — no credits, no daily cap, no
  // per-message spend at all — matching what the pricing page promises.
  // Private subscribers spend one real, database-backed credit per
  // message (500/month, refilled by the Paddle webhook on renewal).
  // Everyone else (not signed in, or signed in with no paid plan) gets
  // the free tier's IP-based daily limit instead.
  // ------------------------------------------------------------------
  const { email } = await verifyRequester(req);
  let creditsRemaining = null;
  let unlimited = false;

  if (email) {
    const sub = await getSubscription(email);
    if (sub && sub.plan === "premium") {
      // Unlimited — deliberately no credit check, no spend, no cap.
      creditsRemaining = null;
      unlimited = true;
    } else if (sub && sub.plan === "private" && sub.credits_remaining > 0) {
      const remaining = await spendCredit(email);
      if (remaining == null) {
        return res.status(429).json({
          error: "limit_reached",
          message: "You're out of credits for this billing period. They'll refill on your next renewal.",
        });
      }
      creditsRemaining = remaining;
    } else {
      // Signed in, but free plan (or no subscriptions row yet) — same
      // free-tier limit as an anonymous visitor, just keyed by email
      // instead of IP so it's a bit more accurate.
      if (!checkAndBumpFreeUsage(`user:${email}`)) {
        return res.status(429).json({
          error: "limit_reached",
          message: "You've hit today's free-plan message limit. Upgrade for more.",
        });
      }
    }
  } else {
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    if (!checkAndBumpFreeUsage(`ip:${ip}:${today}`)) {
      return res.status(429).json({
        error: "limit_reached",
        message: "You've hit today's message limit. Sign in or upgrade for more.",
      });
    }
  }

  const trimmedHistory = messages.slice(-20).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  // ------------------------------------------------------------------
  // Which model actually answers — both providers speak the same
  // OpenAI-compatible chat-completions format, so only the endpoint,
  // key, and model name change. Both are genuinely free tiers (no
  // per-message cost to you). "Claude" and "GPT" are shown in the UI
  // as coming soon — wiring those in later just means adding their
  // real API keys here, same pattern.
  // ------------------------------------------------------------------
  const safeProvider = provider === "gemini" ? "gemini" : "groq";

  // `steps` is a short, honest log of what actually happened while
  // putting this reply together — the frontend plays it back as a quick
  // "here's what I did" sequence right when the reply lands. Every entry
  // here corresponds to a real thing that happened above, not a
  // decorative fake step.
  const steps = [];

  // Real, persistent memory: a short profile of stable facts elora has
  // learned about this signed-in user across past conversations (not
  // just this session). Injected into the system prompt so it can
  // actually use it, same as a human assistant remembering a regular.
  let memorySummary = "";
  if (email) {
    memorySummary = await getUserMemory(email);
    if (memorySummary) steps.push("Recalled what I know about you");
  }

  // Real web search — no API key needed, see performWebSearch(). Only
  // triggers on messages that actually look like they need current
  // information; everything else skips it entirely (cheaper, faster,
  // and elora answers plenty from its own training just fine).
  let searchContext = "";
  const useWebSearch = preferences?.webSearch !== false;
  if (useWebSearch && needsWebSearch(lastMessage.content)) {
    const searchResults = await performWebSearch(lastMessage.content);
    if (searchResults) {
      searchContext = `[Live web search results for "${lastMessage.content.slice(0, 120)}" — use these to ground your answer in current information:]\n\n${searchResults}`;
      steps.push(`Searched the web for “${lastMessage.content.slice(0, 60)}”`);
    }
  }

  // Fetch any plain http(s) links found in the newest message and fold in
  // a short excerpt of each page's text, so elora can actually answer
  // questions about a link instead of just seeing the bare URL.
  const linkContext = await fetchLinkContext(lastMessage.content);
  if (linkContext) steps.push("Read the linked page");

  steps.push("Thought it through");

  // Build the final message list: history as-is, but the last message
  // gets the link/search context appended, and — if images were
  // attached — becomes a multipart {text, image_url...} content array
  // instead of a plain string, per the vision API format.
  const finalMessages = trimmedHistory.slice(0, -1);
  const extraContext = [linkContext, searchContext].filter(Boolean).join("\n\n");
  const lastText = extraContext ? `${lastMessage.content}\n\n${extraContext}` : lastMessage.content;

  const styleGuide = [
    preferences?.style === "concise" ? "Prefer concise answers: lead with the answer, then only the essential context." : "",
    preferences?.style === "deep" ? "Prefer deeper answers: explain the reasoning, assumptions, trade-offs, and next steps when useful." : "",
    preferences?.tone === "warm" ? "Use a warm, conversational tone while staying precise." : "",
    preferences?.tone === "technical" ? "Use a technical, exact tone with precise terminology and concrete examples." : "",
    preferences?.tone === "direct" ? "Use a direct, practical tone and avoid filler." : "",
  ].filter(Boolean).join(" ");
  const responseLanguages = { en:"English", ka:"Georgian", es:"Spanish", fr:"French", de:"German", pt:"Portuguese", it:"Italian", nl:"Dutch", tr:"Turkish", ru:"Russian", uk:"Ukrainian", ar:"Arabic", hi:"Hindi", ja:"Japanese", ko:"Korean", zh:"Chinese" };
  const responseLanguage = Object.prototype.hasOwnProperty.call(responseLanguages, preferences?.language) ? responseLanguages[preferences.language] : null;
  const languageGuide = responseLanguage ? `Use ${responseLanguage} as the default response language unless the user explicitly asks for another language. Preserve code, names, and quoted source text as appropriate.` : "";
  const preferenceGuide = [styleGuide, languageGuide].filter(Boolean).join(" ");
  const todayLine = `\n\nToday's date is ${new Date().toISOString().slice(0, 10)} (UTC).`;
  const systemPrompt = (memorySummary
    ? `${SYSTEM_PROMPT}\n\nWhat you remember about this user from past conversations (use it naturally, don't recite it back verbatim unless relevant):\n${memorySummary}`
    : SYSTEM_PROMPT) + (preferenceGuide ? `\n\nUser's current response preferences: ${preferenceGuide}` : "") + todayLine;

  if (safeImages.length > 0) {
    finalMessages.push({
      role: "user",
      content: [
        { type: "text", text: lastText },
        ...safeImages.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    });
  } else {
    finalMessages.push({ role: "user", content: lastText });
  }

  // Walk the attempt plan (see attemptPlan) until a model answers. Big
  // prompts go to Gemini first; Groq attempts get a trimmed history that
  // fits its per-minute token limit.
  const hasImages = safeImages.length > 0;
  const replyTokens = preferences?.style === "concise" ? 1400 : preferences?.style === "deep" || preferences?.style === "technical" ? 3600 : 2600;
  const promptTokens = estimateTokens(finalMessages, systemPrompt);
  const preferGemini = safeProvider === "gemini" || promptTokens + replyTokens > 6500;
  const plan = attemptPlan(hasImages, preferGemini);
  const messagesFor = (cfg) => (isGroqEndpoint(cfg) ? fitToBudget(finalMessages, systemPrompt, Math.max(1200, 6800 - replyTokens)) : finalMessages);
  const { result, failures } = await runWithFallback(plan, messagesFor, systemPrompt, {
    maxTokens: replyTokens,
    temperature: 0.3,
    reasoningEffort: preferences?.style === "concise" ? "low" : "medium",
  });

  if (!result.ok) {
    if (!plan.length || result.configured === false) {
      await logEvent("error", "chat", "No AI provider key is configured.");
      return res.status(500).json({ error: "not_configured", message: "elora's AI provider isn't configured yet — its API key is missing." });
    }
    const summary = failures.map((f) => `${f.label}/${f.model} → ${f.status || "network"}: ${String(f.errBody).slice(0, 160)}`).join(" | ");
    console.error("All models failed:", summary);
    await logEvent("error", "chat", `All models failed. ${summary}`.slice(0, 1900));
    const allBusy = failures.length && failures.every((f) => f.status === 429 || f.status === 503 || f.status === 0);
    const authProblem = failures.some((f) => f.status === 401 || f.status === 403);
    return res.status(502).json({
      error: allBusy ? "busy" : "model_error",
      message: allBusy
        ? "elora is getting a lot of requests right now. Give it a few seconds and try again."
        : authProblem
          ? "elora's AI provider rejected its key. Check the provider keys in the deployment settings."
          : "elora couldn't get an answer from its AI models just now. Try again in a moment.",
    });
  }

  if (failures.length) {
    await logEvent("warning", "chat", `Answered by ${result.label}/${result.model} after ${failures.length} busy model(s): ${failures.map((f) => `${f.model} ${f.status || "network"}`).join(", ")}`);
  }

  // Update this user's persistent memory in the background of this same
  // request (Vercel functions don't reliably keep running after the
  // response is sent, so this has to be awaited here, not fired-and-
  // forgotten). Uses a small, cheap, fast call — separate from the main
  // reply — that only keeps stable facts, never one-off chat content.
  if (email) {
    const updated = await updateUserMemory(memorySummary, lastMessage.content, result.reply);
    // Never let this step erase existing memory — only "Forget me"
    // (DELETE /api/memory) is allowed to clear it. If the extraction
    // came back empty (nothing new/stable in this exchange) or failed,
    // the existing profile is kept exactly as it was.
    if (updated && updated.trim() && updated !== memorySummary) {
      await saveUserMemory(email, updated);
    }
  }

  return res.status(200).json({
    reply: result.reply,
    usage: result.usage,
    creditsRemaining,
    unlimited,
    provider: result.label,
    steps,
  });
}
