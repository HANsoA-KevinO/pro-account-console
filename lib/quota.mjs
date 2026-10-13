import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir,chmod,access} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {PublicError} from "./oauth.mjs";

export const SYNC_INTERVAL_MS=5*60*1000;
const METHODS=new Set(["initialize","account/read","account/rateLimits/read","account/login/start","account/login/cancel","account/logout"]);
const problem=(code,message,status=502)=>new PublicError(status,code,message);
const email=value=>typeof value==="string"?value.trim().toLowerCase():"";
const iso=seconds=>typeof seconds==="number"&&Number.isFinite(seconds)&&seconds>0&&seconds<8640000000000?new Date(seconds*1000).toISOString():null;
function rpcProblem(method,message){
  const raw=typeof message==="string"?message:"";
  if(method==="account/login/start"&&/address already in use|addrinuse|port.*in use/i.test(raw))return problem("quota_login_port_busy","Codex 授权回调端口正在被占用，请先完成或取消其他 Codex 登录，再重试。",409);
  if(/certificate|unknown issuer|invalid peer|tls handshake|ssl connect/i.test(raw))return problem("quota_tls_failed","Codex 无法验证上游 HTTPS 连接，请检查运行环境的系统 CA 证书。");
  if(/error sending request|failed to connect|connection reset|connection refused|dns error|name resolution|network is unreachable/i.test(raw))return problem("quota_connection_failed","Codex 无法连接 OpenAI，请检查网关运行环境的网络和系统 CA 证书后重试。");
  if(/device.{0,60}(?:disabled|not enabled|not allowed)|enable.{0,60}device.{0,20}(?:code|auth)/i.test(raw))return problem("quota_device_auth_disabled","请在 ChatGPT 安全设置或工作区权限中启用设备码登录后重试。",409);
  if(/unauthorized|not authenticated|not logged|requires.*chatgpt|401/i.test(raw))return problem("quota_authorization_required","Codex 额度授权已失效或尚未完成，请重新连接额度读取。",409);
  if(/\b429\b|rate.?limit.{0,10}exceeded|too many requests/i.test(raw))return problem("quota_throttled","官方额度读取暂时被限流，请稍后重试。");
  if(/403|forbidden/i.test(raw))return problem("quota_permission_denied","此 Codex 授权暂时没有读取额度的权限，请重新授权或检查账号状态。");
  return problem("quota_rpc_failed","Codex 额度接口调用失败，请检查登录状态、网络连接或稍后重试。");
}

export function normalizeRateLimits(result,now=Date.now()) {
  if(!result||typeof result!=="object")throw problem("quota_invalid_response","官方额度响应格式无法识别。");
  const mapped=result.rateLimitsByLimitId;
  const entries=mapped&&typeof mapped==="object"&&!Array.isArray(mapped)&&Object.keys(mapped).length?Object.entries(mapped):result.rateLimits?[[result.rateLimits.limitId||"codex",result.rateLimits]]:[];
  const buckets=entries.map(([id,bucket])=>{
    if(!bucket||typeof bucket!=="object")throw problem("quota_invalid_response","官方额度窗口格式无法识别。");
    const windows=["primary","secondary"].map(kind=>{
      const value=bucket[kind];
      if(value==null)return null;
      if(typeof value.usedPercent!=="number"||!Number.isFinite(value.usedPercent))throw problem("quota_invalid_response","官方额度比例无法识别。");
      return {kind,usedPercent:value.usedPercent,remainingPercent:Math.max(0,Math.min(100,100-value.usedPercent)),windowDurationMins:typeof value.windowDurationMins==="number"&&value.windowDurationMins>0?value.windowDurationMins:null,resetAt:iso(value.resetsAt)};
    }).filter(Boolean);
    const credits=bucket.credits;
    return {id:String(id),name:typeof bucket.limitName==="string"?bucket.limitName:null,model:typeof bucket.normalModelSlug==="string"?bucket.normalModelSlug:null,planType:typeof bucket.planType==="string"?bucket.planType:null,windows,
      credits:credits?{hasCredits:typeof credits.hasCredits==="boolean"?credits.hasCredits:null,unlimited:typeof credits.unlimited==="boolean"?credits.unlimited:null,balance:typeof credits.balance==="string"?credits.balance:null}:null};
  });
  return {source:"codex_app_server",scope:"Codex 限额",observedAt:new Date(now).toISOString(),ordinaryUsageAllowed:typeof result.ordinaryUsageAllowed==="boolean"?result.ordinaryUsageAllowed:null,buckets};
}

