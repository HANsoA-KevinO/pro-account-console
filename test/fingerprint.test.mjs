import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {Store,writeJson} from "../lib/storage.mjs";
import {createGateway} from "../server.mjs";
import {Fingerprints,loadFingerprintLibrary,assessFingerprint,summarizeNumbers} from "../lib/fingerprint.mjs";
import {analyzeGlobalOutputs} from "../vendor/modeltrace/fingerprint-core.mjs";

const library=await loadFingerprintLibrary();
const samples=JSON.parse(await readFile(new URL("./fixtures/modeltrace-samples.json",import.meta.url),"utf8"));
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),"fingerprint-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function responder(model,index){const text=samples[model][index%3].text;return {id:"resp_fingerprint_"+index,model:"gpt-6-sol",status:"completed",output:[{type:"message",content:[{type:"output_text",text}]}],usage:{input_tokens:30,output_tokens:500}};}
async function fixture(t,{sampleModel="gpt-6-sol",fetchImpl}={}){
  const store=await new Store(await directory(t)).init();const calls=[];
  const oauth=id=>({status:()=>({sharing:true}),accessToken:async()=>id});
  const mock=fetchImpl||(async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body,account:options.headers.authorization.slice(7)});
    const model=typeof sampleModel==="function"?sampleModel(calls.length-1):sampleModel;
    const response=responder(model,calls.length-1);response.model=body.model;
    return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
  });
  const fp=new Fingerprints(store,oauth,mock,library);t.after(()=>store.close());
  const run=async(id="account-default",fields={})=>{const started=fp.start(id,{model:"gpt-6-sol",verificationRounds:1,...fields});await fp.tasks.get(id);return fp.get(started.id);};
  return {store,fp,calls,run};
}

test("pinned ModelTrace assets load with license/provenance and preserve reference scorer output",()=>{
  assert.equal(library.info.modelCount,18);assert.equal(library.info.commit,"6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2");
  const result=analyzeGlobalOutputs(samples["gpt-6-sol"],library.bank);
  assert.equal(result.prediction,"gpt-6-sol");assert.ok(result.probability>0.99);
  assert.equal(library.info.models.some(item=>item.id==="gpt-6.1-sol"),false);
});

test("reference coverage and missing samples describe evidence, without disabling unlisted model analysis",()=>{
  const result=analyzeGlobalOutputs(samples["gpt-6-sol"],library.bank);
  assert.equal(assessFingerprint(result,"gpt-6-sol").outcome,"compatible");
  assert.equal(assessFingerprint(result,"gpt-6.1-sol").outcome,"unlisted_model");
  assert.equal(assessFingerprint({...result,used_outputs:1},"gpt-6-sol").outcome,"partial_evidence");
  const stats=summarizeNumbers([1,1,42,355]);assert.equal(stats.count,4);assert.equal(stats.unique,3);assert.equal(stats.counts[354],1);assert.equal(stats.lastDigits[1],2);
});

test("compatible detection uses three fixed-account Responses, logs actual usage, and requires no old baseline",async t=>{
  const f=await fixture(t),b=await f.store.addAccount("B");
  const job=await f.run(b.id);
  assert.equal(job.status,"completed");assert.equal(job.assessment.outcome,"compatible");assert.equal(job.rounds.length,1);
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.account===b.id));
  assert.ok(f.calls.every(call=>call.body.store===false&&call.body.stream===true&&!Object.hasOwn(call.body,"tools")&&!Object.hasOwn(call.body,"temperature")));
  assert.equal(new Set(f.calls.map(call=>call.body.input[0].content)).size,3);
  assert.equal(job.usage.inputTokens,90);assert.equal(job.usage.outputTokens,1500);
  assert.equal(f.store.report({accountId:b.id}).requests,3);assert.ok(f.store.records.every(row=>row.source==="fingerprint"&&row.fingerprintJobId===job.id));
  const summary=f.fp.history();assert.equal(summary.history[0].rounds[0].samples[0].numbers,undefined);assert.ok(f.fp.get(job.id).rounds[0].samples[0].numbers.length>80);
});

test("strong mismatch triggers configured independent verification and records a suspected-difference alert",async t=>{
  const f=await fixture(t,{sampleModel:"gpt-6-luna"});const job=await f.run();
  assert.equal(job.assessment.outcome,"repeated_difference");assert.equal(job.progress,6);assert.equal(job.rounds.length,2);
  assert.equal(job.result.prediction,"gpt-6-luna");assert.ok(job.rounds.every(round=>round.result.used_outputs===3));
  assert.equal(new Set(f.calls.map(call=>call.body.input[0].content)).size,6);
  assert.equal(f.store.alerts()[0].kind,"fingerprint_repeated_difference");assert.equal(f.store.alerts()[0].details.jobId,job.id);
  assert.equal(f.store.getAccount("account-default").enabled,true);
});

