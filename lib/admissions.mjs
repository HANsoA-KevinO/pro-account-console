import {PublicError} from "./oauth.mjs";

const CAPACITY_ERRORS=new Set(["account_concurrency_limit","local_concurrency_limit","session_concurrency_limit"]);
function beforeStartError(status,code,message){const error=new PublicError(status,code,message);error.beforeUpstream=true;return error;}

export class Admissions {
  constructor(store,{eligible=()=>true,waitTimeoutMs=300000,serializeSessions=false}={}){
    if(!Number.isSafeInteger(waitTimeoutMs)||waitTimeoutMs<1)throw new Error("排队等待时间需要是有效的正整数（毫秒）。");
    this.store=store;this.eligible=eligible;this.waitTimeoutMs=waitTimeoutMs;this.serializeSessions=serializeSessions;
    this.pending=[];this.closed=false;this.scheduled=false;
    this.wake=()=>this.kick();store.events.on("capacity",this.wake);
    this.timer=setInterval(this.wake,1000);this.timer.unref();
  }
  agent(authorization,model,{sessionId=null,signal}={}){
    const agent=this.store.authenticate(authorization);
    return this.enqueue(meta=>{
      const current=this.store.authenticate(authorization);
      if(this.serializeSessions&&sessionId!==null&&this.store.db.prepare("SELECT 1 FROM requests WHERE agent_id=? AND status='pending' AND json_extract(payload,'$.session_id')=? LIMIT 1").get(current.id,sessionId)){
        // Invalidated permissions or a disabled pinned account must fail now,
        // rather than being hidden behind the busy session until queue timeout.
        if(current.allowedModels.length&&!current.allowedModels.includes(model))throw new PublicError(403,"model_not_allowed","该接入 key 未获准使用这个模型。");
        this.store.resolveRoute(current,model,{eligible:this.eligible,sessionId,advance:false});
        throw new PublicError(429,"session_concurrency_limit","同一会话的请求需要依次执行。");
      }
      const context=this.store.admit(current,model,"agent",{eligible:this.eligible,sessionId});
      const reservation={...context,...meta};this.store.recordSync(reservation);return reservation;
    },{signal,agentId:agent.id,account:()=>sessionId===null?null:this.store.sessionAccountId(agent.id,sessionId)});
  }
  fixed(record,{signal,validate}={}){
    const accountId=record.accountId||this.store.management.activeAccountId;
    const identity=this.store.accountIdentityHash(accountId);
    return this.enqueue(meta=>{
      this.store.assertAccountAvailable(accountId);
      if(this.store.accountIdentityHash(accountId)!==identity)throw beforeStartError(409,"account_identity_changed","排队期间账号的授权身份已改变，请重新发起请求。");
      validate?.();
      const reservation={...record,accountId,...meta};this.store.reserveAccountRequest(reservation);return reservation;
    },{signal,agentId:record.agentId??null,account:()=>accountId});
  }
  enqueue(attempt,{signal,agentId,account}){
    if(this.closed)return Promise.reject(beforeStartError(503,"gateway_stopping","网关正在停止，请稍后重试。"));
    if(signal?.aborted)return Promise.reject(beforeStartError(499,"request_cancelled","请求已取消。"));
    return new Promise((resolve,reject)=>{
      const entry={attempt,signal,agentId,account,resolve,reject,enteredAt:Date.now(),wasQueued:false,done:false};
      entry.abort=()=>this.finish(entry,beforeStartError(499,"request_cancelled","请求已取消。"));
      entry.timeout=setTimeout(()=>this.finish(entry,beforeStartError(504,"queue_wait_timeout","排队等待已超时，请稍后重试。")),this.waitTimeoutMs);entry.timeout.unref();
      signal?.addEventListener("abort",entry.abort,{once:true});
      this.pending.push(entry);this.kick();
    });
  }
  kick(){
    if(this.closed||this.scheduled)return;
    this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;if(!this.closed)this.pump();});
  }
  pump(){
    // FIFO for requests competing for the same slots. A blocked account/key
    // does not block later requests that can run on another available slot.
    for(const entry of [...this.pending]){
      if(entry.done)continue;
      if(Date.now()-entry.enteredAt>=this.waitTimeoutMs){this.finish(entry,beforeStartError(504,"queue_wait_timeout","排队等待已超时，请稍后重试。"));continue;}
      const meta={queueWaitMs:entry.wasQueued?Math.max(0,Date.now()-entry.enteredAt):0,queuedAt:entry.wasQueued?new Date(entry.enteredAt).toISOString():null};
      try{this.finish(entry,null,entry.attempt(meta));}
      catch(error){
        if(CAPACITY_ERRORS.has(error.code)){entry.wasQueued=true;continue;}
        error.beforeUpstream=true;this.finish(entry,error);
      }
    }
  }
  finish(entry,error,value){
    if(entry.done)return;
    entry.done=true;clearTimeout(entry.timeout);entry.signal?.removeEventListener("abort",entry.abort);
    const index=this.pending.indexOf(entry);if(index>=0)this.pending.splice(index,1);
    if(error)entry.reject(error);else entry.resolve(value);
  }
  waitingForAccount(accountId){return this.pending.filter(entry=>entry.account()===accountId).length;}
  waitingForAgent(agentId){return this.pending.filter(entry=>entry.agentId===agentId).length;}
  status(){return {waiting:this.pending.length,waitTimeoutMs:this.waitTimeoutMs};}
  close(){
    if(this.closed)return;
    this.closed=true;clearInterval(this.timer);this.store.events.off("capacity",this.wake);
    for(const entry of [...this.pending])this.finish(entry,beforeStartError(503,"gateway_stopping","网关正在停止，排队请求已取消。"));
  }
}
