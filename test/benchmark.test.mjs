import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createGateway} from "../server.mjs";
import {fastPlan,cachePlan,measureRequest,summarizeBenchmark} from "../lib/benchmark.mjs";

function stream(events){return new Response(events.map(event=>"data: "+JSON.stringify(event)+"\n\n").join(""),{headers:{"content-type":"text/event-stream","x-gateway-account-id":"a","x-gateway-session-routing":"reused","x-gateway-queue-wait-ms":"50"}});}
const completed={type:"response.completed",response:{id:"resp-benchmark",status:"completed",model:"m",service_tier:"priority",usage:{input_tokens:2000,input_tokens_details:{cached_tokens:1800,cache_write_tokens:100},output_tokens:100,output_tokens_details:{reasoning_tokens:20}}}};

test("benchmark measures text deltas and actual tier, excluding queue and reasoning",async()=>{
  const times=[0,100,200,250];
  const row=await measureRequest(fastPlan({model:"m",pairs:1}).steps[1],{baseUrl:"http://test/v1",apiKey:"secret",now:()=>times.shift(),fetchImpl:async()=>stream([{type:"response.output_text.delta",delta:"hello"},{type:"response.output_text.delta",delta:" world"},completed])});
  assert.equal(row.status,"completed");assert.equal(row.reportedTier,"priority");assert.equal(row.firstTextAfterQueueMs,50);
  assert.equal(row.durationMs,250);assert.equal(row.outputSpanMs,100);assert.equal(row.approxVisibleTokensPerSecond,800);
  assert.equal(row.cacheTokenRatio,.9);assert.equal(row.cacheWriteTokens,100);assert.equal(row.outputCharacters,11);
  assert.ok(!JSON.stringify(row).includes("secret"));
});

test("missing metadata is unknown and a single buffered chunk cannot establish token speed",async()=>{
  const event=structuredClone(completed);delete event.response.service_tier;delete event.response.usage.input_tokens_details;delete event.response.usage.output_tokens_details;
  let time=0;
  const row=await measureRequest(fastPlan({model:"m",pairs:1}).steps[1],{baseUrl:"http://test/v1",apiKey:"secret",now:()=>time+=10,fetchImpl:async()=>stream([{type:"response.output_text.delta",delta:"buffered"},event])});
  assert.equal(row.reportedTier,null);assert.equal(row.cachedTokens,null);assert.equal(row.reasoningTokens,null);assert.equal(row.cacheTokenRatio,null);assert.equal(row.approxVisibleTokensPerSecond,null);
  assert.equal(summarizeBenchmark(fastPlan({model:"m",pairs:1}),[row]).fast.state,"unconfirmed");
});

test("standard fallback and failed streams cannot establish Fast activation",async()=>{
  const plan=fastPlan({model:"m",pairs:1}),event=structuredClone(completed);event.response.service_tier="default";
  const row=await measureRequest(plan.steps[1],{baseUrl:"http://test/v1",apiKey:"secret",fetchImpl:async()=>stream([event])});
  assert.equal(summarizeBenchmark(plan,[row]).fast.state,"served_as_standard");
  const failed=await measureRequest(plan.steps[1],{baseUrl:"http://test/v1",apiKey:"secret",fetchImpl:async()=>stream([{type:"response.output_text.delta",delta:"partial"}])});
  assert.equal(failed.status,"failed");assert.equal(failed.errorCode,"stream_incomplete");
  const error=await measureRequest(plan.steps[1],{baseUrl:"http://test/v1",apiKey:"secret",fetchImpl:async()=>new Response(JSON.stringify({detail:"Unsupported service tier"}),{status:400})});
  assert.equal(error.errorMessage,"Unsupported service tier");assert.equal(error.errorCode,"http_400");
});

test("Fast speed comparison excludes mismatched accounts, cached prompts and queueing",()=>{
  const plan=fastPlan({model:"m",pairs:4});
  const base={status:"completed",accountId:"a",reportedModel:"m",queueWaitMs:0,cachedTokens:0,firstTextAfterQueueMs:100};
  const rows=[];
  for(let pair=1;pair<=4;pair++)rows.push({...base,pair,group:"default",reportedTier:"default",approxVisibleTokensPerSecond:100},{...base,pair,group:"fast",reportedTier:"priority",approxVisibleTokensPerSecond:200});
  rows[3].accountId="b";rows[5].cachedTokens=100;rows[7].queueWaitMs=1;
  const summary=summarizeBenchmark(plan,rows);assert.equal(summary.fast.validPairs,1);assert.equal(summary.fast.medianSpeedRatio,2);
});

test("cache ratios are token weighted; unknown usage and actual cross-account routing stay separate",()=>{
  const plan=cachePlan({model:"m",modes:["explicit"]}),base={status:"completed",group:"explicit",accountId:"a",inputTokens:2000,firstTextAfterQueueMs:100};
  const rows=[{...base,condition:"seed",cachedTokens:0,cacheTokenRatio:0},{...base,condition:"exact",cachedTokens:1000,cacheTokenRatio:.5},
    {...base,condition:"exact",inputTokens:4000,cachedTokens:4000,cacheTokenRatio:1},{...base,condition:"exact",cachedTokens:null,cacheTokenRatio:null},
    {...base,condition:"cross-seed",cachedTokens:2000,cacheTokenRatio:1}];
  const summary=summarizeBenchmark(plan,rows),exact=summary.cache.find(r=>r.group==="explicit"&&r.condition==="exact"),cross=summary.cache.find(r=>r.condition==="cross-seed"&&r.group==="explicit");
  assert.equal(exact.tokenHitRatio,5/6);assert.equal(exact.requestHitRatio,1);assert.equal(exact.missing,1);assert.equal(cross.changedAccount,false);
  assert.equal(summary.totals.cachedTokens,null);assert.equal(summary.totals.missingCacheUsage,1);
});

test("gateway preserves Fast/cache controls and usage while keeping session_id local",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"benchmark-gateway-"));let body;
  const g=await createGateway({sessionWebSockets:false,directory,port:0,oauthFactory:()=>({status:()=>({sharing:true,connected:true}),accessToken:async()=>"UPSTREAM_SECRET"}),fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return stream([{type:"response.output_text.delta",delta:"ok"},completed]);}});
  t.after(async()=>{await g.close();await rm(directory,{recursive:true,force:true});});
  const step=cachePlan({model:"m",modes:["explicit"],crossAccount:false}).steps[0];step.body.service_tier="fast";
  const row=await measureRequest(step,{baseUrl:g.origin+"/v1",apiKey:g.store.settings.gatewayKey});
  assert.equal(row.status,"completed");assert.equal(body.service_tier,"fast");assert.deepEqual(body.prompt_cache_options,{mode:"explicit",ttl:"30m"});
  assert.deepEqual(body.input[0].content[0].prompt_cache_breakpoint,{mode:"explicit"});assert.equal(Object.hasOwn(body,"session_id"),false);
  assert.equal(row.reportedTier,"priority");assert.equal(row.cachedTokens,1800);assert.equal(row.cacheWriteTokens,100);
  assert.equal(g.store.report({session_id:step.body.session_id}).records[0].usage.input_tokens_details.cached_tokens,1800);
});
