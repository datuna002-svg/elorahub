// Web research for elora: decide when a question needs the web, search,
// read the best pages (not just their snippets), and hand the model numbered
// sources it cites as [1], [2]… — elorahub then adds the real links.
import { safeFetch, readablePage, searchWeb } from "./browse.js";

const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|pinterest\.[a-z.]+|linkedin\.com|quora\.com|threads\.net)$/i;
const STOP = new Set("a an the and or but of to in on for with at by from as is are was were be been being it its this that these those what which who whom whose when where why how do does did can could should would will shall may might must i me my we our you your he she they them their about into over under than then so if not no yes please tell give show find search look up google web online internet latest current today best top more most some any all just really very".split(" "));

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch (_e) { return ""; }
}

// Should this message be answered with fresh information from the web?
export function wantsResearch(text, { pref = "auto", heavyBuild = false } = {}) {
  const t = String(text || "").trim();
  if (!t || pref === "off" || pref === false) return false;
  if (t.length < 6 || /^(hi|hey|hello|thanks|thank you|ok|okay|cool|nice|yo|sup)\b[\s!.?]*$/i.test(t)) return false;
  const codey = /```|^\s*(import|const|let|function|def|class|#include|<\?php|<!doctype|<html)\b/im.test(t);
  const explicit = /\b(search|look ?(it |this |that )?up|google|browse|on the (web|internet)|find (me )?(a |the |some |any )?(links?|sources?|websites?|sites?|articles?|videos?|papers?|studies|reviews?|docs|documentation)|links?\b|sources?|citations?|cite|references?|official (site|website|page|docs)|where (can|do|should) i (buy|find|get|download|watch|read)|download (link|page))\b/i.test(t);
  if (explicit) return true;
  if (pref === "always") return !codey;
  if (codey || heavyBuild) return false;
  const timely = /\b(latest|current(ly)?|today|tonight|tomorrow|yesterday|right now|this (week|month|year|season)|last (week|month|year|night)|recent(ly)?|breaking|news|headlines?|update[sd]?|upcoming|release(d| date)?|launch(ed|es)?|new (version|model|update)|20(2[4-9]|3\d)|price[sd]?|costs?|how much (is|does|are|do)|deals?|for sale|in stock|reviews?|rating|best\b|top \d+|vs\.?|versus|compared? to|comparison|alternatives?|recommend(ation)?s?|stock|shares?|crypto|bitcoin|ethereum|exchange rate|weather|forecast|temperature in|schedule|fixtures?|standings|score|who won|results?|election|polls?|president|prime minister|ceo|founder|owner of|net worth|population|how old is|age of|when (is|was|does|did|will)|where is|opening hours|open now|near me|address of|phone number|visa|requirements|law|legal in|rules for)\b/i.test(t);
  if (timely) return true;
  // A factual question about named things (people, products, places, companies).
  const question = /\?\s*$/.test(t) || /^(who|what|when|where|which|is|are|does|did|how)\b/i.test(t);
  const named = /(^|[\s(“"'])([A-Z][\w.&-]{1,}|[A-Z]{2,}\d*)(\s+[A-Z][\w.&-]+)*/.test(t.slice(1));
  return question && named && t.length < 500;
}

// Turns a chatty request into a search query.
export function cleanQuery(text) {
  let q = String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  q = q.replace(/^(hey|hi|hello)[,!.\s]+/i, "")
    .replace(/^(can|could|would|will) you (please )?/i, "")
    .replace(/^(please )?(search|look up|google|find|tell me|show me|give me|i want to know|i need to know|do you know)( the web| online| for| about| me)*\s*/i, "")
    .replace(/\b(please|thanks|thank you)\b/gi, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  return (q || String(text || "")).slice(0, 220);
}

function keyTerms(q) {
  return [...new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 14);
}

// Keeps the paragraphs that actually talk about the question (in page order).
function excerpt(page, terms, maxChars) {
  const blocks = page.blocks || [];
  if (!blocks.length) return "";
  const scored = blocks.map((b, i) => {
    const low = b.x.toLowerCase();
    let s = 0;
    for (const t of terms) if (low.includes(t)) s += 1;
    if (b.t === "h2" || b.t === "h3") s += 0.4;
    if (/\d/.test(b.x)) s += 0.3;
    return { i, s, b };
  });
  const keep = new Set();
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.s - a.s || a.i - b.i)) {
    if (used > maxChars) break;
    if (x.s <= 0 && keep.size >= 4) continue;
    keep.add(x.i);
    used += x.b.x.length + 2;
  }
  if (keep.size < 3) for (let i = 0; i < Math.min(6, blocks.length); i++) keep.add(i);
  let out = "";
  for (const x of scored) {
    if (!keep.has(x.i)) continue;
    const line = x.b.t === "h2" || x.b.t === "h3" ? `## ${x.b.x}` : x.b.t === "li" ? `- ${x.b.x}` : x.b.x;
    if (out.length + line.length > maxChars) break;
    out += line + "\n";
  }
  return out.trim();
}

