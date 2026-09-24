# Getting real AI chat working — free, no credit card

elora's chat calls a real LLM through `/api/chat.js`. The in-chat model
picker offers two genuinely free options right now — [Groq](https://console.groq.com)
and [Gemini](https://aistudio.google.com) — plus "Claude" and "GPT" shown
as **coming soon** placeholders until you're ready to pay for those (they
have no free tier — see PADDLE-SETUP.md's cost notes for context on that
decision). Setting up Groq below is required; Gemini is optional but
recommended since it's also free.

## 1. Get a free Groq API key

1. Go to **console.groq.com** and sign up (Google/GitHub sign-in works).
2. Once logged in, go to **API Keys** in the left sidebar.
3. Click **Create API Key**, name it anything (e.g. "elorahub"), copy the
   key — it starts with `gsk_...`. You won't be able to see it again after
   you close the dialog, so paste it somewhere safe for a second.

## 2. Add it to Vercel

1. Go to your project on **vercel.com** → **Settings** → **Environment
   Variables**.
2. Add a new variable:
   - **Key:** `LLM_API_KEY`
   - **Value:** the `gsk_...` key you just copied
   - **Environment:** Production (and Preview/Development if you want)
3. Click **Save**.
4. Go to the **Deployments** tab and **redeploy** the latest deployment
   (env var changes don't apply retroactively — a redeploy picks them up).

That's it. No other variables are required — the code already defaults to
Groq's endpoint and a free-tier, coding-capable model (`openai/gpt-oss-120b`).

## 3. Confirm it's working

Open your site's chat and send a message. If it's using the real model,
the "thought for X.Xs" tag under the reply will reflect real generation
time and the reply itself will read like an actual model response rather
than the built-in local fallback.

## Free tier limits

Groq's free tier has a request-per-minute and token-per-day cap that's
generous for a new site with light traffic, but can be hit under heavy
use. If you ever outgrow it, either:

- Switch to a paid Groq plan (same code, no changes needed), or
- Point `LLM_ENDPOINT_URL` / `LLM_MODEL` at any other OpenAI-compatible
  provider (OpenRouter, your own self-hosted model — see
  `RUNPOD-DEPLOY.md` for that option, or Together AI, etc.)

## Swapping models

Groq hosts several open models. To change which one elora uses, set
`LLM_MODEL` in Vercel's env vars to any model name Groq currently serves
(check console.groq.com for the current list) — no code changes needed.

## Images (vision)

When someone attaches an image in chat, `/api/chat.js` automatically
switches to a vision-capable model instead of the text one — currently
`qwen/qwen3.8-27b` by default. Groq has changed exact model IDs before
without warning (we already hit this once with the text model), so if
image messages start failing with a `model_not_found`-style error, check
**console.groq.com/docs/vision** for the current vision model ID and set
`LLM_VISION_MODEL` in Vercel's env vars to override it — no code change
needed.

## Links

If a message contains a plain `http(s)://` link, the server fetches that
page itself (6-second timeout, first ~3000 characters of visible text)
and gives the model that content, so elora can actually answer questions
about what's on the page. This only works for public pages that don't
require login, and only reads the first 2 links in a message.

## Adding Gemini (the second free option)

1. Go to **aistudio.google.com/apikey** and sign in with a Google account.
2. Click **Create API key** — copy it (starts with `AIza...`). No credit
   card needed for the free tier.
3. In Vercel → Settings → Environment Variables, add:
   ```
   GEMINI_API_KEY=AIza...
   ```
4. Redeploy. The "Gemini" option in the chat's model picker will now work
   — no other setup needed. Gemini handles images natively (the same
   model does both text and vision, unlike Groq's separate vision model
   above).

If you ever need to change which Gemini model is used, set `GEMINI_MODEL`
in Vercel (default is `gemini-3.8-flash`) — check
**ai.google.dev/gemini-api/docs/pricing** for the current free-tier model
list before changing it.

## How chat credits work (Private/Premium plans)

Signed-in users on a paid plan spend real credits tracked in Supabase
(500/month Private, 1500/month Premium), refilled automatically whenever
Paddle tells your site their subscription renewed (see
`api/paddle-webhook.js` and `supabase-schema-credits.sql` — run that SQL
file once in Supabase's SQL Editor if you haven't already). Anyone not
signed in, or signed in without a paid plan, gets a simple 20-messages/day
free-tier limit instead, same as before. This applies no matter which
model (Groq or Gemini) they're chatting with — the credit is for a
message sent, not tied to a specific model's cost.
