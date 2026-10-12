const q=s=>document.querySelector(s);
const csrf=document.body.dataset.csrf;
let data,qualityAccountId,connection,offset=0,lastReport,modelAccountId=null,scheduleDirty=false,refreshVersion=0,usageVersion=0,fingerprintOffset=0,fingerprintVersion=0,fingerprintRunning=[];
let refreshTimer,adminRecoveryPending=false;
const comparisonNames={stable:"未见明显回归",baseline_needed:"需要同条件基线",repeat_needed:"表现退步 · 需要复测",quality_regression:"连续质量回归",execution_issue:"执行或模型标识问题"};
const alertNames={model_id_difference:"模型标识差异",quality_regression:"旧版质量回归提醒",fingerprint_difference:"疑似模型身份差异",fingerprint_repeated_difference:"多组指纹差异",fingerprint_mixed:"指纹复测存在分歧",fingerprint_drift:"模型指纹变化",fingerprint_candidate:"新模型的指纹候选线索",authorization_required:"需要重新授权",official_usage_limit:"官方额度限制",local_limit:"平台限额",routing_unavailable:"路由账号不可用"};
const fingerprintNames={compatible:"与对照指纹相符",suspected_difference:"疑似模型身份差异",repeated_difference:"多组复测支持差异",weak_difference:"候选偏离 · 较弱线索",inconclusive:"候选未明显区分",partial_evidence:"有效样本不足 · 排名供参考",unlisted_model:"新模型 · 候选参考",unlisted_consistent:"新模型 · 多组候选稳定",unlisted_mixed:"新模型 · 复测候选变化",mixed_evidence:"复测存在分歧",fingerprint_drift:"相较历史指纹发生变化",execution_issue:"检测未完整完成"};
const fingerprintWarn=new Set(["suspected_difference","repeated_difference","weak_difference","mixed_evidence","fingerprint_drift","unlisted_mixed"]);
const percent=value=>Number.isFinite(value)?value>0&&value<0.0001?"<0.01%":(100*value).toFixed(2)+"%":"—";
const fmt=n=>Number(n??0).toLocaleString();
const date=v=>v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Tokyo",hour12:false}):"—";
function node(tag,attrs={},...children){
  const element=document.createElement(tag);
  for(const[key,value]of Object.entries(attrs)){
    if(key.startsWith("on"))element.addEventListener(key.slice(2).toLowerCase(),value);
    else if(key==="class")element.className=value;
    else if(key==="text")element.textContent=value;
    else if(key==="checked"||key==="disabled"||key==="value")element[key]=value;
    else element.setAttribute(key,value);
  }
  for(const child of children.flat())if(child!==null&&child!==undefined)element.append(child instanceof Node?child:document.createTextNode(String(child)));
  return element;
}
function notice(text){q("#notice").textContent=text;q("#notice").hidden=!text;}
function recoverAdminSession(){
  if(adminRecoveryPending)return;
  adminRecoveryPending=true;clearInterval(refreshTimer);
  try{
    const last=Number(sessionStorage.getItem("ag_admin_recovery_at")||0);
    if(Date.now()-last<60000)return;
    sessionStorage.setItem("ag_admin_recovery_at",String(Date.now()));
    sessionStorage.setItem("ag_admin_recovery_page",q('[data-page][aria-current="page"]')?.dataset.page||"accounts");
    location.replace("/login?reason=expired");
  }catch{/* Storage may be disabled; keep polling stopped and show the error. */}
}
async function call(route,options={}){
  if(adminRecoveryPending)throw new Error("管理登录状态已失效，请刷新管理页面后继续。");
  const r=await fetch(route,{cache:"no-store",...options,headers:{"content-type":"application/json","x-demo-csrf":csrf,...options.headers}});
  const body=await r.json();
  if(!r.ok){
    if(["admin_required","lan_admin_required","invalid_csrf"].includes(body.error?.code))recoverAdminSession();
    throw new Error(body.error?.message||"操作失败（"+r.status+"）");
  }
  if(route==="/api/status")try{sessionStorage.removeItem("ag_admin_recovery_at");}catch{}
  return body;
}
const post=(route,body={})=>call(route,{method:"POST",body:JSON.stringify(body)});
const account=id=>data.accounts.find(item=>item.id===id);
const accountName=id=>account(id)?.name||(data.deletedAccounts?.find(item=>item.id===id)?data.deletedAccounts.find(item=>item.id===id).name+"（已删除）":id||"—");
const agentName=id=>data.agents.find(item=>item.id===id)?.name||(id?"历史接入":"管理／质量检查");
const button=(text,action,cls="")=>node("button",{type:"button",class:cls,onClick:async()=>{try{await action();}catch(error){notice(error.message);}}},text);
function fillSelect(selector,items,empty){
  const element=q(selector),previous=element.value;
  element.replaceChildren(...(empty!==undefined?[node("option",{value:""},empty)]:[]),...items.map(item=>node("option",{value:item.id},item.name)));
  if([...element.options].some(option=>option.value===previous))element.value=previous;
}
function dl(rows){return node("dl",{class:"detail-list"},rows.map(([label,value])=>node("div",{},node("dt",{},label),node("dd",{},value))));}
function showDetails(title,content){
  q("#detail-title").textContent=title;q("#detail-content").replaceChildren(content);q("#detail-dialog").showModal();
}
function field(label,name,type,value,extra={}){
  const input=type==="textarea"?node("textarea",{name,rows:3,...extra},value??""):node("input",{name,type,value:value??"",...extra});
  return node("label",{},label,input);
}
function editor(title,fields,onSave){
  q("#editor-title").textContent=title;q("#editor-fields").replaceChildren(...fields);q("#editor-error").textContent="";
  q("#editor-form").onsubmit=async event=>{
    event.preventDefault();q("#editor-save").disabled=true;
    try{const form=new FormData(event.target),values=Object.fromEntries(form);await onSave(values,form);q("#editor-dialog").close();await refresh();}
    catch(error){q("#editor-error").textContent=error.message;}
    finally{q("#editor-save").disabled=false;}
  };
  q("#editor-dialog").showModal();
}
function keyConfig(key){
  const config={base_url:data.baseUrl,api_key:key,model:"<从 /v1/models 选择可用模型>"};
  const text=JSON.stringify(config,null,2);
  showDetails("接入配置 · 请妥善保存",node("div",{},node("p",{class:"note"},"独立 key 只在创建或轮换时显示。它使用统一账号池；OpenAI 令牌不会发给 agent。"),node("textarea",{class:"secret",readOnly:"",rows:7},text),button("复制配置",async()=>{await navigator.clipboard.writeText(text);notice("接入配置已复制。");},"primary")));
}
function editKey(agent){
  const current=agent||{name:"",allowedModels:[],dailyRequests:null,dailyTokenThreshold:null,maxConcurrent:2};
  editor(agent?"编辑接入权限":"添加接入 Key",[
    field("成员／Agent 名称","name","text",current.name,{required:"",maxlength:100}),
    field("允许模型（逗号分隔，留空允许路由可用模型）","models","textarea",current.allowedModels.join(", ")),
    node("div",{class:"two-fields"},field("每日请求上限（留空不限制）","dailyRequests","number",current.dailyRequests,{min:1,max:1000000}),field("每日 token 暂停阈值（留空不限制）","dailyTokenThreshold","number",current.dailyTokenThreshold,{min:1,max:1000000000})),
    field("最大并发请求（自行设置）","maxConcurrent","number",current.maxConcurrent,{required:"",min:1}),
    node("p",{class:"note"},"日请求上限包含进行中的请求；token 阈值依据已报告用量，不能保证单次请求不超额。"),
  ],async values=>{
    const payload={name:values.name,allowedModels:values.models.split(/[,，\s]+/).filter(Boolean),dailyRequests:values.dailyRequests?Number(values.dailyRequests):null,dailyTokenThreshold:values.dailyTokenThreshold?Number(values.dailyTokenThreshold):null,maxConcurrent:Number(values.maxConcurrent)};
    if(agent)await post("/api/keys/"+agent.id,payload);
    else{const result=await post("/api/keys",payload);keyConfig(result.apiKey);}
  });
}
function accountDetails(item){
  showDetails(item.name+" · 账号信息",node("div",{},
    dl([["当前并发 / 上限",fmt(item.concurrency.active)+" / "+fmt(item.maxConcurrent)],["排队请求",fmt(item.concurrency.queued)],["授权到期",date(item.auth.expiresAt)],["套餐权限",item.auth.sharing?"已授权":"未授权"],["最近官方额度错误",date(item.quota.recentQuotaError)]]),
    item.auth.error?node("p",{class:"note danger"},item.auth.error):null,
    item.quota.automatic?node("div",{},node("h3",{},"官方 Codex 限额"),quotaView(item),node("p",{class:"note"},"来源：Codex app-server · account/rateLimits/read。与本行模型授权的登录邮箱核对，并固定工作区。此数据不等于 Responses 接入的总额度。")):null,
    item.quota.rateLimits?node("div",{},node("h3",{},"上游短时限流信息（不等于套餐剩余额度）"),node("pre",{},JSON.stringify(item.quota.rateLimits,null,2))):null,
    node("div",{class:"actions"},
      button("设置并发",()=>editAccountConcurrency(item)),
      button("修改账号备注",()=>{q("#detail-dialog").close();editor("账号备注",[field("名称","name","text",item.name,{required:"",maxlength:100})],values=>post("/api/accounts/"+item.id,{name:values.name}));}),
      item.auth.connected?button("断开模型授权",async()=>{await post("/api/accounts/"+item.id+"/logout");q("#detail-dialog").close();await refresh();},"danger"):null,
      item.quota.automatic?.connected?button("断开额度授权",async()=>{await post("/api/accounts/"+item.id+"/quota/logout");q("#detail-dialog").close();await refresh();},"danger"):null,
      button("删除账号",()=>confirmAccountDeletion(item),"danger"))));
}
function editAccountConcurrency(item){
  if(q("#detail-dialog").open)q("#detail-dialog").close();
  editor(item.name+" · 并发上限",[
    field("该账号最大并发请求","maxConcurrent","number",item.maxConcurrent,{required:"",min:1,step:1}),
    node("p",{class:"note"},"所有接入 key、指纹检测和管理员测试共用此账号的上限。达到上限自动排队，已绑定会话在原账号等待。"),
    node("p",{class:"note"},"调低上限不会中断正在执行的请求，后续请求按新上限接收。并发数仅统计经过本平台的模型请求。"),
  ],async values=>{await post("/api/accounts/"+item.id,{maxConcurrent:Number(values.maxConcurrent)});notice(item.name+" 的并发上限已设置为 "+values.maxConcurrent+"。");});
}
function confirmAccountDeletion(item){
  if(q("#detail-dialog").open)q("#detail-dialog").close();
  const errorText=node("p",{class:"note danger",role:"alert"});
  const confirm=button("确认删除",async()=>{
    confirm.disabled=true;cancel.disabled=true;errorText.textContent="";
    try{
      await post("/api/accounts/"+item.id+"/delete");
      q("#detail-dialog").close();await refresh();notice("已删除账号“"+item.name+"”。历史用量日志已保留。");
    }catch(error){errorText.textContent=error.message;}
    finally{confirm.disabled=false;cancel.disabled=false;}
  },"danger");
  const cancel=button("取消",()=>q("#detail-dialog").close());
  showDetails("删除账号 · "+item.name,node("div",{},
    node("p",{},"确认从本地账号池删除“"+item.name+"”"+(item.auth.email?"（"+item.auth.email+"）":"")+"？"),
    node("p",{},"将清理此账号的本地模型授权、额度授权和额度快照，账号不再参与轮询。以后重新添加时需要重新登录。"),
    node("p",{class:"note"},"历史用量、指纹检测、旧版检查和审计记录保留，并标记账号已删除。此操作只移除本地接入，不会注销 ChatGPT 账号；现有接入 key 继续使用其余账号。"),
    node("div",{class:"actions"},confirm,cancel),errorText));
}
const windowLabel=minutes=>minutes?minutes%1440===0?minutes/1440+" 天窗口":minutes%60===0?minutes/60+" 小时窗口":minutes+" 分钟窗口":"时长未提供";
function quotaView(item){
  const automatic=item.quota.automatic,snapshot=automatic?.snapshot,manual=item.quota.manualSnapshot;
  return node("div",{class:"quota-content"},
    snapshot?node("div",{},node("span",{class:"badge "+(snapshot.stale?"warn":"good")},"Codex · 官方同步"+(snapshot.stale?" · 过时":"")),
      snapshot.buckets.map(bucket=>node("div",{class:"quota-bucket"},node("div",{class:"note"},bucket.name||bucket.id,bucket.model?" · "+bucket.model:""),
        bucket.windows.length?bucket.windows.map(window=>node("div",{class:"quota-window"},
          node("div",{class:"quota-window-heading"},node("span",{},windowLabel(window.windowDurationMins)),node("strong",{class:window.stale?"danger":""},window.remainingPercent+"% 剩余"+(window.stale?" · 过时":""))),
          node("progress",{value:window.remainingPercent,max:100,"aria-label":windowLabel(window.windowDurationMins)+"剩余额度"}),
          window.resetAt?node("div",{class:"note"},"重置 "+date(window.resetAt)):node("div",{class:"note"},"重置时间未提供"))):node("div",{class:"note"},"该额度桶未提供百分比窗口"),
        bucket.credits?.unlimited===true?node("div",{class:"note"},"额外 credits：官方标记为不限量"):bucket.credits?.balance!==null&&bucket.credits?.balance!==undefined?node("div",{class:"note"},"额外 credits："+bucket.credits.balance):null)),
      !snapshot.buckets.length?node("div",{class:"note"},"官方未提供可显示的额度桶"):null,
      snapshot.ordinaryUsageAllowed===false?node("div",{class:"note danger"},"官方报告普通包含用量当前不可用"):null,
      node("div",{class:"note"},"同步 "+date(snapshot.observedAt))):node("div",{},node("span",{},"未知"),node("div",{class:"note"},automatic?.status==="awaiting_authorization"?"等待完成额度授权":automatic?.status==="syncing"?"正在同步额度":"需单独连接额度读取")),
    automatic?.lastError?node("div",{class:"note danger"},automatic.lastError.message):null,
    manual?node("div",{class:"quota-bucket"},node("div",{class:"quota-value"},manual.remainingPercent+"% 剩余 ",node("span",{class:"badge "+(manual.stale?"warn":"")},"手工快照"+(manual.stale?" · 过时":""))),node("div",{class:"note"},manual.window+" · "+date(manual.observedAt)),manual.resetAt?node("div",{class:"note"},"重置 "+date(manual.resetAt)):null):null);
}
async function connectQuota(item){
  const result=await post("/api/accounts/"+item.id+"/quota/login");
  showDetails(item.name+" · 连接额度读取",node("div",{},
    node("p",{},"请在官方授权页面登录 "+item.auth.email+"。授权完成后会自动核对邮箱并读取额度；若登录其他账号，将断开这次额度授权。"),
    node("p",{class:"note"},"这是独立的 Codex 额度授权。授权页面完成后可关闭新标签页，回到这里查看同步结果。"),
    result.mode==="device_code"?node("div",{class:"device-code"},node("span",{class:"note"},"在官方页面输入一次性验证码"),node("strong",{},result.userCode),node("p",{class:"note"},"如未启用设备码登录，请先在 ChatGPT 的安全设置中开启。")):null,
    node("a",{class:"button primary",href:result.authorizationUrl,target:"_blank",rel:"noopener noreferrer"},"打开官方授权 ↗"),
    node("div",{class:"actions"},button("我已完成，刷新状态",async()=>{q("#detail-dialog").close();await refresh();}),button("取消此次授权",async()=>{await post("/api/accounts/"+item.id+"/quota/cancel");q("#detail-dialog").close();await refresh();}))));
  await refresh();
}
async function connectAccount(item){
  const result=await post("/api/accounts/"+item.id+"/login");
  if(result.completionMode!=="manual_callback"){location.assign(result.authorizationUrl);return;}
  const input=node("textarea",{name:"callbackUrl",rows:3,required:"",maxlength:16384,autocomplete:"off",spellcheck:"false",placeholder:result.callbackUrl+"?code=…&state=…"});
  const error=node("p",{class:"note danger",role:"status","aria-live":"polite",hidden:""});
  const submit=node("button",{type:"submit",class:"primary"},"完成账号授权");
  const form=node("form",{},node("label",{},"完整回调地址",input),error,node("div",{class:"actions"},submit));
  form.onsubmit=async event=>{
    event.preventDefault();submit.disabled=true;error.hidden=true;
    try{await post("/api/accounts/"+item.id+"/complete-login",{callbackUrl:input.value.trim()});input.value="";q("#detail-dialog").close();await refresh();notice("账号授权已完成。");}
    catch(problem){error.textContent=problem.message;error.hidden=false;}finally{submit.disabled=false;}
  };
  showDetails(item.name+" · 云端账号授权",node("div",{},
    node("p",{},"1. 打开官方授权页，登录本次要接入的 ChatGPT 账号，并确认套餐调用权限。"),
    node("a",{class:"button primary",href:result.authorizationUrl,target:"_blank",rel:"noopener noreferrer"},"打开官方授权 ↗"),
    node("p",{},"2. 最后会跳到 127.0.0.1 的回调地址。页面可能显示无法连接；复制地址栏中的完整地址，回到这里粘贴。"),
    node("p",{class:"note"},"授权将在 10 分钟后过期。云端核对本次授权并保存凭据；回调地址仅用于完成此次授权。"),form));
}
function renderAccounts(){
  q("#pool-total").textContent=data.accounts.length;
  q("#pool-ready").textContent=data.pool.readyAccountIds.length;
  q("#pool-tokens").textContent=fmt(data.usage.inputTokens)+" / "+fmt(data.usage.outputTokens);
  q("#pool-requests").textContent=fmt(data.usage.requests)+" 条已保存请求 · "+fmt(data.usage.missingUsage)+" 条用量未知";
  q("#pool-status").textContent="统一轮询 · "+data.pool.readyAccountIds.length+" / "+data.accounts.length+" 个账号可参与 · 排队 "+fmt(data.queue?.waiting);
  q("#account-rows").replaceChildren(...data.accounts.map(item=>{
    const ready=data.pool.readyAccountIds.includes(item.id);
    const status=!item.enabled?"已停用":ready?(item.concurrency.saturated?"并发已满":"参与轮询"):item.auth.connected?"缺少套餐权限":"待授权";
    const automatic=item.quota.automatic;
    const quota=quotaView(item);
    const needsLogin=!automatic?.connected||automatic.status==="needs_authorization"||automatic.lastError?.code==="quota_identity_changed";
    const syncButton=needsLogin?button(automatic?.status==="awaiting_authorization"?"继续额度授权":"连接额度读取",()=>connectQuota(item)):button("同步额度",async()=>{await post("/api/accounts/"+item.id+"/quota/sync");await refresh();notice(item.name+" 的 Codex 额度已同步。");});
    syncButton.disabled=automatic?.status==="syncing"||!item.auth.connected;
    return node("tr",{"data-account-id":item.id},node("td",{"data-label":"账号"},node("div",{class:"account-name"},item.name),node("div",{class:"email"},item.auth.email||"尚未授权")),
      node("td",{"data-label":"池内状态"},node("span",{class:"badge "+(item.concurrency.saturated?"warn":ready?"good":"")},status),
        node("div",{class:"account-concurrency"},node("span",{class:"count"},"并发 "+fmt(item.concurrency.active)+" / "+fmt(item.maxConcurrent)),node("span",{class:"note"},"排队 "+fmt(item.concurrency.queued)),button("设置并发",()=>editAccountConcurrency(item),"quiet")),
        item.auth.error?node("div",{class:"note danger"},item.auth.error):null),
      node("td",{"data-label":"官方额度 · 按来源"},quota,node("div",{class:"actions compact"},syncButton,button("手工记录",()=>editQuota(item),"quiet"))),
      node("td",{class:"count","data-label":"累计输入 / 输出"},fmt(item.usage.inputTokens)+" / "+fmt(item.usage.outputTokens),node("div",{class:"note"},fmt(item.usage.requests)+" 次记录")),
      node("td",{"data-label":"操作"},node("div",{class:"actions compact"},
        button(item.enabled?"停用":"启用",async()=>{await post("/api/accounts/"+item.id,{enabled:!item.enabled});await refresh();},item.enabled?"":"primary"),
        button(item.auth.connected?"重新授权":"登录授权",()=>connectAccount(item)),
        button("详情",()=>accountDetails(item)),
        button("删除",()=>confirmAccountDeletion(item),"danger"))));
  }));
  if(!data.accounts.length)q("#account-rows").append(node("tr",{},node("td",{colspan:5,class:"empty"},"暂无账号，点击“添加 Pro 账号”接入。")));
}
function editQuota(item){
  const value=item.quota.manualSnapshot||{};
  editor("手工记录官方额度（不自动推算）",[
    field("官方页面显示的窗口名称","window","text",value.window||"周额度",{required:"",maxlength:100}),
    field("剩余百分比","remainingPercent","number",value.remainingPercent??"",{required:"",min:0,max:100,step:0.1}),
    field("重置时间（可留空，按浏览器本地时间）","resetAt","datetime-local",""),
    node("p",{class:"note"},"这里只保存你从官方用量页面读取的快照，显示记录时间，超过 1 小时标为过时。"),
    node("a",{href:"https://chatgpt.com/settings/usage",target:"_blank",rel:"noopener noreferrer"},"打开官方用量设置 ↗"),
    value.observedAt?button("清除当前快照",async()=>{await post("/api/accounts/"+item.id,{officialSnapshot:null});q("#editor-dialog").close();await refresh();},"quiet"):null,
  ],values=>post("/api/accounts/"+item.id,{officialSnapshot:{window:values.window,remainingPercent:Number(values.remainingPercent),resetAt:values.resetAt?new Date(values.resetAt).toISOString():null}}));
}
function renderKeys(){
  q("#base-url").textContent=data.baseUrl;
  q("#key-cards").replaceChildren(...data.agents.map(agent=>node("article",{class:"key-card"},
    node("div",{class:"section-heading"},node("div",{},node("div",{class:"account-name"},agent.name),node("code",{},agent.keyPrefix+"…")),node("span",{class:"badge "+(agent.enabled?"good":"")},agent.enabled?"启用":"停用")),
    dl([["账号分配","统一账号池轮询"],["允许模型",agent.allowedModels.length?agent.allowedModels.join(", "):"账号池支持的可用模型"],["今日请求剩余",agent.usage.requestsRemaining===null?"未设置上限":fmt(agent.usage.requestsRemaining)+" / "+fmt(agent.dailyRequests)],["token 阈值剩余",agent.usage.tokenThresholdRemaining===null?"未设置阈值":fmt(agent.usage.tokenThresholdRemaining)],["今日已报告 tokens",fmt(agent.usage.tokens)],["并发占用",agent.usage.active+" / "+agent.maxConcurrent],["排队请求",fmt(agent.usage.queued)]]),
    agent.usage.missingUsage?node("p",{class:"note danger"},agent.usage.missingUsage+" 次用量未知；设置 token 阈值时会暂停后续请求。"):null,
    node("div",{class:"actions"},button("编辑权限",()=>editKey(agent)),button(agent.enabled?"停用":"启用",async()=>{await post("/api/keys/"+agent.id,{enabled:!agent.enabled});await refresh();}),button("轮换 Key",async()=>{const result=await post("/api/keys/"+agent.id+"/rotate");await refresh();keyConfig(result.apiKey);},"danger")),
    node("p",{class:"note"},"轮换会立即使旧 key 失效；账号授权不变。"))));
}
function usageQuery(){
  const params=new URLSearchParams({limit:"30",offset:String(offset)});
  for(const[id,key]of [["#usage-account","accountId"],["#usage-agent","agentId"],["#usage-model","model"]])if(q(id).value.trim())params.set(key,q(id).value.trim());
  const period=q("#usage-period").value;
  if(period==="today"){
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(item=>[item.type,item.value]));
    params.set("from",new Date(parts.year+"-"+parts.month+"-"+parts.day+"T00:00:00+09:00").toISOString());
  }else if(period!=="all")params.set("from",new Date(Date.now()-Number(period)*86400000).toISOString());
  return params;
}
async function loadUsage(){
  const version=++usageVersion;
  const params=usageQuery(),report=await call("/api/usage?"+params);
  if(version!==usageVersion)return;
  lastReport=report;
  q("#usage-scope-label").textContent=q("#usage-period").value==="all"&&!q("#usage-account").value&&!q("#usage-agent").value&&!q("#usage-model").value.trim()?"全部请求记录":"筛选结果";
  q("#export-usage").href="/api/usage.csv?"+params;
  q("#usage-count").textContent=fmt(lastReport.requests);q("#usage-success").textContent=fmt(lastReport.completed)+" 次完整成功";
  q("#usage-tokens").textContent=fmt(lastReport.inputTokens)+" / "+fmt(lastReport.outputTokens);
  q("#usage-details").textContent="其中缓存输入 "+fmt(lastReport.cachedTokens)+" · 推理输出 "+fmt(lastReport.reasoningTokens);
  q("#usage-duration").textContent=lastReport.averageDurationMs===null?"—":(lastReport.averageDurationMs/1000).toFixed(2)+" s";
  q("#usage-unknown").textContent=fmt(lastReport.missingUsage)+" 次未确认完整用量";
  q("#usage-breakdown").replaceChildren(...[["按账号",lastReport.byAccount,accountName],["按接入",lastReport.byAgent,agentName]].map(([title,rows,label])=>node("div",{class:"panel"},node("h2",{},title),rows.length?rows.map(row=>node("div",{class:"group-row"},node("span",{},label(row.id)),node("span",{},fmt(row.requests)+" 次 · "+fmt(row.inputTokens+row.outputTokens)+" tokens"))):node("div",{class:"empty"},"暂无记录"))));
  q("#usage-rows").replaceChildren(...lastReport.records.map(row=>node("tr",{},
    node("td",{},date(row.time)),node("td",{},accountName(row.accountId)),node("td",{},row.agentId?agentName(row.agentId):row.source==="fingerprint"?"指纹检测":row.source==="quality"?"旧版答题检查":"管理员测试"),
    node("td",{class:"model"},row.requestedModel+" → "+(row.reportedModel||"未报告")),
    node("td",{},row.status,node("div",{class:"note"},row.errorCode||"")),node("td",{},row.usage?fmt(row.usage.input_tokens)+" / "+fmt(row.usage.output_tokens):"未知"),
    node("td",{},row.durationMs===null?"—":row.durationMs+" ms"),node("td",{},button("查看",()=>showDetails("请求元数据",node("pre",{},JSON.stringify(row,null,2))))))));
  q("#usage-prev").disabled=offset===0;q("#usage-next").disabled=!lastReport.hasMore;
  q("#usage-page").textContent=lastReport.requests?String(offset+1)+"–"+String(offset+lastReport.records.length)+" / "+lastReport.requests:"暂无请求";
}
function renderAlerts(){
  const unseen=data.alerts.filter(item=>!item.acknowledged).length;q("#alert-count").textContent=unseen;
  q("#alert-list").replaceChildren(...(data.alerts.length?data.alerts.map(item=>node("article",{class:"alert-card "+(item.acknowledged?"acknowledged":"")},
    node("div",{class:"section-heading"},node("h2",{},alertNames[item.kind]||item.kind),node("span",{class:"badge"},item.acknowledged?"已确认":"待处理")),
    node("p",{},item.message),node("div",{class:"note"},accountName(item.account_id)+" · "+(item.model||"账号状态")+" · "+date(item.time)),
    node("div",{class:"actions"},button("查看依据",()=>showDetails("提醒依据",node("pre",{},JSON.stringify(item.details,null,2)))),item.details.jobId?button("打开检测报告",()=>openFingerprint(item.details.jobId)):null,!item.acknowledged?button("标记已处理",async()=>{await post("/api/alerts/"+item.id);await refresh();}):null))):[node("div",{class:"panel empty"},"暂无提醒。指纹检测的疑似差异与复测线索会在这里汇总。")]));
  q("#audit-list").replaceChildren(...data.audit.map(row=>node("div",{class:"audit-row"},node("div",{},node("code",{},row.action),node("div",{class:"note"},JSON.stringify(row.details))),node("span",{class:"note"},date(row.time)))));
}
function candidateRows(result){
  return node("div",{},node("div",{class:"fingerprint-ranking-heading"},node("h3",{},"完整归因排序"),node("span",{class:"note"},result.results.length+" 个候选 · 权重从高到低")),node("div",{class:"fingerprint-candidates fingerprint-full-ranking"},result.results.map((item,index)=>node("div",{class:"fingerprint-candidate"},
    node("div",{class:"fingerprint-candidate-heading"},node("span",{},node("small",{},String(index+1).padStart(2,"0")),node("code",{},item.model)),node("strong",{},percent(item.probability))),
    node("progress",{value:item.probability,max:1,"aria-label":item.model+" 归因权重"})))));
}
function fingerprintHistogram(counts){
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 355 80");svg.setAttribute("preserveAspectRatio","none");svg.setAttribute("class","fingerprint-chart");svg.setAttribute("role","img");svg.setAttribute("aria-label","1 到 355 的数字出现频率");
  const peak=Math.max(1,...counts);
  counts.forEach((count,index)=>{const rect=document.createElementNS(svg.namespaceURI,"rect");rect.setAttribute("x",index);rect.setAttribute("y",80-80*count/peak);rect.setAttribute("width","0.85");rect.setAttribute("height",80*count/peak);const title=document.createElementNS(svg.namespaceURI,"title");title.textContent=(index+1)+"："+count+" 次";rect.append(title);svg.append(rect);});
  return node("div",{class:"fingerprint-distribution"},svg,node("div",{class:"fingerprint-axis note"},node("span",{},"1"),node("span",{},"数字取值 → 355")));
}
async function openFingerprint(id){
  const job=await call("/api/fingerprint/"+encodeURIComponent(id));
  showDetails(job.model+" · 指纹检测报告",node("div",{class:"fingerprint-report"},
    dl([["检测账号",accountName(job.accountId)],["请求模型",job.model],["推理参数",job.config.effort],["判断",fingerprintNames[job.assessment?.outcome]||job.status],["实际请求",job.progress+" / 最多 "+job.maximumRequests],["输入 / 输出 tokens",fmt(job.usage.inputTokens)+" / "+fmt(job.usage.outputTokens)],["指纹库版本",job.bank.commit.slice(0,8)+" · "+date(job.bank.builtAt)]]),
    node("p",{class:"note"},"采用 ModelTrace 的 75% 数字分布与 25% 有序块特征评分。每组独立计算候选权重，复测组不会被拼成一个额外概率。"),
    job.rounds.map(round=>node("section",{class:"fingerprint-evidence"},node("div",{class:"section-heading"},node("h3",{},round.index===1?"基础检测":"复测 "+(round.index-1)),node("span",{class:"badge"},round.valid+" / 3 份有效输出")),
      round.result?node("div",{},node("p",{class:"note"},"家族权重："+round.result.family_probabilities.map(item=>item.display_name+" "+percent(item.probability)).join(" · ")),node("div",{class:"table-wrap"},node("table",{},node("thead",{},node("tr",{},...["候选模型","相对权重","数字分布相似度","综合得分"].map(label=>node("th",{},label)))),node("tbody",{},round.result.results.map(item=>node("tr",{},node("td",{},item.model),node("td",{},percent(item.probability)),node("td",{},percent(item.profile_similarity)),node("td",{},item.score.toFixed(3)))))))):node("p",{class:"note"},"尚无有效候选评分。"),
      round.statistics?node("div",{},node("h3",{},"数字分布特征"),dl([["有效数字 / 不同数字",round.statistics.count+" / "+round.statistics.unique],["均值",round.statistics.mean.toFixed(2)],["分布熵",round.statistics.entropyBits.toFixed(3)+" bits"],["最常出现的数字",round.statistics.favorites.map(item=>item.number+"（"+item.count+"次）").join("、")]]),fingerprintHistogram(round.statistics.counts),node("div",{class:"note"},"末位 0–9 次数："+round.statistics.lastDigits.join(" / "))):null,
      round.samples.map((sample,index)=>node("details",{class:"fingerprint-sample"},node("summary",{},"探针 "+(index+1)+" · "+(sample.accepted?"有效":"未计入")+" · "+(sample.parsedNumbers??0)+" / "+sample.expectedCount+" 个数字"),
        sample.error?node("p",{class:"note danger"},"请求错误："+sample.error):null,
        dl([["最低有效数量",sample.minimumNumbers],["返回模型标识",sample.reportedModel||"未报告"],["Response ID",sample.responseId||"—"]]),
        node("pre",{},sample.prompt),sample.numbers?.length?node("pre",{},JSON.stringify(sample.numbers)):null))))));
}
function updateFingerprintControls(){
  const requested=q("#quality-model").value;
  const selected=account(qualityAccountId);
  q("#quality-run").disabled=!requested||modelAccountId!==qualityAccountId||!selected?.enabled||!selected?.auth.sharing||fingerprintRunning.includes(qualityAccountId);
}
async function loadQuality(){
  const version=++fingerprintVersion,params=new URLSearchParams({limit:10,offset:fingerprintOffset});
  if(q("#fingerprint-history-filter").value)params.set("accountId",q("#fingerprint-history-filter").value);
  const report=await call("/api/fingerprint?"+params);if(version!==fingerprintVersion)return;
  fingerprintRunning=report.runningAccountIds;updateFingerprintControls();
  q("#quality-history").replaceChildren(...(report.history.length?report.history.map(job=>{
    const outcome=job.assessment?.outcome;
    return node("article",{class:"panel fingerprint-card","data-fingerprint-id":job.id},
      node("div",{class:"section-heading"},node("div",{},node("h2",{},job.model),node("div",{class:"note"},accountName(job.accountId)+" · "+date(job.time)+" · "+job.config.effort+" · "+(job.source==="scheduled"?"定期检测":"手动检测"))),
        node("span",{class:"badge "+(fingerprintWarn.has(outcome)?"warn":outcome==="compatible"?"good":"")},job.status==="running"?"检测中"+ (job.rounds.length>1?" · 正在复测":""):job.status==="stopped"?"已停止":fingerprintNames[outcome]||job.status)),
      job.result?node("div",{class:"fingerprint-result"},node("div",{},node("span",{class:"eyebrow"},"第 "+job.rounds.at(-1).index+" 组首位候选"),node("strong",{},job.result.prediction)),node("div",{class:"fingerprint-weight"},node("strong",{},percent(job.result.probability)),node("span",{class:"note"},"参考库内相对权重"))):node("div",{class:"empty"},"正在等待有效数字样本"),
      job.result?candidateRows(job.result):null,
      job.result?node("p",{class:"note"},"家族权重："+job.result.family_probabilities.map(item=>item.display_name+" "+percent(item.probability)).join(" · ")):null,
      job.previous?node("p",{class:"note"},"上次同条件候选："+job.previous.candidate+"（"+percent(job.previous.weight)+"） · "+date(job.previous.time)):null,
      node("div",{class:"fingerprint-rounds"},job.rounds.map(round=>node("div",{class:"fingerprint-round"},node("span",{class:"note"},round.index===1?"基础检测":"复测 "+(round.index-1)),node("code",{},round.result?.prediction||"等待评分"),node("span",{class:"note"},round.result?percent(round.result.probability)+" · "+round.valid+"/3 有效":"已执行 "+round.samples.length+"/3")))),
      node("div",{class:"note"},job.progress+" / "+job.planned+" 次请求 · 输入 / 输出 "+fmt(job.usage.inputTokens)+" / "+fmt(job.usage.outputTokens)+" tokens"+(job.failures?" · "+job.failures+" 次请求失败":"")+(job.invalidSamples?" · "+job.invalidSamples+" 份数字不足":"")+(job.usage.unknown?" · "+job.usage.unknown+" 次用量未知":"")),
      job.modelDifferences?node("p",{class:"note danger"},job.modelDifferences+" 次请求与返回模型标识不同，已单独记录提醒。"):null,
      job.status==="running"?node("progress",{class:"quality-progress",value:job.progress,max:job.planned,"aria-label":"指纹检测进度"}):null,
      node("div",{class:"actions"},button("详细报告与采样",()=>openFingerprint(job.id)),job.status==="running"?button("停止后续探针",async()=>{await post("/api/fingerprint/cancel",{accountId:job.accountId});await loadQuality();notice("已停止后续探针；当前请求可能仍会完成。");}):null));
  }):[node("div",{class:"panel empty"},"尚无指纹检测记录。选择一个账号和模型，发送三条数字探针即可查看候选判断。")]));
  q("#fingerprint-prev").disabled=fingerprintOffset===0;q("#fingerprint-next").disabled=!report.hasMore;
  q("#fingerprint-page").textContent=report.total?(fingerprintOffset+1)+"–"+(fingerprintOffset+report.history.length)+" / "+report.total:"暂无记录";
}
async function loadModels(){
  const target=qualityAccountId;
  const list=await call("/api/models?accountId="+encodeURIComponent(target));
  if(target!==qualityAccountId)return;
  const select=q("#quality-model"),previous=select.value;
  select.replaceChildren(...list.data.map(model=>node("option",{value:model.id},(model.display_name||model.id)+" · "+model.id)));
  if(list.data.some(model=>model.id===previous))select.value=previous;
  modelAccountId=qualityAccountId;
  const policy=account(qualityAccountId)?.fingerprintPolicy;
  if(policy?.model&&list.data.some(model=>model.id===policy.model))select.value=policy.model;
  if(policy?.effort)q("#quality-effort").value=policy.effort;
  if(policy?.verificationRounds!==undefined)q("#quality-rounds").value=String(policy.verificationRounds);
  updateFingerprintControls();
}
async function refresh(){
  const version=++refreshVersion;
  const result=await call("/api/status");
  if(version!==refreshVersion)return;
  data=result;
  q("#admin-identity").textContent=data.administrator?.username||"本机管理";
  q("#admin-host").textContent=location.host;
  q("#admin-logout").hidden=!data.administrator?.loginRequired;
  if(!qualityAccountId||!account(qualityAccountId)){qualityAccountId=data.accounts.find(item=>item.enabled&&item.auth.sharing)?.id||data.accounts[0]?.id;scheduleDirty=false;}
  fillSelect("#quality-account-selector",data.accounts);q("#quality-account-selector").value=qualityAccountId||"";
  fillSelect("#usage-account",[...data.accounts,...(data.deletedAccounts||[]).map(item=>({...item,name:item.name+"（已删除）"}))],"所有账号");fillSelect("#usage-agent",data.agents,"所有接入");
  fillSelect("#fingerprint-history-filter",[...data.accounts,...(data.deletedAccounts||[]).map(item=>({...item,name:item.name+"（已删除）"}))],"全部账号");
  q("#fingerprint-bank-state").textContent="ModelTrace · "+data.fingerprintLibrary.modelCount+" 个参考模型 · "+data.fingerprintLibrary.commit.slice(0,8);
  renderAccounts();renderKeys();renderAlerts();
  q("#last-updated").textContent="更新 "+date(new Date().toISOString());
  if(modelAccountId!==qualityAccountId)q("#quality-model").replaceChildren(node("option",{value:""},"读取本次检测账号的模型后选择"));
  const policy=account(qualityAccountId)?.fingerprintPolicy;
  for(const id of ["#quality-account-selector","#quality-load-models","#quality-save-policy","#quality-schedule-enabled","#legacy-quality-load"])q(id).disabled=!qualityAccountId;
  q("#quality-schedule-state").textContent=policy?.enabled?"已启用 · "+policy.intervalHours+" 小时":"关闭";
  if(!scheduleDirty){q("#quality-schedule-enabled").checked=!!policy?.enabled;q("#quality-interval").value=String(policy?.intervalHours||6);}
  await Promise.all([loadUsage(),loadQuality()]);
}
function showPage(page){
  document.querySelectorAll("[data-panel]").forEach(item=>item.hidden=item.dataset.panel!==page);
  document.querySelectorAll("[data-page]").forEach(item=>{if(item.dataset.page===page)item.setAttribute("aria-current","page");else item.removeAttribute("aria-current");});
}
document.querySelectorAll("[data-page]").forEach(item=>item.addEventListener("click",()=>showPage(item.dataset.page)));
try{const page=sessionStorage.getItem("ag_admin_recovery_page");if(["accounts","keys","usage","quality","alerts"].includes(page))showPage(page);sessionStorage.removeItem("ag_admin_recovery_page");}catch{}
q("#refresh").onclick=()=>refresh().catch(error=>notice(error.message));
q("#admin-logout").onclick=async()=>{
  const button=q("#admin-logout");button.disabled=true;
  try{await post("/api/admin/logout");clearInterval(refreshTimer);location.replace("/login?reason=logout");}
  catch(error){notice(error.message);button.disabled=false;}
};
q("#sync-quota-all").onclick=async()=>{
  q("#sync-quota-all").disabled=true;
  try{
    const result=await post("/api/quota/sync"),ok=result.results.filter(item=>item.ok).length,auth=result.results.filter(item=>!item.ok&&["quota_authorization_required","quota_identity_required","quota_login_pending"].includes(item.error?.code)).length;
    await refresh();notice("已同步 "+ok+" 个账号"+(auth?"，"+auth+" 个需要完成额度授权":"")+(result.results.length-ok-auth?"，"+(result.results.length-ok-auth)+" 个同步失败（原因见账号行）":"")+"。");
  }catch(error){notice(error.message);}finally{q("#sync-quota-all").disabled=false;}
};
q("#quality-account-selector").onchange=()=>{
  qualityAccountId=q("#quality-account-selector").value;modelAccountId=null;scheduleDirty=false;
  const policy=account(qualityAccountId)?.fingerprintPolicy;
  q("#quality-effort").value=policy?.effort||"default";q("#quality-rounds").value=String(policy?.verificationRounds??1);
  q("#legacy-quality-history").replaceChildren();refresh().catch(error=>notice(error.message));
};
q("#add-account").onclick=()=>editor("添加独立 Pro 账号",[field("账号备注名称","name","text","",{required:"",placeholder:"例如：个人 Pro / 开发 Pro A",maxlength:100})],async values=>{await post("/api/accounts",{name:values.name});notice("账号已添加。请在对应行中完成授权，授权后会自动参与统一轮询。");});
q("#add-key").onclick=()=>editKey();
q("#copy-default").onclick=async()=>{try{connection=await call("/api/connection");keyConfig(connection.apiKey);}catch(error){notice(error.message);}};
q("#quality-load-models").onclick=async()=>{q("#quality-load-models").disabled=true;try{await loadModels();notice("");}catch(error){notice(error.message);}finally{q("#quality-load-models").disabled=false;}};
q("#apply-usage").onclick=()=>{offset=0;loadUsage().catch(error=>notice(error.message));};
q("#reset-usage").onclick=()=>{q("#usage-period").value="all";for(const id of ["#usage-account","#usage-agent","#usage-model"])q(id).value="";offset=0;loadUsage().catch(error=>notice(error.message));};
q("#usage-prev").onclick=()=>{offset=Math.max(0,offset-30);loadUsage().catch(error=>notice(error.message));};
q("#usage-next").onclick=()=>{offset+=30;loadUsage().catch(error=>notice(error.message));};
q("#quality-run").onclick=async()=>{
  if(modelAccountId!==qualityAccountId||!q("#quality-model").value)return notice("请先读取所选账号的模型列表。");
  q("#quality-run").disabled=true;
  try{await post("/api/fingerprint/run",{accountId:qualityAccountId,model:q("#quality-model").value,effort:q("#quality-effort").value,verificationRounds:Number(q("#quality-rounds").value)});fingerprintOffset=0;q("#fingerprint-history-filter").value="";await loadQuality();notice("指纹检测已开始，完成后直接展示全部候选的归因排序。");}
  catch(error){notice(error.message);}finally{updateFingerprintControls();}
};
q("#quality-save-policy").onclick=async()=>{
  if(q("#quality-schedule-enabled").checked&&modelAccountId!==qualityAccountId)return notice("请先读取所选账号的模型列表。");
  try{await post("/api/fingerprint/policy",{accountId:qualityAccountId,enabled:q("#quality-schedule-enabled").checked,model:q("#quality-model").value,effort:q("#quality-effort").value,verificationRounds:Number(q("#quality-rounds").value),intervalHours:Number(q("#quality-interval").value)});scheduleDirty=false;await refresh();notice("定期指纹检测设置已保存。");}
  catch(error){notice(error.message);}
};
q("#quality-model").onchange=updateFingerprintControls;
q("#fingerprint-history-filter").onchange=()=>{fingerprintOffset=0;loadQuality().catch(error=>notice(error.message));};
q("#fingerprint-prev").onclick=()=>{fingerprintOffset=Math.max(0,fingerprintOffset-10);loadQuality().catch(error=>notice(error.message));};
q("#fingerprint-next").onclick=()=>{fingerprintOffset+=10;loadQuality().catch(error=>notice(error.message));};
q("#legacy-quality-load").onclick=async()=>{
  try{const target=qualityAccountId,{history}=await call("/api/quality?accountId="+encodeURIComponent(target));if(target!==qualityAccountId)return;
    const items=history.length?history.map(job=>node("div",{class:"fingerprint-round"},
      node("strong",{},job.model),
      node("span",{class:"note"},date(job.time)+" · "+job.correct+" / "+job.total+" · "+(job.baseline?"旧基线":comparisonNames[job.comparison]||job.status)),
      button("查看旧结果",()=>showDetails("旧版答题记录",node("pre",{},JSON.stringify(job.results,null,2))))
    )):[node("p",{class:"note"},"所选账号没有旧版答题记录。")];
    q("#legacy-quality-history").replaceChildren(...items);
  }catch(error){notice(error.message);}
};
for(const id of ["#quality-schedule-enabled","#quality-interval"])q(id).addEventListener("change",()=>{scheduleDirty=true;});
for(const id of ["#editor-close","#editor-cancel"])q(id).onclick=()=>q("#editor-dialog").close();
q("#detail-close").onclick=()=>q("#detail-dialog").close();
try{await refresh();}catch(error){notice(error.message);}
if(!adminRecoveryPending)refreshTimer=setInterval(()=>{if(!q("#editor-dialog").open)refresh().catch(error=>notice(error.message));},15000);
