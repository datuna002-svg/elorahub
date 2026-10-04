// Image generation for elora — the pictures in chat replies and the images in
// websites elora builds. Served from GET /api/chat?img=PROMPT&w=&h=&seed= and
// cached by Vercel's CDN for a year, so each picture is made only once.
//
// Where the picture comes from, first that works:
//   1. Pollinations with POLLINATIONS_KEY (a secret sk_ key from
//      enter.pollinations.ai) — fast, many models.
//   2. Gemini image generation with the existing GEMINI_API_KEY
//      (GEMINI_IMAGE_MODEL, default gemini-2.5-flash-image).
//   3. Pollinations without a key (only works for pictures it has cached).
// If none works, a soft gradient stands in so a page never shows a broken
// image, and that answer is cached only briefly so it's retried later.

export const SITE_URL = String(process.env.SITE_URL || "https://elorahub.online").replace(/\/+$/, "");

const usage = new Map();
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const dim = (v, d) => Math.max(256, Math.min(1536, Math.round((Number(v) || d) / 8) * 8));

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function timed(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function fromPollinations(prompt, w, h, seed, key) {
  const params = new URLSearchParams({ width: String(w), height: String(h), seed: String(seed), nologo: "true" });
  if (key && process.env.POLLINATIONS_IMAGE_MODEL) params.set("model", process.env.POLLINATIONS_IMAGE_MODEL);
  if (!key) params.set("model", "flux");
  const base = key ? "https://gen.pollinations.ai/image/" : "https://image.pollinations.ai/prompt/";
  const r = await timed(base + encodeURIComponent(prompt) + "?" + params, { headers: key ? { Authorization: `Bearer ${key}` } : {} }, 55000);
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !/^image\//.test(type)) throw new Error(`pollinations${key ? "" : " (no key)"} ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), type, via: key ? "pollinations" : "pollinations-cache" };
}

const RATIOS = [["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["4:3", 4 / 3], ["3:4", 3 / 4], ["3:2", 1.5], ["2:3", 2 / 3], ["21:9", 21 / 9], ["5:4", 1.25], ["4:5", 0.8]];
async function fromGemini(prompt, w, h) {
  const key = process.env.GEMINI_API_KEY;
  const r = w / h;
  const aspect = RATIOS.reduce((a, b) => (Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a))[0];
  const models = [...new Set([process.env.GEMINI_IMAGE_MODEL, "gemini-2.5-flash-image"].filter(Boolean))];
  let last = "";
  for (const model of models) {
    const res = await timed(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Generate one high-quality image. No text, letters, watermarks or borders unless asked. ${prompt}` }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } },
      }),
    }, 60000);
    if (!res.ok) { last = `gemini ${model} ${res.status}: ${clean((await res.text().catch(() => "")).replace(/\s+/g, " "), 220)}`; continue; }
    const data = await res.json().catch(() => null);
    const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData && p.inlineData.data);
    if (part) return { buf: Buffer.from(part.inlineData.data, "base64"), type: part.inlineData.mimeType || "image/png", via: model };
    last = `gemini ${model}: no image (${clean(data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "empty", 60)})`;
  }
  throw new Error(last || "gemini: no model");
}

// A calm gradient that stands in when no image service answers.
function placeholder(prompt, w, h) {
  const n = hash(prompt);
  const hue = n % 360, hue2 = (hue + 40 + (n >> 9) % 80) % 360;
  const cx = 20 + (n >> 3) % 60, cy = 15 + (n >> 6) % 50;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 22%)"/><stop offset="1" stop-color="hsl(${hue2} 60% 12%)"/></linearGradient><radialGradient id="r" cx="${cx}%" cy="${cy}%" r="60%"><stop offset="0" stop-color="hsl(${hue2} 80% 60% / .55)"/><stop offset="1" stop-color="hsl(${hue2} 80% 60% / 0)"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#r)"/></svg>`;
  return { buf: Buffer.from(svg), type: "image/svg+xml", via: "placeholder" };
}

export async function handleImage(req, res) {
  const q = req.query || {};
  const prompt = clean(q.img, 900);
  const w = dim(q.w || q.width, 1024), h = dim(q.h || q.height, 1024);
  const seed = Math.abs(parseInt(q.seed, 10) || hash(prompt) % 100000) % 1000000000;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (!prompt) { res.setHeader("Cache-Control", "no-store"); return res.status(400).json({ error: "bad_request", message: "Describe the image in ?img=" }); }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  const slot = usage.get(ip) || { count: 0, reset: now + 3600000 };
  if (now > slot.reset) { slot.count = 0; slot.reset = now + 3600000; }
  slot.count++;
  usage.set(ip, slot);

  const errors = [];
  let img = null;
  if (slot.count <= 80) {
    const sources = [];
    if (process.env.POLLINATIONS_KEY) sources.push(() => fromPollinations(prompt, w, h, seed, process.env.POLLINATIONS_KEY));
    if (process.env.GEMINI_API_KEY) sources.push(() => fromGemini(prompt, w, h));
    sources.push(() => fromPollinations(prompt, w, h, seed, ""));
    for (const make of sources) {
      try { img = await make(); break; } catch (err) { errors.push(clean(err.name === "AbortError" ? "timed out" : err.message, 260)); }
    }
  } else {
    errors.push("hourly image limit reached");
  }
  if (!img) img = placeholder(prompt, w, h);
  res.setHeader("Content-Type", img.type);
  res.setHeader("X-Elora-Image", img.via);
  if (img.via === "placeholder") {
    res.setHeader("X-Elora-Image-Errors", errors.join(" | ").replace(/[^\x20-\x7e]/g, "").slice(0, 900));
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  }
  return res.status(200).end(img.buf);
}

// Old-style links the model may still write (image.pollinations.ai needs a
// paid key now) → our own image address, keeping size and seed.
export function rewriteImageLinks(text) {
  return String(text || "").replace(/https?:\/\/image\.pollinations\.ai\/prompt\/([^?"'\s)<>]+)(\?[^"'\s)<>]*)?/g, (all, p, qs) => {
    const params = new URLSearchParams((qs || "").replace(/^\?/, "").replace(/&amp;/g, "&"));
    const w = params.get("width") || params.get("w") || "1024";
    const h = params.get("height") || params.get("h") || "1024";
    const seed = params.get("seed") || "";
    let prompt;
    try { prompt = decodeURIComponent(p); } catch (_e) { prompt = p; }
    return `${SITE_URL}/api/chat?img=${encodeURIComponent(prompt).replace(/'/g, "%27")}&w=${encodeURIComponent(w)}&h=${encodeURIComponent(h)}${seed ? `&seed=${encodeURIComponent(seed)}` : ""}`;
  });
}
