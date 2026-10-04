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

import { safeFetch, readablePage, frameable, searchWeb } from "./_lib/browse.js";
import { handleImage, rewriteImageLinks } from "./_lib/images.js";
import { CAPABILITIES, pickSkills, skillGuide, isHeavy, prefersGemini } from "./_lib/skills.js";
import { research, readLinks, sourcesContext, appendSources, wantsResearch, hostOf, searchDiag } from "./_lib/research.js";
import { normalizeMode, codeModeGuide, CODE_REVIEW_SYSTEM, studioModeGuide, AGENT_PLAN_GUIDE, AGENT_STEP_GUIDE } from "./_lib/modes.js";

// Live progress: when the browser asks for it (body.stream), the reply is
// sent as newline-delimited JSON — {"type":"step"} lines while elora works,
// then one {"type":"final","status","body"} line with the normal response.
function streamingResponse(res) {
  let started = false, ended = false, beat = null;
  const begin = () => {
    if (started) return;
    started = true;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    try { if (res.flushHeaders) res.flushHeaders(); } catch (_e) {}
    beat = setInterval(() => { if (!ended) { try { res.write('{"type":"ping"}\n'); } catch (_e) {} } }, 8000);
  };
  const write = (obj) => { if (ended) return; begin(); try { res.write(JSON.stringify(obj) + "\n"); } catch (_e) {} };
  const finish = () => { ended = true; if (beat) clearInterval(beat); };
  return {
    isStream: true,
    _code: 200,
    setHeader(k, v) { if (!started) res.setHeader(k, v); return this; },
    status(code) { this._code = code; return this; },
    json(body) { write({ type: "final", status: this._code, body }); finish(); res.end(); return this; },
    end(b) { if (!ended) { begin(); finish(); res.end(b); } return this; },
    progress(text) { if (text) write({ type: "step", text: String(text).slice(0, 200) }); },
  };
}
function prettyModel(m) {
  m = String(m || "");
  if (/gpt-oss-120b/.test(m)) return "GPT-OSS 120B";
  if (/gpt-oss-20b/.test(m)) return "GPT-OSS 20B";
  if (/qwen/i.test(m)) return "Qwen";
  const g = /gemini-([\d.]+)-flash(-lite)?/.exec(m);
  if (g) return `Gemini ${g[1]} Flash${g[2] ? "-Lite" : ""}`;
  return m.split("/").pop();
}
function sanitizeSources(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && typeof x.url === "string" && /^https?:\/\//i.test(x.url)).slice(0, 40)
    .map((x) => ({ title: cleanText(x.title, 140) || hostOf(x.url), url: String(x.url).slice(0, 500), site: hostOf(x.url), read: Boolean(x.read), excerpt: "" }));
}
import { logEvent, verifyRequester, getSubscription, spendCredit, getUserMemory, saveUserMemory } from "./_lib/supabaseAdmin.js";
import { createHmac, timingSafeEqual } from "node:crypto";

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
const SYSTEM_PROMPT = `You are elora, the AI assistant for elorahub — a senior engineer, product designer, writer and analyst in one. You build complete, working, beautiful things: websites, apps, games, scripts, backends, bots, pictures, videos, diagrams, logos and documents. Be ambitious and creative: make confident design and product decisions, add the details a top professional would add, and deliver the finished thing in one reply rather than a plan or a skeleton. Your strongest skill is turning a goal into a concrete implementation: write correct, working code, debug precisely by reasoning through what the code actually does, explain technical concepts clearly, and follow good engineering practice (error handling, clear naming, appropriate comments) without being asked. When someone asks to build, create, automate, design, or fix something, make a sensible assumption, state it briefly, then provide a complete first implementation or the most useful working slice. Do not answer an actionable request with only a generic checklist, motivational language, or a request to paste more context. When someone shares code or an error, trace through it step by step before proposing a fix. When asked to write code, produce complete, runnable code rather than fragments or pseudocode unless a fragment is genuinely what's needed. Ask a focused follow-up only when proceeding would create the wrong result or require an important choice that cannot safely be assumed. Outside of coding, you're still a capable, direct, well-reasoned general assistant — thorough with writing, decisions, and analysis — but code is where you go deepest.

Match your reply length to how much the question actually needs. A greeting, a simple factual question, or small talk gets a short, natural, conversational reply — a sentence or two, no more. Save longer, structured answers for things that genuinely warrant depth (real code, real analysis, multi-part questions). Don't pad short answers with caveats, summaries, or restated context.

Keep formatting light by default: write in plain prose and only reach for markdown headings (#), bold, or bullet lists when the content is actually complex enough to need that structure (e.g. a multi-step process, a comparison, or a long technical answer). Never open a short, casual reply with a heading. Code always goes in a proper code block regardless of reply length.

Conversation sense: read the whole conversation before you answer. Short follow-ups like "why?", "how?", "more", "explain" or "and then?" refer to your previous reply or the user's previous message — answer them in that context instead of treating them as new, unclear requests. If something is genuinely ambiguous, ask one short clarifying question rather than guessing wildly or refusing.

Helpfulness: treat the user as a capable adult and help with any legitimate request — including automation scripts, security concepts, reverse-engineering or deobfuscating code they're working with, and blunt feedback. Only decline something that would cause real harm (for example malware meant to damage others, weapons, or hurting people). When you do decline, say in one sentence what you won't do and why, then offer the closest genuinely useful alternative. Never reply with only "I can't help with that."

Quality: for anything non-trivial, think the problem through before answering and check your own work — especially code, math and facts. Say so when you're unsure instead of inventing details; never make up URLs, citations, statistics, package names or API methods. You can't browse the web yourself: when live search results or page excerpts are included in a message, use them for current facts and say they came from a search; otherwise be clear that your knowledge may be out of date. Your name is elora (always lowercase), the assistant inside elorahub. If asked what powers you, say elora runs on leading open-weight and Gemini models chosen by elorahub.

About elorahub (use this when people ask how the app works; don't recite it unprompted): the sidebar has four workspaces, each with its own chats: Chat (everyday questions, with live web research and cited sources), Code (complete projects, a Workbench with tabs, live preview, version changes, Run and ZIP, plus a double-check pass), Studio (pictures, posters, thumbnails, social posts, videos, GIFs and logos, with type, format, style and variation settings above the message box) and Agent (give it a goal: it plans, searches the web, reads the sources and delivers a cited result step by step). Reply modes are Balanced, Quick, Deep dive and Code. Task mode (the Task button beside +, or + → Run as a task) makes you plan a bigger job in 2–6 steps, work through them one at a time with web searches where needed, and hand back downloadable files; it shows a live trail and a Progress panel, and uses one message from the allowance. Uploads: images up to 3 MB and text or source-code files up to 200 KB (the first ~30,000 characters are read); PDFs and Word files are attached by name only for now. Hovering a reply lets people copy, rate, save to Artifacts, or get a different answer; ↑ in an empty box edits the last message; the send button becomes Stop while you reply. Settings (Ctrl+,): Account (what to call them, their work, custom instructions), General (theme, font, text size, width), Privacy (memory on/off, export or clear chats), Usage (remaining messages), Capabilities (web search, reading links, Task mode, suggestions, style and tone), Connectors (GitHub, Google). Plans: Free has a daily message limit, Private gives far more room, Premium is unlimited; paid plans can be cancelled any time and stay active until the end of the billing period. The site has a Help center and a What's new page. If you don't know something about elorahub, say so rather than guessing.

${CAPABILITIES}

Hard problems: slow down. Restate what's really being asked, work through it step by step, check edge cases and your own arithmetic or logic before answering, and if something is ambiguous pick the most sensible reading and say which one you chose.`;



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
  // A second Gemini model: when the main one is overloaded, big jobs try it
  // before falling back to Groq (whose 8k/min limit can't fit a whole site).
  const geminiAlt = geminiOk && !process.env.GEMINI_MODEL && gemini.model !== "gemini-3.5-flash" ? { ...gemini, model: "gemini-3.5-flash" } : null;
  if (preferGemini && geminiOk) { plan.push(gemini); if (geminiAlt) plan.push(geminiAlt); }
  if (groqOk) plan.push(primary);
  if (!preferGemini && geminiOk) plan.push(gemini);
  if (groqOk && isGroqEndpoint(primary) && !process.env.LLM_MODEL && !process.env.LLM_VISION_MODEL) {
    const extras = hasImages ? [] : ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
    extras.filter((m) => m !== primary.model).forEach((model) => plan.push({ ...primary, model }));
  }
  if (!preferGemini && geminiAlt) plan.push(geminiAlt);
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
  const maxTokens = typeof opts.maxTokens === "function" ? opts.maxTokens(cfg, finalMessages, systemPrompt) : opts.maxTokens || 2500;
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: systemPrompt || SYSTEM_PROMPT }, ...finalMessages],
    max_tokens: maxTokens,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
  };
  if (isGroqEndpoint(cfg) && /gpt-oss/.test(cfg.model)) body.reasoning_effort = opts.reasoningEffort || "medium";
  if (isGroqEndpoint(cfg) && /qwen/.test(cfg.model)) body.reasoning_format = opts.wantReasoning ? "parsed" : "hidden";
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
    const choice = data?.choices?.[0] || {};
    const raw = String(choice.message?.content ?? "");
    const inlineThought = /<think>([\s\S]*?)<\/think>/i.exec(raw);
    const reasoning = String(choice.message?.reasoning || choice.message?.reasoning_content || (inlineThought ? inlineThought[1] : "")).trim();
    const reply = cleanReply(raw);
    if (!reply) return { ok: false, configured: true, status: 502, errBody: choice.finish_reason === "length" ? "ran out of tokens while thinking" : "empty reply", label: cfg.label, model: cfg.model };
    return { ok: true, reply, reasoning, finish: choice.finish_reason || "stop", usage: data.usage || null, label: cfg.label, model: cfg.model };
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
  const budget = opts.totalBudgetMs || 50000;
  // Each call gets at most the time that's left, so the whole walk fits the
  // budget (and the function's time limit).
  const callOpts = () => ({ ...opts, timeoutMs: Math.max(6000, Math.min(opts.timeoutMs || 28000, budget - (Date.now() - started))) });
  for (const cfg of plan) {
    if (Date.now() - started > budget - 4000) break;
    if (failures.length && typeof opts.onSwitch === "function") opts.onSwitch(cfg, failures[failures.length - 1]);
    let result = await callModel(cfg, messagesFor(cfg), systemPrompt, callOpts());
    // A momentary rate limit: wait the few seconds the provider asks for, once.
    // A call that timed out isn't retried on the same model — the next one gets the time.
    const wait = !result.ok && result.status === 429 ? retryAfterSeconds(result) : null;
    const timedOut = !result.ok && result.status === 0 && result.errBody === "timed out";
    if (!result.ok && !timedOut && Date.now() - started < budget - 8000 && ((wait != null && wait <= 4) || result.status === 503 || result.status === 0)) {
      await new Promise((r) => setTimeout(r, wait != null ? Math.ceil(wait * 1000) + 150 : result.status === 503 ? 1500 : 600));
      result = await callModel(cfg, messagesFor(cfg), systemPrompt, callOpts());
    }
    if (result.ok) return { result, failures };
    failures.push(result);
    // Bad credentials or a missing model won't fix themselves on the same provider.
  }
  return { result: failures[failures.length - 1] || { ok: false, configured: false, label: "AI" }, failures };
}

