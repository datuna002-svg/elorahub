// GET  -> the current site announcement banner (public — every visitor's
//         page load calls this, no sign-in required).
// POST -> turn the banner on/off and set its message. Owner + admins only.

import { verifyRequester, getSupabaseClient, logEvent } from "./_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const supabase = await getSupabaseClient();
  if (!supabase) return res.status(200).json({ enabled: false, message: "" });

  if (req.method === "GET") {
    try {
      const { data } = await supabase.from("site_banner").select("enabled, message").eq("id", true).maybeSingle();
      return res.status(200).json({ enabled: Boolean(data?.enabled), message: data?.message || "" });
    } catch (_err) {
      // Table not created yet (SUPABASE-SETUP.md step not run) — fail
      // quiet, not with an error, since this endpoint is public.
      return res.status(200).json({ enabled: false, message: "" });
    }
  }

  if (req.method === "POST") {
    const { email, role } = await verifyRequester(req);
    if (!email || !["owner", "administrator"].includes(role)) {
      return res.status(403).json({ error: "forbidden", message: "Only administrators can change this." });
    }
    const { enabled, message } = req.body || {};
    const { error: dbError } = await supabase.from("site_banner").upsert({
      id: true,
      enabled: Boolean(enabled),
      message: typeof message === "string" ? message.slice(0, 400) : "",
      updated_at: new Date().toISOString(),
    });
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    await logEvent(
      "info",
      "banner",
      enabled
        ? `${email} turned the site announcement ON: "${String(message || "").slice(0, 200)}"`
        : `${email} turned the site announcement OFF.`
    );
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
