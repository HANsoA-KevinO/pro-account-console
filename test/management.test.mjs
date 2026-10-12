import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {Store,writeJson,localDay} from "../lib/storage.mjs";
import {createGateway} from "../server.mjs";
import {QUALITY_TASKS,grade,compareQuality,Quality} from "../lib/quality.mjs";

async function temp(t){const dir=await mkdtemp(path.join(os.tmpdir(),"multi-account-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const response=model=>({id:"resp-"+randomUUID(),object:"response",model,status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:4},output_tokens_details:{reasoning_tokens:2}}});
const stream=value=>new Response("data: "+JSON.stringify({type:"response.completed",response:value})+"\n\n",{headers:{"content-type":"text/event-stream"}});
async function fixture(t,fetchImpl){
  const g=await createGateway({sessionWebSockets:false,directory:await temp(t),port:0,fetchImpl,oauthFactory:(profile,id)=>({status:()=>({connected:true,sharing:true,email:id+"@example.test"}),accessToken:async()=>id})});
  t.after(()=>new Promise(resolve=>{g.server.close(resolve);g.server.closeAllConnections();}));
  return g;
}
async function admin(g){
  const page=await fetch(g.origin+"/");const html=await page.text();
  const cookie=page.headers.get("set-cookie").split(";")[0],csrf=html.match(/data-csrf="([^"]+)"/)[1];
  return {cookie,"x-demo-csrf":csrf,"content-type":"application/json"};
}
async function post(g,route,body,headers){return fetch(g.origin+route,{method:"POST",headers,body:JSON.stringify(body)});}

test("legacy authorization/key/history migrate once and remain intact",async t=>{
  const directory=await temp(t);
  const auth={client_id:"issued",subject:"user-a",access_token:"private-access",refresh_token:"private-refresh",scopes:["chatgpt.tokens.use.direct"],expires_at:Date.now()+3600000};
  await writeJson(path.join(directory,"settings.json"),{hostId:"urn:uuid:test",gatewayKey:"gw_legacy"});
  await writeJson(path.join(directory,"connection.json"),auth);
  await writeJson(path.join(directory,"usage.json"),[{id:"legacy-request",time:new Date().toISOString(),requestedModel:"model-a",reportedModel:"model-a",status:"completed",usage:{input_tokens:7,output_tokens:3}}]);
  let store=await new Store(directory).init();
  assert.deepEqual(store.connection,auth);assert.equal(store.summary().requests,1);
  assert.equal(store.authenticate("Bearer gw_legacy").id,"agent-default");
  store.close();store=await new Store(directory).init();t.after(()=>store.close());
  assert.equal(store.summary().requests,1);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory,"connection.json"),"utf8")),auth);
  assert.equal((await stat(path.join(directory,"ledger.sqlite"))).mode&0o777,0o600);
});

test("independent profiles cannot overwrite each other's tokens",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  const second=await store.addAccount("Second Pro");
  await store.accountStore("account-default").setConnection({subject:"a",access_token:"token-a"});
  await store.accountStore(second.id).setConnection({subject:"b",access_token:"token-b"});
  assert.equal(store.accountStore("account-default").connection.access_token,"token-a");
  assert.equal(store.accountStore(second.id).connection.access_token,"token-b");
  await store.accountStore(second.id).setConnection({subject:"b",access_token:"token-b-new"});
  assert.equal(store.connection.access_token,"token-a");
});

