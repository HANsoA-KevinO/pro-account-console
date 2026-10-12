import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {request as sendHttp} from "node:http";
import {runtimeConfig,publicOrigin} from "../lib/runtime.mjs";
import {createGateway} from "../server.mjs";
import {OAuth,ISSUER} from "../lib/oauth.mjs";

test("runtime defaults preserve local startup and all deployment settings are explicit",()=>{
  const local=runtimeConfig("/app",{},[]);assert.equal(local.directory,"/app/.data");assert.equal(local.port,8787);assert.equal(local.requireAdmin,false);assert.equal(local.transport,"http");
  const deployed=runtimeConfig("/app",{GATEWAY_PORT:"9876",GATEWAY_DATA_DIR:"/var/lib/gateway",GATEWAY_PUBLIC_URL:"https://gateway.example.com/",GATEWAY_REQUIRE_ADMIN:"false"},[]);
  assert.equal(deployed.port,9876);assert.equal(deployed.directory,"/var/lib/gateway");assert.equal(deployed.publicUrl,"https://gateway.example.com");assert.equal(deployed.requireAdmin,true);
  assert.equal(runtimeConfig("/app",{GATEWAY_BIND_HOST:"0.0.0.0",GATEWAY_REQUIRE_ADMIN:"false"},[]).requireAdmin,true);
  assert.equal(runtimeConfig("/app",{},["--server"]).requireAdmin,true);
  assert.equal(runtimeConfig("/app",{GATEWAY_DEMO_PORT:"9999"},[]).port,9999);
});

test("invalid origins and unsafe or ambiguous startup settings fail before opening data",()=>{
  for(const url of ["http://gateway.example.com","https://user:pass@gateway.example.com","https://gateway.example.com/path","https://gateway.example.com/?x=1","https://gateway.example.com/#fragment","bad"])assert.throws(()=>publicOrigin(url));
  for(const env of [{GATEWAY_PORT:"1"},{GATEWAY_PORT:"nan"},{GATEWAY_QUEUE_WAIT_MS:"0"},{GATEWAY_BIND_HOST:"evil.invalid"},{GATEWAY_REQUIRE_ADMIN:"yes"},{GATEWAY_UPSTREAM_SESSION_TRANSPORT:"other"}])assert.throws(()=>runtimeConfig("/app",env,[]));
  assert.throws(()=>runtimeConfig("/app",{GATEWAY_PUBLIC_URL:"https://gateway.example.com"},["--lan"]));
});

