import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { connectorConfig, connectorRedirectUri, createOAuthState } from "../../_lib/connectors.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const provider = String(req.query?.provider || "").toLowerCase();
  if (provider !== "google" && provider !== "github") return res.status(404).json({ error: "unknown_provider" });
  const { userId, email } = await verifyRequester(req);
  if (!userId || !email) return res.status(401).json({ error: "authentication_required" });
  if (!connectorConfig()[provider]?.configured) return res.status(503).json({ error: "provider_not_configured", message: `${provider === "google" ? "Google Drive" : "GitHub"} OAuth is not configured by the site owner yet.` });

  try {
    const state = createOAuthState({ userId, provider, step: provider === "github" ? "install" : "authorize" });
    let target;
    if (provider === "google") {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI || connectorRedirectUri("google"),
        response_type: "code",
        scope: "openid email https://www.googleapis.com/auth/drive.readonly",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      target = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } else {
      const slug = process.env.GITHUB_APP_SLUG;
      target = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${new URLSearchParams({ state }).toString()}`;
    }
    return res.status(200).json({ url: target });
  } catch (error) {
    return res.status(503).json({ error: "oauth_unavailable", message: error.message });
  }
}
