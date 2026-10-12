import {EventEmitter} from "node:events";
import {createHash, randomUUID} from "node:crypto";
import {PublicError} from "./oauth.mjs";
import {forwardResponses} from "./responses.mjs";

let recurrence = 19;
for (let i=0;i<11;i++) recurrence = (3*recurrence+7)%97;
export const QUALITY_TASKS = [
  {id:"arithmetic", name:"多步计算", prompt:"计算 (137*29-47*13) 除以 97 的非负余数。只输出整数。", expected:64},
  {id:"ordering", name:"约束排序", prompt:"将 A、B、C、D、E 各用一次排成一行：A 在 B 前，D 紧接 B 后，C 紧接 D 后，E 在 C 后。只输出五个大写字母，无空格。", expected:"ABDCE"},
  {id:"recurrence", name:"迭代推理", prompt:"x 初始为 19，每一步更新 x=(3*x+7) mod 97。执行 11 步后 x 是多少？只输出整数。", expected:recurrence},
  {id:"reference", name:"代码语义", prompt:'Python 执行 a=[1,2,3]; b=a; a=a+[4]; b.append(5)。只输出 JSON 对象，键 a 和 b 分别对应最终列表。', expected:{a:[1,2,3,4],b:[1,2,3,5]}},
  {id:"extraction", name:"结构化抽取", prompt:'记录：甲 paid=17，乙 refunded=9，丙 paid=28，丁 pending=100，戊 paid=5。只对 paid 求和。仅输出 JSON {"count":数量,"sum":金额总和}。', expected:{count:3,sum:50}},
  {id:"instructions", name:"指令遵循", prompt:'将 [9,2,9,4,2,7] 去重并升序排列。只输出 JSON 数组，不要解释。', expected:[2,4,7,9]},
];
const VERSION = "micro-regression-v1";
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value==="object") return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])]));
  return value;
};
export function grade(task, text) {
  const clean = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/,"").replace(/\s*\x60\x60\x60$/,"");
  let actual;try{actual=JSON.parse(clean);}catch{actual=clean;}
  return JSON.stringify(normalize(actual))===JSON.stringify(normalize(task.expected));
}
export function wilson(correct,total) {
  if (!total) return [0,1];
  const z=1.96,p=correct/total,denom=1+z*z/total;
  const center=(p+z*z/(2*total))/denom;
  const width=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/denom;
  return [Math.max(0,center-width),Math.min(1,center+width)];
}
export function compareQuality(current, baseline, previous) {
  if (current.failures || current.modelDifferences) return "execution_issue";
  if (!baseline || current.total<18 || baseline.total<18) return "baseline_needed";
  const candidate = baseline.score-current.score>=0.15 && wilson(current.correct,current.total)[1]<wilson(baseline.correct,baseline.total)[0];
  if (!candidate) return "stable";
  return previous?.comparison==="repeat_needed" || previous?.comparison==="quality_regression" ? "quality_regression" : "repeat_needed";
}
export async function collectedResponse(body, options) {
  const res = new EventEmitter();
  res.destroyed=false;res.writableEnded=false;res.headersSent=false;res.statusCode=200;
  res.writeHead=(code)=>{res.statusCode=code;res.headersSent=true;};
  res.write=()=>true;
  let payload="";
  res.end=data=>{payload+=data??"";res.writableEnded=true;};
  await forwardResponses({...body,stream:false}, {...options,res});
  const result = JSON.parse(payload || "{}");
  if (res.statusCode!==200 || result.status!=="completed") {const error=new PublicError(res.statusCode===200?502:res.statusCode,result.error?.code||"response_failed",result.error?.message||"请求没有完成。");error.beforeUpstream=!!res.gatewayBeforeUpstream;throw error;}
  return result;
}

