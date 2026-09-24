# Setting up real accounts + the owner console — free, no credit card

This gives you: real Google/GitHub/email sign-in, a private owner
workspace only you (and anyone you promote to Administrator/Moderator)
can open, live payment totals, and a real error/event log.

## 1. Create a free Supabase project

1. Go to **supabase.com** → sign up (GitHub sign-in is fastest).
2. Click **New project**. Pick any name and a strong database password
   (save that password somewhere — you likely won't need it again, but
   keep it just in case).
3. Wait ~1-2 minutes for it to finish provisioning.

## 2. Create the database tables

1. In your new project, open **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `supabase-schema.sql` from this repo, copy its entire contents,
   paste it into the editor.
4. **Before running it:** if `datuna002@gmail.com` isn't the email you
   want as the owner, change it in the `insert into public.roles` line.
5. Click **Run**. You should see "Success" — this creates the `roles`
   and `error_logs` tables and marks you as owner.

## 3. Get your API keys

1. Go to **Settings → API** (left sidebar).
2. Copy the **Project URL** (looks like `https://xxxxx.supabase.co`).
3. Copy the **anon / public key** — this one is safe to be public, it
   goes directly into the website's code.
4. Copy the **service_role / secret key** — this one is NOT safe to be
   public. Never put it in `index.html`. It only goes into Vercel's
   environment variables (step 6).

## 4. Turn on Google sign-in

1. In Supabase: **Authentication → Providers → Google** → toggle it on.
2. Supabase shows you a **Callback URL** on that page — copy it.
3. In a new tab, go to **console.cloud.google.com** → create a project
   (or use an existing one) → **APIs & Services → Credentials**.
4. Click **Create Credentials → OAuth client ID**. If prompted, set up
   the OAuth consent screen first (External, fill in an app name — your
   own email is fine as the support contact).
5. Application type: **Web application**. Under **Authorized redirect
   URIs**, paste the Callback URL you copied from Supabase.
6. Click Create. Copy the **Client ID** and **Client secret** it gives you.
7. Back in Supabase's Google provider settings, paste both in, and Save.

## 5. Turn on GitHub sign-in

1. In Supabase: **Authentication → Providers → GitHub** → toggle it on,
   copy its Callback URL.
2. Go to **github.com/settings/developers** → **OAuth Apps** → **New
   OAuth App**.
3. Homepage URL: `https://elorahub.online`. Authorization callback URL:
   the Callback URL from Supabase.
4. Click **Register application**, then **Generate a new client secret**.
5. Copy the **Client ID** and **Client secret** into Supabase's GitHub
   provider settings, and Save.

## 6. Allow your real domain

Still in Supabase: **Authentication → URL Configuration** → set **Site
URL** to `https://elorahub.online`, and add `https://elorahub.online` to
**Redirect URLs** (this is what lets sign-in actually send people back to
your live site instead of failing).

## 7. Add the keys to your site

**Client-side (safe to be public)** — open `index.html`, find this near
the top of the `<script>` block:

```js
var SUPABASE_URL = "YOUR_SUPABASE_URL";
var SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";
```

Replace both placeholder strings with your real Project URL and anon key
from step 3, commit, and push.

**Server-side (secret — Vercel env vars, never in the code)**: go to your
Vercel project → **Settings → Environment Variables**, and add:

- `SUPABASE_URL` = same Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = the service_role key from step 3

Redeploy after adding these (Deployments tab → redeploy latest).

## 8. Confirm it works

1. Visit your live site, click **Sign up**, try Google, GitHub, and email
   sign-in — all three should work for real now.
2. Go to the owner console (footer link → "Owner console"). Signed in as
   the email you set as owner in step 2, you should see the real
   dashboard: sign-up count, subscriptions (0 until Stripe is live),
   payout balance ($0 until Stripe is live), and an empty log (until
   something real happens — or click the "test event" button to confirm
   logging works end to end).
3. Try adding another email as Administrator or Moderator from the Roles
   section — sign in as that email in another browser/incognito window
   and confirm they can (or, for Moderator, can't) see the same data.

## What this doesn't do yet

- Chat messages still aren't stored anywhere server-side, so the
  moderation queue has nothing to show yet — that's a separate project
  (a `messages` table + writing to it from `api/chat.js`) if you want
  real content moderation later.
- Apple sign-in isn't wired up (skipped for now — it requires a $99/yr
  Apple Developer account). Ask if you want it added later.
