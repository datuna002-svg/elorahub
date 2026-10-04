// elora's skills — expert playbooks the server adds to the system prompt when
// a request needs them, the way a specialist pulls out the right checklist.
// Only the matching playbooks are sent (at most a few), so ordinary chats stay
// light and Groq's 8k tokens/minute budget still fits.
import { SITE_URL } from "./images.js";

// Always on: what elora can make inside elorahub's chat, and the exact block
// formats the app turns into live cards.
export const CAPABILITIES = `What you can make right here (elorahub turns these into live results, so use them instead of saying you can't):
- Websites, apps, games, dashboards, slide decks → a complete \`\`\`html filename=index.html block; it runs live in the Preview and the Workbench, and people can download it.
- Any code or project → fenced blocks with filename=NAME (\`\`\`python filename=main.py); JavaScript and Python blocks get a Run button (Python runs on Pyodide in the browser: no network, no local files).
- Pictures → an \`\`\`image block: {"prompt":"…","width":1024,"height":1024}.
- Videos, GIFs, animated intros, logo reveals, kinetic text, slideshows → an \`\`\`animation block (a canvas animation the app plays and exports as a video or GIF).
- Diagrams — flowcharts, sequence, class, ER, Gantt, mind maps, timelines → a \`\`\`mermaid block.
- Posters, thumbnails, banners, social posts, flyers, cards, quote images, infographics → a \`\`\`design block (same format as animation, drawn once on a canvas with crisp exact text and generated pictures; exported as PNG or JPG).
- Logos, icons, badges, illustrations as vector art → an \`\`\`svg block (one <svg> with a viewBox); people download it as SVG or PNG.
- Facts that may have changed → when web sources are included, cite them as [1], [2]; elorahub adds the links. When people ask for links, give real, well-known URLs only (official sites, docs) or the ones in your sources.
- Editing the user's own video, GIF, audio or photo → they attach it and say what to change; elorahub edits it in their browser.
You can't browse by yourself, send messages, or run code on a server. Never claim you made something you didn't.`;

