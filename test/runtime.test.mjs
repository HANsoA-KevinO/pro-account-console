import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {request as sendHttp} from "node:http";
import {runtimeConfig,publicOrigin} from "../lib/runtime.mjs";
import {createGateway} from "../server.mjs";

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
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-runtime-"));t.after(()=>rm(directory,{recursive:true,force:true}));const calls=[];
  const g=await createGateway({port:0,directory,bindHost:"0.0.0.0",publicUrl:"https://gateway.example.com",adminAuth:auth,oauthFactory:()=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>"UPSTREAM_FIXTURE"}),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push({body,headers:options.headers});
    return new Response('data: '+JSON.stringify({type:"response.completed",response:{id:"resp",model:body.model,status:"completed",output:[],usage:{input_tokens:1,output_tokens:1}}})+'\n\n',{headers:{"content-type":"text/event-stream"}});
  }});t.after(()=>g.close());
  const request=(pathname,options={})=>new Promise((resolve,reject)=>{
    const req=sendHttp(new URL(pathname,g.origin),{method:options.method||"GET",headers:{host:"gateway.example.com",...options.headers}},res=>{
      const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on("error",reject);req.end(options.body);
  });
  return {...g,calls,request};
}

test("deployment mode protects both public and loopback admin paths; health checks need no credentials",async t=>{
  const g=await fixture(t);
  assert.equal((await g.request("/")).status,401);assert.equal((await fetch(g.origin+"/")).status,401);
  const api=await g.request("/api/status");assert.equal(api.status,403);assert.equal(api.headers.get("www-authenticate"),null);
  assert.equal((await g.request("/healthz")).status,200);assert.equal((await fetch(g.origin+"/healthz")).status,200);
  assert.equal((await g.request("/",{headers:{host:"evil.invalid","x-forwarded-host":"gateway.example.com"}})).status,403);
  assert.equal((await g.request("/",{headers:{authorization:basic,origin:"https://evil.invalid"}})).status,403);
});

test("public admin cookies are secure, origin-scoped and CSRF protected",async t=>{
  const g=await fixture(t),home=await g.request("/",{headers:{authorization:basic}});assert.equal(home.status,200);
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

test("public account authorization cannot create a non-loopback OAuth callback",async t=>{
  const g=await fixture(t),home=await g.request("/",{headers:{authorization:basic}});const cookie=home.headers.get("set-cookie").split(";")[0];await home.text();
  const session=g.store.adminSession(cookie.slice("ag_admin=".length));
  const response=await g.request("/api/accounts/account-default/login",{method:"POST",headers:{cookie,"x-demo-csrf":session.csrf}});assert.equal(response.status,403);assert.equal((await response.json()).error.code,"local_login_required");
});
