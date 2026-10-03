import { verifyRequester } from "../../_lib/supabaseAdmin.js";
import { getFreshAccess } from "../../_lib/connectors.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
  const { userId, email } = await verifyRequester(req);
  if (!userId || !email) return res.status(401).json({ error: "authentication_required" });
  const query = String(req.query?.q || "").trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: "query_required" });
  try {
    const connection = await getFreshAccess(userId, "google");
    if (!connection) return res.status(404).json({ error: "not_connected" });
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const params = new URLSearchParams({ q: `trashed = false and name contains '${escaped}'`, pageSize: "20", orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,modifiedTime,webViewLink,size),nextPageToken" });
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${connection.accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status === 401 ? 401 : 502).json({ error: "drive_search_failed", message: "Google Drive search failed. Reconnect and try again." });
    return res.status(200).json({ files: (data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink || null, size: f.size ? Number(f.size) : null })) });
  } catch (error) {
    return res.status(503).json({ error: "connector_unavailable", message: error.message });
  }
}
