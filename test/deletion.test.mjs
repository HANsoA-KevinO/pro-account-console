import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,access} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {Store,writeJson} from "../lib/storage.mjs";
import {createGateway} from "../server.mjs";

async function dir(t){const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-delete-test-"));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function admin(g){const r=await fetch(g.origin+"/"),html=await r.text();return {cookie:r.headers.get("set-cookie").split(";")[0],"x-demo-csrf":html.match(/data-csrf="([^"]+)"/)[1],"content-type":"application/json"};}
async function fixture(t){
  const g=await createGateway({sessionWebSockets:false,directory:await dir(t),port:0,oauthFactory:(_profile,id)=>({pending:new Map(),status:()=>({connected:true,sharing:true,email:id+"@example.test"}),accessToken:async()=>id}),fetchImpl:async(url,options)=>{
    if(url.endsWith("/models"))return Response.json({models:[{slug:"m",visibility:"list"}]});
    const model=JSON.parse(options.body).model;
    return new Response("data: "+JSON.stringify({type:"response.completed",response:{id:"r",model,status:"completed",output:[{type:"message",content:[{type:"output_text",text:"ok"}]}],usage:{input_tokens:2,output_tokens:1}}})+"\n\n",{headers:{"content-type":"text/event-stream"}});
  }});
  t.after(()=>new Promise(resolve=>{g.server.close(resolve);g.server.closeAllConnections();}));
  const headers=await admin(g);
  return {...g,headers,remove:id=>fetch(g.origin+"/api/accounts/"+id+"/delete",{method:"POST",headers})};
}

test("deletion clears only the selected profile credentials and quota; logs, keys and other identities remain",async t=>{
  const store=await new Store(await dir(t)).init();t.after(()=>store.close());
  const b=await store.addAccount("Disposable"),c=await store.addAccount("Keep");
  await store.accountStore(b.id).setConnection({subject:"b",access_token:"secret-b"});
  await store.accountStore(c.id).setConnection({subject:"c",access_token:"secret-c"});
  const staleProfile=store.accountStore(b.id),authFile=store.accountFile(b.id);
  const nativeFile=path.join(store.directory,"quota-runtime",b.id,"auth.json");
  await writeJson(nativeFile,{tokens:{access_token:"native-b"}});
  await store.saveQuotaState(b.id,{snapshot:{buckets:[]},binding:{subject:"b"}});
  await store.saveQuotaState(c.id,{snapshot:{buckets:[{id:"keep"}]}});
  store.recordSync({id:"history",time:new Date().toISOString(),accountId:b.id,agentId:"agent-default",requestedModel:"m",status:"completed",usage:{input_tokens:2,output_tokens:1}});
  const previousKey=store.settings.gatewayKey;
  assert.deepEqual(await store.deleteAccount(b.id),{ok:true});
  assert.throws(()=>store.getAccount(b.id),error=>error.code==="account_not_found");
  await assert.rejects(access(authFile));await assert.rejects(access(nativeFile));
  assert.equal(store.quotaStates[b.id],undefined);assert.equal(store.quotaStates[c.id].snapshot.buckets[0].id,"keep");
  assert.equal(store.accountStore(c.id).connection.access_token,"secret-c");
  assert.equal(store.authenticate("Bearer "+previousKey).id,"agent-default");
  assert.equal(store.report({accountId:b.id}).requests,1);
  assert.equal(store.management.deletedAccounts[0].name,"Disposable");
  await assert.rejects(staleProfile.setConnection({access_token:"late-token"}),error=>error.code==="account_not_found");
  await assert.rejects(access(authFile));assert.equal(store.connections.has(b.id),false);
});

test("deleting the original and final profile persists an empty pool across restart, and adding a profile restores management",async t=>{
  const directory=await dir(t);let store=await new Store(directory).init();
  await store.setConnection({access_token:"old-owner"});const key=store.settings.gatewayKey;
  await store.deleteAccount("account-default");store.close();
  store=await new Store(directory).init();t.after(()=>store.close());
  assert.equal(store.management.accounts.length,0);assert.equal(store.management.activeAccountId,null);assert.equal(store.connection,null);
  await assert.rejects(access(store.authFile));assert.equal(store.settings.gatewayKey,key);
  const account=await store.addAccount("New owner");assert.equal(store.management.activeAccountId,account.id);
  assert.notEqual(account.id,"account-default");
});

