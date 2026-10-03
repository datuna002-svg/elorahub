import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, createOAuthState, verifyOAuthState } from "../api/_lib/connectors.js";
import { verifyRequester } from "../api/_lib/supabaseAdmin.js";
import workspaceHandler from "../api/workspace.js";
import cronHandler from "../api/cron/scheduled-tasks.js";
import connectorRouter from "../api/connectors/[provider]/[action].js";

function responseMock(){
  return {
    statusCode:200, headers:{}, body:null, redirectTarget:null,
    setHeader(name,value){this.headers[name]=value;},
    status(code){this.statusCode=code;return this;},
    json(body){this.body=body;return this;},
    redirect(code,target){this.statusCode=code;this.redirectTarget=target;return this;},
  };
}

test("connector secrets encrypt and decrypt with authenticated AES-GCM",()=>{
  const previous=process.env.CONNECTOR_ENCRYPTION_KEY;
  process.env.CONNECTOR_ENCRYPTION_KEY=randomBytes(32).toString("hex");
  const clear="private access token";
  const sealed=encryptSecret(clear);
  assert.notEqual(sealed,clear);
  assert.equal(decryptSecret(sealed),clear);
  assert.equal(decryptSecret(sealed.slice(0,-2)+"aa"),null);
  if(previous===undefined)delete process.env.CONNECTOR_ENCRYPTION_KEY;else process.env.CONNECTOR_ENCRYPTION_KEY=previous;
});

test("OAuth state is signed, provider-bound and rejects tampering",()=>{
  const previous=process.env.CONNECTOR_OAUTH_STATE_SECRET;
  process.env.CONNECTOR_OAUTH_STATE_SECRET=randomBytes(32).toString("hex");
  const state=createOAuthState({userId:"user-123",provider:"google",step:"authorize"});
  assert.equal(verifyOAuthState(state,"google").userId,"user-123");
  assert.equal(verifyOAuthState(state,"github"),null);
  // Change a whole character of the signature (the last base64 character can
  // carry only padding bits, so tampering with it isn't always a real change).
  const at=state.lastIndexOf(".")+1;
  const tampered=state.slice(0,at)+(state[at]==="A"?"B":"A")+state.slice(at+1);
  assert.equal(verifyOAuthState(tampered,"google"),null);
  if(previous===undefined)delete process.env.CONNECTOR_OAUTH_STATE_SECRET;else process.env.CONNECTOR_OAUTH_STATE_SECRET=previous;
});

test("OAuth state refuses signing secrets shorter than 32 bytes",()=>{
  const previous=process.env.CONNECTOR_OAUTH_STATE_SECRET;
  process.env.CONNECTOR_OAUTH_STATE_SECRET="too-short";
  assert.throws(()=>createOAuthState({userId:"user-123",provider:"google",step:"authorize"}),/at least 32 bytes/);
  assert.equal(verifyOAuthState("not-a-state","google"),null);
  if(previous===undefined)delete process.env.CONNECTOR_OAUTH_STATE_SECRET;else process.env.CONNECTOR_OAUTH_STATE_SECRET=previous;
});

test("workspace API refuses unauthenticated reads before touching storage",async()=>{
  const res=responseMock();
  await workspaceHandler({method:"GET",headers:{}},res);
  assert.equal(res.statusCode,401);
  assert.equal(res.body.error,"authentication_required");
  assert.equal((await verifyRequester({headers:{}})).userId,null);
});

test("daily task cron requires a configured bearer secret",async()=>{
  const previous=process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const res=responseMock();
  await cronHandler({method:"GET",headers:{}},res);
  assert.equal(res.statusCode,401);
  if(previous!==undefined)process.env.CRON_SECRET=previous;
});

test("connector OAuth initiation requires a signed-in account",async()=>{
  const res=responseMock();
  await connectorRouter({method:"POST",query:{provider:"google",action:"start"},headers:{}},res);
  assert.equal(res.statusCode,401);
  assert.equal(res.body.error,"authentication_required");
});
