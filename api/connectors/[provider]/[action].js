// One serverless function for every /api/connectors/<provider>/<action>
// endpoint (OAuth start/callback/disconnect, GitHub and Google Drive file
// browsing).
//
// Vercel's free (Hobby) plan rejects any deployment with more than 12
// serverless functions, and every .js file under /api counts as one. The
// real handlers live in api/_connectors/ — folders starting with "_" are
// not deployed as functions — and this file routes to them, so the URLs
// are unchanged (including the OAuth callback URLs registered with GitHub
// and Google).
//
// To add a new connector endpoint: put the handler in api/_connectors/ and
// add it below. Do NOT create new files directly under api/connectors/.

import start from "../../_connectors/oauth/start.js";
import callback from "../../_connectors/oauth/callback.js";
import disconnect from "../../_connectors/oauth/disconnect.js";
import githubRepos from "../../_connectors/github/repos.js";
import githubTree from "../../_connectors/github/tree.js";
import githubFile from "../../_connectors/github/file.js";
import googleFiles from "../../_connectors/google/files.js";
import googleFile from "../../_connectors/google/file.js";

// Provider-specific endpoints take priority, same as the old static
// folders (api/connectors/github/*, api/connectors/google/*) did.
const providerRoutes = {
  github: { repos: githubRepos, tree: githubTree, file: githubFile },
  google: { files: googleFiles, file: googleFile },
};

// Works for any provider; the handler reads req.query.provider itself.
const oauthRoutes = { start, callback, disconnect };

function pick(map, key) {
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

export default async function handler(req, res) {
  const provider = String(req.query?.provider || "").toLowerCase();
  const action = String(req.query?.action || "");
  const route = pick(pick(providerRoutes, provider), action) || pick(oauthRoutes, action);
  if (!route) return res.status(404).json({ error: "not_found" });
  return route(req, res);
}
