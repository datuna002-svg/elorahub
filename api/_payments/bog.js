// Bank of Georgia online payments (BOG Payments API) — elorahub's own checkout.
//
// Flow:
//   1. checkout: create an order, ask the bank to save the card for automatic
//      payments, and send the customer to the bank's secure payment page.
//   2. callback / status: the bank reports the result; we ALWAYS re-read the
//      order from the bank with our own credentials before trusting it, then
//      switch the plan on.
//   3. renewals (daily cron): charge the saved card when a period ends; after
//      three failed attempts the account goes back to Free.
// Docs: https://api.bog.ge/docs/en/payments/introduction
import { createVerify, randomBytes } from "node:crypto";
import { getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";

const TOKEN_URL = "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token";
const API = "https://api.bog.ge/payments/v1";
export const SITE = (process.env.SITE_ORIGIN || process.env.APP_URL || "https://elorahub.online").replace(/\/$/, "");

// The bank's published key for signing callbacks (Callback-Signature header).
const BOG_PUBLIC_KEY = process.env.BOG_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu4RUyAw3+CdkS3ZNILQh
zHI9Hemo+vKB9U2BSabppkKjzjjkf+0Sm76hSMiu/HFtYhqWOESryoCDJoqffY0Q
1VNt25aTxbj068QNUtnxQ7KQVLA+pG0smf+EBWlS1vBEAFbIas9d8c9b9sSEkTrr
TYQ90WIM8bGB6S/KLVoT1a7SnzabjoLc5Qf/SLDG5fu8dH8zckyeYKdRKSBJKvhx
tcBuHV4f7qsynQT+f2UYbESX/TLHwT5qFWZDHZ0YUOUIvb8n7JujVSGZO9/+ll/g
4ZIWhC1MlJgPObDwRkRd8NFOopgxMcMsDIZIoLbWKhHVq67hdbwpAq9K9WMmEhPn
PwIDAQAB
-----END PUBLIC KEY-----`;

export const PLANS = {
  private: { name: "Private", monthly: 15, yearly: 144, credits: 500 },
  premium: { name: "Premium", monthly: 25, yearly: 240, credits: 0 }, // premium is unlimited
};
const CURRENCIES = ["USD", "EUR", "GBP", "GEL"];
export function currency() {
  const c = String(process.env.BOG_CURRENCY || "USD").toUpperCase();
  return CURRENCIES.includes(c) ? c : "USD";
}
export function bogConfigured() {
  return Boolean(process.env.BOG_CLIENT_ID && process.env.BOG_CLIENT_SECRET);
}
export function priceFor(plan, cycle) {
  const p = PLANS[plan];
  if (!p || (cycle !== "monthly" && cycle !== "yearly")) return null;
  const env = process.env[`BOG_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`];
  const amount = env && Number(env) > 0 ? Number(env) : p[cycle];
  return Math.round(amount * 100) / 100;
}
export function addPeriod(fromIso, cycle) {
  const d = new Date(fromIso);
  if (cycle === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}
export function newExternalId(plan, cycle, kind) {
  // e.g. "eh-pm-m-a1b2c3d4e5f6" = premium, monthly; "r" marks a renewal.
  return `eh-${plan === "premium" ? "pm" : "pv"}-${cycle === "yearly" ? "y" : "m"}${kind === "renewal" ? "r" : ""}-${randomBytes(6).toString("hex")}`;
}

// ---- bank API ----
let tokenCache = { value: null, until: 0 };
export async function bogToken(fetchImpl = fetch) {
  if (tokenCache.value && Date.now() < tokenCache.until) return tokenCache.value;
  const basic = Buffer.from(`${process.env.BOG_CLIENT_ID}:${process.env.BOG_CLIENT_SECRET}`).toString("base64");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`BOG auth failed (${res.status})`);
  tokenCache = { value: data.access_token, until: Date.now() + Math.max(30, (Number(data.expires_in) || 300) - 60) * 1000 };
  return tokenCache.value;
}
async function bogCall(method, path, body, fetchImpl = fetch) {
  const token = await bogToken(fetchImpl);
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Accept-Language": "en", "Idempotency-Key": cryptoUuid() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) { const err = new Error(`BOG ${method} ${path} → ${res.status}`); err.status = res.status; err.data = data; throw err; }
  return data;
}
function cryptoUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function orderBody({ plan, cycle, externalId, amount, email }) {
  const p = PLANS[plan];
  return {
    callback_url: `${SITE}/api/pay/callback`,
    external_order_id: externalId,
    application_type: "web",
    capture: "automatic",
    ttl: 30,
    purchase_units: {
      currency: currency(),
      total_amount: amount,
      basket: [{ product_id: `elora-${plan}-${cycle}`, description: `elora ${p.name} (${cycle})`, quantity: 1, unit_price: amount }],
    },
    redirect_urls: {
      success: `${SITE}/?pay=success&ref=${encodeURIComponent(externalId)}#chat`,
      fail: `${SITE}/?pay=failed&ref=${encodeURIComponent(externalId)}#chat`,
    },
    payment_method: ["card", "google_pay", "apple_pay"],
    buyer: email ? { masked_email: email.replace(/^(.).*(@.*)$/, "$1***$2") } : undefined,
  };
}
export const bogApi = {
  createOrder: (body, f) => bogCall("POST", "/ecommerce/orders", body, f),
  saveCardForAutomatic: (orderId, f) => bogCall("PUT", `/orders/${encodeURIComponent(orderId)}/subscriptions`, null, f),
  chargeSavedCard: (parentId, body, f) => bogCall("POST", `/ecommerce/orders/${encodeURIComponent(parentId)}/subscribe`, body, f),
  receipt: (orderId, f) => bogCall("GET", `/receipt/${encodeURIComponent(orderId)}`, null, f),
};

