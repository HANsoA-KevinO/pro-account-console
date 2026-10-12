import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,mkdir,readFile,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {Store,writeJson} from "../lib/storage.mjs";
import {CodexQuotaClient,QuotaSync,normalizeRateLimits,SYNC_INTERVAL_MS} from "../lib/quota.mjs";
import {createGateway} from "../server.mjs";

const reply=(workspace="workspace-a",used=20)=>({accountId:workspace,rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{limitName:"Codex",planType:"pro",primary:{usedPercent:used,windowDurationMins:300,resetsAt:2000000000},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:2000000100},credits:{hasCredits:false,unlimited:false,balance:null}}}});
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),"gateway-quota-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function fixture(t){
  const store=await new Store(await directory(t)).init();t.after(()=>store.close());
  const second=await store.addAccount("Second");
  for(const [id,name]of [["account-default","a"],[second.id,"b"]])await store.accountStore(id).setConnection({subject:"subject-"+name,email:name+"@example.test",access_token:"secret-"+name});
  const calls=[],clients=new Map();let clock=1900000000000;
  const factory=(home,options)=>{
    const id=path.basename(home),isFirst=id==="account-default";
    const client={closed:false,home,options,fail:false,identity:isFirst?"a@example.test":"b@example.test",workspace:isFirst?"workspace-a":"workspace-b",quota:null,
      async start(){await mkdir(home,{recursive:true,mode:0o700});return this;},close(){this.closed=true;},
      async request(method,params){
        calls.push({id,method,params});
        if(method==="account/read")return {account:{type:"chatgpt",email:this.identity,planType:"pro"},workspaceRouting:{chatgptAccountId:this.workspace}};
        if(method==="account/rateLimits/read"){if(this.fail)throw new Error("private-token-do-not-leak");return this.quota||reply(this.workspace,isFirst?20:80);}
        if(method==="account/login/start")return params.type==="chatgptDeviceCode"?{type:"chatgptDeviceCode",loginId:"login-"+id,verificationUrl:"https://auth.openai.com/codex/device",userCode:"ABCD-1234"}:{type:"chatgpt",loginId:"login-"+id,authUrl:"https://auth.openai.com/oauth/authorize?state=test"};
        return {};
      },
    };clients.set(id,client);return client;
  };
  const quota=new QuotaSync(store,{clientFactory:factory,now:()=>clock});t.after(()=>quota.close());
  const bind=async id=>{const connection=store.accountStore(id).connection;await store.saveQuotaState(id,{binding:{subject:connection.subject,email:connection.email,workspaceId:id==="account-default"?"workspace-a":"workspace-b"}});};
  return {store,quota,second,calls,clients,bind,factory,advance:ms=>clock+=ms};
}

test("official windows preserve units and zero; map buckets take precedence over legacy view",()=>{
  const snapshot=normalizeRateLimits(reply(),1900000000000);
  assert.equal(snapshot.source,"codex_app_server");assert.equal(snapshot.scope,"Codex 限额");
  assert.equal(snapshot.buckets.length,1);assert.equal(snapshot.buckets[0].windows[0].remainingPercent,80);
  assert.equal(snapshot.buckets[0].windows[1].remainingPercent,0);
  assert.equal(snapshot.buckets[0].windows[0].windowDurationMins,300);
  assert.equal(snapshot.buckets[0].windows[0].resetAt,new Date(2000000000*1000).toISOString());
  assert.equal(snapshot.buckets[0].credits.balance,null);
  assert.equal(normalizeRateLimits({rateLimits:{primary:null,secondary:null}}).buckets[0].windows.length,0);
  assert.equal(normalizeRateLimits({rateLimits:{primary:{usedPercent:120}}}).buckets[0].windows[0].remainingPercent,0);
  assert.throws(()=>normalizeRateLimits({rateLimits:{primary:{usedPercent:null}}}),error=>error.code==="quota_invalid_response");
});

test("an unlinked profile requires a separate quota authorization, without using global Codex auth",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.quota.sync("account-default"),error=>error.code==="quota_authorization_required");
  assert.equal(f.calls.length,0);assert.equal(f.clients.size,0);
  assert.equal(f.quota.status("account-default").snapshot,null);
});

