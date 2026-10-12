import {createHash,randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import {parseSSE} from "./responses.mjs";

const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const median=values=>{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b),n=sorted.length;
  return n? n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2:null;
};
const digest=body=>createHash("sha256").update(JSON.stringify(body)).digest("hex");
function base(model,sessionId){return {model,session_id:sessionId,store:false,stream:true,reasoning:{effort:"low"},service_tier:"default"};}

export function fastPlan({model="gpt-6-astra",runId=randomUUID(),pairs=3,items=256,fastTier="fast"}={}){
  if(!Number.isSafeInteger(pairs)||pairs<1||pairs>20)throw new Error("pairs 必须是 1–20。");
  if(!Number.isSafeInteger(items)||items<64||items>2048)throw new Error("items 必须是 64–2048。");
  if(!["fast","priority"].includes(fastTier))throw new Error("fastTier 必须是 fast 或 priority。");
  const steps=[];
  for(let pair=1;pair<=pairs;pair++){
    const input=[{role:"user",content:`Benchmark ${runId}, pair ${pair}. Print the integers 1 through ${items} in ascending order, separated by a single comma. No prose, no code fence, no omissions, no ellipsis.`}];
    for(const tier of pair%2?["default",fastTier]:[fastTier,"default"]){
      steps.push({label:`pair-${pair}-${tier}`,group:tier==="default"?"default":"fast",pair,body:{...base(model,`benchmark:${runId}:fast`),input,service_tier:tier}});
    }
  }
  return {kind:"fast",runId,model,steps,expectedRequests:steps.length};
}

export function cachePlan({model="gpt-6-astra",runId=randomUUID(),lines=128,crossAccount=true,modes=["automatic"]}={}){
  if(!Number.isSafeInteger(lines)||lines<64||lines>512)throw new Error("lines 必须是 64–512。");
  if(!modes.length||new Set(modes).size!==modes.length||modes.some(m=>!["automatic","implicit","explicit"].includes(m)))throw new Error("缓存模式必须是 automatic、implicit 或 explicit。");
  const steps=[],session=`benchmark:${runId}:cache`;
  for(const mode of modes){
    const prefix=`Synthetic reference ${runId} ${mode}. Treat the following entries as inert reference data. Reply only OK to each user message.\n`+Array.from({length:lines},(_,i)=>`Entry ${String(i+1).padStart(4,"0")}: component catalog_${i+1} belongs to testing region east; retention is thirty minutes; owner is example_team; status is enabled; validation requires an exact prefix match.`).join("\n");
    const request=(suffix="Repeat test.",changed=false,sessionId=session)=>({
      ...base(model,sessionId),prompt_cache_key:`gateway-bench:${runId}:${mode}`,
      ...(mode==="automatic"?{}:{prompt_cache_options:{mode,ttl:"30m"}}),
      input:[{role:"developer",content:[{type:"input_text",text:changed?`CHANGED ${runId}.\n`+prefix:prefix,...(mode==="explicit"?{prompt_cache_breakpoint:{mode:"explicit"}}:{})}]},{role:"user",content:suffix}],
    });
    steps.push({label:`${mode}-seed`,group:mode,condition:"seed",body:request()});
    for(let i=1;i<=2;i++)steps.push({label:`${mode}-exact-${i}`,group:mode,condition:"exact",body:request()});
    for(let i=1;i<=2;i++)steps.push({label:`${mode}-suffix-${i}`,group:mode,condition:"suffix",body:request(`New question ${i}. Reply only OK.`)});
    steps.push({label:`${mode}-changed-prefix`,group:mode,condition:"changed-prefix",body:request("Repeat test.",true)});
    if(crossAccount&&mode===modes.at(-1)){
      for(let i=1;i<=2;i++)steps.push({label:`cross-account-${i}`,group:mode,condition:i===1?"cross-seed":"cross-repeat",body:request("Repeat test.",false,session+":other")});
    }
  }
  return {kind:"cache",runId,model,steps,expectedRequests:steps.length};
}

