// /api/pay/:action — elorahub's own checkout with Bank of Georgia.
//   GET  config        → is the bank checkout switched on? prices
//   POST checkout      → create an order, return the bank's payment page URL
//   POST callback      → the bank reports a payment result (raw body, signed)
//   GET  status?ref=   → result of the customer's order after they return
//   GET  subscription  → the caller's subscription (Settings → Billing)
//   POST cancel/resume → stop or restart renewal at the end of the period
import { verifyRequester, getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";
import { bogConfigured, currency, PLANS, priceFor, newExternalId, orderBody, bogApi, verifyCallbackSignature, applyReceipt, missingSchema } from "../_payments/bog.js";

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return JSON.stringify(req.body);
  const chunks = [];
  for await (const c of req) { chunks.push(typeof c === "string" ? Buffer.from(c) : c); if (chunks.reduce((n, x) => n + x.length, 0) > 200000) break; }
  return Buffer.concat(chunks).toString("utf8");
}
function send(res, status, body) { res.setHeader("Cache-Control", "no-store, private"); return res.status(status).json(body); }
const prices = () => Object.fromEntries(Object.keys(PLANS).flatMap((p) => ["monthly", "yearly"].map((c) => [`${p}-${c}`, priceFor(p, c)])));

async function handleConfig(req, res) {
  return send(res, 200, { bog: bogConfigured(), currency: currency(), prices: prices() });
}

async function handleCheckout(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  if (!bogConfigured()) return send(res, 503, { error: "not_configured", message: "Card payments aren't switched on yet." });
  const { email } = await verifyRequester(req);
  if (!email) return send(res, 401, { error: "auth_required", message: "Log in first so your plan is linked to your account." });
  let body = {};
  try { body = JSON.parse(await rawBody(req) || "{}"); } catch (_e) { return send(res, 400, { error: "bad_json" }); }
  const plan = body.plan, cycle = body.cycle;
  const amount = priceFor(plan, cycle);
  if (!amount) return send(res, 400, { error: "bad_plan", message: "Choose Private or Premium, monthly or yearly." });
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "storage_unavailable", message: "Payments are temporarily unavailable." });
  const { data: existing, error: subErr } = await supabase.from("bog_subscriptions").select("plan,cycle,status,current_period_end").eq("email", email).maybeSingle();
  if (subErr && missingSchema(subErr)) return send(res, 503, { error: "schema_missing", message: "Payments are being set up — try again soon." });
  if (existing && ["active", "past_due"].includes(existing.status) && existing.plan === plan && new Date(existing.current_period_end) > new Date()) {
    return send(res, 409, { error: "already_subscribed", message: `You already have ${PLANS[plan].name}.` });
  }
  const externalId = newExternalId(plan, cycle, "initial");
  let order;
  try {
    order = await bogApi.createOrder(orderBody({ plan, cycle, externalId, amount, email }));
  } catch (err) {
    await logEvent("error", "payments", `BOG order could not be created: ${err.message} ${JSON.stringify(err.data || {}).slice(0, 300)}`);
    return send(res, 502, { error: "bank_error", message: "The bank couldn't start the payment. Try again in a moment." });
  }
  let cardSaved = false;
  try { await bogApi.saveCardForAutomatic(order.id); cardSaved = true; }
  catch (err) { await logEvent("warning", "payments", `BOG card saving not available for ${order.id}: ${err.message} — this purchase won't renew automatically.`); }
  const { error: insErr } = await supabase.from("bog_orders").insert({ order_id: order.id, external_id: externalId, email, plan, cycle, kind: "initial", status: "created", amount, currency: currency(), card_saved: cardSaved });
  if (insErr) return send(res, 503, { error: missingSchema(insErr) ? "schema_missing" : "db_error", message: "Payments are being set up — try again soon." });
  const redirect = order?._links?.redirect?.href;
  if (!redirect || !/^https:\/\/([a-z0-9-]+\.)*bog\.ge\//i.test(redirect)) return send(res, 502, { error: "bank_error", message: "The bank didn't return a payment page." });
  return send(res, 200, { redirect, ref: externalId, renews: cardSaved });
}

