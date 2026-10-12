import test from "node:test";
import assert from "node:assert/strict";
import {request} from "node:http";
import {mkdtemp,rm,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createGateway} from "../server.mjs";
import {isPrivateIPv4,discoverLanAddress,loadLanAuth,readLanAuth,validateLanAuth,acceptsBasicAuth} from "../lib/network.mjs";
import {writeJson} from "../lib/storage.mjs";

const auth={username:"admin",password:"test-only-long-password"};
const basic="Basic "+Buffer.from(auth.username+":"+auth.password).toString("base64");
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),"gateway-lan-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function send(origin,route,headers={},body){return new Promise((resolve,reject)=>{
  const req=request(new URL(route,origin),{method:body===undefined?"GET":"POST",headers},res=>{let text="";res.setEncoding("utf8");res.on("data",chunk=>text+=chunk);res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,text}));});
  req.on("error",reject);req.end(body===undefined?undefined:JSON.stringify(body));
});}

test("LAN discovery selects private IPv4 and never defaults to public or VPN benchmark addresses",()=>{
  for(const address of ["10.1.2.3","172.16.0.2","172.31.255.254","192.168.3.185"])assert.equal(isPrivateIPv4(address),true);
  for(const address of ["127.0.0.1","0.0.0.0","198.18.0.1","172.32.0.1","8.8.8.8","192.168.1.999","::1"])assert.equal(isPrivateIPv4(address),false);
  assert.equal(discoverLanAddress({utun4:[{family:"IPv4",internal:false,address:"198.18.0.1"}],en0:[{family:"IPv4",internal:false,address:"192.168.3.185"}]}),"192.168.3.185");
  assert.throws(()=>discoverLanAddress({lo0:[{family:"IPv4",internal:true,address:"127.0.0.1"}]}));
});

test("LAN administrator credentials persist privately and accept only the exact Basic credential",async t=>{
  const dir=await temporary(t),first=await loadLanAuth(dir),second=await loadLanAuth(dir);
  assert.deepEqual(first,second);assert.ok(first.password.length>=24);assert.equal((await stat(path.join(dir,"lan-admin.json"))).mode&0o777,0o600);
  assert.equal(acceptsBasicAuth(basic,auth),true);
  for(const header of [undefined,"Bearer key","Basic !!!","Basic "+Buffer.from("other:"+auth.password).toString("base64"),"Basic "+Buffer.from("admin:wrong").toString("base64")])assert.equal(acceptsBasicAuth(header,auth),false);
  assert.equal(validateLanAuth({username:"admin",password:"chosen"}).password,"chosen");
  assert.throws(()=>validateLanAuth({username:"admin",password:""}));
  assert.throws(()=>validateLanAuth({username:"admin:other",password:auth.password}));
  await assert.rejects(createGateway({sessionWebSockets:false,directory:dir,lanAddress:"0.0.0.0",adminAuth:auth}));
  await assert.rejects(createGateway({sessionWebSockets:false,directory:dir,lanAddress:"192.168.3.185"}));
});

