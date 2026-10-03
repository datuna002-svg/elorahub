import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { verifyCallbackSignature, orderBody, priceFor, applyReceipt, addPeriod, newExternalId } from "../api/_payments/bog.js";
import payRouter from "../api/pay/[action].js";

// Minimal in-memory stand-in for the Supabase query builder.
function fakeDb(tables) {
  const db = JSON.parse(JSON.stringify(tables));
  return {
    db,
    from(name) {
      db[name] = db[name] || [];
      const rows = db[name];
      const filters = [];
      let op = "select", payload = null, opts = null;
      const match = (r) => filters.every(([k, v, kind]) => (kind === "in" ? v.includes(r[k]) : kind === "lte" ? r[k] <= v : r[k] === v));
      const run = () => {
        if (op === "update") { rows.filter(match).forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
        if (op === "insert") { rows.push({ ...payload }); return { data: null, error: null }; }
        if (op === "upsert") { const key = opts?.onConflict || "email"; const ex = rows.find((r) => r[key] === payload[key]); if (ex) Object.assign(ex, payload); else rows.push({ ...payload }); return { data: null, error: null }; }
        return { data: rows.filter(match), error: null };
      };
      const q = {
        select() { return q; }, eq(k, v) { filters.push([k, v]); return q; }, in(k, v) { filters.push([k, v, "in"]); return q; }, lte(k, v) { filters.push([k, v, "lte"]); return q; }, limit() { return q; },
        update(p) { op = "update"; payload = p; return q; }, insert(p) { op = "insert"; payload = p; return Promise.resolve(run()); }, upsert(p, o) { op = "upsert"; payload = p; opts = o; return Promise.resolve(run()); },
        maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

test("callback signatures are verified with SHA256withRSA", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const body = JSON.stringify({ event: "order_payment", body: { order_id: "abc" } });
  const sig = createSign("RSA-SHA256").update(body).sign(privateKey, "base64");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyCallbackSignature(body, sig, pem), true);
  assert.equal(verifyCallbackSignature(body + " ", sig, pem), false);
  assert.equal(verifyCallbackSignature(body, "", pem), false);
});

test("orders carry the right amount, currency and return links", () => {
  assert.equal(priceFor("premium", "monthly"), 25);
  assert.equal(priceFor("private", "yearly"), 144);
  assert.equal(priceFor("gold", "monthly"), null);
  const id = newExternalId("premium", "yearly", "initial");
  assert.match(id, /^eh-pm-y-[0-9a-f]{12}$/);
  const b = orderBody({ plan: "premium", cycle: "yearly", externalId: id, amount: 240, email: "nika@example.com" });
  assert.equal(b.purchase_units.total_amount, 240);
  assert.equal(b.purchase_units.basket[0].unit_price, 240);
  assert.equal(b.purchase_units.currency, "USD");
  assert.match(b.callback_url, /\/api\/pay\/callback$/);
  assert.match(b.redirect_urls.success, /pay=success&ref=eh-pm-y-/);
  assert.equal(b.buyer.masked_email, "n***@example.com");
});

test("a completed first payment switches the plan on with a saved card", async () => {
  const sb = fakeDb({ bog_orders: [{ order_id: "o1", external_id: "eh-pm-m-1", email: "a@b.co", plan: "premium", cycle: "monthly", kind: "initial", status: "created", amount: 25, currency: "USD", card_saved: true }], bog_subscriptions: [], subscriptions: [] });
  const r = await applyReceipt(sb, { order_id: "o1", order_status: { key: "completed" }, purchase_units: { transfer_amount: 25 }, payment_detail: { card_type: "visa" } });
  assert.equal(r.status, "completed");
  assert.equal(sb.db.subscriptions[0].plan, "premium");
  const sub = sb.db.bog_subscriptions[0];
  assert.equal(sub.parent_order_id, "o1");
  assert.equal(sub.status, "active");
  assert.ok(new Date(sub.current_period_end) > new Date(Date.now() + 27 * 864e5));
  const again = await applyReceipt(sb, { order_id: "o1", order_status: { key: "completed" } });
  assert.equal(again.already, true);
});

test("an underpaid order does not unlock a plan", async () => {
  const sb = fakeDb({ bog_orders: [{ order_id: "o2", external_id: "x", email: "a@b.co", plan: "premium", cycle: "monthly", kind: "initial", status: "created", amount: 25, currency: "USD", card_saved: false }], bog_subscriptions: [], subscriptions: [] });
  const r = await applyReceipt(sb, { order_id: "o2", order_status: { key: "completed" }, purchase_units: { transfer_amount: 1 } });
  assert.equal(r.ok, false);
  assert.equal(sb.db.subscriptions.length, 0);
});

test("renewals extend the period; three failures move the account to Free", async () => {
  const end = new Date(Date.now() + 3600e3).toISOString();
  const sb = fakeDb({
    bog_orders: [
      { order_id: "r1", external_id: "r1", email: "a@b.co", plan: "private", cycle: "monthly", kind: "renewal", status: "created", amount: 15, currency: "USD", card_saved: true },
      { order_id: "r2", external_id: "r2", email: "a@b.co", plan: "private", cycle: "monthly", kind: "renewal", status: "created", amount: 15, currency: "USD", card_saved: true },
      { order_id: "r3", external_id: "r3", email: "a@b.co", plan: "private", cycle: "monthly", kind: "renewal", status: "created", amount: 15, currency: "USD", card_saved: true },
      { order_id: "r4", external_id: "r4", email: "a@b.co", plan: "private", cycle: "monthly", kind: "renewal", status: "created", amount: 15, currency: "USD", card_saved: true },
    ],
    bog_subscriptions: [{ email: "a@b.co", plan: "private", cycle: "monthly", status: "active", parent_order_id: "o1", amount: 15, currency: "USD", current_period_end: end, failures: 0 }],
    subscriptions: [{ email: "a@b.co", plan: "private", credits_total: 500, credits_remaining: 3 }],
  });
  await applyReceipt(sb, { order_id: "r1", order_status: { key: "completed" }, purchase_units: { transfer_amount: 15 } });
  assert.equal(sb.db.bog_subscriptions[0].current_period_end, addPeriod(end, "monthly"));
  assert.equal(sb.db.subscriptions[0].credits_remaining, 500);
  for (const id of ["r2", "r3"]) await applyReceipt(sb, { order_id: id, order_status: { key: "rejected" } });
  assert.equal(sb.db.bog_subscriptions[0].status, "past_due");
  await applyReceipt(sb, { order_id: "r4", order_status: { key: "rejected" } });
  assert.equal(sb.db.bog_subscriptions[0].status, "expired");
  assert.equal(sb.db.subscriptions[0].plan, "free");
});

test("pay router: unknown actions 404, config works, checkout is off without keys", async () => {
  const res = () => { const r = { code: 0, body: null, headers: {} }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const a = res(); await payRouter({ query: { action: "nope" }, method: "GET", headers: {} }, a); assert.equal(a.code, 404);
  const b = res(); await payRouter({ query: { action: "config" }, method: "GET", headers: {} }, b); assert.equal(b.code, 200); assert.equal(b.body.bog, false); assert.equal(b.body.prices["premium-monthly"], 25);
  const c = res(); await payRouter({ query: { action: "checkout" }, method: "POST", headers: {}, body: {} }, c); assert.equal(c.code, 503);
});
