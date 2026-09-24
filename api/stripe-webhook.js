// /api/stripe-webhook.js
//
// Stripe calls this URL directly (not the browser) whenever something
// happens on a subscription: a payment succeeds, a renewal happens, a
// customer cancels. This is the ONLY reliable way to know a payment
// actually went through — never trust the browser redirect back from
// checkout alone, since a user can close the tab, lose connection, or
// the redirect can just fail after paying successfully.
//
// IMPORTANT: without a real database yet, this currently just logs each
// event. Once the users/subscriptions tables from BACKEND-ROADMAP.md
// exist, the TODO comments below show exactly where to write the update.

import Stripe from "stripe";

// Constructed lazily inside the handler — see note in
// create-checkout-session.js for why this isn't built at module load time.
let stripe;

// Vercel needs the raw request body (unparsed) to verify Stripe's
// signature — turning off the default JSON body parser makes that
// possible.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Use POST.");
  }

  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set.");
    return res.status(500).send("Webhook not configured.");
  }
  stripe = stripe || new Stripe(process.env.STRIPE_SECRET_KEY || "sk_placeholder", { apiVersion: "2024-06-20" });

  let event;
  try {
    const rawBody = await buffer(req);
    // Verifying the signature proves this request really came from Stripe,
    // not someone who found the URL and is pretending a payment happened.
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { plan, cycle } = session.metadata || {};
      console.log(`Checkout completed: ${session.customer_email || session.customer} → ${plan} (${cycle})`);
      // TODO once a database exists:
      //   UPDATE users SET plan = plan WHERE stripe_customer_id = session.customer
      // and store session.subscription as the user's stripe_subscription_id.
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object;
      console.log(`Subscription updated: ${subscription.id}, status: ${subscription.status}`);
      // TODO: sync the user's plan/status if they upgraded, downgraded,
      // or their payment failed and Stripe put them in "past_due".
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      console.log(`Subscription cancelled: ${subscription.id}`);
      // TODO: UPDATE users SET plan = 'free' WHERE stripe_subscription_id = subscription.id
      break;
    }

    default:
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }

  // Always return 200 quickly once you've read the event — Stripe retries
  // on non-2xx responses, which can cause duplicate processing if your
  // handler is slow or errors after already doing the important part.
  return res.status(200).json({ received: true });
}
