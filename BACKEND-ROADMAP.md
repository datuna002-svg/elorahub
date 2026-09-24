# elorahub — what it takes to go from preview to real product

The site you have now (`index.html`) is a complete, polished front end. Four things in it are currently simulated and need real backend infrastructure before they'll work for actual users: **live AI chat, social sign-in, payments, and secure admin roles.** This doc is the build plan for all four.

---

## 1. The four gaps, plainly

| What you asked for | What's true right now | What it needs |
|---|---|---|
| Chat that really analyzes questions, for unlimited users, 24/7 | A JS function that pattern-matches your message and fills in a template | A backend endpoint that calls a real Claude model, with your API key kept server-side |
| Sign in with Google / Apple / GitHub | Buttons that show a toast | Real OAuth apps registered with each provider, plus something to handle the login (Supabase Auth is the fastest path) |
| You get paid when people subscribe | A "Connect payout account" button that does nothing | A real Paddle account, with your bank account added in *their* dashboard — not a credit card. (Stripe was the original plan but doesn't support Georgia-based accounts, so Paddle is used instead — see PADDLE-SETUP.md.) |
| Owner / Admin / Moderator roles | A client-side email check anyone can bypass via dev tools | Roles stored in a real database, checked on the server, tied to a real logged-in session |

None of this can live safely in a static HTML file — anything in the browser is visible to anyone who opens dev tools, including API keys and "who's the owner" checks.

---

## 2. Recommended stack

You don't need a large team or a custom server to do this properly. The fastest reliable path:

- **Supabase** — handles user accounts, Google/GitHub/Apple sign-in, and your database (Postgres) in one product. Free tier is generous enough to launch on.
- **A serverless function** (Vercel functions, as built) — the one place your LLM API key and Paddle API key live. The browser never sees them.
- **Paddle** — subscription billing for Private and Premium, plus your own payouts (Paddle acts as merchant of record and pays out to your bank on its own schedule — used instead of Stripe because Stripe doesn't support Georgia-based accounts).
- **Vercel or Netlify** — hosts the static front end at elorahub.online, free for this traffic level to start.

This whole stack can be free or near-free until you have real paying users.

---

## 3. Data model (the tables you'll need)

```
users
  id, email, auth_provider, created_at, plan ('free' | 'private' | 'premium')

usage_counters
  user_id, date, messages_sent, files_uploaded

conversations
  id, user_id, title, created_at

messages
  id, conversation_id, role ('user' | 'assistant'), content, created_at

roles
  user_id, role ('owner' | 'administrator' | 'moderator')

flags
  id, conversation_id, reason, status ('open' | 'approved' | 'removed')

subscriptions
  user_id, paddle_customer_id, paddle_subscription_id, plan, status, current_period_end
```

Supabase's row-level security (RLS) can enforce a lot of this for you — for example, "a user can only read their own conversations" or "only rows in `roles` can grant admin access" — directly in the database, which is far safer than checking roles in front-end JavaScript.

---

## 4. Making chat real

Replace the front end's `generateReply()` call with a `fetch()` to your own endpoint:

1. Browser sends `{ message, conversation_id, files }` to `/api/chat`.
2. The function checks the user's session (are they logged in?) and their plan + today's usage from `usage_counters`.
3. If they're within their limit, it calls the Claude API with your server-held key and the conversation history.
4. It updates `usage_counters`, saves the message + reply to `messages`, and streams the reply back to the browser.
5. If they're over their plan's limit, it returns a "you've hit your limit — upgrade" response instead of calling the model.

**Model choice affects your margin.** As of writing, Claude Sonnet 5 is $2 per million input tokens / $10 per million output tokens — a strong default for quality and cost. Claude Haiku 4.5 ($1 / $5 per million tokens) is a cheaper option if you want to route simpler messages to it and save Sonnet for harder ones. A typical back-and-forth chat message is a few hundred to a couple thousand tokens, so individual messages are fractions of a cent — the real cost driver is volume, especially on an "unlimited" Premium tier. Worth setting a soft internal cap (e.g. flag accounts sending an unusual volume) even on Premium, so one account can't quietly cost you more than its $25 covers. Confirm current pricing at the source before you budget: https://platform.claude.com/docs/en/about-claude/pricing

---

## 5. Real sign-in

With Supabase Auth:
- Turn on the Google, Apple, and GitHub providers in the Supabase dashboard.
- Register an OAuth app with each provider (Google Cloud Console, Apple Developer, GitHub Developer Settings) and drop the credentials into Supabase.
- Replace the front end's modal submit handlers with Supabase's `signInWithOAuth()` calls — a few lines each.

This is the single biggest scope item outside of chat itself, mostly because of the setup steps with three separate providers (Apple's is the most involved — it requires a paid Apple Developer account).

---

## 6. Getting paid

- Create Paddle Products for Private ($15/mo, $144/yr) and Premium ($25/mo, $240/yr).
- Use Paddle's inline checkout for the actual purchase — it mounts inside your own page, so you never handle card numbers.
- A Paddle webhook updates the user's `plan` in your database the moment a subscription starts, renews, or cancels.
- Add your bank account under Paddle's payout settings — that's the one-time step that makes money land in your account. No credit card linking on your end; that's what customers use to pay you.

---

## 7. Locking down Owner / Admin / Moderator

- Move the `roles` table into the database (see section 3).
- On every admin/owner request, the backend checks the *logged-in session's* role from the database — never a value sent from the browser.
- The front-end Owner Console UI you already have can stay almost exactly as-is; only the "is this really the owner" check needs to move server-side, and the fake data (stats, logs, flags) needs to be replaced with real queries.

---

## 8. Suggested build order

1. Supabase project + Google/GitHub sign-in (Apple can come later — it's the slowest to set up).
2. `users` + `roles` tables, with your email seeded as `owner`.
3. Paddle checkout for Private/Premium + webhook to update `plan`.
4. The `/api/chat` function calling Claude, with usage limits enforced.
5. Move Owner Console's role checks and data to the backend.
6. Deploy front end to Vercel/Netlify, point elorahub.online at it.

Steps 1–3 alone get you a real product people can pay for. Step 4 is what turns the chat from a demo into the actual thing you're selling.

---

*Happy to help build any piece of this when you're ready — the serverless chat function is a good first target since it's the core of the product.*
