import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createGateway} from "../server.mjs";
import {normalizeRequest} from "../lib/responses.mjs";
import {sessionIdFromRequest} from "../lib/session.mjs";

async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),"gateway-session-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function fixture(t,{directory,paused=new Set(),fail=false,onCall}={}){
  const calls=[];
  const g=await createGateway({sessionWebSockets:false,directory:directory||await temporary(t),port:0,
    oauthFactory:(_store,id)=>({status:()=>({connected:!paused.has(id),sharing:!paused.has(id)}),accessToken:async()=>id}),
    fetchImpl:async(url,options)=>{
      if(url.endsWith("/models"))return Response.json({models:[{slug:"m",visibility:"list",display_name:"M"},{slug:"m2",visibility:"list",display_name:"M2"}]});
      const call={accountId:options.headers.authorization.slice(7),headers:options.headers,body:JSON.parse(options.body)};calls.push(call);await onCall?.(call,calls);
      const response={id:"resp_"+calls.length,model:call.body.model,status:fail?"failed":"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:3,output_tokens:2},...(fail?{error:{code:"subscription_sharing_usage_limit_exceeded"}}:{})};
      return new Response("data: "+JSON.stringify({type:fail?"response.failed":"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
    },
  });
  t.after(()=>g.close());
  const send=(fields={},key=g.store.settings.gatewayKey)=>fetch(g.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"m",input:"hello",stream:false,...fields})});
  const count=()=>g.store.db.prepare("SELECT COUNT(*) AS n FROM session_routes").get().n;
  return {...g,calls,send,count};
}

test("session_id is validated locally and removed from the upstream body while context is preserved",()=>{
  const input=[{role:"user",content:"one"},{role:"assistant",content:"answer"},{type:"function_call",call_id:"call_1",name:"tool",arguments:"{}"},{type:"function_call_output",call_id:"call_1",output:"done"}];
  const body={model:"m",session_id:"chat-123",input,prompt_cache_key:"cache-group",reasoning:{effort:"medium"}};
  const upstream=normalizeRequest(body);
  assert.equal(Object.hasOwn(upstream,"session_id"),false);assert.deepEqual(upstream.input,input);assert.equal(upstream.prompt_cache_key,"cache-group");assert.deepEqual(upstream.reasoning,body.reasoning);
  assert.equal(body.session_id,"chat-123");assert.equal(sessionIdFromRequest(body),"chat-123");assert.equal(sessionIdFromRequest({}),null);
  for(const value of [null,1,true,{},[],""," chat","chat ","chat\n123","x".repeat(257)])assert.throws(()=>normalizeRequest({model:"m",input:"x",session_id:value}),error=>error.code==="invalid_session_id");
});

test("new sessions round-robin and continuations keep their account without advancing the pool",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B"),c=await g.store.addAccount("C");
  const first=await g.send({session_id:"s1"});assert.equal(first.headers.get("x-gateway-session-routing"),"assigned");assert.equal(first.headers.get("x-gateway-account-id"),"account-default");await first.json();
  const follow=await g.send({session_id:"s1",model:"m2",input:[{role:"user",content:"hello"},{role:"assistant",content:"ok"},{role:"user",content:"next"}]});assert.equal(follow.headers.get("x-gateway-session-routing"),"reused");await follow.json();
  for(const session_id of ["s2","s1","s3"])await(await g.send({session_id})).json();
  const ordinary=await g.send();assert.equal(ordinary.headers.get("x-gateway-session-routing"),"none");await ordinary.json();
  assert.deepEqual(g.calls.map(call=>call.accountId),["account-default","account-default",b.id,"account-default",c.id,"account-default"]);assert.equal(g.count(),3);
  assert.ok(g.calls.every(call=>!Object.hasOwn(call.body,"session_id")));assert.equal(g.calls[1].body.input.length,3);
  const records=g.store.report({session_id:"s1"}).records;assert.equal(records.length,3);assert.ok(records.every(row=>row.accountId==="account-default"));assert.equal(new Set(records.map(row=>row.id)).size,3);
  assert.deepEqual(new Set(records.map(row=>row.sessionRouting)),new Set(["assigned","reused"]));
});

test("session bindings are isolated by key and persist through rotation of the same key entry",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B"),other=await g.store.addAgent({name:"Other"});
  await(await g.send({session_id:"shared"})).json();await(await g.send({session_id:"shared"},other.apiKey)).json();
  await(await g.send({session_id:"shared"})).json();
  const rotated=await g.store.rotateAgent(other.agent.id);
  assert.equal((await g.send({session_id:"shared"},other.apiKey)).status,401);
  await(await g.send({session_id:"shared"},rotated.apiKey)).json();
  assert.deepEqual(g.calls.map(call=>call.accountId),["account-default",b.id,"account-default",b.id]);assert.equal(g.count(),2);
  const usage=await(await fetch(g.origin+"/v1/usage?session_id=shared",{headers:{authorization:"Bearer "+rotated.apiKey}})).json();
  assert.equal(usage.usage.requests,2);assert.ok(usage.usage.records.every(row=>row.agentId===other.agent.id));
});