// Long answers: when a model stops because it hit its token cap, ask for
// the rest (Gemini first — its quota fits the long prompt) and stitch the
// pieces together, so hard questions don't end mid-sentence.
function joinContinuation(head, tail) {
  let t = String(tail || "").replace(/^\s*(continuing|continued)[^\n]*\n+/i, "");
  const window = head.slice(-220);
  for (let n = Math.min(window.length, t.length); n >= 12; n--) {
    if (window.endsWith(t.slice(0, n))) { t = t.slice(n); break; }
  }
  const needsSpace = /[\w.,;:!?)]$/.test(head) && /^[\w(]/.test(t);
  return head + (needsSpace ? " " : "") + t;
}
// Models sometimes put "filename=NAME" on its own line under the fence;
// fold it back into the info string so the file keeps its name.
function normalizeFences(text) {
  return rewriteImageLinks(text).replace(/```([\w+#.-]*)[ \t]*\n[ \t]*filename=([^\s`]+)[ \t]*\n/g, "```$1 filename=$2\n");
}
// What went wrong with each model that didn't answer (no provider text
// except short error messages for bad requests).
function describeFailures(failures) {
  return failures.map((f) => ({
    model: f.model,
    status: f.status || 0,
    reason: f.errBody === "timed out" ? "timed out" : f.status === 429 ? "rate limited" : f.status === 503 ? `overloaded: ${String(f.errBody || "").replace(/\s+/g, " ").slice(0, 160)}` : f.status === 401 || f.status === 403 ? "key rejected" : f.status === 404 ? "model not found" : f.status === 400 || f.status === 502 ? String(f.errBody || "").replace(/\s+/g, " ").slice(0, 140) : f.status ? `http ${f.status}` : "network",
  }));
}
async function continueLongReply(first, baseMessages, systemPrompt, opts) {
  let reply = first.reply;
  let finish = first.finish;
  let rounds = 0;
  const started = Date.now();
  while (finish === "length" && rounds < 2 && Date.now() - started < (opts.budgetMs || 30000)) {
    const msgs = [...baseMessages, { role: "assistant", content: reply }, { role: "user", content: "Your reply was cut off. Continue exactly where it stopped — no repetition, no preamble, keep the same formatting (stay inside any open code block)." }];
    const { result } = await runWithFallback(attemptPlan(false, true), () => msgs, systemPrompt, {
      maxTokens: (cfg) => (isGroqEndpoint(cfg) ? Math.max(800, 7600 - estimateTokens(msgs, systemPrompt)) : 6000),
      temperature: 0.3, reasoningEffort: "low", totalBudgetMs: Math.max(8000, (opts.budgetMs || 30000) - (Date.now() - started)), timeoutMs: opts.timeoutMs || 26000,
    });
    if (!result.ok) break;
    reply = joinContinuation(reply, result.reply);
    finish = result.finish;
    rounds++;
  }
  return { reply, truncated: finish === "length", rounds };
}

