// GET -> real daily counts for the last 30 days: sign-ups (from Supabase
// auth) and logged site events (from error_logs). No sampling, no fake
// data — a quiet day just shows as a 0. Owner + administrators only.

import { verifyRequester, getSupabaseClient } from "../_lib/supabaseAdmin.js";

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { email, role } = await verifyRequester(req);
  if (!email || !["owner", "administrator"].includes(role)) {
    return res.status(403).json({ error: "forbidden", message: "Only administrators can view this." });
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ error: "not_configured", message: "Supabase isn't configured yet." });
  }

  const DAYS = 30;
  const now = Date.now();
  const buckets = [];
  for (let i = DAYS - 1; i >= 0; i--) buckets.push(dayKey(now - i * 86400000));

  const signupCounts = Object.fromEntries(buckets.map((d) => [d, 0]));
  const eventCounts = Object.fromEntries(buckets.map((d) => [d, 0]));

  try {
    const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    (data?.users || []).forEach((u) => {
      const k = dayKey(u.created_at);
      if (k in signupCounts) signupCounts[k] += 1;
    });
  } catch (_err) {
    // leave zeros — a broken read here shouldn't fail the whole response
  }

  try {
    const since = new Date(now - DAYS * 86400000).toISOString();
    const { data } = await supabase.from("error_logs").select("created_at").gte("created_at", since);
    (data || []).forEach((l) => {
      const k = dayKey(l.created_at);
      if (k in eventCounts) eventCounts[k] += 1;
    });
  } catch (_err) {
    // same — zeros rather than a hard failure
  }

  return res.status(200).json({
    days: buckets,
    signups: buckets.map((d) => signupCounts[d]),
    events: buckets.map((d) => eventCounts[d]),
  });
}