async function fetchJson(url, ms = 6000) {
  const r = await safeFetch(url, { timeoutMs: ms, accept: "application/json" });
  if (!r.ok || !r.body) return null;
  try { return JSON.parse(r.body); } catch (_e) { return null; }
}

// Reads one link the best way for its site. Never throws.
export async function readUrl(url, { maxChars = 6000, terms = [] } = {}) {
  const site = hostOf(url);
  try {
    // GitHub repository: description, stats and the README.
    let m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url);
    if (m) {
      const [, owner, repo] = m;
      const [info, readme] = await Promise.all([
        fetchJson(`https://api.github.com/repos/${owner}/${repo}`),
        safeFetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`, { timeoutMs: 6000, accept: "text/plain" }),
      ]);
      const head = info ? `${info.full_name}: ${info.description || ""}\nLanguage: ${info.language || "?"} · ★ ${info.stargazers_count} · forks ${info.forks_count} · open issues ${info.open_issues_count} · license ${info.license?.spdx_id || "none"} · last push ${String(info.pushed_at || "").slice(0, 10)}${info.topics?.length ? ` · topics: ${info.topics.join(", ")}` : ""}${info.homepage ? ` · homepage ${info.homepage}` : ""}` : `${owner}/${repo}`;
      const body = readme.ok ? readme.body : "";
      return { ok: Boolean(info || body), url, site, title: info ? info.full_name : `${owner}/${repo}`, text: `${head}\n\nREADME:\n${body}`.slice(0, maxChars) };
    }
    // A file on GitHub → its raw text.
    m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/(.+)$/i.exec(url);
    if (m) {
      const raw = await safeFetch(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, { timeoutMs: 6000, accept: "text/plain" });
      if (raw.ok && raw.body) return { ok: true, url, site, title: m[3].split("/").pop(), text: raw.body.slice(0, maxChars) };
    }
    // YouTube: title and channel (transcripts aren't available without an API key).
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(site)) {
      const info = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      const page = await safeFetch(url, { timeoutMs: 6000 });
      const desc = page.ok && page.body ? readablePage(page.body, url).description : "";
      if (info || desc) return { ok: true, url, site, title: info?.title || "YouTube video", text: `YouTube video: "${info?.title || ""}" by ${info?.author_name || "unknown channel"}.\nDescription: ${desc || "(not available)"}\n(The video's spoken content isn't available — only its title and description.)` };
    }
    // Reddit threads have a JSON view.
    if (/(^|\.)reddit\.com$/i.test(site) && /\/comments\//.test(url)) {
      const data = await fetchJson(url.replace(/[?#].*$/, "").replace(/\/?$/, ".json"));
      if (Array.isArray(data)) {
        const post = data[0]?.data?.children?.[0]?.data || {};
        const comments = (data[1]?.data?.children || []).map((c) => c.data).filter((c) => c && c.body).slice(0, 12).map((c) => `- (${c.score}) ${c.body.replace(/\s+/g, " ").slice(0, 400)}`);
        return { ok: true, url, site, title: post.title || "Reddit thread", text: `${post.title || ""}\n${post.selftext || ""}\n\nTop comments:\n${comments.join("\n")}`.slice(0, maxChars) };
      }
    }
    const res = await safeFetch(url, { timeoutMs: 7000 });
    if (!res.ok || !res.textual || !res.body) return { ok: false, url, site, title: site, text: "", reason: res.reason || (res.status ? `HTTP ${res.status}` : "not readable") };
    if (/html|xhtml/i.test(res.contentType)) {
      const page = readablePage(res.body, res.url);
      const text = [page.description, excerpt(page, terms, maxChars)].filter(Boolean).join("\n");
      return { ok: text.length > 40, url: res.url || url, site, title: page.title || site, text: text.slice(0, maxChars) };
    }
    return { ok: true, url, site, title: url.split("/").pop() || site, text: res.body.trim().slice(0, maxChars) };
  } catch (_e) {
    return { ok: false, url, site, title: site, text: "", reason: "not readable" };
  }
}

// Real Google results through Gemini's "Grounding with Google Search" tool
// (uses the existing GEMINI_API_KEY). Returns a cited summary plus the pages
// Google used. Scraped search engines block datacenter servers, so this is
// the main search; scraping is only the fallback.
async function geminiSearch(query) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const models = [...new Set([process.env.GEMINI_SEARCH_MODEL, process.env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash"].filter(Boolean))];
  const today = new Date().toISOString().slice(0, 10);
  for (const model of models) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 22000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Today is ${today}. Search the web and report what current, reliable sources say about the question below. Give the key facts with exact numbers, names, versions, prices and dates, say which are the newest, and note where sources disagree. Under 220 words, no preamble.\n\nQuestion: ${query}` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1400 },
        }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const cand = data?.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const text = parts.map((x) => x.text || "").join("").trim();
      const meta = cand?.groundingMetadata || {};
      const chunks = (meta.groundingChunks || []).map((c) => c.web).filter((w) => w && w.uri);
      if (!text || !chunks.length) continue;
      return { text, chunks, supports: meta.groundingSupports || [], queries: meta.webSearchQueries || [], model };
    } catch (_e) {
      // try the next model
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
// Google's grounding links are redirects; find where each one really goes.
async function resolveRedirect(uri) {
  if (!/vertexaisearch\.cloud\.google\.com|grounding-api-redirect/.test(uri)) return uri;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(uri, { redirect: "manual", signal: ctrl.signal });
    const loc = r.headers.get("location");
    return loc && /^https?:\/\//i.test(loc) ? loc : uri;
  } catch (_e) { return uri; } finally { clearTimeout(timer); }
}
// Drops results that don't mention the question's words (blocked search
// engines sometimes answer with generic pages).
function relevant(results, query) {
  const terms = keyTerms(query);
  if (terms.length < 2) return results;
  return results.filter((r) => {
    const hay = `${r.text} ${r.snippet} ${r.href}`.toLowerCase();
    return terms.filter((t) => hay.includes(t)).length >= Math.min(2, Math.ceil(terms.length / 3));
  });
}

// Search, then read the best few pages. Returns numbered-ready sources.
export async function research(question, { depth = "normal", exclude = [], onProgress } = {}) {
  const query = cleanQuery(question);
  const say = typeof onProgress === "function" ? onProgress : () => {};
  say(`Searching the web for “${query.slice(0, 80)}”`);
  const want = depth === "deep" ? 5 : 3;
  const skip = new Set(exclude.map(String));
  const g = await geminiSearch(query);
  if (g) {
    // Unique pages, in Google's order.
    const resolved = await Promise.all(g.chunks.slice(0, 10).map(async (c) => ({ title: c.title || "", url: await resolveRedirect(c.uri) })));
    const seen = new Map();
    const pages = [];
    resolved.forEach((c, i) => {
      const key = c.url.replace(/[#?].*$/, "");
      if (!seen.has(key) && !skip.has(c.url)) { seen.set(key, pages.length); pages.push({ ...c, from: [i] }); }
      else if (seen.has(key)) pages[seen.get(key)].from.push(i);
    });
    const indexOf = new Map();
    pages.forEach((pg, k) => pg.from.forEach((i) => indexOf.set(i, k + 1)));
    // Put Google's citations into the summary as [n].
    let summary = g.text;
    const marks = (g.supports || []).map((sp) => ({ end: sp?.segment?.endIndex, nums: [...new Set((sp.groundingChunkIndices || []).map((i) => indexOf.get(i)).filter(Boolean))] })).filter((m) => Number.isFinite(m.end) && m.nums.length).sort((a, b) => b.end - a.end);
    const bytes = Buffer.from(summary, "utf8");
    let out = bytes;
    for (const m of marks) {
      if (m.end > out.length) continue;
      out = Buffer.concat([out.subarray(0, m.end), Buffer.from(m.nums.map((n) => `[${n}]`).join(""), "utf8"), out.subarray(m.end)]);
    }
    summary = out.toString("utf8");
    const top = pages.slice(0, want);
    if (top.length) say(`Reading ${top.map((x) => hostOf(x.url)).join(", ")}`);
    const terms = keyTerms(query);
    const read = await Promise.all(top.map((x) => readUrl(x.url, { maxChars: depth === "deep" ? 3200 : 2000, terms })));
    const sources = pages.slice(0, want + 3).map((pg, k) => {
      const rd = read[k];
      return { title: (rd && rd.ok && rd.title) || pg.title || hostOf(pg.url), url: (rd && rd.ok && rd.url) || pg.url, site: hostOf((rd && rd.ok && rd.url) || pg.url) || pg.title, excerpt: rd && rd.ok ? rd.text : "", read: Boolean(rd && rd.ok) };
    });
    return { query, sources, read: read.filter((x) => x && x.ok).length, summary, engine: "google" };
  }
  let results = [];
  try { results = relevant(await searchWeb(query), query); } catch (_e) { results = []; }
  if (!results.length) return { query, sources: [], read: 0 };
  const chosen = [];
  const extra = [];
  const hosts = new Set();
  for (const r of results) {
    const host = hostOf(r.href);
    if (!host || skip.has(r.href)) continue;
    if (chosen.length < want && !SKIP_HOSTS.test(host) && !hosts.has(host) && !/\.pdf($|\?)/i.test(r.href)) { chosen.push(r); hosts.add(host); }
    else if (extra.length < 3 && !hosts.has(host)) { extra.push(r); hosts.add(host); }
  }
  if (chosen.length) say(`Reading ${chosen.map((r) => hostOf(r.href)).join(", ")}`);
  const terms = keyTerms(query);
  const pages = await Promise.all(chosen.map((r) => readUrl(r.href, { maxChars: depth === "deep" ? 3800 : 2600, terms })));
  const sources = [];
  chosen.forEach((r, i) => {
    const p = pages[i];
    sources.push({ title: (p && p.ok && p.title) || r.text || hostOf(r.href), url: (p && p.ok && p.url) || r.href, site: hostOf(r.href), excerpt: p && p.ok ? p.text : r.snippet || "", read: Boolean(p && p.ok) });
  });
  extra.forEach((r) => sources.push({ title: r.text || hostOf(r.href), url: r.href, site: hostOf(r.href), excerpt: r.snippet || "", read: false }));
  return { query, sources: sources.filter((s) => s.excerpt || s.title).slice(0, want + 3), read: pages.filter((p) => p && p.ok).length };
}

export function sourcesContext(sources, offset = 0, summary = "") {
  if (!sources.length) return "";
  const today = new Date().toISOString().slice(0, 10);
  const shifted = summary && offset ? summary.replace(/\[(\d{1,2})\]/g, (m, n) => `[${Number(n) + offset}]`) : summary;
  return `[Web research, ${today}.${shifted ? `\nGoogle search summary (its [n] marks point to the numbered sources below):\n${shifted}\n` : ""} Numbered sources below — use them for anything factual or recent. Put the source number in square brackets right after each sentence that uses it, like [1] or [2][3]. Prefer the most recent and most authoritative source when they disagree, and say when they disagree. Don't write your own list of sources or links at the end — elorahub adds the real links automatically. If the sources don't answer the question, say what's missing and answer from your own knowledge, clearly marked.]\n\n${sources.map((s, i) => `[${offset + i + 1}] ${s.title} — ${s.url}${s.read ? "" : " (search snippet only)"}\n${String(s.excerpt || "").slice(0, 4000)}`).join("\n\n")}`;
}

// Removes a sources list the model wrote itself and adds the real one,
// with only the sources the answer cites (or all of them if it cites none).
export function appendSources(reply, sources, offset = 0) {
  let text = String(reply || "").replace(/\n+(?:#{1,4}\s*|\*\*)?(?:Sources|References|Links)(?::)?(?:\*\*)?:?\s*\n(?:\s*(?:[-*•]|\d+[.)]|\[\d+\])\s.*(?:\n|$))+\s*$/i, "").trimEnd();
  if (!sources.length) return text;
  const cited = new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const list = sources.map((s, i) => ({ n: offset + i + 1, ...s })).filter((s) => (cited.size ? cited.has(s.n) : s.read)).slice(0, 10);
  if (!list.length) return text;
  const safe = (s) => String(s || "").replace(/[\[\]\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110);
  return `${text}\n\n**Sources**\n${list.map((s) => `- [${s.n}] [${safe(s.title)}](${s.url}) · ${s.site}`).join("\n")}`;
}

// Links pasted in the message: read up to four of them properly.
export async function readLinks(text, { onProgress } = {}) {
  const urls = [...new Set((String(text || "").match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, "")))].slice(0, 4);
  if (!urls.length) return { context: "", pages: [] };
  const say = typeof onProgress === "function" ? onProgress : () => {};
  say(`Reading ${urls.map(hostOf).join(", ")}`);
  const each = urls.length === 1 ? 14000 : urls.length === 2 ? 8000 : 5500;
  const pages = await Promise.all(urls.map((u) => readUrl(u, { maxChars: each, terms: keyTerms(text) })));
  const ok = pages.filter((p) => p.ok);
  const failed = pages.filter((p) => !p.ok);
  const parts = ok.map((p) => `--- ${p.title} (${p.url}) ---\n${p.text}`);
  if (failed.length) parts.push(`(Couldn't read: ${failed.map((p) => `${p.url} — ${p.reason || "blocked or empty"}`).join("; ")}. Say so if it matters, and don't pretend you saw them.)`);
  return {
    context: parts.length ? `[The user shared ${urls.length === 1 ? "a link" : "links"}. Here is what the pages actually contain — analyse them carefully, quote specifics, and point out anything notable:]\n\n${parts.join("\n\n")}` : "",
    pages: ok.map((p) => ({ title: p.title, url: p.url, site: p.site })),
  };
}