// Auto task: elora decides whether a request is a multi-step job.
function looksLikeTask(text) {
  const t = String(text || "").trim();
  if (t.length < 45) return false;
  if (/^(what|who|when|where|why|is|are|does|do|can|how much|how many)\b[^.!?\n]{0,90}\?\s*$/i.test(t)) return false;
  return /\b(build|create|make|write|generate|draft|plan|research|compare|analy[sz]e|design|develop|set ?up|implement|prepare|outline|produce|script|app|website|landing page|report|guide|checklist|strategy|itinerary|curriculum|business plan|step[- ]by[- ]step|files?|project)\b/i.test(t);
}
async function decideTask(text, history) {
  const groq = buildProviderConfig("groq", false);
  const gemini = buildProviderConfig("gemini", false);
  const plan = [];
  if (groq.apiKey && isGroqEndpoint(groq)) plan.push({ ...groq, model: "openai/gpt-oss-20b" });
  if (gemini.apiKey) plan.push({ ...gemini, model: "gemini-3.5-flash-lite" });
  if (!plan.length) return false;
  const recent = history.slice(-4, -1).map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`).join("\n");
  const sys = `You route requests for an AI assistant. Answer TASK only when the latest request is a substantial job that clearly benefits from planning and several separate steps — for example building something with multiple files, researching and comparing several options with current information, or producing a long structured deliverable (plan, report, curriculum). Answer CHAT for questions, explanations, puzzles, opinions, single pieces of code, rewrites, short documents, follow-ups and anything a single good reply handles. When unsure, answer CHAT. Reply with exactly one word: TASK or CHAT.`;
  const msg = `${recent ? `Earlier conversation:\n${recent}\n\n` : ""}Latest request:\n"""${String(text).slice(0, 3000)}"""`;
  const { result } = await runWithFallback(plan, () => [{ role: "user", content: msg }], sys, { maxTokens: 400, temperature: 0, reasoningEffort: "low", totalBudgetMs: 7000, timeoutMs: 6000 });
  return Boolean(result.ok && /\bTASK\b/i.test(result.reply) && !/\bCHAT\b/i.test(result.reply));
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
  const text = String(prompt || "").slice(0, 3000);
  // Briefings and "watch this topic" tasks need today's information.
  let found = "";
  if (needsWebSearch(text) || /\b(news|headlines|briefing|monitor|watch for|mentions?|updates? on|trends?)\b/i.test(text)) {
    try {
      const query = text.replace(/\s+/g, " ").slice(0, 160);
      const results = await performWebSearch(query);
      if (results) found = `[Live web search results for this task, ${new Date().toISOString().slice(0, 10)} — use them, cite the links you rely on:]\n${results}\n\n`;
    } catch (_e) {}
  }
  const messages = [{ role: "user", content: found + text }];
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
  // Shared multi-engine search (DuckDuckGo → Bing → Mojeek → Wikipedia).
  try {
    const found = await searchWeb(query);
    if (found.length) {
      await logEvent("info", "chat", `Web search returned ${found.length} results for "${String(query).slice(0, 80)}".`);
      return found.slice(0, 6).map((r) => `${r.text} — ${r.snippet} (${r.href})`).join("\n");
    }
  } catch (_err) {}
  return performWebSearchLegacy(query);
}
async function performWebSearchLegacy(query) {
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
        // safeFetch refuses private/internal addresses and caps size + time.
        const res = await safeFetch(url, { timeoutMs: 6000 });
        if (!res.ok || !res.textual || !res.body) return null;
        let cleaned;
        if (/html/i.test(res.contentType)) {
          const page = readablePage(res.body, res.url);
          cleaned = [page.title, page.description, ...page.blocks.map((b) => b.x)].filter(Boolean).join("\n");
        } else {
          cleaned = res.body.trim();
        }
        return `--- Content from ${url} ---\n${cleaned.slice(0, 4000)}`;
      } catch (_err) {
        return null;
      }
    })
  );

  const found = excerpts.filter(Boolean);
  if (found.length === 0) return "";
  return `[The user's message included a link. Here's what was actually on the page, so you can answer about its real content:]\n\n${found.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Task mode — multi-step work with visible progress.
//
// The browser drives a task as a short series of requests to this same
// function (keeps every call well inside the time limit):
//   plan   → elora breaks the request into 2–6 steps        (charged once)
//   step   → elora does one step; a step may run a real web
//            search or read the user's links first          (free, needs token)
//   finish → elora writes the final reply                    (free, needs token)
// The plan call returns a short-lived signed token, so step/finish calls
// are only free for a task this person actually started and paid for.
// ---------------------------------------------------------------------------
function taskSecret() {
  return process.env.TASK_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.CONNECTOR_OAUTH_STATE_SECRET || "";
}
function signTaskToken(claims) {
  const secret = taskSecret();
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyTaskToken(token, subject) {
  const secret = taskSecret();
  if (!secret || typeof token !== "string" || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!claims || claims.sub !== subject || !(claims.exp > Date.now())) return null;
    return claims;
  } catch (_e) {
    return null;
  }
}

const TASK_KINDS = ["research", "think", "write", "code"];
const cleanText = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);

function sanitizePlan(raw) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  const clean = steps
    .map((s) => ({
      title: cleanText(typeof s === "string" ? s : s?.title, 80),
      kind: TASK_KINDS.includes(s?.kind) ? s.kind : "think",
      search: cleanText(s?.search, 120),
    }))
    .filter((s) => s.title)
    .slice(0, 6);
  return {
    title: cleanText(raw?.title, 80) || "Task",
    deliverable: cleanText(raw?.deliverable, 200),
    steps: clean.length ? clean : [{ title: "Work through the request", kind: "think", search: "" }, { title: "Write up the result", kind: "write", search: "" }],
  };
}

function parseJsonObject(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (_e) { return null; }
}

// Files the model wrote as ```lang filename=NAME blocks.
function extractFiles(text) {
  const files = [];
  const re = /```([\w+#.-]*)[ \t]+filename=([^\s`]+)[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || ""))) && files.length < 6) {
    files.push({ name: m[2].replace(/[^\w.\-]/g, "_").slice(0, 80), lang: m[1] || "", content: m[3].slice(0, 60000) });
  }
  return files;
}

