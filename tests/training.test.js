import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { scrubPII, signReply, verifyReply, qualityScore, cleanContext, sftLine, dpoLine, handleTraining } from "../api/_lib/training.js";
import adminTraining from "../api/_lib/training.js";

process.env.TRAINING_SECRET = "test-secret";

// A tiny in-memory stand-in for the Supabase query builder.
function fakeSupabase(opts = {}) {
  const tables = { training_consent: [], training_feedback: [] };
  const from = (name) => {
    if (opts.missing) {
      const err = { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` };
      const q = new Proxy({}, { get: (_t, k) => (k === "then" ? (r) => r({ data: null, error: err, count: null }) : () => q) });
      return q;
    }
    const rows = tables[name];
    let op = "select", payload = null, filters = [], head = false, range = null, single = null, wantCount = false, orders = [];
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      if (op === "insert") {
        const row = { id: randomUUID(), status: "pending", created_at: new Date().toISOString(), reasons: [], has_content: false, has_improved: false, has_rejected: false, verified: false, quality: 0.5, ...payload };
        rows.push(row);
        return { data: single ? { id: row.id } : [row], error: null };
      }
      if (op === "upsert") {
        const i = rows.findIndex((r) => r.user_id === payload.user_id);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null };
      }
      if (op === "update") {
        const hit = rows.filter(match);
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      let out = rows.filter(match);
      for (const [col, asc] of orders.slice().reverse()) out = out.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (single) return { data: out[0] || null, error: null };
      return { data: head ? null : out, error: null, count: wantCount ? rows.filter(match).length : null };
    };
    const q = {
      select(_c, o) { if (op === "select") { head = Boolean(o && o.head); wantCount = Boolean(o && o.count); } return q; },
      insert(p) { op = "insert"; payload = p; return q; },
      update(p) { op = "update"; payload = p; return q; },
      upsert(p) { op = "upsert"; payload = p; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      neq(c, v) { filters.push((r) => r[c] !== v); return q; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return q; },
      gte(c, v) { filters.push((r) => r[c] >= v); return q; },
      order(c, o) { orders.push([c, !o || o.ascending !== false]); return q; },
      range(a, b) { range = [a, b]; return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    return q;
  };
  return { from, tables };
}
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
}
const call = async (handler, method, body, deps, query = {}) => { const r = res(); await handler({ method, body, query, headers: {} }, r, deps); return r; };

test("scrubPII removes personal details but keeps code usable", () => {
  const raw = "Mail me at jane.doe@example.com or +995 555 12 34 56, card 4242 4242 4242 4242, IBAN GE29NB0000000101904917, key tvly-dev-AbCdEf1234567890xyz and sk-proj-abcdefghijklmnop1234, server 8.8.8.8, local 127.0.0.1, password: hunter22!\nconst ts = 1696420000000; const port = 3000;";
  const out = scrubPII(raw);
  for (const bad of ["jane.doe@example.com", "555 12 34 56", "4242 4242 4242 4242", "GE29NB0000000101904917", "tvly-dev-AbCdEf", "sk-proj-abcdefghijklmnop1234", "8.8.8.8", "hunter22!"]) assert.ok(!out.includes(bad), `still contains ${bad}: ${out}`);
  for (const keep of ["127.0.0.1", "1696420000000", "port = 3000", "[email]", "[phone]", "[card]", "[iban]", "[secret]", "[ip]"]) assert.ok(out.includes(keep), `missing ${keep}: ${out}`);
  assert.equal(scrubPII("4242424242424241"), "4242424242424241", "non-Luhn numbers stay");
});

test("reply signatures verify only the exact text", () => {
  const sig = signReply("Hello **world**");
  assert.ok(verifyReply("Hello **world**", sig));
  assert.ok(!verifyReply("Hello world", sig));
  assert.ok(!verifyReply("Hello **world**", ""));
});

test("context is trimmed to user-first, user-last turns", () => {
  const ctx = cleanContext([{ role: "assistant", content: "hi" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c me@x.io" }, { role: "assistant", content: "d" }, { role: "system", content: "x" }]);
  assert.deepEqual(ctx, [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c [email]" }]);
});

test("export lines use the standard formats", () => {
  const row = { mode: "code", rating: "good", messages: [{ role: "user", content: "hi" }], reply: "Hello!", rejected: "Hey.", improved: null };
  const sft = JSON.parse(sftLine(row));
  assert.equal(sft.messages[0].role, "system");
  assert.equal(sft.messages.at(-1).content, "Hello!");
  const dpo = JSON.parse(dpoLine(row));
  assert.equal(dpo.chosen[0].content, "Hello!");
  assert.equal(dpo.rejected[0].content, "Hey.");
  assert.equal(sftLine({ ...row, rating: "bad" }), null, "bad replies are not training targets");
  const fixed = JSON.parse(sftLine({ ...row, rating: "bad", improved: "Better hello." }));
  assert.equal(fixed.messages.at(-1).content, "Better hello.");
  assert.ok(qualityScore({ ...row, verified: true, reasons: ["clear"] }) > qualityScore({ ...row, rating: "bad" }));
});

test("feedback without consent keeps only the rating", async () => {
  const supabase = fakeSupabase();
  const r = await call(handleTraining, "POST", { action: "feedback", rating: "good", reasons: ["clear", "nonsense"], messages: [{ role: "user", content: "hi" }], reply: "Hello", mode: "chat" }, { supabase, user: { userId: "u1" } });
  assert.equal(r.body.saved, false);
  const row = supabase.tables.training_feedback[0];
  assert.deepEqual(row.reasons, ["clear"]);
  assert.equal(row.has_content, false);
  assert.equal(row.reply, undefined);
});

test("opted-in feedback saves a scrubbed, verified example; updates and withdrawal work", async () => {
  const supabase = fakeSupabase();
  const deps = { supabase, user: { userId: "u2" } };
  assert.equal((await call(handleTraining, "GET", null, deps, { training: "1" })).body.state, "unset");
  assert.equal((await call(handleTraining, "POST", { action: "consent", on: true }, deps)).body.state, "on");
  const reply = "Call me at +1 415 555 0134 — here you go.";
  const r = await call(handleTraining, "POST", { action: "feedback", rating: "bad", reasons: ["wrong"], messages: [{ role: "user", content: "my email is a@b.co" }], reply, sig: signReply(reply), mode: "code", model: "gemini" }, deps);
  assert.equal(r.body.saved, true);
  const row = supabase.tables.training_feedback[0];
  assert.equal(row.verified, true);
  assert.ok(!row.reply.includes("555 0134"));
  assert.ok(row.messages[0].content.includes("[email]"));
  // add a better answer
  const u = await call(handleTraining, "POST", { action: "feedback", id: r.body.id, key: r.body.key, rating: "bad", reasons: ["wrong", "long"], improved: "The right answer." }, deps);
  assert.equal(u.body.ok, true);
  assert.equal(row.improved, "The right answer.");
  assert.equal(row.has_improved, true);
  assert.ok(row.reply.length > 0, "conversation kept on update");
  // a forged key is refused
  assert.equal((await call(handleTraining, "POST", { action: "feedback", id: r.body.id, key: "x".repeat(32), rating: "good" }, deps)).statusCode, 403);
  assert.equal((await call(handleTraining, "GET", null, deps, { training: "1" })).body.shared, 1);
  // withdraw
  const w = await call(handleTraining, "POST", { action: "consent", on: false }, deps);
  assert.equal(w.body.removed, 1);
  assert.equal(row.status, "withdrawn");
});

test("admin stats, review, and export", async () => {
  const supabase = fakeSupabase();
  const user = { userId: "u3" };
  await call(handleTraining, "POST", { action: "consent", on: true }, { supabase, user });
  const good = "Here is a great, complete answer with real detail.";
  await call(handleTraining, "POST", { action: "feedback", rating: "good", reasons: ["clear"], messages: [{ role: "user", content: "q1" }], reply: good, sig: signReply(good), rejected: "meh", mode: "chat" }, { supabase, user });
  await call(handleTraining, "POST", { action: "feedback", rating: "bad", reasons: ["wrong"], messages: [{ role: "user", content: "q2" }], reply: "nope", mode: "studio", improved: "A much better answer." }, { supabase, user });
  await call(handleTraining, "POST", { action: "feedback", rating: "good", mode: "agent" }, { supabase, user: {} });
  const admin = { supabase, user: { email: "owner@x.com", role: "owner" } };
  assert.equal((await call(adminTraining, "GET", null, { supabase, user: { email: "m@x.com", role: "moderator" } })).statusCode, 403);
  const st = (await call(adminTraining, "GET", null, admin, { view: "stats" })).body;
  assert.equal(st.total, 3);
  assert.equal(st.shared, 2);
  assert.equal(st.satisfaction, 67);
  assert.equal(st.sft.all, 2);
  assert.equal(st.dpo.all, 2);
  assert.equal(st.highQualityPending, 1);
  const bulk = (await call(adminTraining, "POST", { action: "approve-high" }, admin)).body;
  assert.equal(bulk.approved, 1);
  const queue = (await call(adminTraining, "GET", null, admin, { view: "queue", status: "pending" })).body;
  assert.equal(queue.items.length, 1);
  assert.equal((await call(adminTraining, "POST", { id: queue.items[0].id, status: "approved", improved: "Edited by admin, mail x@y.com" }, admin)).body.ok, true);
  assert.ok(supabase.tables.training_feedback.find((r) => r.id === queue.items[0].id).improved.includes("[email]"));
  const sft = (await call(adminTraining, "GET", null, admin, { view: "export", format: "sft", scope: "approved" })).body;
  assert.equal(sft.count, 2);
  sft.lines.trim().split("\n").forEach((l) => assert.ok(JSON.parse(l).messages.length >= 3));
  const dpo = (await call(adminTraining, "GET", null, admin, { view: "export", format: "dpo", scope: "all" })).body;
  assert.equal(dpo.count, 2);
  assert.equal(dpo.next, null);
});

test("missing tables are reported as setup needed", async () => {
  const supabase = fakeSupabase({ missing: true });
  assert.equal((await call(handleTraining, "GET", null, { supabase, user: { userId: "u" } }, { training: "1" })).body.setup, false);
  assert.equal((await call(adminTraining, "GET", null, { supabase, user: { email: "o@x", role: "owner" } }, { view: "stats" })).body.setup, false);
});
