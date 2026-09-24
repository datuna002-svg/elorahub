# Connecting real payments — Stripe setup

This makes the "Get Private" / "Get Premium" buttons charge actual money
and land in your bank account. Code side is already built and tested
(`api/create-checkout-session.js` and `api/stripe-webhook.js`) — this is
the account setup that makes it real.

## 1. Create a Stripe account

stripe.com → sign up. Stripe will eventually ask for identity/bank details
to activate live payments, but everything below can be built and tested
first in **test mode** (Stripe's toggle in the top-right of the dashboard)
with no real money involved.

## 2. Create your products and prices

In the Stripe Dashboard → Product catalog → **+ Add product**, create:

- **Private** — $15.00/month recurring, and a second price on the same
  product for $144.00/year (that's the 20%-off yearly rate already shown
  on the pricing page)
- **Premium** — $25.00/month recurring, and $240.00/year

Each price you create gets an ID like `price_1Qxxxxxxxxxxxxxxxxxxxxxx` —
copy all four.

## 3. Set environment variables in Vercel

```
STRIPE_SECRET_KEY=sk_test_...          (or sk_live_... when you go live)
STRIPE_PRICE_PRIVATE_MONTHLY=price_...
STRIPE_PRICE_PRIVATE_YEARLY=price_...
STRIPE_PRICE_PREMIUM_MONTHLY=price_...
STRIPE_PRICE_PREMIUM_YEARLY=price_...
STRIPE_WEBHOOK_SECRET=whsec_...        (from step 4 below)
```

Use your **test mode** secret key (`sk_test_...`) while trying this out —
test mode payments use fake card numbers and charge nothing real.

## 4. Point a webhook at your deployed site

In Stripe Dashboard → Developers → Webhooks → **+ Add endpoint**:

- Endpoint URL: `https://elorahub.online/api/stripe-webhook`
- Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

Stripe shows you a signing secret (`whsec_...`) right after you create the
endpoint — that's `STRIPE_WEBHOOK_SECRET` from step 3.

## 5. Test it for real (with fake money)

With Stripe in test mode, click "Get Private" on your deployed site and
use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
You'll land back on your site, and — this is the important part — check
Vercel's function logs for the webhook: you should see `Checkout
completed: ... → private (monthly)` printed, confirming the whole loop
works end to end.

## 6. What still needs the database

Right now, `stripe-webhook.js` logs each event but doesn't update anyone's
plan anywhere permanent, because there's no `users` table yet (see
BACKEND-ROADMAP.md). The exact lines to add are marked with `// TODO` in
that file — once the `users` and `subscriptions` tables exist, that's
where a signed-up user's account actually flips from Free to Private.

## 7. Going live

When ready for real money: finish Stripe's account activation (identity +
bank details for payouts — this is where your bank account gets connected,
not a credit card), flip the dashboard out of test mode, swap
`STRIPE_SECRET_KEY` for the `sk_live_...` version, and repeat step 4 for a
live-mode webhook endpoint (test and live mode have separate webhooks).
