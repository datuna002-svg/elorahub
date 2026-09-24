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

import { logEvent, verifyRequester, getSubscription, spendCredit } from "./_lib/supabaseAdmin.js";

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

// Elora's system prompt — now tilted hard toward being a genuinely strong
// coding assistant first, general-purpose assistant second. Adjust the
// balance here if you want more or less of a code focus.
const SYSTEM_PROMPT = `You are Elora, the AI assistant for elorahub. Your strongest skill is programming: you write correct, working code, debug precisely by reasoning through what the code actually does rather than guessing, explain technical concepts clearly, and follow good engineering practice (error handling, clear naming, appropriate comments) without being asked. When someone shares code or an error, trace through it step by step before proposing a fix. When asked to write code, produce complete, runnable code rather than fragments or pseudocode unless a fragment is genuinely what's needed. Outside of coding, you're still a capable, direct, well-reasoned general assistant — thorough with writing, decisions, and analysis — but code is where you go deepest.

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
  // Signed-in users with an active Private/Premium subscription spend
  // one real, database-backed credit per message (500/month Private,
  // 1500/month Premium — refilled by the Paddle webhook on renewal).
  // Everyone else (not signed in, or signed in with no paid plan) gets
  // the free tier's IP-based daily limit instead.
  // ------------------------------------------------------------------
  const { email } = await verifyRequester(req);
  let creditsRemaining = null;

  if (email) {
    const sub = await getSubscription(email);
    if (sub && (sub.plan === "private" || sub.plan === "premium") && sub.credits_remaining > 0) {
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

  let endpointUrl, apiKey, model;
  if (safeProvider === "gemini") {
    endpointUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    apiKey = process.env.GEMINI_API_KEY;
    // Gemini is natively multimodal, so the same model handles text
    // and images — no separate vision model needed like Groq below.
    model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  } else {
    endpointUrl = process.env.LLM_ENDPOINT_URL || "https://api.groq.com/openai/v1/chat/completions";
    apiKey = process.env.LLM_API_KEY;
    const textModel = process.env.LLM_MODEL || "openai/gpt-oss-120b";
    // Vision model — used automatically whenever an image is attached.
    // Groq's exact vision model ID has changed before; if this 404s,
    // check console.groq.com/docs/vision for the current one and set
    // LLM_VISION_MODEL to override without touching code.
    const visionModel = process.env.LLM_VISION_MODEL || "qwen/qwen3.8-27b";
    model = safeImages.length > 0 ? visionModel : textModel;
  }

  if (!apiKey) {
    console.error(`${safeProvider} API key is not set.`);
    return res.status(500).json({
      error: "not_configured",
      message: `The ${safeProvider === "gemini" ? "Gemini" : "Groq"} model isn't configured yet — its API key is missing.`,
    });
  }

  // Fetch any plain http(s) links found in the newest message and fold in
  // a short excerpt of each page's text, so Elora can actually answer
  // questions about a link instead of just seeing the bare URL.
  const linkContext = await fetchLinkContext(lastMessage.content);

  // Build the final message list: history as-is, but the last message
  // gets the link excerpts appended, and — if images were attached —
  // becomes a multipart {text, image_url...} content array instead of
  // a plain string, per the vision API format.
  const finalMessages = trimmedHistory.slice(0, -1);
  const lastText = linkContext ? `${lastMessage.content}\n\n${linkContext}` : lastMessage.content;

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

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...finalMessages],
        max_tokens: 1024,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error("Self-hosted model error:", response.status, errBody);
      await logEvent("error", "chat", `Model endpoint returned ${response.status}: ${errBody.slice(0, 300)}`);
      return res.status(502).json({
        error: "model_error",
        message: "Elora couldn't reach the model just now. Try again in a moment.",
      });
    }

    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content ?? "";

    if (!reply) {
      console.error("Unexpected response shape from model endpoint:", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        error: "model_error",
        message: "Elora's response came back empty. Try again.",
      });
    }

    return res.status(200).json({
      reply,
      usage: data.usage || null,
      creditsRemaining,
    });
  } catch (err) {
    console.error("Self-hosted model request failed:", err);
    await logEvent("error", "chat", `Model request threw: ${err.message}`);
    return res.status(502).json({
      error: "model_error",
      message: "Elora couldn't reach the model just now. Try again in a moment.",
    });
  }
}
