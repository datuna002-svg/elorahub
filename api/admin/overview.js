// GET -> the owner-console dashboard numbers: real sign-up count (from
// Supabase auth), real active-subscription counts + MRR (from Stripe
// subscriptions), and the real Stripe balance (what you'd actually get
// paid out). Every number here is live — nothing is hardcoded/fake.
// Owner + administrators only.
import { verifyRequester, getSupabaseClient } from "../_lib/supabaseAdmin.js";

const PRICE_IDS = {
  [process.env.STRIPE_PRICE_PRIVATE_MONTHLY]: { plan: "private", cents: null },
  [process.env.STRIPE_PRICE_PRIVATE_YEARLY]: { plan: "private", cents: null },
  [process.env.STRIPE_PRICE_PREMIUM_MONTHLY]: { plan: "premium", cents: null },
  [process.env.STRIPE_PRICE_PREMIUM_YEARLY]: { plan: "premium", cents: null },
};
const MONTHLY_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_PRIVATE_MONTHLY,
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
]);
const YEARLY_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_PRIVATE_YEARLY,
  process.env.STRIPE_PRICE_PREMIUM_YEARLY,
]);

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
    payoutsAvailableCents: null,
    payoutsPendingCents: null,
    supabaseConnected: false,
    stripeConnected: Boolean(process.env.STRIPE_SECRET_KEY),
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

  // --- Real subscriptions + estimated MRR + payout balance, from Stripe ---
  if (result.stripeConnected) {
    try {
      const { default: Stripe } = await import("stripe");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      let activePrivate = 0;
      let activePremium = 0;
      let mrrCents = 0;
      let startingAfter;
      do {
        const page = await stripe.subscriptions.list({ status: "active", limit: 100, starting_after: startingAfter });
        for (const sub of page.data) {
          const priceId = sub.items?.data?.[0]?.price?.id;
          const amount = sub.items?.data?.[0]?.price?.unit_amount || 0;
          const info = PRICE_IDS[priceId];
          if (!info) continue;
          if (info.plan === "private") activePrivate += 1;
          if (info.plan === "premium") activePremium += 1;
          if (MONTHLY_PRICE_IDS.has(priceId)) mrrCents += amount;
          else if (YEARLY_PRICE_IDS.has(priceId)) mrrCents += Math.round(amount / 12);
        }
        startingAfter = page.has_more ? page.data[page.data.length - 1].id : undefined;
      } while (startingAfter);

      result.activePrivate = activePrivate;
      result.activePremium = activePremium;
      result.mrrCents = mrrCents;

      const balance = await stripe.balance.retrieve();
      result.payoutsAvailableCents = balance.available.reduce((s, b) => s + b.amount, 0);
      result.payoutsPendingCents = balance.pending.reduce((s, b) => s + b.amount, 0);
      result.currency = balance.available[0]?.currency || "usd";
    } catch (err) {
      result.stripeError = err.message;
    }
  }

  return res.status(200).json(result);
}
