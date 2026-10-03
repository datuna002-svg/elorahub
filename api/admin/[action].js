// One serverless function for every /api/admin/* endpoint.
//
// Vercel's free (Hobby) plan rejects any deployment with more than 12
// serverless functions, and every .js file under /api counts as one. The
// real admin handlers live in api/_admin/ — folders starting with "_" are
// not deployed as functions — and this file routes to them, so the URLs
// are unchanged: /api/admin/users still runs api/_admin/users.js.
//
// To add a new admin endpoint: put the handler in api/_admin/ and add it
// to the `routes` map below. Do NOT create new files directly in api/admin/.

import analytics from "../_admin/analytics.js";
import logs from "../_admin/logs.js";
import overview from "../_admin/overview.js";
import roles from "../_admin/roles.js";
import status from "../_admin/status.js";
import users from "../_admin/users.js";
import whoami from "../_admin/whoami.js";

const routes = { analytics, logs, overview, roles, status, users, whoami };

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  const route = Object.prototype.hasOwnProperty.call(routes, action) ? routes[action] : null;
  if (!route) return res.status(404).json({ error: "not_found" });
  return route(req, res);
}
