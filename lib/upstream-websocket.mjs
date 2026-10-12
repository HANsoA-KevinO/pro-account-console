import WebSocket from "ws";
import {createHash,randomUUID} from "node:crypto";
import {PublicError,RESOURCE} from "./oauth.mjs";

const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const codeOf=event=>event.error?.code||event.response?.error?.code||event.code;
const terminal=event=>["response.completed","response.failed","response.incomplete","error"].includes(event.type);
const cancelled=()=>new PublicError(499,"request_cancelled","请求已取消。");
function settingsOf(payload){
  const {input,stream,...settings}=payload;
  // Comparison IDs request diagnostics only; they do not change the context.
  if(settings.prompt_cache_options){
    const {comparison_response_id,...options}=settings.prompt_cache_options;
    if(Object.keys(options).length)settings.prompt_cache_options=options;
    else delete settings.prompt_cache_options;
  }
  return Object.fromEntries(Object.keys(settings).sort().map(key=>[key,settings[key]]));
}

class EventQueue {
  constructor(socket){this.socket=socket;this.items=[];this.bytes=0;this.waiter=null;this.done=false;this.error=null;}
  push(event,size){
    if(this.done)return;
    if(this.waiter){const waiter=this.waiter;this.waiter=null;waiter.resolve({value:event,done:false});return;}
    this.items.push({event,size});this.bytes+=size;
    if(this.bytes>1024*1024)this.socket.pause?.();
    if(this.bytes>8*1024*1024)this.fail(new PublicError(502,"upstream_event_buffer_overflow","上游事件缓冲超过限制。"));
  }
  end(){this.done=true;if(this.waiter){this.waiter.resolve({done:true});this.waiter=null;}}
  fail(error){if(this.error)return;this.error=error;this.done=true;if(this.waiter){this.waiter.reject(error);this.waiter=null;}}
  next(){
    if(this.items.length){const {event,size}=this.items.shift();this.bytes-=size;if(this.bytes<512*1024)this.socket.resume?.();return Promise.resolve({value:event,done:false});}
    if(this.error)return Promise.reject(this.error);
    if(this.done)return Promise.resolve({done:true});
    return new Promise((resolve,reject)=>{this.waiter={resolve,reject};});
  }
}

