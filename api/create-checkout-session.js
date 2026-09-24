// /api/create-checkout-session.js
//
// Creates a real Stripe Checkout session in EMBEDDED mode — the payment
// form mounts inside elorahub's own page (via Stripe.js on the client)
// instead of redirecting the browser away to a stripe.com page. Stripe
// still renders and handles the actual card/PayPal fields inside that
// embedded form, so this server (and elorahub's own code) never sees or
// touches card numbers or bank details — that boundary doesn't change,
// only where the iframe visually sits.
//
// Which payment methods appear (card, PayPal, etc.) is controlled in the
// Stripe Dashboard → Settings → Payment methods, not in this code — see
// STRIPE-SETUP.md.
//
// Requires a Stripe account (any account can do this — you do NOT need
// Stripe Connect, which is only for platforms paying out to other people).
// See STRIPE-SETUP.md in this folder for the one-time setup steps.

import Stripe from "stripe";
import { logEvent } from "./_lib/supabaseAdmin.js";

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

  // Where Stripe sends the browser once payment completes, inside the
  // embedded form (a real navigation only happens on success/exit).
  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ui_mode: "embedded",
      line_items: [{ price: priceId, quantity: 1 }],
      return_url: `${origin}/?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
      customer_email: customerEmail || undefined,
      // Carrying the plan/cycle through as metadata means the webhook
      // (stripe-webhook.js) can read them back without a database lookup —
      // useful until real accounts exist to look up instead.
      metadata: { plan, cycle },
      subscription_data: {
        metadata: { plan, cycle },
      },
    });

    return res.status(200).json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error("Stripe checkout session creation failed:", err.message);
    await logEvent("error", "checkout", `Checkout session creation failed: ${err.message}`);
    return res.status(502).json({ error: "stripe_error", message: "Couldn't start checkout. Try again in a moment." });
  }
}
