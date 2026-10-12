import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createGateway} from "../server.mjs";

function gate(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function until(predicate){const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error("Timed out waiting for queue state");await delay(5);}}
async function fixture(t,{onCall,release,queueWaitMs=2000}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-queue-test-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];
  const g=await createGateway({sessionWebSockets:false,directory,port:0,queueWaitMs,
    oauthFactory:(_store,id)=>({status:()=>({sharing:true,connected:true}),accessToken:async()=>id}),
    fetchImpl:async(url,options)=>{
      if(url.endsWith("/models"))return Response.json({models:[{slug:"m",visibility:"list",display_name:"M"}]});
      const body=JSON.parse(options.body),call={number:calls.length+1,accountId:options.headers.authorization.slice(7),input:body.input[0].content};calls.push(call);await onCall?.(call);
      const response={id:"resp_queue_"+call.number,model:body.model,status:"completed",output:[{type:"message",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:1,output_tokens:1}};
      return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
    },
  });
  await g.store.updateAccount("account-default",{maxConcurrent:1});await g.store.updateAgent("agent-default",{maxConcurrent:100});
  t.after(async()=>{release?.();await g.close();});
  const send=(input,key=g.store.settings.gatewayKey,{session_id,signal}={})=>fetch(g.origin+"/v1/responses",{method:"POST",signal,headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"m",input,stream:false,...(session_id===undefined?{}:{session_id})})});
  return {...g,calls,send};
}
async function admin(g){const page=await fetch(g.origin+"/"),html=await page.text();return {cookie:page.headers.get("set-cookie").split(";")[0],"x-demo-csrf":html.match(/data-csrf="([^"]+)"/)[1],"content-type":"application/json"};}

test("account queue dispatches FIFO across keys and reserves slots only on execution",async t=>{
  const firstGate=gate(),secondGate=gate(),g=await fixture(t,{onCall:call=>call.number===1?firstGate.promise:call.number===2?secondGate.promise:undefined,release:()=>{firstGate.resolve();secondGate.resolve();}});
  const other=await g.store.addAgent({name:"Other",maxConcurrent:100});
  const first=g.send("first");await until(()=>g.calls.length===1);
  const second=g.send("second",other.apiKey);await until(()=>g.admissions.status().waiting===1);
  const third=g.send("third");await until(()=>g.admissions.status().waiting===2);
  assert.equal(g.store.records.length,1);assert.equal(g.store.accountConcurrency("account-default").active,1);
  const usage=await(await fetch(g.origin+"/v1/usage",{headers:{authorization:"Bearer "+other.apiKey}})).json();assert.equal(usage.today.queued,1);assert.equal(usage.usage.requests,0);
  firstGate.resolve();await(await first).json();await until(()=>g.calls.length===2);
  assert.equal(g.calls[1].input,"second");assert.equal(g.admissions.status().waiting,1);assert.equal(g.store.accountConcurrency("account-default").active,1);
  secondGate.resolve();const response=await second;assert.equal(response.status,200);assert.ok(Number(response.headers.get("x-gateway-queue-wait-ms"))>0);await response.json();await(await third).json();
  assert.deepEqual(g.calls.map(call=>call.input),["first","second","third"]);assert.equal(g.store.records.length,3);assert.equal(g.admissions.status().waiting,0);
});

test("a pinned queue stays on its account and does not block a free account",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});const b=await g.store.addAccount("B");await g.store.updateAccount(b.id,{maxConcurrent:1});
  const first=g.send("first",undefined,{session_id:"chat"});await until(()=>g.calls.length===1);
  const follow=g.send("follow",undefined,{session_id:"chat"});await until(()=>g.admissions.waitingForAccount("account-default")===1);
  const other=await g.send("free-account",undefined,{session_id:"other-chat"});assert.equal(other.status,200);assert.equal(other.headers.get("x-gateway-account-id"),b.id);await other.json();
  assert.equal(g.calls.length,2);hold.resolve();await(await first).json();const response=await follow;assert.equal(response.headers.get("x-gateway-account-id"),"account-default");await response.json();
  assert.equal(g.calls.at(-1).accountId,"account-default");
});

test("key concurrency also queues while independent keys can use available account capacity",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});await g.store.updateAccount("account-default",{maxConcurrent:2});await g.store.updateAgent("agent-default",{maxConcurrent:1});
  const other=await g.store.addAgent({name:"Independent",maxConcurrent:100});
  const first=g.send("first");await until(()=>g.calls.length===1);const second=g.send("same-key");await until(()=>g.admissions.status().waiting===1);
  const independent=await g.send("other-key",other.apiKey);assert.equal(independent.status,200);await independent.json();assert.equal(g.calls[1].input,"other-key");
  hold.resolve();await(await first).json();await(await second).json();assert.equal(g.calls[2].input,"same-key");
});