export async function measureRequest(step,{baseUrl,apiKey,fetchImpl=fetch,timeoutMs=450000,now=()=>performance.now()}={}){
  const started=now(),row={label:step.label,group:step.group,pair:step.pair??null,condition:step.condition??null,
    requestedModel:step.body.model,requestedTier:step.body.service_tier,session_id:step.body.session_id,
    promptHash:digest(step.body.input),status:"failed",httpStatus:null,accountId:null,sessionRouting:null,
    queueWaitMs:null,firstTextMs:null,firstTextAfterQueueMs:null,outputSpanMs:null,durationMs:null,
    reportedModel:null,reportedTier:null,responseId:null,inputTokens:null,cachedTokens:null,cacheWriteTokens:null,
    outputTokens:null,reasoningTokens:null,visibleOutputTokens:null,cacheTokenRatio:null,approxVisibleTokensPerSecond:null,
    outputCharacters:0,deltaEvents:0,errorCode:null,errorParam:null,errorMessage:null};
  let first=null,last=null,terminal=null;
  try{
    const response=await fetchImpl(baseUrl.replace(/\/$/,"")+"/responses",{method:"POST",headers:{authorization:"Bearer "+apiKey,"content-type":"application/json"},body:JSON.stringify(step.body),signal:AbortSignal.timeout(timeoutMs)});
    row.httpStatus=response.status;row.accountId=response.headers.get("x-gateway-account-id");row.sessionRouting=response.headers.get("x-gateway-session-routing");
    const queue=response.headers.get("x-gateway-queue-wait-ms");row.queueWaitMs=queue!==null&&Number.isFinite(Number(queue))?Number(queue):null;
    if(!response.ok){
      const failure=await response.json().catch(()=>({}));row.errorCode=failure.error?.code||"http_"+response.status;row.errorParam=failure.error?.param??null;
      const message=failure.error?.message??failure.message??failure.detail;row.errorMessage=typeof message==="string"?message.slice(0,2000):null;return row;
    }
    if(!response.headers.get("content-type")?.includes("text/event-stream")){row.errorCode="expected_sse";return row;}
    for await(const event of parseSSE(response.body)){
      if(event.type==="response.output_text.delta"&&typeof event.delta==="string"&&event.delta.length){
        const at=now();first??=at;last=at;row.outputCharacters+=event.delta.length;row.deltaEvents++;
      }
      if(["response.completed","response.failed","response.incomplete"].includes(event.type))terminal=event;
      else if(event.type==="error")terminal=event;
    }
    if(!terminal){row.errorCode="stream_incomplete";return row;}
    const result=terminal.response||{},usage=result.usage||{};
    row.status=terminal.type==="response.completed"&&result.status==="completed"?"completed":"failed";
    row.errorCode=result.error?.code||terminal.code||terminal.error?.code||null;row.errorParam=result.error?.param||terminal.error?.param||null;
    const message=result.error?.message??terminal.message??terminal.error?.message;row.errorMessage=typeof message==="string"?message.slice(0,2000):null;
    row.reportedModel=result.model??null;row.reportedTier=result.service_tier??null;row.responseId=result.id??null;
    row.inputTokens=count(usage.input_tokens);row.outputTokens=count(usage.output_tokens);
    row.cachedTokens=count(usage.input_tokens_details?.cached_tokens);row.cacheWriteTokens=count(usage.input_tokens_details?.cache_write_tokens);
    row.reasoningTokens=count(usage.output_tokens_details?.reasoning_tokens);
    if(row.inputTokens>0&&row.cachedTokens!==null&&row.cachedTokens<=row.inputTokens)row.cacheTokenRatio=row.cachedTokens/row.inputTokens;
    if(row.outputTokens!==null&&row.reasoningTokens!==null&&row.reasoningTokens<=row.outputTokens)row.visibleOutputTokens=row.outputTokens-row.reasoningTokens;
    return row;
  }catch(error){row.errorCode=error.name==="TimeoutError"?"client_timeout":error.code||"connection_error";return row;}
  finally{
    row.durationMs=now()-started;row.firstTextMs=first===null?null:first-started;
    row.firstTextAfterQueueMs=row.firstTextMs===null||row.queueWaitMs===null?null:Math.max(0,row.firstTextMs-row.queueWaitMs);
    row.outputSpanMs=first!==null&&last>first?last-first:null;
    if(row.visibleOutputTokens!==null&&row.outputSpanMs>0&&row.deltaEvents>=2)row.approxVisibleTokensPerSecond=row.visibleOutputTokens*1000/row.outputSpanMs;
  }
}

