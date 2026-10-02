import { timingSafeEqual, randomUUID } from "node:crypto";
import { getSupabaseClient, logEvent } from "../_lib/supabaseAdmin.js";
import { runScheduledPrompt } from "../chat.js";

function send(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(provided);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}
function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
function nextRun(cadence, now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else {
    d.setUTCDate(d.getUTCDate() + 1);
    if (cadence === "weekdays") while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString();
}
function nextWeekdayMidnight(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
function missingSchema(error) {
  return ["42P01", "PGRST205", "PGRST204"].includes(error?.code) || /relation .* does not exist|could not find the table/i.test(error?.message || "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
  if (!isAuthorized(req)) return send(res, 401, { error: "unauthorized" });

  const supabase = await getSupabaseClient();
  if (!supabase) return send(res, 503, { error: "storage_unavailable" });
  const now = new Date();
  const { data: due, error: dueError } = await supabase
    .from("scheduled_tasks")
    .select("id,user_id,title,prompt,cadence,timezone,next_run_at,enabled,lease_until")
    .eq("enabled", true)
    .lte("next_run_at", now.toISOString())
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .order("next_run_at", { ascending: true })
    .limit(20);
  if (dueError) return send(res, missingSchema(dueError) ? 503 : 500, { error: missingSchema(dueError) ? "workspace_schema_missing" : "task_query_failed" });

  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const outcomes = [];

  for (const candidate of due || []) {
    const lease = randomUUID();
    const leaseUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { data: task, error: claimError } = await supabase
      .from("scheduled_tasks")
      .update({ lease_token: lease, lease_until: leaseUntil, last_status: "running", updated_at: new Date().toISOString() })
      .eq("id", candidate.id)
      .eq("user_id", candidate.user_id)
      .eq("enabled", true)
      .lte("next_run_at", now.toISOString())
      .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
      .select("id,user_id,title,prompt,cadence,timezone,next_run_at")
      .maybeSingle();
    if (claimError || !task) { skipped++; continue; }
    claimed++;

    const current = new Date();
    if (task.cadence === "weekdays" && isWeekend(current)) {
      const { error } = await supabase.from("scheduled_tasks").update({ next_run_at: nextWeekdayMidnight(current), lease_token: null, lease_until: null, last_status: "pending", updated_at: new Date().toISOString() }).eq("id", task.id).eq("user_id", task.user_id).eq("lease_token", lease);
      if (error) { failed++; await logEvent("error", "scheduled-tasks", `Could not advance weekend task ${task.id}: ${error.message}`); }
      else skipped++;
      continue;
    }

    let outcome;
    try {
      outcome = await runScheduledPrompt(task.prompt);
    } catch (error) {
      outcome = { ok: false, error: String(error?.message || "Scheduled model request failed.").slice(0, 600) };
    }

    const runRow = {
      task_id: task.id,
      user_id: task.user_id,
      title: task.title,
      prompt: task.prompt,
      result: outcome.ok ? outcome.result : null,
      error: outcome.ok ? null : String(outcome.error || "Task failed.").slice(0, 2000),
      status: outcome.ok ? "succeeded" : "failed",
    };
    const { error: runError } = await supabase.from("scheduled_task_runs").insert(runRow);
    const next = nextRun(task.cadence, new Date());
    const finalStatus = outcome.ok && !runError ? "succeeded" : "failed";
    const { error: finishError } = await supabase.from("scheduled_tasks").update({
      next_run_at: next,
      last_run_at: new Date().toISOString(),
      last_status: finalStatus,
      lease_token: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    }).eq("id", task.id).eq("user_id", task.user_id).eq("lease_token", lease);

    if (finishError || runError) {
      failed++;
      await logEvent("error", "scheduled-tasks", `Run persistence failed for ${task.id}: ${(finishError || runError).message}`);
      outcomes.push({ id: task.id, status: "persistence_failed" });
    } else if (outcome.ok) {
      succeeded++;
      outcomes.push({ id: task.id, status: "succeeded" });
    } else {
      failed++;
      outcomes.push({ id: task.id, status: "failed" });
      await logEvent("warning", "scheduled-tasks", `Scheduled task ${task.id} failed: ${runRow.error}`);
    }
  }

  return send(res, 200, { ok: true, checked: (due || []).length, claimed, succeeded, failed, skipped, outcomes });
}
