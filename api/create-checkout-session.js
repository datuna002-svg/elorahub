// /api/create-checkout-session.js
//
// Creates a real Stripe Checkout session and returns its URL. The front end
// redirects the browser there — Stripe hosts the actual payment page, so
// this server never sees or touches card details.
//
// Requires a Stripe account (any account can do this — you do NOT need
// Stripe Connect, which is only for platforms paying out to other people).
// See STRIPE-SETUP.md in this folder for the one-time setup steps.

import Stripe from "stripe";

// Constructed lazily inside the handler (not at module load) so a missing
// key doesn't crash the whole function before the friendlier check below
// can run.
let stripe;

// Maps a (plan, cycle) pair to the Stripe Price ID you created in the
// Stripe Dashboard. These are placeholders — replace them with your real
// price IDs (they look like "price_1Qxxxxxxxxxxxxxxxxxxxxxx") once you've
// created the products in Stripe. See STRIPE-SETUP.md.
const PRICE_IDS = {
  "private-monthly": process.env.STRIPE_PRICE_PRIVATE_MONTHLY,
  "private-yearly": process.env.STRIPE_PRICE_PRIVATE_YEARLY,
  "premium-monthly": process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
  "premium-yearly": process.env.STRIPE_PRICE_PREMIUM_YEARLY,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not set.");
    return res.status(500).json({ error: "not_configured", message: "Payments aren't set up yet." });
  }
  stripe = stripe || new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const { plan, cycle, customerEmail } = req.body || {};
  const key = `${plan}-${cycle}`;
  const priceId = PRICE_IDS[key];

  if (!priceId) {
    return res.status(400).json({
      error: "invalid_plan",
      message: `No price configured for "${plan}" billed "${cycle}". Valid combinations: ` + Object.keys(PRICE_IDS).join(", "),
    });
  }

  // Where Stripe sends the browser back to after checkout. Adjust these
  // paths if your success/cancel handling should land somewhere else.
  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
      customer_email: customerEmail || undefined,
      // Carrying the plan/cycle through as metadata means the webhook
      // (stripe-webhook.js) can read them back without a database lookup —
      // useful until real accounts exist to look up instead.
      metadata: { plan, cycle },
      subscription_data: {
        metadata: { plan, cycle },
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err.message);
    return res.status(502).json({ error: "stripe_error", message: "Couldn't start checkout. Try again in a moment." });
  }
}
