// GET    -> the signed-in user's own memory profile (what elora has
//           learned about them across past conversations).
// DELETE -> wipe it ("forget me"). Any signed-in user can manage their
//           own memory — this has nothing to do with admin roles.

// Also "Help train elora" (api/_lib/training.js), so it doesn't need its
// own serverless function:
// GET  ?training=1                       -> your training-data setting
// POST {action:"consent"|"feedback", …}  -> change it / rate a reply
// Rating works signed out too; only the rating itself is kept then.

import { verifyRequester, getUserMemory, deleteUserMemory, logEvent } from "./_lib/supabaseAdmin.js";
import { handleTraining } from "./_lib/training.js";

export default async function handler(req, res) {
  if (req.method === "POST" || (req.method === "GET" && req.query && req.query.training !== undefined)) {
    try { return await handleTraining(req, res); } catch (err) {
      await logEvent("error", "training", `Training feedback failed: ${err && err.message}`);
      return res.status(500).json({ error: "server_error", message: "Couldn't save that — try again." });
    }
  }
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
