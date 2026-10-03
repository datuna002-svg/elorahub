// GET -> a live health check for every external piece elorahub depends
// on (Supabase, Groq, Gemini, Paddle) — so a misconfigured or typo'd env
// var (like the SUPABASE_UR incident) shows up immediately in the
// console instead of silently breaking a feature. Administrator only.

import { verifyRequester, getSupabaseClient } from "../_lib/supabaseAdmin.js";

async function pingWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { email, role } = await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only administrators can view this." });
  }

  const checks = [];

  // --- Supabase: we already used it to verify this request, but confirm
  // a live query still works (not just that the client constructed). ---
  const supabase = await getSupabaseClient();
  let supabaseOk = false;
  if (supabase) {
    try {
      const { error } = await supabase.from("roles").select("email").limit(1);
      supabaseOk = !error;
    } catch (_err) {
      supabaseOk = false;
    }
  }
  checks.push({
    name: "Supabase",
    detail: "Auth, roles, subscriptions, logs",
    configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    live: supabaseOk,
  });

  // --- Groq (the default chat model) ---
  const groqKey = process.env.LLM_API_KEY;
  let groqLive = false;
  if (groqKey) {
    const r = await pingWithTimeout(
      (process.env.LLM_ENDPOINT_URL || "https://api.groq.com/openai/v1/chat/completions").replace("/chat/completions", "/models"),
      { headers: { Authorization: `Bearer ${groqKey}` } },
      5000
    );
    groqLive = r.ok;
  }
  checks.push({ name: "Groq (elora)", detail: "Default text model", configured: Boolean(groqKey), live: groqLive });

  // --- Gemini (elora Vision) ---
  const geminiKey = process.env.GEMINI_API_KEY;
  checks.push({
    name: "Gemini (elora Vision)",
    detail: "Vision / image model",
    configured: Boolean(geminiKey),
    live: null, // no cheap official probe endpoint — configured is the strongest signal without spending a real request
  });

  // --- Paddle (billing) ---
  const paddleKey = process.env.PADDLE_API_KEY;
  let paddleLive = false;
  if (paddleKey) {
    const r = await pingWithTimeout("https://api.paddle.com/subscriptions?per_page=1", { headers: { Authorization: `Bearer ${paddleKey}` } }, 5000);
    paddleLive = r.ok;
  }
  checks.push({
    name: "Paddle",
    detail: "Checkout, subscriptions, payouts",
    configured: Boolean(paddleKey && process.env.PADDLE_CLIENT_TOKEN),
    live: paddleLive,
  });

  return res.status(200).json({ checks, checkedAt: new Date().toISOString() });
}
