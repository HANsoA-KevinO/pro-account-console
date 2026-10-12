import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, rm, stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {request as httpRequest} from "node:http";
import {generateKeyPair, SignJWT, exportJWK, createLocalJWKSet} from "jose";
import {createGateway} from "../server.mjs";
import {OAuth, ISSUER, RESOURCE, verifyIdentity} from "../lib/oauth.mjs";
import {Store} from "../lib/storage.mjs";
import {normalizeRequest, parseSSE} from "../lib/responses.mjs";

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-gateway-test-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
const completeResponse = model => ({
  id: "resp_test", object: "response", model, status: "completed",
  output: [{type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{type: "output_text", text: "网关连接成功。", annotations: []}]}],
  usage: {input_tokens: 17, output_tokens: 8, total_tokens: 25},
});
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(event => "event: " + event.type + "\r\ndata: " + JSON.stringify(event) + "\r\n\r\n").join(""));
  let index = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (index === bytes.length) return controller.close();
    const end = Math.min(index + 7, bytes.length);
    controller.enqueue(bytes.slice(index, end));
    index = end;
  }}), {headers: {"content-type": "text/event-stream", "x-request-id": "req_test"}});
}
async function fixture(t, fetchImpl) {
  const directory = await temporary(t);
  const gateway = await createGateway({sessionWebSockets:false,
    directory, port: 0, fetchImpl,
    oauthFactory: () => ({status: () => ({connected: true, sharing: true}), accessToken: async () => "UPSTREAM_SECRET_NOT_FOR_CLIENT"}),
  });
  t.after(() => new Promise(resolve => {gateway.server.close(resolve);gateway.server.closeAllConnections();}));
  return {...gateway, headers: {authorization: "Bearer " + gateway.store.settings.gatewayKey, "content-type": "application/json"}};
}

test("input adaptation preserves caller context and rejects unsupported capabilities", () => {
  const request = normalizeRequest({model: "test-model", input: "Hello", stream: false});
  assert.deepEqual(request.input, [{role: "user", content: "Hello"}]);
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  for (const fields of [{temperature: 0}, {previous_response_id: "resp_old"}, {store: true}, {input: [{role: "system", content: "x"}]}]) {
    assert.throws(() => normalizeRequest({model: "test-model", input: "x", ...fields}));
  }
});

test("SSE parser handles fragmented UTF-8, CRLF, and terminal events", async () => {
  const source = sse([{type: "response.output_text.delta", delta: "中文"}, {type: "response.completed", response: completeResponse("test-model")}]);
  const events = [];
  for await (const event of parseSSE(source.body)) events.push(event);
  assert.equal(events[0].delta, "中文");
  assert.equal(events[1].response.usage.input_tokens, 17);
});

test("SSE event names preserve terminal events and errors when JSON omits type",async()=>{
  const source=new Response('event: response.completed\ndata: '+JSON.stringify({response:completeResponse("test-model")})+'\n\nevent: error\ndata: {"code":"upstream_failed"}\n\n');
  const events=[];for await(const event of parseSSE(source.body))events.push(event);
  assert.equal(events[0].type,"response.completed");assert.equal(events[1].type,"error");
});

test("incomplete upstream streams retain bounded metadata without storing content or credentials",async t=>{
  const g=await fixture(t,async()=>sse([{type:"response.created",response:{id:"resp_unfinished",model:"test-model",status:"in_progress"}}, {type:"response.output_text.delta",delta:"PRIVATE_OUTPUT"}]));
  const response=await fetch(g.origin+"/v1/responses",{method:"POST",headers:g.headers,body:JSON.stringify({model:"test-model",input:"PRIVATE_INPUT",stream:false})});
  assert.equal(response.status,502);assert.equal((await response.json()).error.code,"stream_incomplete");
  const record=g.store.records[0];assert.equal(record.streamDiagnostics.eventCount,2);assert.equal(record.streamDiagnostics.lastEventType,"response.output_text.delta");assert.equal(record.streamDiagnostics.terminalEvent,null);assert.equal(record.streamDiagnostics.upstreamStatus,200);
  assert.ok(!JSON.stringify(record).includes("PRIVATE_OUTPUT"));assert.ok(!JSON.stringify(record).includes("PRIVATE_INPUT"));assert.ok(!JSON.stringify(record).includes("UPSTREAM_SECRET"));
});