// SHA256withRSA signature over the raw callback body.
export function verifyCallbackSignature(rawBody, signature, publicKey = BOG_PUBLIC_KEY) {
  if (!signature) return false;
  try {
    const v = createVerify("RSA-SHA256");
    v.update(rawBody);
    v.end();
    return v.verify(publicKey, String(signature).trim(), "base64");
  } catch (_e) {
    return false;
  }
}

// ---- state changes (always driven by a receipt fetched from the bank) ----
export function missingSchema(error) {
  return ["42P01", "PGRST205", "PGRST204"].includes(error?.code) || /relation .* does not exist|could not find the table/i.test(error?.message || "");
}
async function setPlan(supabase, email, plan) {
  const credits = plan === "free" ? 0 : PLANS[plan]?.credits || 0;
  await supabase.from("subscriptions").upsert({ email, plan, credits_total: credits, credits_remaining: credits, updated_at: new Date().toISOString() });
}
export async function applyReceipt(supabase, receipt) {
  const orderId = String(receipt?.order_id || receipt?.id || "");
  const status = String(receipt?.order_status?.key || receipt?.order_status || "").toLowerCase();
  if (!orderId || !status) return { ok: false, reason: "bad_receipt" };
  const { data: order, error } = await supabase.from("bog_orders").select("*").eq("order_id", orderId).maybeSingle();
  if (error) return { ok: false, reason: missingSchema(error) ? "schema_missing" : "db_error" };
  if (!order) return { ok: false, reason: "unknown_order" };
  const now = new Date().toISOString();
  const final = ["completed", "rejected", "refunded", "refunded_partially", "blocked"].includes(status);
  if (order.status === "completed" || (final && order.status === status)) return { ok: true, status: order.status, order, already: true };
  await supabase.from("bog_orders").update({ status, updated_at: now }).eq("order_id", orderId);
  const paid = Number(receipt?.purchase_units?.transfer_amount ?? receipt?.purchase_units?.request_amount ?? order.amount);
  const cardType = receipt?.payment_detail?.card_type || null;

  if (status === "completed") {
    if (Number.isFinite(paid) && paid + 0.001 < Number(order.amount)) {
      await logEvent("error", "payments", `BOG order ${orderId} paid ${paid}, expected ${order.amount} — plan not changed.`);
      return { ok: false, reason: "amount_mismatch" };
    }
    const { data: sub } = await supabase.from("bog_subscriptions").select("*").eq("email", order.email).maybeSingle();
    if (order.kind === "renewal" && sub) {
      const base = new Date(sub.current_period_end) > new Date() ? sub.current_period_end : now;
      await supabase.from("bog_subscriptions").update({ status: "active", failures: 0, current_period_end: addPeriod(base, sub.cycle), card_type: cardType || sub.card_type, updated_at: now }).eq("email", order.email);
    } else {
      await supabase.from("bog_subscriptions").upsert({
        email: order.email, plan: order.plan, cycle: order.cycle, status: "active",
        parent_order_id: order.card_saved ? orderId : null, card_type: cardType,
        amount: order.amount, currency: order.currency, current_period_end: addPeriod(now, order.cycle),
        cancel_at_period_end: false, failures: 0, updated_at: now,
      }, { onConflict: "email" });
    }
    await setPlan(supabase, order.email, order.plan);
    await logEvent("info", "payments", `BOG payment completed: ${order.email} → ${order.plan} (${order.cycle}, ${order.kind}).`);
    return { ok: true, status, order };
  }
  if (["rejected", "blocked"].includes(status) && order.kind === "renewal") {
    const { data: sub } = await supabase.from("bog_subscriptions").select("*").eq("email", order.email).maybeSingle();
    if (sub) {
      const failures = (sub.failures || 0) + 1;
      if (failures >= 3) {
        await supabase.from("bog_subscriptions").update({ status: "expired", failures, updated_at: now }).eq("email", order.email);
        await setPlan(supabase, order.email, "free");
        await logEvent("warning", "payments", `BOG renewal failed 3 times for ${order.email} — moved to Free.`);
      } else {
        await supabase.from("bog_subscriptions").update({ status: "past_due", failures, updated_at: now }).eq("email", order.email);
      }
    }
  }
  if (["refunded"].includes(status)) {
    await supabase.from("bog_subscriptions").update({ status: "canceled", updated_at: now }).eq("email", order.email);
    await setPlan(supabase, order.email, "free");
  }
  return { ok: true, status, order };
}