test("a saved session keeps its account after the gateway restarts",async t=>{
  const directory=await temporary(t),first=await fixture(t,{directory}),b=await first.store.addAccount("B");
  await(await first.send({session_id:"first"})).json();await(await first.send({session_id:"survive-restart"})).json();assert.equal(first.calls.at(-1).accountId,b.id);
  await first.close();
  const second=await fixture(t,{directory});
  const response=await second.send({session_id:"survive-restart"});assert.equal(response.headers.get("x-gateway-session-routing"),"reused");await response.json();
  assert.equal(second.calls[0].accountId,b.id);assert.equal(second.count(),2);
  assert.equal(second.calls[0].headers["session-id"],first.calls.at(-1).headers["session-id"]);
});

test("disabled, removing, unauthorized, deleted or model-ineligible bound accounts never silently fail over",async t=>{
  const paused=new Set(),g=await fixture(t,{paused});await g.store.addAccount("B");
  await(await g.send({session_id:"pinned"})).json();
  await g.store.updateAccount("account-default",{enabled:false});
  let response=await g.send({session_id:"pinned"});assert.equal(response.status,409);assert.equal((await response.json()).error.code,"session_account_unavailable");
  await g.store.updateAccount("account-default",{enabled:true});
  g.store.removingAccounts.add("account-default");assert.equal((await g.send({session_id:"pinned"})).status,409);g.store.removingAccounts.delete("account-default");
  paused.add("account-default");assert.equal((await g.send({session_id:"pinned"})).status,409);paused.delete("account-default");
  await(await fetch(g.origin+"/v1/models",{headers:{authorization:"Bearer "+g.store.settings.gatewayKey}})).json();
  assert.equal((await g.send({session_id:"pinned",model:"unavailable-model"})).status,409);
  assert.equal(g.calls.length,1);
  await(await g.send({session_id:"pinned"})).json();assert.equal(g.calls.at(-1).accountId,"account-default");
  await g.store.deleteAccount("account-default");assert.equal((await g.send({session_id:"pinned"})).status,409);assert.equal(g.calls.length,2);
});

test("token refresh preserves a session, but replacement of the authorized identity invalidates it",async t=>{
  const g=await fixture(t);await g.store.addAccount("B");
  await g.store.setConnection({subject:"owner",client_id:"client",access_token:"old"});
  await(await g.send({session_id:"identity"})).json();
  await g.store.setConnection({subject:"owner",client_id:"client",access_token:"renewed"});
  await(await g.send({session_id:"identity"})).json();
  await g.store.setConnection({subject:"different-owner",client_id:"client",access_token:"different"});
  const response=await g.send({session_id:"identity"});assert.equal(response.status,409);assert.equal(g.calls.length,2);
  assert.equal(g.count(),1);
});

test("invalid input, denied models and exhausted key limits do not create bindings or advance routing",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B"),key=await g.store.addAgent({name:"Limited",allowedModels:["m"],dailyRequests:1});
  assert.equal((await g.send({session_id:"",input:"x"})).status,400);
  assert.equal((await g.send({session_id:"invalid-context",input:[]})).status,400);
  assert.equal((await g.send({session_id:"forbidden",model:"other"},key.apiKey)).status,403);assert.equal(g.count(),0);
  await(await g.send({session_id:"allowed"},key.apiKey)).json();
  assert.equal((await g.send({session_id:"blocked"},key.apiKey)).status,429);assert.equal(g.count(),1);
  await(await g.send({session_id:"next"})).json();assert.equal(g.calls.at(-1).accountId,b.id);
});

test("HTTP requests for one session queue while independent sessions keep running",{timeout:10000},async t=>{
  let release,arrived;const gate=new Promise(resolve=>release=resolve),firstArrived=new Promise(resolve=>arrived=resolve);
  const g=await fixture(t,{onCall:async(_call,calls)=>{if(calls.length===1){arrived();await gate;}}});const b=await g.store.addAccount("B");
  const first=g.send({session_id:"parallel"});await firstArrived;
  const follow=g.send({session_id:"parallel"});
  try{
    const deadline=Date.now()+1000;while(g.admissions.status().waiting!==1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(g.admissions.status().waiting,1);assert.equal(g.calls.length,1);assert.equal(g.store.agentUsage(g.store.management.agents[0]).active,1);
    const other=await g.send({session_id:"independent"});assert.equal(other.status,200);await other.json();assert.equal(g.calls[1].accountId,b.id);
  }finally{release();}
  const responses=await Promise.all([first,follow]);assert.ok(responses.every(response=>response.status===200));await Promise.all(responses.map(response=>response.json()));
  assert.deepEqual(g.calls.map(call=>call.accountId),["account-default",b.id,"account-default"]);assert.equal(g.count(),2);
});

test("an upstream quota failure retains the binding and never tries another account",async t=>{
  const g=await fixture(t,{fail:true});await g.store.addAccount("B");
  for(let i=0;i<2;i++){const response=await g.send({session_id:"quota-failed"});assert.equal(response.status,429);await response.json();}
  assert.deepEqual(g.calls.map(call=>call.accountId),["account-default","account-default"]);assert.equal(g.count(),1);
});