test("non-streaming gateway collects completed response and records actual usage", async t => {
  let requestBody;
  const g = await fixture(t, async (url, options) => {
    assert.equal(url, RESOURCE + "/responses");
    assert.equal(options.headers.authorization, "Bearer UPSTREAM_SECRET_NOT_FOR_CLIENT");
    requestBody = JSON.parse(options.body);
    return sse([{type: "response.output_text.delta", delta: "网关连接成功。"}, {type: "response.completed", response: completeResponse("test-model")}]);
  });
  const response = await fetch(g.origin + "/v1/responses", {method: "POST", headers: g.headers, body: JSON.stringify({model: "test-model", input: "Hello", stream: false})});
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, "completed");
  assert.equal(requestBody.stream, true);
  assert.equal(g.store.summary().inputTokens, 17);
  assert.equal(g.store.records[0].modelCheck, "matching");
  assert.equal(g.store.records[0].requestId, "req_test");
  const saved = JSON.stringify(g.store.records);
  assert.ok(!saved.includes("Hello"));
  assert.ok(!saved.includes("UPSTREAM_SECRET"));
});

test("streaming gateway forwards tool events and model differences without rewriting model", async t => {
  const g = await fixture(t, async () => sse([
    {type: "response.output_item.added", item: {type: "function_call", call_id: "call_1", name: "tools.lookup", arguments: "{}"}},
    {type: "response.completed", response: completeResponse("reported-other-model")},
  ]));
  const response = await fetch(g.origin + "/v1/responses", {method: "POST", headers: g.headers, body: JSON.stringify({model: "requested-model", input: "x", stream: true})});
  const text = await response.text();
  assert.ok(text.includes("call_1"));
  assert.ok(text.includes("response.completed"));
  assert.ok(text.includes("reported-other-model"));
  assert.equal(g.store.records[0].modelCheck, "different");
});

test("valid SSE without a Content-Type header still requires a completed event", async t => {
  const g = await fixture(t, async () => {
    const response = sse([{type: "response.completed", response: completeResponse("test-model")}]);
    response.headers.delete("content-type");
    return response;
  });
  const response = await fetch(g.origin + "/v1/responses", {method: "POST", headers: g.headers, body: JSON.stringify({model: "test-model", input: "x", stream: false})});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
  assert.equal(g.store.summary().completed, 1);
});

test("final output is assembled from completed items when upstream snapshot omits it", async t => {
  const g = await fixture(t, async () => sse([
    {type: "response.output_item.done", output_index: 0, item: completeResponse("test-model").output[0]},
    {type: "response.completed", response: {...completeResponse("test-model"), output: []}},
  ]));
  for (const stream of [false, true]) {
    const response = await fetch(g.origin + "/v1/responses", {method: "POST", headers: g.headers, body: JSON.stringify({model: "test-model", input: "x", stream})});
    let final;
    if (stream) {for await (const event of parseSSE(response.body)) if (event.type === "response.completed") final = event.response;}
    else final = await response.json();
    assert.equal(final.output[0].content[0].text, "网关连接成功。");
    assert.equal(final.model, "test-model");
  }
});

test("missing terminal event and quota failure cannot be reported as success", async t => {
  let quota = false;
  const g = await fixture(t, async () => quota
    ? sse([{type: "response.failed", response: {model: "test-model", status: "failed", error: {code: "subscription_sharing_usage_limit_exceeded"}}}])
    : sse([{type: "response.output_text.delta", delta: "Partial"}]));
  const request = () => fetch(g.origin + "/v1/responses", {method: "POST", headers: g.headers, body: JSON.stringify({model: "test-model", input: "x", stream: false})});
  let response = await request();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "stream_incomplete");
  quota = true;
  response = await request();
  assert.equal(response.status, 429);
  assert.equal(g.store.summary().completed, 0);
  assert.equal(g.store.summary().missingUsage, 2);
});