// Daily: charge saved cards that are due, close cancelled ones, and settle
// any renewal whose callback never arrived.
export async function processRenewals(fetchImpl = fetch) {
  if (!bogConfigured()) return { skipped: "not_configured" };
  const supabase = await getSupabaseClient();
  if (!supabase) return { skipped: "storage_unavailable" };
  const now = new Date();
  const soon = new Date(now.getTime() + 20 * 3600 * 1000).toISOString();
  const { data: subs, error } = await supabase.from("bog_subscriptions").select("*").in("status", ["active", "past_due"]).lte("current_period_end", soon).limit(50);
  if (error) return { skipped: missingSchema(error) ? "schema_missing" : "db_error" };
  const out = { charged: 0, ended: 0, failed: 0, settled: 0 };
  for (const sub of subs || []) {
    const ended = new Date(sub.current_period_end) <= now;
    if (sub.cancel_at_period_end || !sub.parent_order_id) {
      if (ended) {
        await supabase.from("bog_subscriptions").update({ status: sub.cancel_at_period_end ? "canceled" : "expired", updated_at: now.toISOString() }).eq("email", sub.email);
        await setPlan(supabase, sub.email, "free");
        out.ended++;
      }
      continue;
    }
    if (sub.last_attempt_at && now - new Date(sub.last_attempt_at) < 20 * 3600 * 1000) continue;
    const externalId = newExternalId(sub.plan, sub.cycle, "renewal");
    try {
      await supabase.from("bog_subscriptions").update({ last_attempt_at: now.toISOString() }).eq("email", sub.email);
      const r = await bogApi.chargeSavedCard(sub.parent_order_id, { callback_url: `${SITE}/api/pay/callback`, external_order_id: externalId }, fetchImpl);
      await supabase.from("bog_orders").insert({ order_id: r.id, external_id: externalId, email: sub.email, plan: sub.plan, cycle: sub.cycle, kind: "renewal", status: "created", amount: sub.amount, currency: sub.currency, card_saved: true });
      out.charged++;
    } catch (err) {
      out.failed++;
      await logEvent("error", "payments", `BOG renewal for ${sub.email} could not start: ${err.message}`);
    }
  }
  const stale = new Date(now.getTime() - 3600 * 1000).toISOString();
  const { data: pending } = await supabase.from("bog_orders").select("order_id").eq("kind", "renewal").in("status", ["created", "processing"]).lte("created_at", stale).limit(30);
  for (const o of pending || []) {
    try { await applyReceipt(supabase, await bogApi.receipt(o.order_id, fetchImpl)); out.settled++; } catch (_e) {}
  }
  return out;
}
