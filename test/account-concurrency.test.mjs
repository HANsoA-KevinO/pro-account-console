import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Store,writeJson} from "../lib/storage.mjs";
import {createGateway} from "../server.mjs";

async function temporary(t){const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-account-cap-"));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
function gate(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error("Timed out waiting for request state");await delay(5);}}
async function fixture(t,{onCall,release,failAuth=false,streamImpl}={}){
  const calls=[];
  const g=await createGateway({sessionWebSockets:false,directory:await temporary(t),port:0,queueWaitMs:40,
    oauthFactory:(_profile,id)=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>{if(failAuth)throw new Error("mock auth failure");return id;}}),
    fetchImpl:async(url,options)=>{
      if(url.endsWith("/models"))return Response.json({models:[{slug:"m",display_name:"M",visibility:"list"}]});
      const call={number:calls.length+1,accountId:options.headers.authorization.slice(7),body:JSON.parse(options.body),signal:options.signal};calls.push(call);
      await onCall?.(call);if(streamImpl)return streamImpl(call);
      const response={id:"resp_cap_"+call.number,model:call.body.model,status:"completed",output:[{type:"message",content:[{type:"output_text",text:Array.from({length:300},(_,i)=>String(i+1)).join(" ")}]}],usage:{input_tokens:1,output_tokens:1}};
      return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
    },
  });
  await g.store.updateAgent("agent-default",{maxConcurrent:100});
  t.after(async()=>{release?.();await g.close();});
  const send=(fields={},key=g.store.settings.gatewayKey)=>fetch(g.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"m",input:"hello",stream:false,...fields})});
  return {...g,calls,send};
}
async function admin(g){const page=await fetch(g.origin+"/"),html=await page.text();return {cookie:page.headers.get("set-cookie").split(";")[0],"x-demo-csrf":html.match(/data-csrf="([^"]+)"/)[1],"content-type":"application/json"};}

test("account caps default to two, migrate existing accounts once, persist and have no 32 ceiling",async t=>{
  const directory=await temporary(t);let store=await new Store(directory).init();
  const b=await store.addAccount("B");assert.equal(store.getAccount(b.id).maxConcurrent,2);
  await store.updateAccount(b.id,{maxConcurrent:64});
  const old=structuredClone(store.management);delete old.accounts[0].maxConcurrent;store.close();await writeJson(path.join(directory,"management.json"),old);
  store=await new Store(directory).init();t.after(()=>store.close());
  assert.equal(store.getAccount("account-default").maxConcurrent,2);assert.equal(store.getAccount(b.id).maxConcurrent,64);
  for(const value of [0,-1,1.5,null,"2",true,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(store.updateAccount(b.id,{maxConcurrent:value}),error=>error.code==="invalid_account_concurrency");
  assert.equal(store.getAccount(b.id).maxConcurrent,64);
});

test("all keys share one account cap and a full pool queues without an upstream call or session binding",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:()=>hold.promise,release:hold.resolve});
  await g.store.updateAccount("account-default",{maxConcurrent:1});const other=await g.store.addAgent({name:"Other",maxConcurrent:100});
  const first=g.send({session_id:"first"});await until(()=>g.calls.length===1);
  assert.equal(g.store.accountConcurrency("account-default").active,1);
  const second=await g.send({session_id:"blocked"},other.apiKey);assert.equal(second.status,504);assert.equal((await second.json()).error.code,"queue_wait_timeout");
  assert.equal(g.calls.length,1);assert.equal(g.store.db.prepare("SELECT COUNT(*) AS n FROM session_routes").get().n,1);
  hold.resolve();await(await first).json();await until(()=>g.store.accountConcurrency("account-default").active===0);
  assert.equal((await g.send({session_id:"blocked"},other.apiKey)).status,200);
});

test("new requests skip saturated accounts and pinned conversations wait for their original account",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});const b=await g.store.addAccount("B");
  await g.store.updateAccount("account-default",{maxConcurrent:1});await g.store.updateAccount(b.id,{maxConcurrent:1});
  const first=g.send({session_id:"pinned"});await until(()=>g.calls.length===1);
  const next=await g.send({session_id:"new-chat"});assert.equal(next.status,200);assert.equal(next.headers.get("x-gateway-account-id"),b.id);await next.json();
  const follow=await g.send({session_id:"pinned"});assert.equal(follow.status,504);assert.equal((await follow.json()).error.code,"queue_wait_timeout");assert.equal(g.calls.length,2);
  const catalog=await fetch(g.origin+"/v1/models",{headers:{authorization:"Bearer "+g.store.settings.gatewayKey}});assert.equal(catalog.status,200);assert.equal((await catalog.json()).data[0].id,"m");
  hold.resolve();await(await first).json();
  const retried=await g.send({session_id:"pinned"});assert.equal(retried.status,200);assert.equal(retried.headers.get("x-gateway-account-id"),"account-default");await retried.json();
});