test("client cancellation removes a queued request and it never reaches upstream",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});
  const first=g.send("first");await until(()=>g.calls.length===1);
  const controller=new AbortController(),queued=g.send("cancel-me",undefined,{signal:controller.signal}).catch(error=>error);await until(()=>g.admissions.status().waiting===1);
  controller.abort();assert.equal((await queued).name,"AbortError");await until(()=>g.admissions.status().waiting===0);
  hold.resolve();await(await first).json();await delay(20);assert.equal(g.calls.length,1);assert.equal(g.store.records.length,1);
});

test("queue timeout returns 504 without model calls or new session bindings",async t=>{
  const hold=gate(),g=await fixture(t,{queueWaitMs:50,onCall:()=>hold.promise,release:hold.resolve});
  const first=g.send("first");await until(()=>g.calls.length===1);
  const queued=await g.send("timeout",undefined,{session_id:"not-started"});assert.equal(queued.status,504);assert.equal((await queued.json()).error.code,"queue_wait_timeout");
  assert.equal(g.calls.length,1);assert.equal(g.admissions.status().waiting,0);assert.equal(g.store.db.prepare("SELECT COUNT(*) AS n FROM session_routes").get().n,0);
  hold.resolve();await(await first).json();
});

test("queued requests recheck key revocation and pinned account state before dispatch",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});
  const other=await g.store.addAgent({name:"Revocable",maxConcurrent:100});const first=g.send("first",undefined,{session_id:"pinned"});await until(()=>g.calls.length===1);
  const revoked=g.send("revoke",other.apiKey);await until(()=>g.admissions.status().waiting===1);await g.store.updateAgent(other.agent.id,{enabled:false});const revokedResponse=await revoked;assert.equal(revokedResponse.status,403);assert.equal((await revokedResponse.json()).error.code,"key_disabled");
  const pinned=g.send("pinned-follow",undefined,{session_id:"pinned"});await until(()=>g.admissions.status().waiting===1);await g.store.updateAccount("account-default",{enabled:false});const pinnedResponse=await pinned;assert.equal(pinnedResponse.status,409);assert.equal((await pinnedResponse.json()).error.code,"session_account_unavailable");
  assert.equal(g.calls.length,1);hold.resolve();await(await first).json();
});

test("administrator requests queue and disconnect cancellation does not execute them",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve}),headers=await admin(g);
  const first=g.send("first");await until(()=>g.calls.length===1);const controller=new AbortController();
  const queued=fetch(g.origin+"/api/test",{method:"POST",headers,signal:controller.signal,body:JSON.stringify({accountId:"account-default",model:"m",input:"admin"})}).catch(error=>error);
  await until(()=>g.admissions.waitingForAccount("account-default")===1);controller.abort();assert.equal((await queued).name,"AbortError");await until(()=>g.admissions.status().waiting===0);
  hold.resolve();await(await first).json();assert.equal(g.calls.length,1);
});

test("a queued fingerprint can be cancelled immediately without consuming model usage",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});
  const first=g.send("first");await until(()=>g.calls.length===1);const started=g.fingerprints.start("account-default",{model:"gpt-6-sol",verificationRounds:0});await until(()=>g.admissions.status().waiting===1);
  g.fingerprints.cancel("account-default");await g.fingerprints.tasks.get("account-default");const result=g.fingerprints.get(started.id);assert.equal(result.status,"stopped");assert.equal(result.usage.unknown,0);assert.equal(g.admissions.status().waiting,0);
  hold.resolve();await(await first).json();assert.equal(g.calls.length,1);
});

test("stopping the gateway cancels its queue and does not replay queued model calls",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:()=>hold.promise,release:hold.resolve});const first=g.send("first");await until(()=>g.calls.length===1);
  const queued=g.send("shutdown");await until(()=>g.admissions.status().waiting===1);const closing=g.close();
  const response=await queued;assert.equal(response.status,503);assert.equal((await response.json()).error.code,"gateway_stopping");assert.equal(g.calls.length,1);
  hold.resolve();await(await first).json();await closing;
});

test("queue timeout ends on dispatch and does not limit the subsequent model execution",async t=>{
  const hold=gate(),g=await fixture(t,{queueWaitMs:100,onCall:call=>call.number===1?hold.promise:delay(130),release:hold.resolve});
  const first=g.send("first");await until(()=>g.calls.length===1);const queued=g.send("long-execution");await until(()=>g.admissions.status().waiting===1);await delay(20);hold.resolve();await(await first).json();
  const response=await queued;assert.equal(response.status,200);await response.json();assert.equal(g.calls.length,2);
});
