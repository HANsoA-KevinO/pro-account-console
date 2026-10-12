import {readFile} from "node:fs/promises";
import {createHash,randomUUID} from "node:crypto";
import {analyzeGlobalOutputs,parseNumbers} from "../vendor/modeltrace/fingerprint-core.mjs";
import {generateChallenges} from "../vendor/modeltrace/challenge-browser.mjs";
import {PublicError} from "./oauth.mjs";
import {collectedResponse} from "./quality.mjs";

const digest=value=>createHash("sha256").update(value).digest("hex");
export const THRESHOLDS={compatible:0.5,candidate:0.8,expected:0.15,gap:0.65};
const EFFORTS=["default","low","medium","high"];
function config(fields,library){
  const model=typeof fields.model==="string"?fields.model.trim():"";
  if(!model||model.length>200)throw new PublicError(400,"model_required","请选择检测模型。");
  // Attribution scores the whole bank. The requested model is only used for automatic difference alerts.
  const expected=model;
  const effort=fields.effort??"default",verificationRounds=Number(fields.verificationRounds??1);
  if(!EFFORTS.includes(effort))throw new PublicError(400,"invalid_effort","推理参数支持 default、low、medium、high。");
  if(!Number.isInteger(verificationRounds)||verificationRounds<0||verificationRounds>3)throw new PublicError(400,"invalid_verification","异常复测支持 0–3 组。");
  return {method:"modeltrace-number-fingerprint-v1",model,expected,effort,verificationRounds,bankSha256:library.info.bankSha256};
}
export async function loadFingerprintLibrary(){
  const [bankBytes,scorer,provenanceText]=await Promise.all([
    readFile(new URL("../vendor/modeltrace/unified_bank.json",import.meta.url)),
    readFile(new URL("../vendor/modeltrace/fingerprint-core.mjs",import.meta.url)),
    readFile(new URL("../vendor/modeltrace/provenance.json",import.meta.url),"utf8"),
  ]);
  const provenance=JSON.parse(provenanceText);
  if(digest(bankBytes)!==provenance.bankSha256||digest(scorer)!==provenance.scorerSha256)throw new Error("ModelTrace assets do not match pinned checksums");
  const bank=JSON.parse(bankBytes);
  return {bank,info:{...provenance,models:bank.models.map(({id,family,response_count})=>({id,family,samples:response_count})),thresholds:THRESHOLDS}};
}
export function summarizeNumbers(numbers){
  const counts=Array(355).fill(0),lastDigits=Array(10).fill(0);
  for(const value of numbers){counts[value-1]++;lastDigits[value%10]++;}
  const total=numbers.length;
  const entropyBits=-counts.reduce((sum,count)=>sum+(count&&total?count/total*Math.log2(count/total):0),0);
  return {count:total,unique:counts.filter(Boolean).length,mean:total?numbers.reduce((sum,value)=>sum+value,0)/total:null,entropyBits,counts,lastDigits,
    favorites:counts.map((count,index)=>({number:index+1,count})).filter(item=>item.count).sort((a,b)=>b.count-a.count||a.number-b.number).slice(0,10)};
}
export function assessFingerprint(result,expected,previous){
  const top=result.results[0],reference=result.results.find(item=>item.model===expected);
  const referenceRank=reference?result.results.indexOf(reference)+1:null;
  const complete=result.used_outputs===3;
  let outcome="inconclusive";
  if(!complete)outcome="partial_evidence";
  else if(!reference)outcome="unlisted_model";
  else if(top.model===expected&&top.probability>=THRESHOLDS.compatible)outcome="compatible";
  else if(top.model!==expected&&top.probability>=THRESHOLDS.candidate&&reference.probability<=THRESHOLDS.expected&&top.probability-reference.probability>=THRESHOLDS.gap)outcome="suspected_difference";
  else if(top.model!==expected)outcome="weak_difference";
  const drift=complete&&!!previous&&top.model!==previous.candidate&&top.probability>=THRESHOLDS.candidate&&previous.weight>=THRESHOLDS.compatible;
  return {outcome,referenceKnown:!!reference,referenceRank,referenceWeight:reference?.probability??null,candidate:top.model,candidateWeight:top.probability,
    gap:reference?top.probability-reference.probability:null,drift,previous:previous?{jobId:previous.jobId,time:previous.time,candidate:previous.candidate,weight:previous.weight}:null,
    needsVerification:complete&&(outcome==="suspected_difference"||drift||!reference&&top.probability>=THRESHOLDS.candidate)};
}

