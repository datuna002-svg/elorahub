// /api/paddle-config.js
//
// Returns the PUBLIC pieces Paddle's checkout needs in the browser: the
// client-side token (designed to be public — same idea as Stripe's old
// publishable key) and the Price IDs for each plan/cycle combo. None of
// this is secret; it's just kept in env vars instead of hardcoded so you
// never have to touch index.html to configure real payments. See
// PADDLE-SETUP.md for where to get each value.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Use GET." });
  }

  const clientToken = process.env.PADDLE_CLIENT_TOKEN || null;
  const environment = process.env.PADDLE_ENV === "sandbox" ? "sandbox" : "production";

  const priceIds = {
    "private-monthly": process.env.PADDLE_PRICE_PRIVATE_MONTHLY || null,
    "private-yearly": process.env.PADDLE_PRICE_PRIVATE_YEARLY || null,
    "premium-monthly": process.env.PADDLE_PRICE_PREMIUM_MONTHLY || null,
    "premium-yearly": process.env.PADDLE_PRICE_PREMIUM_YEARLY || null,
  };

  return res.status(200).json({
    configured: Boolean(clientToken),
    clientToken,
    environment,
    priceIds,
  });
}
