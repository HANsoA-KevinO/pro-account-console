import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import {createGateway} from "../server.mjs";
import {SessionWebSockets} from "../lib/upstream-websocket.mjs";

function gate(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
async function until(check){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error("Timed out waiting for state");await delay(5);}}
const output=n=>[{type:"reasoning",id:"rs_"+n,encrypted_content:"opaque_"+n,summary:[]},{type:"message",id:"msg_"+n,role:"assistant",phase:"final_answer",status:"completed",content:[{type:"output_text",text:"ok",annotations:[]}]}];
function sockets({onCall}={}){
  const calls=[],connections=[];
  class Socket extends EventEmitter {
    constructor(options){super();this.readyState=0;this.options=options;this.number=connections.length+1;connections.push(this);queueMicrotask(()=>{this.readyState=1;this.emit("open");});}
    send(data,callback){
      const body=JSON.parse(data),call={body,socket:this,index:calls.length+1};calls.push(call);callback?.();
      Promise.resolve().then(()=>onCall?.(call)).then(result=>{
        if(this.readyState!==1||result===false)return;
        const n=call.index,response={id:"resp_"+n,model:body.model,status:"completed",prompt_cache_key:"connection_"+this.number,output:output(n),usage:{input_tokens:3000,input_tokens_details:{cached_tokens:body.previous_response_id?2800:0},output_tokens:2}};
        this.event({type:"response.created",response:{id:response.id,status:"in_progress",model:body.model}});
        this.event({type:"response.output_text.delta",delta:"ok"});
        for(let i=0;i<response.output.length;i++)this.event({type:"response.output_item.done",output_index:i,item:response.output[i]});
        this.event({type:"response.completed",response:{...response,output:[]}});
      }).catch(error=>this.emit("error",error));
    }
    event(value){this.emit("message",Buffer.from(JSON.stringify(value)));}
    terminate(){if(this.readyState===3)return;this.readyState=3;this.emit("close",1006,Buffer.alloc(0));}
    pause(){} resume(){}
  }
  return {calls,connections,factory:(_,options)=>new Socket(options)};
}
async function fixture(t,options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-ws-test-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const fake=sockets(options);let token="token_one";
  const g=await createGateway({sessionWebSockets:true,port:0,directory,socketFactory:fake.factory,socketOptions:options.socketOptions,queueWaitMs:2000,
    oauthFactory:()=>({status:()=>({sharing:true,connected:true}),accessToken:async()=>token}),
    fetchImpl:async url=>{assert.ok(url.endsWith("/models"),"session inference must use WebSocket");return Response.json({models:[{slug:"m",visibility:"list"}]});},
  });
  await g.store.updateAccount("account-default",{maxConcurrent:4});await g.store.updateAgent("agent-default",{maxConcurrent:4});
  t.after(()=>{options.release?.();return g.close();});
  const send=(fields={},key=g.store.settings.gatewayKey,signal)=>fetch(g.origin+"/v1/responses",{method:"POST",signal,headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model:"m",session_id:"chat",input:[{role:"user",content:"hello"}],stream:false,...fields})});
  return {...g,...fake,send,setToken:value=>token=value};
}
const nextInput=n=>[{role:"user",content:"hello"},...output(n),{role:"user",content:"next"}];

test("HTTP clients receive complete JSON and SSE while session history becomes WS increments",async t=>{
  const g=await fixture(t);const body={model:"m",session_id:"chat",input:[{role:"user",content:"hello"}],stream:false};
  const first=await g.send(body);assert.equal(first.headers.get("x-gateway-upstream-transport"),"websocket");const result=await first.json();assert.deepEqual(result.output,output(1));
  const follow=await g.send({input:nextInput(1),stream:true});const text=await follow.text();assert.match(text,/response.completed/);assert.match(text,/"cached_tokens":2800/);
  assert.equal(g.connections.length,1);assert.equal(g.calls[1].body.previous_response_id,"resp_1");assert.deepEqual(g.calls[1].body.input,[{role:"user",content:"next"}]);
  for(const call of g.calls){assert.equal(call.body.type,"response.create");assert.equal(Object.hasOwn(call.body,"stream"),false);assert.equal(Object.hasOwn(call.body,"session_id"),false);assert.equal(Object.hasOwn(call.body,"stream_id"),false);}
  const rows=g.store.report({session_id:"chat"}).records;assert.equal(rows.length,2);assert.ok(rows.every(row=>row.upstreamTransport==="websocket"));assert.equal(new Set(rows.map(row=>row.upstreamSession.cacheKeyHash)).size,1);assert.equal(rows.find(row=>row.upstreamSession.mode==="continuation").upstreamSession.sentInputItems,1);
});