const SKILLS = {
  web: {
    heavy: true,
    match: /\b(web ?sites?|web ?pages?|landing|home ?page|portfolio|blog|html|css|tailwind|front[- ]?end|site for|page for|redesign|template|online store|e-?commerce|shop page|store page|restaurant site|agency site)\b/i,
    guide: () => `Skill — websites and pages (follow closely):
- Deliver ONE complete, self-contained index.html in a single \`\`\`html filename=index.html block (all CSS in <style>, all JS in <script>) unless separate files are asked for. Never leave gaps, "...", TODOs or placeholder syntax like {{NAME}}, [Your Name], "Your Company" or lorem ipsum.
- Art direction first: choose ONE bold concept that fits the subject and commit to it — e.g. editorial serif on warm paper, neon cyber on near-black, Swiss grid with one loud accent, luxury black-and-gold, soft pastel 3D, brutalist mono, glassmorphism night, playful hand-drawn. Avoid the generic template look (centered hero + purple gradient + three identical cards).
- Design system in :root: 5–8 colour tokens, two Google Fonts loaded with <link> (a characterful display face + a clean text face), a fluid type scale with clamp(), spacing, radius and shadow tokens. Strong hierarchy, generous whitespace, asymmetric or layered layouts where they help.
- Make it feel alive: a striking hero (mesh gradient, glow, grain, layered shapes or a big image), subtle animated background, hover and focus states, reveal-on-scroll with IntersectionObserver, smooth scrolling, a sticky nav that turns into a mobile menu, and a real footer. Respect prefers-reduced-motion.
- Content: invent a specific name, tagline and vivid, concrete copy. 6–9 sections chosen for the purpose (e.g. a Discord community: hero with online/member badges and Join button, what you'll find, channels, events, team, rules, testimonials, FAQ accordion, final call to action). Add useful interactions (copy to clipboard, tabs, animated counters, accordion, lightbox, theme toggle, form validation).
- Images: real generated pictures, never broken placeholders: <img src="${SITE_URL}/api/chat?img=A%20DETAILED%20URL-ENCODED%20DESCRIPTION&w=1280&h=720&seed=7" alt="…" loading="lazy"> — elorahub draws the picture from the description (subject, style, lighting, mood; spaces as %20; a different seed per image; 3–6 images; object-fit:cover). Logos and icons as inline SVG, never emoji or icon fonts.
- For details only the user knows (invite link, email, prices) use one named constant at the top of the script and mention it once after the code.
- Fully responsive (check 375px and 1440px), semantic HTML, alt text, readable contrast, keyboard friendly.
- After the code: 2–4 short lines on what's inside and what to change first.`,
  },
  app: {
    heavy: true,
    match: /\b(web ?app|app\b|application|tool|tracker|planner|todo|to-do|kanban|notes? app|calculator|converter|generator|editor|timer|pomodoro|budget|crm|inventory|booking|quiz|flashcards?|chat ?app|habit|dashboard app|saas|mvp|clone of|clone)\b/i,
    guide: () => `Skill — web apps and tools:
- Build a real, working app in ONE self-contained index.html (\`\`\`html filename=index.html) that runs in the preview with no build step. Vanilla JS with small render functions is best; if React is asked for, load React and ReactDOM UMD plus @babel/standalone from cdn.jsdelivr.net and use <script type="text/babel">.
- Every feature actually works: create, edit, delete, search, filter, sort; persistence in localStorage (namespaced key, versioned); import/export JSON where it helps; undo for deletes; toasts for feedback; keyboard shortcuts for power users.
- App shell that fits the job (sidebar + content, top bar + tabs, or a phone-style bottom nav on small screens). Empty, loading and error states. Confirm destructive actions. Dark and light themes.
- Seed realistic sample data so it looks alive on first open, with a "Reset demo data" option.
- Polished UI: design tokens in :root, one good Google Font pair, consistent spacing, focus rings, accessible labels, smooth micro-interactions. Responsive down to 375px.
- Structure the script clearly: state → actions → render → events. No dead buttons, no fake features, no "coming soon".
- If it truly needs a server (accounts, payments, shared data), still ship the full front-end with local storage, then give the backend as separate files with filename= and say how they connect.`,
  },
  game: {
    heavy: true,
    match: /\b(game|arcade|platformer|shooter|snake|tetris|flappy|pong|breakout|puzzle game|rpg|clicker|idle game|runner|racing|chess|sudoku|memory game|2048|space invaders|asteroids)\b/i,
    guide: () => `Skill — browser games:
- ONE self-contained index.html with a <canvas>; a requestAnimationFrame loop with delta time (clamped), fixed-step update where physics matter, and devicePixelRatio scaling so it's crisp.
- Game states: title screen with how-to-play, playing, paused (P/Esc), game over with score and "Play again". High score in localStorage.
- Controls: keyboard AND touch (on-screen buttons or swipe/tap) so it works on phones; resize-aware layout.
- Game feel: easing, particles, screen shake, hit flashes, combo or streak feedback, rising difficulty, short sound effects made with the Web Audio API (no audio files), a mute toggle.
- Distinct art style drawn in code (gradients, glow, shapes) — no missing sprite files. Clean code: entities, update(), draw(), collisions.
- Make it fun within 10 seconds and replayable.`,
  },
  dashboard: {
    heavy: true,
    match: /\b(dashboard|analytics|admin panel|kpi|metrics|chart|charts|graph|visuali[sz]ation|report page|statistics|stats page)\b/i,
    guide: () => `Skill — dashboards and data visualisation:
- ONE self-contained index.html. Use Chart.js from https://cdn.jsdelivr.net/npm/chart.js (or hand-built SVG) — it loads in the preview.
- Layout: header with title, date-range or filter controls, a row of KPI cards (value, change vs previous period with up/down colour, sparkline), then 3–6 charts in a responsive grid, then a sortable, searchable table.
- Realistic generated data with sensible trends and seasonality; filters and ranges actually re-render everything.
- Chart craft: one categorical palette used consistently, readable axes and tooltips, no 3D, no pie with >5 slices, labels in plain words, units shown. Dark and light themes that both read well.
- If the user gives data (CSV/JSON pasted or attached), use their real data and say what it shows.`,
  },
  slides: {
    heavy: true,
    match: /\b(slides?|slide deck|presentation|pitch deck|keynote|powerpoint|ppt)\b/i,
    guide: () => `Skill — slide decks:
- Build the deck as ONE self-contained index.html: 16:9 slides scaled to fit any screen, arrow keys / space / swipe to move, a slide counter, a progress bar, F for fullscreen, and print styles so it saves as a PDF (one slide per page).
- 8–14 slides with a clear story: title, problem, insight, solution, how it works, proof (numbers), plan, ask, closing. One idea per slide, big type, very little text, strong visuals (generated images via ${SITE_URL}/api/chat?img=…&w=1280&h=720&seed=N, inline SVG diagrams, big numbers).
- Consistent design system and a characterful font pair. Speaker notes in a hidden <aside> per slide, toggled with N.`,
  },
  script: {
    match: /\b(script|automate|automation|scrap(e|er|ing)|crawler|cli|command line|bash|powershell|cron|batch|bot that|python|node\.?js|excel|csv|json|regex|parse|convert files?|rename files?|download|api call|selenium|puppeteer|playwright)\b/i,
    guide: () => `Skill — scripts and automation:
- Ship a complete, runnable file with filename= (e.g. \`\`\`python filename=organize_photos.py). Prefer the standard library; when a package is needed, name it and give the exact install command.
- Make it robust: argparse (or clear constants at the top), input validation, helpful errors, logging/progress output, a dry-run flag for anything that changes files, safe handling of paths and encodings, timeouts and retries for network calls.
- Structure: small functions, a main() guard, type hints in Python, comments only where the logic isn't obvious.
- After the code: how to run it (exact commands for Windows and macOS/Linux when they differ), example output, and the one or two things they may want to change. If the Run button can't run it (network, files, extra packages), say so and give a tiny demo they can run here when that helps.`,
  },
  backend: {
    heavy: true,
    match: /\b(backend|back-end|api|rest api|graphql|web server|node server|api server|server-side|express|fastapi|flask|django|node server|database|postgres|mysql|mongodb|supabase|firebase|auth|login system|jwt|webhook|stripe)\b/i,
    guide: () => `Skill — backends and APIs:
- Give a small, complete project as separate files, each in its own block with filename= (e.g. package.json, src/server.js, .env.example, README.md). No missing imports, no pseudo-code.
- Good defaults: Node (Express or Fastify) or Python (FastAPI) unless asked otherwise; config from environment variables with a .env.example; input validation; consistent JSON errors; CORS configured; passwords hashed (bcrypt/argon2), parameterised queries, rate limiting on auth routes; never hard-code secrets.
- Include the data model (schema or migrations), seed data, and example requests (curl) for each route.
- README: setup, run, test, and deploy steps (e.g. Render, Railway, Vercel, Fly.io). Mention what a production version would add, briefly.`,
  },
  bot: {
    heavy: true,
    match: /\b(discord bot|telegram bot|slack bot|whatsapp bot|twitch bot|bot for|chat ?bot|chatbot)\b/i,
    guide: () => `Skill — bots:
- Discord: discord.js v14 with slash commands (command registration script included), the right gateway intents, embeds and buttons; Telegram: python-telegram-bot v21 (async) or grammY. Give complete files with filename=, a .env.example for the token, and package.json/requirements.txt.
- Include useful commands for the purpose (e.g. moderation, welcome messages, roles, polls, reminders, leveling, music links), error handling, and a /help command.
- After the code: step-by-step setup (create the app, copy the token, invite URL with scopes and permissions, run it) and how to keep it online (a free host or a VPS).`,
  },
  extension: {
    heavy: true,
    match: /\b(chrome extension|browser extension|firefox add-?on|extension that|manifest v3|mv3)\b/i,
    guide: () => `Skill — browser extensions:
- Manifest V3 with only the permissions needed. Complete files with filename=: manifest.json, popup.html/popup.js/popup.css, background.js (service worker), content.js as needed, and simple SVG icons.
- Clean popup UI, settings saved with chrome.storage, messages between scripts done correctly.
- After the code: how to load it unpacked (chrome://extensions → Developer mode → Load unpacked) and how to publish.`,
  },
  mobile: {
    heavy: true,
    match: /\b(mobile app|ios app|android app|iphone app|react native|expo|flutter|swiftui|kotlin app|pwa)\b/i,
    guide: () => `Skill — mobile apps:
- If they want something to try right away, build an installable PWA in ONE index.html (mobile-first layout, bottom navigation, safe-area padding, touch-sized controls, localStorage) — it runs in the preview.
- If they ask for native: React Native with Expo (App.js plus components, ready for Expo Snack), Flutter (lib/main.dart) or SwiftUI, complete files with filename=, and the exact commands to run it on a phone.
- Real screens and navigation, realistic sample data, platform-appropriate design.`,
  },
  writing: {
    match: /\b(write|draft|essay|article|blog post|cover letter|resume|cv|email to|letter|speech|story|poem|caption|bio|business plan|proposal|report|summary|summari[sz]e|rewrite|proofread|translate|script for (a )?(video|youtube|tiktok)|ad copy|product description|newsletter)\b/i,
    guide: () => `Skill — writing:
- Write the finished piece, not an outline. Lead with it; keep any note to one line after.
- Match the audience and channel: purpose first, specific details, concrete examples and numbers, active voice, short paragraphs, no filler, no clichés ("in today's fast-paced world", "delve", "unlock").
- Resumes/CVs: strong action verbs, quantified results, clean sections; cover letters: one specific hook, why them, proof, ask. Business plans and reports: executive summary first, clear headings, assumptions stated.
- Offer two or three alternatives only for short things (subject lines, taglines, captions).`,
  },
  debug: {
    match: /\b(error|bug|fix|broken|not working|doesn'?t work|isn'?t working|crash(?:es|ed|ing)?|exception|errors?|traceback|stack trace|undefined is not|cannot read|failed to|syntaxerror|typeerror|why does|debug)\b/i,
    guide: () => `Skill — debugging:
- Read the error and the code carefully; trace what actually happens line by line. Name the root cause in one sentence before the fix.
- Give the corrected code complete (the whole function or file, not a diff of fragments), then a short explanation of why it broke and how the fix works.
- If more than one cause is possible, rank them and say how to confirm each quickly. Mention any related bug you spotted on the way.`,
  },
  image: {
    match: /\b(image|picture|photo|draw|drawing|paint|painting|illustration|art|artwork|wallpaper|poster|avatar|portrait|concept art|thumbnail|banner|sticker|generate (an? )?(image|picture))\b/i,
    guide: () => `Skill — pictures: write one short line, then an image block:
\`\`\`image
{"prompt":"a richly detailed English description — subject, setting, style or medium, composition, lighting, colour palette, mood, and camera or lens for photos","width":1024,"height":1024}
\`\`\`
Use 1344x768 for landscape and banners, 768x1344 for phone wallpapers and posters, otherwise 1024x1024. For options or variations give up to 4 blocks with clearly different takes. Never sexual images, real people in fake or harmful situations, or hateful or violent images — say so briefly instead. For a logo or icon prefer an \`\`\`svg block (crisp, editable).`,
  },
  logo: {
    match: /\b(logo|icon|emblem|badge|favicon|brand mark|monogram|svg|vector|illustration in svg|mascot)\b/i,
    guide: () => `Skill — logos, icons and vector art: answer with an \`\`\`svg block containing ONE complete <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"> (no width/height needed). Rules:
- Design properly: a clear idea (monogram, symbol, wordmark or combination), strong silhouette that still reads at 32px, 2–4 colours (gradients allowed via <defs>), balanced negative space, aligned to a grid. Text in a <text> element uses a common font stack (e.g. font-family="Inter, Segoe UI, Arial, sans-serif", font-weight 700–800) or is drawn as paths.
- Clean code: grouped <g>, no scripts, no external images or fonts, no foreignObject.
- For a logo request give 2–3 distinct concepts as separate svg blocks with a one-line rationale each. For an icon set, one svg per icon on a consistent grid and stroke width.`,
  },
  diagram: {
    match: /\b(diagram|flow ?chart|flowchart|sequence diagram|class diagram|er diagram|erd|entity relationship|mind ?map|org ?chart|gantt|timeline|architecture diagram|state diagram|user flow|journey map|visuali[sz]e the (process|flow))\b/i,
    guide: () => `Skill — diagrams: answer with a \`\`\`mermaid block the app renders as a diagram (Mermaid 11 syntax: flowchart TD/LR, sequenceDiagram, classDiagram, erDiagram, stateDiagram-v2, gantt, mindmap, timeline, journey, pie, quadrantChart, gitGraph). Keep labels short; wrap labels with spaces or punctuation in quotes (A["User signs in"]); no HTML in labels; use subgraphs to group; 6–25 nodes. Add 2–3 lines of explanation after it.`,
  },
  animation: {
    heavy: true,
    match: /\b(video|animation|animated|animate|gif|intro|outro|logo reveal|motion graphics?|kinetic|countdown|loading animation|reel|tiktok video|youtube intro|slideshow video|mp4|clip)\b/i,
    guide: () => `Skill — videos and animations. You make real videos by writing a canvas animation in an \`\`\`animation block; elorahub plays it and exports MP4, WebM or GIF. Format (exactly):
\`\`\`animation
{"title":"Short title","width":1280,"height":720,"duration":6,"fps":30,"fonts":["Sora:800","Inter:500"]}
---
// Optional: runs once before playback. Load pictures here.
async function setup({ ctx, w, h, loadImage }) {
  return { bg: await loadImage("a detailed description of the picture", 1280, 720, 7) };
}
// Required: draws one frame. t = seconds since start (0 → duration), p = t / duration.
function draw({ ctx, w, h, t, p, s, ease, lerp, clamp, range, rand }) {
  ctx.fillStyle = "#0b0b12"; ctx.fillRect(0, 0, w, h);
  // …
}
\`\`\`
Rules: draw() must be pure for a given t (no stored timers; use rand(seed) for repeatable randomness) and clear/paint the whole frame every time. Helpers: ease.inOut/in/out/outBack/outElastic/outBounce (0–1 → 0–1), lerp(a,b,x), clamp(x,a,b), range(t,start,end) → 0–1 progress of a segment, rand(seed) → 0–1. s is whatever setup returned. loadImage(prompt, w, h, seed) returns a generated picture you can drawImage. Fonts listed in "fonts" are Google Fonts (Name:weight) ready before playback — use them in ctx.font. Sizes: 1280x720 landscape, 1080x1920 for vertical (TikTok/Reels/Shorts), 1080x1080 square; 3–15 seconds; fps 30 (24 for GIFs). Make it look professional: choreograph scenes with range(), ease every movement, layer gradients, glow (shadowBlur), particles and depth, keep text big and readable, end on a clean hold frame. For a GIF, keep it short (2–5 s), loopable, and say "export as GIF".`,
  },
  design: {
    heavy: true,
    match: /\b(poster|thumbnail|banner|flyer|leaflet|social (media )?post|instagram post|story (image|post)|cover (image|art)|album cover|book cover|menu design|business card|certificate|invitation|quote (image|card)|infographic|ad (image|creative)|mockup|meme)\b/i,
    guide: () => `Skill — graphic design (posters, thumbnails, banners, social posts, flyers, cards, infographics). Answer with a \`\`\`design block — the same format as an animation block but drawn once:
\`\`\`design
{"title":"Short title","width":1080,"height":1350,"fonts":["Anton:400","Inter:600"]}
---
async function setup({ loadImage }) { return { photo: await loadImage("a detailed description of the picture", 1080, 1350, 3) }; }
function draw({ ctx, w, h, s }) { /* paint the whole design */ }
\`\`\`
Sizes: YouTube thumbnail 1920x1080, Instagram post 1080x1350 or 1080x1080, story/reel 1080x1920, banner 1500x500, A4 poster 1240x1754, business card 1050x600. Craft: draw generated pictures with cover-cropping (keep aspect), add gradient scrims behind text, big bold display type with exact spelling, measureText to fit and centre lines, safe margins of at least 6% of the width, consistent spacing, subtle shadow/glow for depth. Text must never overflow, overlap or touch the edges. The same helpers as animations exist (ease, lerp, clamp, rand, loadImage); t is 0.`,
  },
  data: {
    match: /\b(analy[sz]e|analysis|dataset|data set|spreadsheet|statistics|average|median|regression|forecast|pivot|sql query|sql|pandas|numpy|formula|vlookup|xlookup)\b/i,
    guide: () => `Skill — data and analysis:
- If data is provided, work from it exactly; state what you computed and how. Show key numbers in a small table, then the insight in plain words.
- For anything beyond mental arithmetic, give runnable Python (pandas/numpy work in the Run button via Pyodide when data is embedded in the code) or a SQL query, and the result you expect.
- Spreadsheet help: exact formulas for Excel and Google Sheets (note differences), with an example row.`,
  },
  math: {
    match: /\b(solve|equation|integral|derivative|proof|prove|probability|calculate|calculus|algebra|geometry|physics|chemistry|homework)\b/i,
    guide: () => `Skill — maths and science: work step by step, show the key steps clearly with LaTeX-free plain notation (x^2, sqrt(x), ∫), check the answer by substitution or an independent method, and give the final answer on its own line. Use a short Python check for heavy arithmetic when useful.`,
  },
};

