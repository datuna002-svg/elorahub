// GET  -> the last 100 real system events/errors (owner + administrators only)
// POST -> insert a manual test event, so you can confirm the console works
//         end to end before a real error ever happens
import { verifyRequester, getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const { email, role } = await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only the owner and administrators can view system logs." });
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: "not_configured", message: "Supabase isn't configured yet — see SUPABASE-SETUP.md." });
  }

  if (req.method === "GET") {
    const { data, error: dbError } = await supabase
      .from("error_logs")
      .select("id, level, source, message, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    return res.status(200).json({ logs: data });
  }

  if (req.method === "POST") {
    await logEvent("info", "manual-test", `Test event triggered by ${email} from the owner console.`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
