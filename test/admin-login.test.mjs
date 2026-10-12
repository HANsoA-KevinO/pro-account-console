import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createGateway} from "../server.mjs";
import {OAuth,ISSUER,RESOURCE} from "../lib/oauth.mjs";

const credentials={username:"admin",password:"form-login-fixture"};
async function fixture(t,options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-login-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const g=await createGateway({port:0,directory,requireAdmin:true,adminAuth:credentials,...options});t.after(()=>g.close());
  const request=(route,opts={})=>fetch(g.origin+route,{redirect:"manual",...opts});
  const login=(body=credentials,headers={})=>request("/auth/admin/login",{method:"POST",headers:{origin:g.origin,"content-type":"application/json",...headers},body:JSON.stringify(body)});
  return {...g,request,login};
}

test("form login has no HTTP challenge, stores only a cookie and supports password-manager inputs",async t=>{
  const g=await fixture(t),root=await g.request("/");assert.equal(root.status,303);assert.equal(root.headers.get("location"),"/login");assert.equal(root.headers.get("www-authenticate"),null);
  const page=await g.request("/login"),html=await page.text();assert.equal(page.status,200);assert.ok(html.includes('autocomplete="current-password"'));assert.ok(!html.includes(credentials.password));assert.ok(page.headers.get("content-security-policy").includes("form-action 'self'"));
  for(const route of ["/login.js","/login.css"])assert.equal((await g.request(route)).status,200);
  assert.equal((await g.request("/app.js")).status,403);
  const wrong=await g.login({...credentials,password:"wrong"});assert.equal(wrong.status,401);assert.equal(wrong.headers.get("www-authenticate"),null);assert.equal((await wrong.json()).error.code,"invalid_credentials");assert.equal(wrong.headers.get("set-cookie"),null);
  const login=await g.login(),cookie=login.headers.get("set-cookie").split(";")[0];assert.equal(login.status,200);assert.ok(login.headers.get("set-cookie").includes("HttpOnly; SameSite=Lax"));assert.ok(!JSON.stringify(await login.json()).includes(credentials.password));
  const home=await g.request("/",{headers:{cookie}});assert.equal(home.status,200);const csrf=(await home.text()).match(/data-csrf="([^"]+)"/)[1];
  assert.equal((await g.request("/login",{headers:{cookie}})).status,303);
  assert.equal((await g.request("/api/admin/logout",{method:"POST",headers:{cookie,"content-type":"application/json"},body:"{}"})).status,403);
  const logout=await g.request("/api/admin/logout",{method:"POST",headers:{cookie,"x-demo-csrf":csrf,"content-type":"application/json"},body:"{}"});assert.equal(logout.status,200);assert.ok(logout.headers.get("set-cookie").includes("Max-Age=0"));
  assert.equal((await g.request("/api/status",{headers:{cookie}})).status,403);
  // Previously cached Basic credentials must not silently sign the user back in.
  assert.equal((await g.request("/",{headers:{cookie,authorization:"Basic "+Buffer.from(credentials.username+":"+credentials.password).toString("base64")}})).status,303);
});

test("login rejects cross-origin submissions and excessive attempts; successful login rotates the session",async t=>{
  const g=await fixture(t);
  assert.equal((await g.login(credentials,{origin:"https://evil.invalid"})).status,403);
  assert.equal((await g.login(credentials,{origin:""})).status,403);
  assert.equal((await g.login(credentials,{"content-type":"text/plain"})).status,403);
  const first=await g.login(),cookie=first.headers.get("set-cookie").split(";")[0],second=await g.login(credentials,{cookie});assert.equal(second.status,200);assert.notEqual(second.headers.get("set-cookie").split(";")[0],cookie);assert.equal((await g.request("/api/status",{headers:{cookie}})).status,403);
  for(let i=0;i<10;i++)assert.equal((await g.login({...credentials,password:"wrong"})).status,401);
  const limited=await g.login();assert.equal(limited.status,429);assert.ok(Number(limited.headers.get("retry-after"))>0);assert.equal(limited.headers.get("www-authenticate"),null);
});

test("manual callback completion validates the exact loopback URL, session binding, expiry and one-time state",async()=>{
  const connection={client_id:"client_test"},store={connection,settings:{hostId:"host_test"}};
  const oauth=new OAuth(store,{redirectUri:"http://127.0.0.1:18787/auth/callback"});
  oauth.discovery={authorization_endpoint:ISSUER+"/authorize",token_endpoint:ISSUER+"/token",jwks_uri:ISSUER+"/jwks"};
  let exchanges=0;
  oauth.callback=async (parameters,browser)=>{const {transaction,code}=oauth.consume(parameters,browser);assert.equal(transaction.browser,"browser-session");assert.equal(code,"one-time-code");exchanges++;};
  const start=await oauth.start({browser:"browser-session"}),state=new URL(start.url).searchParams.get("state"),callback=oauth.redirectUri+"?"+new URLSearchParams({state,code:"one-time-code",client_id:"client_test"});
  assert.equal(new URL(start.url).searchParams.get("resource"),RESOURCE);
  for(const value of [callback.replace("127.0.0.1","localhost"),callback.replace("18787","1455"),callback.replace("/auth/callback","/callback"),callback+"#fragment",callback+"&state=duplicate","invalid"]){await assert.rejects(oauth.completeRemote(value,"browser-session"),x=>x.code==="invalid_callback_url");}
  assert.equal(exchanges,0);await oauth.completeRemote(callback,"browser-session");assert.equal(exchanges,1);
  await assert.rejects(oauth.completeRemote(callback,"browser-session"),x=>x.code==="invalid_state");
  const second=await oauth.start({browser:"browser-session"}),secondState=new URL(second.url).searchParams.get("state");
  await assert.rejects(oauth.completeRemote(oauth.redirectUri+"?"+new URLSearchParams({state:secondState,code:"one-time-code",client_id:"client_test"}),"other-browser"),x=>x.code==="invalid_state");
  const third=await oauth.start({browser:"browser-session"}),thirdState=new URL(third.url).searchParams.get("state");oauth.pending.get(thirdState).expiresAt=Date.now()-1;
  await assert.rejects(oauth.completeRemote(oauth.redirectUri+"?"+new URLSearchParams({state:thirdState,code:"one-time-code",client_id:"client_test"}),"browser-session"),x=>x.code==="invalid_state");
  assert.equal(exchanges,1);
});