test("keys share the unified pool while usage remains attributed to actual accounts",async t=>{
  const seen=[];
  const g=await fixture(t,async(url,options)=>{seen.push(options.headers.authorization);return stream(response("model-a"));});
  const account=await g.store.addAccount("Another Pro");
  const key=await g.store.addAgent({name:"Agent B",allowedModels:["model-a"]});
  const body={model:"model-a",input:"x",stream:false};
  let r=await post(g,"/v1/responses",body,{authorization:"Bearer "+g.store.settings.gatewayKey,"content-type":"application/json"});
  assert.equal(r.status,200);await r.json();
  r=await post(g,"/v1/responses",body,{authorization:"Bearer "+key.apiKey,"content-type":"application/json"});
  assert.equal(r.status,200);await r.json();
  r=await post(g,"/v1/responses",body,{authorization:"Bearer "+key.apiKey,"content-type":"application/json"});
  assert.equal(r.status,200);await r.json();
  assert.deepEqual(seen,["Bearer account-default","Bearer "+account.id,"Bearer account-default"]);
  assert.equal(g.store.report({accountId:account.id}).requests,1);
  assert.equal(g.store.report({agentId:key.agent.id}).outputTokens,10);
  assert.equal(g.store.report({accountId:account.id}).cachedTokens,4);
  const modelBlocked=await post(g,"/v1/responses",{...body,model:"other-model"},{authorization:"Bearer "+key.apiKey,"content-type":"application/json"});
  assert.equal(modelBlocked.status,403);assert.equal(seen.length,3);
});

test("key rotation and disabling revoke only the selected key",async t=>{
  const g=await fixture(t,async()=>stream(response("model-a")));
  const key=await g.store.addAgent({name:"Disposable"});
  const rotated=await g.store.rotateAgent(key.agent.id);
  assert.throws(()=>g.store.authenticate("Bearer "+key.apiKey));
  assert.equal(g.store.authenticate("Bearer "+rotated.apiKey).id,key.agent.id);
  assert.equal(g.store.authenticate("Bearer "+g.store.settings.gatewayKey).id,"agent-default");
  await g.store.updateAgent(key.agent.id,{enabled:false});
  assert.throws(()=>g.store.authenticate("Bearer "+rotated.apiKey));
  assert.ok(!JSON.stringify(g.store.publicAgents()).includes(rotated.apiKey));
  assert.ok(!JSON.stringify(g.store.publicAgents()).includes("keyHash"));
});

test("request limits reserve in-flight calls; unknown usage never becomes free allowance",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  const key=await store.addAgent({name:"Limited",dailyRequests:1,maxConcurrent:2});
  const agent=store.authenticate("Bearer "+key.apiKey);
  const reservation=store.admit(agent,"model-a");
  assert.throws(()=>store.admit(agent,"model-a"),error=>error.code==="local_request_limit");
  await store.record({...reservation,status:"auth_failed",errorCode:"sign_in_required"});
  assert.equal(store.agentUsage(agent).requestsRemaining,1);
  await store.updateAgent(agent.id,{dailyRequests:null,dailyTokenThreshold:50});
  const next=store.authenticate("Bearer "+key.apiKey);
  const attempt=store.admit(next,"model-a");
  await store.record({...attempt,status:"interrupted",usage:null});
  assert.throws(()=>store.admit(next,"model-a"),error=>error.code==="local_token_threshold");
});

test("concurrency settings above 32 are accepted while invalid counts are rejected",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  const key=await store.addAgent({name:"High concurrency",maxConcurrent:64});
  assert.equal(key.agent.maxConcurrent,64);
  const updated=await store.updateAgent(key.agent.id,{maxConcurrent:256});
  assert.equal(updated.maxConcurrent,256);
  for(const value of [0,-1,1.5,Infinity])await assert.rejects(store.updateAgent(key.agent.id,{maxConcurrent:value}),error=>error.code==="invalid_limit");
});

test("manual official quota snapshots are labeled and never overwrite official unknown",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  await store.updateAccount("account-default",{officialSnapshot:{window:"Weekly",remainingPercent:42,resetAt:"2026-10-16T00:00:00Z"}});
  const quota=store.quotaFor("account-default");
  assert.equal(quota.officialRemaining,null);assert.equal(quota.manualSnapshot.source,"manual");
  assert.equal(quota.manualSnapshot.remainingPercent,42);
  assert.equal(localDay(new Date("2026-10-08T16:00:00Z")),"2026-10-09");
});

