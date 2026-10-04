// "Help train elora" — opt-in training data for elorahub's own model.
//
// Every 👍/👎 on a reply is recorded (rating, reasons, model, workspace).
// Only for signed-in people who turned the setting on is the rated
// conversation itself saved — after emails, phone numbers, card and bank
// numbers, IP addresses and secrets are scrubbed out. The owner console
// reviews those examples and exports them as JSONL files ready for
// fine-tuning (chat examples + preference pairs).
//
// Tables: supabase-schema-training.sql. No new serverless function — the
// user side runs inside /api/memory, the admin side inside /api/admin/training.

import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyRequester, getSupabaseClient } from "./supabaseAdmin.js";

export const POLICY_VERSION = "2026-10";
export const GOOD_REASONS = ["accurate", "clear", "creative", "design", "code", "sources", "fast"];
export const BAD_REASONS = ["wrong", "ignored", "design", "code", "long", "short", "outdated", "refused", "other"];
const MODES = new Set(["chat", "code", "studio", "agent"]);
const MAX_CONTEXT = 12;
const MAX_MSG = 12000;
const MAX_REPLY = 60000;

// ---------------------------------------------------------------- signing
// The server signs every reply it writes. A rating that comes back with a
// matching signature is "verified": elora really wrote that text.
function secret() {
  return process.env.TRAINING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.LLM_API_KEY || "";
}
function hmac(label, text) {
  const key = secret();
  if (!key) return "";
  return createHmac("sha256", `elora-training:${label}:${key}`).update(String(text || "")).digest("hex").slice(0, 32);
}
function same(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export function signReply(text) { return hmac("reply", text); }
export function verifyReply(text, sig) { return same(signReply(text), sig); }
export function feedbackKey(id) { return hmac("feedback", id); }

// ---------------------------------------------------------------- scrubbing
function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
const PRIVATE_IP = /^(127\.|10\.|0\.|255\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Removes personal details and secrets. Keeps the text otherwise intact,
// so code examples stay usable.
export function scrubPII(input) {
  let t = String(input || "");
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]");
  t = t.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token]");
  t = t.replace(/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g, "[secret]");
  t = t.replace(/\b(?:tvly|gsk|ghp|gho|ghu|ghs|github_pat|glpat|hf|xox[abprs]|whsec|rzp|shpat)[-_][A-Za-z0-9_-]{12,}/g, "[secret]");
  t = t.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[secret]");
  t = t.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[secret]");
  t = t.replace(/\b((?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*)(["']?)[^\s"'`]{6,}\2/gi, "$1$2[secret]$2");
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]");
  t = t.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, (m) => (m.replace(/ /g, "").length >= 15 && /\d{6,}/.test(m.replace(/ /g, "")) ? "[iban]" : m));
  t = t.replace(/(?<![\w.])(?:\d[ -]?){12,18}\d(?![\w.])/g, (m) => {
    const d = m.replace(/\D/g, "");
    const spaced = /[ -]/.test(m);
    if (d.length < 13 || d.length > 19) return m;
    if (!spaced && d.length !== 15 && d.length !== 16) return m;
    return luhn(d) ? "[card]" : m;
  });
  t = t.replace(/(?<![\w/.-])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\w/-])/g, "[phone]");
  t = t.replace(/(?<![\w/.-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w/-])/g, "[phone]");
  t = t.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, (m) => (PRIVATE_IP.test(m) ? m : "[ip]"));
  return t;
}

