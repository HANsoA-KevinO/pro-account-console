import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {HttpSessions,upstreamSessionId} from "../lib/upstream-http-session.mjs";
import {createGateway} from "../server.mjs";

const scope={agentId:"key-a",accountId:"account-a",identity:"owner-a",sessionId:"对话：123",model:"m"};
const payload={model:"m",input:[{role:"user",content:"hello"}],tools:[],reasoning:{effort:"medium"},store:false,stream:true};
const output=[{type:"reasoning",id:"rs_1",encrypted_content:"opaque-reasoning"},{type:"function_call",id:"fc_1",call_id:"call_1",name:"echo",arguments:"{}"}];
const result={type:"function_call_output",call_id:"call_1",output:"done"};
const final={status:"completed",output,prompt_cache_key:upstreamSessionId(scope)};
function pool(t,options){const p=new HttpSessions(options);t.after(()=>p.close());return p;}
function begin(p,body=payload,fields={}){return p.prepare(body,{scope,token:"token",...fields});}
function complete(p,request,response=final,state="route-secret"){p.observeHeaders(request,new Headers({"x-codex-turn-state":state}));p.finish(request,response);}
function follow(body=payload){return {...body,input:[...body.input,...output,result]};}

test("upstream UUID is stable across restart and separate by key, account and identity",()=>{
  const id=upstreamSessionId(scope);assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id,upstreamSessionId({...scope}));assert.equal(id,upstreamSessionId({...scope,model:"another-model"}));
  for(const field of ["agentId","accountId","identity","sessionId"])assert.notEqual(id,upstreamSessionId({...scope,[field]:scope[field]+"other"}));
});

test("only proven full-history tool appends replay the first server routing token",t=>{
  const p=pool(t),first=begin(p);assert.equal(first.headers["session-id"],upstreamSessionId(scope));assert.equal(first.headers["x-codex-turn-state"],undefined);
  complete(p,first.request);const body=follow(),second=begin(p,body);assert.equal(second.headers["x-codex-turn-state"],"route-secret");assert.equal(second.metadata.turnRouting,"tool_continuation");
  complete(p,second.request,final,"different-response-token");
  const third=begin(p,{...body,input:[...body.input,...output,result]});assert.equal(third.headers["x-codex-turn-state"],"route-secret");complete(p,third.request);
  const userTurn=begin(p,{...body,input:[...body.input,...output,{role:"user",content:"next question"}]});assert.equal(userTurn.headers["x-codex-turn-state"],undefined);assert.equal(userTurn.metadata.turnRouting,"new_turn");
  assert.equal(JSON.stringify(userTurn.metadata).includes("route-secret"),false);p.finish(userTurn.request);
});

test("rewritten history, ambiguous replay, changed settings and token refresh reset turn routing",t=>{
  for(const scenario of ["rewrite","replay","reasoning","tools","token"]){
    const p=pool(t);complete(p,begin(p).request);
    let body=follow(),fields={};
    if(scenario==="rewrite")body.input[0]={role:"user",content:"changed"};
    if(scenario==="replay")body=payload;
    if(scenario==="reasoning")body={...body,reasoning:{effort:"high"}};
    if(scenario==="tools")body={...body,tools:[{type:"function",name:"new_tool"}]};
    if(scenario==="token")fields.token="refreshed-token";
    const next=begin(p,body,fields);assert.equal(next.headers["x-codex-turn-state"],undefined,scenario);assert.equal(next.headers["session-id"],upstreamSessionId(scope));p.finish(next.request);
  }
});

test("diagnostic comparison changes do not reset a matching tool continuation",t=>{
  const p=pool(t),body={...payload,prompt_cache_options:{comparison_response_id:"old"}};complete(p,begin(p,body).request);
  const next=begin(p,{...follow(body),prompt_cache_options:{comparison_response_id:"new"}});assert.equal(next.headers["x-codex-turn-state"],"route-secret");p.finish(next.request);
});

test("failure or incomplete stream discards routing state; restart keeps affinity",t=>{
  const p=pool(t);complete(p,begin(p).request);const second=begin(p,follow());p.finish(second.request);
  const third=begin(p,follow());assert.equal(third.headers["x-codex-turn-state"],undefined);p.finish(third.request);
  const fresh=begin(pool(t),follow());assert.equal(fresh.headers["session-id"],third.headers["session-id"]);assert.equal(fresh.headers["x-codex-turn-state"],undefined);
});

test("retained routing state is bounded and contains hashes, with no hard active-request cap",async t=>{
  let valid=true;const p=pool(t,{idleMs:30,maxRetained:1,valid:()=>valid});complete(p,begin(p).request);
  const saved=[...p.entries.values()][0];assert.ok(saved.contextHashes.every(x=>/^[0-9a-f]{64}$/.test(x)));assert.equal(JSON.stringify(saved).includes("opaque-reasoning"),false);
  const other=begin(p,payload,{scope:{...scope,sessionId:"other"}});complete(p,other.request);assert.equal(p.entries.size,1);
  const a=begin(p),b=begin(p,payload,{scope:{...scope,sessionId:"parallel"}});assert.equal(p.active.size,2);p.finish(a.request);p.finish(b.request);
  complete(p,begin(p).request);valid=false;p.prune();assert.equal(p.entries.size,0);valid=true;complete(p,begin(p).request);
  await new Promise(resolve=>setTimeout(resolve,50));p.prune();assert.equal(p.entries.size,0);
});