test("one sync per profile at a time; independent identities and saved snapshots survive restart",async t=>{
  const f=await fixture(t);await f.bind("account-default");await f.bind(f.second.id);
  await Promise.all([f.quota.sync("account-default"),f.quota.sync("account-default"),f.quota.sync(f.second.id)]);
  assert.equal(f.calls.filter(item=>item.method==="account/rateLimits/read").length,2);
  assert.equal(f.quota.status("account-default").snapshot.buckets[0].windows[0].remainingPercent,80);
  assert.equal(f.quota.status(f.second.id).snapshot.buckets[0].windows[0].remainingPercent,20);
  assert.notEqual(f.clients.get("account-default").home,f.clients.get(f.second.id).home);
  assert.equal((await stat(path.join(f.store.directory,"quota-state.json"))).mode&0o777,0o600);
  const persisted=JSON.parse(await readFile(path.join(f.store.directory,"quota-state.json"),"utf8"));
  assert.ok(!JSON.stringify(persisted).includes("secret-"));
  assert.ok(!JSON.stringify(f.quota.status("account-default")).includes("subject-"));
  f.store.quotaStates=persisted;assert.equal(f.quota.status("account-default").connected,true);
});

test("different login email is rejected before quota read and managed auth is disconnected",async t=>{
  const f=await fixture(t);await f.bind("account-default");
  const client=await f.quota.client("account-default");client.identity="b@example.test";
  await assert.rejects(f.quota.sync("account-default"),error=>error.code==="quota_identity_mismatch");
  assert.equal(f.calls.some(item=>item.method==="account/rateLimits/read"),false);
  assert.equal(f.calls.some(item=>item.method==="account/logout"),true);
  assert.equal(f.quota.status("account-default").snapshot,null);
});

test("workspace mismatch never overwrites a previous successful snapshot",async t=>{
  const f=await fixture(t);await f.bind("account-default");await f.quota.sync("account-default");
  const client=f.clients.get("account-default");client.quota=reply("different-workspace");f.advance(60001);
  await assert.rejects(f.quota.sync("account-default"),error=>error.code==="quota_snapshot_identity_mismatch");
  const state=f.quota.status("account-default");assert.equal(state.snapshot.buckets[0].windows[0].remainingPercent,80);assert.equal(state.snapshot.stale,true);
});

test("sync failure keeps stale values, sanitizes errors, and never fabricates refreshed allowance",async t=>{
  const f=await fixture(t);await f.bind("account-default");await f.quota.sync("account-default");f.advance(60001);
  f.clients.get("account-default").fail=true;
  await assert.rejects(f.quota.sync("account-default"),error=>error.code==="quota_sync_failed");
  const state=f.quota.status("account-default");assert.equal(state.snapshot.stale,true);assert.equal(state.snapshot.buckets[0].windows[1].remainingPercent,0);
  assert.ok(!JSON.stringify(state).includes("private-token"));
  assert.equal(f.store.getAccount("account-default").enabled,true);
});

test("expired snapshots and reset windows become stale; an identity change hides cached data",async t=>{
  const f=await fixture(t);await f.bind("account-default");await f.quota.sync("account-default");f.advance(2*SYNC_INTERVAL_MS+1);
  assert.equal(f.quota.status("account-default").snapshot.stale,true);
  f.advance(100000000001);assert.equal(f.quota.status("account-default").snapshot.buckets[0].windows[0].stale,true);
  await f.store.accountStore("account-default").setConnection({subject:"changed",email:"a@example.test",access_token:"replacement"});
  assert.equal(f.quota.status("account-default").snapshot,null);assert.equal(f.quota.status("account-default").connected,false);
});

test("automatic sync includes linked disabled profiles; no model turns or unlinked login is started",async t=>{
  const f=await fixture(t);await f.bind("account-default");await f.store.updateAccount("account-default",{enabled:false});
  await f.quota.tick();assert.equal(f.calls.filter(item=>item.method==="account/rateLimits/read").length,1);
  assert.equal(f.calls.some(item=>item.id===f.second.id),false);
  assert.deepEqual([...new Set(f.calls.map(item=>item.method))],["account/read","account/rateLimits/read"]);
  await f.quota.tick();assert.equal(f.calls.length,2);
});

test("quota login is serialized across profiles and cancellation releases the loopback login slot",async t=>{
  const f=await fixture(t);const first=await f.quota.startLogin("account-default");
  assert.ok(first.authorizationUrl.startsWith("https://auth.openai.com/"));assert.equal(f.quota.status("account-default").status,"awaiting_authorization");
  await assert.rejects(f.quota.startLogin(f.second.id),error=>error.code==="quota_login_busy");
  await f.quota.cancelLogin("account-default");await f.quota.startLogin(f.second.id);
  assert.equal(f.calls.filter(item=>item.method==="account/login/cancel").length,1);
});

