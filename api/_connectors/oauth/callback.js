import { verifyOAuthState, connectorRedirectUri, storeConnector, createInstallationToken, SITE_ORIGIN } from "../../_lib/connectors.js";
import { getSupabaseClient } from "../../_lib/supabaseAdmin.js";

function redirectResult(res, value) {
  return res.redirect(302, `${SITE_ORIGIN}/?connector=${encodeURIComponent(value)}#chat`);
}
async function readJson(response) { return response.json().catch(() => ({})); }
async function finishGoogle(req, state) {
  const code = String(req.query?.code || "");
  if (!code) throw new Error("Google did not return an authorization code.");
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || connectorRedirectUri("google");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const tokens = await readJson(tokenResponse);
  if (!tokenResponse.ok || !tokens.access_token) throw new Error("Google authorization could not be completed.");
  const whoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const who = await readJson(whoResponse);
  if (!whoResponse.ok) throw new Error("Google account details could not be verified.");
  const supabase = await getSupabaseClient();
  if (!supabase) throw new Error("Connector storage is unavailable.");
  await storeConnector(supabase, {
    userId: state.userId,
    provider: "google",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString(),
    scopes: String(tokens.scope || "").split(/\s+/).filter(Boolean),
    metadata: { account: who.email || who.name || "Google account", email: who.email || null, sub: who.sub || null },
  });
}
async function finishGitHubInstall(req, state) {
  const installationId = String(req.query?.installation_id || "");
  if (!/^\d{1,20}$/.test(installationId)) throw new Error("GitHub did not return a valid app installation.");
  const verifyState = createVerifyState(state.userId, installationId);
  const params = new URLSearchParams({ client_id: process.env.GITHUB_APP_CLIENT_ID || "", scope: "read:user", state: verifyState, redirect_uri: connectorRedirectUri("github") });
  return { redirect: `https://github.com/login/oauth/authorize?${params.toString()}` };
}
function createVerifyState(userId, installationId) {
  // Imported dynamically to keep all state-signing rules centralized.
  return createOAuthState({ userId, provider: "github", step: "verify", installationId });
}
async function finishGitHubVerify(req, state) {
  const code = String(req.query?.code || "");
  if (!code || !/^\d{1,20}$/.test(String(state.installationId || ""))) throw new Error("GitHub installation verification was incomplete.");
  const redirectUri = connectorRedirectUri("github");
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_APP_CLIENT_ID, client_secret: process.env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const userToken = await readJson(tokenResponse);
  if (!tokenResponse.ok || !userToken.access_token) throw new Error("GitHub user verification failed.");
  const headers = { Authorization: `Bearer ${userToken.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const whoResponse = await fetch("https://api.github.com/user", { headers });
  const who = await readJson(whoResponse);
  if (!whoResponse.ok || !who.id) throw new Error("GitHub account could not be verified.");
  let installation = null;
  for (let page = 1; page <= 10 && !installation; page++) {
    const installationsResponse = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, { headers });
    const installationsData = await readJson(installationsResponse);
    if (!installationsResponse.ok) throw new Error("GitHub app installations could not be verified for this account.");
    const installations = Array.isArray(installationsData.installations) ? installationsData.installations : [];
    installation = installations.find((item) => String(item.id) === String(state.installationId)) || null;
    if (installations.length < 100) break;
  }
  if (!installation) throw new Error("This GitHub app installation is not accessible to the account you verified.");
  const installationToken = await createInstallationToken(state.installationId);
  const supabase = await getSupabaseClient();
  if (!supabase) throw new Error("Connector storage is unavailable.");
  await storeConnector(supabase, {
    userId: state.userId,
    provider: "github",
    accessToken: installationToken.token,
    expiresAt: installationToken.expires_at,
    scopes: ["contents:read", "metadata:read"],
    metadata: { installationId: String(state.installationId), account: installation.account?.login || who.login || "GitHub account", accountType: installation.account?.type || null, installationTarget: installation.repository_selection || "selected", githubUserId: who.id },
  });
}

// Import the shared signer after function declarations to avoid duplicate state logic.
import { createOAuthState } from "../../_lib/connectors.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const provider = String(req.query?.provider || "").toLowerCase();
  if (provider !== "google" && provider !== "github") return res.status(404).send("Unknown connector");
  if (req.query?.error) return redirectResult(res, "error");
  const state = verifyOAuthState(String(req.query?.state || ""), provider);
  if (!state) return redirectResult(res, "state-error");
  try {
    if (provider === "google") {
      if (state.step !== "authorize") throw new Error("Invalid Google authorization state.");
      await finishGoogle(req, state);
      return redirectResult(res, "google-connected");
    }
    if (state.step === "install") {
      const next = await finishGitHubInstall(req, state);
      return res.redirect(302, next.redirect);
    }
    if (state.step === "verify") {
      await finishGitHubVerify(req, state);
      return redirectResult(res, "github-connected");
    }
    throw new Error("Invalid GitHub authorization state.");
  } catch (error) {
    console.error("Connector OAuth callback failed:", error?.message || error);
    return redirectResult(res, `${provider}-error`);
  }
}
