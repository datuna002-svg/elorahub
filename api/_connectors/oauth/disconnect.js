import { verifyRequester, getSupabaseClient } from "../../_lib/supabaseAdmin.js";
import { decryptSecret, getConnectorRow } from "../../_lib/connectors.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const provider = String(req.query?.provider || "").toLowerCase();
  if (provider !== "google" && provider !== "github") return res.status(404).json({ error: "unknown_provider" });
  const { userId, email } = await verifyRequester(req);
  if (!userId || !email) return res.status(401).json({ error: "authentication_required" });
  const { supabase, row } = await getConnectorRow(userId, provider);
  if (!supabase) return res.status(503).json({ error: "connector_storage_unavailable" });
  const token = row ? decryptSecret(row.access_token_encrypted) : null;
  if (token) {
    try {
      if (provider === "google") await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
      else await fetch("https://api.github.com/installation/token", { method: "DELETE", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    } catch (_error) { /* still remove the locally stored grant; any remaining token expires at the provider */ }
  }
  const { error } = await supabase.from("user_connectors").delete().eq("user_id", userId).eq("provider", provider);
  if (error) return res.status(500).json({ error: "disconnect_failed" });
  return res.status(200).json({ ok: true, note: provider === "github" ? "EloraHub's stored access was removed. The GitHub App itself may still need to be uninstalled in GitHub settings." : "EloraHub's stored access was removed." });
}
