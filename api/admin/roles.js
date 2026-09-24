// GET  -> list everyone with a role (owner + administrators only)
// POST -> grant administrator/moderator to an email (owner only)
// DELETE -> remove someone's role (owner only)
import { verifyRequester, getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const { email, role } = await verifyRequester(req);
  if (!email) {
    return res.status(403).json({ error: "forbidden", message: "Sign in with an authorized account to view this." });
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: "not_configured", message: "Supabase isn't configured yet — see SUPABASE-SETUP.md." });
  }

  if (req.method === "GET") {
    if (!["owner", "administrator"].includes(role)) {
      return res.status(403).json({ error: "forbidden", message: "Only the owner and administrators can view roles." });
    }
    const { data, error: dbError } = await supabase
      .from("roles")
      .select("email, role, added_at")
      .order("added_at", { ascending: true });
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    return res.status(200).json({ roles: data, yourRole: role });
  }

  if (req.method === "POST") {
    if (role !== "owner") {
      return res.status(403).json({ error: "forbidden", message: "Only the owner can add roles." });
    }
    const { email: targetEmail, role: targetRole } = req.body || {};
    if (!targetEmail || typeof targetEmail !== "string" || !["administrator", "moderator"].includes(targetRole)) {
      return res.status(400).json({ error: "bad_request", message: "Provide a valid email and role (administrator or moderator)." });
    }
    const normalized = targetEmail.trim().toLowerCase();
    if (normalized === email) {
      return res.status(400).json({ error: "bad_request", message: "That's already you (the owner)." });
    }
    const { error: dbError } = await supabase.from("roles").upsert({ email: normalized, role: targetRole });
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    await logEvent("info", "roles", `${email} granted ${targetRole} to ${normalized}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (role !== "owner") {
      return res.status(403).json({ error: "forbidden", message: "Only the owner can remove roles." });
    }
    const { email: targetEmail } = req.body || {};
    if (!targetEmail) return res.status(400).json({ error: "bad_request", message: "Provide an email." });
    const normalized = targetEmail.trim().toLowerCase();
    const { error: dbError } = await supabase.from("roles").delete().eq("email", normalized);
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    await logEvent("info", "roles", `${email} removed the role for ${normalized}`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
