# Connecting real payments — Paddle setup

This makes the "Get Private" / "Get Premium" buttons charge actual money
and land in your bank account. **Paddle is used instead of Stripe because
Stripe doesn't support accounts based in Georgia** — Paddle does, and it
works as a "merchant of record," meaning Paddle itself is the seller on
paper, handles all the tax/compliance paperwork worldwide, and then pays
you out. The checkout form is **inline** — it mounts directly inside
elorahub's own page (not a redirect to paddle.com), so your code never
sees or touches card numbers or bank details.

Code side is already built (`api/paddle-config.js` and
`api/paddle-webhook.js`, plus the checkout modal in `index.html`) — this
document is the one-time account setup that makes it real.

Paddle's fee is **5% + $0.50 per transaction** — a bit more than Stripe's
~2.9% + $0.30, because Paddle is also handling tax compliance for you,
which you'd otherwise have to do yourself.

## 1. Create a Paddle account

paddle.com → **Start selling** / sign up. You'll eventually need to submit
some business/identity info to go live, but everything below can be built
and tested first in **sandbox mode** (a toggle Paddle shows once you're in
the dashboard) using fake test cards, no real money involved.

## 2. Create your products and prices

In the Paddle Dashboard → **Catalog → Products** → **+ Create product**,
create:

- **Private** — $15.00/month recurring, and a second price on the same
  product for $144.00/year (the 20%-off yearly rate shown on the pricing
  page)
- **Premium** — $25.00/month recurring, and $240.00/year

Each price you create gets an ID like `pri_01h8xxxxxxxxxxxxxxxxxxxxxx` —
copy all four; you'll need them in step 4.

## 3. Get your API key and client-side token

Paddle Dashboard → **Developer tools → Authentication**:

- **API key** — a secret, server-side-only key (starts with a long
  string, shown once). This is `PADDLE_API_KEY` below.
- **Client-side token** — this one is *designed to be public*, similar to
  how Stripe's old publishable key worked. It's what lets the checkout
  form open in the browser. This is `PADDLE_CLIENT_TOKEN` below.

## 4. Set environment variables in Vercel

Go to your Vercel project → **Settings → Environment Variables** and add:

```
PADDLE_API_KEY=your_secret_api_key
PADDLE_CLIENT_TOKEN=your_client_side_token
PADDLE_PRICE_PRIVATE_MONTHLY=pri_...
PADDLE_PRICE_PRIVATE_YEARLY=pri_...
PADDLE_PRICE_PREMIUM_MONTHLY=pri_...
PADDLE_PRICE_PREMIUM_YEARLY=pri_...
PADDLE_WEBHOOK_SECRET=whsec... (from step 5 below)
```

While testing, also add `PADDLE_ENV=sandbox` so the checkout form knows
to run in test mode. Remove that variable (or set it to `production`)
once you're ready for real payments.

After adding these, go to the **Deployments** tab and **redeploy** the
latest deployment — env var changes don't apply retroactively.

## 5. Point a webhook at your deployed site

Paddle Dashboard → **Developer tools → Notifications** → **+ New
destination**:

- URL: `https://elorahub.online/api/paddle-webhook`
- Events to send: `transaction.completed`, `subscription.created`,
  `subscription.updated`, `subscription.canceled`

Paddle shows you a **signing secret** right after you create the
destination — that's `PADDLE_WEBHOOK_SECRET` from step 4.

## 6. Test it for real (with fake money)

With `PADDLE_ENV=sandbox` set, click "Get Private" on your deployed site
and use one of Paddle's sandbox test cards (Paddle's docs list these —
search "Paddle sandbox test cards" for the current ones). You should land
back with an active checkout confirmation, and — the important part —
check Vercel's function logs for the webhook: you should see `Paddle
subscription created: ...` printed, confirming the whole loop works.

## 7. What still needs the database

Right now, `paddle-webhook.js` logs each event but doesn't update anyone's
plan anywhere permanent, because there's no `users`/`subscriptions` table
yet (see BACKEND-ROADMAP.md). The exact spots to add that are marked with
comments in that file — once those tables exist, that's where a signed-up
user's account actually flips from Free to Private/Premium.

## 8. Going live

When ready for real money: finish Paddle's account verification (business
details + your Bank of Georgia account info for payouts), remove the
`PADDLE_ENV=sandbox` variable (or set it to `production`), and make sure
you've repeated step 5 for a **live** webhook destination — sandbox and
live each need their own.

Payouts follow Paddle's own schedule (typically monthly, after a short
hold period) — check **Paddle Dashboard → Payouts** for your account's
exact schedule and next payout date; that number isn't something this
site's owner console can show directly, since it's Paddle's own ledger.