test("removal blocks new routing and prevents queued/late credential and quota writes",async t=>{
  const store=await new Store(await dir(t)).init();t.after(()=>store.close());
  const b=await store.addAccount("B"),agent=store.authenticate("Bearer "+store.settings.gatewayKey);
  store.removingAccounts.add("account-default");
  assert.equal(store.resolveRoute(agent,"m").accountId,b.id);
  await assert.rejects(store.setConnection({access_token:"late"}),error=>error.code==="account_deleting");
  await assert.rejects(store.saveQuotaState("account-default",{snapshot:{}}),error=>error.code==="account_deleting");
  assert.equal(store.connection,null);assert.equal(store.quotaStates["account-default"],undefined);
});

test("admin deletion is protected and removes the profile from models/routing without changing the shared key",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B");
  const url=g.origin+"/api/accounts/account-default/delete";
  assert.equal((await fetch(url,{method:"POST"})).status,401);
  assert.equal((await fetch(url,{method:"POST",headers:{cookie:g.headers.cookie}})).status,403);
  g.getOAuth("account-default").pending.set("old-state",{});
  const old=g.getOAuth("account-default");
  assert.equal((await g.remove("account-default")).status,200);assert.equal(old.pending.size,0);
  const status=await (await fetch(g.origin+"/api/status",{headers:g.headers})).json();
  assert.equal(status.accounts.length,1);assert.equal(status.activeAccountId,b.id);assert.equal(status.deletedAccounts[0].id,"account-default");
  const response=await fetch(g.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+g.store.settings.gatewayKey,"content-type":"application/json"},body:JSON.stringify({model:"m",input:"x",stream:false})});
  assert.equal(response.status,200);assert.equal(response.headers.get("x-gateway-account-id"),b.id);await response.json();
  assert.equal((await g.remove("account-default")).status,404);
  assert.equal((await g.remove(b.id)).status,200);
  assert.equal((await fetch(g.origin+"/api/status",{headers:g.headers})).status,200);
  const health=await (await fetch(g.origin+"/healthz")).json();assert.equal(health.connected,false);
  assert.equal((await fetch(g.origin+"/v1/models",{headers:{authorization:"Bearer "+g.store.settings.gatewayKey}})).status,503);
});

test("active requests, quality jobs and quota reads block deletion before any credential cleanup",async t=>{
  const g=await fixture(t);
  await g.store.setConnection({access_token:"keep-during-busy"});
  const pending={id:"busy",time:new Date().toISOString(),accountId:"account-default",requestedModel:"m",status:"pending"};g.store.recordSync(pending);
  let r=await g.remove("account-default");assert.equal(r.status,409);assert.equal((await r.json()).error.code,"account_busy");
  g.store.recordSync({...pending,status:"completed",usage:{input_tokens:1,output_tokens:1}});
  g.quality.running.set("account-default",{});assert.equal((await g.remove("account-default")).status,409);g.quality.running.delete("account-default");
  g.fingerprints.running.set("account-default",{});assert.equal((await g.remove("account-default")).status,409);g.fingerprints.running.delete("account-default");
  g.quota.running.set("account-default",Promise.resolve());assert.equal((await g.remove("account-default")).status,409);g.quota.running.delete("account-default");
  assert.equal(g.store.connection.access_token,"keep-during-busy");assert.equal(g.store.management.accounts.length,1);
});

test("deleting a profile stops its pending quota login/runtime and preserves other runtime sessions",async t=>{
  const g=await fixture(t),b=await g.store.addAccount("B");
  const removed={closed:false,close(){this.closed=true;}},kept={closed:false,close(){this.closed=true;}};
  g.quota.clients.set("account-default",Promise.resolve(removed));g.quota.clients.set(b.id,Promise.resolve(kept));
  g.quota.login={accountId:"account-default",loginId:"pending-login",timer:setTimeout(()=>{},60000)};
  assert.equal((await g.remove("account-default")).status,200);
  assert.equal(removed.closed,true);assert.equal(kept.closed,false);assert.equal(g.quota.login,null);
  assert.equal(g.quota.clients.has("account-default"),false);assert.equal(g.quota.clients.has(b.id),true);
});