test("HTTP pool shutdown cancels active requests and clears opaque routing state",t=>{
  const p=pool(t);let aborted=false;begin(p,payload,{abort:()=>{aborted=true;}});p.close();assert.equal(aborted,true);assert.equal(p.active.size,0);assert.equal(p.entries.size,0);assert.throws(()=>begin(p),e=>e.code==="gateway_stopping");
});

async function gateway(t,{respond}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-http-session-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const calls=[];let token="token",owner="owner";
  const g=await createGateway({directory,port:0,oauthFactory:()=>({status:()=>({sharing:true,connected:true}),accessToken:async()=>token}),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body),headers=options.headers,index=calls.length+1;calls.push({body,headers});
    const custom=respond?.({body,headers,index});if(custom)return custom;
    const response={id:"resp_"+index,model:body.model,status:"completed",prompt_cache_key:headers["session-id"]??"untracked",output,usage:{input_tokens:3000,input_tokens_details:{cached_tokens:index>1?2800:0},output_tokens:2}};
    return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream","x-codex-turn-state":"private-state-"+index}});
  }});
  await g.store.setConnection({subject:owner,client_id:"client",access_token:token});
  t.after(()=>g.close());const send=(body={},key=g.store.settings.gatewayKey,stream=false)=>fetch(g.origin+"/v1/responses",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json","session-id":"untrusted-header","x-codex-turn-state":"untrusted-state"},body:JSON.stringify({...payload,session_id:"shared",...body,stream})});
  return {...g,calls,send,setToken:async value=>{token=value;await g.store.setConnection({subject:owner,client_id:"client",access_token:value});}};
}

test("default gateway uses HTTP full histories, original output items and server turn routing",async t=>{
  const g=await gateway(t);assert.equal(g.webSocketPool,null);
  const first=await g.send({prompt_cache_key:"caller-key"});assert.equal(first.headers.get("x-gateway-upstream-transport"),"http");const id=first.headers.get("x-gateway-upstream-session-id");await first.json();
  const body={...follow(),prompt_cache_key:"caller-key"};await(await g.send(body)).json();
  assert.equal(g.calls[1].headers["session-id"],id);assert.equal(g.calls[1].headers["x-codex-turn-state"],"private-state-1");assert.notEqual(id,"untrusted-header");
  assert.deepEqual(g.calls[1].body.input,body.input);assert.deepEqual(g.calls[1].body.tools,body.tools);assert.equal(g.calls[1].body.prompt_cache_key,"caller-key");assert.equal(Object.hasOwn(g.calls[1].body,"previous_response_id"),false);assert.equal(Object.hasOwn(g.calls[1].body,"session_id"),false);
  const next=await g.send({input:[...body.input,...output,{role:"user",content:"another turn"}]});assert.equal(next.headers.get("x-gateway-upstream-turn-routing"),"new_turn");await next.json();assert.equal(g.calls[2].headers["x-codex-turn-state"],undefined);
  const rows=g.store.report({session_id:"shared"}).records;assert.equal(rows.length,3);assert.ok(rows.every(r=>r.upstreamSession.cacheKeyMatchesSession));assert.equal(rows.find(r=>r.responseId==="resp_2").upstreamSession.turnStateSent,true);assert.equal(JSON.stringify(rows).includes("private-state"),false);
});

test("HTTP affinity survives token rotation and remains isolated by key",async t=>{
  const g=await gateway(t);await(await g.send()).json();const id=g.calls[0].headers["session-id"];
  await g.setToken("renewed");await(await g.send(follow())).json();assert.equal(g.calls[1].headers["session-id"],id);assert.equal(g.calls[1].headers["x-codex-turn-state"],undefined);
  const key=await g.store.addAgent({name:"Other"});await(await g.send({},key.apiKey)).json();assert.notEqual(g.calls[2].headers["session-id"],id);const otherId=g.calls[2].headers["session-id"];
  const rotated=await g.store.rotateAgent(key.agent.id);await(await g.send({},rotated.apiKey)).json();assert.equal(g.calls[3].headers["session-id"],otherId);
});

test("HTTP SSE completion records affinity and CSV contains flags without opaque routing tokens",async t=>{
  const g=await gateway(t);const response=await g.send({},undefined,true);const text=await response.text();assert.ok(text.includes("event: response.completed"));assert.equal(text.includes("private-state-1"),false);
  const id=g.calls[0].headers["session-id"];assert.equal(response.headers.get("x-gateway-upstream-session-id"),id);
  const home=await fetch(g.origin+"/"),cookie=home.headers.get("set-cookie").split(";")[0];await home.text();
  const csv=await(await fetch(g.origin+"/api/usage.csv",{headers:{cookie}})).text();assert.ok(csv.includes("upstream_session_header_id"));assert.ok(csv.includes(id));assert.equal(csv.includes("private-state-1"),false);
});

test("HTTP partial EOF reports stream_incomplete and clears routing state without replay",async t=>{
  const g=await gateway(t,{respond:({index})=>index===1?new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{"content-type":"text/event-stream","x-codex-turn-state":"private-incomplete-token"}}):null});
  const response=await g.send({},undefined,true);const text=await response.text();assert.ok(text.includes("stream_incomplete"));assert.equal(g.calls.length,1);assert.equal(g.httpSessions.active.size,0);assert.equal(g.httpSessions.entries.size,0);
  await(await g.send()).json();assert.equal(g.calls.length,2);assert.equal(g.calls[1].headers["x-codex-turn-state"],undefined);assert.equal(g.calls[0].headers["session-id"],g.calls[1].headers["session-id"]);
});