async function runTaskPhase(res, ctx) {
  const { phase, task, goal, history, systemBase, preferences, subject, creditsRemaining, unlimited, email, memoryOn, memorySummary, mode } = ctx;
  const progress = typeof ctx.progress === "function" ? ctx.progress : () => {};
  const isAgent = mode === "agent";
  const prevSources = sanitizeSources(task?.sources);
  const plan = attemptPlan(false, true); // Gemini first: tasks are token-heavy
  const maxSteps = Math.max(2, Math.min(6, Number(preferences?.taskMaxSteps) || 6));
  // Gemini gets room for whole files; Groq's cap depends on its 8k/min budget.
  const opts = (maxTokens, effort) => ({ maxTokens: (cfg, msgs, sys) => (isGroqEndpoint(cfg) ? Math.max(1200, Math.min(maxTokens, 7600 - estimateTokens(msgs, sys))) : Math.max(maxTokens, 8000)), temperature: 0.3, reasoningEffort: effort || "medium", totalBudgetMs: 48000 });

  if (phase === "plan") {
    const sys = `${systemBase}\n\nYou are planning a multi-step task that you will then carry out yourself, one step at a time, in this chat. Break the user's latest request into the FEWEST concrete steps the job really needs (2–${maxSteps}). A step can use a web search — give a short query in "search" only when the step needs current or factual information you don't reliably know; otherwise leave it empty. You can't run code, click around websites, or reach the user's accounts or files beyond what they attached. Make the last step produce the deliverable. For a website, web app, dashboard or browser game, plan 3–4 steps: (1) "think" — decide the concept: name, audience, palette, fonts, sections and the actual copy; (2) "code" — build the whole thing as ONE self-contained index.html (CSS and JS inline); (3) "code" — polish: richer visuals, animations, generated images, mobile layout, and output the complete improved index.html; optionally (4) "code" — review for bugs and output the final complete file. Don't split it into separate CSS and JS files unless the user asked. For other code jobs, plan complete files and end with a step that reviews them for bugs and outputs corrected, complete versions.\n${isAgent ? `\n${AGENT_PLAN_GUIDE}\n` : ""}Return ONLY a JSON object, no prose: {"title":"short task title","deliverable":"one sentence: what the user gets","steps":[{"title":"imperative step title (max 60 chars)","kind":"research|think|write|code","search":"query or empty"}]}`;
    const { result, failures } = await runWithFallback(plan, () => history, sys, { ...opts(1400), onSwitch: (cfg) => progress(`Switching to ${prettyModel(cfg.model)}`) });
    if (!result.ok) return taskFailure(res, failures);
    const parsed = sanitizePlan(parseJsonObject(result.reply) || {});
    parsed.steps = parsed.steps.slice(0, maxSteps);
    const token = signTaskToken({ sub: subject, exp: Date.now() + 20 * 60 * 1000, n: parsed.steps.length });
    return res.status(200).json({ task: parsed, token, provider: result.label, creditsRemaining, unlimited, auto: Boolean(ctx.auto) });
  }

  const p = sanitizePlan(task?.plan || {});
  // Earlier steps' output (code included) so later steps can build on and
  // review it; newest steps keep the most room.
  const rawResults = Array.isArray(task?.results) ? task.results.map((r) => String(r || "")) : [];
  let room = 26000;
  const results = rawResults.slice().reverse().map((r) => { const keep = r.slice(0, Math.max(800, Math.min(9000, room))); room -= keep.length; return keep; }).reverse();
  const planList = p.steps.map((s, k) => `${k + 1}. ${s.title}`).join("\n");
  const prior = results.map((r, k) => `### Step ${k + 1} — ${p.steps[k] ? p.steps[k].title : ""}\n${r}`).join("\n\n");

  if (phase === "step") {
    const stepSkills = pickSkills(goal, p.title, preferences?.workspaceMode);
    const isBuild = isHeavy(stepSkills);
    const i = Math.max(0, Math.min(p.steps.length - 1, Number(task?.stepIndex) || 0));
    const step = p.steps[i];
    const used = [];
    let context = "";
    let newSources = [];
    const query = step.search || (isAgent && step.kind === "research" ? `${step.title} ${p.title}`.slice(0, 200) : "");
    if (query && preferences?.webSearch !== false) {
      const found = await research(query, { depth: isAgent ? "deep" : "normal", exclude: prevSources.map((x) => x.url), onProgress: progress });
      newSources = found.sources;
      used.push({ tool: "web_search", query: found.query, ok: newSources.length > 0, results: newSources.map((x) => `${x.title} — ${x.url}`), read: newSources.filter((x) => x.read).map((x) => ({ site: x.site, title: x.title, url: x.url })) });
      if (newSources.length) context += `\n\n${sourcesContext(newSources, prevSources.length, found.summary || "")}`;
    }
    if (prevSources.length) context += `\n\n[Sources found in earlier steps — cite them by these numbers when you use them:]\n${prevSources.map((x, k) => `[${k + 1}] ${x.title} — ${x.url}`).join("\n")}`;
    if (i === 0 && preferences?.readLinks !== false) {
      const links = await readLinks(goal, { onProgress: progress });
      if (links.context) { used.push({ tool: "read_links", ok: true, pages: links.pages }); context += `\n\n${links.context}`; }
    }
    progress(step.kind === "code" ? `Writing the code for “${step.title}”` : step.kind === "research" ? `Working through what I found` : `Working on “${step.title}”`);
    const sys = `${systemBase}\n\nYou are carrying out a task step by step.\nTask: ${p.title}\nThe user's request: """${goal.slice(0, 4000)}"""\nPlan:\n${planList}\n\nNow do ONLY step ${i + 1}: "${step.title}". Build on the earlier results, be concrete and complete, and don't repeat what earlier steps already produced. When this step creates something the user should keep (code, a document, a CSV…), put each file in its own fenced block whose info string is the language followed by filename=NAME — for example \`\`\`python filename=scraper.py. Always write complete files, never fragments, "..." or "rest stays the same"; if you improve a file from an earlier step, output the whole new version under the same filename. Websites should look polished and work on phones.${isAgent ? `\n\n${AGENT_STEP_GUIDE}` : ""}${stepSkills.length && step.kind !== "research" ? `\n\n${skillGuide(stepSkills)}` : ""}`;
    const msg = `${prior ? `Results so far:\n\n${prior}\n\n` : ""}${context ? `${context.trim()}\n\n` : ""}Do step ${i + 1} now: ${step.title}`;
    const stepOpts = opts(step.kind === "code" || step.kind === "write" ? 5000 : 2800, step.kind === "code" ? "high" : "medium");
    if (isBuild && step.kind === "code") {
      // A whole polished page is long: give Gemini room for it.
      stepOpts.maxTokens = (cfg, msgs, sysP) => (isGroqEndpoint(cfg) ? Math.max(1200, Math.min(7000, 7600 - estimateTokens(msgs, sysP))) : 12000);
      stepOpts.timeoutMs = 150000;
      stepOpts.totalBudgetMs = 200000;
      stepOpts.reasoningEffort = "low";
    }
    stepOpts.onSwitch = (cfg) => progress(`Switching to ${prettyModel(cfg.model)}`);
    // Groq counts prompt + reply against 8k tokens a minute: give it a compact
    // version (shorter earlier results and source excerpts) that fits.
    const compactFor = (cfg) => {
      if (!isGroqEndpoint(cfg)) return [{ role: "user", content: msg }];
      const shortSys = estimateTokens([], sys);
      const room = Math.max(1200, 7400 - 1900 - shortSys) * 3.4;
      const shortPrior = results.map((r, k) => `### Step ${k + 1} — ${p.steps[k] ? p.steps[k].title : ""}\n${r.slice(0, 900)}`).join("\n\n");
      const shortCtx = context.replace(/(\n\[\d+\] [^\n]*\n)([\s\S]*?)(?=\n\n\[\d+\] |\n\n\[Sources found|$)/g, (m, head, body) => head + body.slice(0, 700));
      let compact = `${shortPrior ? `Results so far (shortened):\n\n${shortPrior}\n\n` : ""}${shortCtx ? `${shortCtx.trim()}\n\n` : ""}Do step ${i + 1} now: ${step.title}`;
      if (compact.length > room) compact = compact.slice(0, Math.max(0, room - 400)) + `\n…\n\nDo step ${i + 1} now: ${step.title}`;
      return [{ role: "user", content: compact }];
    };
    const { result, failures } = await runWithFallback(plan, compactFor, sys, stepOpts);
    if (!result.ok) return taskFailure(res, failures);
    const stepReply = normalizeFences(result.reply);
    return res.status(200).json({ result: stepReply, files: extractFiles(stepReply), used, provider: result.label, sources: newSources.map((x) => ({ title: x.title, url: x.url, site: x.site, read: x.read })), fallbacks: failures.length ? describeFailures(failures) : undefined });
  }

  // finish
  const fileNames = (Array.isArray(task?.files) ? task.files : []).map((f) => cleanText(f, 80)).filter(Boolean).slice(0, 12);
  const sys = `${systemBase}\n\nYou just finished a multi-step task for the user. Write your final reply: lead with the result itself — complete and well structured, keeping the concrete facts, numbers and names the steps found — then a short note on what you did.${prevSources.length ? " Cite the numbered web sources as [n] after the facts that come from them; elorahub adds the links, so don't list them yourself." : ""}${isAgent ? ` ${AGENT_STEP_GUIDE}` : ""} ${fileNames.length ? `These files were produced and are attached under your reply as downloads: ${fileNames.join(", ")} — refer to them by name instead of pasting their full contents again.` : ""} Keep it tight and useful.`;
  const msg = `The user's request: """${goal.slice(0, 4000)}"""\n\nTask: ${p.title}\n\nWhat each step produced:\n\n${prior || "(no step output)"}${prevSources.length ? `\n\nNumbered sources used:\n${prevSources.map((x, k) => `[${k + 1}] ${x.title} — ${x.url}`).join("\n")}` : ""}`;
  progress("Writing the final answer");
  const finishFor = (cfg) => {
    if (!isGroqEndpoint(cfg)) return [{ role: "user", content: msg }];
    const room = Math.max(1200, 7400 - 1900 - estimateTokens([], sys)) * 3.4;
    const shortPrior = results.map((r, k) => `### Step ${k + 1} — ${p.steps[k] ? p.steps[k].title : ""}\n${r.slice(0, Math.floor(room / Math.max(1, results.length)) - 120)}`).join("\n\n");
    let compact = `The user's request: """${goal.slice(0, 1500)}"""\n\nTask: ${p.title}\n\nWhat each step produced (shortened):\n\n${shortPrior || "(no step output)"}${prevSources.length ? `\n\nNumbered sources used:\n${prevSources.map((x, k) => `[${k + 1}] ${x.title} — ${x.url}`).join("\n")}` : ""}`;
    if (compact.length > room + 1500) compact = compact.slice(0, room + 1500);
    return [{ role: "user", content: compact }];
  };
  const { result, failures } = await runWithFallback(plan, finishFor, sys, { ...opts(isAgent ? 4000 : 2400), onSwitch: (cfg) => progress(`Switching to ${prettyModel(cfg.model)}`) });
  if (!result.ok) return taskFailure(res, failures);
  if (email && memoryOn) {
    const updated = await updateUserMemory(memorySummary, goal, result.reply);
    if (updated && updated.trim() && updated !== memorySummary) await saveUserMemory(email, updated);
  }
  const finalTaskReply = prevSources.length ? appendSources(normalizeFences(result.reply), prevSources) : normalizeFences(result.reply);
  return res.status(200).json({ reply: finalTaskReply, provider: result.label, sources: prevSources.length ? prevSources.map((x, k) => ({ n: k + 1, title: x.title, url: x.url, site: x.site })) : undefined });
}

async function taskFailure(res, failures) {
  const summary = (failures || []).map((f) => `${f.label}/${f.model} → ${f.status || "network"}`).join(", ");
  await logEvent("error", "chat", `Task step failed on all models: ${summary}`.slice(0, 1900));
  const busy = (failures || []).length && failures.every((f) => f.status === 429 || f.status === 503 || f.status === 0);
  return res.status(502).json({ error: busy ? "busy" : "model_error", message: busy ? "elora's models are busy right now. Try the task again in a few seconds." : "elora couldn't finish this step. Try the task again." });
}


// ---------------------------------------------------------------------------
// Media edits — the browser runs ffmpeg (WebAssembly) on the user's own file;
// this only turns their words into one safe ffmpeg command. The file itself
// never leaves their device.
// ---------------------------------------------------------------------------
const mediaUsage = new Map();
const MEDIA_OUT = /^output\.(mp4|webm|gif|mp3|wav|ogg|m4a|png|jpg|jpeg|webp)$/;
async function handleMediaPlan(req, res, body) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const slot = mediaUsage.get(ip) || { count: 0, reset: now + 3600000 };
  if (now > slot.reset) { slot.count = 0; slot.reset = now + 3600000; }
  slot.count++;
  mediaUsage.set(ip, slot);
  if (slot.count > 80) return res.status(429).json({ error: "busy", message: "That's a lot of edits this hour — try again a little later." });
  const instruction = cleanText(body.instruction, 1200);
  const m = body.media && typeof body.media === "object" ? body.media : {};
  const type = cleanText(m.type, 60);
  const input = /^input\.[a-z0-9]{2,5}$/.test(String(m.input || "")) ? String(m.input) : "input.mp4";
  const kind = /^video\//.test(type) ? "video" : /^audio\//.test(type) ? "audio" : type === "image/gif" ? "animated GIF" : "image";
  const facts = [kind, m.duration ? `${Number(m.duration).toFixed(1)} s long` : "", m.width && m.height ? `${Number(m.width)}x${Number(m.height)}` : "", m.size ? `${(Number(m.size) / 1048576).toFixed(1)} MB` : ""].filter(Boolean).join(", ");
  if (!instruction) return res.status(400).json({ error: "bad_request", message: "Say what to change." });
  const sys = `You turn a request to edit a media file into ONE ffmpeg command that runs in ffmpeg.wasm (ffmpeg 6, single thread, ~2 GB memory). Available: libx264, libvpx-vp9, aac, libmp3lame, libopus, gif, png, mjpeg, libwebp encoders and the standard filters (scale, crop, trim, setpts, atempo, reverse, areverse, fps, transpose, hflip, vflip, eq, hue, boxblur, gblur, split, palettegen, paletteuse, concat, loop, fade, afade, pad, rotate, colorchannelmixer, unsharp, vignette, curves). NOT available: drawtext or subtitles (no fonts), network inputs, hardware encoders.
The input file is "${input}" (${facts || kind}).
Return ONLY JSON, no prose:
{"args":["-i","${input}", ...more arguments..., "output.EXT"],"output":"output.EXT","summary":"one short friendly sentence saying what you did"}
Rules: the args array never includes the word ffmpeg; it starts with "-i","${input}" (you may put -ss / -t before -i for fast trimming); the very last argument is the output file, named output with one of these extensions: mp4, webm, gif, mp3, wav, ogg, m4a, png, jpg, webp. For MP4 use -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart (and -c:a aac if there's audio; -an to remove it). For GIF use fps 10–15, width at most 640 with -2 for height and flags=lanczos, and split + palettegen + paletteuse in one -filter_complex or -vf. Keep the aspect ratio unless asked. Speed changes: setpts for video and atempo (0.5–2.0, chain for more) for audio. For a still image keep the same format unless asked. If it can't be done with these tools, return {"error":"one short reason and what you can do instead"}.`;
  const plan = [];
  const groq = buildProviderConfig("groq", false);
  const gemini = buildProviderConfig("gemini", false);
  if (groq.apiKey && isGroqEndpoint(groq)) plan.push({ ...groq, model: "openai/gpt-oss-120b" });
  if (gemini.apiKey) plan.push(gemini);
  if (groq.apiKey && isGroqEndpoint(groq)) plan.push({ ...groq, model: "openai/gpt-oss-20b" });
  if (!plan.length) return res.status(503).json({ error: "not_configured", message: "No AI model is configured." });
  const { result } = await runWithFallback(plan, () => [{ role: "user", content: instruction }], sys, { maxTokens: 900, temperature: 0.1, reasoningEffort: "low", totalBudgetMs: 25000 });
  if (!result.ok) return res.status(502).json({ error: "model_error", message: "elora couldn't plan that edit just now. Try again." });
  const out = parseJsonObject(result.reply) || {};
  if (out.error) return res.status(200).json({ error: "cannot", message: cleanText(out.error, 300) });
  const args = Array.isArray(out.args) ? out.args.map((a) => String(a)).slice(0, 80) : [];
  const output = String(out.output || args[args.length - 1] || "");
  const bad = !args.length || args.some((a) => /:\/\/|^(https?|tcp|udp|rtmp|file|pipe|concat):/i.test(a) || a.length > 600) || !MEDIA_OUT.test(output) || args[args.length - 1] !== output || args.indexOf(input) < 0;
  if (bad) return res.status(200).json({ error: "cannot", message: "elora couldn't turn that into a safe edit. Try saying it a different way." });
  return res.status(200).json({ args, output, summary: cleanText(out.summary, 300) });
}

