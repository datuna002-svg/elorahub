(function(){
  "use strict";

  var app = window.EloraHubApp || null;
  var panel = document.getElementById("workspaceOverlay");
  var panelBody = document.getElementById("workspacePanelBody");
  var panelTitle = document.getElementById("workspacePanelTitle");
  var panelKicker = document.getElementById("workspacePanelKicker");
  var panelDescription = document.getElementById("workspacePanelDescription");
  var accountTrigger = document.getElementById("accountMenuTrigger");
  var accountMenu = document.getElementById("accountMenu");
  var moreTrigger = document.getElementById("moreMenuTrigger");
  var moreMenu = document.getElementById("moreMenu");
  var attachTrigger = document.getElementById("attachBtn");
  var attachMenu = document.getElementById("attachMenu");
  var chatInput = document.getElementById("chatInput");
  var fileInput = document.getElementById("fileInput");
  var folderInput = document.getElementById("folderInput");
  var state = emptyState();
  var identity = "guest";
  var syncAvailable = false;
  var accountSyncReady = false;
  var guestImportPending = false;
  var syncMessage = "Saved on this device";
  var syncTimer = 0;
  var reminderTimer = 0;
  var activePanel = null;
  var lastFocus = null;
  var connectorStatuses = { google:{ configured:false, connected:false }, github:{ configured:false, connected:false } };

  var BUILTIN_PROMPTS = [
    { id:"prompt-rewrite", title:"Rewrite, keep my voice", prompt:"Rewrite this so it is clearer and tighter, but preserve my voice and meaning:\n\n" },
    { id:"prompt-decide", title:"Think through a decision", prompt:"Help me make this decision. State the real trade-offs, surface assumptions, then recommend a direction:\n\n" },
    { id:"prompt-explain", title:"Explain a file plainly", prompt:"Explain the attached file in plain language. Start with the main point, then identify what matters and what is uncertain.\n\n" },
    { id:"prompt-build", title:"Build a first working version", prompt:"Build a complete first working version of this. State your assumptions briefly, then give me the implementation and how to run it:\n\n" }
  ];

  function emptyState(){ return { schema:1, projects:[], artifacts:[], schedules:[], skills:[], taskRuns:[], sessions:[] }; }
  function escapeHtml(value){ return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]; }); }
  function uid(){ return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "eh-" + Date.now().toString(36) + Math.random().toString(36).slice(2,9); }
  function toast(message){ if(app && app.toast){ app.toast(message); return; } var el=document.getElementById("toast"); if(el){ el.textContent=message; el.classList.add("is-visible"); setTimeout(function(){el.classList.remove("is-visible");},2800); } }
  function currentUser(){ return app && app.getUser ? app.getUser() : null; }
  function accessToken(){ return app && app.getAccessToken ? app.getAccessToken() : null; }
  function identityForUser(user){
    if(user && user.id) return "account-" + user.id;
    if(user && user.email) return "local-" + String(user.email).toLowerCase();
    return "guest";
  }
  function storageKey(kind, who){ return "elorahub_" + kind + "_v1_" + who; }
  function normalizeState(raw){
    var out=emptyState();
    if(!raw || typeof raw!=="object") return out;
    ["projects","artifacts","schedules","skills","taskRuns"].forEach(function(k){ if(Array.isArray(raw[k])) out[k]=raw[k].filter(function(x){return x && typeof x==="object" && typeof x.id==="string";}).slice(0,200); });
    if(Array.isArray(raw.sessions)) out.sessions=raw.sessions.filter(function(x){return x && typeof x==="object" && (typeof x.id==="number" || typeof x.id==="string");}).slice(0,30);
    return out;
  }
  function readJson(key, fallback){ try{ var v=JSON.parse(localStorage.getItem(key)||"null"); return v==null?fallback:v; }catch(_e){ return fallback; } }
  function writeJson(key,value){ try{ localStorage.setItem(key,JSON.stringify(value)); return true; }catch(_e){ return false; } }
  function snapshotSynced(){ return {schema:1,projects:state.projects,artifacts:state.artifacts,schedules:state.schedules,skills:state.skills}; }
  function mergeItems(localItems,remoteItems){
    var map=new Map();
    (Array.isArray(remoteItems)?remoteItems:[]).concat(Array.isArray(localItems)?localItems:[]).forEach(function(item){
      if(!item || !item.id) return;
      var old=map.get(item.id);
      if(!old || Number(item.updatedAt||item.createdAt||0)>=Number(old.updatedAt||old.createdAt||0)) map.set(item.id,item);
    });
    return Array.from(map.values()).sort(function(a,b){return Number(b.updatedAt||b.createdAt||0)-Number(a.updatedAt||a.createdAt||0);}).slice(0,200);
  }
  function mergeWorkspace(local,remote){
    var out=emptyState();
    ["projects","artifacts","schedules","skills"].forEach(function(k){out[k]=mergeItems(local[k],remote[k]);});
    out.taskRuns=mergeItems(local.taskRuns,remote.taskRuns);
    out.sessions=local.sessions||[];
    return out;
  }
  function mergeGuestWorkspaceIntoAccount(accountIdentity){
    var guest=normalizeState(readJson(storageKey("workspace","guest"),emptyState()));
    if(!guest.projects.length&&!guest.artifacts.length&&!guest.schedules.length&&!guest.skills.length) return false;
    var account=normalizeState(readJson(storageKey("workspace",accountIdentity),emptyState()));
    var merged=mergeWorkspace(account,guest);
    writeJson(storageKey("workspace",accountIdentity),{schema:1,projects:merged.projects,artifacts:merged.artifacts,schedules:merged.schedules,skills:merged.skills,taskRuns:merged.taskRuns});
    return true;
  }
  function localSave(){
    var synced=snapshotSynced();
    writeJson(storageKey("workspace",identity),Object.assign({},synced,{taskRuns:state.taskRuns}));
    writeJson(storageKey("chats",identity),state.sessions.slice(0,30));
    if(identity.indexOf("account-")===0 && accessToken() && accountSyncReady){
      clearTimeout(syncTimer);
      syncTimer=setTimeout(pushRemote,600);
    }
  }
  async function api(path,options){
    options=options||{}; options.headers=Object.assign({},options.headers||{});
    var token=accessToken(); if(token) options.headers.Authorization="Bearer "+token;
    if(options.body && !options.headers["Content-Type"]) options.headers["Content-Type"]="application/json";
    return fetch(path,options);
  }
  async function pullRemote(){
    if(!accessToken() || identity.indexOf("account-")!==0){ syncAvailable=false; accountSyncReady=false; setSyncText(); return false; }
    var requestedIdentity=identity;
    try{
      var res=await api("/api/workspace",{method:"GET",cache:"no-store"});
      if(identity!==requestedIdentity) return false;
      if(!res.ok){ syncAvailable=false; syncMessage=res.status===404||res.status===503?"Local copy · account sync setup needed":"Local copy · sync unavailable"; setSyncText(); return false; }
      var data=await res.json();
      if(identity!==requestedIdentity) return false;
      var remote=normalizeState(data.workspace||data);
      state=mergeWorkspace(state,remote);
      syncAvailable=true; accountSyncReady=true; syncMessage="Synced to your account";
      localSave(); renderAll(); setSyncText();
      if(guestImportPending){guestImportPending=false;toast("Your browser-local projects, notes, reminders and prompts are now synced to this account.");}
      return true;
    }catch(_e){ if(identity!==requestedIdentity)return false; syncAvailable=false; accountSyncReady=false; syncMessage="Local copy · sync unavailable"; setSyncText(); return false; }
  }
  async function pushRemote(){
    if(!accessToken() || identity.indexOf("account-")!==0 || !accountSyncReady) return false;
    var requestedIdentity=identity, body=JSON.stringify({workspace:snapshotSynced()});
    try{
      var res=await api("/api/workspace",{method:"PUT",body:body});
      if(identity!==requestedIdentity) return false;
      if(!res.ok){ syncAvailable=false; syncMessage="Local copy · account sync setup needed"; setSyncText(); return false; }
      syncAvailable=true; syncMessage="Synced to your account"; setSyncText();
      return true;
    }catch(_e){ syncAvailable=false; syncMessage="Local copy · sync unavailable"; setSyncText(); return false; }
  }
  function loadIdentity(){
    var user=currentUser();
    identity=identityForUser(user);
    state=normalizeState(readJson(storageKey("workspace",identity),emptyState()));
    state.sessions=readJson(storageKey("chats",identity),[]);
    if(!Array.isArray(state.sessions)) state.sessions=[];
    if(app && app.restoreSessions) app.restoreSessions(state.sessions);
    syncAvailable=false; accountSyncReady=false;
    syncMessage=(user && accessToken())?"Checking account sync…":"Saved on this device";
    renderAll(); setSyncText();
    if(user && accessToken()) pullRemote();
  }
  function onAuthChange(){
    var next=identityForUser(currentUser());
    if(next!==identity){
      localSave();
      if(next.indexOf("account-")===0 && identity==="guest") guestImportPending=mergeGuestWorkspaceIntoAccount(next);
      identity=next;
    }
    loadIdentity();
    renderAccount();
  }
  function setSyncText(){
    // The account row shows the plan; sync status lives in the account menu.
    var meta=document.getElementById("accountSyncState");
    if(meta){
      var user=currentUser();
      meta.textContent=user ? (accessToken() ? syncMessage : "Local account · not synced") : "Log in to sync your workspace";
    }
  }
  function scheduleSave(){ localSave(); renderCounts(); }
  function renderCounts(){
    var pc=document.getElementById("projectCount"), ac=document.getElementById("artifactCount"), sc=document.getElementById("scheduleCount");
    if(pc) pc.textContent=state.projects.length?String(state.projects.length):"";
    if(ac) ac.textContent=state.artifacts.length?String(state.artifacts.length):"";
    if(sc) sc.textContent=state.schedules.filter(function(s){return s.enabled!==false;}).length?String(state.schedules.filter(function(s){return s.enabled!==false;}).length):"";
    renderPinnedProjects();
    renderSidebarSchedules();
  }
  // Active scheduled tasks/reminders, listed in the sidebar like pinned items.
  function renderSidebarSchedules(){
    var host=document.getElementById("sidebarScheduledList"), wrap=document.getElementById("sidebarScheduled");
    if(!host||!wrap) return;
    var active=state.schedules.filter(function(s){return s.enabled!==false;});
    wrap.hidden=!active.length; host.textContent="";
    active.slice(0,5).forEach(function(item){
      var btn=document.createElement("button"); btn.type="button"; btn.className="workspace-pinned-item ec-scheduled-item"; btn.dataset.workspaceView="scheduled";
      btn.innerHTML='<svg class="ec-i" aria-hidden="true"><use href="#i-clock"/></svg>';
      var label=document.createElement("span"); label.textContent=item.title||"Scheduled task";
      btn.appendChild(label); btn.addEventListener("click",function(){openPanel("scheduled");}); host.appendChild(btn);
    });
  }
  function renderAccount(){
    var user=currentUser(), name=(user && (user.name||user.email))||"Guest", email=(user && user.email)||"Not signed in";
    var nameEl=document.getElementById("sidebarUserName"), meta=document.getElementById("sidebarUserMeta"), avatar=document.getElementById("sidebarAvatar");
    var menuName=document.getElementById("accountMenuName"), menuEmail=document.getElementById("accountMenuEmail");
    var authAction=document.getElementById("accountAuthAction"), signOut=document.getElementById("accountSignOut");
    if(nameEl) nameEl.textContent=name; if(menuName) menuName.textContent=name; if(menuEmail) menuEmail.textContent=email;
    if(avatar) avatar.textContent=(user && user.name ? user.name.slice(0,1) : user && user.email ? user.email.slice(0,1) : "G").toUpperCase();
    if(authAction){ authAction.hidden=!!user; }
    if(signOut){ signOut.hidden=!user; }
    if(meta) setSyncText();
  }
  function renderPinnedProjects(){
    var host=document.getElementById("workspacePinnedList"), wrap=document.getElementById("workspacePinned");
    if(!host||!wrap) return;
    var pinned=state.projects.filter(function(p){return !!p.pinned;});
    wrap.hidden=!pinned.length; host.textContent="";
    pinned.slice(0,5).forEach(function(project){
      var btn=document.createElement("button"); btn.type="button"; btn.className="workspace-pinned-item"; btn.dataset.projectOpen=project.id;
      var dot=document.createElement("span"); dot.className="workspace-pinned-dot"; dot.setAttribute("aria-hidden","true");
      var label=document.createElement("span"); label.textContent=project.name;
      btn.append(dot,label); host.appendChild(btn);
    });
  }
  function openMenu(menu,trigger){
    if(!menu) return;
    var shouldOpen=menu.hidden; closeMenus(); menu.hidden=!shouldOpen;
    if(trigger) trigger.setAttribute("aria-expanded",String(shouldOpen));
  }
  function closeMenus(){
    [[accountMenu,accountTrigger],[moreMenu,moreTrigger],[attachMenu,attachTrigger]].forEach(function(pair){if(pair[0]) pair[0].hidden=true;if(pair[1])pair[1].setAttribute("aria-expanded","false");});
    var learn=document.getElementById("learnMenu"); if(learn) learn.hidden=true;
  }
  // ---------------------------------------------------------------------
  // Full-page views in the main area (Projects, Artifacts, Scheduled tasks,
  // Customize) — they replace the chat until you pick a chat or New chat.
  // ---------------------------------------------------------------------
  var pageEl=document.getElementById("workspacePage"), pageBody=document.getElementById("workspacePageBody"), chatMain=document.getElementById("chatMain");
  var sheetEl=null;
  var ui={artTab:"all",artQuery:"",artView:"list",artSearch:false,custTab:"skills",custScope:"",custQuery:"",projQuery:""};
  var SKILL_CATALOG=[
    {id:"cat-review",icon:"code",title:"Code reviewer",desc:"Paste code and get a careful review: real bugs, edge cases, security and naming — then the fixed code.",prompt:"Review this code like a senior engineer. List real bugs and risky edge cases first (with line references), then security problems, then readability. Finish with the corrected full code.\n\n```\n\n```"},
    {id:"cat-bug",icon:"bug",title:"Bug hunter",desc:"Describe the bug and paste the error. elora traces what the code really does and gives the smallest fix.",prompt:"Help me find and fix a bug. Trace what the code actually does step by step, name the root cause, then give the smallest correct fix and how to check it worked.\n\nWhat happens:\n\nError message:\n\nCode:\n"},
    {id:"cat-site",icon:"window",title:"Website builder",desc:"Describe a site and get a complete, responsive page you can preview, tweak and download.",prompt:"Build a complete, responsive one-page website as a single HTML file with inline CSS and JS. Make it modern and polished.\n\nIt's for:\nSections I want:\n"},
    {id:"cat-explain",icon:"cap",title:"Explain it simply",desc:"Any topic or file explained in plain words, with one good example.",prompt:"Explain this in plain, simple language as if I'm smart but new to it. Start with a one-sentence summary, then the key ideas, then one concrete example:\n\n"},
    {id:"cat-email",icon:"mail",title:"Email writer",desc:"Turn a few notes into a clear, friendly email in your voice, with a subject line.",prompt:"Write a clear, friendly email from these notes. Keep it short, keep my voice, and give me a subject line.\n\nTo:\nWhat I want:\nNotes:\n"},
    {id:"cat-polish",icon:"pen",title:"Writing polish",desc:"Tighten a draft without losing your voice — clearer, shorter, stronger.",prompt:"Rewrite this so it's clearer and tighter, but keep my voice and meaning. Then list the 3 biggest changes you made:\n\n"},
    {id:"cat-quiz",icon:"book",title:"Quiz me",desc:"Learn faster: elora asks one question at a time and explains whatever you miss.",prompt:"Quiz me on this topic, one question at a time. Wait for my answer, tell me if I'm right, explain briefly, then ask the next one. Start easy and get harder.\n\nTopic: "},
    {id:"cat-plan",icon:"check-list",title:"Project planner",desc:"Break a goal into clear steps with time estimates and the first thing to do today.",prompt:"Turn this goal into a clear plan: milestones, concrete steps with rough time estimates, risks to watch, and the very first thing I should do today.\n\nGoal: "},
    {id:"cat-decide",icon:"scale",title:"Decision helper",desc:"Lay out the real trade-offs of a choice and get a straight recommendation.",prompt:"Help me decide. State the real trade-offs, surface hidden assumptions, then give me a clear recommendation and what would change your mind.\n\nThe choice: "},
    {id:"cat-summary",icon:"doc",title:"Summarize anything",desc:"Paste text or attach a file. Get the key points, decisions and next steps.",prompt:"Summarize this. Give me the 5 key points, any decisions or numbers that matter, and suggested next steps:\n\n"},
    {id:"cat-sql",icon:"database",title:"SQL helper",desc:"Describe the data you want and get the query, explained, plus indexes that help.",prompt:"Write the SQL for this, explain it line by line, and suggest indexes that would make it fast.\n\nTables:\nWhat I need:\n"},
    {id:"cat-translate",icon:"globe",title:"Georgian ⇄ English",desc:"Natural translations both ways, with a note on tone where it matters.",prompt:"Translate this naturally (Georgian ⇄ English — detect which way). Keep the tone; add a short note only where a phrase has no direct equivalent:\n\n"},
    {id:"cat-interview",icon:"user",title:"Interview coach",desc:"Practice a job interview: realistic questions, then honest feedback on each answer.",prompt:"Run a mock job interview with me. Ask one realistic question at a time, wait for my answer, then give honest feedback and a stronger version before the next question.\n\nRole:\nCompany (optional):\n"},
    {id:"cat-regex",icon:"terminal",title:"Regex builder",desc:"Say what you need to match and get a tested regular expression with examples.",prompt:"Write a regular expression for this. Explain each part, and show 3 strings it matches and 3 it shouldn't:\n\nI need to match: "}
  ];
  var BUILDERS=[
    {id:"b-app",icon:"phone",title:"App builder",big:true,desc:"A complete web app in one go: screens, navigation, saved data, dark mode — planned and built step by step, ready to preview and download.",prompt:"Build a complete, working web app as a single self-contained HTML file (inline CSS and JS). Plan it first, then build it step by step: data model, screens and navigation, create / edit / delete, saving to localStorage, empty states, a polished responsive design with dark mode, and keyboard shortcuts. Finish with a short how-to-use guide.\n\nThe app: [what should it do?]\nWho uses it: [who]\nMust-have features: [list]"},
    {id:"b-site",icon:"window",title:"Website builder Pro",big:true,desc:"A full multi-page website — home, about, services, contact — with shared styles, animations and SEO, delivered as files you can download.",prompt:"Build a complete multi-page website as separate files: index.html, about.html, services.html, contact.html, styles.css and script.js. Work step by step: plan the sitemap and design system, build each page, add responsive navigation, smooth scroll animations, a working contact form layout, SEO meta tags and accessibility. Use real-sounding copy, not lorem ipsum.\n\nThe website is for: [business or person]\nStyle: [modern / minimal / bold / playful]\nColours: [optional]"},
    {id:"b-landing",icon:"spark",title:"Landing page builder",big:true,desc:"A high-converting landing page: hero, features, social proof, pricing, FAQ and a strong call to action.",prompt:"Build a high-converting landing page as one HTML file with inline CSS and JS. Plan the message first, then build: hero with a clear promise and CTA, features, how it works, testimonials placeholder, pricing table, FAQ accordion, final CTA and footer. Make it responsive with tasteful animations.\n\nProduct: [what are you selling?]\nAudience: [who]\nMain call to action: [e.g. Sign up, Book a call]"},
    {id:"b-dashboard",icon:"gauge",title:"Dashboard builder",big:true,desc:"An admin dashboard with charts, stat cards, a searchable table and filters, filled with realistic sample data.",prompt:"Build an interactive dashboard as one HTML file (inline CSS and JS, charts drawn with SVG or canvas — no external libraries). Step by step: plan the metrics, generate realistic sample data, build stat cards, a line chart and a bar chart, a sortable and searchable table, date-range filters and a responsive layout with dark mode.\n\nWhat it tracks: [sales, fitness, students, website traffic…]\nKey numbers: [list]"},
    {id:"b-game",icon:"bolt",title:"Game builder",big:true,desc:"A playable browser game with controls, scoring, levels and a start screen — runs right in the preview.",prompt:"Build a complete, playable browser game as one HTML file using canvas (inline JS and CSS). Step by step: design the rules, build the game loop, controls (keyboard and touch), scoring, increasing difficulty, a start screen, pause and game-over screens, and a saved high score.\n\nGame idea: [describe it, e.g. a space dodger, a puzzle, a platformer]"},
    {id:"b-store",icon:"card",title:"Online store page",big:true,desc:"A shop page with product grid, filters, a working cart and a checkout form layout (no real payments).",prompt:"Build an online store front as one HTML file (inline CSS and JS). Step by step: product data, product grid with images (use placeholder gradients), search and category filters, product detail modal, a cart saved in localStorage with quantities and totals, and a checkout form layout. No real payments.\n\nThe store sells: [what]\nStore name: [name]"},
    {id:"b-portfolio",icon:"user",title:"Portfolio builder",big:true,desc:"A personal portfolio site: intro, projects, skills, experience and contact, beautifully laid out.",prompt:"Build a personal portfolio website as one HTML file (inline CSS and JS). Step by step: hero with name and role, about, project cards with filters, skills, experience timeline, testimonials and a contact section. Responsive, fast and elegant.\n\nMy name and role: [e.g. Nika — designer]\nProjects to show: [list a few]"},
    {id:"b-api",icon:"database",title:"REST API builder",big:true,desc:"A Node.js + Express API with routes, validation, error handling, a README and example requests.",prompt:"Build a complete REST API in Node.js with Express. Step by step: design the resources and endpoints, create package.json, server.js, routes, input validation, error handling, an in-memory or SQLite store, and a README with setup steps and example curl requests.\n\nThe API is for: [e.g. a todo app, a bookstore, a booking system]\nResources: [list]"},
    {id:"b-bot",icon:"chat",title:"Discord bot builder",big:true,desc:"A discord.js bot with slash commands, permissions and a step-by-step setup guide.",prompt:"Build a Discord bot with discord.js v14. Step by step: plan the commands, create package.json, index.js, a commands folder with slash commands, command registration, error handling, a .env example and a README with setup instructions.\n\nWhat the bot does: [describe]\nCommands: [list]"},
    {id:"b-extension",icon:"plug",title:"Chrome extension builder",big:true,desc:"A Manifest V3 extension with a popup, options and content script, ready to load unpacked.",prompt:"Build a Chrome extension (Manifest V3). Step by step: manifest.json, popup.html/popup.js/popup.css, a content script, an options page, storage with chrome.storage, and a README explaining how to load it unpacked.\n\nThe extension should: [describe]"},
    {id:"b-python",icon:"terminal",title:"Python automation",big:true,desc:"A robust Python script for a boring task — with arguments, logging, error handling and instructions.",prompt:"Write a complete Python 3 automation script. Step by step: plan it, then write the code with argparse options, logging, clear error handling, and comments; add a requirements.txt if needed and usage examples.\n\nAutomate this: [describe the boring task]"},
    {id:"b-slides",icon:"slides",title:"Slide deck builder",big:true,desc:"A beautiful presentation as one HTML file — keyboard navigation, speaker-friendly and ready to present.",prompt:"Create a presentation as one self-contained HTML file: 8–12 slides, arrow keys and on-screen buttons to move, slide counter, clean modern design, and strong headlines. Plan the story first, then build the slides step by step.\n\nTopic: [what]\nAudience: [who]\nLength: [minutes]"}
  ];
  var TEMPLATES=[
    {id:"tpl-brief",icon:"sunrise",title:"Daily briefing",desc:"A short morning summary of the news on the topics you care about.",kind:"daily_task",cadence:"daily",prompt:"Give me a short morning briefing: the 5 most important news items today about [your topics]. One or two sentences each, with the source link."},
    {id:"tpl-monitor",icon:"binoculars",title:"Monitor a topic",desc:"Watch for news or mentions of a topic, competitor or keyword.",kind:"daily_task",cadence:"daily",prompt:"Search for news and mentions of [topic, company or keyword]. List anything new from the last 24 hours with a one-line summary and the link. If there's nothing new, say so in one line."},
    {id:"tpl-weekly",icon:"check-list",title:"Weekly review",desc:"A Friday check-in on your goals and the top three priorities for next week.",kind:"daily_task",cadence:"weekly",prompt:"Weekly review for my goals: [list your goals]. Give me 3 short reflection questions, then suggest the top 3 priorities for next week and one thing to stop doing."},
    {id:"tpl-ideas",icon:"bulb",title:"Content ideas",desc:"A few fresh post ideas each week for your niche, each with a hook.",kind:"daily_task",cadence:"weekly",prompt:"Give me 5 fresh content ideas for [my niche and audience] this week. For each: a hook line, the format (post, short video, thread) and why it should work."},
    {id:"tpl-learn",icon:"cap",title:"Learn something",desc:"A bite-size lesson every weekday on a subject you pick.",kind:"daily_task",cadence:"weekdays",prompt:"Teach me one bite-size lesson (under 300 words) about [subject]. Build on the basics day by day and end with one question to check my understanding."},
    {id:"tpl-remind",icon:"bell",title:"Reminder",desc:"A one-time nudge at the exact time you choose, while elorahub is open.",kind:"reminder"}
  ];
  var MAKE=[
    {id:"doc",title:"Document",art:'<div class="ew-art-doc"><i></i><i></i><i></i><i></i><i></i><i></i></div>',prompt:"Write a clear, well-structured document in markdown, with headings and short sections. Topic and audience: "},
    {id:"slides",title:"Slides",art:'<div class="ew-art-slides"><i></i><i></i><i></i></div>',prompt:"Create a slide deck as one self-contained HTML file: one slide per screen, arrow keys and on-screen buttons to move, a clean dark design and 6–10 slides. Topic: "},
    {id:"site",title:"Website",art:'<div class="ew-art-site"><i></i><i></i><i></i></div>',prompt:"Build a complete, responsive one-page website as a single HTML file with inline CSS and JS. Make it modern and polished. It's for: "},
    {id:"app",title:"App",art:'<div class="ew-art-app"><i></i><i></i><i></i><i></i><i></i></div>',prompt:"Build a small working web app as a single HTML file with inline CSS and JS, saving data in localStorage. The app: "}
  ];
  function ic(name){ return '<svg class="ec-i" aria-hidden="true"><use href="#i-'+name+'"/></svg>'; }
  function markNav(view){ document.querySelectorAll(".ec-nav [data-workspace-view]").forEach(function(b){ b.classList.toggle("is-current", b.dataset.workspaceView===view); }); }
  function closeSidebarOnPhone(){ var side=document.getElementById("chatSidebar"), scrim=document.getElementById("sidebarScrim"); if(side&&side.classList.contains("is-open")&&scrim) scrim.click(); }
  function openPanel(view){
    closeMenus();
    if(view==="skills"){ ui.custTab="skills"; view="customize"; }
    else if(view==="connectors"){ ui.custTab="connectors"; view="customize"; loadConnectorStatus().then(function(){ if(activePanel==="customize"&&ui.custTab==="connectors") renderPanel(); }); }
    activePanel=view;
    if(!pageEl||!pageBody) return;
    if(window.EloraNav&&!window.EloraNav.isRestoring()) window.EloraNav.record({page:"chat",view:view});
    pageEl.hidden=false; if(chatMain) chatMain.classList.add("is-page");
    var tpClose=document.getElementById("taskPanelClose"), tp=document.getElementById("taskPanel"); if(tp&&!tp.hidden&&tpClose) tpClose.click();
    var bp=document.getElementById("browserPanel"); if(bp&&!bp.hidden){ var bc=document.getElementById("browserClose"); if(bc) bc.click(); }
    markNav(view); renderPanel(); pageEl.scrollTop=0;
    if(window.eloraSwapIn) window.eloraSwapIn(pageBody);
    closeSidebarOnPhone();
  }
  function closePage(){
    closeSheet();
    if(!pageEl||pageEl.hidden) return;
    pageEl.hidden=true; if(chatMain) chatMain.classList.remove("is-page"); markNav(null); activePanel=null;
  }
  function closePanel(){ closePage(); }
  function timeLabel(ts){ if(!ts) return ""; try{return new Date(ts).toLocaleString([], {dateStyle:"medium",timeStyle:"short"});}catch(_e){return "";} }
  function agoLabel(ts){
    if(!ts) return ""; var d=Date.now()-Number(ts), m=Math.round(d/60000);
    if(m<1) return "Just now"; if(m<60) return m+"m ago"; var h=Math.round(m/60); if(h<24) return h+"h ago";
    var days=Math.round(h/24); if(days<7) return days+"d ago";
    try{return new Date(ts).toLocaleDateString([], {month:"short",day:"numeric"});}catch(_e){return "";}
  }
  function emptyBlock(iconName,title,copy,buttonHtml){ return '<div class="ew-empty">'+ic(iconName)+'<h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(copy)+'</p>'+(buttonHtml||"")+'</div>'; }
  function searchBox(id,placeholder,value){ return '<label class="ew-search">'+ic("search")+'<input type="search" id="'+id+'" placeholder="'+escapeHtml(placeholder)+'" value="'+escapeHtml(value||"")+'" autocomplete="off"></label>'; }
  function matches(q){ q=String(q||"").trim().toLowerCase(); return function(){ if(!q) return true; return Array.prototype.slice.call(arguments).join(" ").toLowerCase().indexOf(q)>-1; }; }
  function serverRunLabel(){ try{ var d=new Date(); d.setUTCHours(0,5,0,0); return d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); }catch(_e){ return "00:05 UTC"; } }
  function cadenceLabel(c){ return c==="weekly"?"Weekly":c==="weekdays"?"Weekdays":"Every day"; }

  // ---- Projects ----
  function renderProjects(){
    var sessions=app&&app.getSessions?app.getSessions():state.sessions;
    var match=matches(ui.projQuery);
    var html='<header class="ew-head"><h1>Projects</h1><button class="ew-btn ew-btn-main" type="button" data-action="show-project-form">'+ic("plus")+'New project</button></header>';
    html+='<p class="ew-sub">Group related chats and keep their context in one place.</p>';
    if(!state.projects.length) return html+emptyBlock("folder","No projects yet","Create a project to keep a set of chats together — a website, a class, a side business.",'<button class="ew-btn ew-btn-main" type="button" data-action="show-project-form">'+ic("plus")+'New project</button>');
    html+='<div class="ew-bar">'+searchBox("ewProjSearch","Search projects",ui.projQuery)+'</div>';
    var list=state.projects.filter(function(p){return match(p.name,p.description);});
    if(!list.length) return html+emptyBlock("search","No matching projects","Try a different word.");
    html+='<div class="ew-grid">'+list.map(function(p){
      var chats=sessions.filter(function(s){return s.projectId===p.id;}).sort(function(a,b){return Number(b.updatedAt||0)-Number(a.updatedAt||0);});
      var convs=chats.slice(0,3).map(function(c){return '<button type="button" data-ew="open-conv" data-id="'+escapeHtml(String(c.id))+'">'+ic("chat")+'<span>'+escapeHtml(c.title||"Conversation")+'</span></button>';}).join("");
      var pid=escapeHtml(p.id);
      return '<article class="ew-card"><div class="ew-card-top"><span class="ew-card-ico">'+ic("folder")+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(p.name)+'</h3><div class="ew-card-meta">'+chats.length+' chat'+(chats.length===1?"":"s")+' · '+escapeHtml(agoLabel(p.updatedAt||p.createdAt))+(p.pinned?' · Pinned':'')+'</div></div><div class="ew-card-tools"><button class="ew-iconbtn'+(p.pinned?" is-on":"")+'" type="button" title="'+(p.pinned?"Unpin from sidebar":"Pin to sidebar")+'" aria-label="'+(p.pinned?"Unpin":"Pin")+'" data-project-action="pin" data-id="'+pid+'">'+ic("pin")+'</button><button class="ew-iconbtn" type="button" title="Rename" aria-label="Rename" data-project-action="rename" data-id="'+pid+'">'+ic("pen")+'</button><button class="ew-iconbtn" type="button" title="Delete" aria-label="Delete" data-project-action="delete" data-id="'+pid+'">'+ic("trash")+'</button></div></div>'+
        (p.description?'<p>'+escapeHtml(p.description)+'</p>':'')+(convs?'<div class="ew-convs">'+convs+'</div>':'')+
        '<div class="ew-card-acts"><button class="ew-btn ew-btn-sm ew-btn-main" type="button" data-project-action="open" data-id="'+pid+'">'+ic("plus")+'New chat</button><button class="ew-btn ew-btn-sm" type="button" data-project-action="current" data-id="'+pid+'">Add this chat</button></div></article>';
    }).join("")+'</div>';
    return html;
  }

  // ---- Artifacts ----
  function artKind(a){ var k=String(a.kind||"Note"); return k==="File"?"files":k==="Note"?"notes":"replies"; }
  function artIcon(a){ var k=artKind(a); if(k==="files") return /\.(html?|css|js|ts|py|json|sh|go|rs|java|c|cpp)$/i.test(a.title||"")?"code":"file"; return k==="notes"?"pen":"chat"; }
  function renderArtifacts(){
    var tabs=[["all","All"],["replies","Saved replies"],["files","Files"],["notes","Notes"]];
    var match=matches(ui.artQuery);
    var html='<header class="ew-head"><h1>Artifacts</h1><button class="ew-iconbtn'+(ui.artSearch?" is-on":"")+'" type="button" data-ew="art-search" title="Search" aria-label="Search artifacts">'+ic("search")+'</button><button class="ew-iconbtn" type="button" data-ew="art-view" title="'+(ui.artView==="list"?"Grid view":"List view")+'" aria-label="Switch view">'+ic(ui.artView==="list"?"grid":"list")+'</button><button class="ew-btn" type="button" data-action="show-note-form">'+ic("plus")+'New note</button></header>';
    html+='<div class="ew-bar"><div class="ew-tabs" role="tablist">'+tabs.map(function(t){return '<button type="button" role="tab" class="ew-tab'+(ui.artTab===t[0]?" is-active":"")+'" data-ew="art-tab" data-v="'+t[0]+'">'+t[1]+'</button>';}).join("")+'</div>'+(ui.artSearch?'<span class="ew-spacer"></span>'+searchBox("ewArtSearch","Search artifacts",ui.artQuery):'')+'</div>';
    html+='<div class="ew-label">Make something new</div><div class="ew-make">'+MAKE.map(function(m){return '<button type="button" class="ew-make-card" data-ew="make" data-v="'+m.id+'"><div class="ew-art">'+m.art+'</div><strong>'+escapeHtml(m.title)+'<small>Task</small></strong></button>';}).join("")+'</div>';
    var items=state.artifacts.filter(function(a){return (ui.artTab==="all"||artKind(a)===ui.artTab)&&match(a.title,a.content,a.kind);});
    html+='<div class="ew-label">'+(ui.artTab==="all"?"Saved":tabs.filter(function(t){return t[0]===ui.artTab;})[0][1])+'</div>';
    if(!state.artifacts.length) return html+emptyBlock("artifact","Nothing saved yet","Save a reply with the bookmark under it, keep files from a task, or write a note.");
    if(!items.length) return html+emptyBlock("search","Nothing here","Try another tab or search word.");
    var acts=function(a){ var id=escapeHtml(a.id); return '<div class="ew-row-acts"><button class="ew-iconbtn" type="button" title="Copy" aria-label="Copy" data-artifact-action="copy" data-id="'+id+'">'+ic("copy")+'</button><button class="ew-iconbtn" type="button" title="Download" aria-label="Download" data-artifact-action="download" data-id="'+id+'">'+ic("download")+'</button><button class="ew-iconbtn" type="button" title="Delete" aria-label="Delete" data-artifact-action="delete" data-id="'+id+'">'+ic("trash")+'</button></div>'; };
    if(ui.artView==="grid"){
      html+='<div class="ew-grid">'+items.map(function(a){return '<article class="ew-card"><div class="ew-card-top ew-card-click" data-ew="art-open" data-id="'+escapeHtml(a.id)+'"><span class="ew-card-ico">'+ic(artIcon(a))+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(a.title||"Untitled")+'</h3><div class="ew-card-meta">'+escapeHtml(a.kind||"Note")+' · '+escapeHtml(agoLabel(a.updatedAt||a.createdAt))+'</div></div></div><p class="ew-card-click" data-ew="art-open" data-id="'+escapeHtml(a.id)+'">'+escapeHtml(plainExcerpt(a.content,200))+'</p>'+acts(a)+'</article>';}).join("")+'</div>';
    } else {
      html+='<div class="ew-list">'+items.map(function(a){return '<div class="ew-row"><span class="ew-row-ico">'+ic(artIcon(a))+'</span><div class="ew-row-main" data-ew="art-open" data-id="'+escapeHtml(a.id)+'" role="button" tabindex="0"><strong>'+escapeHtml(a.title||"Untitled")+'</strong><small>'+escapeHtml(plainExcerpt(a.content,120))+'</small></div><span class="ew-row-time">'+escapeHtml(agoLabel(a.updatedAt||a.createdAt))+'</span>'+acts(a)+'</div>';}).join("")+'</div>';
    }
    return html;
  }
  function plainExcerpt(text,n){ return String(text||"").replace(/```[a-z0-9 =._-]*\n?/gi," ").replace(/[#*`>|]+/g," ").replace(/^\s*[-+]\s+/gm," ").replace(/\s+/g," ").trim().slice(0,n); }
  function looksLikeHtml(a){ return /\.html?$/i.test(a.title||"")||/^\s*(<!doctype html|<html[\s>])/i.test(String(a.content||"")); }
  function openViewer(a){
    var html='<h2>'+escapeHtml(a.title||"Untitled")+'</h2><p>'+escapeHtml(a.kind||"Note")+' · saved '+escapeHtml(timeLabel(a.updatedAt||a.createdAt))+'</p><div class="ew-bar">'+(looksLikeHtml(a)?'<button class="ew-btn ew-btn-sm ew-btn-main" type="button" data-ew="viewer-preview">'+ic("eye")+'Preview</button>':'')+'<button class="ew-btn ew-btn-sm" type="button" data-artifact-action="copy" data-id="'+escapeHtml(a.id)+'">'+ic("copy")+'Copy</button><button class="ew-btn ew-btn-sm" type="button" data-artifact-action="download" data-id="'+escapeHtml(a.id)+'">'+ic("download")+'Download</button></div><div class="ew-viewer" id="ewViewerBody"></div>';
    openSheet(html,true);
    var body=document.getElementById("ewViewerBody");
    if(looksLikeHtml(a)){ showViewerPreview(a,body); }
    else if(app&&app.renderMarkdown){ body.appendChild(app.renderMarkdown(/```/.test(a.content)||artKind(a)!=="files"?a.content:"```\n"+a.content+"\n```")); }
    else { var pre=document.createElement("pre"); pre.textContent=a.content||""; body.appendChild(pre); }
    sheetEl.dataset.artifactId=a.id;
  }
  function showViewerPreview(a,body){
    body=body||document.getElementById("ewViewerBody"); if(!body) return;
    body.textContent=""; var frame=document.createElement("iframe"); frame.setAttribute("sandbox","allow-scripts allow-forms allow-modals"); frame.title="Preview of "+(a.title||"file"); frame.srcdoc=String(a.content||""); body.appendChild(frame);
  }
  function selectFirstBlank(){
    setTimeout(function(){ if(!chatInput) return; var v=chatInput.value, a=v.indexOf("["), b=v.indexOf("]",a); if(a>-1&&b>a){ chatInput.focus(); chatInput.setSelectionRange(a,b+1); } },60);
  }
  function startMake(id){
    var m=MAKE.filter(function(x){return x.id===id;})[0]; if(!m) return;
    if(app&&app.startNewChat) app.startNewChat();
    closePage();
    if(app&&app.setTaskMode) app.setTaskMode(true);
    setChatInput(m.prompt);
  }

  // ---- Scheduled tasks ----
  function renderSchedules(){
    var html='<header class="ew-head"><h1>Scheduled tasks</h1><button class="ew-btn ew-btn-main" type="button" data-ew="new-task">'+ic("plus")+'New task</button></header>';
    html+='<p class="ew-sub">Run tasks on a schedule or whenever you need them. Background tasks run once a day around '+escapeHtml(serverRunLabel())+' your time, even when elorahub is closed.</p>';
    if(state.schedules.length){
      html+='<div class="ew-grid2">'+state.schedules.slice().sort(function(a,b){return Number(b.createdAt)-Number(a.createdAt);}).map(function(s){
        var on=s.enabled!==false, bg=s.kind==="daily_task";
        var when=bg?cadenceLabel(s.cadence)+" · around "+serverRunLabel():(s.firedAt?"Done · ":"Once · ")+timeLabel(s.dueAt);
        var runs=state.taskRuns.filter(function(r){return r.taskId===s.id;}).sort(function(a,b){return Number(b.createdAt)-Number(a.createdAt);}).slice(0,3);
        var results=runs.map(function(r){return '<details class="ew-note"><summary style="cursor:pointer">'+(r.status==="failed"?"Run failed · ":"Result · ")+escapeHtml(timeLabel(r.createdAt))+'</summary><div style="margin-top:8px;white-space:pre-wrap;max-height:260px;overflow:auto">'+escapeHtml(r.result||r.error||"")+'</div></details>';}).join("");
        return '<article class="ew-card"><div class="ew-card-top"><span class="ew-card-ico">'+ic(bg?"repeat":"bell")+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(s.title)+'</h3><div class="ew-card-meta">'+ic("clock")+escapeHtml(when)+'</div></div><label class="ew-switch" title="'+(on?"Pause":"Resume")+'"><input type="checkbox" '+(on?"checked":"")+' data-schedule-action="toggle" data-id="'+escapeHtml(s.id)+'" aria-label="'+(on?"Pause":"Resume")+' '+escapeHtml(s.title)+'"><span></span></label></div><p>'+escapeHtml(bg?(s.prompt||""):(s.note||"A reminder for you."))+'</p>'+results+'<div class="ew-card-acts">'+(on?'<span class="ew-chip is-green">On</span>':'<span class="ew-chip">Paused</span>')+'<span class="ew-spacer"></span><button class="ew-iconbtn" type="button" title="Delete" aria-label="Delete" data-schedule-action="delete" data-id="'+escapeHtml(s.id)+'">'+ic("trash")+'</button></div></article>';
      }).join("")+'</div>';
      html+='<div class="ew-wave" aria-hidden="true"><svg viewBox="0 0 600 14" preserveAspectRatio="none"><path d="M0 7 Q 7.5 0 15 7 T 30 7 T 45 7 T 60 7 T 75 7 T 90 7 T 105 7 T 120 7 T 135 7 T 150 7 T 165 7 T 180 7 T 195 7 T 210 7 T 225 7 T 240 7 T 255 7 T 270 7 T 285 7 T 300 7 T 315 7 T 330 7 T 345 7 T 360 7 T 375 7 T 390 7 T 405 7 T 420 7 T 435 7 T 450 7 T 465 7 T 480 7 T 495 7 T 510 7 T 525 7 T 540 7 T 555 7 T 570 7 T 585 7 T 600 7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></div>';
    }
    html+='<div class="ew-label">'+(state.schedules.length?"Start from a template":"Start from a template — or press New task")+'</div><div class="ew-grid2">'+TEMPLATES.map(function(t){
      var when=t.kind==="reminder"?"Once · at the time you pick":cadenceLabel(t.cadence)+" · around "+serverRunLabel();
      return '<button type="button" class="ew-card ew-style-opt" data-ew="tpl" data-v="'+t.id+'"><div class="ew-card-top"><span class="ew-card-ico">'+ic(t.icon)+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(t.title)+'</h3><p style="margin-top:4px">'+escapeHtml(t.desc)+'</p><div class="ew-card-meta" style="margin-top:8px">'+ic("clock")+escapeHtml(when)+'</div></div></div></button>';
    }).join("")+'</div>';
    return html;
  }
  function localDateTimeValue(date){ var d=new Date(date.getTime()-date.getTimezoneOffset()*60000); return d.toISOString().slice(0,16); }
  function openScheduleSheet(tpl){
    var canOffline=!!(currentUser()&&accessToken()&&syncAvailable);
    var kind=tpl&&tpl.kind==="reminder"?"reminder":(tpl?"daily_task":(canOffline?"daily_task":"reminder"));
    var html='<h2>'+(tpl?escapeHtml(tpl.title):"New task")+'</h2><p>'+(tpl?escapeHtml(tpl.desc):"Have elora prepare something on a schedule, or set a reminder.")+'</p>';
    html+='<form class="ew-form" id="scheduleForm"><label>Name<input name="title" maxlength="90" required value="'+escapeHtml(tpl?tpl.title:"")+'" placeholder="e.g. Morning news on AI"></label>';
    html+='<label>Type<select name="kind" id="scheduleKind"><option value="daily_task"'+(kind==="daily_task"?" selected":"")+(canOffline?"":" disabled")+'>Background task — elora runs it on the server</option><option value="reminder"'+(kind==="reminder"?" selected":"")+'>Reminder — rings in this tab</option></select></label>';
    html+='<div id="offlineTaskFields" class="ew-form"'+(kind==="daily_task"?"":" hidden")+'><label>What should elora do?<textarea name="prompt" maxlength="3000" placeholder="Describe the result you want each time">'+escapeHtml(tpl&&tpl.prompt?tpl.prompt:"")+'</textarea></label><label>Repeat<select name="cadence"><option value="daily"'+(tpl&&tpl.cadence==="daily"?" selected":"")+'>Every day</option><option value="weekdays"'+(tpl&&tpl.cadence==="weekdays"?" selected":"")+'>Weekdays</option><option value="weekly"'+(tpl&&tpl.cadence==="weekly"?" selected":"")+'>Weekly</option></select></label><div class="ew-note">Runs once a day around '+escapeHtml(serverRunLabel())+' your time. Results appear on this page. Words in [brackets] are yours to fill in. elora only prepares a result — it never sends messages or changes your accounts.</div></div>';
    html+='<div id="reminderFields" class="ew-form"'+(kind==="reminder"?"":" hidden")+'><label>Remind me at<input name="dueAt" type="datetime-local" value="'+localDateTimeValue(new Date(Date.now()+3600000))+'"></label><label>Note<textarea name="note" maxlength="500" placeholder="Optional detail"></textarea></label><div class="ew-note">Reminders ring while elorahub is open in a tab. <button type="button" class="ew-btn ew-btn-sm" data-action="notifications" style="margin-left:6px">Allow notifications</button></div></div>';
    if(!canOffline) html+='<div class="ew-note">'+(currentUser()?"Background tasks need account sync — it's being set up for your account.":"Log in to create background tasks that run while elorahub is closed.")+'</div>';
    html+='<div class="ew-form-acts"><button class="ew-btn" type="button" data-ew="close-sheet">Cancel</button><button class="ew-btn ew-btn-main" type="submit">Create task</button></div></form>';
    openSheet(html);
    var first=sheetEl.querySelector(kind==="daily_task"?"textarea[name=prompt]":"input[name=title]"); if(first){ first.focus(); if(first.tagName==="TEXTAREA"){ var at=first.value.indexOf("["); if(at>-1){ var end=first.value.indexOf("]",at); first.setSelectionRange(at,end>-1?end+1:at); } } }
  }

  // ---- Customize ----
  function renderCustomize(){
    var tabs=[["skills","Skills"],["connectors","Connectors"],["styles","Styles"]];
    if(!ui.custScope) ui.custScope=state.skills.length?"yours":"discover";
    var html='<header class="ew-head"><h1>Customize</h1>'+(ui.custTab==="skills"?'<button class="ew-btn" type="button" data-action="show-skill-form">'+ic("plus")+'Add</button>':'')+'</header>';
    html+='<div class="ew-bar"><div class="ew-plain-tabs" role="tablist">'+tabs.map(function(t){return '<button type="button" role="tab" class="ew-tab'+(ui.custTab===t[0]?" is-active":"")+'" data-ew="cust-tab" data-v="'+t[0]+'">'+t[1]+'</button>';}).join("")+'</div>';
    if(ui.custTab==="skills") html+='<div class="ew-tabs" style="margin-left:6px">'+[["yours","Yours"],["discover","Discover"]].map(function(t){return '<button type="button" class="ew-tab'+(ui.custScope===t[0]?" is-active":"")+'" data-ew="cust-scope" data-v="'+t[0]+'">'+t[1]+'</button>';}).join("")+'</div><span class="ew-spacer"></span>'+searchBox("ewCustSearch","Search skills",ui.custQuery);
    html+='</div>';
    if(ui.custTab==="connectors") return html+'<p class="ew-sub" style="margin-top:0">Let elora read files you pick from your other apps. Read-only — elora never edits or deletes anything.</p>'+renderConnectors();
    if(ui.custTab==="styles") return html+renderStyles();
    var match=matches(ui.custQuery);
    var added=function(cid){ return state.skills.some(function(s){return s.from===cid;}); };
    if(ui.custScope==="discover"){
      var list=SKILL_CATALOG.filter(function(c){return match(c.title,c.desc);});
      var builders=BUILDERS.filter(function(c){return match(c.title,c.desc);});
      var card=function(c){var on=added(c.id);return '<article class="ew-card"><div class="ew-card-top"><span class="ew-card-ico">'+ic(c.icon)+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(c.title)+(c.big?' <span class="ew-chip ew-chip-ai">Task</span>':'')+'</h3><p style="margin-top:4px">'+escapeHtml(c.desc)+'</p><div class="ew-card-meta" style="margin-top:6px">by elorahub</div></div><div style="display:flex;gap:6px"><button class="ew-btn ew-btn-sm" type="button" data-ew="skill-try" data-id="'+c.id+'">'+ic("chat")+'Try</button><button class="ew-add'+(on?" is-added":"")+'" type="button" data-ew="skill-add" data-id="'+c.id+'" title="'+(on?"Added to Yours":"Add to Yours")+'" aria-label="'+(on?"Added":"Add")+' '+escapeHtml(c.title)+'">'+ic(on?"check":"plus")+'</button></div></div></article>';};
      if(!ui.custQuery){
        var fb=BUILDERS[0];
        html+='<section class="ew-feature ew-feature-ai"><div class="ew-feature-copy"><small>From elorahub · Big builder</small><h2>'+escapeHtml(fb.title)+'</h2><p>'+escapeHtml(fb.desc)+'</p><div class="ew-card-acts" style="padding:0"><button class="ew-btn ew-btn-main" type="button" data-ew="skill-try" data-id="'+fb.id+'">'+ic("bolt")+'Build an app</button><button class="ew-btn" type="button" data-ew="skill-add" data-id="'+fb.id+'"'+(added(fb.id)?" disabled":"")+'>'+(added(fb.id)?ic("check")+"Added":ic("plus")+"Add")+'</button></div></div><div class="ew-feature-art ew-feature-art-ai">'+ic(fb.icon)+'</div></section>';
        builders=builders.slice(1);
      }
      if(builders.length) html+='<div class="ew-label">Big builders — they plan the work and build it step by step</div><div class="ew-grid2">'+builders.map(card).join("")+'</div>';
      if(!ui.custQuery){
        var f=SKILL_CATALOG[0];
        html+='<section class="ew-feature"><div class="ew-feature-copy"><small>From elorahub</small><h2>'+escapeHtml(f.title)+'</h2><p>'+escapeHtml(f.desc)+'</p><div class="ew-card-acts" style="padding:0"><button class="ew-btn ew-btn-main" type="button" data-ew="skill-add" data-id="'+f.id+'"'+(added(f.id)?" disabled":"")+'>'+(added(f.id)?ic("check")+"Added":ic("plus")+"Add")+'</button><button class="ew-btn" type="button" data-ew="skill-try" data-id="'+f.id+'">'+ic("chat")+'Try</button></div></div><div class="ew-feature-art">'+ic(f.icon)+'</div></section>';
        list=list.slice(1);
      }
      html+='<div class="ew-label">'+(ui.custQuery?"More results":"Everyday skills")+'</div>';
      if(!list.length&&!builders.length) return html+emptyBlock("search","No skills match","Try a different word.");
      html+='<div class="ew-grid2">'+list.map(card).join("")+'</div>';
      return html;
    }
    var mine=state.skills.filter(function(s){return match(s.title,s.prompt);});
    if(!state.skills.length) return html+emptyBlock("wand","No skills yet","Add ready-made skills from Discover, or write your own reusable prompt.",'<div class="ew-card-acts" style="justify-content:center"><button class="ew-btn ew-btn-main" type="button" data-ew="cust-scope" data-v="discover">Browse Discover</button><button class="ew-btn" type="button" data-action="show-skill-form">'+ic("plus")+'Write your own</button></div>');
    if(!mine.length) return html+emptyBlock("search","No skills match","Try a different word.");
    html+='<div class="ew-grid2">'+mine.map(function(s){var c=SKILL_CATALOG.concat(BUILDERS).filter(function(x){return x.id===s.from;})[0];return '<article class="ew-card"><div class="ew-card-top"><span class="ew-card-ico">'+ic(c?c.icon:"wand")+'</span><div style="min-width:0;flex:1"><h3>'+escapeHtml(s.title)+'</h3><p style="margin-top:4px">'+escapeHtml(c?c.desc:String(s.prompt||"").slice(0,160))+'</p><div class="ew-card-meta" style="margin-top:6px">'+(c?"from elorahub":"by you")+'</div></div></div><div class="ew-card-acts"><button class="ew-btn ew-btn-sm ew-btn-main" type="button" data-ew="skill-try" data-id="'+escapeHtml(s.id)+'">'+ic("chat")+'Use</button><span class="ew-spacer"></span><button class="ew-iconbtn" type="button" title="Remove" aria-label="Remove '+escapeHtml(s.title)+'" data-skill-action="delete" data-id="'+escapeHtml(s.id)+'">'+ic("trash")+'</button></div></article>';}).join("")+'</div>';
    return html;
  }
  function renderStyles(){
    var prefs=app&&app.getPreferences?app.getPreferences():{};
    var styles=[["balanced","Balanced","Clear answers with just enough detail."],["concise","Concise","Short and to the point. Code first."],["deep","In depth","Thorough explanations, examples and edge cases."],["technical","Technical","Precise, expert-level answers with full code."]];
    var tones=[["direct","Direct","Straight answers, no fluff."],["warm","Warm","Friendly and encouraging."],["technical","Precise","Exact wording, careful claims."]];
    var opt=function(key,cur,o){return '<button type="button" class="ew-card ew-style-opt'+(cur===o[0]?" is-on":"")+'" data-ew="style" data-k="'+key+'" data-v="'+o[0]+'" aria-pressed="'+(cur===o[0])+'"><span class="ew-check">'+ic("check")+'</span><h3>'+o[1]+'</h3><p>'+o[2]+'</p></button>';};
    var html='<p class="ew-sub" style="margin-top:0">Choose how elora writes by default. You can still switch per message in the box.</p>';
    html+='<div class="ew-label">Answer style</div><div class="ew-grid">'+styles.map(function(o){return opt("style",prefs.style||"balanced",o);}).join("")+'</div>';
    html+='<div class="ew-label">Tone</div><div class="ew-grid">'+tones.map(function(o){return opt("tone",prefs.tone||"direct",o);}).join("")+'</div>';
    var ins=String(prefs.instructions||"").trim();
    html+='<div class="ew-label">Your instructions</div><article class="ew-card"><h3>Instructions for elora</h3><p>'+escapeHtml(ins||"Nothing yet — tell elora things like “keep answers short” or “always use TypeScript”.")+'</p><div class="ew-card-acts"><button class="ew-btn ew-btn-sm" type="button" data-ew="edit-instructions">'+ic("pen")+'Edit</button></div></article>';
    return html;
  }

  // ---- shared sheet (forms and the artifact viewer) ----
  function openSheet(html,wide){
    if(!sheetEl){
      sheetEl=document.createElement("div"); sheetEl.className="ew-sheet"; sheetEl.hidden=true; sheetEl.setAttribute("role","dialog"); sheetEl.setAttribute("aria-modal","true");
      document.body.appendChild(sheetEl);
      sheetEl.addEventListener("click",function(e){ if(e.target===sheetEl){closeSheet();return;} handlePanelClick(e); });
      sheetEl.addEventListener("submit",handlePanelSubmit);
      sheetEl.addEventListener("change",function(e){ if(e.target.id==="scheduleKind") renderScheduleFields(); });
    }
    sheetEl.innerHTML='<div class="ew-sheet-card'+(wide?" is-wide":"")+'"><button type="button" class="ew-iconbtn ew-sheet-x" data-ew="close-sheet" aria-label="Close">'+ic("x")+'</button>'+html+'</div>';
    sheetEl.hidden=false; delete sheetEl.dataset.artifactId;
    var root=document.getElementById("page-chat"); if(root&&!root.contains(sheetEl)){} 
  }
  function closeSheet(){ if(sheetEl&&!sheetEl.hidden){ sheetEl.hidden=true; sheetEl.innerHTML=""; } }
  function openFormSheet(kind){
    if(kind==="project") openSheet('<h2>New project</h2><p>Keep related chats together.</p><form class="ew-form" id="projectForm"><label>Name<input name="name" maxlength="70" required placeholder="e.g. Website refresh"></label><label>What is it for?<textarea name="description" maxlength="350" placeholder="A short note to keep the work focused"></textarea></label><div class="ew-form-acts"><button class="ew-btn" type="button" data-ew="close-sheet">Cancel</button><button class="ew-btn ew-btn-main" type="submit">Create project</button></div></form>');
    else if(kind==="note") openSheet('<h2>New note</h2><p>Saved in Artifacts.</p><form class="ew-form" id="noteForm"><label>Title<input name="title" maxlength="100" required placeholder="A useful note"></label><label>Content<textarea name="content" maxlength="12000" required placeholder="Write or paste your note" style="min-height:180px"></textarea></label><div class="ew-form-acts"><button class="ew-btn" type="button" data-ew="close-sheet">Cancel</button><button class="ew-btn ew-btn-main" type="submit">Save note</button></div></form>');
    else if(kind==="skill") openSheet('<h2>Add a skill</h2><p>A reusable starting prompt. Use it from Customize or the + menu.</p><form class="ew-form" id="skillForm"><label>Name<input name="title" maxlength="70" required placeholder="e.g. Product brief"></label><label>Prompt<textarea name="prompt" maxlength="2500" required placeholder="Write the instruction elora should start from" style="min-height:160px"></textarea></label><div class="ew-form-acts"><button class="ew-btn" type="button" data-ew="close-sheet">Cancel</button><button class="ew-btn ew-btn-main" type="submit">Save skill</button></div></form>');
    var f=sheetEl&&sheetEl.querySelector("input"); if(f) f.focus();
  }
  function rerenderKeepFocus(id){
    var el=document.getElementById(id), pos=el?el.selectionStart:null;
    renderPanel();
    var again=document.getElementById(id); if(again){ again.focus(); try{ if(pos!=null) again.setSelectionRange(pos,pos); }catch(_e){} }
  }
  function emptyPanel(title,copy){ return emptyBlock("search",title,copy); }
  async function loadConnectorStatus(){
    if(!accessToken()){ connectorStatuses={google:{configured:false,connected:false},github:{configured:false,connected:false}}; return; }
    try{
      var res=await api("/api/connectors/status",{method:"GET",cache:"no-store"});
      if(res.ok){ var data=await res.json(); connectorStatuses=data.providers||connectorStatuses; }
      else connectorStatuses={google:{configured:false,connected:false},github:{configured:false,connected:false}};
    }catch(_e){ connectorStatuses={google:{configured:false,connected:false},github:{configured:false,connected:false}}; }
  }
  function renderConnectors(){
    var rows=[
      {key:"google",name:"Google Drive",icon:'<svg viewBox="0 0 87.3 78" width="22" height="20"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>',copy:"Search and read files you choose to use in a chat. Read-only access."},
      {key:"github",name:"GitHub",icon:'<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2.2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2.2z"/></svg>',copy:"Browse repositories and read files with a read-only installation."}
    ];
    var html='<div class="workspace-note" style="margin-bottom:16px"><strong>Read-only by design.</strong> EloraHub cannot create, change, or delete files here. Content only enters a chat after you select it, and is not sent until you press Send. Disconnect removes EloraHub access; GitHub may still require uninstalling the app from GitHub settings.</div>';
    html+='<div style="display:grid;gap:10px">'+rows.map(function(r){
      var s=connectorStatuses[r.key]||{}, connected=!!s.connected, ready=!!s.configured;
      var signedIn=!!(currentUser()&&accessToken());
      var status=connected?"Connected · read-only":ready?"Ready to connect":signedIn?"Provider setup required":"Sign in to check availability";
      var action=connected?'<button class="workspace-secondary" type="button" data-connector-action="disconnect" data-provider="'+r.key+'">Disconnect</button>':ready?'<button class="workspace-primary" type="button" data-connector-action="connect" data-provider="'+r.key+'">Connect</button>':signedIn?'<button class="workspace-secondary" type="button" disabled title="OAuth app setup is not configured">Unavailable</button>':'<button class="workspace-secondary" type="button" data-connector-action="signin">Sign in to connect</button>';
      var search=connected&&r.key==="google"?'<form class="workspace-search-form" id="googleSearchForm"><label>Find a Drive file<input name="q" type="search" maxlength="120" placeholder="Search file names" required></label><button class="workspace-secondary" type="submit">Search Drive</button></form><div id="googleSearchResults" class="workspace-result-list"></div>':"";
      search+=connected&&r.key==="github"?'<form class="workspace-search-form" id="githubSearchForm"><label>Find a repository<input name="q" type="search" maxlength="120" placeholder="Repository or owner" required></label><button class="workspace-secondary" type="submit">Search GitHub</button></form><div id="githubSearchResults" class="workspace-result-list"></div><div id="githubTreeResults" class="workspace-result-list"></div>':"";
      return '<article class="workspace-connector-block"><div class="workspace-connector-card"><div class="workspace-connector-icon" aria-hidden="true">'+r.icon+'</div><div class="workspace-connector-copy"><strong>'+r.name+'</strong><p>'+r.copy+' <span style="display:block;margin-top:4px;color:#abb0b5">'+status+'</span></p></div>'+action+'</div>'+search+'</article>';
    }).join("")+'</div><div style="margin-top:16px"><button class="workspace-secondary" type="button" data-action="refresh-connectors">Refresh setup status</button></div>';
    return html;
  }
  async function googleDriveSearch(query){
    var host=document.getElementById("googleSearchResults");if(!host)return;host.textContent="Searching Drive…";
    try{
      var response=await api("/api/connectors/google/files?"+new URLSearchParams({q:query}),{method:"GET",cache:"no-store"});var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.message||"Drive search failed.");
      if(!data.files||!data.files.length){host.innerHTML=emptyPanel("No matching files","Try a different name.","⌕");return;}
      host.innerHTML=data.files.map(function(f){return '<article class="workspace-result"><div><strong>'+escapeHtml(f.name)+'</strong><small>'+escapeHtml(f.mimeType||"Drive file")+(f.modifiedTime?" · "+escapeHtml(timeLabel(Date.parse(f.modifiedTime))):"")+'</small></div><button class="workspace-secondary" type="button" data-connector-action="google-read" data-file-id="'+escapeHtml(f.id)+'" data-file-name="'+escapeHtml(f.name)+'" data-file-link="'+escapeHtml(f.webViewLink||"")+'">Use in chat</button></article>';}).join("");
    }catch(error){host.textContent=error.message||"Could not search Drive.";}
  }
  async function githubRepoSearch(query){
    var host=document.getElementById("githubSearchResults");if(!host)return;host.textContent="Searching GitHub…";
    try{
      var response=await api("/api/connectors/github/repos?"+new URLSearchParams({q:query}),{method:"GET",cache:"no-store"});var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.message||"GitHub search failed.");
      if(!data.repositories||!data.repositories.length){host.innerHTML=emptyPanel("No repositories found","Check the query or GitHub App installation selection.","⌕");return;}
      host.innerHTML=data.repositories.map(function(r){return '<article class="workspace-result"><div><strong>'+escapeHtml(r.fullName)+'</strong><small>'+escapeHtml(r.description||"Repository")+(r.private?" · Private":" · Public")+'</small></div><button class="workspace-secondary" type="button" data-connector-action="github-browse" data-owner="'+escapeHtml(r.owner)+'" data-repo="'+escapeHtml(r.name)+'" data-ref="'+escapeHtml(r.defaultBranch||"main")+'">Browse</button></article>';}).join("");
    }catch(error){host.textContent=error.message||"Could not search GitHub.";}
  }
  async function githubBrowse(owner,repo,path,ref){
    var host=document.getElementById("githubTreeResults");if(!host)return;host.textContent="Loading repository contents…";
    try{
      var params=new URLSearchParams({owner:owner,repo:repo,path:path||"",ref:ref||"main"});var response=await api("/api/connectors/github/tree?"+params,{method:"GET",cache:"no-store"});var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.message||"Repository contents could not be loaded.");
      var entries=data.entries||[];
      host.innerHTML='<div class="workspace-result-heading"><strong>'+escapeHtml(owner+'/'+repo+(path?"/"+path:""))+'</strong><button type="button" class="workspace-secondary" data-connector-action="github-browse" data-owner="'+escapeHtml(owner)+'" data-repo="'+escapeHtml(repo)+'" data-path="'+escapeHtml(path.split("/").slice(0,-1).join("/"))+'" data-ref="'+escapeHtml(ref||"main")+'">Up</button></div>'+(entries.length?entries.map(function(entry){var isDir=entry.type==="dir";return '<article class="workspace-result"><div><strong>'+escapeHtml(isDir?"▸ ":"◇ ")+escapeHtml(entry.name)+'</strong><small>'+escapeHtml(isDir?"Folder":String(entry.size||0)+" bytes")+'</small></div><button class="workspace-secondary" type="button" data-connector-action="'+(isDir?"github-browse":"github-read")+'" data-owner="'+escapeHtml(owner)+'" data-repo="'+escapeHtml(repo)+'" data-path="'+escapeHtml(entry.path)+'" data-ref="'+escapeHtml(ref||"main")+'">'+(isDir?"Open":"Use in chat")+'</button></article>';}).join(""):emptyPanel("No files here","This directory is empty or the installation has limited access.","◇"));
    }catch(error){host.textContent=error.message||"Could not load repository contents.";}
  }
  async function readConnectorFile(provider,attrs){
    var params;
    if(provider==="google"){
      params=new URLSearchParams({id:attrs.fileId||""});
    }else{
      params=new URLSearchParams({owner:attrs.owner||"",repo:attrs.repo||"",path:attrs.path||""});
    }
    try{
      var response=await api("/api/connectors/"+provider+"/file?"+params,{method:"GET",cache:"no-store"});var data=await response.json().catch(function(){return {};});
      if(!response.ok)throw new Error(data.message||"The selected file could not be read.");
      var title=data.title||data.path||attrs.fileName||"selected file";
      var link=data.webViewLink||data.htmlUrl||"";
      setChatInput("Please analyze this file and help me with the useful parts.\n\nFile: "+title+(link?"\nSource: "+link:"")+"\n\n--- FILE CONTENT ---\n"+String(data.content||"").slice(0,120000)+"\n--- END FILE CONTENT ---\n\n");
      toast("Selected file loaded into the composer. Review it, then press Send when ready.");
    }catch(error){toast(error.message||"Could not read the selected file.");}
  }
  function renderPanel(){
    if(pageBody&&activePanel){
      if(activePanel==="projects") pageBody.innerHTML=renderProjects();
      else if(activePanel==="artifacts") pageBody.innerHTML=renderArtifacts();
      else if(activePanel==="scheduled") pageBody.innerHTML=renderSchedules();
      else if(activePanel==="customize") pageBody.innerHTML=renderCustomize();
      if(window.eloraTintIcons) window.eloraTintIcons(pageBody);
    }
    renderCounts();
  }
  function addArtifact(title,content,kind,sourceId){
    var normalized=String(content||"").trim(); if(!normalized) return;
    var duplicate=state.artifacts.find(function(a){return a.kind===kind&&a.sourceId===sourceId;});
    if(duplicate){toast("That reply is already saved in Artifacts.");return;}
    var now=Date.now();
    state.artifacts.unshift({id:uid(),title:String(title||"Saved note").slice(0,100),content:normalized.slice(0,12000),kind:kind||"Note",sourceId:sourceId||null,createdAt:now,updatedAt:now});
    state.artifacts=state.artifacts.slice(0,200); scheduleSave();
    if(activePanel==="artifacts") renderPanel();
    toast("Saved to Artifacts.");
  }
  function addSaveButtons(root){
    (root||document).querySelectorAll(".ec-msg.is-ai .ec-actions").forEach(function(actions){
      if(actions.querySelector("[data-workspace-save-message]")) return;
      var btn=document.createElement("button"); btn.type="button"; btn.dataset.workspaceSaveMessage="1"; btn.title="Save to Artifacts"; btn.setAttribute("aria-label","Save to Artifacts"); btn.innerHTML='<svg class="ec-i" aria-hidden="true"><use href="#i-bookmark"/></svg>'; actions.appendChild(btn);
    });
  }
  function setChatInput(value){
    if(!chatInput) return;
    chatInput.value=value; chatInput.dispatchEvent(new Event("input",{bubbles:true})); chatInput.focus();
    closePanel(); closeMenus();
  }
  function updateResearchLabels(){
    var enabled=app&&app.getPreferences?app.getPreferences().webSearch!==false:true;
    ["researchMenuState","researchAttachState"].forEach(function(id){var el=document.getElementById(id);if(el)el.textContent=enabled?"On":"Off";});
  }
  function toggleResearch(){ if(app&&app.toggleResearch){var enabled=app.toggleResearch();updateResearchLabels();toast(enabled?"Research mode is on for relevant current questions.":"Research mode is off.");} }
  function renderScheduleFields(){
    var kind=document.getElementById("scheduleKind"); if(!kind)return;
    var reminder=document.getElementById("reminderFields"), task=document.getElementById("offlineTaskFields");
    if(reminder) reminder.hidden=kind.value!=="reminder";
    if(task) task.hidden=kind.value!=="daily_task";
  }
  function safeOpenConnector(provider){
    if(!accessToken()){toast("Sign in to connect an external service.");return;}
    api("/api/connectors/"+encodeURIComponent(provider)+"/start",{method:"POST"}).then(function(res){return res.json().then(function(data){return {res:res,data:data};});}).then(function(x){
      if(!x.res.ok||!x.data.url){toast(x.data.message||"This provider is not configured yet.");return;}
      window.location.assign(x.data.url);
    }).catch(function(){toast("Couldn't start the secure connection. Try again later.");});
  }
  function localReminderTick(){
    var now=Date.now(), changed=false;
    state.schedules.forEach(function(s){
      if(s.kind!=="reminder"||s.enabled===false||s.firedAt||!s.dueAt||Number(s.dueAt)>now)return;
      s.firedAt=now; s.updatedAt=now; changed=true;
      var message=s.note?String(s.note).slice(0,150):"Your scheduled reminder is due.";
      if("Notification" in window && Notification.permission==="granted"){
        try{new Notification(s.title||"EloraHub reminder",{body:message,tag:s.id});}catch(_e){toast((s.title||"Reminder")+": "+message);}
      }else toast((s.title||"Reminder")+": "+message);
    });
    if(changed){scheduleSave(); if(activePanel==="scheduled")renderPanel();}
  }
  function askNotificationPermission(){
    if(!("Notification" in window)){toast("This browser does not support notifications; reminders will appear in EloraHub while the tab is open.");return;}
    Notification.requestPermission().then(function(value){toast(value==="granted"?"Browser notifications enabled.":"Notifications not enabled. Reminders will appear in the open tab.");});
  }
  function handlePanelSubmit(e){
    e.preventDefault(); var form=e.target, data=new FormData(form), now=Date.now();
    if(form.id==="feedbackForm"){
      var text=String(data.get("text")||"").trim(); if(!text)return;
      var who=currentUser(); var body=text+"\n\n— sent from elorahub"+(who&&who.email?" by "+who.email:"");
      window.location.href="mailto:elorahubonline@gmail.com?subject="+encodeURIComponent("elorahub feedback")+"&body="+encodeURIComponent(body);
      closeSheet(); toast("Thanks! Your email app should open with your feedback."); return;
    }
    if(form.id==="projectForm"){
      var name=String(data.get("name")||"").trim(); if(!name)return;
      state.projects.unshift({id:uid(),name:name,description:String(data.get("description")||"").trim(),pinned:false,createdAt:now,updatedAt:now});
      scheduleSave(); closeSheet(); renderPanel(); toast("Project created.");
    }else if(form.id==="noteForm"){
      addArtifact(String(data.get("title")||"Untitled note"),String(data.get("content")||""),"Note",null);
      closeSheet(); renderPanel();
    }else if(form.id==="skillForm"){
      var title=String(data.get("title")||"").trim(), prompt=String(data.get("prompt")||"").trim(); if(!title||!prompt)return;
      state.skills.unshift({id:uid(),title:title,prompt:prompt,createdAt:now,updatedAt:now}); state.skills=state.skills.slice(0,100); ui.custScope="yours"; scheduleSave(); closeSheet(); renderPanel(); toast("Skill saved.");
    }else if(form.id==="googleSearchForm"){
      googleDriveSearch(String(data.get("q")||""));
    }else if(form.id==="githubSearchForm"){
      githubRepoSearch(String(data.get("q")||""));
    }else if(form.id==="scheduleForm"){
      var kind=String(data.get("kind")||"reminder"), title2=String(data.get("title")||"").trim(); if(!title2)return;
      if(kind==="reminder"){
        var due=new Date(String(data.get("dueAt")||"")).getTime();
        if(!Number.isFinite(due)||due<=now){toast("Choose a future reminder time.");return;}
        state.schedules.unshift({id:uid(),kind:"reminder",title:title2,note:String(data.get("note")||"").trim(),dueAt:due,enabled:true,createdAt:now,updatedAt:now,firedAt:null});
        scheduleSave(); closeSheet(); renderPanel(); toast("Reminder added. Keep this tab open to receive it."); return;
      }
      if(!currentUser()||!accessToken()){toast("Sign in with a synced account to create a task that runs while the site is closed.");return;}
      if(!syncAvailable){
        pushRemote().then(function(ok){ if(!ok){toast("Account storage is not ready yet. Your project owner must finish the workspace database setup before offline tasks can run.");return;} createServerTask(data,title2,now); });
        return;
      }
      createServerTask(data,title2,now);
    }
  }
  function createServerTask(data,title,now){
    var prompt=String(data.get("prompt")||"").trim(); if(!prompt){toast("Add a prompt for the daily AI task.");return;}
    var cadence=String(data.get("cadence")||"daily");
    var nextRun=new Date(); nextRun.setUTCHours(0,0,0,0);
    if(cadence==="weekly") nextRun.setUTCDate(nextRun.getUTCDate()+7);
    else{if(nextRun.getTime()<=now)nextRun.setUTCDate(nextRun.getUTCDate()+1);if(cadence==="weekdays")while(nextRun.getUTCDay()===0||nextRun.getUTCDay()===6)nextRun.setUTCDate(nextRun.getUTCDate()+1);}
    var id=uid();
    state.schedules.unshift({id:id,kind:"daily_task",title:title,prompt:prompt,cadence:cadence,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC",nextRunAt:nextRun.getTime(),enabled:true,createdAt:now,updatedAt:now,lastRunAt:null});
    scheduleSave(); pushRemote().then(function(ok){if(!ok){state.schedules=state.schedules.filter(function(s){return s.id!==id;});scheduleSave();toast("Couldn't sync this offline task, so it wasn't added.");return;}closeSheet();renderPanel();toast("Task saved. elora runs it around "+serverRunLabel()+" your time.");});
  }
  function handlePanelClick(e){
    var ew=e.target.closest("[data-ew]");
    if(ew){
      var k=ew.dataset.ew, v=ew.dataset.v;
      if(k==="close-sheet") closeSheet();
      else if(k==="art-tab"){ui.artTab=v;renderPanel();}
      else if(k==="art-view"){ui.artView=ui.artView==="list"?"grid":"list";renderPanel();}
      else if(k==="art-search"){ui.artSearch=!ui.artSearch;if(!ui.artSearch)ui.artQuery="";renderPanel();var si=document.getElementById("ewArtSearch");if(si)si.focus();}
      else if(k==="make") startMake(v);
      else if(k==="art-open"){var it=state.artifacts.find(function(x){return x.id===ew.dataset.id;});if(it)openViewer(it);}
      else if(k==="viewer-preview"){var it2=state.artifacts.find(function(x){return sheetEl&&x.id===sheetEl.dataset.artifactId;});if(it2)showViewerPreview(it2);}
      else if(k==="new-task") openScheduleSheet(null);
      else if(k==="tpl") openScheduleSheet(TEMPLATES.find(function(t){return t.id===v;})||null);
      else if(k==="cust-tab"){ui.custTab=v;if(v==="connectors")loadConnectorStatus().then(function(){if(activePanel==="customize"&&ui.custTab==="connectors")renderPanel();});renderPanel();}
      else if(k==="cust-scope"){ui.custScope=v;renderPanel();}
      else if(k==="skill-try"){var sk=SKILL_CATALOG.concat(BUILDERS,state.skills).find(function(x){return x.id===ew.dataset.id;});if(sk){var isBig=!!sk.big||BUILDERS.some(function(b){return b.id===sk.from;});if(app&&app.startNewChat)app.startNewChat();if(isBig&&app&&app.setTaskMode)app.setTaskMode(true);setChatInput(sk.prompt);selectFirstBlank();}}
      else if(k==="skill-add"){var cat=SKILL_CATALOG.concat(BUILDERS).find(function(x){return x.id===ew.dataset.id;});if(cat&&!state.skills.some(function(x){return x.from===cat.id;})){var t0=Date.now();state.skills.unshift({id:uid(),title:cat.title,prompt:cat.prompt,from:cat.id,createdAt:t0,updatedAt:t0});scheduleSave();renderPanel();toast("Added “"+cat.title+"” to your skills.");}}
      else if(k==="style"){if(app&&app.setPreference)app.setPreference(ew.dataset.k,v);renderPanel();}
      else if(k==="edit-instructions"){if(app&&app.openSettings)app.openSettings("account");setTimeout(function(){var ta=document.getElementById("settingsInstructions");if(ta)ta.focus();},80);}
      else if(k==="open-conv"){if(app&&app.openConversation){closePage();app.openConversation(Number(ew.dataset.id));}}
      else if(k==="install-app"){if(installPrompt){installPrompt.prompt();installPrompt.userChoice.then(function(){installPrompt=null;closeSheet();});}}
      return;
    }
    var close=e.target.closest("[data-workspace-close]"); if(close){closePanel();return;}
    var action=e.target.closest("[data-action]");
    if(action){
      var a=action.dataset.action;
      if(a==="show-project-form") openFormSheet("project");
      else if(a==="show-note-form") openFormSheet("note");
      else if(a==="show-skill-form") openFormSheet("skill");
      else if(a.indexOf("cancel-")===0) closeSheet();
      else if(a==="notifications") askNotificationPermission();
      else if(a==="refresh-connectors"){loadConnectorStatus().then(renderPanel);}
      return;
    }
    var project=e.target.closest("[data-project-action]");
    if(project){
      var id=project.dataset.id, obj=state.projects.find(function(p){return p.id===id;}); if(!obj)return;
      var pa=project.dataset.projectAction;
      if(pa==="pin"){obj.pinned=!obj.pinned;obj.updatedAt=Date.now();scheduleSave();renderPanel();}
      else if(pa==="rename"){var title=window.prompt("Project name",obj.name);if(title&&title.trim()){obj.name=title.trim().slice(0,70);obj.updatedAt=Date.now();scheduleSave();renderPanel();}}
      else if(pa==="delete"){
        if(!window.confirm("Delete this project? Its conversations remain in Recent."))return;
        state.projects=state.projects.filter(function(p){return p.id!==id;});
        state.sessions.forEach(function(s){if(s.projectId===id)delete s.projectId;});
        if(app&&app.assignActiveProject)app.assignActiveProject(null);
        scheduleSave();renderPanel();toast("Project deleted; conversations remain in Recent.");
      }else if(pa==="open"){
        if(app&&app.startNewChat)app.startNewChat(); if(app&&app.assignActiveProject)app.assignActiveProject(id); closePanel(); toast("New chat opened in “"+obj.name+"”.");
      }else if(pa==="current"){
        if(app&&app.assignActiveProject){if(!app.getActiveConversationId()){app.startNewChat();}app.assignActiveProject(id);toast("Current chat added to “"+obj.name+"”.");}
      }
      return;
    }
    var artifact=e.target.closest("[data-artifact-action]");
    if(artifact){
      var aid=artifact.dataset.id, item=state.artifacts.find(function(x){return x.id===aid;}); if(!item)return;
      var aa=artifact.dataset.artifactAction;
      if(aa==="delete"){state.artifacts=state.artifacts.filter(function(x){return x.id!==aid;});scheduleSave();closeSheet();renderPanel();toast("Deleted.");}
      else if(aa==="copy"){copyText(item.content).then(function(){toast("Copied.");});}
      else if(aa==="download"){downloadText((item.title||"artifact").replace(/[^\w.-]+/g,"-")+".md","# "+item.title+"\n\n"+item.content);}
      return;
    }
    var schedule=e.target.closest("[data-schedule-action]");
    if(schedule){var sid=schedule.dataset.id,s=state.schedules.find(function(x){return x.id===sid;});if(!s)return;if(schedule.dataset.scheduleAction==="toggle"){s.enabled=s.enabled===false;s.updatedAt=Date.now();scheduleSave();renderPanel();}else if(schedule.dataset.scheduleAction==="delete"){state.schedules=state.schedules.filter(function(x){return x.id!==sid;});scheduleSave();renderPanel();}return;}
    var skill=e.target.closest("[data-skill-action]");
    if(skill){var sid2=skill.dataset.id, item2=BUILTIN_PROMPTS.concat(state.skills).find(function(x){return x.id===sid2;});if(!item2)return;if(skill.dataset.skillAction==="use")setChatInput(item2.prompt);else if(skill.dataset.skillAction==="delete"){state.skills=state.skills.filter(function(x){return x.id!==sid2;});scheduleSave();renderPanel();}return;}
    var connector=e.target.closest("[data-connector-action]");
    if(connector){
      var actionName=connector.dataset.connectorAction;
      if(actionName==="signin"){if(app&&app.openSignIn)app.openSignIn();}
      else if(actionName==="connect")safeOpenConnector(connector.dataset.provider);
      else if(actionName==="disconnect"){api("/api/connectors/"+encodeURIComponent(connector.dataset.provider)+"/disconnect",{method:"POST"}).then(function(){return loadConnectorStatus();}).then(function(){renderPanel();toast("EloraHub's connection has been removed.");}).catch(function(){toast("Couldn't disconnect this service.");});}
      else if(actionName==="google-read")readConnectorFile("google",connector.dataset);
      else if(actionName==="github-browse")githubBrowse(connector.dataset.owner,connector.dataset.repo,connector.dataset.path||"",connector.dataset.ref||"main");
      else if(actionName==="github-read")readConnectorFile("github",connector.dataset);
      return;
    }
    var pin=e.target.closest("[data-project-open]"); if(pin){var proj=state.projects.find(function(p){return p.id===pin.dataset.projectOpen;});if(proj){if(app&&app.startNewChat)app.startNewChat();if(app&&app.assignActiveProject)app.assignActiveProject(proj.id);toast("New chat opened in “"+proj.name+"”.");}return;}
  }
  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);
    return new Promise(function(resolve,reject){var t=document.createElement("textarea");t.value=text;t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();try{document.execCommand("copy");resolve();}catch(e){reject(e);}t.remove();});
  }
  function downloadText(name,text){var blob=new Blob([text],{type:"text/markdown;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  function handleAccountAction(e){
    var pageBtn=e.target.closest("[data-account-page]");
    if(pageBtn){closeMenus();if(app&&app.showPage)app.showPage(pageBtn.dataset.accountPage);return;}
    var btn=e.target.closest("[data-account-action]"); if(!btn)return;
    var action=btn.dataset.accountAction;
    if(action==="learn"){var sub=document.getElementById("learnMenu");if(sub){var open=sub.hidden;sub.hidden=!open;btn.setAttribute("aria-expanded",String(open));}return;}
    closeMenus();
    if(action==="settings"){if(app&&app.openSettings)app.openSettings("general");}
    else if(action==="language"){if(app&&app.openSettings){app.openSettings("general");setTimeout(function(){var field=document.getElementById("responseLanguageSelect");if(field)field.focus();},60);}}
    else if(action==="usage"){if(app&&app.openSettings)app.openSettings("usage");}
    else if(action==="connectors")openPanel("connectors");
    else if(action==="help"){if(app&&app.showPage)app.showPage("help");}
    else if(action==="feedback")openFeedback();
    else if(action==="apps")openAppsSheet();
    else if(action==="changelog"){if(app&&app.showPage)app.showPage("changelog");}
    else if(action==="upgrade"){if(window.EloraPlans)window.EloraPlans.open();else if(app&&app.showPage)app.showPage("pricing");}
    else if(action==="signout"){var old=document.getElementById("signOutBtn");if(old)old.click();}
  }
  function openFeedback(){
    openSheet('<h2>Give feedback</h2><p>Tell us what works, what\'s broken, or what you wish elora could do. We read every message.</p><form class="ew-form" id="feedbackForm"><label>Your feedback<textarea name="text" maxlength="2000" required placeholder="What happened, and what did you expect?" style="min-height:150px"></textarea></label><div class="ew-form-acts"><button class="ew-btn" type="button" data-ew="close-sheet">Cancel</button><button class="ew-btn ew-btn-main" type="submit">Send by email</button></div></form>');
    var t=sheetEl.querySelector("textarea"); if(t) t.focus();
  }
  var installPrompt=null;
  window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();installPrompt=e;});
  function openAppsSheet(){
    var standalone=window.matchMedia&&matchMedia("(display-mode: standalone)").matches;
    var ua=navigator.userAgent||"", ios=/iphone|ipad|ipod/i.test(ua), android=/android/i.test(ua);
    var steps=ios?'<li>Open elorahub.online in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button.</li><li>Choose <strong>Add to Home Screen</strong>.</li>':android?'<li>Open elorahub.online in <strong>Chrome</strong>.</li><li>Tap the <strong>⋮</strong> menu.</li><li>Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li>':'<li>In <strong>Chrome</strong> or <strong>Edge</strong>, open the browser menu <strong>⋮</strong>.</li><li>Choose <strong>Cast, save and share → Install page as app</strong> (or <strong>Apps → Install elorahub</strong>).</li><li>elorahub opens in its own window, with an icon in your taskbar or dock.</li>';
    openSheet('<h2>Get the elorahub app</h2><p>'+(standalone?"You're already using elorahub as an app.":"Install elorahub so it opens in its own window, right from your home screen or taskbar.")+'</p>'+(installPrompt&&!standalone?'<div class="ew-bar"><button class="ew-btn ew-btn-main" type="button" data-ew="install-app">'+ic("download")+'Install elorahub</button></div>':'')+'<div class="ew-note"><strong>'+(ios?"iPhone and iPad":android?"Android":"Computer")+'</strong><ol style="margin:8px 0 0;padding-left:18px;display:grid;gap:4px">'+steps+'</ol></div><p style="margin-top:14px;color:var(--ec-text-3);font-size:12.5px">On another device? Open <strong>elorahub.online</strong> there and use Get apps from the account menu.</p>');
  }
  function startDictation(){
    var Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Speech){toast("Voice dictation is not supported in this browser. You can still type your message.");return;}
    var recognition=new Speech(); recognition.lang=(function(){try{return JSON.parse(localStorage.getItem("elorahub_chat_preferences")||"{}").dictationLang||"";}catch(e){return "";}})()||navigator.language||"en-US"; recognition.interimResults=true; recognition.continuous=false;
    var prefix=chatInput.value+(chatInput.value.trim()?" ":"");
    recognition.onresult=function(event){var phrase=Array.from(event.results).map(function(r){return r[0].transcript;}).join("");chatInput.value=prefix+phrase;chatInput.dispatchEvent(new Event("input",{bubbles:true}));};
    recognition.onerror=function(){toast("Microphone input stopped. Check browser permission and try again.");};
    recognition.onend=function(){chatInput.focus();};
    try{recognition.start();toast("Listening… speak your message.");}catch(_e){toast("Couldn't start dictation. Check microphone permission.");}
  }
  function initEvents(){
    document.querySelectorAll("[data-workspace-view]").forEach(function(btn){btn.addEventListener("click",function(){var view=btn.dataset.workspaceView;closeMenus();openPanel(view);if(view==="connectors")loadConnectorStatus().then(renderPanel);});});
    document.querySelectorAll("[data-workspace-action='research']").forEach(function(btn){btn.addEventListener("click",toggleResearch);});
    if(accountTrigger)accountTrigger.addEventListener("click",function(){openMenu(accountMenu,accountTrigger);});
    if(moreTrigger)moreTrigger.addEventListener("click",function(){openMenu(moreMenu,moreTrigger);});
    if(attachTrigger)attachTrigger.addEventListener("click",function(e){e.preventDefault();openMenu(attachMenu,attachTrigger);});
    if(accountMenu)accountMenu.addEventListener("click",handleAccountAction);
    var authAction=document.getElementById("accountAuthAction"); if(authAction)authAction.addEventListener("click",function(){closeMenus();if(app&&app.openSignIn)app.openSignIn();});
    if(panel)panel.addEventListener("click",function(e){if(e.target.closest("[data-workspace-close]"))closePanel();});
    document.addEventListener("click",function(e){if(!e.target.closest(".ec-account-wrap"))closeOne(accountMenu,accountTrigger);if(!e.target.closest(".ec-more"))closeOne(moreMenu,moreTrigger);if(!e.target.closest(".ec-plus-wrap"))closeOne(attachMenu,attachTrigger);});
    document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeMenus();closeSheet();}});
    if(fileInput)fileInput.addEventListener("click",function(){closeMenus();});
    document.querySelectorAll("[data-attach-action]").forEach(function(btn){btn.addEventListener("click",function(){var a=btn.dataset.attachAction;closeMenus();if(a==="files"&&fileInput)fileInput.click();else if(a==="folder"&&folderInput)folderInput.click();else if(a==="dictate")startDictation();else if(a==="research")toggleResearch();});});
    if(folderInput)folderInput.addEventListener("change",function(){
      if(!folderInput.files||!folderInput.files.length)return;
      try{var transfer=new DataTransfer();Array.from(folderInput.files).forEach(function(f){transfer.items.add(f);});fileInput.files=transfer.files;fileInput.dispatchEvent(new Event("change",{bubbles:true}));}catch(_e){toast("Folder upload isn't available in this browser. Choose files instead.");}
      folderInput.value="";
    });
    if(pageBody){
      pageBody.addEventListener("click",handlePanelClick);pageBody.addEventListener("submit",handlePanelSubmit);
      pageBody.addEventListener("input",function(e){var id=e.target.id;if(id==="ewProjSearch"){ui.projQuery=e.target.value;rerenderKeepFocus(id);}else if(id==="ewArtSearch"){ui.artQuery=e.target.value;rerenderKeepFocus(id);}else if(id==="ewCustSearch"){ui.custQuery=e.target.value;rerenderKeepFocus(id);}});
      pageBody.addEventListener("keydown",function(e){if((e.key==="Enter"||e.key===" ")&&e.target.matches&&e.target.matches(".ew-row-main")){e.preventDefault();e.target.click();}});
    }
    document.addEventListener("click",function(e){
      if(e.target.closest("#newChatBtn")){var wasOpen=pageEl&&!pageEl.hidden;closePage();if(wasOpen&&window.EloraNav)window.EloraNav.record({page:"chat",conv:"new"});return;}
      if(e.target.closest("#chatHistoryList button,#chatHistoryList [role=listitem]"))closePage();
    });
    var thread=document.getElementById("chatThread");
    if(thread){
      thread.addEventListener("click",function(e){var btn=e.target.closest("[data-workspace-save-message]");if(!btn)return;var msg=btn.closest(".ec-msg.is-ai"),bubble=msg&&msg.querySelector(".ec-msg-text");if(!bubble)return;var title=app&&app.getActiveConversationTitle?app.getActiveConversationTitle():"Elora response";var id=app&&app.getActiveConversationId?app.getActiveConversationId():null;addArtifact(title,bubble.innerText,"Elora response",id?String(id)+":"+bubble.innerText.slice(0,80):null);btn.textContent="Saved";btn.disabled=true;});
      new MutationObserver(function(){addSaveButtons(thread);}).observe(thread,{childList:true,subtree:true}); addSaveButtons(thread);
    }
    window.addEventListener("elorahub:auth-state",function(){onAuthChange();});
    window.addEventListener("elorahub:conversation-updated",function(){
      if(app&&app.getSessions){state.sessions=app.getSessions();writeJson(storageKey("chats",identity),state.sessions);}
      if(activePanel==="projects"&&pageEl&&!pageEl.hidden)renderPanel();
    });
    document.querySelectorAll("[data-theme-mode]").forEach(function(btn){btn.addEventListener("click",function(){if(app&&app.setThemeMode)app.setThemeMode(btn.dataset.themeMode);document.querySelectorAll("[data-theme-mode]").forEach(function(b){b.classList.toggle("is-active",b===btn);});});});
    updateResearchLabels();
    reminderTimer=setInterval(localReminderTick,20000); document.addEventListener("visibilitychange",function(){if(!document.hidden)localReminderTick();});
  }
  // Keep every pop-up menu fully reachable: if it doesn't fit above (or
  // below) its button inside the visible area, open it on the roomier side
  // and let it scroll.
  function clipBox(el){
    var top=0,bottom=window.innerHeight,node=el.parentElement;
    while(node&&node!==document.body){
      var cs=getComputedStyle(node);
      if(/(hidden|auto|scroll|clip)/.test(cs.overflowY+cs.overflow)){var r=node.getBoundingClientRect();top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}
      node=node.parentElement;
    }
    return {top:top,bottom:bottom};
  }
  function fitPop(menu){
    if(!menu||menu.hidden||menu.classList.contains("ec-pop-sub")) return;
    menu.classList.remove("ec-pop-flip-down","ec-pop-flip-up","is-scrolling"); menu.style.maxHeight=""; menu.style.top=""; menu.style.bottom="";
    var wrap=(menu.parentElement||menu), anchor=wrap.getBoundingClientRect(), box=clipBox(menu), pad=10;
    var h=menu.scrollHeight+2, above=anchor.top-box.top-pad-6, below=box.bottom-anchor.bottom-pad-6;
    var opensUp=menu.classList.contains("ec-pop-up")||menu.classList.contains("ec-pop-account");
    var room=opensUp?above:below, other=opensUp?below:above;
    if(h<=room) return;
    if(h<=other){menu.classList.add(opensUp?"ec-pop-flip-down":"ec-pop-flip-up");return;}
    // Neither side has room: slide it so the whole menu is on screen (it may
    // cover its own button), scrolling only if the screen is very short.
    var space=box.bottom-box.top-2*pad;
    if(h>space){menu.style.maxHeight=Math.floor(space)+"px";menu.classList.add("is-scrolling");h=space;}
    var wanted=opensUp?anchor.top-6-h:anchor.bottom+6;
    var top=Math.min(Math.max(wanted,box.top+pad),box.bottom-pad-h);
    menu.style.top=Math.round(top-anchor.top)+"px"; menu.style.bottom="auto";
  }
  window.eloraFitPop=fitPop;
  (function watchPops(){
    var obs=new MutationObserver(function(list){list.forEach(function(m){if(m.target.classList&&m.target.classList.contains("ec-pop")&&!m.target.hidden)fitPop(m.target);});});
    document.querySelectorAll(".ec-pop").forEach(function(menu){obs.observe(menu,{attributes:true,attributeFilter:["hidden"]});});
    window.addEventListener("resize",function(){document.querySelectorAll(".ec-pop").forEach(function(menu){if(!menu.hidden)fitPop(menu);});});
  })();
  function closeOne(menu,trigger){if(menu)menu.hidden=true;if(trigger)trigger.setAttribute("aria-expanded","false");}
  // Read-only counts for Settings → Usage.
  function tryBuilder(id){
    var b=BUILDERS.filter(function(x){return x.id===id;})[0]; if(!b) return false;
    closePage();
    if(app&&app.startNewChat) app.startNewChat();
    if(app&&app.setTaskMode) app.setTaskMode(true);
    setChatInput(b.prompt); selectFirstBlank();
    return true;
  }
  window.EloraWorkspace={openPage:openPanel,closePage:function(){closePage();},tryBuilder:tryBuilder,saveArtifact:function(title,content,kind){addArtifact(title,content,kind||"File",null);},counts:function(){return {projects:state.projects.length,artifacts:state.artifacts.length,skills:state.skills.length,builtIn:BUILTIN_PROMPTS.length,schedules:state.schedules.filter(function(x){return x.enabled!==false;}).length};}};
  function renderAll(){renderAccount();renderCounts();updateResearchLabels();if(activePanel&&panel&&!panel.hidden)renderPanel();}
  function init(){
    initEvents();
    loadIdentity();
    renderScheduleFields();
    var connectorResult=new URLSearchParams(window.location.search).get("connector");
    if(connectorResult){history.replaceState({},"",window.location.pathname+window.location.hash);toast(connectorResult.indexOf("connected")>=0?"Connector connected. Review its status in Connectors.":"Connector connection did not complete.");if(connectorResult.indexOf("connected")>=0){openPanel("connectors");loadConnectorStatus().then(renderPanel);}}
    window.addEventListener("pageshow",function(){onAuthChange();});
  }
  init();
})();
