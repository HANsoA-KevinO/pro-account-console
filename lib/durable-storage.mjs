import {Worker} from "node:worker_threads";
import {mkdir,writeFile,readFile,chmod} from "node:fs/promises";
import path from "node:path";
import {PublicError} from "./oauth.mjs";

const mirrors=new Map();
const names=new Set(["settings.json","management.json","connection.json","quota-state.json","lan-admin.json","usage.json"]);
export function durableFileName(name){
  return typeof name==="string"&&(names.has(name)||/^accounts\/account[-\w]*\.json$/.test(name)||/^quota-runtime\/account[-\w]*\/(?:auth\.json|config\.toml)$/.test(name)||/^backups\/[\w-]+\.json$/.test(name));
}
export function durableDeleteName(name){return durableFileName(name)||/^quota-runtime\/account[-\w]*$/.test(name);}
function failure(code="durable_storage_unavailable"){
  return new PublicError(503,code,code==="durable_result_too_large"?"持久化查询结果过大，请缩小日志筛选范围。":"Cloudflare 持久化存储暂不可用，请稍后重试。");
}
export function durableEndpoint(url,{allowLoopback=false}={}){
  const value=new URL(url);
  if(value.username||value.password||value.search||value.hash||value.pathname!=="/__gateway/state"||!(value.protocol==="https:"||(allowLoopback&&value.protocol==="http:"&&["127.0.0.1","localhost"].includes(value.hostname))))throw new Error("Invalid durable storage endpoint");
  return value.href;
}

// The existing Store exposes synchronous SQLite queries. Network I/O runs on
// a separate thread; the database remains authoritative in a Durable Object.
export class DurableDatabaseSync {
  constructor({url,secret,timeoutMs=10000,allowLoopback=false,responseBytes=32*1024*1024}){
    this.url=durableEndpoint(url,{allowLoopback});if(typeof secret!=="string"||secret.length<32)throw new Error("Durable storage secret is missing");
    this.secret=secret;this.timeoutMs=timeoutMs;this.buffer=new SharedArrayBuffer(responseBytes+8);this.transaction=null;this.closed=false;
    this.worker=new Worker(new URL("./durable-rpc-worker.mjs",import.meta.url));this.worker.on("error",()=>{this.broken=true;});this.worker.unref();
  }
  call(payload){
    if(this.closed||this.broken)throw failure();
    const control=new Int32Array(this.buffer,0,2);Atomics.store(control,0,0);Atomics.store(control,1,0);
    this.worker.postMessage({url:this.url,secret:this.secret,payload,buffer:this.buffer,timeoutMs:this.timeoutMs});
    if(Atomics.wait(control,0,0,this.timeoutMs+2000)==="timed-out"){
      this.broken=true;void this.worker.terminate();throw failure();
    }
    const result=JSON.parse(new TextDecoder().decode(new Uint8Array(this.buffer,8,Atomics.load(control,1))));
    if(result.error)throw failure(result.error.code);return result;
  }
  execute(sql,args=[],mode="all"){
    if(this.transaction){
      if(mode!=="run"&&mode!=="exec")throw new Error("Durable transactions support write statements only");
      this.transaction.push({sql,args});return {rows:[],changes:0};
    }
    return this.call({action:"sql",sql,args});
  }
  exec(sql){
    const command=sql.trim().replace(/;$/," ").trim().toUpperCase();
    if(command==="BEGIN"||command==="BEGIN TRANSACTION"){if(this.transaction)throw new Error("Transaction already open");this.transaction=[];return;}
    if(command==="ROLLBACK"){this.transaction=null;return;}
    if(command==="COMMIT"){
      if(!this.transaction)throw new Error("No transaction is open");const statements=this.transaction;this.transaction=null;this.call({action:"batch",statements});return;
    }
    // Cloudflare owns SQLite journal settings; the native disk pragma has no
    // effect in this backend. All schema statements still execute remotely.
    sql=sql.replace(/PRAGMA\s+journal_mode\s*=\s*DELETE\s*;/gi,"");
    if(sql.trim())this.execute(sql,[],"exec");
  }
  prepare(sql){return {all:(...args)=>this.execute(sql,args).rows,get:(...args)=>this.execute(sql,args).rows[0],run:(...args)=>({changes:this.execute(sql,args,"run").changes,lastInsertRowid:0})};}
  close(){this.closed=true;this.transaction=null;void this.worker.terminate();}
}

export class DurableFiles {
  constructor({url,secret,allowLoopback=false}){this.url=durableEndpoint(url,{allowLoopback});this.secret=secret;}
  async call(payload){
    let response,result;
    try{response=await fetch(this.url,{method:"POST",headers:{authorization:"Bearer "+this.secret,"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});result=await response.json();}
    catch{throw failure();}
    if(!response.ok||result.error)throw failure(result.error?.code);return result;
  }
  async put(name,bytes){if(!durableFileName(name))throw new Error("Invalid durable file path");await this.call({action:"file_put",name,value:Buffer.from(bytes).toString("base64")});}
  async remove(name){if(!durableDeleteName(name))return;await this.call({action:"file_delete",name});}
  async restore(directory){
    const result=await this.call({action:"file_list"});
    if(!Array.isArray(result.files))throw failure();
    for(const file of result.files){
      if(!durableFileName(file.name)||typeof file.value!=="string")throw failure();
      const target=path.join(directory,file.name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await chmod(path.dirname(target),0o700);
      await writeFile(target,Buffer.from(file.value,"base64"),{mode:0o600});await chmod(target,0o600);
    }
    mirrors.set(path.resolve(directory),this);
    return ()=>mirrors.delete(path.resolve(directory));
  }
}
function mirrorFor(file){
  const location=path.resolve(file);
  for(const [directory,mirror]of mirrors)if(location.startsWith(directory+path.sep))return {mirror,name:path.relative(directory,location).split(path.sep).join("/")};
}
export async function persistRuntimeFile(file,bytes){const found=mirrorFor(file);if(found&&durableFileName(found.name))await found.mirror.put(found.name,bytes);}
export async function deleteRuntimeFile(file){const found=mirrorFor(file);if(found)await found.mirror.remove(found.name);}
export async function persistQuotaAuth(home){
  const file=path.join(home,"auth.json");let bytes;
  try{bytes=await readFile(file);}catch(error){if(error.code!=="ENOENT")throw error;await deleteRuntimeFile(file);return null;}
  await persistRuntimeFile(file,bytes);return bytes;
}
