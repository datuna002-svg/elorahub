import { createCipheriv, createDecipheriv, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { getSupabaseClient } from "./supabaseAdmin.js";

const SITE_ORIGIN = (process.env.SITE_ORIGIN || process.env.APP_URL || "https://elorahub.online").replace(/\/$/, "");

export function connectorRedirectUri(provider) {
  return `${SITE_ORIGIN}/api/connectors/${provider}/callback`;
}
function oauthStateSecret() {
  const value = process.env.CONNECTOR_OAUTH_STATE_SECRET || "";
  return Buffer.byteLength(value, "utf8") >= 32 ? value : null;
}
export function connectorConfig() {
  const secure = Boolean(oauthStateSecret() && encryptionKey());
  return {
    google: { configured: secure && Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI) },
    github: { configured: secure && Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET) },
  };
}
function encryptionKey() {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY || "";
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try { const decoded = Buffer.from(raw, "base64"); return decoded.length === 32 ? decoded : null; } catch { return null; }
}
export function canEncryptConnectorTokens() { return Boolean(encryptionKey()); }
export function encryptSecret(value) {
  const key = encryptionKey();
  if (!key) throw new Error("CONNECTOR_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decryptSecret(payload) {
  const key = encryptionKey();
  if (!key || typeof payload !== "string") return null;
  try {
    const [version, ivText, tagText, dataText] = payload.split(".");
    if (version !== "v1" || !ivText || !tagText || !dataText) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
  } catch { return null; }
}
export function createOAuthState(claims) {
  const secret = oauthStateSecret();
  if (!secret) throw new Error("CONNECTOR_OAUTH_STATE_SECRET must be at least 32 bytes");
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 10 * 60 * 1000, nonce: randomBytes(18).toString("base64url") })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyOAuthState(state, provider) {
  const secret = oauthStateSecret();
  if (!secret || typeof state !== "string") return null;
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.provider !== provider || !claims.userId || !claims.exp || claims.exp < Date.now() || !claims.nonce) return null;
    return claims;
  } catch { return null; }
}
export async function getConnectorRow(userId, provider) {
  const supabase = await getSupabaseClient();
  if (!supabase) return { supabase: null, row: null, error: new Error("Supabase unavailable") };
  const { data, error } = await supabase.from("user_connectors").select("*").eq("user_id", userId).eq("provider", provider).maybeSingle();
  return { supabase, row: data || null, error };
}
export async function storeConnector(supabase, record) {
  const { accessToken, refreshToken, ...safe } = record;
  const payload = {
    user_id: safe.userId,
    provider: safe.provider,
    access_token_encrypted: encryptSecret(accessToken),
    refresh_token_encrypted: refreshToken ? encryptSecret(refreshToken) : null,
    expires_at: safe.expiresAt || null,
    scopes: Array.isArray(safe.scopes) ? safe.scopes : [],
    metadata: safe.metadata || {},
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("user_connectors").upsert(payload, { onConflict: "user_id,provider" });
  if (error) throw error;
}
function githubPrivateKey() { return (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n"); }
export function createGitHubAppJwt() {
  const appId = process.env.GITHUB_APP_ID;
  const key = githubPrivateKey();
  if (!appId || !key) throw new Error("GitHub App credentials are not configured");
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 30, exp: now + 8 * 60, iss: appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}
export async function createInstallationToken(installationId) {
  const jwt = createGitHubAppJwt();
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new Error(`GitHub installation token request failed (${response.status})`);
  return data;
}
export async function getFreshAccess(userId, provider) {
  const { supabase, row, error } = await getConnectorRow(userId, provider);
  if (error) throw new Error("Connector storage is not available");
  if (!row) return null;
  let accessToken = decryptSecret(row.access_token_encrypted);
  if (!accessToken) throw new Error("Stored connector token could not be decrypted; reconnect the service.");
  const expires = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (provider === "google" && expires && expires < Date.now() + 60_000) {
    const refreshToken = decryptSecret(row.refresh_token_encrypted);
    if (!refreshToken) throw new Error("Google access expired; reconnect Google Drive.");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error("Google token refresh failed; reconnect Google Drive.");
    accessToken = data.access_token;
    await storeConnector(supabase, { userId, provider, accessToken, refreshToken, expiresAt: new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString(), scopes: row.scopes || [], metadata: row.metadata || {} });
  }
  if (provider === "github" && expires && expires < Date.now() + 60_000) {
    const installationId = row.metadata?.installationId;
    if (!installationId) throw new Error("GitHub installation information is missing; reconnect GitHub.");
    const data = await createInstallationToken(installationId);
    accessToken = data.token;
    await storeConnector(supabase, { userId, provider, accessToken, expiresAt: data.expires_at, scopes: row.scopes || [], metadata: row.metadata || {} });
  }
  return { accessToken, row };
}
export function isMissingConnectorSchema(error) {
  return ["42P01", "PGRST205", "PGRST204"].includes(error?.code) || /relation .* does not exist|could not find the table/i.test(error?.message || "");
}
export { SITE_ORIGIN };
