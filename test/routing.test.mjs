import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createGateway} from "../server.mjs";
import {Store,writeJson,readJson} from "../lib/storage.mjs";

async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),"routing-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function fixture(t,{fail=false,paused=new Set()}={}){
  const calls=[];
  const gateway=await createGateway({sessionWebSockets:false,
    directory:await directory(t),port:0,
    oauthFactory:(_store,id)=>({status:()=>({connected:!paused.has(id),sharing:!paused.has(id)}),accessToken:async()=>id}),
    fetchImpl:async(url,options)=>{
      if(url.endsWith("/models"))return Response.json({models:[{slug:"m",visibility:"list",display_name:"M"}]});
      calls.push(options.headers.authorization.slice(7));
      const body=JSON.parse(options.body);
      const response=fail?{status:"failed",model:body.model,error:{code:"subscription_sharing_usage_limit_exceeded"}}:{id:"resp_test",object:"response",status:"completed",model:body.model,output:[{type:"message",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:3,output_tokens:2}};
      return new Response("data: "+JSON.stringify({type:fail?"response.failed":"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
    },
  });
  t.after(()=>new Promise(resolve=>{gateway.server.close(resolve);gateway.server.closeAllConnections();}));
  const send=(key=gateway.store.settings.gatewayKey,model="m")=>fetch(gateway.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model,input:"hello",stream:false})});
  return {...gateway,calls,send};
}

test("one key round-robins across all accounts and new accounts join automatically",async t=>{
  const g=await fixture(t);
  const b=await g.store.addAccount("B"),c=await g.store.addAccount("C");
  for(let i=0;i<4;i++){const r=await g.send();assert.equal(r.status,200);await r.json();}
  assert.deepEqual(g.calls,["account-default",b.id,c.id,"account-default"]);
  const key=await g.store.addAgent({name:"Unbound"});
  assert.equal(Object.hasOwn(key.agent,"accountId"),false);
  assert.equal(Object.hasOwn(g.store.authenticate("Bearer "+key.apiKey),"accountId"),false);
  const r=await g.send(key.apiKey);await r.json();
  assert.equal(g.calls.at(-1),b.id);
  assert.equal(g.store.records.at(-1).routeId,"route-default");
  assert.equal(g.store.records.at(-1).accountId,b.id);
});

test("disabled and unauthorised accounts are excluded without changing the key",async t=>{
  const paused=new Set(),g=await fixture(t,{paused});
  const b=await g.store.addAccount("B"),c=await g.store.addAccount("C");
  await g.store.updateAccount(b.id,{enabled:false});paused.add(c.id);
  for(let i=0;i<2;i++)await(await g.send()).json();
  assert.deepEqual(g.calls,["account-default","account-default"]);
  paused.add("account-default");
  const result=await g.send();
  assert.equal(result.status,503);assert.equal(g.calls.length,2);
  assert.equal(g.store.alerts()[0].kind,"routing_unavailable");
});

test("all keys share one pool; obsolete route configuration cannot override it",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B");
  const key=await g.store.addAgent({name:"Special"});
  await assert.rejects(g.store.addRoute({name:"Special model",priority:10,keyIds:[key.agent.id],models:["m"],accountScope:"selected",accountIds:[b.id],strategy:"first"}),error=>error.status===410);
  await assert.rejects(g.store.updateRoute("route-default",{strategy:"first"}),error=>error.status===410);
  await assert.rejects(g.store.deleteRoute("route-default"),error=>error.status===410);
  await(await g.send(key.apiKey)).json();await(await g.send()).json();
  assert.deepEqual(g.calls,["account-default",b.id]);
});

test("model catalog and preview do not consume a round-robin position",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B");
  const catalog=await fetch(g.origin+"/v1/models",{headers:{authorization:"Bearer "+g.store.settings.gatewayKey}});
  assert.equal(catalog.status,200);assert.equal((await catalog.json()).data[0].id,"m");
  const key=g.store.authenticate("Bearer "+g.store.settings.gatewayKey);
  for(let i=0;i<3;i++)assert.equal(g.store.resolveRoute(key,"m",{advance:false}).accountId,"account-default");
  await(await g.send()).json();await(await g.send()).json();
  assert.deepEqual(g.calls,["account-default",b.id]);
});

test("upstream quota failure is returned after exactly one attempt, without hidden retry",async t=>{
  const g=await fixture(t,{fail:true});
  await g.store.addAccount("B");
  const response=await g.send();
  assert.equal(response.status,429);await response.json();
  assert.equal(g.calls.length,1);
  assert.equal(g.store.records.length,1);
});

test("limits count across all routed accounts and permission rejection does not advance routing",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B");
  const key=await g.store.addAgent({name:"Limited",allowedModels:["m"],dailyRequests:2});
  let result=await g.send(key.apiKey,"denied");assert.equal(result.status,403);
  for(let i=0;i<2;i++){result=await g.send(key.apiKey);assert.equal(result.status,200);await result.json();}
  result=await g.send(key.apiKey);assert.equal(result.status,429);
  assert.deepEqual(g.calls,["account-default",b.id]);
});

test("v2 migration removes bindings without rotating keys or changing credentials",async t=>{
  const dir=await directory(t);
  let store=await new Store(dir).init();
  const b=await store.addAccount("B"),key=await store.addAgent({name:"Old key"});
  const old=structuredClone(store.management);delete old.routes;old.version=2;
  old.agents.forEach(agent=>{agent.accountId=b.id;});
  await store.setConnection({access_token:"fixture-token",subject:"owner"});
  store.close();await writeJson(path.join(dir,"management.json"),old);
  store=await new Store(dir).init();t.after(()=>store.close());
  assert.equal(store.management.version,4);
  assert.equal(store.authenticate("Bearer "+key.apiKey).name,"Old key");
  assert.equal(Object.hasOwn(store.authenticate("Bearer "+key.apiKey),"accountId"),false);
  assert.equal(store.connection.access_token,"fixture-token");
  assert.equal(store.management.routes[0].accountScope,"all");
  assert.equal((await readJson(path.join(dir,"backups","management-before-global-pool.json"))).version,2);
  await assert.rejects(store.addAgent({name:"Wrong",accountId:b.id}),error=>error.code==="key_account_binding_removed");
});

test("v3 custom routing is backed up and replaced by one global pool",async t=>{
  const dir=await directory(t);
  let store=await new Store(dir).init();
  const b=await store.addAccount("B"),key=await store.addAgent({name:"Retained key"});
  const legacy=structuredClone(store.management);legacy.version=3;
  legacy.routes.unshift({id:"legacy-special",name:"Old specific route",priority:1,enabled:true,keyIds:[key.agent.id],models:[],accountScope:"selected",accountIds:[b.id],strategy:"first",createdAt:new Date().toISOString()});
  store.close();await writeJson(path.join(dir,"management.json"),legacy);
  store=await new Store(dir).init();t.after(()=>store.close());
  assert.equal(store.management.routes.length,1);
  assert.equal(store.management.routes[0].accountScope,"all");
  const agent=store.authenticate("Bearer "+key.apiKey);
  assert.equal(store.resolveRoute(agent,"m",{advance:true}).accountId,"account-default");
  assert.equal(store.resolveRoute(agent,"m",{advance:true}).accountId,b.id);
  const backup=await readJson(path.join(dir,"backups","management-before-global-pool.json"));
  assert.equal(backup.routes.length,2);
});
