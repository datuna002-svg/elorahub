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
import { logEvent } from "./_lib/supabaseAdmin.js";

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
      break;
    }

    case "subscription.updated": {
      const sub = event.data || {};
      console.log(`Paddle subscription updated: ${sub.id}, status: ${sub.status}`);
      if (sub.status === "past_due" || sub.status === "paused") {
        await logEvent("warning", "paddle-webhook", `Subscription ${sub.id} is now ${sub.status} — a payment likely failed.`);
      }
      break;
    }

    case "subscription.canceled": {
      const sub = event.data || {};
      console.log(`Paddle subscription cancelled: ${sub.id}`);
      await logEvent("info", "paddle-webhook", `Subscription cancelled: ${sub.id}`);
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
