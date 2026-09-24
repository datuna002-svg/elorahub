// GET -> the caller's own role, if any (owner / administrator / moderator).
// Unlike /api/admin/roles.js (owner+administrator only, since it lists
// EVERYONE's roles), this endpoint is safe for moderators to call too —
// it only ever reveals the caller's own role, nothing about anyone else.
// This is what the Administrator console uses to decide whether to show
// the full console or the limited moderator view.

import { verifyRequester } from "../_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const { email, role } = await verifyRequester(req);
  if (!email || !role) {
    return res.status(403).json({ error: "forbidden", message: "Sign in with an authorized account to view this." });
  }

  return res.status(200).json({ email, role });
}
