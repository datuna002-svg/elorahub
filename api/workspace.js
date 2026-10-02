import { verifyRequester, getSupabaseClient } from "./_lib/supabaseAdmin.js";

const EMPTY = { schema: 1, projects: [], artifacts: [], schedules: [], skills: [] };
const ID_RE = /^[a-zA-Z0-9._:-]{1,100}$/;
const MAX_BODY_BYTES = 1_500_000;

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store, private");
  return res.status(status).json(body);
}
function text(value, max, fallback = "") {
  return String(value == null ? fallback : value).trim().slice(0, max);
}
function id(value) {
  const s = text(value, 100);
  return ID_RE.test(s) ? s : null;
}
function timestamp(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, Date.now() + 366 * 86400000) : fallback;
}
function sanitizeArray(raw, mapper, max) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).map(mapper).filter(Boolean);
}
function sanitizeWorkspace(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const now = Date.now();
  const projects = sanitizeArray(data.projects, (p) => {
    const projectId = id(p?.id);
    const name = text(p?.name, 80);
    if (!projectId || !name) return null;
    return { id: projectId, name, description: text(p.description, 500), pinned: p.pinned === true, createdAt: timestamp(p.createdAt, now), updatedAt: timestamp(p.updatedAt, now) };
  }, 100);
  const artifacts = sanitizeArray(data.artifacts, (a) => {
    const artifactId = id(a?.id);
    const title = text(a?.title, 120);
    const content = text(a?.content, 16000);
    if (!artifactId || !title || !content) return null;
    return { id: artifactId, title, content, kind: text(a.kind, 50, "Note"), sourceId: text(a.sourceId, 180) || null, createdAt: timestamp(a.createdAt, now), updatedAt: timestamp(a.updatedAt, now) };
  }, 100);
  const schedules = sanitizeArray(data.schedules, (s) => {
    const scheduleId = id(s?.id);
    const title = text(s?.title, 100);
    const kind = s?.kind === "daily_task" ? "daily_task" : s?.kind === "reminder" ? "reminder" : null;
    if (!scheduleId || !title || !kind) return null;
    if (kind === "daily_task") {
      const prompt = text(s.prompt, 3000);
      if (!prompt) return null;
      return { id: scheduleId, kind, title, prompt, cadence: ["daily", "weekdays", "weekly"].includes(s.cadence) ? s.cadence : "daily", timezone: text(s.timezone, 80, "UTC"), nextRunAt: timestamp(s.nextRunAt, now + 86400000), enabled: s.enabled !== false, createdAt: timestamp(s.createdAt, now), updatedAt: timestamp(s.updatedAt, now) };
    }
    return { id: scheduleId, kind, title, note: text(s.note, 500), dueAt: timestamp(s.dueAt), firedAt: s.firedAt ? timestamp(s.firedAt) : null, enabled: s.enabled !== false, createdAt: timestamp(s.createdAt, now), updatedAt: timestamp(s.updatedAt, now) };
  }, 100);
  const skills = sanitizeArray(data.skills, (s) => {
    const skillId = id(s?.id);
    const title = text(s?.title, 80);
    const prompt = text(s?.prompt, 2500);
    if (!skillId || !title || !prompt) return null;
    return { id: skillId, title, prompt, createdAt: timestamp(s.createdAt, now), updatedAt: timestamp(s.updatedAt, now) };
  }, 100);
  return { schema: 1, projects, artifacts, schedules, skills };
}
function isMissingSchema(error) {
  return ["42P01", "PGRST205", "PGRST204"].includes(error?.code) || /relation .* does not exist|could not find the table/i.test(error?.message || "");
}
function nextUtcRun(value) {
  const d = new Date(value || Date.now() + 86400000);
  if (!Number.isFinite(d.getTime())) return new Date(Date.now() + 86400000).toISOString();
  return d.toISOString();
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "PUT") return send(res, 405, { error: "method_not_allowed" });

  const { email, userId } = await verifyRequester(req);
  if (!email || !userId) return send(res, 401, { error: "authentication_required" });
  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "workspace_storage_unavailable", message: "Workspace storage is not configured yet." });

  if (req.method === "GET") {
    const [workspaceResult, tasksResult, runsResult] = await Promise.all([
      supabase.from("user_workspaces").select("workspace,updated_at").eq("user_id", userId).maybeSingle(),
      supabase.from("scheduled_tasks").select("id,title,prompt,cadence,timezone,next_run_at,enabled,last_run_at,last_status,created_at,updated_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
      supabase.from("scheduled_task_runs").select("run_id,task_id,title,result,error,status,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(60),
    ]);
    const error = workspaceResult.error || tasksResult.error || runsResult.error;
    if (error) return send(res, isMissingSchema(error) ? 503 : 500, { error: isMissingSchema(error) ? "workspace_schema_missing" : "workspace_read_failed", message: isMissingSchema(error) ? "Run supabase-schema-workspace.sql to enable account sync." : "Couldn't load workspace data." });

    const workspace = { ...EMPTY, ...(workspaceResult.data?.workspace || {}) };
    const reminders = Array.isArray(workspace.schedules) ? workspace.schedules.filter((s) => s?.kind === "reminder") : [];
    const serverSchedules = (tasksResult.data || []).map((s) => ({ id: s.id, kind: "daily_task", title: s.title, prompt: s.prompt, cadence: s.cadence, timezone: s.timezone, nextRunAt: new Date(s.next_run_at).getTime(), enabled: s.enabled, lastRunAt: s.last_run_at ? new Date(s.last_run_at).getTime() : null, lastStatus: s.last_status, createdAt: new Date(s.created_at).getTime(), updatedAt: new Date(s.updated_at).getTime() }));
    workspace.schedules = reminders.concat(serverSchedules);
    const taskRuns = (runsResult.data || []).map((run) => ({ id: run.run_id, taskId: run.task_id, title: run.title, result: run.result, error: run.error, status: run.status, createdAt: new Date(run.created_at).getTime() }));
    return send(res, 200, { workspace, taskRuns, syncedAt: workspaceResult.data?.updated_at || null });
  }

  let body = req.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return send(res, 413, { error: "payload_too_large" });
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: "invalid_json" }); }
  } else if (body && Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    return send(res, 413, { error: "payload_too_large" });
  }
  if (!body || typeof body !== "object" || !body.workspace || typeof body.workspace !== "object" || Array.isArray(body.workspace)) return send(res, 400, { error: "invalid_workspace_payload" });
  const workspace = sanitizeWorkspace(body?.workspace || body);
  const storedWorkspace = { ...workspace, schedules: workspace.schedules.filter((s) => s.kind === "reminder") };

  const { error: saveError } = await supabase.from("user_workspaces").upsert({ user_id: userId, workspace: storedWorkspace, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (saveError) return send(res, isMissingSchema(saveError) ? 503 : 500, { error: isMissingSchema(saveError) ? "workspace_schema_missing" : "workspace_write_failed", message: isMissingSchema(saveError) ? "Run supabase-schema-workspace.sql to enable account sync." : "Couldn't save workspace data." });

  const taskSpecs = workspace.schedules.filter((s) => s.kind === "daily_task");
  const { data: existing, error: readTasksError } = await supabase.from("scheduled_tasks").select("id,next_run_at,last_run_at,last_status,lease_token,lease_until,created_at").eq("user_id", userId);
  if (readTasksError) return send(res, isMissingSchema(readTasksError) ? 503 : 500, { error: "scheduled_task_sync_failed" });
  const existingById = new Map((existing || []).map((row) => [row.id, row]));
  const records = taskSpecs.map((task) => {
    const old = existingById.get(task.id);
    return {
      id: task.id,
      user_id: userId,
      title: task.title,
      prompt: task.prompt,
      cadence: task.cadence,
      timezone: task.timezone,
      next_run_at: old?.next_run_at || nextUtcRun(task.nextRunAt),
      enabled: task.enabled,
      last_run_at: old?.last_run_at || null,
      last_status: old?.last_status || "pending",
      lease_token: old?.lease_token || null,
      lease_until: old?.lease_until || null,
      created_at: old?.created_at || new Date(task.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
    };
  });
  if (records.length) {
    const { error } = await supabase.from("scheduled_tasks").upsert(records, { onConflict: "user_id,id" });
    if (error) return send(res, isMissingSchema(error) ? 503 : 500, { error: "scheduled_task_sync_failed" });
  }
  const keepIds = new Set(taskSpecs.map((s) => s.id));
  const removedIds = (existing || []).map((row) => row.id).filter((taskId) => !keepIds.has(taskId));
  if (removedIds.length) {
    const { error } = await supabase.from("scheduled_tasks").delete().eq("user_id", userId).in("id", removedIds);
    if (error) return send(res, 500, { error: "scheduled_task_delete_failed" });
  }
  return send(res, 200, { ok: true, syncedAt: new Date().toISOString() });
}
