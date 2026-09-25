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
const SYSTEM_PROMPT = `You are elora, the AI assistant for elorahub. Your strongest skill is programming: you write correct, working code, debug precisely by reasoning through what the code actually does rather than guessing, explain technical concepts clearly, and follow good engineering practice (error handling, clear naming, appropriate comments) without being asked. When someone shares code or an error, trace through it step by step before proposing a fix. When asked to write code, produce complete, runnable code rather than fragments or pseudocode unless a fragment is genuinely what's needed. Outside of coding, you're still a capable, direct, well-reasoned general assistant — thorough with writing, decisions, and analysis — but code is where you go deepest.

Match your reply length to how much the question actually needs. A greeting, a simple factual question, or small talk gets a short, natural, conversational reply — a sentence or two, no more. Save longer, structured answers for things that genuinely warrant depth (real code, real analysis, multi-part questions). Don't pad short answers with caveats, summaries, or restated context.

Keep formatting light by default: write in plain prose and only reach for markdown headings (#), bold, or bullet lists when the content is actually complex enough to need that structure (e.g. a multi-step process, a comparison, or a long technical answer). Never open a short, casual reply with a heading. Code always goes in a proper code block regardless of reply length.`;

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
  const textModel = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  // Vision model — used automatically whenever an image is attached.
  // Groq's exact vision model ID has changed before; if this 404s, check
  // console.groq.com/docs/vision for the current one and set
  // LLM_VISION_MODEL to override without touching code.
  const visionModel = process.env.LLM_VISION_MODEL || "qwen/qwen3.8-27b";
  return {
    endpointUrl: process.env.LLM_ENDPOINT_URL || "https://api.groq.com/openai/v1/chat/completions",
    apiKey: process.env.LLM_API_KEY,
    model: hasImages ? visionModel : textModel,
    label: "Groq",
  };
}

async function callProvider(providerName, hasImages, finalMessages, systemPrompt, maxTokens, temperature) {
  const cfg = buildProviderConfig(providerName, hasImages);
  if (!cfg.apiKey) return { ok: false, configured: false, label: cfg.label };
  try {
    const response = await fetch(cfg.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: systemPrompt || SYSTEM_PROMPT }, ...finalMessages],
        max_tokens: maxTokens || 1024,
        temperature: temperature != null ? temperature : 0.4,
      }),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return { ok: false, configured: true, status: response.status, errBody, label: cfg.label };
    }
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content ?? "";
    if (!reply) return { ok: false, configured: true, status: 502, errBody: "empty reply", label: cfg.label };
    return { ok: true, reply, usage: data.usage || null, label: cfg.label };
  } catch (err) {
    return { ok: false, configured: true, status: 0, errBody: err.message, label: cfg.label };
  }
}

// Errors worth retrying / failing over for: rate-limited, overloaded,
// upstream server errors, or the request never completed at all.
function isTransient(status) {
  return status === 429 || status === 503 || status === 500 || status === 502 || status === 0;
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

async function performWebSearch(query) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    // A real desktop-browser User-Agent, not an obvious bot string —
    // DuckDuckGo's anti-bot filtering blocks/CAPTCHAs an identifiable
    // bot UA outright, especially from datacenter IPs like Vercel's.
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      await logEvent("warning", "chat", `Web search fetch failed: DuckDuckGo returned ${res.status} for "${query.slice(0, 80)}".`);
      return null;
    }
    const html = await res.text();

    // Pull titles and snippets independently, in document order, and pair
    // them up by index — more resilient to DuckDuckGo's exact nesting
    // than trying to match a whole result block as one regex.
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
    if (results.length === 0) {
      await logEvent("warning", "chat", `Web search returned no parseable results for "${query.slice(0, 80)}" (got ${html.length} bytes back).`);
      return null;
    }
    return results.join("\n");
  } catch (err) {
    await logEvent("warning", "chat", `Web search threw for "${query.slice(0, 80)}": ${err.message}`);
    return null;
  }
}