// A private, account-specific CLI home. No model, thread or tool execution is exposed.
export class CodexQuotaClient {
  constructor(home,{binary,spawnImpl=spawn,timeoutMs=30000,onNotification=()=>{}}={}) {
    this.home=home;this.binary=binary;this.spawn=spawnImpl;this.timeoutMs=timeoutMs;this.onNotification=onNotification;
    this.sequence=0;this.pending=new Map();this.buffer="";this.closed=false;
  }
  async start() {
    await mkdir(this.home,{recursive:true,mode:0o700});await chmod(this.home,0o700);
    let binary=this.binary||process.env.GATEWAY_CODEX_BIN;
    if(!binary){
      const bundled="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
      try{await access(bundled,constants.X_OK);binary=bundled;}catch{binary="codex";}
    }
    const env={CODEX_HOME:this.home};
    for(const key of ["PATH","HOME","TMPDIR","LANG","LC_ALL","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","NO_PROXY","https_proxy","http_proxy","all_proxy","no_proxy","SSL_CERT_FILE","SSL_CERT_DIR"])if(process.env[key])env[key]=process.env[key];
    this.child=this.spawn(binary,["app-server","--listen","stdio://","-c",'cli_auth_credentials_store="file"',"-c","analytics.enabled=false"],{cwd:this.home,env,stdio:["pipe","pipe","ignore"]});
    this.child.on("error",()=>this.fail(problem("quota_runtime_unavailable","无法启动本机 Codex，请检查 CLI 安装或 GATEWAY_CODEX_BIN。")));
    this.child.on("exit",()=>this.fail(problem("quota_runtime_stopped","额度读取进程已停止，请重新同步。")));
    this.child.stdin.on("error",()=>this.fail(problem("quota_runtime_stopped","额度读取连接已中断。")));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data",chunk=>{
      this.buffer+=chunk;
      if(this.buffer.length>1024*1024){this.close();return;}
      let end;
      while((end=this.buffer.indexOf("\n"))>=0){
        const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
        let message;try{message=JSON.parse(line);}catch{this.close();return;}
        if(message.id!==undefined&&!message.method){
          const item=this.pending.get(message.id);if(!item)continue;
          this.pending.delete(message.id);clearTimeout(item.timer);
          if(message.error)item.reject(rpcProblem(item.method,message.error.message));else item.resolve(message.result);
        }else if(message.method&&message.id===undefined){
          Promise.resolve(this.onNotification(message)).catch(()=>{});
        }else if(message.method){this.send({id:message.id,error:{code:-32601,message:"Quota reader does not support this method"}});}
      }
    });
    await this.request("initialize",{clientInfo:{name:"pro_account_quota_reader",title:"Pro Account Console quota reader",version:"0.5.0"},capabilities:{experimentalApi:false}});
    this.send({method:"initialized",params:{}});
    return this;
  }
  send(message){if(!this.closed)this.child.stdin.write(JSON.stringify(message)+"\n");}
  request(method,params={}) {
    if(!METHODS.has(method))return Promise.reject(problem("quota_method_forbidden","额度读取器不允许此操作。",400));
    if(this.closed)return Promise.reject(problem("quota_runtime_stopped","额度读取连接已中断。"));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(problem("quota_timeout","官方额度读取超时，请稍后重试。"));this.close();},this.timeoutMs);timer.unref();
      this.pending.set(id,{resolve,reject,timer,method});this.send({id,method,params});
    });
  }
  fail(error){this.closed=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
  close(){this.fail(problem("quota_runtime_stopped","额度读取连接已关闭。"));this.child?.kill("SIGTERM");}
}