test("LAN management is password protected, sessions stay origin scoped, and Responses still uses agent keys",async t=>{
  let lanAddress;try{lanAddress=discoverLanAddress();}catch{t.skip("No private LAN interface on this host");return;}
  let calls=0;
  const g=await createGateway({sessionWebSockets:false,directory:await temporary(t),port:0,lanAddress,adminAuth:auth,
    oauthFactory:()=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>"mock-upstream-token"}),
    fetchImpl:async(_url,options)=>{calls++;const body=JSON.parse(options.body);return new Response("data: "+JSON.stringify({type:"response.completed",response:{id:"resp_lan",model:body.model,status:"completed",output:[],usage:{input_tokens:1,output_tokens:1}}})+"\n\n",{headers:{"content-type":"text/event-stream"}});},
  });
  t.after(()=>g.close());
  assert.equal(g.server.address().address,"127.0.0.1");assert.equal(g.lanServer.address().address,lanAddress);
  const denied=await send(g.lanOrigin,"/");assert.equal(denied.status,401);assert.ok(denied.headers["www-authenticate"].startsWith("Basic "));assert.equal(denied.headers["set-cookie"],undefined);
  assert.equal((await send(g.lanOrigin,"/app.js")).status,403);
  assert.equal((await send(g.lanOrigin,"/api/status",{authorization:"Bearer "+g.store.settings.gatewayKey})).status,403);
  assert.equal((await send(g.lanOrigin,"/healthz",{host:"evil.example",authorization:basic})).status,403);
  assert.equal((await send(g.lanOrigin,"/healthz",{host:new URL(g.origin).host,authorization:basic})).status,403);
  const local=await send(g.origin,"/"),localCookie=local.headers["set-cookie"][0].split(";")[0];assert.equal(local.status,200);
  assert.equal((await send(g.lanOrigin,"/api/status",{authorization:basic,cookie:localCookie})).status,403);
  const page=await send(g.lanOrigin,"/",{authorization:basic}),cookie=page.headers["set-cookie"][0].split(";")[0],csrf=page.text.match(/data-csrf="([^"]+)"/)[1];
  assert.equal(page.status,200);assert.ok(!page.text.includes(auth.password));
  const headers={authorization:basic,cookie,"x-demo-csrf":csrf,"content-type":"application/json",origin:g.lanOrigin};
  const status=await send(g.lanOrigin,"/api/status",headers);assert.equal(status.status,200);assert.equal(JSON.parse(status.text).baseUrl,g.lanOrigin+"/v1");
  assert.equal((await send(g.lanOrigin,"/api/status",{cookie})).status,200);
  assert.equal((await send(g.lanOrigin,"/app.js",{cookie})).status,200);
  assert.equal((await send(g.lanOrigin,"/style.css",{cookie})).status,200);
  assert.equal((await send(g.lanOrigin,"/api/status",{...headers,origin:g.origin})).status,403);
  assert.equal((await send(g.lanOrigin,"/api/keys",{...headers,"x-demo-csrf":"wrong"},{name:"fail"})).status,403);
  assert.equal((await send(g.lanOrigin,"/api/accounts/account-default/login",headers,{})).status,403);
  assert.equal((await send(g.lanOrigin,"/api/accounts/account-default/quota/login",headers,{})).status,403);
  assert.equal((await send(g.lanOrigin,"/auth/callback?state=anything",headers)).status,403);
  assert.equal((await send(g.lanOrigin,"/v1/responses",{authorization:basic},{model:"m",input:"x"})).status,401);
  const response=await send(g.lanOrigin,"/v1/responses",{authorization:"Bearer "+g.store.settings.gatewayKey,"content-type":"application/json"},{model:"m",input:"x",stream:false});
  assert.equal(response.status,200);assert.equal(JSON.parse(response.text).id,"resp_lan");assert.equal(calls,1);
});

test("editing the LAN password takes effect without restart and invalid configuration never falls back to the old password",async t=>{
  let lanAddress;try{lanAddress=discoverLanAddress();}catch{t.skip("No private LAN interface on this host");return;}
  const directory=await temporary(t),file=path.join(directory,"lan-admin.json");await writeJson(file,auth);
  const g=await createGateway({sessionWebSockets:false,directory,port:0,lanAddress,adminAuth:auth,adminAuthLoader:()=>readLanAuth(directory)});
  t.after(()=>g.close());
  assert.equal((await send(g.lanOrigin,"/",{authorization:basic})).status,200);
  const updated={username:"admin",password:"chosen"};await writeJson(file,updated);
  assert.equal((await send(g.lanOrigin,"/",{authorization:basic})).status,401);
  const newBasic="Basic "+Buffer.from(updated.username+":"+updated.password).toString("base64");
  assert.equal((await send(g.lanOrigin,"/",{authorization:newBasic})).status,200);
  await writeJson(file,{username:"admin",password:""});
  assert.equal((await send(g.lanOrigin,"/",{authorization:newBasic})).status,503);
  assert.equal((await send(g.origin,"/")).status,200);
  await writeJson(file,updated);
  assert.equal((await send(g.lanOrigin,"/",{authorization:newBasic})).status,200);
});