export class Fingerprints {
  constructor(store,getOAuth,fetchImpl,library,admissions=null){
    this.store=store;this.getOAuth=getOAuth;this.fetch=fetchImpl;this.library=library;this.admissions=admissions;this.running=new Map();this.tasks=new Map();this.waitControllers=new Map();
    for(const row of store.db.prepare("SELECT payload FROM fingerprints WHERE status='running'").all()){
      const job=JSON.parse(row.payload);job.status="interrupted";job.finishedAt=new Date().toISOString();job.assessment={...job.assessment,outcome:"execution_issue"};this.save(job);
    }
  }
  save(job){
    this.store.db.prepare("INSERT INTO fingerprints VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload").run(job.id,job.time,job.accountId,job.model,job.configHash,job.status,JSON.stringify(job));
  }
  get(id){
    const row=this.store.db.prepare("SELECT payload FROM fingerprints WHERE id=?").get(id);
    if(!row)throw new PublicError(404,"fingerprint_not_found","指纹检测记录不存在。");
    return JSON.parse(row.payload);
  }
  history(filters={}){
    const values=[],where=filters.accountId?" WHERE account_id=?":"";
    if(filters.accountId)values.push(filters.accountId);
    const limit=Math.max(1,Math.min(50,Math.floor(Number(filters.limit)||10))),offset=Math.max(0,Math.floor(Number(filters.offset)||0));
    const total=this.store.db.prepare("SELECT COUNT(*) AS total FROM fingerprints"+where).get(...values).total;
    const rows=this.store.db.prepare("SELECT payload FROM fingerprints"+where+" ORDER BY time DESC,id DESC LIMIT ? OFFSET ?").all(...values,limit,offset);
    return {history:rows.map(row=>{const job=JSON.parse(row.payload);return {...job,rounds:job.rounds.map(({samples,...round})=>({...round,samples:samples.map(({numbers,prompt,...sample})=>sample)}))};}),total,offset,limit,hasMore:offset+rows.length<total,library:this.library.info,runningAccountIds:[...this.running.keys()]};
  }
  previous(accountId,hash){
    const rows=this.store.db.prepare("SELECT payload FROM fingerprints WHERE account_id=? AND config_hash=? AND status='completed' ORDER BY time DESC,id DESC LIMIT 10").all(accountId,hash);
    const job=rows.map(row=>JSON.parse(row.payload)).find(item=>!item.failures&&item.rounds.some(round=>round.valid===3)&&item.result);
    return job?{jobId:job.id,time:job.time,candidate:job.result.prediction,weight:job.result.probability}:null;
  }
  start(accountId,fields,source="manual"){
    const account=this.store.assertAccountAvailable(accountId);
    if(!account.enabled)throw new PublicError(403,"account_disabled","账号已停用。");
    if(!this.getOAuth(accountId).status().sharing)throw new PublicError(401,"sign_in_required","请先完成该账号的模型授权。");
    if(this.running.has(accountId))throw new PublicError(409,"fingerprint_running","该账号已有指纹检测正在执行。");
    if(!this.admissions)this.store.assertAccountCapacity(accountId);
    const settings=config(fields,this.library),configHash=digest(JSON.stringify({...settings,verificationRounds:undefined}));
    const subject=this.store.accountStore(accountId).connection?.subject||null;
    const job={id:randomUUID(),time:new Date().toISOString(),accountId,accountName:account.name,model:settings.model,config:settings,configHash,source,status:"running",
      identityHash:subject?digest(subject):null,bank:{project:this.library.info.project,commit:this.library.info.commit,bankSha256:this.library.info.bankSha256,builtAt:this.library.info.bankBuiltAt,modelCount:this.library.info.modelCount},
      progress:0,planned:3,maximumRequests:3*(1+settings.verificationRounds),failures:0,invalidSamples:0,modelDifferences:0,usage:{inputTokens:0,outputTokens:0,unknown:0},rounds:[],result:null,assessment:null,previous:this.previous(accountId,configHash)};
    this.running.set(accountId,job);this.save(job);this.store.audit("fingerprint_started",{accountId,model:job.model,expected:settings.expected,maximumRequests:job.maximumRequests});
    const task=this.execute(job).catch(()=>{job.status="failed";job.assessment={...job.assessment,outcome:"execution_issue"};job.finishedAt=new Date().toISOString();this.save(job);}).finally(()=>{this.running.delete(accountId);this.tasks.delete(accountId);});
    this.tasks.set(accountId,task);
    return {id:job.id,status:job.status,maximumRequests:job.maximumRequests};
  }
  cancel(accountId){
    const job=this.running.get(accountId);if(!job)return {stopping:false};
    job.stopRequested=true;this.waitControllers.get(accountId)?.abort();this.save(job);this.store.audit("fingerprint_stop_requested",{accountId,jobId:job.id});return {stopping:true};
  }
  shouldStop(job){
    const account=this.store.getAccount(job.accountId),subject=this.store.accountStore(job.accountId).connection?.subject||null;
    return job.stopRequested||!account.enabled||this.store.removingAccounts.has(job.accountId)||!this.getOAuth(job.accountId).status().sharing||(job.identityHash&&(subject?digest(subject):null)!==job.identityHash);
  }
  async execute(job){
    let verify=false;
    for(let group=0;group<=job.config.verificationRounds;group++){
      if(group&&!verify)break;
      if(this.shouldStop(job)){job.status="stopped";break;}
      const round={index:group+1,kind:group?"verification":"initial",valid:0,samples:[],result:null,assessment:null};job.rounds.push(round);
      if(group)job.planned+=3;
      this.save(job);
      const outputs=[];
      for(const challenge of generateChallenges(3)){
        if(this.shouldStop(job)){job.status="stopped";break;}
        const sample={id:challenge.id,prompt:challenge.prompt,expectedCount:challenge.expected_count,minimumNumbers:Math.max(80,Math.ceil(challenge.expected_count*0.55)),accepted:false};
        const waitController=new AbortController();this.waitControllers.set(job.accountId,waitController);
        try{
          const response=await collectedResponse({model:job.model,input:[{role:"user",content:challenge.prompt}],store:false,...(job.config.effort==="default"?{}:{reasoning:{effort:job.config.effort}})},
            {oauth:this.getOAuth(job.accountId),store:this.store,fetchImpl:this.fetch,admissions:this.admissions,signal:waitController.signal,validateContext:()=>{if(this.shouldStop(job))throw new PublicError(499,"request_cancelled","检测已停止或账号状态已改变。");},context:{accountId:job.accountId,agentId:null,source:"fingerprint",fingerprintJobId:job.id,probeId:challenge.id}});
          const text=(response.output||[]).flatMap(item=>item.content||[]).filter(part=>part.type==="output_text").map(part=>part.text).join("");
          const numbers=parseNumbers(text);sample.numbers=numbers;sample.parsedNumbers=numbers.length;sample.accepted=numbers.length>=sample.minimumNumbers;
          sample.reportedModel=response.model??null;sample.responseId=response.id??null;sample.outputSha256=digest(text);sample.usage=response.usage??null;
          if(response.model&&response.model!==job.model)job.modelDifferences++;
          if(Number.isFinite(response.usage?.input_tokens)&&Number.isFinite(response.usage?.output_tokens)){job.usage.inputTokens+=response.usage.input_tokens;job.usage.outputTokens+=response.usage.output_tokens;}else job.usage.unknown++;
          if(sample.accepted){outputs.push({text,expected_count:challenge.expected_count});round.valid++;}else job.invalidSamples++;
          if(this.shouldStop(job))job.status="stopped";
        }catch(error){
          sample.error=error instanceof PublicError?error.code:"request_failed";
          if(job.stopRequested&&error.beforeUpstream)job.status="stopped";
          else{job.failures++;if(!error.beforeUpstream&&error.code!=="account_concurrency_limit")job.usage.unknown++;if(error.beforeUpstream||(error.status>=400&&error.status<500))job.status="failed";}
        }finally{if(this.waitControllers.get(job.accountId)===waitController)this.waitControllers.delete(job.accountId);}
        round.samples.push(sample);job.progress++;this.save(job);
        if(job.status!=="running")break;
      }
      if(outputs.length){
        round.result=analyzeGlobalOutputs(outputs,this.library.bank);
        round.assessment=assessFingerprint(round.result,job.config.expected,job.previous);
        round.statistics=summarizeNumbers(round.samples.filter(sample=>sample.accepted).flatMap(sample=>sample.numbers));
        job.result=round.result;job.assessment=round.assessment;
      }
      verify=group===0&&!!round.assessment?.needsVerification;
      // Once the first group requests verification, finish the selected verification groups even if candidates change.
      if(group)verify=true;
      this.save(job);
      if(job.status!=="running")break;
    }
    if(job.status==="running")job.status="completed";
    const complete=job.rounds.every(round=>round.valid===3);
    if(!job.result||job.failures||job.status!=="completed")job.assessment={...job.assessment,outcome:"execution_issue"};
    else if(!complete)job.assessment={...job.assessment,outcome:"partial_evidence"};
    else if(job.rounds.length>1){
      const candidates=job.rounds.map(round=>round.result.prediction),consistent=new Set(candidates).size===1;
      if(job.rounds.every(round=>round.assessment.outcome==="suspected_difference")&&consistent)job.assessment={...job.assessment,outcome:"repeated_difference"};
      else if(!job.assessment.referenceKnown)job.assessment={...job.assessment,outcome:consistent?"unlisted_consistent":"unlisted_mixed"};
      else if(job.rounds.some(round=>round.assessment.outcome==="suspected_difference"))job.assessment={...job.assessment,outcome:"mixed_evidence"};
    }
    if(job.assessment?.drift&&!["repeated_difference","mixed_evidence","execution_issue","partial_evidence"].includes(job.assessment.outcome))job.assessment={...job.assessment,outcome:"fingerprint_drift"};
    job.finishedAt=new Date().toISOString();this.save(job);
    const outcome=job.assessment?.outcome;
    const kinds={suspected_difference:"fingerprint_difference",repeated_difference:"fingerprint_repeated_difference",mixed_evidence:"fingerprint_mixed",fingerprint_drift:"fingerprint_drift",unlisted_consistent:"fingerprint_candidate"};
    if(kinds[outcome])this.store.alert(kinds[outcome],job.accountId,null,job.model,
      `${job.model} 的数字指纹${outcome==="mixed_evidence"?"复测结果存在差异":`偏向 ${job.assessment.candidate}`}，已保存 ${job.rounds.length} 组检测证据，供疑似判断。`,
      {jobId:job.id,outcome,expected:job.config.expected,candidate:job.assessment.candidate,candidateWeight:job.assessment.candidateWeight,referenceKnown:job.assessment.referenceKnown,bankSha256:job.bank.bankSha256,groups:job.rounds.map(round=>({candidate:round.result?.prediction,weight:round.result?.probability,valid:round.valid}))});
    this.store.audit("fingerprint_finished",{jobId:job.id,accountId:job.accountId,status:job.status,outcome,requests:job.progress});
  }
  async policy(accountId,fields){
    const account=this.store.assertAccountAvailable(accountId),previous=account.fingerprintPolicy||{};
    if(typeof fields.enabled!=="boolean")throw new PublicError(400,"invalid_policy","定期检测开关无效。");
    const intervalHours=Number(fields.intervalHours??6);
    if(![1,6,12,24].includes(intervalHours))throw new PublicError(400,"invalid_interval","定期检测间隔支持 1、6、12、24 小时。");
    const settings=fields.enabled?config(fields,this.library):{model:String(fields.model||previous.model||"").slice(0,200),effort:fields.effort??previous.effort??"default",verificationRounds:Number(fields.verificationRounds??previous.verificationRounds??1)};
    const {expected,...policySettings}=settings;
    return this.store.manage(next=>{this.store.assertAccountAvailable(accountId);next.accounts.find(item=>item.id===accountId).fingerprintPolicy={...policySettings,enabled:fields.enabled,intervalHours,lastStartedAt:new Date().toISOString()};},"fingerprint_policy_changed",{accountId,enabled:fields.enabled,intervalHours});
  }
  async tick(){
    for(const account of this.store.management.accounts){
      const policy=account.fingerprintPolicy;
      if(!account.enabled||!policy?.enabled||this.running.has(account.id)||this.store.removingAccounts.has(account.id))continue;
      if(Date.now()-Date.parse(policy.lastStartedAt)<policy.intervalHours*3600000||!this.getOAuth(account.id).status().sharing||this.store.accountConcurrency(account.id).saturated)continue;
      const startedAt=new Date().toISOString();
      try{this.start(account.id,policy,"scheduled");}
      catch(error){if(error.code==="account_concurrency_limit")continue;throw error;}
      await this.store.manage(next=>{
        const current=next.accounts.find(item=>item.id===account.id);
        if(!current?.enabled||!current.fingerprintPolicy?.enabled||this.store.removingAccounts.has(account.id))return null;
        current.fingerprintPolicy.lastStartedAt=startedAt;
      },"scheduled_fingerprint_checked",{accountId:account.id});
    }
  }
}