// ---------------------------------------------------------------- quality
// A quick 0–1 guess at how useful an example is, so the best ones are
// reviewed first and "approve high quality" is safe.
export function qualityScore(row) {
  const answer = String(row.improved || row.reply || "");
  let s = 0.5;
  if (row.verified) s += 0.15;
  if (row.improved) s += 0.2;
  if (row.rating === "good") s += 0.1;
  else if (!row.improved) s -= 0.3;
  if (row.rating === "good" && row.rejected) s += 0.05;
  s += Math.min(0.09, (row.reasons || []).length * 0.03) * (row.rating === "good" ? 1 : 0);
  if (answer.length < 40) s -= 0.25;
  if (answer.length > 50000) s -= 0.1;
  if (((answer.match(/```/g) || []).length) % 2) s -= 0.15;
  if (/couldn't be reached|hit today's limit|You stopped this reply|couldn't answer just now/i.test(answer)) s -= 0.4;
  if (!Array.isArray(row.messages) || !row.messages.some((m) => m.role === "user")) s -= 0.2;
  return Math.round(Math.max(0, Math.min(1, s)) * 100) / 100;
}

// ---------------------------------------------------------------- cleaning input
export function cleanContext(messages) {
  if (!Array.isArray(messages)) return [];
  const out = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: scrubPII(m.content.slice(0, MAX_MSG)) }));
  const tail = out.slice(-MAX_CONTEXT);
  while (tail.length && tail[0].role !== "user") tail.shift();
  while (tail.length && tail[tail.length - 1].role !== "user") tail.pop();
  return tail;
}
const clip = (s, n) => (typeof s === "string" && s.trim() ? scrubPII(s.slice(0, n)) : null);

// ---------------------------------------------------------------- export formats
export function systemFor(mode) {
  const ws = MODES.has(mode) ? mode : "chat";
  return `You are elora, the AI assistant built into elorahub (${ws} workspace). You are warm, direct and exceptionally capable: you research carefully, cite sources, write excellent code and design with care.`;
}
// Chat fine-tuning (SFT): {"messages":[system, ...conversation, assistant]}.
export function sftLine(row) {
  const answer = row.improved || (row.rating === "good" ? row.reply : null);
  if (!answer || !Array.isArray(row.messages) || !row.messages.length) return null;
  return JSON.stringify({ messages: [{ role: "system", content: systemFor(row.mode) }, ...row.messages, { role: "assistant", content: answer }] });
}
// Preference pairs (DPO, Hugging Face TRL format): prompt / chosen / rejected.
export function dpoLine(row) {
  if (!Array.isArray(row.messages) || !row.messages.length) return null;
  let chosen = null, rejected = null;
  if (row.improved && row.reply && row.improved.trim() !== row.reply.trim()) { chosen = row.improved; rejected = row.reply; }
  else if (row.rating === "good" && row.reply && row.rejected && row.rejected.trim() !== row.reply.trim()) { chosen = row.reply; rejected = row.rejected; }
  if (!chosen) return null;
  return JSON.stringify({ prompt: [{ role: "system", content: systemFor(row.mode) }, ...row.messages], chosen: [{ role: "assistant", content: chosen }], rejected: [{ role: "assistant", content: rejected }] });
}

// ---------------------------------------------------------------- helpers
export function missingTable(error) {
  return Boolean(error && /does not exist|schema cache|42P01|PGRST205/i.test(`${error.code || ""} ${error.message || ""}`));
}
const hits = new Map();
function throttled(req) {
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 40;
}
function readBody(req) {
  const b = req.body;
  if (b && typeof b === "object") return b;
  try { return JSON.parse(b || "{}"); } catch (_e) { return {}; }
}

async function consentOf(supabase, userId) {
  if (!userId) return { state: "signed-out" };
  const { data, error } = await supabase.from("training_consent").select("consented, consented_at, withdrawn_at").eq("user_id", userId).maybeSingle();
  if (error) return missingTable(error) ? { state: "setup" } : { state: "error" };
  if (!data) return { state: "unset" };
  return { state: data.consented ? "on" : "off", since: data.consented ? data.consented_at : data.withdrawn_at };
}

// ---------------------------------------------------------------- /api/memory (user side)
// GET  /api/memory?training=1            → consent state + how many examples you've shared
// POST /api/memory {action:"consent", on}
// POST /api/memory {action:"feedback", rating, reasons, messages, reply, sig, mode, model, improved, rejected, id, key}
export async function handleTraining(req, res, deps = {}) {
  const supabase = deps.supabase || await getSupabaseClient();
  if (!supabase) return res.status(200).json({ setup: false, state: "setup" });
  const { userId } = deps.user || await verifyRequester(req);

  if (req.method === "GET") {
    const consent = await consentOf(supabase, userId);
    if (consent.state === "setup") return res.status(200).json({ setup: false, state: "setup" });
    let shared = 0;
    if (userId) {
      const { count } = await supabase.from("training_feedback").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("has_content", true).neq("status", "withdrawn");
      shared = count || 0;
    }
    return res.status(200).json({ setup: true, signedIn: Boolean(userId), ...consent, shared });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (throttled(req)) return res.status(429).json({ error: "slow_down", message: "Too many ratings at once — try again in a minute." });
  const body = readBody(req);

  if (body.action === "consent") {
    if (!userId) return res.status(403).json({ error: "forbidden", message: "Sign in to choose this setting." });
    const on = body.on === true;
    const now = new Date().toISOString();
    const row = on ? { user_id: userId, consented: true, policy_version: POLICY_VERSION, consented_at: now, withdrawn_at: null, updated_at: now } : { user_id: userId, consented: false, policy_version: POLICY_VERSION, withdrawn_at: now, updated_at: now };
    const { error } = await supabase.from("training_consent").upsert(row);
    if (error) return res.status(200).json(missingTable(error) ? { setup: false, state: "setup" } : { error: "db_error", message: "Couldn't save that — try again." });
    let removed = 0;
    if (!on) {
      // Withdrawing consent takes your examples out of the training set.
      const { data } = await supabase.from("training_feedback").update({ status: "withdrawn", updated_at: now }).eq("user_id", userId).eq("has_content", true).neq("status", "withdrawn").select("id");
      removed = (data || []).length;
    }
    return res.status(200).json({ ok: true, setup: true, state: on ? "on" : "off", removed });
  }

  if (body.action !== "feedback") return res.status(400).json({ error: "bad_request" });
  const rating = body.rating === "good" || body.rating === "bad" ? body.rating : null;
  if (!rating) return res.status(400).json({ error: "bad_request", message: "rating must be good or bad" });
  const allowed = rating === "good" ? GOOD_REASONS : BAD_REASONS;
  const reasons = [...new Set((Array.isArray(body.reasons) ? body.reasons : []).map(String).filter((r) => allowed.includes(r)))];
  const consent = await consentOf(supabase, userId);
  if (consent.state === "setup") return res.status(200).json({ setup: false, state: "setup" });
  const share = consent.state === "on";

  const reply = typeof body.reply === "string" ? body.reply.slice(0, MAX_REPLY) : "";
  const messages = share && reply ? cleanContext(body.messages) : [];
  const usable = messages.length > 0;
  const improved = share ? clip(body.improved, MAX_REPLY) : null;
  const rejected = share ? clip(body.rejected, MAX_REPLY) : null;
  const now = new Date().toISOString();
  const content = usable ? { messages, reply: scrubPII(reply), rejected, has_content: true, has_rejected: Boolean(rejected), verified: verifyReply(reply, body.sig) } : null;

  // Update an earlier rating of the same reply (reasons added, a better
  // answer written, or the conversation attached after opting in).
  if (body.id && body.key) {
    if (!same(feedbackKey(body.id), body.key)) return res.status(403).json({ error: "forbidden" });
    const { data: prev, error: readErr } = await supabase.from("training_feedback").select("*").eq("id", body.id).maybeSingle();
    if (readErr || !prev) return res.status(404).json({ error: "not_found" });
    if (prev.status === "withdrawn") return res.status(200).json({ ok: true, id: body.id, key: body.key, saved: false, state: consent.state });
    const patch = { rating, reasons, updated_at: now };
    if (MODES.has(body.mode)) patch.mode = body.mode;
    if (body.model) patch.model = String(body.model).slice(0, 80);
    if (content && !prev.has_content) Object.assign(patch, content);
    if (improved && (prev.has_content || content)) Object.assign(patch, { improved, has_improved: true });
    const next = { ...prev, ...patch };
    patch.quality = qualityScore(next);
    if (prev.status !== "pending" && (patch.improved !== undefined || rating !== prev.rating)) patch.status = "pending";
    const { error } = await supabase.from("training_feedback").update(patch).eq("id", body.id);
    if (error) return res.status(200).json({ error: "db_error", message: "Couldn't save that — try again." });
    return res.status(200).json({ ok: true, id: body.id, key: body.key, saved: Boolean(next.has_content), state: consent.state });
  }

  const row = {
    rating, reasons, user_id: userId || null, updated_at: now,
    mode: MODES.has(body.mode) ? body.mode : "chat",
    model: String(body.model || "").slice(0, 80),
    ...(content || {}),
    ...(content && improved ? { improved, has_improved: true } : {}),
  };
  row.quality = qualityScore({ ...row, messages: row.messages || [] });
  const { data, error } = await supabase.from("training_feedback").insert(row).select("id").single();
  if (error) return res.status(200).json(missingTable(error) ? { setup: false, state: "setup" } : { error: "db_error", message: "Couldn't save that — try again." });
  return res.status(200).json({ ok: true, id: data.id, key: feedbackKey(data.id), saved: usable, state: consent.state });
}

// ---------------------------------------------------------------- admin side
const PAGE = 1000;
async function allRows(build, max = 50000) {
  const out = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) return { error, rows: out };
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows: out };
}
export const READY_STEPS = [100, 500, 1000, 5000];

export async function trainingStats(supabase) {
  const { rows, error } = await allRows(() => supabase.from("training_feedback").select("user_id, rating, reasons, mode, model, has_content, has_improved, has_rejected, status, verified, quality, created_at").order("created_at", { ascending: true }));
  if (error) return missingTable(error) ? { setup: false } : { error: error.message };
  const live = rows.filter((r) => r.status !== "withdrawn");
  const content = live.filter((r) => r.has_content);
  const sftOk = (r) => r.has_content && (r.rating === "good" || r.has_improved);
  const dpoOk = (r) => r.has_content && (r.has_improved || (r.rating === "good" && r.has_rejected));
  const tally = (key) => {
    const m = new Map();
    live.forEach((r) => { const k = r[key] || "unknown"; const e = m.get(k) || { name: k, good: 0, bad: 0 }; e[r.rating] += 1; m.set(k, e); });
    return [...m.values()].sort((a, b) => b.good + b.bad - (a.good + a.bad)).slice(0, 12);
  };
  const reasons = (rating) => {
    const m = new Map();
    live.filter((r) => r.rating === rating).forEach((r) => (r.reasons || []).forEach((x) => m.set(x, (m.get(x) || 0) + 1)));
    return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  };
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const daily = Object.fromEntries(days.map((d) => [d, { good: 0, bad: 0 }]));
  live.forEach((r) => { const d = String(r.created_at).slice(0, 10); if (daily[d]) daily[d][r.rating] += 1; });
  const good = live.filter((r) => r.rating === "good").length;
  return {
    setup: true,
    total: live.length, good, bad: live.length - good,
    satisfaction: live.length ? Math.round((good / live.length) * 100) : null,
    shared: content.length,
    contributors: new Set(content.map((r) => r.user_id).filter(Boolean)).size,
    verified: content.filter((r) => r.verified).length,
    pending: content.filter((r) => r.status === "pending").length,
    approved: content.filter((r) => r.status === "approved").length,
    rejected: content.filter((r) => r.status === "rejected").length,
    withdrawn: rows.filter((r) => r.status === "withdrawn").length,
    highQualityPending: content.filter((r) => r.status === "pending" && r.verified && r.rating === "good" && r.quality >= 0.8).length,
    sft: { approved: content.filter((r) => r.status === "approved" && sftOk(r)).length, all: content.filter((r) => r.status !== "rejected" && sftOk(r)).length },
    dpo: { approved: content.filter((r) => r.status === "approved" && dpoOk(r)).length, all: content.filter((r) => r.status !== "rejected" && dpoOk(r)).length },
    steps: READY_STEPS,
    byModel: tally("model"), byMode: tally("mode"),
    badReasons: reasons("bad"), goodReasons: reasons("good"),
    days, daily: days.map((d) => daily[d]),
  };
}

export default async function adminTraining(req, res, deps = {}) {
  const { email, role } = deps.user || await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only the owner and administrators can see training data." });
  }
  const supabase = deps.supabase || await getSupabaseClient();
  if (!supabase) return res.status(500).json({ error: "not_configured", message: "Supabase isn't configured yet." });
  const q = req.query || {};

  if (req.method === "GET" && (q.view || "stats") === "stats") {
    const stats = await trainingStats(supabase);
    return res.status(stats.error ? 500 : 200).json(stats);
  }

  if (req.method === "GET" && q.view === "queue") {
    const status = ["pending", "approved", "rejected"].includes(q.status) ? q.status : "pending";
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    let query = supabase.from("training_feedback").select("id, rating, reasons, mode, model, verified, quality, status, messages, reply, improved, rejected, created_at, reviewed_by, reviewed_at").eq("has_content", true).eq("status", status);
    if (q.rating === "good" || q.rating === "bad") query = query.eq("rating", q.rating);
    query = status === "pending" ? query.order("quality", { ascending: false }).order("created_at", { ascending: false }) : query.order("reviewed_at", { ascending: false, nullsFirst: false });
    const { data, error } = await query.range(offset, offset + 19);
    if (error) return res.status(200).json(missingTable(error) ? { setup: false } : { error: error.message });
    return res.status(200).json({ items: data || [], next: (data || []).length === 20 ? offset + 20 : null });
  }

  if (req.method === "GET" && q.view === "export") {
    const format = q.format === "dpo" ? "dpo" : "sft";
    const scope = q.scope === "all" ? "all" : "approved";
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    let query = supabase.from("training_feedback").select("id, rating, mode, messages, reply, improved, rejected").eq("has_content", true).order("created_at", { ascending: true });
    query = scope === "approved" ? query.eq("status", "approved") : query.in("status", ["pending", "approved"]);
    const { data, error } = await query.range(offset, offset + 199);
    if (error) return res.status(500).json({ error: error.message });
    // Stays under Vercel's response limit; the browser asks for the next part.
    let lines = "", used = 0, count = 0;
    for (const row of data || []) {
      used += 1;
      const line = format === "dpo" ? dpoLine(row) : sftLine(row);
      if (line) { lines += line + "\n"; count += 1; }
      if (lines.length > 3000000) break;
    }
    const more = (data || []).length === 200 || used < (data || []).length;
    return res.status(200).json({ lines, count, next: more ? offset + used : null });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    const now = new Date().toISOString();
    if (body.action === "approve-high") {
      const { data, error } = await supabase.from("training_feedback").update({ status: "approved", reviewed_by: email, reviewed_at: now }).eq("status", "pending").eq("has_content", true).eq("verified", true).eq("rating", "good").gte("quality", 0.8).select("id");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, approved: (data || []).length });
    }
    const status = ["approved", "rejected", "pending"].includes(body.status) ? body.status : null;
    if (!body.id || !status) return res.status(400).json({ error: "bad_request" });
    const patch = { status, reviewed_by: email, reviewed_at: now, updated_at: now };
    if (typeof body.improved === "string") {
      const improved = body.improved.trim() ? scrubPII(body.improved.slice(0, MAX_REPLY)) : null;
      Object.assign(patch, { improved, has_improved: Boolean(improved) });
    }
    const { data: prev } = await supabase.from("training_feedback").select("*").eq("id", body.id).maybeSingle();
    if (!prev || prev.status === "withdrawn") return res.status(404).json({ error: "not_found" });
    patch.quality = qualityScore({ ...prev, ...patch });
    const { error } = await supabase.from("training_feedback").update(patch).eq("id", body.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