test("key caps and account caps both apply, and lowering a cap lets active requests finish",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:()=>hold.promise,release:hold.resolve});
  await g.store.updateAccount("account-default",{maxConcurrent:2});const limited=await g.store.addAgent({name:"Limited key",maxConcurrent:1});
  const first=g.send({},limited.apiKey);await until(()=>g.calls.length===1);
  const denied=await g.send({},limited.apiKey);assert.equal(denied.status,504);assert.equal((await denied.json()).error.code,"queue_wait_timeout");
  const second=g.send();await until(()=>g.calls.length===2);
  await g.store.updateAccount("account-default",{maxConcurrent:1});assert.equal(g.store.accountConcurrency("account-default").active,2);
  const third=await g.send();assert.equal(third.status,504);assert.equal((await third.json()).error.code,"queue_wait_timeout");
  hold.resolve();const finished=await Promise.all([first,second]);assert.ok(finished.every(r=>r.status===200));await Promise.all(finished.map(r=>r.json()));
  await until(()=>g.store.accountConcurrency("account-default").active===0);assert.equal((await g.send()).status,200);
});

test("a streaming request keeps its slot until it completes or the client disconnects",async t=>{
  const g=await fixture(t,{streamImpl:call=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    call.signal.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});
  }}),{headers:{"content-type":"text/event-stream"}})});
  await g.store.updateAccount("account-default",{maxConcurrent:1});
  const response=await g.send({stream:true}),reader=response.body.getReader();await reader.read();
  assert.equal(g.store.accountConcurrency("account-default").active,1);
  const denied=await g.send();assert.equal(denied.status,504);assert.equal(g.calls.length,1);
  await reader.cancel();await until(()=>g.store.accountConcurrency("account-default").active===0);
  assert.equal(g.store.records[0].status,"interrupted");
});

test("admin tests and fingerprint probes share the same account slots as agent traffic",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});await g.store.updateAccount("account-default",{maxConcurrent:1});
  const headers=await admin(g),first=g.send();await until(()=>g.calls.length===1);
  const adminTest=await fetch(g.origin+"/api/test",{method:"POST",headers,body:JSON.stringify({accountId:"account-default",model:"m",input:"test"})});assert.equal(adminTest.status,504);assert.equal((await adminTest.json()).error.code,"queue_wait_timeout");
  const waiting=g.fingerprints.start("account-default",{model:"gpt-6-sol",verificationRounds:0});await g.fingerprints.tasks.get("account-default");assert.equal(g.fingerprints.get(waiting.id).status,"failed");assert.equal(g.fingerprints.get(waiting.id).usage.unknown,0);assert.equal(g.calls.length,1);
  const status=await(await fetch(g.origin+"/api/status",{headers})).json();assert.deepEqual(status.accounts[0].concurrency,{active:1,limit:1,remaining:0,saturated:true,queued:0});
  hold.resolve();await(await first).json();
  assert.equal((await fetch(g.origin+"/api/test",{method:"POST",headers,body:JSON.stringify({accountId:"account-default",model:"m",input:"test"})})).status,200);
  const started=g.fingerprints.start("account-default",{model:"gpt-6-sol",verificationRounds:0});await g.fingerprints.tasks.get("account-default");
  assert.equal(g.fingerprints.get(started.id).status,"completed");assert.equal(g.calls.length,5);assert.equal(g.store.accountConcurrency("account-default").active,0);
});

test("due fingerprint checks defer while full without advancing their schedule",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.number===1?hold.promise:undefined,release:hold.resolve});await g.store.updateAccount("account-default",{maxConcurrent:1});
  const due=new Date(0).toISOString();await g.store.manage(next=>{next.accounts[0].fingerprintPolicy={enabled:true,model:"gpt-6-sol",effort:"default",verificationRounds:0,intervalHours:1,lastStartedAt:due};},"test_policy");
  const first=g.send();await until(()=>g.calls.length===1);await g.fingerprints.tick();assert.equal(g.calls.length,1);assert.equal(g.store.getAccount("account-default").fingerprintPolicy.lastStartedAt,due);
  hold.resolve();await(await first).json();await g.fingerprints.tick();await g.fingerprints.tasks.get("account-default");
  assert.equal(g.calls.length,4);assert.notEqual(g.store.getAccount("account-default").fingerprintPolicy.lastStartedAt,due);
});

test("authorization failure and gateway restart release stale reservations",async t=>{
  const g=await fixture(t,{failAuth:true});await g.store.updateAccount("account-default",{maxConcurrent:1});
  const response=await g.send();assert.equal(response.status,502);await response.json();assert.equal(g.store.accountConcurrency("account-default").active,0);assert.equal(g.calls.length,0);
  const directory=await temporary(t);let store=await new Store(directory).init();const agent=store.authenticate("Bearer "+store.settings.gatewayKey);
  store.admit(agent,"m");assert.equal(store.accountConcurrency("account-default").active,1);store.close();
  store=await new Store(directory).init();t.after(()=>store.close());assert.equal(store.accountConcurrency("account-default").active,0);assert.equal(store.records[0].status,"interrupted");
});
