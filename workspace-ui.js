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
  var activePanel = "projects";
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
  }
  function closePanel(){ if(panel){panel.hidden=true;document.body.classList.remove("workspace-panel-open");} if(lastFocus&&lastFocus.focus) lastFocus.focus(); }
  function openPanel(view){
    closeMenus();
    if(view==="customize"){ if(panel) panel.hidden=true; if(app&&app.openSettings) app.openSettings("general"); return; }
    var meta={
      projects:["Projects","Keep related work together, and jump back into its conversations."],
      artifacts:["Artifacts","Keep useful answers, notes, and drafts close at hand."],
      scheduled:["Scheduled","Set a precise in-tab reminder or a daily task that runs on the server."],
      skills:["Prompt library","Reusable starting points for the work you do often."],
      connectors:["Connectors","Read-only connections for the services you chose."],
    }[view]||["Workspace","Your EloraHub workspace"];
    activePanel=view; lastFocus=document.activeElement;
    if(panel){panel.hidden=false;document.body.classList.add("workspace-panel-open");if(window.eloraSwapIn)window.eloraSwapIn(panel.querySelector(".workspace-panel")||panel);}
    if(panelTitle) panelTitle.textContent=meta[0]; if(panelKicker) panelKicker.textContent="ELORAHUB WORKSPACE"; if(panelDescription) panelDescription.textContent=meta[1];
    renderPanel();
    var closeBtn=panel&&panel.querySelector(".workspace-close"); if(closeBtn) closeBtn.focus();
  }
  function emptyPanel(title,copy,mark){ return '<div class="workspace-empty"><div class="workspace-empty-mark" aria-hidden="true">'+escapeHtml(mark||"◇")+'</div><h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(copy)+'</p></div>'; }
  function timeLabel(ts){ if(!ts) return ""; try{return new Date(ts).toLocaleString([], {dateStyle:"medium",timeStyle:"short"});}catch(_e){return "";} }
  function renderProjects(){
    var sessions=app&&app.getSessions?app.getSessions():state.sessions;
    var html='<div class="workspace-toolbar"><p>Projects group related chats and saved work; they are stored locally and sync when account storage is available.</p><button class="workspace-primary" type="button" data-action="show-project-form">＋ New project</button></div>';
    html+='<form class="workspace-form" id="projectForm" hidden><label>Project name<input name="name" maxlength="70" required placeholder="e.g. Website refresh"></label><label>What is this for?<textarea name="description" maxlength="350" placeholder="A short note to keep the work focused"></textarea></label><div><button class="workspace-primary" type="submit">Create project</button> <button class="workspace-secondary" type="button" data-action="cancel-project-form">Cancel</button></div></form>';
    if(!state.projects.length) return html+emptyPanel("Nothing in Projects yet","Create a project to group its chats and keep related work organized.","▦");
    html+='<div class="workspace-card-list" style="margin-top:16px">'+state.projects.map(function(p){
      var count=sessions.filter(function(s){return s.projectId===p.id;}).length;
      return '<article class="workspace-card"><h3>'+escapeHtml(p.name)+'</h3><p>'+escapeHtml(p.description||"No description yet.")+'</p><div class="workspace-card-meta"><span>'+count+' conversation'+(count===1?"":"s")+'</span><span>'+timeLabel(p.updatedAt||p.createdAt)+'</span></div><div class="workspace-card-actions"><button type="button" data-project-action="open" data-id="'+escapeHtml(p.id)+'">Open project chat</button><button type="button" data-project-action="current" data-id="'+escapeHtml(p.id)+'">Add current chat</button><button type="button" data-project-action="pin" data-id="'+escapeHtml(p.id)+'">'+(p.pinned?"Unpin":"Pin")+'</button><button type="button" data-project-action="rename" data-id="'+escapeHtml(p.id)+'">Rename</button><button type="button" data-project-action="delete" data-id="'+escapeHtml(p.id)+'">Delete</button></div></article>';
    }).join("")+'</div>';
    return html;
  }
  function renderArtifacts(){
    var html='<div class="workspace-toolbar"><p>Save an assistant reply from the conversation, or write a note for yourself.</p><button class="workspace-primary" type="button" data-action="show-note-form">＋ New note</button></div>';
    html+='<form class="workspace-form" id="noteForm" hidden><label>Title<input name="title" maxlength="100" required placeholder="A useful note"></label><label>Content<textarea name="content" maxlength="12000" required placeholder="Write or paste your note"></textarea></label><div><button class="workspace-primary" type="submit">Save note</button> <button class="workspace-secondary" type="button" data-action="cancel-note-form">Cancel</button></div></form>';
    if(!state.artifacts.length) return html+emptyPanel("No saved artifacts yet","Use the Save action beneath an Elora response, or create a note of your own.","◇");
    html+='<div class="workspace-card-list" style="margin-top:16px">'+state.artifacts.map(function(a){
      return '<article class="workspace-card"><h3>'+escapeHtml(a.title)+'</h3><p>'+escapeHtml(String(a.content||"").slice(0,240))+(String(a.content||"").length>240?"…":"")+'</p><div class="workspace-card-meta"><span>'+escapeHtml(a.kind||"Note")+'</span><span>'+timeLabel(a.updatedAt||a.createdAt)+'</span></div><div class="workspace-card-actions"><button type="button" data-artifact-action="copy" data-id="'+escapeHtml(a.id)+'">Copy</button><button type="button" data-artifact-action="download" data-id="'+escapeHtml(a.id)+'">Download .md</button><button type="button" data-artifact-action="delete" data-id="'+escapeHtml(a.id)+'">Delete</button></div></article>';
    }).join("")+'</div>';
    return html;
  }
  function localDateTimeValue(date){ var d=new Date(date.getTime()-date.getTimezoneOffset()*60000); return d.toISOString().slice(0,16); }
  function renderSchedules(){
    var canOffline=!!(currentUser()&&accessToken()&&syncAvailable);
    var html='<div class="workspace-toolbar"><p>Reminders ring while this tab is open. Offline AI tasks run once daily in the Vercel UTC window.</p><button class="workspace-secondary" type="button" data-action="notifications">Enable browser notifications</button></div>';
    html+='<form class="workspace-form" id="scheduleForm"><label>What should EloraHub do?<input name="title" maxlength="90" required placeholder="e.g. Review my weekly goals"></label><label>Schedule type<select name="kind" id="scheduleKind"><option value="reminder">In-tab reminder · around your chosen time</option><option value="daily_task" '+(canOffline?"":"disabled")+'>Background AI task · runs while the site is closed</option></select></label>';
    html+='<div id="reminderFields"><label>Remind me at<input name="dueAt" type="datetime-local" value="'+localDateTimeValue(new Date(Date.now()+3600000))+'" required></label><label>Reminder note<textarea name="note" maxlength="500" placeholder="Optional detail to include in the reminder"></textarea></label></div>';
    html+='<div id="offlineTaskFields" hidden><label>Prompt for Elora<textarea name="prompt" maxlength="3000" placeholder="What should Elora prepare each time this task runs?"></textarea></label><label>Repeat<select name="cadence"><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></select></label><div class="workspace-note"><strong>Vercel execution window:</strong> once daily, around 00:00–00:59 UTC on the current setup. The task runs on its selected cadence and only asks Elora to generate and save a result; it will not send messages or edit connected services.</div></div>';
    if(!canOffline) html+='<div class="workspace-note">Sign in with a connected account to create server-backed tasks. In-tab reminders remain available without signing in.</div>';
    html+='<div><button class="workspace-primary" type="submit">Add schedule</button></div></form>';
    if(!state.schedules.length) return html+emptyPanel("Nothing scheduled","Add an in-tab reminder or, when signed in and synced, a background AI task.","◷");
    html+='<div class="workspace-card-list" style="margin-top:18px">'+state.schedules.slice().sort(function(a,b){return Number(a.createdAt)-Number(b.createdAt);}).map(function(s){
      var cadenceLabel=s.cadence==="weekly"?"Weekly":s.cadence==="weekdays"?"Weekdays":"Daily";
      var desc=s.kind==="daily_task"?"Background AI · "+cadenceLabel+" · "+(s.timezone||"UTC"):"In-tab reminder · "+timeLabel(s.dueAt);
      var status=s.enabled===false?"Paused":s.kind==="daily_task"?"Vercel UTC window":"Tab must stay open";
      var runs=state.taskRuns.filter(function(r){return r.taskId===s.id;}).sort(function(a,b){return Number(b.createdAt)-Number(a.createdAt);}).slice(0,3);
      var results=runs.map(function(r){return '<details style="margin-top:10px"><summary style="color:var(--text-2);font-size:.69rem;cursor:pointer">'+(r.status==="failed"?"Run failed · ":"Result · ")+escapeHtml(timeLabel(r.createdAt))+'</summary><pre style="max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--text-2);font:.69rem/1.55 var(--font-body);padding:10px;background:rgba(0,0,0,.18);border-radius:9px">'+escapeHtml(r.result||r.error||"")+'</pre></details>';}).join("");
      return '<article class="workspace-card"><h3>'+escapeHtml(s.title)+'</h3><p>'+escapeHtml(s.kind==="daily_task"?(s.prompt||""): (s.note||"A reminder for you."))+'</p><div class="workspace-card-meta"><span>'+escapeHtml(desc)+'</span><span>'+escapeHtml(status)+'</span></div>'+results+'<div class="workspace-card-actions"><button type="button" data-schedule-action="toggle" data-id="'+escapeHtml(s.id)+'">'+(s.enabled===false?"Resume":"Pause")+'</button><button type="button" data-schedule-action="delete" data-id="'+escapeHtml(s.id)+'">Delete</button></div></article>';
    }).join("")+'</div>';
    return html;
  }
  function renderSkills(){
    var html='<div class="workspace-toolbar"><p>Click a prompt to load it into the composer. Your own prompts stay on this device and sync to your account when available.</p><button class="workspace-primary" type="button" data-action="show-skill-form">＋ Save prompt</button></div>';
    html+='<form class="workspace-form" id="skillForm" hidden><label>Name<input name="title" maxlength="70" required placeholder="e.g. Product brief"></label><label>Prompt<textarea name="prompt" maxlength="2500" required placeholder="Write a reusable instruction"></textarea></label><div><button class="workspace-primary" type="submit">Save prompt</button> <button class="workspace-secondary" type="button" data-action="cancel-skill-form">Cancel</button></div></form>';
    html+='<div class="workspace-section-label" style="padding-left:0;margin-top:18px">START HERE</div><div class="workspace-card-list">'+BUILTIN_PROMPTS.map(function(p){return '<article class="workspace-card"><h3>'+escapeHtml(p.title)+'</h3><p>Built-in EloraHub prompt</p><div class="workspace-card-actions"><button type="button" data-skill-action="use" data-id="'+escapeHtml(p.id)+'">Use prompt</button></div></article>';}).join("")+'</div>';
    if(state.skills.length) html+='<div class="workspace-section-label" style="padding-left:0;margin-top:22px">SAVED BY YOU</div><div class="workspace-card-list">'+state.skills.map(function(s){return '<article class="workspace-card"><h3>'+escapeHtml(s.title)+'</h3><p>'+escapeHtml(String(s.prompt||"").slice(0,180))+'</p><div class="workspace-card-actions"><button type="button" data-skill-action="use" data-id="'+escapeHtml(s.id)+'">Use prompt</button><button type="button" data-skill-action="delete" data-id="'+escapeHtml(s.id)+'">Delete</button></div></article>';}).join("")+'</div>';
    return html;
  }
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
      {key:"google",name:"Google Drive",icon:"G",copy:"Search and read files you choose to use in a chat. Read-only access."},
      {key:"github",name:"GitHub",icon:"GH",copy:"Browse repositories and read files with a read-only installation."}
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
    if(!panelBody) return;
    if(activePanel==="projects") panelBody.innerHTML=renderProjects();
    else if(activePanel==="artifacts") panelBody.innerHTML=renderArtifacts();
    else if(activePanel==="scheduled") panelBody.innerHTML=renderSchedules();
    else if(activePanel==="skills") panelBody.innerHTML=renderSkills();
    else if(activePanel==="connectors") panelBody.innerHTML=renderConnectors();
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
    if(form.id==="projectForm"){
      var name=String(data.get("name")||"").trim(); if(!name)return;
      state.projects.unshift({id:uid(),name:name,description:String(data.get("description")||"").trim(),pinned:false,createdAt:now,updatedAt:now});
      scheduleSave(); renderPanel(); toast("Project created.");
    }else if(form.id==="noteForm"){
      addArtifact(String(data.get("title")||"Untitled note"),String(data.get("content")||""),"Note",null);
      form.reset(); renderPanel();
    }else if(form.id==="skillForm"){
      var title=String(data.get("title")||"").trim(), prompt=String(data.get("prompt")||"").trim(); if(!title||!prompt)return;
      state.skills.unshift({id:uid(),title:title,prompt:prompt,createdAt:now,updatedAt:now}); state.skills=state.skills.slice(0,100); scheduleSave(); renderPanel(); toast("Prompt saved to your library.");
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
        scheduleSave(); renderPanel(); toast("Reminder added. Keep this tab open to receive it."); return;
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
    scheduleSave(); pushRemote().then(function(ok){if(!ok){state.schedules=state.schedules.filter(function(s){return s.id!==id;});scheduleSave();toast("Couldn't sync this offline task, so it wasn't added.");return;}renderPanel();toast("Background AI task saved. It runs on the selected cadence in the site's UTC window.");});
  }
  function handlePanelClick(e){
    var close=e.target.closest("[data-workspace-close]"); if(close){closePanel();return;}
    var action=e.target.closest("[data-action]");
    if(action){
      var a=action.dataset.action;
      if(a==="show-project-form"){var f=document.getElementById("projectForm");if(f){f.hidden=false;f.querySelector("input").focus();}}
      else if(a==="cancel-project-form"){var pf=document.getElementById("projectForm");if(pf)pf.hidden=true;}
      else if(a==="show-note-form"){var nf=document.getElementById("noteForm");if(nf){nf.hidden=false;nf.querySelector("input").focus();}}
      else if(a==="cancel-note-form"){var nf2=document.getElementById("noteForm");if(nf2)nf2.hidden=true;}
      else if(a==="show-skill-form"){var sf=document.getElementById("skillForm");if(sf){sf.hidden=false;sf.querySelector("input").focus();}}
      else if(a==="cancel-skill-form"){var sf2=document.getElementById("skillForm");if(sf2)sf2.hidden=true;}
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
      if(aa==="delete"){state.artifacts=state.artifacts.filter(function(x){return x.id!==aid;});scheduleSave();renderPanel();}
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
    var btn=e.target.closest("[data-account-action]"); if(!btn)return;
    var action=btn.dataset.accountAction; closeMenus();
    if(action==="settings"){if(app&&app.openSettings)app.openSettings("general");}
    else if(action==="language"){if(app&&app.openSettings){app.openSettings("general");setTimeout(function(){var field=document.getElementById("responseLanguageSelect");if(field)field.focus();},0);}}
    else if(action==="usage"){if(app&&app.openSettings)app.openSettings("subscription");}
    else if(action==="connectors")openPanel("connectors");
    else if(action==="help"){if(app&&app.showPage)app.showPage("guidelines");}
    else if(action==="upgrade"){if(window.EloraPlans)window.EloraPlans.open();else if(app&&app.showPage)app.showPage("pricing");}
    else if(action==="signout"){var old=document.getElementById("signOutBtn");if(old)old.click();}
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
    document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeMenus();if(panel&&!panel.hidden)closePanel();}});
    if(fileInput)fileInput.addEventListener("click",function(){closeMenus();});
    document.querySelectorAll("[data-attach-action]").forEach(function(btn){btn.addEventListener("click",function(){var a=btn.dataset.attachAction;closeMenus();if(a==="files"&&fileInput)fileInput.click();else if(a==="folder"&&folderInput)folderInput.click();else if(a==="dictate")startDictation();else if(a==="research")toggleResearch();});});
    if(folderInput)folderInput.addEventListener("change",function(){
      if(!folderInput.files||!folderInput.files.length)return;
      try{var transfer=new DataTransfer();Array.from(folderInput.files).forEach(function(f){transfer.items.add(f);});fileInput.files=transfer.files;fileInput.dispatchEvent(new Event("change",{bubbles:true}));}catch(_e){toast("Folder upload isn't available in this browser. Choose files instead.");}
      folderInput.value="";
    });
    if(panelBody){panelBody.addEventListener("click",handlePanelClick);panelBody.addEventListener("submit",handlePanelSubmit);panelBody.addEventListener("change",function(e){if(e.target.id==="scheduleKind")renderScheduleFields();});}
    var thread=document.getElementById("chatThread");
    if(thread){
      thread.addEventListener("click",function(e){var btn=e.target.closest("[data-workspace-save-message]");if(!btn)return;var msg=btn.closest(".ec-msg.is-ai"),bubble=msg&&msg.querySelector(".ec-msg-text");if(!bubble)return;var title=app&&app.getActiveConversationTitle?app.getActiveConversationTitle():"Elora response";var id=app&&app.getActiveConversationId?app.getActiveConversationId():null;addArtifact(title,bubble.innerText,"Elora response",id?String(id)+":"+bubble.innerText.slice(0,80):null);btn.textContent="Saved";btn.disabled=true;});
      new MutationObserver(function(){addSaveButtons(thread);}).observe(thread,{childList:true,subtree:true}); addSaveButtons(thread);
    }
    window.addEventListener("elorahub:auth-state",function(){onAuthChange();});
    window.addEventListener("elorahub:conversation-updated",function(){
      if(app&&app.getSessions){state.sessions=app.getSessions();writeJson(storageKey("chats",identity),state.sessions);}
      if(activePanel==="projects")renderPanel();
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
    if(!menu||menu.hidden) return;
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
  window.EloraWorkspace={saveArtifact:function(title,content,kind){addArtifact(title,content,kind||"File",null);},counts:function(){return {projects:state.projects.length,artifacts:state.artifacts.length,skills:state.skills.length,builtIn:BUILTIN_PROMPTS.length,schedules:state.schedules.filter(function(x){return x.enabled!==false;}).length};}};
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
