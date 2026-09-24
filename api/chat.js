// /api/chat.js
//
// This version calls YOUR OWN self-hosted model — no per-token billing to
// Anthropic, OpenAI, or anyone else. It expects an OpenAI-compatible
// endpoint (which is what vLLM serves), pointed at an open-weight,
// code-focused model such as Qwen2.5-Coder-14B-Instruct running on your
// own GPU (see RUNPOD-DEPLOY.md in this folder for how to stand that up).
//
// Nothing about the request/response shape below is Anthropic- or
// OpenAI-specific — this is the standard "OpenAI-compatible chat
// completions" format that vLLM, Ollama, LM Studio, text-generation-webui,
// and most self-hosted inference servers all speak, so this file works
// with any of them as long as the three env vars below are set correctly.

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

  const endpointUrl = process.env.LLM_ENDPOINT_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL || "Qwen/Qwen2.5-Coder-14B-Instruct";

  if (!endpointUrl) {
    console.error("LLM_ENDPOINT_URL is not set.");
    return res.status(500).json({
      error: "not_configured",
      message: "The self-hosted model endpoint isn't configured yet.",
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
    return res.status(502).json({
      error: "model_error",
      message: "Elora couldn't reach the model just now. Try again in a moment.",
    });
  }
}