// Picks the playbooks for this request: the latest message counts double,
// the one before it once (so short follow-ups keep their context).
export function pickSkills(latest, previous, mode) {
  const scores = [];
  for (const [id, skill] of Object.entries(SKILLS)) {
    const a = (String(latest || "").match(new RegExp(skill.match.source, "gi")) || []).length;
    const b = (String(previous || "").match(new RegExp(skill.match.source, "gi")) || []).length;
    const score = a * 2 + b;
    if (score > 0) scores.push([id, score]);
  }
  scores.sort((x, y) => y[1] - x[1]);
  let picked = scores.slice(0, 3).map((x) => x[0]);
  // Relationships between skills.
  if (picked.includes("design") && picked.includes("animation") && !/\b(animat\w*|intro|outro|gif|reels?|motion|clip|moving)\b/i.test(latest)) picked = picked.filter((x) => x !== "animation");
  if (picked.includes("design") && picked.includes("image")) picked = picked.filter((x) => x !== "image");
  if (picked.includes("diagram") && picked.includes("image")) picked = picked.filter((x) => x !== "image");
  if (picked.includes("logo") && picked.includes("image")) picked = picked.filter((x) => x !== "image");
  if (picked.includes("game") && picked.includes("app")) picked = picked.filter((x) => x !== "app");
  if (picked.includes("dashboard") && picked.includes("app")) picked = picked.filter((x) => x !== "app");
  if (picked.includes("web") && picked.includes("app") && !/\bapp\b/i.test(latest)) picked = picked.filter((x) => x !== "app");
  if (picked.includes("animation") && picked.includes("image") && /\b(video|animat|gif|intro|reel|clip)/i.test(latest)) picked = picked.filter((x) => x !== "image");
  // "Write a script/app…" is a coding job, not a writing one.
  const CODE = ["web", "app", "game", "dashboard", "script", "backend", "bot", "extension", "mobile", "debug", "slides", "animation", "logo", "diagram"];
  if (picked.includes("writing") && picked.some((x) => CODE.includes(x))) picked = picked.filter((x) => x !== "writing");
  // A plain "build/make/create" in Code mode without a clear kind → app.
  if (!picked.length && mode === "code" && /\b(build|make|create|design|code)\b/i.test(latest)) picked = ["app"];
  return picked.slice(0, 3);
}

export function skillGuide(ids) {
  return ids.map((id) => (SKILLS[id] ? SKILLS[id].guide() : "")).filter(Boolean).join("\n\n");
}

// Design-heavy answers that come out better from Gemini, even when short.
export function prefersGemini(ids) {
  return ids.some((id) => id === "logo" || id === "animation" || id === "slides" || id === "design");
}

export function isHeavy(ids) {
  return ids.some((id) => SKILLS[id] && SKILLS[id].heavy);
}

export const SKILL_IDS = Object.keys(SKILLS);
