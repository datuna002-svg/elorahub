// /api/paddle-webhook.js
//
// Paddle calls this URL directly (not the browser) whenever something
// happens on a subscription: a payment succeeds, a renewal happens, a
// customer cancels. This is the ONLY reliable way to know a payment
// actually went through — never trust the browser closing the checkout
// modal alone, since a user can close the tab after paying but before
// any redirect/callback fires.
//
// IMPORTANT: without a real database yet, this currently just logs each
// event to the owner console's log feed. Once real users/subscriptions
// tables exist, this is where you'd flip a user's plan in the database.

import crypto from "node:crypto";
import { logEvent, getSupabaseClient } from "./_lib/supabaseAdmin.js";

// Which plan each Price ID belongs to, and how many chat credits that
// plan refills to on every successful renewal. Keep these two in sync
// with what you actually charge — see PADDLE-SETUP.md.
const PRICE_PLAN = {
  [process.env.PADDLE_PRICE_PRIVATE_MONTHLY]: "private",
  [process.env.PADDLE_PRICE_PRIVATE_YEARLY]: "private",
  [process.env.PADDLE_PRICE_PREMIUM_MONTHLY]: "premium",
  [process.env.PADDLE_PRICE_PREMIUM_YEARLY]: "premium",
};
const CREDITS_BY_PLAN = { private: 500, premium: 1500 };

// Paddle's subscription webhooks only include a customer_id, not the
// email itself — one extra API call resolves it. Requires the API key
// to have "Customer — Read" permission (see PADDLE-SETUP.md).
async function resolveCustomerEmail(customerId) {
  if (!customerId || !process.env.PADDLE_API_KEY) return null;
  try {
    const res = await fetch(`https://api.paddle.com/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${process.env.PADDLE_API_KEY}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.data?.email || null;
  } catch (_err) {
    return null;
  }
}

// Writes (or refills) a user's plan + credits in the subscriptions
// table, based on a Paddle subscription object. Never throws — a
// database hiccup here shouldn't fail the webhook response to Paddle.
async function upsertSubscription(sub) {
  const priceId = sub.items?.[0]?.price?.id;
  const plan = PRICE_PLAN[priceId];
  if (!plan) return; // unrecognized price — nothing to record

  const email = await resolveCustomerEmail(sub.customer_id);
  if (!email) return;

  try {
    const supabase = await getSupabaseClient();
    if (!supabase) return;
    const creditsTotal = CREDITS_BY_PLAN[plan] || 0;
    await supabase.from("subscriptions").upsert({
      email: email.toLowerCase(),
      plan,
      credits_total: creditsTotal,
      credits_remaining: creditsTotal, // refills every renewal — see note in PADDLE-SETUP.md
      paddle_subscription_id: sub.id,
      updated_at: new Date().toISOString(),
    });
  } catch (_err) {
    // best-effort — logged separately by the caller if needed
  }
}

async function downgradeToFree(sub) {
  const email = await resolveCustomerEmail(sub.customer_id);
  if (!email) return;
  try {
    const supabase = await getSupabaseClient();
    if (!supabase) return;
    await supabase.from("subscriptions").upsert({
      email: email.toLowerCase(),
      plan: "free",
      credits_total: 0,
      credits_remaining: 0,
      paddle_subscription_id: sub.id,
      updated_at: new Date().toISOString(),
    });
  } catch (_err) {
    // best-effort
  }
}

// Vercel needs the raw, untouched request body to verify Paddle's
// signature — turning off the default JSON body parser makes that
// possible (same reason the old Stripe webhook needed this).
export const config = {
  api: { bodyParser: false },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", (chunk) => chunks.push(chunk));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

// Paddle's signature header looks like "ts=1234567890;h1=abcdef...".
// Verification: HMAC-SHA256(secret, `${ts}:${rawBody}`) must match h1,
// and the timestamp should be recent (guards against a replayed request).
function verifyPaddleSignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(";").map((p) => p.split("=").map((s) => s.trim()))
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  // Reject anything older than 5 minutes — generous enough for normal
  // network delay, tight enough to block a replayed old request.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const signedPayload = `${ts}:${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(h1, "hex"));
  } catch (_err) {
    return false; // length mismatch etc. — treat as invalid, not a crash
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Use POST.");
  }

  const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("PADDLE_WEBHOOK_SECRET is not set.");
    return res.status(500).send("Webhook not configured.");
  }

  const rawBody = await buffer(req);
  const signatureHeader = req.headers["paddle-signature"];

  if (!verifyPaddleSignature(rawBody, signatureHeader, webhookSecret)) {
    console.error("Paddle webhook signature verification failed.");
    await logEvent("error", "paddle-webhook", "Signature verification failed — request rejected.");
    return res.status(400).send("Invalid signature.");
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    return res.status(400).send("Invalid JSON.");
  }

  switch (event.event_type) {
    case "transaction.completed": {
      const tx = event.data || {};
      const email = tx.customer?.email || tx.customer_id || "unknown";
      console.log(`Paddle payment completed: ${email}`);
      await logEvent("info", "paddle-webhook", `Payment completed: ${email}`);
      break;
    }

    case "subscription.created": {
      const sub = event.data || {};
      console.log(`Paddle subscription created: ${sub.id}, status: ${sub.status}`);
      await logEvent("info", "paddle-webhook", `New subscription: ${sub.id} (${sub.status})`);
      if (sub.status === "active" || sub.status === "trialing") {
        await upsertSubscription(sub);
      }
      break;
    }

    case "subscription.updated": {
      const sub = event.data || {};
      console.log(`Paddle subscription updated: ${sub.id}, status: ${sub.status}`);
      if (sub.status === "past_due" || sub.status === "paused") {
        await logEvent("warning", "paddle-webhook", `Subscription ${sub.id} is now ${sub.status} — a payment likely failed.`);
      } else if (sub.status === "active") {
        // Covers both a plan change and a normal renewal — either way,
        // this refills credits_remaining back to the plan's full amount.
        await upsertSubscription(sub);
      }
      break;
    }

    case "subscription.canceled": {
      const sub = event.data || {};
      console.log(`Paddle subscription cancelled: ${sub.id}`);
      await logEvent("info", "paddle-webhook", `Subscription cancelled: ${sub.id}`);
      await downgradeToFree(sub);
      break;
    }

    default:
      console.log(`Unhandled Paddle event type: ${event.event_type}`);
  }

  // Always return 200 quickly once you've read the event — Paddle retries
  // on non-2xx responses, which can cause duplicate processing if your
  // handler is slow or errors after already doing the important part.
  return res.status(200).json({ received: true });
}