test("same-session requests queue before reserving key/account slots and other sessions progress",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.index===1?hold.promise:undefined,release:hold.resolve});
  const first=g.send();await until(()=>g.calls.length===1);
  const follow=g.send({input:nextInput(1)});await until(()=>g.admissions.status().waiting===1);assert.equal(g.store.accountConcurrency("account-default").active,1);
  const independent=await g.send({session_id:"other"});assert.equal(independent.status,200);await independent.json();assert.equal(g.calls.length,2);
  hold.resolve();await(await first).json();await(await follow).json();assert.equal(g.calls[2].body.previous_response_id,"resp_1");assert.equal(g.calls[2].socket,g.calls[0].socket);
});

test("sessions are isolated by key and model; rotation of the same key keeps its connection",async t=>{
  const g=await fixture(t);await(await g.send()).json();const other=await g.store.addAgent({name:"Other",maxConcurrent:4});await(await g.send({},other.apiKey)).json();
  const rotated=await g.store.rotateAgent("agent-default");await(await g.send({input:nextInput(1)},rotated.apiKey)).json();assert.equal(g.connections.length,2);assert.equal(g.calls[2].socket,g.calls[0].socket);
  await(await g.send({model:"m2"},rotated.apiKey)).json();assert.equal(g.connections.length,3);assert.equal(g.calls[3].body.previous_response_id,undefined);
});

test("an idle disconnection recovers full context on the same account without stale parent IDs",async t=>{
  const g=await fixture(t);await(await g.send()).json();g.connections[0].terminate();
  const input=nextInput(1),response=await g.send({input});assert.equal(response.status,200);await response.json();assert.equal(g.connections.length,2);assert.deepEqual(g.calls[1].body.input,input);assert.equal(g.calls[1].body.previous_response_id,undefined);
  const row=g.store.report({session_id:"chat"}).records.find(x=>x.responseId==="resp_2");assert.equal(row.accountId,"account-default");assert.equal(row.upstreamSession.mode,"recovered");
});

test("credential renewal rebuilds the socket and forwards the complete caller history",async t=>{
  const g=await fixture(t);await(await g.send()).json();g.setToken("renewed_token");await(await g.send({input:nextInput(1)})).json();
  assert.equal(g.connections.length,2);assert.equal(g.connections[1].options.headers.Authorization,"Bearer renewed_token");assert.deepEqual(g.calls[1].body.input,nextInput(1));assert.equal(g.store.report().records.find(x=>x.responseId==="resp_2").upstreamSession.resetReason,"credentials_refreshed");
});

test("changed history or settings resets the chain without dropping input or adding model retries",async t=>{
  const g=await fixture(t);await(await g.send()).json();const changed=[{role:"user",content:"edited"}];await(await g.send({input:changed})).json();
  const follow=[...changed,...output(2),{role:"user",content:"next"}];await(await g.send({input:follow,reasoning:{effort:"high"}})).json();
  assert.equal(g.calls.length,3);assert.equal(g.connections.length,1);assert.deepEqual(g.calls[1].body.input,changed);assert.deepEqual(g.calls[2].body.input,follow);assert.ok(g.calls.every(call=>call.body.previous_response_id===undefined));
  assert.deepEqual(new Set(g.store.report().records.filter(x=>x.upstreamSession.mode==="context_reset").map(x=>x.upstreamSession.resetReason)),new Set(["history_changed","settings_changed"]));
});

test("comparison diagnostics do not unnecessarily reset a compatible response chain",async t=>{
  const g=await fixture(t);await(await g.send()).json();await(await g.send({input:nextInput(1),prompt_cache_options:{comparison_response_id:"resp_1"}})).json();assert.equal(g.calls[1].body.previous_response_id,"resp_1");assert.equal(g.calls[1].body.prompt_cache_options.comparison_response_id,"resp_1");
});

test("a missing parent is recovered once before generation and every attempt is visible",async t=>{
  const g=await fixture(t,{onCall:call=>{if(call.index===2){call.socket.event({type:"error",status:400,error:{code:"previous_response_not_found",message:"Parent expired"}});return false;}}});
  await(await g.send()).json();const response=await g.send({input:nextInput(1)});assert.equal(response.headers.get("x-gateway-upstream-recovery-attempts"),"1");await response.json();assert.equal(g.calls.length,3);assert.equal(g.calls[2].body.previous_response_id,undefined);assert.deepEqual(g.calls[2].body.input,nextInput(1));
  const rows=g.store.report().records;assert.equal(rows.length,2);const row=rows.find(x=>x.responseId==="resp_3");assert.equal(row.upstreamSession.attempts.length,2);assert.equal(row.upstreamSession.attempts[0].errorCode,"previous_response_not_found");
});