async function handleCallback(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const raw = await rawBody(req);
  const signed = verifyCallbackSignature(raw, req.headers["callback-signature"]);
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch (_e) { return send(res, 400, { error: "bad_json" }); }
  const orderId = payload?.body?.order_id;
  if (!orderId || !bogConfigured()) return send(res, 200, { ok: true });
  if (!signed) await logEvent("warning", "payments", `BOG callback for ${String(orderId).slice(0, 60)} had no valid signature — checking with the bank directly.`);
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "storage_unavailable" });
  try {
    // Never trust the callback body: read the order from the bank ourselves.
    const receipt = await bogApi.receipt(orderId);
    const result = await applyReceipt(supabase, receipt);
    return send(res, 200, { ok: true, status: result.status || null });
  } catch (err) {
    await logEvent("error", "payments", `BOG callback handling failed for ${String(orderId).slice(0, 60)}: ${err.message}`);
    return send(res, 500, { error: "callback_failed" });
  }
}

async function handleStatus(req, res) {
  const { email } = await verifyRequester(req);
  if (!email) return send(res, 401, { error: "auth_required" });
  const ref = String(req.query?.ref || "").slice(0, 60);
  const supabase = await getSupabaseClient();
  if (!supabase || !ref) return send(res, 400, { error: "bad_request" });
  const { data: order } = await supabase.from("bog_orders").select("*").eq("external_id", ref).eq("email", email).maybeSingle();
  if (!order) return send(res, 404, { error: "not_found" });
  let status = order.status;
  if (!["completed", "rejected", "refunded", "blocked"].includes(status) && bogConfigured()) {
    try { const r = await applyReceipt(supabase, await bogApi.receipt(order.order_id)); status = r.status || status; } catch (_e) {}
  }
  return send(res, 200, { status, plan: order.plan, cycle: order.cycle });
}

async function handleSubscription(req, res) {
  const { email } = await verifyRequester(req);
  if (!email) return send(res, 401, { error: "auth_required" });
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "storage_unavailable" });
  const { data: sub, error } = await supabase.from("bog_subscriptions").select("plan,cycle,status,current_period_end,cancel_at_period_end,card_type,amount,currency,parent_order_id").eq("email", email).maybeSingle();
  if (error) return send(res, 200, { subscription: null });
  if (!sub) return send(res, 200, { subscription: null });
  const { parent_order_id, ...rest } = sub;
  return send(res, 200, { subscription: { ...rest, renews: Boolean(parent_order_id) } });
}

async function handleCancel(req, res, resume) {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const { email } = await verifyRequester(req);
  if (!email) return send(res, 401, { error: "auth_required" });
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "storage_unavailable" });
  const { data: sub } = await supabase.from("bog_subscriptions").select("status,current_period_end").eq("email", email).maybeSingle();
  if (!sub || !["active", "past_due"].includes(sub.status)) return send(res, 404, { error: "no_subscription", message: "There's no active subscription to change." });
  await supabase.from("bog_subscriptions").update({ cancel_at_period_end: !resume, updated_at: new Date().toISOString() }).eq("email", email);
  await logEvent("info", "payments", `${email} ${resume ? "resumed" : "cancelled"} their subscription.`);
  return send(res, 200, { ok: true, cancel_at_period_end: !resume, current_period_end: sub.current_period_end });
}

// The signed-in customer's own payments, newest first (for Settings → Billing).
async function handleInvoices(req, res) {
  const { email } = await verifyRequester(req);
  if (!email) return send(res, 401, { error: "auth_required" });
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 200, { invoices: [] });
  const { data, error } = await supabase
    .from("bog_orders")
    .select("external_id,plan,cycle,kind,status,amount,currency,created_at")
    .eq("email", email)
    .in("status", ["completed", "refunded", "partially_refunded"])
    .order("created_at", { ascending: false })
    .limit(24);
  if (error) return send(res, 200, { invoices: [] });
  return send(res, 200, { invoices: (data || []).map((o) => ({ id: o.external_id, plan: o.plan, cycle: o.cycle, kind: o.kind, status: o.status, amount: Number(o.amount), currency: o.currency, created_at: o.created_at })) });
}

const ROUTES = {
  config: handleConfig,
  checkout: handleCheckout,
  callback: handleCallback,
  status: handleStatus,
  subscription: handleSubscription,
  cancel: (req, res) => handleCancel(req, res, false),
  resume: (req, res) => handleCancel(req, res, true),
  invoices: handleInvoices,
};

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) return send(res, 404, { error: "not_found" });
  try {
    return await ROUTES[action](req, res);
  } catch (err) {
    await logEvent("error", "payments", `/api/pay/${action} failed: ${err.message}`);
    return send(res, 500, { error: "server_error", message: "Something went wrong with the payment. Try again." });
  }
}