export class QuotaSync {
  constructor(store,{clientFactory,now=Date.now}={}) {
    this.store=store;this.now=now;this.clients=new Map();this.running=new Map();this.login=null;this.closed=false;
    this.clientFactory=clientFactory||((home,options)=>new CodexQuotaClient(home,options));
  }
  expected(id){
    this.store.assertAccountAvailable(id);
    const connection=this.store.accountStore(id).connection;
    if(!connection?.access_token||!connection.subject||!email(connection.email))throw problem("quota_identity_required","请先完成该账号的模型登录授权，再连接额度读取。",409);
    return {subject:connection.subject,email:email(connection.email)};
  }
  status(id){
    const state=this.store.quotaStates[id]||{};
    const connection=this.store.accountStore(id).connection;
    const bound=!!connection?.access_token&&!!state.binding&&state.binding.subject===connection.subject&&state.binding.email===email(connection.email);
    const snapshot=bound?state.snapshot:null;
    const stale=!!snapshot&&(state.status!=="ok"||this.now()-Date.parse(snapshot.observedAt)>2*SYNC_INTERVAL_MS);
    return {connected:bound,status:this.running.has(id)?"syncing":this.login?.accountId===id?"awaiting_authorization":bound?(state.status||"needs_authorization"):"needs_authorization",
      lastAttemptAt:state.lastAttemptAt||null,lastError:state.lastError||null,snapshot:snapshot?{...snapshot,stale,buckets:snapshot.buckets.map(bucket=>({...bucket,windows:bucket.windows.map(window=>({...window,stale:stale||!!(window.resetAt&&Date.parse(window.resetAt)<=this.now())}))}))}:null,
      syncIntervalMinutes:SYNC_INTERVAL_MS/60000};
  }
  async client(id){
    if(this.closed)throw problem("quota_runtime_stopped","额度读取服务已关闭。");
    const existing=this.clients.get(id);
    if(existing){const client=await existing;if(!client.closed)return client;this.clients.delete(id);}
    const home=path.join(this.store.directory,"quota-runtime",id);
    const promise=(async()=>{
      const client=this.clientFactory(home,{onNotification:message=>this.notification(id,message)});
      try{await client.start();return client;}catch(error){client.close();throw error;}
    })();
    this.clients.set(id,promise);
    try{const client=await promise;if(client.closed)throw problem("quota_runtime_stopped","额度读取进程已停止，请重新同步。");return client;}
    catch(error){this.clients.delete(id);throw error;}
  }
  async verify(id,client) {
    const expected=this.expected(id),result=await client.request("account/read",{refreshToken:false}),account=result?.account;
    if(account?.type!=="chatgpt")throw problem("quota_authorization_required","尚未完成此账号的 Codex 额度授权。",409);
    if(!email(account.email)||email(account.email)!==expected.email){
      await client.request("account/logout").catch(()=>{});
      await this.store.saveQuotaState(id,{binding:null,snapshot:null});
      throw problem("quota_identity_mismatch","额度授权登录了不同的账号。已断开该额度授权，请选择本行显示的账号重新登录。",409);
    }
    const workspaceId=result.workspaceRouting?.chatgptAccountId||null;
    const binding=this.store.quotaStates[id]?.binding;
    if(binding&&(binding.subject!==expected.subject||binding.email!==expected.email||binding.workspaceId&&binding.workspaceId!==workspaceId))throw problem("quota_identity_changed","额度读取身份或工作区已变化，请重新连接额度授权。",409);
    return {...expected,workspaceId};
  }
  sync(id,{force=false}={}) {
    this.store.assertAccountAvailable(id);
    if(this.running.has(id))return this.running.get(id);
    const promise=this.performSync(id,force).finally(()=>this.running.delete(id));
    this.running.set(id,promise);return promise;
  }
  async performSync(id,force) {
    try{
      this.expected(id);
      if(this.login?.accountId===id)throw problem("quota_login_pending","请先完成正在进行的额度授权。",409);
      const previous=this.store.quotaStates[id];
      if(!force&&previous?.status==="ok"&&this.now()-Date.parse(previous.snapshot?.observedAt)<60000&&this.status(id).connected)return this.status(id);
      // Do not fall back to the desktop/CLI's global login or infer an account ID from SIWC tokens.
      if(!previous?.binding){
        try{await access(path.join(this.store.directory,"quota-runtime",id,"auth.json"));}
        catch{throw problem("quota_authorization_required","需要为此账号连接一次 Codex 额度读取授权。",409);}
      }
      const client=await this.client(id),binding=await this.verify(id,client);
      const response=await client.request("account/rateLimits/read",{});
      if(response?.accountId&&binding.workspaceId&&response.accountId!==binding.workspaceId)throw problem("quota_snapshot_identity_mismatch","官方额度返回的账号与已登录工作区不一致，未保存该数据。");
      // Recheck the selected SIWC identity after asynchronous requests, before saving a snapshot.
      const current=this.expected(id);
      if(current.subject!==binding.subject||current.email!==binding.email)throw problem("quota_identity_changed","账号授权在同步期间变化，请重新连接额度读取。",409);
      const snapshot=normalizeRateLimits(response,this.now());
      await this.store.saveQuotaState(id,{binding,snapshot,status:"ok",lastAttemptAt:new Date(this.now()).toISOString(),lastError:null});
      this.store.audit("quota_synced",{accountId:id,source:snapshot.source,buckets:snapshot.buckets.length});
      return this.status(id);
    }catch(error){
      const safe=error instanceof PublicError?error:problem("quota_sync_failed","官方额度同步失败，请稍后重试。");
      await this.store.saveQuotaState(id,{status:safe.code==="quota_authorization_required"||safe.code==="quota_identity_required"?"needs_authorization":"error",lastAttemptAt:new Date(this.now()).toISOString(),lastError:{code:safe.code,message:safe.message}});
      throw safe;
    }
  }
  async syncAll(){
    const results=await Promise.all(this.store.management.accounts.map(async account=>{
      try{await this.sync(account.id,{force:true});return {accountId:account.id,ok:true};}
      catch(error){return {accountId:account.id,ok:false,error:{code:error.code,message:error.message}};}
    }));return {results};
  }
  async tick(){
    if(this.closed)return;
    await Promise.all(this.store.management.accounts.filter(account=>this.status(account.id).connected&&this.now()-(Date.parse(this.store.quotaStates[account.id]?.lastAttemptAt)||0)>=SYNC_INTERVAL_MS).map(account=>this.sync(account.id).catch(()=>{})));
  }
  async startLogin(id,{deviceCode=false}={}){
    this.expected(id);
    if(this.running.has(id))throw problem("quota_busy","该账号正在同步，请稍后连接授权。",409);
    if(this.login){
      if(this.login.accountId===id&&this.login.result)return this.login.result;
      throw problem("quota_login_busy","已有一个账号正在进行额度授权，请先完成或取消它。",409);
    }
    this.login={accountId:id};
    try{
      const client=await this.client(id);
      const type=deviceCode?"chatgptDeviceCode":"chatgpt",result=await client.request("account/login/start",{type});
      const url=new URL(deviceCode?result?.verificationUrl:result?.authUrl);
      if(result.type!==type||url.protocol!=="https:"||url.hostname!=="auth.openai.com"||url.username||url.password||typeof result.loginId!=="string"||(deviceCode&&(typeof result.userCode!=="string"||!/^[-A-Z0-9]{4,64}$/i.test(result.userCode))))throw problem("quota_invalid_login","Codex 未返回预期的官方授权信息。");
      const publicResult={authorizationUrl:url.href,mode:deviceCode?"device_code":"browser",...(deviceCode?{userCode:result.userCode}:{})};
      Object.assign(this.login,{loginId:result.loginId,result:publicResult});
      this.login.timer=setTimeout(()=>this.cancelLogin(id).catch(()=>{}),10*60*1000);this.login.timer.unref();
      await this.store.saveQuotaState(id,{lastError:null});
      this.store.audit("quota_login_started",{accountId:id});
      return publicResult;
    }catch(error){
      const failed=this.login;this.clearLogin();
      if(failed?.loginId){
        try{const client=await this.client(id);await client.request("account/login/cancel",{loginId:failed.loginId});}
        catch{const client=await this.clients.get(id);client?.close();}
      }
      const safe=error instanceof PublicError?error:problem("quota_login_failed","无法开始额度授权，请稍后重试。");
      await this.store.saveQuotaState(id,{status:"error",lastError:{code:safe.code,message:safe.message}});
      throw safe;
    }
  }
  clearLogin(){if(this.login?.timer)clearTimeout(this.login.timer);this.login=null;}
  async cancelLogin(id){
    this.store.getAccount(id);
    if(this.login?.accountId!==id)return {ok:true};
    const login=this.login;this.clearLogin();
    if(login.loginId){const client=await this.client(id);await client.request("account/login/cancel",{loginId:login.loginId});}
    return {ok:true};
  }
  async notification(id,message){
    if(this.store.removingAccounts.has(id))return;
    if(message.method!=="account/login/completed"||this.login?.accountId!==id)return;
    if(message.params?.loginId&&this.login.loginId&&message.params.loginId!==this.login.loginId)return;
    this.clearLogin();
    if(message.params?.success){
      // A deliberate reconnect allows a fresh workspace binding, but old data stays hidden until verified.
      await this.store.saveQuotaState(id,{binding:null,snapshot:null});
      await this.sync(id,{force:true}).catch(()=>{});
    }else await this.store.saveQuotaState(id,{status:"error",lastError:{code:"quota_login_failed",message:"额度授权未完成，请重新连接。"}});
  }
  async disconnect(id){
    await this.cancelLogin(id);
    if(this.running.has(id))await this.running.get(id).catch(()=>{});
    const client=await this.client(id);await client.request("account/logout",{});
    await this.store.saveQuotaState(id,{binding:null,snapshot:null,status:"needs_authorization",lastError:null});
    this.store.audit("quota_disconnected",{accountId:id});
    return {ok:true};
  }
  async removeAccount(id){
    if(this.login?.accountId===id)this.clearLogin();
    const pending=this.clients.get(id);this.clients.delete(id);
    if(!pending)return;
    const client=await pending.catch(()=>null);if(!client)return;
    const child=client.child;
    if(child&&child.exitCode===null&&child.signalCode===null){
      const stopped=once(child,"exit").catch(()=>{});
      client.close();
      const killTimer=setTimeout(()=>child.kill("SIGKILL"),3000);killTimer.unref();
      try{await stopped;}finally{clearTimeout(killTimer);}
    }else client.close();
  }
  close(){this.closed=true;this.clearLogin();for(const promise of this.clients.values())promise.then(client=>client.close()).catch(()=>{});this.clients.clear();}
}