const browseUsage = new Map();
async function handleBrowse(req, res, browse) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const slot = browseUsage.get(ip) || { count: 0, reset: now + 3600000 };
  if (now > slot.reset) { slot.count = 0; slot.reset = now + 3600000; }
  slot.count++;
  browseUsage.set(ip, slot);
  if (slot.count > 200) return res.status(429).json({ kind: "error", message: "You've opened a lot of pages this hour. Try again in a little while." });
  const q = typeof browse.q === "string" ? browse.q.trim().slice(0, 300) : "";
  if (q) {
    const results = await searchWeb(q);
    return res.status(200).json({ kind: "search", query: q, results });
  }
  const url = typeof browse.url === "string" ? browse.url.trim().slice(0, 2000) : "";
  if (!url) return res.status(400).json({ kind: "error", message: "Type a web address or something to search for." });
  const page = await safeFetch(url);
  if (!page.ok && !page.textual) {
    return res.status(200).json({ kind: "error", url, status: page.status || 0, message: page.reason || (page.status ? `The site answered with an error (${page.status}).` : "The page couldn't be opened.") });
  }
  const canFrame = frameable(page.headers, page.url);
  if (!page.textual) return res.status(200).json({ kind: "file", url: page.url, contentType: page.contentType, frameable: canFrame });
  if (!/html|xhtml/i.test(page.contentType)) {
    return res.status(200).json({ kind: "page", url: page.url, status: page.status, title: page.url.split("/").pop() || page.url, description: "", image: "", blocks: [{ t: "pre", x: page.body.slice(0, 40000) }], links: [], frameable: canFrame });
  }
  const read = readablePage(page.body, page.url);
  return res.status(200).json({ kind: "page", url: page.url, status: page.status, frameable: canFrame, ...read });
}

