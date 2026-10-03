// GET -> the owner-console dashboard numbers: real sign-up count (from
// Supabase auth), active subscriptions + monthly revenue (from elorahub's
// own Bank of Georgia records, plus any legacy Paddle subscriptions) and
// the latest payments. Owner + administrators only. Every number is live —
// anything that can't be read is left null and the UI shows "—".

import { verifyRequester, getSupabaseClient } from "../_lib/supabaseAdmin.js";
import { bogConfigured } from "../_payments/bog.js";

const PRICE_PLAN = {
  [process.env.PADDLE_PRICE_PRIVATE_MONTHLY]: "private",
  [process.env.PADDLE_PRICE_PRIVATE_YEARLY]: "private",
  [process.env.PADDLE_PRICE_PREMIUM_MONTHLY]: "premium",
  [process.env.PADDLE_PRICE_PREMIUM_YEARLY]: "premium",
};

async function listActiveSubscriptions(apiKey) {
  const results = [];
  let url = "https://api.paddle.com/subscriptions?status=active&per_page=100";

  // Paddle paginates via a full "next" URL in the response — follow it
  // until there isn't one, capped so a runaway loop can't hang the request.
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Paddle API returned ${res.status}`);
    const body = await res.json();
    results.push(...(body.data || []));
    url = body.meta?.pagination?.has_more ? body.meta.pagination.next : null;
  }

  return results;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { email, role } = await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only the owner and administrators can view this." });
  }

  const result = {
    signups: null,
    activePrivate: null,
    activePremium: null,
    mrrCents: null,
    currency: "usd",
    supabaseConnected: false,
    paddleConnected: Boolean(process.env.PADDLE_API_KEY),
    bogConnected: bogConfigured(),
    recentPayments: [],
  };

  // --- Real sign-up count, from Supabase's own user table ---
  const supabase = await getSupabaseClient();
  if (supabase) {
    result.supabaseConnected = true;
    try {
      const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (!error && data?.users) result.signups = data.users.length;
    } catch (_err) {
      // leave as null — the UI shows "—" rather than a fake number
    }
  }

  // --- Real subscriptions + estimated MRR, from Paddle ---
  if (result.paddleConnected) {
    try {
      const subs = await listActiveSubscriptions(process.env.PADDLE_API_KEY);

      let activePrivate = 0;
      let activePremium = 0;
      let mrrCents = 0;
      let currency = "usd";

      for (const sub of subs) {
        const item = sub.items?.[0];
        const priceId = item?.price?.id;
        const plan = PRICE_PLAN[priceId];
        if (!plan) continue;

        if (plan === "private") activePrivate += 1;
        if (plan === "premium") activePremium += 1;

        const amountCents = Number(item.price?.unit_price?.amount || 0);
        currency = (item.price?.unit_price?.currency_code || currency).toLowerCase();
        const interval = item.price?.billing_cycle?.interval;
        if (interval === "month") mrrCents += amountCents;
        else if (interval === "year") mrrCents += Math.round(amountCents / 12);
      }

      result.activePrivate = activePrivate;
      result.activePremium = activePremium;
      result.mrrCents = mrrCents;
      result.currency = currency;
    } catch (err) {
      result.paddleError = err.message;
    }
  }

  // --- Bank of Georgia: elorahub's own subscription + payment records ---
  if (supabase) {
    try {
      const nowIso = new Date().toISOString();
      const { data: subs, error } = await supabase
        .from("bog_subscriptions")
        .select("plan, cycle, status, amount, currency, current_period_end")
        .in("status", ["active", "past_due"])
        .gt("current_period_end", nowIso);
      if (error) throw new Error(error.message);
      let priv = 0, prem = 0, cents = 0, cur = null;
      for (const sub of subs || []) {
        if (sub.plan === "private") priv += 1;
        if (sub.plan === "premium") prem += 1;
        const c = Math.round(Number(sub.amount || 0) * 100);
        cents += sub.cycle === "yearly" ? Math.round(c / 12) : c;
        cur = cur || String(sub.currency || "USD").toLowerCase();
      }
      result.activePrivate = (result.activePrivate || 0) + priv;
      result.activePremium = (result.activePremium || 0) + prem;
      result.mrrCents = (result.mrrCents || 0) + cents;
      if (cur && !result.paddleConnected) result.currency = cur;

      const { data: orders } = await supabase
        .from("bog_orders")
        .select("email, plan, cycle, kind, status, amount, currency, created_at")
        .order("created_at", { ascending: false })
        .limit(8);
      result.recentPayments = orders || [];
    } catch (err) {
      result.bogError = err.message;
    }
  }

  return res.status(200).json(result);
}