test("unlisted new models receive candidate ranks and repeated candidate evidence, without inventing a reference weight",async t=>{
  const f=await fixture(t);const job=await f.run("account-default",{model:"gpt-6.1-sol"});
  assert.equal(job.status,"completed");assert.equal(job.assessment.outcome,"unlisted_consistent");assert.equal(job.assessment.referenceKnown,false);assert.equal(job.assessment.referenceWeight,null);
  assert.equal(job.result.results.length,18);assert.equal(f.store.alerts()[0].kind,"fingerprint_candidate");
  assert.equal(f.calls.length,6);assert.ok(f.calls.every(call=>call.body.model==="gpt-6.1-sol"));
  const legacyInput=await f.run("account-default",{model:"gpt-6.1-sol",expected:"gpt-6-sol",verificationRounds:0});
  assert.equal(legacyInput.assessment.outcome,"unlisted_model");assert.equal(legacyInput.config.expected,"gpt-6.1-sol");assert.ok(f.calls.every(call=>call.body.model==="gpt-6.1-sol"));
  assert.deepEqual(legacyInput.result.results.map(item=>item.model),job.result.results.map(item=>item.model));
});

test("verification disagreements are retained and cannot become a repeated-difference conclusion",async t=>{
  const f=await fixture(t,{sampleModel:index=>index<3?"gpt-6-luna":"gpt-6-sol"});const job=await f.run();
  assert.equal(job.assessment.outcome,"mixed_evidence");assert.equal(job.rounds[0].result.prediction,"gpt-6-luna");assert.equal(job.rounds[1].result.prediction,"gpt-6-sol");
  assert.equal(f.store.alerts()[0].kind,"fingerprint_mixed");
});

test("unknown-model historical candidate change is retained under identical model/effort/reference/bank conditions",async t=>{
  let changed=false;const f=await fixture(t,{sampleModel:()=>changed?"gpt-6-luna":"gpt-6-sol"});
  const first=await f.run("account-default",{model:"gpt-6.1-sol",verificationRounds:0});changed=true;
  const second=await f.run("account-default",{model:"gpt-6.1-sol",verificationRounds:0});
  assert.equal(second.previous.jobId,first.id);assert.equal(second.assessment.outcome,"fingerprint_drift");
  const differentEffort=await f.run("account-default",{model:"gpt-6.1-sol",effort:"high",verificationRounds:0});assert.equal(differentEffort.previous,null);
});

test("invalid numeric samples create partial evidence, not model mismatch; auth/quota errors stop further calls",async t=>{
  let index=0;
  const f=await fixture(t,{fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body),response=responder("gpt-6-luna",index++);response.model=body.model;
    if(index>1)response.output[0].content[0].text="无法生成数字。";
    return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
  }});
  const job=await f.run();assert.equal(job.assessment.outcome,"partial_evidence");assert.equal(job.progress,3);assert.equal(job.rounds.length,1);assert.equal(job.invalidSamples,2);assert.equal(f.store.alerts().length,0);
  let quotaCalls=0;f.fp.fetch=async()=>{quotaCalls++;return Response.json({error:{code:"subscription_sharing_usage_limit_exceeded"}},{status:429});};
  const failed=await f.run();assert.equal(failed.status,"failed");assert.equal(failed.assessment.outcome,"execution_issue");assert.equal(quotaCalls,1);
});

test("cancel and identity/enable changes prevent follow-up probes; a second job cannot overlap",async t=>{
  let entered,release;
  const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{fetchImpl:async()=>{entered();await gate;return new Response("data: "+JSON.stringify({type:"response.completed",response:responder("gpt-6-sol",0)})+"\n\n",{headers:{"content-type":"text/event-stream"}});}});
  const started=f.fp.start("account-default",{model:"gpt-6-sol"});await ready;
  assert.throws(()=>f.fp.start("account-default",{model:"gpt-6-sol"}),error=>error.code==="fingerprint_running");
  f.fp.cancel("account-default");release();await f.fp.tasks.get("account-default");
  const job=f.fp.get(started.id);assert.equal(job.status,"stopped");assert.equal(job.progress,1);assert.equal(job.assessment.outcome,"execution_issue");
});

