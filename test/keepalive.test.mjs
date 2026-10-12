import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createGateway} from "../server.mjs";
import {parseSSE} from "../lib/responses.mjs";

async function fixture(t,fetchImpl,queueWaitMs=500){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-heartbeat-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const g=await createGateway({port:0,directory,streamKeepaliveMs:10,queueWaitMs,oauthFactory:()=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>"fixture"}),fetchImpl});t.after(()=>g.close());
  const send=()=>fetch(g.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+g.store.settings.gatewayKey,"content-type":"application/json"},body:JSON.stringify({model:"m",input:"hello",stream:true})});return {...g,send};
}
const completed=()=>new Response('data: {"type":"response.completed","response":{"id":"r","model":"m","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{"content-type":"text/event-stream"}});

test("SSE keepalive covers queued requests and a slow upstream without inventing completion",async t=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;}),g=await fixture(t,async()=>{await gate;return completed();});
  await g.store.updateAccount("account-default",{maxConcurrent:1});
  const first=await g.send(),firstBody=first.text(),second=await g.send(),secondBody=second.text();
  assert.equal(g.admissions.status().waiting,1);assert.equal(second.status,200);assert.ok(second.headers.get("content-type").includes("text/event-stream"));
  await delay(20);finish();
  for(const body of await Promise.all([firstBody,secondBody])){
    assert.ok(body.includes(": gateway keepalive"));const events=[];for await(const item of parseSSE(new Response(body).body))events.push(item);
    assert.deepEqual(events.map(item=>item.type),["response.completed"]);
  }
  assert.equal(g.store.report().requests,2);
});

test("queue expiry after a heartbeat is an SSE error; delayed upstream HTTP errors retain their status",async t=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;}),g=await fixture(t,async()=>{await gate;return new Response('{"error":{"code":"upstream_limited","message":"fixture limit"}}',{status:429});},50);
  await g.store.updateAccount("account-default",{maxConcurrent:1});
  const first=await g.send(),body=first.text(),queued=await g.send(),events=[];
  for await(const item of parseSSE(queued.body))events.push(item);
  assert.equal(events.at(-1).code,"queue_wait_timeout");assert.equal(events.at(-1).status,504);
  finish();const upstreamEvents=[];for await(const item of parseSSE(new Response(await body).body))upstreamEvents.push(item);
  assert.equal(upstreamEvents.at(-1).code,"upstream_limited");assert.equal(upstreamEvents.at(-1).status,429);
  assert.equal(g.store.records.length,1);
});
