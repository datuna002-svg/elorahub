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

import { logEvent } from "./_lib/supabaseAdmin.js";

// ---------------------------------------------------------------------------
// TEMPORARY in-memory rate limiting — same caveat as before: resets on
// restart, doesn't work across multiple server instances, and is keyed by
// IP rather than a real logged-in user. Replace with a database-backed
// usage_counters table (see BACKEND-ROADMAP.md) once real accounts exist.
// ---------------------------------------------------------------------------
const usage = new Map();

const PLAN_LIMITS = {
  free: 20,
  private: 200,
  premium: Infinity,
};

function checkAndBumpUsage(key, plan) {
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const count = usage.get(key) || 0;
  if (count >= limit) return false;
  usage.set(key, count + 1);
  return true;
}

// Elora's system prompt — now tilted hard toward being a genuinely strong
// coding assistant first, general-purpose assistant second. Adjust the
// balance here if you want more or less of a code focus.
const SYSTEM_PROMPT = `You are Elora, the AI assistant for elorahub. Your strongest skill is programming: you write correct, working code, debug precisely by reasoning through what the code actually does rather than guessing, explain technical concepts clearly, and follow good engineering practice (error handling, clear naming, appropriate comments) without being asked. When someone shares code or an error, trace through it step by step before proposing a fix. When asked to write code, produce complete, runnable code rather than fragments or pseudocode unless a fragment is genuinely what's needed. Outside of coding, you're still a capable, direct, well-reasoned general assistant — thorough with writing, decisions, and analysis — but code is where you go deepest.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const { messages, plan } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages must be a non-empty array." });
  }

  const lastMessage = messages[messages.length - 1];
  if (typeof lastMessage.content !== "string" || lastMessage.content.length > 8000) {
    return res.status(400).json({ error: "Message is empty or too long (8000 char max)." });
  }

  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const usageKey = `${ip}:${today}`;
  const safePlan = ["free", "private", "premium"].includes(plan) ? plan : "free";

  if (!checkAndBumpUsage(usageKey, safePlan)) {
    return res.status(429).json({
      error: "limit_reached",
      message: "You've hit today's message limit for your plan. Upgrade for more.",
    });
  }

  const trimmedHistory = messages.slice(-20).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));

  const endpointUrl = process.env.LLM_ENDPOINT_URL || "https://api.groq.com/openai/v1/chat/completions";
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "openai/gpt-oss-120b";

  if (!apiKey) {
    console.error("LLM_API_KEY is not set.");
    return res.status(500).json({
      error: "not_configured",
      message: "The AI model isn't configured yet — LLM_API_KEY is missing.",
    });
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
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...trimmedHistory],
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
