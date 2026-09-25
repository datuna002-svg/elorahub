// GET    -> the signed-in user's own memory profile (what elora has
//           learned about them across past conversations).
// DELETE -> wipe it ("forget me"). Any signed-in user can manage their
//           own memory — this has nothing to do with admin roles.

import { verifyRequester, getUserMemory, deleteUserMemory, logEvent } from "./_lib/supabaseAdmin.js";

export default async function handler(req, res) {
  const { email } = await verifyRequester(req);
  if (!email) {
    return res.status(403).json({ error: "forbidden", message: "Sign in to manage your memory." });
  }

  if (req.method === "GET") {
    const summary = await getUserMemory(email);
    return res.status(200).json({ summary });
  }

  if (req.method === "DELETE") {
    await deleteUserMemory(email);
    await logEvent("info", "memory", `${email} cleared what elora remembers about them.`);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method_not_allowed" });
}