test("official managed login completion checks identity and immediately syncs only the selected profile",async t=>{
  const f=await fixture(t);await f.quota.startLogin("account-default");
  await writeJson(path.join(f.clients.get("account-default").home,"auth.json"),{});
  await f.quota.notification("account-default",{method:"account/login/completed",params:{loginId:"login-account-default",success:true}});
  assert.equal(f.quota.status("account-default").connected,true);
  assert.equal(f.quota.status("account-default").snapshot.buckets[0].windows[0].remainingPercent,80);
  assert.equal(f.quota.status(f.second.id).connected,false);
});

test("RPC child isolates auth/config, drops inherited API tokens, restricts operations and sanitizes server errors",async t=>{
  const home=await directory(t),seen=[];let spawned;
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.kill=()=>{};
  child.stdin.on("data",data=>{
    const message=JSON.parse(String(data));seen.push(message);
    if(message.id!==undefined)child.stdout.write(JSON.stringify(message.method==="account/rateLimits/read"?{id:message.id,error:{message:"Bearer do-not-leak",code:-32000}}:{id:message.id,result:{}})+"\n");
  });
  const client=new CodexQuotaClient(home,{binary:"fake-codex",spawnImpl:(binary,args,options)=>{spawned={binary,args,options};return child;}});
  t.after(()=>client.close());await client.start();
  assert.equal(spawned.options.env.CODEX_HOME,home);assert.equal(spawned.options.cwd,home);
  assert.ok(!Object.hasOwn(spawned.options.env,"OPENAI_API_KEY"));assert.ok(spawned.args.includes('cli_auth_credentials_store="file"'));
  await assert.rejects(client.request("thread/start"),error=>error.code==="quota_method_forbidden");
  await assert.rejects(client.request("account/rateLimits/read"),error=>!error.message.includes("do-not-leak"));
  assert.deepEqual(seen.map(item=>item.method),["initialize","initialized","account/rateLimits/read"]);
});

test("admin sync endpoints require cookie+CSRF and expose no private bindings through status",async t=>{
  const f=await fixture(t);
  const g=await createGateway({sessionWebSockets:false,port:0,directory:await directory(t),quotaClientFactory:f.factory});
  t.after(()=>new Promise(resolve=>{g.server.close(resolve);g.server.closeAllConnections();}));
  assert.equal((await fetch(g.origin+"/api/quota/sync",{method:"POST"})).status,401);
  const page=await fetch(g.origin+"/"),html=await page.text(),cookie=page.headers.get("set-cookie").split(";")[0],csrf=html.match(/data-csrf="([^"]+)"/)[1];
  assert.equal((await fetch(g.origin+"/api/quota/sync",{method:"POST",headers:{cookie}})).status,403);
  const r=await fetch(g.origin+"/api/quota/sync",{method:"POST",headers:{cookie,"x-demo-csrf":csrf}});
  assert.equal(r.status,200);assert.equal((await r.json()).results[0].error.code,"quota_identity_required");
  const status=await (await fetch(g.origin+"/api/status",{headers:{cookie}})).json();
  assert.equal(status.accounts[0].quota.automatic.snapshot,null);
  assert.ok(!JSON.stringify(status).includes("binding"));
});


test("remote quota sign-in uses device codes, deduplicates requests and still verifies account identity",async t=>{
  const f=await fixture(t),result=await f.quota.startLogin("account-default",{deviceCode:true});
  assert.equal(result.mode,"device_code");assert.equal(result.authorizationUrl,"https://auth.openai.com/codex/device");assert.equal(result.userCode,"ABCD-1234");
  assert.deepEqual(await f.quota.startLogin("account-default",{deviceCode:true}),result);
  assert.equal(f.calls.filter(x=>x.method==="account/login/start").length,1);assert.equal(f.calls.find(x=>x.method==="account/login/start").params.type,"chatgptDeviceCode");
  await writeJson(path.join(f.clients.get("account-default").home,"auth.json"),{});
  await f.quota.notification("account-default",{method:"account/login/completed",params:{loginId:"login-account-default",success:true}});
  assert.equal(f.quota.login,null);assert.equal(f.quota.status("account-default").connected,true);
  assert.ok(!JSON.stringify(f.store.auditLog()).includes(result.userCode));
});
