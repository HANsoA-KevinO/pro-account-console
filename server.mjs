import http from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {randomBytes,createHash} from "node:crypto";
import {Store} from "./lib/storage.mjs";
import {OAuth,PublicError,safeEqual,RESOURCE} from "./lib/oauth.mjs";
import {forwardResponses,normalizeRequest} from "./lib/responses.mjs";
import {sessionIdFromRequest} from "./lib/session.mjs";
import {Admissions} from "./lib/admissions.mjs";
import {SessionWebSockets} from "./lib/upstream-websocket.mjs";
import {HttpSessions} from "./lib/upstream-http-session.mjs";
import {Quality,collectedResponse} from "./lib/quality.mjs";
import {QuotaSync} from "./lib/quota.mjs";
import {Fingerprints,loadFingerprintLibrary} from "./lib/fingerprint.mjs";
import {isPrivateIPv4,discoverLanAddress,loadLanAuth,readLanAuth,validateLanAuth,acceptsBasicAuth} from "./lib/network.mjs";
import {runtimeConfig,publicOrigin} from "./lib/runtime.mjs";
import {keepStreamAlive} from "./lib/sse-keepalive.mjs";

const root=path.dirname(fileURLToPath(import.meta.url));
const contentTypes={"/app.js":"text/javascript","/style.css":"text/css"};
const cookies=req=>Object.fromEntries((req.headers.cookie||"").split(";").map(part=>part.trim().split("=")).filter(pair=>pair.length===2));
async function readBody(req) {
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new PublicError(413,"body_too_large","请求体超过 1 MiB 限制。");chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new PublicError(400,"invalid_json","请求体不是有效 JSON。");}
}
function json(res,status,value){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));}
function csv(rows) {
  const cell=value=>{
    let text=String(value??"");if(/^[=+@-]/.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return [
    ["time","account_id","agent_id","route_id","routing_strategy","source","requested_model","reported_model","status","input_tokens","output_tokens","cached_tokens","reasoning_tokens","duration_ms","first_token_ms","request_id","response_id","error_code","session_id","session_routing","queue_wait_ms","queued_at","upstream_transport","upstream_session_mode","upstream_connection_id","upstream_previous_response_id","upstream_sent_items","upstream_recovery_attempts","upstream_cache_key_hash","upstream_session_header_id","upstream_turn_routing","upstream_turn_state_sent","upstream_turn_state_received","upstream_cache_key_matches_session"],
    ...rows.map(row=>[row.time,row.accountId,row.agentId,row.routeId,row.routingStrategy,row.source,row.requestedModel,row.reportedModel,row.status,row.usage?.input_tokens,row.usage?.output_tokens,row.usage?.input_tokens_details?.cached_tokens,row.usage?.output_tokens_details?.reasoning_tokens,row.durationMs,row.firstTokenMs,row.requestId,row.responseId,row.errorCode,row.session_id,row.sessionRouting,row.queueWaitMs,row.queuedAt,row.upstreamTransport,row.upstreamSession?.mode,row.upstreamSession?.connectionId,row.upstreamSession?.previousResponseId,row.upstreamSession?.sentInputItems,row.upstreamSession?.recoveryAttempts,row.upstreamSession?.cacheKeyHash,row.upstreamSession?.sessionHeaderId,row.upstreamSession?.turnRouting,row.upstreamSession?.turnStateSent,row.upstreamSession?.turnStateReceived,row.upstreamSession?.cacheKeyMatchesSession]),
  ].map(row=>row.map(cell).join(",")).join("\r\n");
}

export async function createGateway({port=8787,directory=path.join(root,".data"),fetchImpl=fetch,oauthFactory,quotaClientFactory,lanAddress=null,adminAuth=null,adminAuthLoader=null,queueWaitMs=300000,sessionWebSockets=false,socketFactory,socketOptions={},httpSessionOptions={},bindHost="127.0.0.1",publicUrl=null,requireAdmin=false,databaseFactory,streamKeepaliveMs=0,adminCookieName="ag_admin",loginCookieName="ag_login"}={}) {
  publicUrl=publicOrigin(publicUrl);
  if(!/^[a-zA-Z][\w-]{0,63}$/.test(adminCookieName)||!/^[a-zA-Z][\w-]{0,63}$/.test(loginCookieName)||adminCookieName===loginCookieName)throw new Error("Invalid gateway cookie names");
  if(!["127.0.0.1","0.0.0.0"].includes(bindHost))throw new Error("Invalid bindHost");
  requireAdmin=requireAdmin||!!publicUrl||bindHost!=="127.0.0.1";
  if(requireAdmin)validateLanAuth(adminAuth);
  if(lanAddress&&(publicUrl||bindHost!=="127.0.0.1"))throw new Error("LAN and server mode cannot be combined");
  if(lanAddress){if(!isPrivateIPv4(lanAddress))throw new Error("内网入口只支持私有 IPv4 地址。");validateLanAuth(adminAuth);}
  const store=await new Store(directory,{databaseFactory}).init();
  const quota=new QuotaSync(store,{clientFactory:quotaClientFactory});
  const fingerprintLibrary=await loadFingerprintLibrary();
  const oauths=new Map(),catalogs=new Map();
  let origin,lanOrigin=null,lanServer=null,quality,fingerprints,timer;
  const getOAuth=id=>{
    store.getAccount(id);
    if(!oauths.has(id))oauths.set(id,oauthFactory?oauthFactory(store.accountStore(id),id):new OAuth(store.accountStore(id),{redirectUri:origin+"/auth/callback",fetchImpl}));
    return oauths.get(id);
  };
  const models=async(accountId,allowed=[])=>{
    if(!store.assertAccountAvailable(accountId).enabled)throw new PublicError(403,"account_disabled","账号已停用。");
    const oauth=getOAuth(accountId);
    let token;
    try{token=await oauth.accessToken();}
    catch(error){store.alert("authorization_required",accountId,null,null,"该账号需要检查登录授权。",{code:error.code||"auth_error"});throw error;}
    const upstream=await fetchImpl(RESOURCE+"/models",{headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(30000)});
    if(!upstream.ok)throw new PublicError(upstream.status,"model_list_failed","无法读取该账号的可用模型。");
    const result=await upstream.json();
    if(!Array.isArray(result.models))throw new PublicError(502,"invalid_model_catalog","模型列表格式与套餐接口预期不同。");
    const visible=result.models.filter(model=>model.visibility==="list").map(model=>({id:model.slug,object:"model",created:0,owned_by:"openai",display_name:model.display_name}));
    catalogs.set(accountId,{time:Date.now(),data:visible});
    return {object:"list",data:visible.filter(model=>!allowed.length||allowed.includes(model.id))};
  };
  const eligible=(id,model)=>{
    if(store.removingAccounts.has(id))return false;
    if(!getOAuth(id).status().sharing)return false;
    const cached=catalogs.get(id);
    return !model||!cached||Date.now()-cached.time>300000||cached.data.some(item=>item.id===model);
  };
  const validSession=scope=>{
    const account=store.management.accounts.find(item=>item.id===scope.accountId),agent=store.management.agents.find(item=>item.id===scope.agentId);
    return !!account?.enabled&&!!agent?.enabled&&getOAuth(scope.accountId).status().sharing&&store.accountIdentityHash(scope.accountId)===scope.identity;
  };
  const webSocketPool=sessionWebSockets?new SessionWebSockets({...socketOptions,socketFactory,valid:validSession}):null;
  const httpSessions=new HttpSessions({...httpSessionOptions,valid:validSession});
  const pruneSockets=()=>{webSocketPool?.prune();httpSessions.prune();};store.events.on("capacity",pruneSockets);
  const admissions=new Admissions(store,{eligible,waitTimeoutMs:queueWaitMs,serializeSessions:true});
  const routeStatuses=()=>store.publicRoutes().map(rule=>({
    ...rule,candidateAccountIds:store.candidateAccounts(rule),
    readyAccountIds:store.candidateAccounts(rule).filter(id=>store.getAccount(id).enabled&&eligible(id)),
  }));
  const keyCatalog=async agent=>{
    const ids=[...new Set(store.relevantRoutes(agent).flatMap(rule=>store.candidateAccounts(rule)))].filter(id=>store.getAccount(id).enabled&&eligible(id));
    if(!ids.length)throw new PublicError(503,"route_unavailable","统一路由当前没有已授权的可用账号。");
    const results=await Promise.allSettled(ids.map(id=>models(id)));
    const union=new Map();let failures=0;
    for(const result of results){
      if(result.status==="fulfilled")for(const model of result.value.data)union.set(model.id,model);
      else failures++;
    }
    if(!union.size&&failures===results.length)throw new PublicError(502,"model_catalogs_unavailable","路由账号的模型列表暂时无法读取。");
    const data=[];
    for(const model of union.values()){
      if(agent.allowedModels.length&&!agent.allowedModels.includes(model.id))continue;
      try{
        const decision=store.resolveRoute(agent,model.id,{eligible,advance:false});
        if(catalogs.get(decision.accountId)?.data.some(item=>item.id===model.id))data.push(model);
      }catch(error){if(!(error instanceof PublicError))throw error;}
    }
    return {object:"list",data};
  };
  const accountStatuses=()=>store.management.accounts.map(account=>({
    ...account,concurrency:{...store.accountConcurrency(account.id),queued:admissions.waitingForAccount(account.id)},auth:getOAuth(account.id).status(),quota:{...store.quotaFor(account.id),automatic:quota.status(account.id)},
    usage:store.report({accountId:account.id,limit:1}),
  }));
  const handler=async(req,res)=>{
    res.setHeader("x-content-type-options","nosniff");res.setHeader("referrer-policy","no-referrer");res.setHeader("x-frame-options","DENY");
    try{
      const localHost=req.headers.host===new URL(origin).host;
      const lanHost=lanOrigin&&req.headers.host===new URL(lanOrigin).host;
      const publicHost=publicUrl&&req.headers.host===new URL(publicUrl).host;
      const loopback=["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      if((!localHost&&!lanHost&&!publicHost)||(localHost&&!loopback&&!requireAdmin))throw new PublicError(403,"invalid_host","请使用配置的本机、内网或部署地址访问。");
      const requestOrigin=publicHost?publicUrl:localHost?origin:lanOrigin;
      const url=new URL(req.url,requestOrigin),segments=url.pathname.split("/").filter(Boolean),query=Object.fromEntries(url.searchParams);
      const existingAdminSession=store.adminSession(cookies(req)[adminCookieName]);
      let authFingerprint=null,validLanSession=false;
      if(req.headers.origin&&req.headers.origin!==requestOrigin)throw new PublicError(403,"invalid_origin","拒绝跨站请求。");
      if(req.headers["sec-fetch-site"]==="cross-site"&&!["/","/auth/callback"].includes(url.pathname))throw new PublicError(403,"cross_site_request","拒绝跨站请求。");
      if(req.method==="GET"&&url.pathname==="/healthz")return json(res,200,{ok:true,mode:requireAdmin?"self-hosted":"central-routing-local",connected:store.candidateAccounts(store.management.routes.find(rule=>rule.id==="route-default")).some(id=>store.getAccount(id).enabled&&eligible(id))});
      const protectedAdmin=lanHost||requireAdmin;
      if(protectedAdmin&&!url.pathname.startsWith("/v1/")){
        let currentAuth;
        try{currentAuth=adminAuthLoader?validateLanAuth(await adminAuthLoader()):adminAuth;}
        catch{throw new PublicError(503,"lan_admin_config_invalid","管理员凭据文件无效，请在运行环境修复 lan-admin.json 的用户名和密码。");}
        authFingerprint=createHash("sha256").update(JSON.stringify([currentAuth.username,currentAuth.password])).digest("hex");
        validLanSession=existingAdminSession?.origin===requestOrigin&&existingAdminSession.authFingerprint===authFingerprint;
        if(!validLanSession&&!acceptsBasicAuth(req.headers.authorization,currentAuth)){
          if(req.method==="GET"&&url.pathname==="/"){
            res.setHeader("www-authenticate",'Basic realm="Pro Account Console", charset="UTF-8"');
            return json(res,401,{error:{code:"lan_admin_required",message:"内网管理需要管理员用户名和密码。"}});
          }
          throw new PublicError(403,"lan_admin_required","管理登录状态已失效，请重新打开管理页面登录。");
        }
      }
      if((lanHost||publicHost)&&(url.pathname==="/auth/callback"||(req.method==="POST"&&(url.pathname==="/api/login"||/^\/api\/accounts\/[^/]+\/(?:quota\/)?login$/.test(url.pathname)))))throw new PublicError(403,"local_login_required","账号授权请在运行网关的电脑上打开 "+origin+" 完成；服务器部署请先建立 SSH 端口转发，再使用此回环地址授权。");
      if(req.method==="GET"&&url.pathname==="/"){
        const existing=existingAdminSession;
        const session=existing&&existing.origin===requestOrigin&&(!protectedAdmin||validLanSession)?existing:{id:randomBytes(32).toString("base64url"),csrf:randomBytes(32).toString("base64url"),expiresAt:Date.now()+86400000,origin:requestOrigin,authFingerprint};
        store.saveAdminSession(session);
        res.setHeader("set-cookie",adminCookieName+"="+session.id+"; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400"+(requestOrigin.startsWith("https:")?"; Secure":""));
        res.setHeader("content-security-policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});
        return res.end((await readFile(path.join(root,"public/index.html"),"utf8")).replace("__CSRF__",session.csrf));
      }
      if(req.method==="GET"&&Object.hasOwn(contentTypes,url.pathname)){res.writeHead(200,{"content-type":contentTypes[url.pathname],"cache-control":"no-store"});return res.end(await readFile(path.join(root,"public",url.pathname.slice(1))));}
      if(req.method==="GET"&&url.pathname==="/auth/callback"){
        const state=url.searchParams.get("state");
        const entry=[...oauths].find(([,oauth])=>oauth.pending?.has(state));
        if(entry){
          try{await entry[1].callback(url.searchParams,cookies(req)[loginCookieName]);store.audit("account_authorized",{accountId:entry[0],sharing:entry[1].status().sharing});}
          catch(error){entry[1].loginError=error instanceof PublicError?error.message:"登录验证失败，请重新登录。";store.alert("authorization_required",entry[0],null,null,entry[1].loginError,{code:error.code||"callback_failed"});}
        }else store.alert("authorization_required",null,null,null,"登录回调已过期或服务曾重启，请从账号页面重新授权。",{});
        res.writeHead(303,{location:"/","cache-control":"no-store","set-cookie":loginCookieName+"=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0"});return res.end();
      }
      if(url.pathname.startsWith("/api/")){
        const session=existingAdminSession;
        if(!session||session.origin!==requestOrigin||(protectedAdmin&&!validLanSession))throw new PublicError(protectedAdmin?403:401,"admin_required","管理登录状态已失效，请刷新并重新打开管理页面。");
        if(req.method==="POST"&&!safeEqual(req.headers["x-demo-csrf"],session.csrf))throw new PublicError(403,"invalid_csrf","操作校验失败，请刷新页面。");
        if(req.method==="GET"&&url.pathname==="/api/status")return json(res,200,{
          auth:store.management.activeAccountId?getOAuth(store.management.activeAccountId).status():{connected:false,sharing:false,email:null},usage:store.summary(),baseUrl:requestOrigin+"/v1",lanBaseUrl:lanOrigin?lanOrigin+"/v1":null,
          activeAccountId:store.management.activeAccountId,accounts:accountStatuses(),agents:store.publicAgents().map(agent=>({...agent,usage:{...agent.usage,queued:admissions.waitingForAgent(agent.id)}})),routes:routeStatuses(),queue:admissions.status(),
          publicBaseUrl:publicUrl?publicUrl+"/v1":null,
          deletedAccounts:store.management.deletedAccounts||[],
          upstreamSessions:webSocketPool?.status()||httpSessions.status(),
          fingerprintLibrary:fingerprintLibrary.info,
          pool:{strategy:"round_robin",totalAccounts:store.management.accounts.length,readyAccountIds:store.management.accounts.filter(account=>account.enabled&&eligible(account.id)).map(account=>account.id)},
          alerts:store.alerts(),audit:store.auditLog(),localOnly:!lanOrigin&&!publicUrl,
        });
        if(req.method==="GET"&&url.pathname==="/api/connection")return json(res,200,{baseUrl:requestOrigin+"/v1",apiKey:store.settings.gatewayKey,routing:"central"});
        if(req.method==="GET"&&url.pathname==="/api/models")return json(res,200,await models(query.accountId||store.management.activeAccountId));
        if(req.method==="GET"&&url.pathname==="/api/usage")return json(res,200,store.report(query));
        if(req.method==="GET"&&url.pathname==="/api/usage.csv"){res.writeHead(200,{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="gateway-usage.csv"',"cache-control":"no-store"});return res.end("\uFEFF"+csv(store.exportRows(query)));}
        if(req.method==="GET"&&url.pathname==="/api/quality")return json(res,200,{history:quality.history(query.accountId||store.management.activeAccountId)});
        if(req.method==="GET"&&url.pathname==="/api/fingerprint")return json(res,200,fingerprints.history(query));
        if(req.method==="GET"&&segments[1]==="fingerprint"&&segments[2])return json(res,200,fingerprints.get(segments[2]));
        if(req.method==="POST"){
          if(url.pathname==="/api/quota/sync")return json(res,200,await quota.syncAll());
          if(url.pathname==="/api/accounts")return json(res,201,await store.addAccount((await readBody(req)).name));
          if(url.pathname==="/api/keys")return json(res,201,await store.addAgent(await readBody(req)));
          if(url.pathname==="/api/routes")return json(res,201,await store.addRoute(await readBody(req)));
          if(url.pathname==="/api/routes/preview")throw new PublicError(410,"routing_options_removed","已改为全局账号池，不再提供按规则预览。");
          if(segments[1]==="routes"&&segments[2]){
            if(segments[3]==="delete"){await store.deleteRoute(segments[2]);return json(res,200,{ok:true});}
            if(segments.length===3)return json(res,200,await store.updateRoute(segments[2],await readBody(req)));
          }
          if(url.pathname==="/api/test"){
            const fields=await readBody(req),accountId=fields.accountId||store.management.activeAccountId;
            if(!store.assertAccountAvailable(accountId).enabled)throw new PublicError(403,"account_disabled","账号已停用。");
            const waiting=new AbortController(),cancel=()=>waiting.abort();res.on("close",cancel);
            try{return json(res,200,await collectedResponse({model:fields.model,input:fields.input,store:false},{oauth:getOAuth(accountId),store,fetchImpl,admissions,signal:waiting.signal,context:{accountId,agentId:null,source:"admin"}}));}
            finally{res.off("close",cancel);}
          }
          if(url.pathname==="/api/quality/run"||url.pathname==="/api/quality/policy"||url.pathname==="/api/quality/baseline")throw new PublicError(410,"legacy_quality_retired","答题质量检查已替换为模型指纹检测，旧记录仍可查看。");
          if(url.pathname==="/api/fingerprint/run"){const fields=await readBody(req);return json(res,202,fingerprints.start(fields.accountId||store.management.activeAccountId,fields));}
          if(url.pathname==="/api/fingerprint/cancel")return json(res,200,fingerprints.cancel((await readBody(req)).accountId));
          if(url.pathname==="/api/fingerprint/policy"){const fields=await readBody(req);await fingerprints.policy(fields.accountId,fields);return json(res,200,{ok:true});}
          if(url.pathname==="/api/quality/cancel")return json(res,200,quality.cancel((await readBody(req)).accountId));
          if(segments[1]==="accounts"&&segments[2]){
            const id=segments[2];store.assertAccountAvailable(id);
            if(segments[3]==="delete"&&segments.length===4){
              if(store.accountHasActiveRequests(id)||quality.running.has(id)||fingerprints.running.has(id)||quota.running.has(id))throw new PublicError(409,"account_busy","该账号有请求、指纹检测或额度同步正在执行，请完成后再删除。");
              store.removingAccounts.add(id);
              try{
                oauths.get(id)?.pending?.clear();
                await quota.removeAccount(id);
                await store.deleteAccount(id);
                oauths.delete(id);catalogs.delete(id);
                return json(res,200,{ok:true});
              }finally{store.removingAccounts.delete(id);}
            }
            if(segments[3]==="quota"){
              if(segments[4]==="sync")return json(res,200,await quota.sync(id,{force:true}));
              if(segments[4]==="login")return json(res,200,await quota.startLogin(id));
              if(segments[4]==="cancel")return json(res,200,await quota.cancelLogin(id));
              if(segments[4]==="logout")return json(res,200,await quota.disconnect(id));
            }
            if(segments.length===3)return json(res,200,await store.updateAccount(id,await readBody(req)));
            if(segments[3]==="select"){await store.selectAccount(id);return json(res,200,{ok:true});}
            if(segments[3]==="login"){
              if(!store.getAccount(id).enabled)throw new PublicError(403,"account_disabled","请先启用该账号。");
              const login=await getOAuth(id).start();
              res.setHeader("set-cookie",loginCookieName+"="+login.browser+"; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600");
              return json(res,200,{authorizationUrl:login.url});
            }
            if(segments[3]==="logout"){const result=await getOAuth(id).logout();store.audit("account_disconnected",{accountId:id});return json(res,200,result);}
          }
          if(segments[1]==="keys"&&segments[2]){
            if(segments[3]==="rotate")return json(res,200,await store.rotateAgent(segments[2]));
            if(segments.length===3)return json(res,200,await store.updateAgent(segments[2],await readBody(req)));
          }
          if(segments[1]==="alerts"&&segments[2]){store.acknowledge(segments[2]);return json(res,200,{ok:true});}
          if(url.pathname==="/api/login"){store.assertAccountAvailable(store.management.activeAccountId);const login=await getOAuth(store.management.activeAccountId).start();res.setHeader("set-cookie",loginCookieName+"="+login.browser+"; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600");return json(res,200,{authorizationUrl:login.url});}
          if(url.pathname==="/api/logout")return json(res,200,await getOAuth(store.management.activeAccountId).logout());
        }
      }
      if(url.pathname.startsWith("/v1/")){
        const agent=store.authenticate(req.headers.authorization);
        if(req.method==="GET"&&url.pathname==="/v1/models")return json(res,200,await keyCatalog(agent));
        if(req.method==="GET"&&url.pathname==="/v1/usage")return json(res,200,{name:agent.name,routing:"central",limits:{dailyRequests:agent.dailyRequests,dailyTokenThreshold:agent.dailyTokenThreshold,maxConcurrent:agent.maxConcurrent},today:{...store.agentUsage(agent),queued:admissions.waitingForAgent(agent.id)},queue:{waiting:admissions.waitingForAgent(agent.id),waitTimeoutMs:queueWaitMs},usage:store.report({...query,agentId:agent.id}),quota:{officialRemaining:null,scope:"per-account",note:"实际账号由统一路由选择，官方套餐额度分别管理。"}});
        if(req.method==="POST"&&url.pathname==="/v1/responses"){
          const body=await readBody(req);normalizeRequest(body);
          if(body.stream===true)keepStreamAlive(res,streamKeepaliveMs);
          const waiting=new AbortController(),cancel=()=>waiting.abort();res.on("close",cancel);
          let context;
          try{context=await admissions.agent(req.headers.authorization,body.model.trim(),{sessionId:sessionIdFromRequest(body),signal:waiting.signal});}
          finally{res.off("close",cancel);}
          if(res.destroyed||waiting.signal.aborted){await store.record({...context,status:"interrupted",errorCode:"request_cancelled",usage:{input_tokens:0,output_tokens:0}});return;}
          return await forwardResponses(body,{oauth:getOAuth(context.accountId),store,res,fetchImpl,context,webSocketPool,httpSessions});
        }
      }
      throw new PublicError(404,"not_found","当前版本没有提供该接口。");
    }catch(error){
      const status=error instanceof PublicError?error.status:500;
      // A Basic-auth browser can re-prompt on an API 401 even when the password
      // is correct. Only the initial document navigation issues that challenge.
      const adminApi401=status===401&&(requireAdmin||(lanOrigin&&req.headers.host===new URL(lanOrigin).host))&&req.url.startsWith("/api/");
      if(!res.headersSent&&!res.destroyed)json(res,adminApi401?403:status,{error:{code:error instanceof PublicError?error.code:"internal_error",message:error instanceof PublicError?error.message:"操作失败，请稍后重试。"}});
      else if(!res.destroyed){
        if(res.gatewayStreaming)res.end("event: error\ndata: "+JSON.stringify({type:"error",code:error instanceof PublicError?error.code:"internal_error",message:error instanceof PublicError?error.message:"操作失败，请稍后重试。",status})+"\n\n");
        else res.end();
      }
    }
  };
  const server=http.createServer(handler);
  try{await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,bindHost,resolve);});}
  catch(error){admissions.close();webSocketPool?.close();httpSessions.close();store.events.off("capacity",pruneSockets);quota.close();store.close();throw error;}
  origin="http://127.0.0.1:"+server.address().port;
  if(lanAddress){
    lanOrigin="http://"+lanAddress+":"+server.address().port;
    lanServer=http.createServer(handler);
    try{await new Promise((resolve,reject)=>{lanServer.once("error",reject);lanServer.listen(server.address().port,lanAddress,resolve);});}
    catch(error){admissions.close();webSocketPool?.close();httpSessions.close();store.events.off("capacity",pruneSockets);await new Promise(resolve=>server.close(resolve));quota.close();store.close();throw error;}
  }
  quality=new Quality(store,getOAuth,fetchImpl);
  fingerprints=new Fingerprints(store,getOAuth,fetchImpl,fingerprintLibrary,admissions);
  timer=setInterval(()=>{fingerprints.tick().catch(()=>{});quota.tick().catch(()=>{});},60000);timer.unref();
  quota.tick().catch(()=>{});
  let localClosed=false,lanClosed=!lanServer;
  const release=()=>{if(!localClosed||!lanClosed)return;admissions.close();webSocketPool?.close();httpSessions.close();store.events.off("capacity",pruneSockets);clearInterval(timer);quota.close();for(const job of fingerprints.running.values())job.stopRequested=true;if(!quality.running.size&&!fingerprints.running.size&&!quota.running.size)store.close();};
  server.on("close",()=>{localClosed=true;if(lanServer?.listening)lanServer.close();release();});
  lanServer?.on("close",()=>{lanClosed=true;release();});
  const close=()=>{admissions.close();webSocketPool?.close();httpSessions.close();return Promise.all([server,lanServer].filter(Boolean).map(listener=>new Promise(resolve=>listener.listening?listener.close(resolve):resolve())));};
  return {server,lanServer,store,getOAuth,quality,fingerprints,quota,admissions,webSocketPool,httpSessions,origin,lanOrigin,close,get oauth(){return getOAuth(store.management.activeAccountId);}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {port,directory,bindHost,publicUrl,requireAdmin,transport,queueWaitMs,lan}=runtimeConfig(root);
  const lanAddress=lan?discoverLanAddress():null;
  const adminAuth=lanAddress||requireAdmin?await loadLanAuth(directory):null;
  const {origin,lanOrigin,close}=await createGateway({port,directory,bindHost,publicUrl,requireAdmin,lanAddress,adminAuth,adminAuthLoader:lanAddress||requireAdmin?()=>readLanAuth(directory):null,queueWaitMs,sessionWebSockets:transport==="websocket"});
  console.log("Agent Gateway multi-account manager: "+origin);
  if(lanOrigin){console.log("LAN administration and Responses API: "+lanOrigin);console.log("LAN administrator credentials: "+path.join(directory,"lan-admin.json"));}
  if(requireAdmin){console.log("Server administrator credentials: "+path.join(directory,"lan-admin.json"));if(publicUrl)console.log("Public administration and Responses API: "+publicUrl);}
  console.log("Existing authorizations are retained; periodic fingerprint checks are off until enabled.");
  console.log("Upstream session transport: "+transport+"; requests without session_id use HTTP/SSE.");
  const stop=()=>close().then(()=>process.exit(0));process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
