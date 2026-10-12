import path from "node:path";
import {fileURLToPath} from "node:url";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createGateway} from "../server.mjs";
import {runtimeConfig} from "./runtime.mjs";
import {readJson,writeJson} from "./storage.mjs";
import {loadLanAuth,readLanAuth,validateLanAuth} from "./network.mjs";
import {CodexQuotaClient} from "./quota.mjs";
import {DurableDatabaseSync,DurableFiles,persistRuntimeFile,deleteRuntimeFile} from "./durable-storage.mjs";

export class PersistentQuotaClient extends CodexQuotaClient {
  constructor(home,options={}){
    let client;
    super(home,{...options,onNotification:async message=>{await client.syncAuth();await options.onNotification?.(message);}});client=this;
    this.authDigest=null;this.syncQueue=Promise.resolve();
  }
  syncAuth(){
    const operation=this.syncQueue.then(async()=>{
      const file=path.join(this.home,"auth.json");let bytes;
      try{bytes=await readFile(file);}catch(error){if(error.code!=="ENOENT")throw error;if(this.authDigest){await deleteRuntimeFile(file);this.authDigest=null;}return;}
      const digest=createHash("sha256").update(bytes).digest("hex");
      if(digest!==this.authDigest){await persistRuntimeFile(file,bytes);this.authDigest=digest;}
    });this.syncQueue=operation.catch(()=>{});return operation;
  }
  async request(method,params={}){await this.syncAuth();const result=await super.request(method,params);await this.syncAuth();return result;}
  async start(){
    await super.start();await this.syncAuth();
    // The official CLI can renew its own credentials between RPC calls. Mirror
    // those writes as well, and stop this client if they cannot be persisted.
    this.watchTimer=setInterval(()=>this.syncAuth().catch(()=>this.close()),1500);this.watchTimer.unref();return this;
  }
  close(){clearInterval(this.watchTimer);super.close();}
}

export async function startCloudflare(){
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),config=runtimeConfig(root,process.env,["--server"]);
  if(!config.publicUrl)throw new Error("Cloudflare public URL is required");
  const options={url:process.env.GATEWAY_DURABLE_URL,secret:process.env.GATEWAY_STATE_SECRET};
  const files=new DurableFiles(options),removeMirror=await files.restore(config.directory);
  let database,gateway;
  try{
    if(process.env.GATEWAY_ADMIN_PASSWORD){
      const configured=validateLanAuth({username:process.env.GATEWAY_ADMIN_USERNAME||"admin",password:process.env.GATEWAY_ADMIN_PASSWORD});
      const existing=await readJson(path.join(config.directory,"lan-admin.json"));
      if(existing?.username!==configured.username||existing?.password!==configured.password)await writeJson(path.join(config.directory,"lan-admin.json"),configured);
    }
    const adminAuth=await loadLanAuth(config.directory);database=new DurableDatabaseSync(options);
    gateway=await createGateway({...config,adminAuth,adminAuthLoader:()=>readLanAuth(config.directory),databaseFactory:()=>database,quotaClientFactory:(home,options)=>new PersistentQuotaClient(home,options),sessionWebSockets:config.transport==="websocket",streamKeepaliveMs:15000,adminCookieName:"ag_cf_admin",loginCookieName:"ag_cf_login"});
    console.log("Cloudflare gateway ready; durable database and account storage connected.");
    const stop=async()=>{await gateway.close();removeMirror();process.exit(0);};process.once("SIGTERM",stop);process.once("SIGINT",stop);
    return gateway;
  }catch(error){database?.close();removeMirror();throw error;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startCloudflare().catch(()=>{console.error("Cloudflare gateway could not initialize its durable storage or configuration.");process.exit(1);});
}