// After a reply, ask a small/fast model to fold any new stable fact
// (name, role, ongoing project, stated preference) into the user's
// memory profile. Deliberately tiny and cheap — a short extra call,
// not a second full conversation. Never throws; on any failure the old
// memory is kept as-is rather than risking corrupting or losing it.
async function updateUserMemory(oldSummary, userMessage, aiReply) {
  const cfg = buildProviderConfig("groq", false);
  if (!cfg.apiKey) return oldSummary;
  try {
    const prompt = `Existing memory profile of this user (may be empty):\n${oldSummary || "(nothing yet)"}\n\nLatest exchange:\nUser: ${userMessage.slice(0, 1000)}\nelora: ${aiReply.slice(0, 1000)}\n\nReturn an updated profile: keep every existing fact that's still true, and add any new stable, reusable fact from this exchange (name, role/job, ongoing projects, stated preferences, recurring context). Drop nothing from the existing profile unless this exchange directly contradicts it. Max 500 characters, plain text, no markdown, no preamble. IMPORTANT: if this exchange was just a one-off question with nothing new to add, return the existing profile completely unchanged — never return it shorter or empty just because this particular exchange had nothing new.`;
    const response = await fetch(cfg.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: "You maintain a short factual memory profile of a user for an AI assistant. Output ONLY the updated profile text and nothing else — no labels, no quotes, no explanation." },
          { role: "user", content: prompt },
        ],
        max_tokens: 180,
        temperature: 0,
      }),
    });
    if (!response.ok) return oldSummary;
    const data = await response.json();
    const updated = data?.choices?.[0]?.message?.content?.trim();
    return updated != null ? updated : oldSummary;
  } catch (_err) {
    return oldSummary;
  }
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const { messages, provider, images } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array." });
  }

  const lastMessage = messages[messages.length - 1];
  if (typeof lastMessage.content !== "string" || lastMessage.content.length > 8000) {
    return res.status(400).json({ error: "Message is empty or too long (8000 char max)." });
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
  if (needsWebSearch(lastMessage.content)) {
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

  const systemPrompt = memorySummary
    ? `${SYSTEM_PROMPT}\n\nWhat you remember about this user from past conversations (use it naturally, don't recite it back verbatim unless relevant):\n${memorySummary}`
    : SYSTEM_PROMPT;

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

  // Try the user's selected provider. On a transient error, retry once
  // after a short delay (Groq's overload errors are often momentary). If
  // it still fails, automatically fail over to the other provider — the
  // user never sees the first provider's error at all when this works.
  const primary = safeProvider;
  const fallbackName = primary === "gemini" ? "groq" : "gemini";

  let result = await callProvider(primary, safeImages.length > 0, finalMessages, systemPrompt);

  if (!result.ok && result.configured && isTransient(result.status)) {
    await new Promise((r) => setTimeout(r, 600));
    result = await callProvider(primary, safeImages.length > 0, finalMessages, systemPrompt);
  }

  let usedFallback = false;
  if (!result.ok) {
    const fallbackCfg = buildProviderConfig(fallbackName, safeImages.length > 0);
    if (fallbackCfg.apiKey) {
      const fallbackResult = await callProvider(fallbackName, safeImages.length > 0, finalMessages, systemPrompt);
      if (fallbackResult.ok) {
        result = fallbackResult;
        usedFallback = true;
      }
    }
  }

  if (!result.ok) {
    if (result.configured === false) {
      console.error(`${result.label} API key is not set.`);
      await logEvent("error", "chat", `${result.label} isn't configured.`);
      return res.status(500).json({
        error: "not_configured",
        message: `The ${result.label} model isn't configured yet — its API key is missing.`,
      });
    }
    console.error("Model request failed after retry + fallback:", result.status, result.errBody);
    await logEvent(
      "error",
      "chat",
      `Both providers failed. Last: ${result.label} returned ${result.status}: ${String(result.errBody).slice(0, 300)}`
    );
    return res.status(502).json({
      error: "model_error",
      message: "elora couldn't reach any model just now — it's under heavy load. Try again in a moment.",
    });
  }

  if (usedFallback) {
    await logEvent(
      "warning",
      "chat",
      `${primary === "gemini" ? "Gemini" : "Groq"} was overloaded/unavailable — automatically failed over to ${result.label} for this reply.`
    );
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
