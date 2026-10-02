# EloraHub workspace features — deployment setup

The UI and server routes in this change add browser-local projects, artifacts, saved prompts, recent chats, in-tab reminders, daily background AI tasks, and optional read-only Google Drive/GitHub connectors. **Account sync, background jobs, and third-party connectors remain disabled until the site owner completes the setup below.** No API keys or OAuth secrets belong in the repository or in chat messages.

## 1. Run the Supabase migration

In the Supabase project already used by EloraHub, open **SQL Editor → New query**, run [`supabase-schema-workspace.sql`](./supabase-schema-workspace.sql), and verify that it succeeds. It creates:

- `user_workspaces` for private account-synced projects, artifacts, reminders, and prompts;
- `scheduled_tasks` and `scheduled_task_runs` for server-run jobs and their output;
- `user_connectors` for encrypted, per-user OAuth credentials.

All four tables have RLS enabled and intentionally have no browser policies. Only EloraHub's server-side service-role API accesses them. Do not expose the Supabase service-role key to a browser.

The app uses its existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` server environment variables. If account sync currently works in the existing memory features, these are already configured.

## 2. Configure Vercel daily tasks

`vercel.json` schedules `/api/cron/scheduled-tasks` at `00:05 UTC` daily. Add a high-entropy `CRON_SECRET` in Vercel **Project → Settings → Environment Variables** for Production (and Preview only if you want preview cron runs). Vercel sends it in `Authorization: Bearer …`; the route refuses requests when the secret is absent or incorrect.

Daily tasks need a signed-in account and the Supabase migration. They only generate and save a result in the user's Scheduled panel. They do **not** send email/messages, purchase anything, or edit a connected service. Results can be opened from the corresponding schedule card.

Vercel Hobby Cron runs at most once per day and its invocation can occur anywhere in the configured hour (the schedule is UTC). Delivery is best-effort: Vercel documents that a cron may occasionally miss or duplicate an invocation and does not retry failed invocations. A database lease reduces overlapping/duplicate work, but it is not an exactly-once guarantee. The current handler processes at most 20 due tasks per invocation; excess due work remains queued for a later daily run. Function duration limits still apply.

## 3. Optional Google Drive connector

Create an OAuth client in Google Cloud, enable the Google Drive API, configure the consent screen, and add this exact authorized redirect URI:

`https://elorahub.online/api/connectors/google/callback`

Add these Production environment variables in Vercel:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://elorahub.online/api/connectors/google/callback`

The app requests only `openid`, `email`, and `drive.readonly`. Users search their Drive and explicitly select a Google Doc, Sheet, or supported text file. Selected content is inserted into the EloraHub composer; it is not sent to the model until the user presses Send. Other file types are not extracted.

## 4. Optional GitHub connector

Create a GitHub App. Set its **User authorization callback URL** to:

`https://elorahub.online/api/connectors/github/callback`

Grant only repository **Contents: read-only** and **Metadata: read-only** permissions. Do not grant write, administration, issues, pull-request, workflow, or organization-management permissions. Enable user authorization and configure the app to request `read:user`. Install it only on repositories the user chooses. The callback performs a user-verification step before storing an installation token.

Add these Production environment variables in Vercel:

- `GITHUB_APP_ID`
- `GITHUB_APP_SLUG`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_PRIVATE_KEY` (PEM value; use Vercel's multiline secret field)

Users can find their installed repositories, browse contents, and choose a text file to load into the composer. EloraHub will not write to GitHub. Disconnecting removes EloraHub's saved token; the user may also need to uninstall the GitHub App in GitHub settings.

## 5. Shared security secrets

Add the following Production variables in Vercel. Generate each value independently and keep it private:

- `CONNECTOR_OAUTH_STATE_SECRET`: at least 32 random bytes; used to sign short-lived OAuth state.
- `CONNECTOR_ENCRYPTION_KEY`: exactly 32 random bytes, encoded as 64 hexadecimal characters or Base64; used for AES-256-GCM token encryption.
- `SITE_ORIGIN=https://elorahub.online` (the default fallback is also EloraHub's production domain).

A secure shell can produce fresh candidates with `openssl rand -hex 32`; never paste the output into a public issue, repository, or chat. Add them directly in Vercel's encrypted environment-variable UI.

After these changes are published and the environment variables/migration are in place, open **Connectors → Refresh setup status**. Google Drive and GitHub appear as connectable only after the corresponding credentials and database are ready.


## AI provider requirement for offline tasks

Scheduled tasks use EloraHub's existing server-side model configuration (`LLM_API_KEY`/`LLM_ENDPOINT_URL` or `OPENAI_API_KEY`, and optionally `GEMINI_API_KEY` for provider fallback). Configure at least one working server-side AI provider in Vercel. A failed provider run is stored in the task result panel; Vercel does not automatically retry a failed cron invocation.


## Official references

- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), [usage and pricing limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), and [managing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- [GitHub Apps installations REST API](https://docs.github.com/en/rest/apps/installations) and [OAuth app scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
- [Google Drive export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats) and [`files.export`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export).


## Local-to-account behavior

Projects, artifacts, reminders, and saved prompts work in browser storage while signed out. On sign-in, those guest workspace items are merged into the account workspace and the original browser-local copy is retained. Chat transcripts stay in their browser/device-local recents; they are not included in the account workspace sync payload.