test("partial output followed by EOF fails honestly and is never replayed automatically",async t=>{
  const g=await fixture(t,{onCall:call=>{if(call.index===1){call.socket.event({type:"response.created",response:{id:"partial",status:"in_progress"}});call.socket.event({type:"response.output_text.delta",delta:"partial"});call.socket.terminate();return false;}}});
  const response=await g.send({stream:true}),text=await response.text();assert.match(text,/partial/);assert.match(text,/stream_incomplete/);assert.doesNotMatch(text,/response.completed/);assert.equal(g.calls.length,1);const row=g.store.report().records[0];assert.equal(row.status,"failed");assert.equal(row.usage,null);
  await(await g.send()).json();assert.equal(g.connections.length,2);
});

test("initial WS validation errors retain HTTP error status and do not fall back",async t=>{
  const g=await fixture(t,{onCall:call=>{call.socket.event({type:"error",status:400,error:{code:"invalid_parameter",message:"Unsupported option"}});return false;}});
  const response=await g.send({stream:true});assert.equal(response.status,400);assert.equal((await response.json()).error.code,"invalid_parameter");assert.equal(g.calls.length,1);assert.equal(g.store.report().records[0].errorCode,"invalid_parameter");
});

test("revoking a key disposes its idle authenticated session",async t=>{
  const g=await fixture(t);await(await g.send()).json();assert.equal(g.webSocketPool.status().connections,1);await g.store.updateAgent("agent-default",{enabled:false});assert.equal(g.webSocketPool.status().connections,0);assert.equal((await g.send()).status,403);
});

test("idle sessions expire, retain only context hashes, and do not impose an active-request cap",async()=>{
  const fake=sockets(),pool=new SessionWebSockets({socketFactory:fake.factory,idleMs:20,maxRetained:1});
  try{
    const scope={agentId:"k",accountId:"a",sessionId:"s",model:"m"},payload={model:"m",input:[{role:"user",content:"PRIVATE_TEST_TEXT"}],store:false,stream:true};
    const first=await pool.open(payload,{scope,token:"token"});for await(const event of first.events){}const entry=[...pool.entries.values()][0];assert.ok(entry.contextHashes.every(x=>typeof x==="string"&&x.length===64));assert.equal(entry.request,null);assert.equal(JSON.stringify(entry.contextHashes).includes("PRIVATE_TEST_TEXT"),false);
    await delay(45);assert.equal(pool.status().connections,0);const second=await pool.open(payload,{scope,token:"token",reusedSession:true});for await(const event of second.events){}assert.equal(second.metadata.mode,"recovered");
  }finally{pool.close();}
});

test("cancelling active inference releases its session and account for queued work",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:call=>call.index===1?hold.promise:undefined,release:hold.resolve}),controller=new AbortController();
  const first=g.send({},undefined,controller.signal).catch(error=>error);await until(()=>g.calls.length===1);
  const follow=g.send();await until(()=>g.admissions.status().waiting===1);controller.abort();assert.equal((await first).name,"AbortError");
  await(await follow).json();await until(()=>g.store.report().records.some(row=>row.status==="interrupted"));assert.equal(g.calls.length,2);assert.equal(g.connections.length,2);assert.equal(g.store.accountConcurrency("account-default").active,0);
});

test("shutdown terminates active sockets without waiting for the model timeout",async t=>{
  const hold=gate(),g=await fixture(t,{onCall:()=>hold.promise,release:hold.resolve});const response=g.send();await until(()=>g.calls.length===1);const closing=g.close();
  assert.equal((await response).status,502);await closing;assert.equal(g.webSocketPool.status().connections,0);assert.equal(g.calls.length,1);
});

test("repeated missing-parent errors are bounded to one recorded recovery",async t=>{
  const g=await fixture(t,{onCall:call=>{if(call.index>1){call.socket.event({type:"error",status:400,error:{code:"previous_response_not_found",message:"Parent unavailable"}});return false;}}});
  await(await g.send()).json();const response=await g.send({input:nextInput(1)});assert.equal(response.status,400);assert.equal(g.calls.length,3);const failed=g.store.report().records.find(row=>row.status==="failed");assert.equal(failed.upstreamSession.recoveryAttempts,1);assert.equal(failed.upstreamSession.attempts.length,2);
});

test("malformed upstream events preserve the primary parser failure and are not retried",async t=>{
  const g=await fixture(t,{onCall:call=>{call.socket.emit("message",Buffer.from("{not-json"));return false;}});const response=await g.send();assert.equal(response.status,502);assert.equal((await response.json()).error.code,"invalid_upstream_event");assert.equal(g.calls.length,1);
});