const auth={username:"admin",password:"fixture-password"};
const basic="Basic "+Buffer.from(auth.username+":"+auth.password).toString("base64");
async function fixture(t,options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-runtime-"));t.after(()=>rm(directory,{recursive:true,force:true}));const calls=[];
  const g=await createGateway({port:0,directory,bindHost:"0.0.0.0",publicUrl:"https://gateway.example.com",adminAuth:auth,oauthFactory:()=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>"UPSTREAM_FIXTURE"}),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push({body,headers:options.headers});
    return new Response('data: '+JSON.stringify({type:"response.completed",response:{id:"resp",model:body.model,status:"completed",output:[],usage:{input_tokens:1,output_tokens:1}}})+'\n\n',{headers:{"content-type":"text/event-stream"}});
  },...options});t.after(()=>g.close());
  const request=(pathname,options={})=>new Promise((resolve,reject)=>{
    const req=sendHttp(new URL(pathname,g.origin),{method:options.method||"GET",headers:{host:"gateway.example.com",...options.headers}},res=>{
      const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on("error",reject);req.end(options.body);
  });
  const login=async (credentials=auth)=>request("/auth/admin/login",{method:"POST",headers:{origin:"https://gateway.example.com","content-type":"application/json"},body:JSON.stringify(credentials)});
  return {...g,calls,request,login};
}

test("deployment mode protects both public and loopback admin paths; health checks need no credentials",async t=>{
  const g=await fixture(t);
  const anonymous=await g.request("/");assert.equal(anonymous.status,303);assert.equal(anonymous.headers.get("location"),"/login");assert.equal(anonymous.headers.get("www-authenticate"),null);assert.equal((await fetch(g.origin+"/",{redirect:"manual"})).status,303);assert.equal((await g.request("/login")).status,200);
  const api=await g.request("/api/status");assert.equal(api.status,403);assert.equal(api.headers.get("www-authenticate"),null);
  assert.equal((await g.request("/healthz")).status,200);assert.equal((await fetch(g.origin+"/healthz")).status,200);
  assert.equal((await g.request("/",{headers:{host:"evil.invalid","x-forwarded-host":"gateway.example.com"}})).status,403);
  assert.equal((await g.request("/",{headers:{authorization:basic,origin:"https://evil.invalid"}})).status,403);
});

test("public admin cookies are secure, origin-scoped and CSRF protected",async t=>{
  const g=await fixture(t),home=await g.login();assert.equal(home.status,200);
  const setCookie=home.headers.get("set-cookie");assert.ok(setCookie.includes("; Secure"));assert.ok(setCookie.includes("HttpOnly"));const cookie=setCookie.split(";")[0];await home.text();
  const response=await g.request("/api/status",{headers:{cookie}});assert.equal(response.status,200);const status=await response.json();assert.equal(status.baseUrl,"https://gateway.example.com/v1");assert.equal(status.publicBaseUrl,status.baseUrl);
  assert.equal((await fetch(g.origin+"/api/status",{headers:{cookie}})).status,403);
  assert.equal((await g.request("/api/accounts",{method:"POST",headers:{cookie,"content-type":"application/json"},body:'{"name":"no-csrf"}'})).status,403);
});

test("public Responses keeps bearer-key auth and stable HTTP session routing separate from admin auth",async t=>{
  const g=await fixture(t);assert.equal((await g.request("/v1/responses",{method:"POST",headers:{authorization:basic}})).status,401);
  const response=await g.request("/v1/responses",{method:"POST",headers:{authorization:"Bearer "+g.store.settings.gatewayKey,"content-type":"application/json"},body:JSON.stringify({model:"m",session_id:"s",input:"hello",stream:false})});
  assert.equal(response.status,200);assert.equal(response.headers.get("x-gateway-upstream-transport"),"http");await response.json();assert.ok(g.calls[0].headers["session-id"]);assert.equal(g.calls.length,1);
});

test("public callback cannot impersonate a loopback callback",async t=>{
  const g=await fixture(t),home=await g.login();const cookie=home.headers.get("set-cookie").split(";")[0];await home.text();
  const session=g.store.adminSession(cookie.slice("ag_admin=".length));
  const response=await g.request("/auth/callback?state=untrusted",{headers:{cookie}});assert.equal(response.status,403);assert.equal((await response.json()).error.code,"local_login_required");
});


test("Cloudflare admin cookies do not overwrite or accept the local gateway cookie",async t=>{
  const g=await fixture(t,{adminCookieName:"ag_cf_admin",loginCookieName:"ag_cf_login"});
  const home=await g.login();assert.equal(home.status,200);
  const cookie=home.headers.get("set-cookie").split(";")[0];assert.ok(cookie.startsWith("ag_cf_admin="));
  assert.equal((await g.request("/api/status",{headers:{cookie}})).status,200);
  assert.equal((await g.request("/api/status",{headers:{cookie:cookie.replace("ag_cf_admin=","ag_admin=")}})).status,403);
});

test("public model authorization starts and completes in the same admin session without changing the OAuth redirect URI",async t=>{
  let oauth,exchanged=0;
  const g=await fixture(t,{oauthFactory:store=>{
    oauth=new OAuth(store,{redirectUri:"http://127.0.0.1:18787/auth/callback"});
    oauth.discovery={authorization_endpoint:ISSUER+"/authorize",token_endpoint:ISSUER+"/token",jwks_uri:ISSUER+"/jwks"};
    oauth.callback=async (params,browser)=>{oauth.consume(params,browser);exchanged++;};return oauth;
  }}),login=await g.login(),cookie=login.headers.get("set-cookie").split(";")[0],session=g.store.adminSession(cookie.slice(cookie.indexOf("=")+1));
  const headers={cookie,"x-demo-csrf":session.csrf,"content-type":"application/json",origin:"https://gateway.example.com"};
  const started=await g.request("/api/accounts/account-default/login",{method:"POST",headers,body:"{}"});assert.equal(started.status,200);assert.equal(started.headers.get("set-cookie"),null);
  const result=await started.json(),url=new URL(result.authorizationUrl);assert.equal(result.completionMode,"manual_callback");assert.equal(url.searchParams.get("redirect_uri"),"http://127.0.0.1:18787/auth/callback");
  const callbackUrl=result.callbackUrl+"?"+new URLSearchParams({code:"fixture-code",state:url.searchParams.get("state"),client_id:"fixture-client"});
  const route="/api/accounts/account-default/complete-login",body=JSON.stringify({callbackUrl});
  assert.equal((await g.request(route,{method:"POST",headers:{...headers,"x-demo-csrf":"wrong"},body})).status,403);assert.equal(exchanged,0);
  const done=await g.request(route,{method:"POST",headers,body});assert.equal(done.status,200);assert.equal(exchanged,1);
  assert.equal((await g.request(route,{method:"POST",headers,body})).status,400);assert.equal(exchanged,1);
  assert.ok(!JSON.stringify(g.store.auditLog()).includes("fixture-code"));
});