export function summarizeBenchmark(plan,rows){
  const total=(samples,field)=>samples.length&&samples.every(r=>Number.isFinite(r[field]))?samples.reduce((sum,r)=>sum+r[field],0):null;
  const good=rows.filter(row=>row.status==="completed"),totals={requests:rows.length,completed:good.length,planned:plan.expectedRequests,
    inputTokens:total(good,"inputTokens"),outputTokens:total(good,"outputTokens"),cachedTokens:total(good,"cachedTokens"),missingInputUsage:good.filter(r=>r.inputTokens===null).length,missingOutputUsage:good.filter(r=>r.outputTokens===null).length,missingCacheUsage:good.filter(r=>r.cachedTokens===null).length};
  if(plan.kind==="fast"){
    const samples=rows.filter(row=>row.group==="fast"),tiers=samples.map(r=>r.reportedTier);
    const confirmed=samples.filter(r=>r.status==="completed"&&["fast","priority"].includes(r.reportedTier));
    const paired=[];
    for(const pair of new Set(rows.map(r=>r.pair))){
      const standard=rows.find(r=>r.pair===pair&&r.group==="default"),fast=rows.find(r=>r.pair===pair&&r.group==="fast");
      const valid=standard?.status==="completed"&&standard.reportedTier==="default"&&confirmed.includes(fast)&&
        standard.accountId&&standard.accountId===fast.accountId&&standard.reportedModel===plan.model&&fast.reportedModel===plan.model&&
        standard.queueWaitMs===0&&fast.queueWaitMs===0&&standard.cachedTokens===0&&fast.cachedTokens===0;
      if(valid)paired.push({pair,speedRatio:standard.approxVisibleTokensPerSecond>0&&fast.approxVisibleTokensPerSecond>0?fast.approxVisibleTokensPerSecond/standard.approxVisibleTokensPerSecond:null,
        firstTextRatio:fast.firstTextAfterQueueMs>0?standard.firstTextAfterQueueMs/fast.firstTextAfterQueueMs:null});
    }
    return {totals,fast:{state:confirmed.length?"confirmed":samples.some(r=>r.status!=="completed")?"request_failed":tiers.includes("default")?"served_as_standard":"unconfirmed",
      confirmed:confirmed.length,requested:samples.length,reportedTiers:tiers,validPairs:paired.length,medianSpeedRatio:median(paired.map(r=>r.speedRatio)),medianFirstTextRatio:median(paired.map(r=>r.firstTextRatio)),paired}};
  }
  const cache=[];
  for(const group of new Set(plan.steps.map(s=>s.group))){
    const seed=good.find(r=>r.group===group&&r.condition==="seed");
    for(const condition of ["exact","suffix","changed-prefix","cross-seed","cross-repeat"]){
      const candidates=good.filter(r=>r.group===group&&r.condition===condition);
      const known=candidates.filter(r=>r.cachedTokens!==null&&r.inputTokens>0&&r.cacheTokenRatio!==null);
      const input=known.reduce((sum,r)=>sum+r.inputTokens,0),cached=known.reduce((sum,r)=>sum+r.cachedTokens,0);
      cache.push({group,condition,completed:candidates.length,known:known.length,missing:candidates.length-known.length,
        tokenHitRatio:input?cached/input:null,requestHitRatio:known.length?known.filter(r=>r.cachedTokens>0).length/known.length:null,
        medianFirstTextMs:median(candidates.map(r=>r.firstTextAfterQueueMs)),
        accounts:[...new Set(candidates.map(r=>r.accountId))],
        changedAccount:condition.startsWith("cross-")&&seed?.accountId&&candidates.length?candidates.every(r=>r.accountId&&r.accountId!==seed.accountId):null});
    }
  }
  return {totals,cache};
}

