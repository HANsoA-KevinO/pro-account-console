import {parseArgs} from "node:util";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {fastPlan,cachePlan,measureRequest,summarizeBenchmark,reportMarkdown} from "../lib/benchmark.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {values,positionals}=parseArgs({allowPositionals:true,options:{run:{type:"boolean",default:false},model:{type:"string",default:"gpt-6-astra"},pairs:{type:"string",default:"3"},items:{type:"string",default:"256"},"fast-tier":{type:"string",default:"fast"},lines:{type:"string",default:"128"},"cache-mode":{type:"string",default:"automatic"},"no-cross-account":{type:"boolean",default:false}}});
const kind=positionals[0];
if(!["fast","cache"].includes(kind))throw new Error("用法：npm run benchmark -- fast|cache [--run] [--model gpt-6-astra]。默认只显示方案。");
const modes=values["cache-mode"]==="both"?["implicit","explicit"]:[values["cache-mode"]];
const plan=kind==="fast"?fastPlan({model:values.model,pairs:Number(values.pairs),items:Number(values.items),fastTier:values["fast-tier"]}):cachePlan({model:values.model,lines:Number(values.lines),crossAccount:!values["no-cross-account"],modes});
console.log(JSON.stringify({kind,runId:plan.runId,model:plan.model,requests:plan.expectedRequests,execute:values.run,steps:plan.steps.map(s=>({label:s.label,condition:s.condition,tier:s.body.service_tier,session_id:s.body.session_id}))},null,2));
if(values.run){
  const baseUrl=process.env.GATEWAY_BENCHMARK_URL||`http://127.0.0.1:${process.env.GATEWAY_PORT||process.env.GATEWAY_DEMO_PORT||8787}/v1`;
  const settings=process.env.GATEWAY_BENCHMARK_KEY?null:JSON.parse(await readFile(path.join(process.env.GATEWAY_DATA_DIR||path.join(root,".data"),"settings.json"),"utf8"));
  const apiKey=process.env.GATEWAY_BENCHMARK_KEY||settings.gatewayKey;
  const report={kind,runId:plan.runId,model:plan.model,startedAt:new Date().toISOString(),baseUrl,rows:[],summary:null};
  const directory=path.join(root,"reports");await mkdir(directory,{recursive:true});
  const stem=path.join(directory,`${kind}-${plan.runId}`);
  const save=async()=>{
    report.summary=summarizeBenchmark(plan,report.rows);
    await writeFile(stem+".json",JSON.stringify(report,null,2)+"\n",{mode:0o600});
    await writeFile(stem+".md",reportMarkdown(report),{mode:0o600});
  };
  for(const step of plan.steps){
    console.log("开始 "+step.label);
    const row=await measureRequest(step,{baseUrl,apiKey});report.rows.push(row);await save();
    console.log(JSON.stringify(row));
    if(row.status!=="completed"){console.log("样本失败，已停止后续模型请求；报告保留错误和已有样本。");process.exitCode=1;break;}
  }
  console.log(JSON.stringify({report:stem+".md",summary:report.summary},null,2));
}