test("member usage cannot access another key; administrator exports include attribution",async t=>{
  const g=await fixture(t,async()=>stream(response("model-a")));
  const other=await g.store.addAgent({name:"Other"});
  await g.store.record({id:"private-other",time:new Date().toISOString(),accountId:"account-default",agentId:other.agent.id,requestedModel:"model-a",status:"completed",usage:{input_tokens:99,output_tokens:1}});
  const data=await(await fetch(g.origin+"/v1/usage?agentId="+other.agent.id,{headers:{authorization:"Bearer "+g.store.settings.gatewayKey}})).json();
  assert.equal(data.usage.requests,0);
  const headers=await admin(g);
  const exported=await fetch(g.origin+"/api/usage.csv",{headers});
  const text=await exported.text();
  assert.ok(text.includes(other.agent.id));assert.ok(!text.includes(other.apiKey));
  const all=await(await fetch(g.origin+"/api/status",{headers})).json();
  assert.ok(!JSON.stringify(all).includes("access_token"));
});

test("model difference alerts deduplicate and can be acknowledged",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  for(let i=0;i<2;i++)await store.record({id:randomUUID(),time:new Date().toISOString(),accountId:"account-default",agentId:"agent-default",requestedModel:"a",reportedModel:"b",modelCheck:"different",status:"completed",usage:{input_tokens:1,output_tokens:1}});
  assert.equal(store.alerts().length,1);assert.equal(store.alerts()[0].kind,"model_id_difference");
  store.acknowledge(store.alerts()[0].id);assert.equal(store.alerts()[0].acknowledged,1);
});

test("quality grading is deterministic; failures do not become downgrade findings",()=>{
  assert.ok(grade(QUALITY_TASKS.find(task=>task.id==="reference"),'{"b":[1,2,3,5],"a":[1,2,3,4]}'));
  assert.equal(grade(QUALITY_TASKS[0],"not a number"),false);
  const baseline={score:1,correct:18,total:18};
  const low={score:0,correct:0,total:18,failures:0,modelDifferences:0};
  assert.equal(compareQuality(low,baseline,null),"repeat_needed");
  assert.equal(compareQuality(low,baseline,{comparison:"repeat_needed"}),"quality_regression");
  assert.equal(compareQuality({...low,failures:1},baseline,{comparison:"repeat_needed"}),"execution_issue");
  assert.equal(compareQuality({...low,total:6},baseline,null),"baseline_needed");
});

test("quality baseline requires complete same-model runs and scheduling is opt-in",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  const quality=new Quality(store,()=>({status:()=>({sharing:true})}),async()=>{throw new Error("Must not call upstream");});
  await quality.tick();assert.equal(quality.running.size,0);
  const job={id:"baseline",time:new Date().toISOString(),accountId:"account-default",model:"a",configHash:"hash",score:1,correct:18,total:18,failures:0,modelDifferences:0,status:"completed"};
  quality.save(job);quality.setBaseline(job.id);
  assert.equal(quality.history("account-default")[0].baseline,true);
  quality.save({...job,id:"bad",failures:1});
  assert.throws(()=>quality.setBaseline("bad"));
});

test("stopping a quality job or disabling its account prevents subsequent upstream calls",async t=>{
  const store=await new Store(await temp(t)).init();t.after(()=>store.close());
  let calls=0;
  const quality=new Quality(store,()=>({accessToken:async()=>"fake"}),async()=>{calls++;return stream(response("a"));});
  const job={id:"stopped",time:new Date().toISOString(),accountId:"account-default",model:"a",configHash:"hash",config:{rounds:3,effort:"default"},status:"running",progress:0,planned:18,correct:0,total:0,failures:0,score:null,results:[],stopRequested:true};
  await quality.execute(job);assert.equal(calls,0);assert.equal(job.status,"stopped");
  await store.updateAccount("account-default",{enabled:false});
  await quality.execute({...job,id:"disabled",stopRequested:false,status:"running"});
  assert.equal(calls,0);
});