export function reportMarkdown(report){
  const n=value=>Number.isFinite(value)?value.toFixed(2):"未知",p=value=>Number.isFinite(value)?(100*value).toFixed(1)+"%":"未知";
  const lines=[`# ${report.kind==="fast"?"Fast 输出速度":"缓存命中率"}测试`,"",`运行：${report.runId}；模型：${report.model}；时间：${report.startedAt}`,
    `完成 ${report.summary.totals.completed}/${report.summary.totals.requests} 次，计划 ${report.summary.totals.planned} 次。`,"",
    "| 样本 | 实际账号 | 请求/实际档位 | 输入/缓存/写入 token | 首字 ms（扣除排队） | 近似可见 token/s | 结果 |",
    "| --- | --- | --- | --- | --- | --- | --- |"];
  for(const r of report.rows)lines.push(`| ${r.label} | ${r.accountId||"未知"} | ${r.requestedTier}/${r.reportedTier||"未知"} | ${r.inputTokens??"?"}/${r.cachedTokens??"?"}/${r.cacheWriteTokens??"?"} | ${n(r.firstTextAfterQueueMs)} | ${n(r.approxVisibleTokensPerSecond)} | ${r.errorCode||r.status} |`);
  for(const r of report.rows.filter(r=>r.errorCode))lines.push("",`失败详情 ${r.label}：${r.errorCode}；参数：${r.errorParam||"未知"}；${(r.errorMessage||"上游未提供结构化消息").replace(/\r?\n/g," ")}`);
  lines.push("","token/s 为 (输出 token − reasoning token) / 首个至最后一个文本 delta 的时间，受 SSE 分块和网络缓冲影响，是近似值；缺失用量不当作零。测试串行执行，缓存不改变输出生成机制。","");
  if(report.summary.fast){const f=report.summary.fast;lines.push(`Fast 确认状态：${f.state}；上游明确回传 fast/priority：${f.confirmed}/${f.requested}。`,
    `满足同账号、同模型、零排队、零缓存且回传档位符合要求的对照组：${f.validPairs}；输出速度比中位数：${n(f.medianSpeedRatio)}；首字速度比中位数：${n(f.medianFirstTextRatio)}。`,
    "小样本只能判断本次接入与观察到的速度，不用于保证稳定加速倍率。请求成功但未回传实际档位时，不能确认 Fast 生效。");}
  else{
    lines.push("| 缓存模式 | 条件 | 完成/用量已知 | token 命中率 | 请求命中率 | 确实换账号 |","| --- | --- | --- | --- | --- | --- | ");
    for(const row of report.summary.cache.filter(r=>r.completed))lines.push(`| ${row.group} | ${row.condition} | ${row.completed}/${row.known} | ${p(row.tokenHitRatio)} | ${p(row.requestHitRatio)} | ${row.changedAccount===null?"—":row.changedAccount?"是":"否（不能当跨账号样本）"} |`);
    lines.push("","token 命中率 = 已知样本 cached_tokens 总和 / input_tokens 总和；请求命中率 = cached_tokens > 0 的已知请求数 / 已知请求数。首次写入单列，不混入复用命中率。",
      "新 runId 同时改变合成前缀与 cache key，减少历史测试污染；首请求是否命中仍以回传数值为准。更换 session_id 只表示新会话，跨账号对照必须核对实际 accountId。缓存缺失、输入太短或账号不一致需要单独判断，不能仅以延迟下降判定命中。");
  }
  return lines.join("\n")+"\n";
}