/** One authenticated socket per key/account/model/session; only hashes survive a turn. */
export class SessionWebSockets {
  constructor({socketFactory=(url,options)=>new WebSocket(url,options),idleMs=600000,maxAgeMs=3300000,maxRetained=128,valid=()=>true}={}){
    for(const value of [idleMs,maxAgeMs,maxRetained])if(!Number.isSafeInteger(value)||value<1)throw new Error("WebSocket 连接配置需要有效的正整数。");
    this.socketFactory=socketFactory;this.idleMs=idleMs;this.maxAgeMs=maxAgeMs;this.maxRetained=maxRetained;this.valid=valid;
    this.entries=new Map();this.closed=false;
    this.timer=setInterval(()=>this.prune(),Math.min(60000,idleMs));this.timer.unref();
  }
  key(scope){return JSON.stringify([scope.agentId,scope.accountId,scope.sessionId,scope.model]);}
  retire(entry,reason){
    entry.closeReason=reason;entry.closed=true;
    if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);
    if(entry.request&&!entry.request.terminalReceived)entry.request.queue.fail(new PublicError(502,"stream_incomplete","流式连接结束，但没有收到完成事件。"));
    entry.socket?.terminate();
  }
  prune(){
    const now=Date.now();
    for(const entry of this.entries.values()){
      let valid=false;try{valid=this.valid(entry.scope);}catch{}
      const reason=entry.closed?"connection_closed":!valid?"authorization_changed":now-entry.createdAt>=this.maxAgeMs?"connection_age":now-entry.lastUsedAt>=this.idleMs?"idle_expired":null;
      if(reason){if(entry.busy)entry.discardAfterUse=reason;else this.retire(entry,reason);}
    }
    // This bounds retained idle state, not the number of concurrent requests.
    const idle=[...this.entries.values()].filter(entry=>!entry.busy).sort((a,b)=>a.lastUsedAt-b.lastUsedAt);
    while(this.entries.size>this.maxRetained&&idle.length)this.retire(idle.shift(),"idle_capacity");
  }
  status(){return {transport:"websocket",connections:this.entries.size,active:[...this.entries.values()].filter(entry=>entry.busy).length,idleMs:this.idleMs};}
  async connect(scope,token,signal){
    if(signal?.aborted)throw cancelled();
    const entry={key:this.key(scope),scope:{...scope},connectionId:randomUUID(),tokenHash:digest(token),createdAt:Date.now(),lastUsedAt:Date.now(),contextHashes:[],previousId:null,settingsHash:null,busy:true,closed:false,request:null};
    this.entries.set(entry.key,entry);
    try{
      entry.socket=this.socketFactory(RESOURCE.replace(/^https:/,"wss:")+"/responses",{headers:{Authorization:"Bearer "+token,"x-client-request-id":entry.connectionId},handshakeTimeout:15000,maxPayload:8*1024*1024});
      const socket=entry.socket;
      socket.on("message",data=>{
        const request=entry.request;if(!request||request.terminalReceived)return;
        const size=Buffer.byteLength(data);if(size>8*1024*1024){request.queue.fail(new PublicError(502,"upstream_event_too_large","上游事件过大。"));this.retire(entry,"invalid_event");return;}
        let event;try{event=JSON.parse(data.toString());if(!event||typeof event!=="object"||typeof event.type!=="string")throw new Error();}
        catch{request.queue.fail(new PublicError(502,"invalid_upstream_event","上游返回了无法解析的事件。"));this.retire(entry,"invalid_event");return;}
        if(event.type==="response.output_item.done"&&Number.isInteger(event.output_index)&&event.item)request.outputItems.set(event.output_index,event.item);
        if(terminal(event)){
          request.terminalReceived=true;
          const response=event.response;
          if(response&&!response.output?.length&&request.outputItems.size)response.output=[...request.outputItems.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
          request.meta.cacheKeyHash=response?.prompt_cache_key==null?null:digest(response.prompt_cache_key);
          request.meta.cacheDiagnostics=response?.prompt_cache_diagnostics??null;
          if(event.type==="response.completed"&&typeof response?.id==="string"){
            entry.previousId=response.id;entry.contextHashes=[...request.inputHashes,...(response.output||[]).map(digest)];entry.settingsHash=request.settingsHash;
          }else{entry.previousId=null;entry.contextHashes=[];entry.settingsHash=null;entry.discardAfterUse="response_failed";request.meta.errorCode=codeOf(event)||null;}
        }
        request.queue.push(event,size);
        if(request.queue.error)this.retire(entry,"buffer_overflow");
        else if(request.terminalReceived)request.queue.end();
      });
      socket.on("error",()=>{if(entry.request&&!entry.request.terminalReceived)entry.request.queue.fail(new PublicError(502,"upstream_connection_error","上游 WebSocket 连接未成功完成。"));entry.closed=true;});
      socket.on("close",()=>{entry.closed=true;if(entry.request&&!entry.request.terminalReceived)entry.request.queue.fail(new PublicError(502,"stream_incomplete","流式连接结束，但没有收到完成事件。"));});
      await new Promise((resolve,reject)=>{
        const finish=(failure)=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);socket.off("open",open);socket.off("error",error);socket.off("close",close);socket.off("unexpected-response",unexpected);failure?reject(failure):resolve();};
        const open=()=>finish();
        const error=()=>finish(new PublicError(502,"upstream_websocket_connect_failed","无法建立上游 WebSocket 连接。"));
        const close=()=>finish(new PublicError(502,"upstream_websocket_connect_failed","上游连接在建立完成前关闭。"));
        const unexpected=(_,response)=>{const status=response.statusCode;response.resume();finish(new PublicError(status>=400&&status<600?status:502,"upstream_websocket_rejected","上游拒绝 WebSocket 连接（HTTP "+status+"）。"));};
        const abort=()=>finish(cancelled());
        const timer=setTimeout(error,16000);timer.unref();socket.once("open",open);socket.once("error",error);socket.once("close",close);socket.once("unexpected-response",unexpected);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
      });
      return entry;
    }catch(error){this.retire(entry,"connect_failed");throw error;}
  }
  start(entry,payload,signal,onSent,mode,reason){
    const inputHashes=payload.input.map(digest),settingsHash=digest(settingsOf(payload));
    const matches=entry.previousId&&inputHashes.length>=entry.contextHashes.length&&entry.contextHashes.every((item,i)=>item===inputHashes[i]);
    const sameSettings=entry.settingsHash===settingsHash;
    const continuation=!!(entry.previousId&&matches&&sameSettings);
    if(entry.previousId&&!continuation){mode="context_reset";reason=sameSettings?"history_changed":"settings_changed";}
    const {stream,...body}=payload;
    const wire={type:"response.create",...body,input:continuation?payload.input.slice(entry.contextHashes.length):payload.input,...(continuation?{previous_response_id:entry.previousId}:{})};
    const meta={connectionId:entry.connectionId,mode:continuation?"continuation":mode,resetReason:continuation?null:reason,previousResponseId:wire.previous_response_id??null,fullInputItems:payload.input.length,sentInputItems:wire.input.length,cacheKeyHash:null,cacheDiagnostics:null};
    const request={queue:new EventQueue(entry.socket),inputHashes,settingsHash,outputItems:new Map(),meta,signal,terminalReceived:false};
    request.abort=()=>{request.queue.fail(cancelled());this.retire(entry,"request_cancelled");};entry.request=request;
    signal?.addEventListener("abort",request.abort,{once:true});
    if(signal?.aborted){request.abort();return request;}
    onSent?.();
    try{entry.socket.send(JSON.stringify(wire),error=>{if(error){request.queue.fail(new PublicError(502,"upstream_connection_error","上游请求未成功完成。"));this.retire(entry,"send_failed");}});}
    catch{request.queue.fail(new PublicError(502,"upstream_connection_error","上游请求未成功完成。"));this.retire(entry,"send_failed");}
    return request;
  }
  release(entry,request){
    request.signal?.removeEventListener("abort",request.abort);
    if(entry.request===request)entry.request=null;
    entry.busy=false;entry.lastUsedAt=Date.now();
    if(!request.terminalReceived||entry.closed||entry.discardAfterUse)this.retire(entry,entry.discardAfterUse||entry.closeReason||"request_incomplete");
    this.prune();
  }
  async open(payload,{scope,token,signal,onSent,reusedSession=false}={}){
    if(this.closed)throw new PublicError(503,"gateway_stopping","网关正在停止，请稍后重试。");
    this.prune();const key=this.key(scope);let entry=this.entries.get(key),reason=null;
    if(entry?.busy)throw new PublicError(429,"session_concurrency_limit","同一会话的请求正在执行，请等待完成。");
    if(entry&&(entry.closed||entry.tokenHash!==digest(token))){reason=entry.closed?"connection_closed":"credentials_refreshed";this.retire(entry,reason);entry=null;}
    let mode=entry?"initial":reusedSession||reason?"recovered":"initial";
    if(!entry){reason??=reusedSession?"no_live_connection":null;entry=await this.connect(scope,token,signal);}else entry.busy=true;
    let request=this.start(entry,payload,signal,onSent,mode,reason);const attempts=[request.meta];let first;
    try{
      first=await request.queue.next();
      // A missing parent is a validation failure, before any inference events.
      // Recover once with full input, and expose both attempts in the ledger.
      if(!first.done&&first.value.type==="error"&&codeOf(first.value)==="previous_response_not_found"&&request.meta.previousResponseId){
        this.release(entry,request);this.retire(entry,"previous_response_not_found");entry=await this.connect(scope,token,signal);
        request=this.start(entry,payload,signal,onSent,"recovered","previous_response_not_found");attempts.push(request.meta);first=await request.queue.next();
      }
    }catch(error){error.upstreamSession={...request.meta,attempts,recoveryAttempts:attempts.length-1};this.release(entry,request);throw error;}
    const metadata={...request.meta,attempts,recoveryAttempts:attempts.length-1};
    if(!first.done&&first.value.type==="error"){
      const event=first.value,status=event.status||event.error?.status;
      const error=new PublicError(status>=400&&status<600?status:502,codeOf(event)||"upstream_stream_error",event.error?.message||event.message||"上游请求未完成。");
      error.upstreamSession=metadata;this.release(entry,request);throw error;
    }
    const pool=this;
    async function* events(){
      try{
        if(!first.done)yield first.value;
        while(true){const next=await request.queue.next();if(next.done)break;yield next.value;}
      }finally{Object.assign(metadata,request.meta);pool.release(entry,request);}
    }
    return {events:events(),metadata};
  }
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const entry of [...this.entries.values()])this.retire(entry,"gateway_stopping");}
}