test("legacy periodic checks retire once while old history is retained; fingerprint scheduling is opt-in",async t=>{
  const dir=await directory(t);let store=await new Store(dir).init();
  const management=structuredClone(store.management);delete management.fingerprintMigrated;management.accounts[0].qualityPolicy={enabled:true,model:"old-model",intervalHours:6};
  store.db.prepare("INSERT INTO quality VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("old",new Date().toISOString(),"account-default","old-model","hash",1,18,18,0,1,JSON.stringify({id:"old",status:"completed"}));store.close();
  await writeJson(path.join(dir,"management.json"),management);store=await new Store(dir).init();t.after(()=>store.close());
  assert.equal(store.getAccount("account-default").qualityPolicy.enabled,false);assert.equal(store.getAccount("account-default").legacyQualityPolicy.enabled,true);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM quality").get().n,1);
  const fp=new Fingerprints(store,()=>({status:()=>({sharing:true}),accessToken:async()=>"mock"}),async()=>{throw new Error("Unexpected request");},library);
  await fp.tick();assert.equal(fp.running.size,0);assert.equal(store.getAccount("account-default").fingerprintPolicy,undefined);
  await fp.policy("account-default",{enabled:true,model:"gpt-6-sol",intervalHours:6,verificationRounds:0});assert.equal(store.getAccount("account-default").fingerprintPolicy.enabled,true);
  await fp.tick();assert.equal(fp.running.size,0);
  await fp.policy("account-default",{enabled:false,intervalHours:6});assert.equal(store.getAccount("account-default").fingerprintPolicy.enabled,false);
});

test("admin fingerprint APIs are protected, global/filterable, and legacy inference endpoints are retired",async t=>{
  let index=0;const g=await createGateway({sessionWebSockets:false,port:0,directory:await directory(t),oauthFactory:(_store,id)=>({status:()=>({connected:true,sharing:true}),accessToken:async()=>id}),fetchImpl:async(url,options)=>{
    const response=responder("gpt-6-sol",index++);response.model=JSON.parse(options.body).model;
    return new Response("data: "+JSON.stringify({type:"response.completed",response})+"\n\n",{headers:{"content-type":"text/event-stream"}});
  }});t.after(()=>new Promise(resolve=>{g.server.close(resolve);g.server.closeAllConnections();}));
  assert.equal((await fetch(g.origin+"/api/fingerprint")).status,401);
  const page=await fetch(g.origin+"/"),html=await page.text(),headers={cookie:page.headers.get("set-cookie").split(";")[0],"x-demo-csrf":html.match(/data-csrf="([^"]+)"/)[1],"content-type":"application/json"};
  assert.equal((await fetch(g.origin+"/api/fingerprint/run",{method:"POST",headers:{cookie:headers.cookie},body:"{}"})).status,403);
  const r=await fetch(g.origin+"/api/fingerprint/run",{method:"POST",headers,body:JSON.stringify({accountId:"account-default",model:"gpt-6-sol",verificationRounds:0})});assert.equal(r.status,202);const started=await r.json();await g.fingerprints.tasks.get("account-default");
  const report=await (await fetch(g.origin+"/api/fingerprint",{headers})).json();assert.equal(report.total,1);assert.equal(report.history[0].id,started.id);
  const filtered=await (await fetch(g.origin+"/api/fingerprint?accountId=other",{headers})).json();assert.equal(filtered.total,0);
  const full=await (await fetch(g.origin+"/api/fingerprint/"+started.id,{headers})).json();assert.ok(full.rounds[0].samples[0].numbers.length>80);
  assert.equal((await fetch(g.origin+"/api/quality/run",{method:"POST",headers,body:"{}"})).status,410);
});

test("a due opt-in policy starts exactly one scheduled fixed-account group and advances its interval",async t=>{
  const f=await fixture(t);
  await f.fp.policy("account-default",{enabled:true,model:"gpt-6-sol",intervalHours:1,verificationRounds:0});
  await f.store.manage(next=>{next.accounts[0].fingerprintPolicy.lastStartedAt=new Date(Date.now()-3600001).toISOString();},"test_schedule",{});
  await f.fp.tick();await f.fp.tasks.get("account-default");
  const job=f.fp.history().history[0];assert.equal(job.source,"scheduled");assert.equal(job.progress,3);assert.equal(job.assessment.outcome,"compatible");
  await f.fp.tick();assert.equal(f.calls.length,3);
});

test("legacy manual references are removed from periodic policies without rewriting old attribution reports",async t=>{
  const dir=await directory(t);let store=await new Store(dir).init();
  const management=structuredClone(store.management);delete management.fingerprintAttributionMigrated;
  management.accounts[0].fingerprintPolicy={model:"gpt-6-sol",expected:"gpt-6-luna",enabled:true,intervalHours:6,verificationRounds:0,lastStartedAt:new Date().toISOString()};
  const oldReport={id:"old-report",config:{expected:"gpt-6-luna"},rounds:[]};
  store.db.prepare("INSERT INTO fingerprints VALUES (?,?,?,?,?,?,?)").run("old-report",new Date().toISOString(),"account-default","gpt-6-sol","old-hash","completed",JSON.stringify(oldReport));
  store.close();await writeJson(path.join(dir,"management.json"),management);
  store=await new Store(dir).init();t.after(()=>store.close());
  const account=store.getAccount("account-default");assert.equal(account.fingerprintPolicy.expected,undefined);assert.equal(account.fingerprintPolicy.enabled,true);assert.equal(account.legacyFingerprintReference,"gpt-6-luna");
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT payload FROM fingerprints WHERE id='old-report'").get().payload),oldReport);
  const fp=new Fingerprints(store,()=>({status:()=>({sharing:true}),accessToken:async()=>"mock"}),async()=>{throw new Error("Unexpected request");},library);
  await fp.policy("account-default",{enabled:true,model:"gpt-6-sol",expected:"gpt-6-luna",verificationRounds:0,intervalHours:6});
  assert.equal(store.getAccount("account-default").fingerprintPolicy.expected,undefined);
});