test("local key, administrator cookie, CSRF, and host boundaries are enforced", async t => {
  const g = await fixture(t, async () => {throw new Error("Should not reach upstream");});
  assert.equal((await fetch(g.origin + "/v1/models")).status, 401);
  assert.equal((await fetch(g.origin + "/api/connection")).status, 401);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(g.origin + "/healthz", {headers: {host: "evil.example"}}, response => {response.resume();resolve(response.statusCode);});
    request.on("error", reject);
    request.end();
  });
  assert.equal(reboundStatus, 403);
  const page = await fetch(g.origin + "/", {headers: {"sec-fetch-site": "cross-site"}});
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(!html.includes("UPSTREAM_SECRET"));
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const connection = await fetch(g.origin + "/api/connection", {headers: {cookie}});
  const data = await connection.json();
  assert.equal(data.apiKey, g.store.settings.gatewayKey);
  assert.equal(Object.hasOwn(data, "access_token"), false);
  assert.equal((await fetch(g.origin + "/api/login", {method: "POST", headers: {cookie}})).status, 403);
  assert.equal((await fetch(g.origin + "/api/connection", {headers: {cookie, origin: "https://evil.example"}})).status, 403);
});

test("credential storage is private and refresh operations are serialized", async t => {
  const store = await new Store(await temporary(t)).init();
  await store.setConnection({client_id: "issued", subject: "user", access_token: "old", refresh_token: "refresh-old", expires_at: 0, scopes: ["chatgpt.tokens.use.direct"]});
  let refreshCalls = 0;
  const oauth = new OAuth(store, {redirectUri: "http://127.0.0.1:8787/auth/callback"});
  oauth.tokenRequest = async fields => {
    assert.equal(fields.client_id, "issued");
    assert.equal(fields.refresh_token, "refresh-old");
    refreshCalls++;
    await new Promise(resolve => setTimeout(resolve, 15));
    return {access_token: "new", refresh_token: "refresh-new", expires_in: 3600};
  };
  assert.deepEqual(await Promise.all([oauth.accessToken(), oauth.accessToken()]), ["new", "new"]);
  assert.equal(refreshCalls, 1);
  assert.equal(store.connection.refresh_token, "refresh-new");
  assert.equal((await stat(store.authFile)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
});

test("OAuth callback transaction is browser-bound, expiring, and one-time", async t => {
  const store = await new Store(await temporary(t)).init();
  const oauth = new OAuth(store, {redirectUri: "http://127.0.0.1:8787/auth/callback"});
  const transaction = {browser: "browser", expiresAt: Date.now() + 10000, clientId: "issued"};
  oauth.pending.set("valid", transaction);
  const params = new URLSearchParams({state: "valid", code: "code", client_id: "issued"});
  assert.equal(oauth.consume(params, "browser").clientId, "issued");
  assert.throws(() => oauth.consume(params, "browser"));
  oauth.pending.set("wrong-browser", transaction);
  assert.throws(() => oauth.consume(new URLSearchParams({state: "wrong-browser", code: "code"}), "other-browser"));
  oauth.pending.set("expired", {...transaction, expiresAt: 0});
  assert.throws(() => oauth.consume(new URLSearchParams({state: "expired", code: "code"}), "browser"));
  oauth.pending.set("client-change", transaction);
  assert.throws(() => oauth.consume(new URLSearchParams({state: "client-change", code: "code", client_id: "other"}), "browser"));
});

test("OIDC validation rejects wrong nonce, audience, issuer, and signature", async () => {
  const {privateKey, publicKey} = await generateKeyPair("RS256");
  const jwk = {...await exportJWK(publicKey), kid: "test"};
  const jwks = createLocalJWKSet({keys: [jwk]});
  const token = await new SignJWT({nonce: "nonce"}).setProtectedHeader({alg: "RS256", kid: "test"}).setSubject("user").setIssuer(ISSUER).setAudience("issued").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  assert.equal((await verifyIdentity(token, "issued", "nonce", jwks)).sub, "user");
  await assert.rejects(verifyIdentity(token, "issued", "wrong-nonce", jwks));
  await assert.rejects(verifyIdentity(token, "wrong-audience", "nonce", jwks));
  const wrongIssuer = await new SignJWT({nonce: "nonce"}).setProtectedHeader({alg: "RS256", kid: "test"}).setSubject("user").setIssuer("https://evil.example").setAudience("issued").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  await assert.rejects(verifyIdentity(wrongIssuer, "issued", "nonce", jwks));
  const expired = await new SignJWT({nonce: "nonce"}).setProtectedHeader({alg: "RS256", kid: "test"}).setSubject("user").setIssuer(ISSUER).setAudience("issued").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) - 120).sign(privateKey);
  await assert.rejects(verifyIdentity(expired, "issued", "nonce", jwks));
  const parts = token.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  await assert.rejects(verifyIdentity(parts.join("."), "issued", "nonce", jwks));
});
