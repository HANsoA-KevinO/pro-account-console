import {DurableObject} from "cloudflare:workers";
import {stateOperation,owner} from "./state.mjs";

const json=(status,value)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const stateFor=(env,jurisdiction=env.DATA_JURISDICTION)=>owner(env.STATE,"gateway-state-v1",jurisdiction);
const containerFor=(env,jurisdiction=env.DATA_JURISDICTION)=>owner(env.GATEWAY,"gateway-container-v1",jurisdiction);
function validSecret(header,secret){
  if(typeof secret!=="string"||secret.length<32||typeof header!=="string")return false;
  const a=new TextEncoder().encode(header),b=new TextEncoder().encode("Bearer "+secret);
  if(a.length!==b.length)return false;let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
export class GatewayState extends DurableObject {
  async fetch(request){
    if(request.method!=="POST"||!validSecret(request.headers.get("authorization"),this.env.GATEWAY_STATE_SECRET))return json(403,{error:{code:"state_forbidden"}});
    try{
      const payload=await request.json(),result=stateOperation(this.ctx.storage,payload);
      await this.ctx.storage.sync();const response=json(200,result);response.headers.set("x-gateway-data-jurisdiction",this.ctx.id.jurisdiction||"global");return response;
    }catch{return json(503,{error:{code:"durable_storage_unavailable"}});}
  }
}
export class GatewayContainer extends DurableObject {
  async stop(){
    const container=this.ctx.container;
    if(container?.running){container.signal(15);await container.monitor();}
    return {ok:true};
  }
  async ready(){
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const container=this.ctx.container;if(!container)throw new Error("Container is not configured");
      if(!container.running)container.start({enableInternet:true,env:{
        GATEWAY_PORT:"18787",GATEWAY_BIND_HOST:"0.0.0.0",GATEWAY_REQUIRE_ADMIN:"true",
        GATEWAY_DATA_DIR:"/var/lib/pro-account-console",GATEWAY_PUBLIC_URL:this.env.PUBLIC_ORIGIN,
        GATEWAY_UPSTREAM_SESSION_TRANSPORT:"http",GATEWAY_QUEUE_WAIT_MS:"300000",
        GATEWAY_DURABLE_URL:this.env.PUBLIC_ORIGIN+"/__gateway/state",GATEWAY_STATE_SECRET:this.env.GATEWAY_STATE_SECRET,
        GATEWAY_ADMIN_USERNAME:this.env.GATEWAY_ADMIN_USERNAME||"admin",GATEWAY_ADMIN_PASSWORD:this.env.GATEWAY_ADMIN_PASSWORD,
      }});
      await container.setInactivityTimeout(10*60*1000);
      const port=container.getTcpPort(18787),deadline=Date.now()+90000;
      while(Date.now()<deadline){
        try{const response=await port.fetch("http://127.0.0.1:18787/healthz");if(response.ok)return port;}catch{}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error("Container startup timed out");
    })().finally(()=>{this.starting=null;});return this.starting;
  }
  async fetch(request){
    try{
      const port=await this.ready(),url=new URL(request.url);url.protocol="http:";
      // TLS terminates at the Worker. Preserve the public host and Origin for
      // the gateway's host allowlist, secure cookies and CSRF validation.
      const response=await port.fetch(new Request(url,request)),headers=new Headers(response.headers);
      headers.set("x-gateway-compute-jurisdiction",this.ctx.id.jurisdiction||"global");
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    }
    catch{return json(503,{error:{code:"cloudflare_container_starting",message:"云端网关正在启动或更新，请稍后重试。"}});}
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    // State requests never traverse a starting container: startup itself needs
    // this storage service. Both namespaces always address one fixed owner.
    if(["/__gateway/state","/__gateway/state-legacy","/__gateway/stop"].includes(url.pathname)){
      if(request.method!=="POST"||request.headers.has("origin")||!validSecret(request.headers.get("authorization"),env.GATEWAY_STATE_SECRET))return json(403,{error:{code:"state_forbidden"}});
      if(url.pathname==="/__gateway/stop"){
        const body=await request.json();if(!["global","us"].includes(body.jurisdiction))return json(400,{error:{code:"invalid_jurisdiction"}});
        return json(200,await containerFor(env,body.jurisdiction).stop());
      }
      return stateFor(env,url.pathname==="/__gateway/state-legacy"?"global":env.DATA_JURISDICTION).fetch(request);
    }
    if(env.SETUP_LOCK==="true")return json(503,{error:{code:"cloudflare_setup_in_progress",message:"网关正在完成区域部署，请稍后重试。"}});
    if(!env.PUBLIC_ORIGIN||!env.GATEWAY_STATE_SECRET||!env.GATEWAY_ADMIN_PASSWORD)return json(503,{error:{code:"cloudflare_setup_required",message:"请先完成 Cloudflare 网关配置。"}});
    if(url.origin!==env.PUBLIC_ORIGIN)return json(403,{error:{code:"invalid_host"}});
    return containerFor(env).fetch(request);
  },
};
