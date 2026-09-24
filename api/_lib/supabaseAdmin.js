// Server-only Supabase helper. Uses the SERVICE ROLE key, which must
// NEVER be sent to the browser — it bypasses row-level security. Only
// import this file from files under /api (serverless functions), never
// from anything shipped to the client.

let cachedClient = null;

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  if (!cachedClient) {
    // Lazy import so this file doesn't crash at module load if the
    // package isn't installed yet in some environment.
    cachedClient = null;
  }
  return { url, serviceKey };
}

let SupabaseClientCtor = null;
async function getClient() {
  const creds = getSupabaseAdmin();
  if (!creds) return null;
  if (!SupabaseClientCtor) {
    const mod = await import("@supabase/supabase-js");
    SupabaseClientCtor = mod.createClient;
  }
  return SupabaseClientCtor(creds.url, creds.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Reads the caller's Supabase access token from the Authorization header,
 * confirms it's a real signed-in user, and looks up their role in the
 * `roles` table. Returns { email: null, role: null } for anyone who isn't
 * signed in or isn't in the roles table — callers should treat that as
 * "not authorized" and refuse, never assume a default role.
 */
export async function verifyRequester(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { email: null, role: null };

  const supabase = await getClient();
  if (!supabase) return { email: null, role: null };

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user?.email) return { email: null, role: null };

  const email = data.user.email.toLowerCase();
  const { data: roleRow } = await supabase
    .from("roles")
    .select("role")
    .eq("email", email)
    .maybeSingle();

  return { email, role: roleRow?.role || null };
}

/** Best-effort event/error logging — never throws, so a logging failure
 * can't take down the request that triggered it. */
export async function logEvent(level, source, message) {
  try {
    const supabase = await getClient();
    if (!supabase) return;
    await supabase.from("error_logs").insert({ level, source, message: String(message).slice(0, 2000) });
  } catch (_err) {
    // intentionally swallowed
  }
}

export { getClient as getSupabaseClient };
