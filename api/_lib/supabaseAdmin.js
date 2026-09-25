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

/**
 * Looks up a signed-in user's plan + remaining chat credits by email.
 * Returns null if the table/row doesn't exist yet (treat as "free plan,
 * use the anonymous IP-based limit" rather than crashing).
 */
export async function getSubscription(email) {
  try {
    const supabase = await getClient();
    if (!supabase || !email) return null;
    const { data } = await supabase
      .from("subscriptions")
      .select("plan, credits_total, credits_remaining")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    return data || null;
  } catch (_err) {
    return null;
  }
}

/**
 * Atomically takes 1 credit from a user's balance via the
 * spend_one_credit() Postgres function (see supabase-schema-credits.sql)
 * — a single atomic UPDATE, so two chat requests arriving at the same
 * moment can't both read the same balance and both decrement from it.
 * Returns the new remaining count on success, or null if they had none
 * left (or no subscriptions row exists yet — caller should fall back to
 * the free-plan limit in that case, never silently allow unlimited use).
 */
export async function spendCredit(email) {
  try {
    const supabase = await getClient();
    if (!supabase || !email) return null;
    const { data, error } = await supabase.rpc("spend_one_credit", { user_email: email.toLowerCase() });
    if (error || data == null) return null;
    return data;
  } catch (_err) {
    return null;
  }
}

/**
 * Reads a signed-in user's persistent memory profile — a short block of
 * stable facts elora has learned about them across past conversations
 * (name, role, ongoing projects, preferences). Returns "" if there's
 * none yet or the table/DB isn't reachable — never throws.
 */
export async function getUserMemory(email) {
  try {
    const supabase = await getClient();
    if (!supabase || !email) return "";
    const { data } = await supabase
      .from("user_memory")
      .select("summary")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    return data?.summary || "";
  } catch (_err) {
    return "";
  }
}

/** Overwrites a user's memory profile. Never throws. */
export async function saveUserMemory(email, summary) {
  try {
    const supabase = await getClient();
    if (!supabase || !email) return;
    await supabase.from("user_memory").upsert({
      email: email.toLowerCase(),
      summary: String(summary || "").slice(0, 1000),
      updated_at: new Date().toISOString(),
    });
  } catch (_err) {
    // best-effort — losing a memory update shouldn't fail the chat reply
  }
}

/** Wipes a user's memory profile entirely — used by "forget me". */
export async function deleteUserMemory(email) {
  try {
    const supabase = await getClient();
    if (!supabase || !email) return;
    await supabase.from("user_memory").delete().eq("email", email.toLowerCase());
  } catch (_err) {
    // best-effort
  }
}

export { getClient as getSupabaseClient };
