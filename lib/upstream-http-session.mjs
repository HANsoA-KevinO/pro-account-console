import {createHash} from "node:crypto";
import {PublicError} from "./oauth.mjs";

const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const namespace=Buffer.from("a736b4fece354e569bcc5295b94f9488","hex");

// A name-based UUID is stable across restarts and key/token rotation. Identity
// replacement and different key entries/accounts cannot share an upstream ID.
export function upstreamSessionId(scope){
  const name=JSON.stringify(["gateway-http-session-v1",scope.agentId,scope.accountId,scope.identity,scope.sessionId]);
  const bytes=createHash("sha1").update(namespace).update(name).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString("hex");return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}

function settingsOf(payload){
  const {input,stream,...settings}=payload;
  if(settings.prompt_cache_options){
    const {comparison_response_id,...options}=settings.prompt_cache_options;
    if(Object.keys(options).length)settings.prompt_cache_options=options;
    else delete settings.prompt_cache_options;
  }
  return Object.fromEntries(Object.keys(settings).sort().map(key=>[key,settings[key]]));
}

/** HTTP affinity plus bounded, in-memory routing state for proven tool continuations. */
export class HttpSessions {
  constructor({idleMs=600000,maxRetained=128,valid=()=>true}={}){
    for(const value of [idleMs,maxRetained])if(!Number.isSafeInteger(value)||value<1)throw new Error("HTTP 会话配置需要有效的正整数。");
    this.idleMs=idleMs;this.maxRetained=maxRetained;this.valid=valid;this.entries=new Map();this.active=new Map();this.closed=false;
    this.timer=setInterval(()=>this.prune(),Math.min(idleMs,60000));this.timer.unref();
  }
  key(scope){return JSON.stringify([scope.agentId,scope.accountId,scope.identity,scope.sessionId,scope.model]);}
  isValid(scope){try{return this.valid(scope);}catch{return false;}}
  prune(){
    const now=Date.now();
    for(const [key,entry] of this.entries)if(now-entry.lastUsedAt>=this.idleMs||!this.isValid(entry.scope))this.entries.delete(key);
    while(this.entries.size>this.maxRetained)this.entries.delete(this.entries.keys().next().value);
  }
  status(){return {transport:"http",sessionAffinity:"session-id",connections:0,active:this.active.size,retainedTurnStates:this.entries.size,idleMs:this.idleMs};}
  prepare(payload,{scope,token,abort}={}){
    if(this.closed)throw new PublicError(503,"gateway_stopping","网关正在停止，请稍后重试。");
    this.prune();const key=this.key(scope);
    if(this.active.has(key))throw new PublicError(429,"session_concurrency_limit","同一会话的请求正在执行，请等待完成。");
    const previous=this.entries.get(key);this.entries.delete(key);
    const inputHashes=payload.input.map(digest),settingsHash=digest(settingsOf(payload)),tokenHash=digest(token);
    const matches=previous&&inputHashes.length>previous.contextHashes.length&&previous.contextHashes.every((item,i)=>item===inputHashes[i]);
    // A new user message, a history rewrite, or ambiguous replay starts a new
    // turn. Only appended tool results following the exact completed context
    // establish a continuation; a shared session_id alone is not sufficient.
    const toolAppend=matches&&payload.input.slice(previous.contextHashes.length).every(item=>["function_call_output","custom_tool_call_output"].includes(item?.type));
    const compatible=!!(toolAppend&&previous.settingsHash===settingsHash&&previous.tokenHash===tokenHash);
    const turnState=compatible?previous.turnState:null;
    const sessionId=upstreamSessionId(scope);
    const metadata={mode:"full_history",sessionHeaderId:sessionId,sessionHeaderHash:digest(sessionId),fullInputItems:payload.input.length,sentInputItems:payload.input.length,turnRouting:compatible?"tool_continuation":"new_turn",turnStateSent:!!turnState,turnStateReceived:false,cacheKeyHash:null,cacheKeyMatchesSession:null};
    const request={key,scope:{...scope},inputHashes,settingsHash,tokenHash,turnState,sessionId,metadata,abort};
    this.active.set(key,request);
    return {request,metadata,headers:{"session-id":sessionId,"thread-id":sessionId,...(turnState?{"x-codex-turn-state":turnState}:{})}};
  }
  observeHeaders(request,headers){
    const state=headers.get("x-codex-turn-state");
    if(typeof state==="string"&&state.length>0&&state.length<=16384&&!/[\u0000\r\n]/.test(state)){
      request.metadata.turnStateReceived=true;
      // As in Codex's OnceLock, keep the first token within the same turn.
      request.turnState??=state;
    }
  }
  finish(request,response=null){
    if(!request||this.active.get(request.key)!==request)return;
    this.active.delete(request.key);
    request.metadata.cacheKeyHash=response?.prompt_cache_key==null?null:digest(response.prompt_cache_key);
    request.metadata.cacheKeyMatchesSession=response?.prompt_cache_key==null?null:response.prompt_cache_key===request.sessionId;
    if(!this.closed&&response?.status==="completed"&&request.turnState&&this.isValid(request.scope)){
      this.entries.set(request.key,{scope:request.scope,tokenHash:request.tokenHash,settingsHash:request.settingsHash,turnState:request.turnState,contextHashes:[...request.inputHashes,...(response.output||[]).map(digest)],lastUsedAt:Date.now()});
    }
    this.prune();
  }
  close(){
    if(this.closed)return;this.closed=true;clearInterval(this.timer);this.entries.clear();
    for(const request of this.active.values())request.abort?.();
    this.active.clear();
  }
}