export default async function handler(req, res) {
  const out = req.method === "POST" && req.body && req.body.stream === true ? streamingResponse(res) : res;
  try {
    return await chatHandler(req, out);
  } catch (err) {
    console.error("chat handler failed:", err);
    try { await logEvent("error", "chat", `Unexpected error: ${String(err && err.message || err).slice(0, 300)}`); } catch (_e) {}
    if (out.isStream || !res.headersSent) return out.status(500).json({ error: "server_error", message: "Something went wrong on elora's side. Try again in a moment." });
  }
}

async function chatHandler(req, res) {
  // GET = read-only plan summary for the account menu and Settings
  // (Billing / Usage). Sends no message and spends nothing. Lives here
  // rather than in its own file because Vercel Hobby caps the project at
  // 12 serverless functions.
  // Generated pictures (chat image cards and images in built websites).
  if (req.method === "GET" && req.query && req.query.img) return handleImage(req, res);
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

  // Browser panel: open a page or run a search. No AI call and nothing is
  // charged — just a safe, rate-limited page reader (see api/_lib/browse.js).
  if (req.body && req.body.browse && typeof req.body.browse === "object") {
    return handleBrowse(req, res, req.body.browse);
  }
  if (req.body && req.body.mediaPlan && typeof req.body.mediaPlan === "object") {
    return handleMediaPlan(req, res, req.body.mediaPlan);
  }

  const progress = (t) => { if (res.isStream) res.progress(t); };
  const onSwitch = (cfg, failed) => progress(`${prettyModel(failed && failed.model)} is ${failed && failed.errBody === "timed out" ? "slow" : "busy"} — switching to ${prettyModel(cfg.model)}`);

  const { messages, provider, images, preferences } = req.body || {};
  const mode = normalizeMode(preferences?.workspaceMode);

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

  // Task mode (see runTaskPhase): step/finish calls ride on the plan call
  // that was already charged, proven by a short-lived signed token.
  const task = req.body?.task && typeof req.body.task === "object" ? req.body.task : null;
  const taskPhase = task && ["plan", "step", "finish"].includes(task.phase) ? task.phase : null;
  const clientIp = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const subject = email ? `u:${email}` : `ip:${clientIp}`;
  const taskClaims = taskPhase === "step" || taskPhase === "finish" ? verifyTaskToken(task.token, subject) : null;
  if ((taskPhase === "step" || taskPhase === "finish") && !taskClaims && taskSecret()) {
    return res.status(401).json({ error: "task_expired", message: "This task expired — start it again." });
  }

  if (taskClaims) {
    // Already paid for when the task was planned.
  } else if (email) {
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
  const addStep = (t) => { steps.push(t); progress(t); };
  const startedAt = Date.now();

  // Auto task: for requests that look like a bigger job, a quick, cheap
  // routing call decides whether to plan it as a multi-step task instead
  // of a single reply. Already charged above — the task's later steps
  // ride on the signed token like a manual task.
  const agentTask = mode === "agent" && !taskPhase && safeImages.length === 0 && lastMessage.content.trim().length > 14 && !/^(hi|hey|hello|thanks|thank you|ok|okay)\b/i.test(lastMessage.content.trim());
  if (!taskPhase) progress(agentTask ? "Planning the work" : "Reading your message");
  const autoTask = agentTask || (!taskPhase && preferences?.autoTask === true && safeImages.length === 0 && looksLikeTask(lastMessage.content)
    ? await decideTask(lastMessage.content, messages.slice(-6))
    : false);

  // Real, persistent memory: a short profile of stable facts elora has
  // learned about this signed-in user across past conversations (not
  // just this session). Injected into the system prompt so it can
  // actually use it, same as a human assistant remembering a regular.
  let memorySummary = "";
  const memoryOn = preferences?.memory !== false;
  if (email && memoryOn) {
    memorySummary = await getUserMemory(email);
    if (memorySummary) addStep("Recalled what I know about you");
  }

  // Web research: search, read the best pages, cite numbered sources
  // (see api/_lib/research.js). Runs when the question needs fresh facts or
  // the user asks for links; "always" and "deep" come from Settings.
  let searchContext = "";
  let sources = [];
  let researchNote = "";
  const webMode = preferences?.webSearch === false ? "off" : ["always", "deep"].includes(preferences?.webMode) ? preferences.webMode : "auto";
  const heavyIntent = isHeavy(pickSkills(lastMessage.content, "", mode));
  if (!taskPhase && !autoTask && wantsResearch(lastMessage.content, { pref: webMode === "deep" ? "always" : webMode, heavyBuild: heavyIntent })) {
    const found = await research(lastMessage.content, { depth: webMode === "deep" ? "deep" : "normal", onProgress: progress });
    if (found.sources.length) {
      sources = found.sources;
      searchContext = sourcesContext(sources, 0, found.summary || "");
      steps.push(`Searched the web for “${found.query.slice(0, 60)}”`);
      const readSites = sources.filter((x) => x.read).map((x) => x.site);
      if (readSites.length) steps.push(`Read ${readSites.length} source${readSites.length === 1 ? "" : "s"}: ${readSites.join(", ")}`);
    } else {
      steps.push("Searched the web — nothing useful came back");
      if (searchDiag.last) await logEvent("warning", "chat", `Web search found nothing useful (add TAVILY_API_KEY, BRAVE_SEARCH_KEY or SERPER_API_KEY for reliable search): ${searchDiag.last}`.slice(0, 900));
    }
    researchNote = found.engine || (searchDiag.last ? `fallback (${searchDiag.last.slice(0, 300)})` : "fallback");
  }

  // Links in the newest message are opened and read properly (GitHub repos
  // and files, Reddit threads, YouTube titles, any normal page).
  let linkContext = "";
  if (!taskPhase && !autoTask && preferences?.readLinks !== false) {
    const links = await readLinks(lastMessage.content, { onProgress: progress });
    linkContext = links.context;
    if (links.pages.length) steps.push(`Read ${links.pages.map((x) => x.site).join(", ")}`);
  }

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
  const code = preferences?.code && typeof preferences.code === "object" ? preferences.code : {};
  const codeGuide = [
    code.indent === "tabs" ? "In code, indent with tabs." : code.indent === "4" ? "In code, indent with 4 spaces." : code.indent === "2" ? "In code, indent with 2 spaces." : "",
    code.comments === "minimal" ? "Keep code comments minimal." : code.comments === "thorough" ? "Comment code thoroughly for a learner." : "",
    code.explain === "brief" ? "After code, keep the explanation to a few lines." : code.explain === "full" ? "After code, explain how it works step by step." : "",
    /^[\w#+. -]{1,24}$/.test(String(code.language || "")) && code.language !== "auto" ? `When the language isn't specified, default to ${code.language}.` : "",
    code.types === true ? "Prefer typed code (TypeScript over JavaScript, type hints in Python)." : "",
  ].filter(Boolean).join(" ");
  const preferenceGuide = [styleGuide, languageGuide, codeGuide].filter(Boolean).join(" ");
  // Optional, from Settings → Privacy → "Location for local answers": only the
  // browser's time zone (e.g. "Asia/Tbilisi"), never GPS or an address.
  const zone = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(String(preferences?.timeZone || "")) ? String(preferences.timeZone) : "";
  let localLine = "";
  if (zone) {
    try {
      const local = new Date().toLocaleString("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
      localLine = ` The user's time zone is ${zone} (their local time now: ${local}). Use this for local time, weather and "near me" questions only when relevant; don't mention it otherwise.`;
    } catch (_e) {}
  }
  const todayLine = `\n\nToday's date is ${new Date().toISOString().slice(0, 10)} (UTC).${localLine}`;
  // Profile + custom instructions from Settings → Account.
  const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const callMe = clean(preferences?.callMe, 60);
  const work = clean(preferences?.work, 60);
  const instructions = String(preferences?.instructions || "").trim().slice(0, 1500);
  const personal = [callMe ? `They like to be called ${callMe}.` : "", work ? `Their work: ${work}.` : ""].filter(Boolean).join(" ");
  const personalBlock = personal || instructions
    ? `\n\nAbout the user: ${personal || "(no profile details)"}${instructions ? `\nTheir standing instructions for you — follow them unless they conflict with being safe and honest:\n"""\n${instructions}\n"""` : ""}`
    : "";
  // Skills: the expert playbooks this request needs (see api/_lib/skills.js).
  const userTexts = messages.filter((m) => m && m.role === "user" && typeof m.content === "string").map((m) => m.content.slice(0, 2000));
  let skills = pickSkills(lastMessage.content, userTexts.length > 1 ? userTexts[userTexts.length - 2] : "", mode);
  if (mode === "studio") {
    const t = preferences?.studio?.type;
    const want = t === "video" || t === "gif" ? "animation" : ["design", "poster", "thumbnail", "social"].includes(t) ? "design" : t === "logo" || t === "icon" ? "logo" : t === "diagram" ? "diagram" : t === "image" ? "image" : "";
    if (want && !skills.includes(want)) skills = [want, ...skills].slice(0, 3);
    if (!skills.length) skills = ["image", "design"];
  }
  const skillText = skills.length ? `\n\n${skillGuide(skills)}` : "";
  // A big deliverable (a site, app, game, video…) gets the long-output setup.
  const buildGuide = (mode === "studio" && skills.some((x) => x === "animation" || x === "design")) || isHeavy(skills) && (mode === "code" || mode === "studio" || /\b(build|make|create|design|generate|develop|code|write|program|animate|render|produce|turn|convert|i want|i need|give me|can you|could you|let'?s)\b/i.test(lastMessage.content)) ? "heavy" : "";
  const systemPrompt = (memorySummary
    ? `${SYSTEM_PROMPT}\n\nWhat you remember about this user from past conversations (use it naturally, don't recite it back verbatim unless relevant):\n${memorySummary}`
    : SYSTEM_PROMPT) + (mode === "code" ? `\n\n${codeModeGuide(preferences)}` : mode === "studio" ? `\n\n${studioModeGuide(preferences)}` : "") + skillText + (preferenceGuide ? `\n\nUser's current response preferences: ${preferenceGuide}` : "") + personalBlock + todayLine;

  if (taskPhase || autoTask) {
    return runTaskPhase(res, {
      phase: autoTask ? "plan" : taskPhase, task: task || {}, goal: lastMessage.content, history: trimmedHistory, systemBase: systemPrompt,
      preferences, subject, creditsRemaining, unlimited, email, memoryOn, memorySummary, auto: autoTask, mode, progress,
    });
  }

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

  progress(buildGuide ? (mode === "studio" ? "Designing it — this can take a minute" : "Building it — big builds take a minute or two") : sources.length ? "Writing the answer from the sources" : mode === "code" ? "Writing the code" : "Writing the answer");
  // Walk the attempt plan (see attemptPlan) until a model answers. Big
  // prompts go to Gemini first; Groq attempts get a trimmed history that
  // fits its per-minute token limit.
  const hasImages = safeImages.length > 0;
  const replyTokens = preferences?.style === "concise" ? 1600 : preferences?.style === "deep" || preferences?.style === "technical" ? 4000 : 3000;
  const promptTokens = estimateTokens(finalMessages, systemPrompt);
  const isBuildReply = Boolean(buildGuide);
  const preferGemini = safeProvider === "gemini" || promptTokens + replyTokens > 6500 || isBuildReply || prefersGemini(skills) || mode === "studio";
  const plan = attemptPlan(hasImages, preferGemini);
  const messagesFor = (cfg) => (isGroqEndpoint(cfg) ? fitToBudget(finalMessages, systemPrompt, Math.max(1200, 6800 - replyTokens)) : finalMessages);
  const { result, failures } = await runWithFallback(plan, messagesFor, systemPrompt, {
    // Groq counts prompt + reply against 8k tokens/minute, so its cap
    // depends on the prompt; Gemini gets more room for long answers.
    maxTokens: (cfg, msgs, sys) => (isGroqEndpoint(cfg) ? Math.max(1200, Math.min(replyTokens + 1200, 7600 - estimateTokens(msgs, sys))) : isBuildReply ? 12000 : Math.round(replyTokens * 2)),
    temperature: isBuildReply ? 0.6 : 0.3,
    timeoutMs: isBuildReply ? 150000 : undefined,
    // Deep dive and Code get the most careful reasoning.
    // (A build needs its tokens for the page itself, not for thinking.)
    reasoningEffort: isBuildReply || preferences?.style === "concise" ? "low" : preferences?.style === "deep" || preferences?.style === "technical" ? "high" : "medium",
    wantReasoning: preferences?.showThinking !== false,
    totalBudgetMs: isBuildReply ? 210000 : 40000,
    onSwitch,
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

  // Cut off by the token cap? Fetch the rest so the answer is complete.
  let finalReply = result.reply;
  let truncated = false;
  if (result.finish === "length") {
    const textOnly = [...finalMessages.slice(0, -1), { role: "user", content: lastText }];
    const elapsed = Date.now() - startedAt;
    const more = await continueLongReply(result, textOnly, systemPrompt, isBuildReply ? { budgetMs: Math.max(30000, 255000 - elapsed), timeoutMs: 90000 } : { budgetMs: Math.max(8000, 52000 - elapsed) });
    finalReply = more.reply;
    truncated = more.truncated;
    if (more.rounds) addStep(more.rounds === 1 ? "Kept writing past the length limit" : `Kept writing past the length limit (${more.rounds} more parts)`);
  }

  if (failures.length) {
    await logEvent("warning", "chat", `Answered by ${result.label}/${result.model} after ${failures.length} busy model(s): ${failures.map((f) => `${f.model} ${f.status || "network"}`).join(", ")}`);
  }

  // Update this user's persistent memory in the background of this same
  // request (Vercel functions don't reliably keep running after the
  // response is sent, so this has to be awaited here, not fired-and-
  // forgotten). Uses a small, cheap, fast call — separate from the main
  // reply — that only keeps stable facts, never one-off chat content.
  if (email && memoryOn) {
    const updated = await updateUserMemory(memorySummary, lastMessage.content, finalReply);
    // Never let this step erase existing memory — only "Forget me"
    // (DELETE /api/memory) is allowed to clear it. If the extraction
    // came back empty (nothing new/stable in this exchange) or failed,
    // the existing profile is kept exactly as it was.
    if (updated && updated.trim() && updated !== memorySummary) {
      await saveUserMemory(email, updated);
    }
  }

  // Code mode: a second, independent look at the code before the user sees it.
  if (mode === "code" && preferences?.code?.doubleCheck !== false && /```/.test(finalReply) && finalReply.length < 16000 && !isBuildReply && Date.now() - startedAt < 150000) {
    progress("Double-checking the code");
    const reviewMsg = `The user's request:\n"""${lastMessage.content.slice(0, 6000)}"""\n\nDraft answer:\n"""${finalReply}"""`;
    const { result: rv } = await runWithFallback(attemptPlan(false, true), () => [{ role: "user", content: reviewMsg }], CODE_REVIEW_SYSTEM, {
      maxTokens: (cfg, msgs, sys) => (isGroqEndpoint(cfg) ? Math.max(1200, 7600 - estimateTokens(msgs, sys)) : 9000),
      temperature: 0.1, reasoningEffort: "medium", timeoutMs: 70000, totalBudgetMs: 80000,
    });
    if (rv.ok) {
      const checked = cleanReply(rv.reply);
      if (/^ok\.?$/i.test(checked.trim())) steps.push("Double-checked the code — no problems found");
      else if (/```/.test(checked) && checked.length > finalReply.length * 0.5 && rv.finish !== "length") { finalReply = checked; steps.push("Double-checked the code and fixed what it found"); }
    }
  }

  finalReply = normalizeFences(finalReply);
  if (sources.length) finalReply = appendSources(finalReply, sources);
  return res.status(200).json({
    reply: finalReply,
    sources: sources.length ? sources.map((x, i) => ({ n: i + 1, title: x.title, url: x.url, site: x.site })) : undefined,
    research: researchNote || undefined,
    fallbacks: failures.length ? describeFailures(failures) : undefined,
    usage: result.usage,
    creditsRemaining,
    unlimited,
    provider: result.label,
    model: result.model,
    steps,
    thinking: preferences?.showThinking === false ? "" : String(result.reasoning || "").slice(0, 8000),
    truncated,
    elapsedMs: Date.now() - startedAt,
  });
}
