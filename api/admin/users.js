// GET  -> every signed-up account (from Supabase auth) merged with its
//         plan/credits (from the subscriptions table). Owner + admins.
// POST -> manually set a user's plan/credits — for support or comp
//         purposes. Takes effect immediately, same as a real Paddle
//         renewal would. Owner + admins.

import { verifyRequester, getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";

const DEFAULT_CREDITS = { free: 0, private: 500, premium: 1500 };

export default async function handler(req, res) {
  const { email, role } = await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only administrators can view this." });
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: "not_configured", message: "Supabase isn't configured yet." });
  }

  if (req.method === "GET") {
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (authError) return res.status(500).json({ error: "db_error", message: authError.message });

    const { data: subs, error: subsError } = await supabase
      .from("subscriptions")
      .select("email, plan, credits_total, credits_remaining");
    if (subsError) return res.status(500).json({ error: "db_error", message: subsError.message });

    const subsByEmail = {};
    (subs || []).forEach((s) => { subsByEmail[s.email] = s; });

    const users = (authData?.users || [])
      .map((u) => {
        const normalized = (u.email || "").toLowerCase();
        const sub = subsByEmail[normalized];
        return {
          email: u.email,
          createdAt: u.created_at,
          plan: sub?.plan || "free",
          creditsRemaining: sub?.credits_remaining ?? null,
          creditsTotal: sub?.credits_total ?? null,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ users });
  }

  if (req.method === "POST") {
    const { email: targetEmail, plan } = req.body || {};
    if (!targetEmail || typeof targetEmail !== "string" || !["free", "private", "premium"].includes(plan)) {
      return res.status(400).json({ error: "bad_request", message: "Provide a valid email and plan." });
    }
    const normalized = targetEmail.trim().toLowerCase();
    const credits = DEFAULT_CREDITS[plan];
    const { error: dbError } = await supabase.from("subscriptions").upsert({
      email: normalized,
      plan,
      credits_total: credits,
      credits_remaining: credits,
      updated_at: new Date().toISOString(),
    });
    if (dbError) return res.status(500).json({ error: "db_error", message: dbError.message });
    await logEvent("info", "users", `${email} set ${normalized}'s plan to ${plan} (${credits} credits).`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
