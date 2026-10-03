# Card payments with Bank of Georgia — setup

elorahub has its own checkout built in: customers pick a plan inside the chat,
pay on Bank of Georgia's secure page (card, Apple Pay, Google Pay), and come
back with their plan switched on. Renewals charge the saved card automatically;
customers cancel in Settings → Billing. It stays OFF until the keys below exist.

## 1. Business (one time)
1. Register as an Individual Entrepreneur at a Public Service Hall (or use your LLC).
2. Ask the Revenue Service for Small Business Status (1% turnover tax) if eligible.
3. Open a business (IE) account at Bank of Georgia.

## 2. Ask Bank of Georgia for online payments
Apply for e-commerce / internet acquiring ("BOG Payments" API). Message you can send:

> Hello, I run elorahub.online, an AI assistant sold as a monthly/yearly
> subscription (Private $15/month or $144/year, Premium $25/month or $240/year).
> I'd like to accept online card payments through the BOG Payments API
> (api.bog.ge), including Apple Pay and Google Pay. Please confirm:
> 1) international (foreign) cards are accepted,
> 2) saving cards for automatic recurring payments (subscriptions) is enabled
>    for my merchant account,
> 3) I can charge in USD,
> 4) your commission per payment and when funds reach my account.
> Website: https://elorahub.online — Terms, Privacy Policy, pricing and contact
> (elorahubonline@gmail.com) are on the site. Thank you!

## 3. Database (one time)
Supabase → SQL Editor → New query → paste `supabase-schema-bog.sql` → Run.

## 4. Keys in Vercel
Vercel → Project → Settings → Environment Variables:

| Name | Value |
|---|---|
| `BOG_CLIENT_ID` | client id from Bank of Georgia |
| `BOG_CLIENT_SECRET` | secret key from Bank of Georgia |
| `BOG_CURRENCY` | `USD` (or `GEL`, `EUR`, `GBP` if the bank requires) |

Optional price overrides: `BOG_PRICE_PRIVATE_MONTHLY`, `BOG_PRICE_PRIVATE_YEARLY`,
`BOG_PRICE_PREMIUM_MONTHLY`, `BOG_PRICE_PREMIUM_YEARLY` (numbers, e.g. `25`).

Then Deployments → Redeploy. Until the keys exist, customers who pick a plan
see a friendly "Payments are almost ready" panel; after the redeploy they see
"Pay securely by card" and can pay. The owner console (Purchases and Status)
shows subscriptions, monthly revenue and the latest payments.

## 5. Tell the bank your callback address
`https://elorahub.online/api/pay/callback`
(It's also sent with every order, so this is just in case they ask.)

## How it works
- `POST /api/pay/checkout` creates the order, asks the bank to save the card for
  automatic payments, and returns the bank's payment page.
- `POST /api/pay/callback` — the bank's notification. The order is always re-read
  from the bank with elorahub's own credentials before any plan changes.
- The daily cron (`/api/cron/scheduled-tasks`) charges saved cards when a period
  ends. Three failed tries in a row → the account returns to Free.
- Settings → Billing shows the subscription with Cancel / Keep buttons.