export class Quality {
  constructor(store, getOAuth, fetchImpl) {
    this.store=store;this.getOAuth=getOAuth;this.fetch=fetchImpl;this.running=new Map();
    for(const row of store.db.prepare("SELECT payload FROM quality").all()){
      const job=JSON.parse(row.payload);
      if(job.status==="running"){job.status="interrupted";job.comparison="execution_issue";this.save(job);}
    }
  }
  history(accountId) {
    return this.store.db.prepare("SELECT payload,baseline FROM quality WHERE account_id=? ORDER BY time DESC LIMIT 20").all(accountId).map(row=>({...JSON.parse(row.payload),baseline:!!row.baseline}));
  }
  start(accountId, fields, source="manual") {
    const account=this.store.assertAccountAvailable(accountId);
    if (!account.enabled) throw new PublicError(403,"account_disabled","账号已停用。");
    if (this.running.has(accountId)) throw new PublicError(409,"quality_running","该账号已有质量检查进行中。");
    if (typeof fields.model!=="string" || !fields.model.trim() || fields.model.length>200) throw new PublicError(400,"model_required","请选择检测模型。");
    const rounds=Number(fields.rounds??3);
    if (![1,3].includes(rounds)) throw new PublicError(400,"invalid_rounds","检测支持 1 或 3 轮。");
    const effort=fields.effort??"default";
    if (!["default","low","medium","high"].includes(effort)) throw new PublicError(400,"invalid_effort","推理参数无效。");
    const config={version:VERSION,model:fields.model.trim(),rounds,effort};
    const hash=createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const job={id:randomUUID(),time:new Date().toISOString(),accountId,model:config.model,configHash:hash,config,source,status:"running",progress:0,planned:QUALITY_TASKS.length*rounds,correct:0,total:0,failures:0,modelDifferences:0,score:null,results:[]};
    this.running.set(accountId,job);
    this.save(job);
    this.store.audit("quality_started",{accountId,model:config.model,rounds,source});
    this.execute(job).catch(()=>{job.status="failed";this.save(job);}).finally(()=>this.running.delete(accountId));
    return this.publicJob(job);
  }
  save(job) {
    this.store.db.prepare("INSERT INTO quality VALUES (?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET score=excluded.score,correct=excluded.correct,total=excluded.total,failures=excluded.failures,payload=excluded.payload").run(job.id,job.time,job.accountId,job.model,job.configHash,job.score,job.correct,job.total,job.failures,JSON.stringify(job));
  }
  publicJob(job) {return {...job,results:job.results.map(({answer,...row})=>row)};}
  async execute(job) {
    for (let round=0;round<job.config.rounds;round++) for (const task of QUALITY_TASKS) {
      if(job.stopRequested||!this.store.getAccount(job.accountId).enabled){
        job.status="stopped";job.comparison="execution_issue";this.save(job);return;
      }
      let result={taskId:task.id,name:task.name,round:round+1,passed:false};
      try {
        const response=await collectedResponse({
          model:job.model,input:[{role:"user",content:task.prompt}],store:false,
          ...(job.config.effort==="default"?{}:{reasoning:{effort:job.config.effort}}),
        },{
          oauth:this.getOAuth(job.accountId),store:this.store,fetchImpl:this.fetch,
          context:{accountId:job.accountId,agentId:null,source:"quality"},
        });
        const answer=(response.output||[]).flatMap(item=>item.content||[]).filter(part=>part.type==="output_text").map(part=>part.text).join("");
        result={...result,answer,passed:grade(task,answer),reportedModel:response.model};
        if (response.model!==job.model) job.modelDifferences++;
        job.total++;if(result.passed)job.correct++;
      } catch(error) {
        job.failures++;result.error=error instanceof PublicError?error.code:"execution_error";
        // Authentication/quota failure needs action; do not consume more calls.
        if ((error.status>=400&&error.status<500)||job.failures>=3) {
          job.results.push(result);job.progress++;job.status="completed";job.score=job.total?job.correct/job.total:null;job.comparison="execution_issue";this.save(job);return;
        }
      }
      job.results.push(result);job.progress++;
      job.score=job.total?job.correct/job.total:null;this.save(job);
    }
    job.status="completed";
    const baselineRow=this.store.db.prepare("SELECT payload FROM quality WHERE account_id=? AND config_hash=? AND baseline=1 ORDER BY time DESC LIMIT 1").get(job.accountId,job.configHash);
    const baseline=baselineRow?JSON.parse(baselineRow.payload):null;
    const prior=this.store.db.prepare("SELECT payload FROM quality WHERE account_id=? AND config_hash=? AND id!=? AND baseline=0 ORDER BY time DESC LIMIT 1").get(job.accountId,job.configHash,job.id);
    const previous=prior?JSON.parse(prior.payload):null;
    job.comparison=compareQuality(job,baseline,previous?.baselineId===baseline?.id?previous:null);
    job.baselineId=baseline?.id??null;
    this.save(job);
    if(job.comparison==="quality_regression")this.store.alert("quality_regression",job.accountId,null,job.model,"连续两次同条件检查明显低于基线，建议核查模型、参数和服务状态；不能证明后台换模。",{runId:job.id,baselineId:baseline.id,score:job.score,baselineScore:baseline.score});
  }
  setBaseline(id) {
    const row=this.store.db.prepare("SELECT payload FROM quality WHERE id=?").get(id);
    if(!row)throw new PublicError(404,"quality_not_found","检测记录不存在。");
    const job=JSON.parse(row.payload);
    if(job.status!=="completed"||job.failures||job.modelDifferences||job.total<18)throw new PublicError(400,"invalid_baseline","基线需要完成 3 轮、至少 18 次有效请求，且没有执行错误或模型标识差异。");
    this.store.db.exec("BEGIN");
    try {
      this.store.db.prepare("UPDATE quality SET baseline=0 WHERE account_id=? AND config_hash=?").run(job.accountId,job.configHash);
      this.store.db.prepare("UPDATE quality SET baseline=1 WHERE id=?").run(id);
      this.store.db.exec("COMMIT");
    } catch(error){this.store.db.exec("ROLLBACK");throw error;}
    this.store.audit("quality_baseline_set",{runId:id,accountId:job.accountId});
  }
  cancel(accountId) {
    const job=this.running.get(accountId);
    if(!job)return {stopping:false};
    job.stopRequested=true;this.save(job);
    this.store.audit("quality_stop_requested",{accountId,runId:job.id});
    return {stopping:true};
  }
  async policy(accountId,fields) {
    this.store.assertAccountAvailable(accountId);
    const hours=Number(fields.intervalHours??6);
    if(![6,12,24].includes(hours))throw new PublicError(400,"invalid_interval","定期检查间隔支持 6、12 或 24 小时。");
    if(typeof fields.enabled!=="boolean" || (fields.enabled && (!fields.model || !["default","low","medium","high"].includes(fields.effort??"default"))))throw new PublicError(400,"invalid_policy","请选择模型和有效的检查配置。");
    return this.store.manage(next=>{
      this.store.assertAccountAvailable(accountId);
      next.accounts.find(account=>account.id===accountId).qualityPolicy={enabled:fields.enabled,model:String(fields.model??"").slice(0,200),effort:fields.effort??"default",rounds:3,intervalHours:hours,lastStartedAt:new Date().toISOString()};
    },"quality_policy_changed",{accountId,enabled:fields.enabled,intervalHours:hours});
  }
  async tick() {
    for(const account of this.store.management.accounts){
      const policy=account.qualityPolicy;
      if(!account.enabled||!policy?.enabled||this.running.has(account.id)||this.store.removingAccounts.has(account.id))continue;
      if(Date.now()-Date.parse(policy.lastStartedAt)<policy.intervalHours*3600000)continue;
      if(!this.getOAuth(account.id).status().sharing)continue;
      const current=await this.store.manage(next=>{
        const item=next.accounts.find(entry=>entry.id===account.id);
        if(!item?.enabled||!item.qualityPolicy?.enabled||this.store.removingAccounts.has(account.id))return null;
        item.qualityPolicy.lastStartedAt=new Date().toISOString();
        return {...item.qualityPolicy};
      },"scheduled_quality_checked",{accountId:account.id});
      if(current)this.start(account.id,current,"scheduled");
    }
  }
}