test("LAN administrator login and CSRF survive restart, while stale API sessions never issue a browser challenge",async t=>{
  let lanAddress;try{lanAddress=discoverLanAddress();}catch{t.skip("No private LAN interface on this host");return;}
  const directory=await temporary(t);
  const first=await createGateway({sessionWebSockets:false,directory,port:0,lanAddress,adminAuth:auth});t.after(()=>first.close());
  const page=await send(first.lanOrigin,"/",{authorization:basic}),cookie=page.headers["set-cookie"][0].split(";")[0],csrf=page.text.match(/data-csrf="([^"]+)"/)[1];
  const rawCookie=cookie.slice(cookie.indexOf("=")+1);
  const saved=first.store.db.prepare("SELECT * FROM admin_sessions").get();assert.notEqual(saved.id_hash,rawCookie);assert.equal(saved.id_hash.length,64);
  const port=first.server.address().port;await first.close();
  const second=await createGateway({sessionWebSockets:false,directory,port,lanAddress,adminAuth:auth});t.after(()=>second.close());
  assert.equal((await send(second.lanOrigin,"/api/status",{cookie})).status,200);
  assert.equal((await send(second.lanOrigin,"/api/accounts",{cookie,"x-demo-csrf":csrf,"content-type":"application/json",origin:second.lanOrigin},{name:"After restart"})).status,201);
  const invalidCookie="ag_admin="+"x".repeat(43);
  for(const headers of [{cookie:invalidCookie},{cookie:invalidCookie,authorization:basic}]){
    const r=await send(second.lanOrigin,"/api/status",headers);assert.equal(r.status,403);assert.equal(r.headers["www-authenticate"],undefined);
  }
  second.store.db.prepare("UPDATE admin_sessions SET expires_at=?").run(Date.now()-1);
  const expired=await send(second.lanOrigin,"/api/status",{cookie});assert.equal(expired.status,403);assert.equal(expired.headers["www-authenticate"],undefined);
  const root=await send(second.lanOrigin,"/",{cookie});assert.equal(root.status,401);assert.ok(root.headers["www-authenticate"]);
  const renewed=await send(second.lanOrigin,"/",{authorization:basic});assert.equal(renewed.status,200);
});

test("changing the LAN password revokes existing cookies and accepts a new login without repeated API challenges",async t=>{
  let lanAddress;try{lanAddress=discoverLanAddress();}catch{t.skip("No private LAN interface on this host");return;}
  const directory=await temporary(t),file=path.join(directory,"lan-admin.json");await writeJson(file,auth);
  const g=await createGateway({sessionWebSockets:false,directory,port:0,lanAddress,adminAuth:auth,adminAuthLoader:()=>readLanAuth(directory)});t.after(()=>g.close());
  const page=await send(g.lanOrigin,"/",{authorization:basic}),cookie=page.headers["set-cookie"][0].split(";")[0];
  assert.equal((await send(g.lanOrigin,"/api/status",{cookie})).status,200);
  const next={username:"admin",password:"changed"};await writeJson(file,next);
  const revoked=await send(g.lanOrigin,"/api/status",{cookie,authorization:basic});assert.equal(revoked.status,403);assert.equal(revoked.headers["www-authenticate"],undefined);
  const newBasic="Basic "+Buffer.from(next.username+":"+next.password).toString("base64");
  const newPage=await send(g.lanOrigin,"/",{authorization:newBasic,cookie}),newCookie=newPage.headers["set-cookie"][0].split(";")[0];
  assert.notEqual(newCookie,cookie);assert.equal((await send(g.lanOrigin,"/api/status",{cookie:newCookie})).status,200);
});

test("account authorization errors on LAN management APIs do not trigger HTTP Basic prompts",async t=>{
  let lanAddress;try{lanAddress=discoverLanAddress();}catch{t.skip("No private LAN interface on this host");return;}
  const g=await createGateway({sessionWebSockets:false,directory:await temporary(t),port:0,lanAddress,adminAuth:auth});t.after(()=>g.close());
  const page=await send(g.lanOrigin,"/",{authorization:basic}),cookie=page.headers["set-cookie"][0].split(";")[0];
  const r=await send(g.lanOrigin,"/api/models?accountId=account-default",{cookie});
  assert.equal(r.status,403);assert.equal(JSON.parse(r.text).error.code,"sign_in_required");assert.equal(r.headers["www-authenticate"],undefined);
});
