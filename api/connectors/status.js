import { verifyRequester, getSupabaseClient } from "../_lib/supabaseAdmin.js";
import { connectorConfig, isMissingConnectorSchema } from "../_lib/connectors.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  const { userId, email } = await verifyRequester(req);
  if (!userId || !email) return res.status(401).json({ error: "authentication_required" });
  const ready = connectorConfig();
  const supabase = await getSupabaseClient();
  if (!supabase) return res.status(503).json({ error: "connector_storage_unavailable", providers: { google: { ...ready.google, connected: false }, github: { ...ready.github, connected: false } } });
  const { data, error } = await supabase.from("user_connectors").select("provider,metadata,updated_at").eq("user_id", userId);
  if (error && !isMissingConnectorSchema(error)) return res.status(500).json({ error: "connector_status_failed" });
  const connections = new Map((data || []).map((row) => [row.provider, row]));
  const providers = {};
  for (const provider of ["google", "github"]) {
    const row = connections.get(provider);
    providers[provider] = {
      configured: !!ready[provider]?.configured,
      connected: !!row,
      account: row?.metadata?.account || row?.metadata?.email || null,
      connectedAt: row?.updated_at || null,
    };
  }
  return res.status(200).json({ providers });
}
