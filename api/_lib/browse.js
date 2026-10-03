// Safe page fetching for elora's browser panel and for reading links.
//
// Every request is checked before it leaves the server: only http(s) on the
// normal ports, never localhost / private / link-local / reserved
// addresses (checked again after each redirect), a short timeout, and a
// size cap. Pages come back as clean, readable text blocks plus their links
// — never as raw HTML — so the browser panel can't be used to run another
// site's scripts inside elorahub.
import { lookup } from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 1_500_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 elorahub-browser/1.0";

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + (Number(part) & 255), 0) >>> 0;
}
function inRange(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return BLOCKED_V4.some((c) => inRange(ip, c));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff")) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export async function checkUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch (_e) { return { ok: false, reason: "That doesn't look like a web address." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Only http and https pages can be opened." };
  if (url.username || url.password) return { ok: false, reason: "Addresses with a login in them can't be opened." };
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) return { ok: false, reason: "That port can't be opened." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") return { ok: false, reason: "Private addresses can't be opened." };
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, reason: "Private addresses can't be opened." };
    return { ok: true, url };
  }
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return { ok: false, reason: "Private addresses can't be opened." };
  } catch (_e) {
    return { ok: false, reason: "That site couldn't be found." };
  }
  return { ok: true, url };
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= MAX_BYTES) { try { await reader.cancel(); } catch (_e) {} break; }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// Fetches a page, following up to 4 redirects and re-checking each hop.
export async function safeFetch(raw, { timeoutMs = 9000, accept } = {}) {
  let target = raw;
  for (let hop = 0; hop < 5; hop++) {
    const check = await checkUrl(target);
    if (!check.ok) return { ok: false, status: 0, reason: check.reason };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(check.url.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: accept || "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.9" },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, reason: err.name === "AbortError" ? "The site took too long to answer." : "The site couldn't be reached." };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, status: res.status, reason: "The site sent a broken redirect." };
      target = new URL(loc, check.url).href;
      continue;
    }
    try {
      const contentType = res.headers.get("content-type") || "";
      const textual = /text\/html|application\/xhtml|text\/plain|application\/json|text\/markdown|text\/csv/i.test(contentType);
      const body = textual ? await readCapped(res) : "";
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, url: check.url.href, contentType, headers: res.headers, body, textual };
    } catch (_e) {
      clearTimeout(timer);
      return { ok: false, status: res.status, reason: "The page couldn't be read." };
    }
  }
  return { ok: false, status: 0, reason: "Too many redirects." };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", euro: "€", pound: "£" };
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_e) { return " "; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (_e) { return " "; } })
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(ENTITIES, n.toLowerCase()) ? ENTITIES[n.toLowerCase()] : m));
}
function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t\f\v\r]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = re.exec(html);
  if (!tag) return "";
  const c = /content=["']([^"']*)["']/i.exec(tag[0]);
  return c ? decodeEntities(c[1]).trim() : "";
}

// Turns HTML into readable blocks (headings, paragraphs, list items, code)
// and a list of links, preferring the page's <main> or <article>.
export function readablePage(html, baseUrl) {
  const src = String(html || "");
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src) || [])[1] || "") || meta(src, "og:title");
  const description = meta(src, "description") || meta(src, "og:description");
  let image = meta(src, "og:image");
  try { if (image) image = new URL(image, baseUrl).href; } catch (_e) { image = ""; }
  if (image && !/^https:/i.test(image)) image = "";
  const cleaned = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, " ");
  const main = (/<main\b[\s\S]*?<\/main>/i.exec(cleaned) || /<article\b[\s\S]*?<\/article>/i.exec(cleaned) || [])[0];
  const body = main || cleaned.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const blocks = [];
  let total = 0;
  const re = /<(h[1-6]|p|li|pre|blockquote|dt|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) && blocks.length < 260 && total < 45000) {
    const tag = m[1].toLowerCase();
    const text = tag === "pre" ? decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim() : stripTags(m[2]);
    if (!text || (tag !== "pre" && text.length < 2)) continue;
    const t = /^h[1-6]$/.test(tag) ? (Number(tag[1]) <= 2 ? "h2" : "h3") : tag === "li" ? "li" : tag === "pre" ? "pre" : tag === "blockquote" ? "quote" : "p";
    blocks.push({ t, x: text.slice(0, 4000) });
    total += text.length;
  }
  if (blocks.length < 3) {
    const flat = stripTags(body).split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 30).slice(0, 120);
    flat.forEach((x) => blocks.push({ t: "p", x: x.slice(0, 2000) }));
  }
  const links = [];
  const seen = new Set();
  const lr = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = lr.exec(cleaned)) && links.length < 160) {
    let href;
    try { href = new URL(decodeEntities(m[1]), baseUrl).href; } catch (_e) { continue; }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const text = stripTags(m[2]).replace(/\s+/g, " ").slice(0, 120);
    if (!text) continue;
    seen.add(href);
    links.push({ href, text });
  }
  return { title: title.slice(0, 200), description: description.slice(0, 400), image, blocks, links };
}

// Can this page be shown live in an iframe on elorahub?
export function frameable(headers, url) {
  if (!/^https:/i.test(url || "")) return false;
  const xfo = String(headers?.get?.("x-frame-options") || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
  const csp = String(headers?.get?.("content-security-policy") || "").toLowerCase();
  const fa = /frame-ancestors([^;]*)/.exec(csp);
  if (fa && !/\*|elorahub\.online/.test(fa[1])) return false;
  return true;
}

// Search results for the browser's address bar (DuckDuckGo, then Wikipedia).
export async function searchWeb(query) {
  const q = String(query || "").slice(0, 300);
  const res = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeoutMs: 7000 });
  const results = [];
  if (res.ok && res.body) {
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(res.body)) && results.length < 10) {
      let href = decodeEntities(m[1]);
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (_e) {} }
      if (href.startsWith("//")) href = "https:" + href;
      if (!/^https?:/i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
      results.push({ href, text: stripTags(m[2]).slice(0, 160), snippet: stripTags(m[3] || "").slice(0, 300) });
    }
  }
  if (!results.length) {
    const wiki = await safeFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=8`, { timeoutMs: 6000, accept: "application/json" });
    try {
      const hits = JSON.parse(wiki.body || "{}")?.query?.search || [];
      hits.forEach((h) => results.push({ href: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, "_"))}`, text: h.title, snippet: stripTags(h.snippet) }));
    } catch (_e) {}
  }
  return results;
}
