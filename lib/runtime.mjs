import path from "node:path";

export function publicOrigin(value){
  if(!value)return null;
  let url;try{url=new URL(value);}catch{throw new Error("GATEWAY_PUBLIC_URL must be a valid HTTPS origin");}
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("GATEWAY_PUBLIC_URL must be an HTTPS origin without credentials, path, query or fragment");
  return url.origin;
}

export function runtimeConfig(root,env=process.env,args=process.argv.slice(2)){
  const port=Number(env.GATEWAY_PORT||env.GATEWAY_DEMO_PORT||env.PORT||8787);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("Gateway port must be 1024–65535");
  const bindHost=env.GATEWAY_BIND_HOST||"127.0.0.1";
  if(!["127.0.0.1","0.0.0.0"].includes(bindHost))throw new Error("GATEWAY_BIND_HOST must be 127.0.0.1 or 0.0.0.0");
  const publicUrl=publicOrigin(env.GATEWAY_PUBLIC_URL);
  if(env.GATEWAY_REQUIRE_ADMIN&&!['true','false'].includes(env.GATEWAY_REQUIRE_ADMIN))throw new Error("GATEWAY_REQUIRE_ADMIN must be true or false");
  const requireAdmin=args.includes("--server")||!!publicUrl||bindHost!=="127.0.0.1"||env.GATEWAY_REQUIRE_ADMIN==="true";
  if(args.includes("--lan")&&(publicUrl||bindHost!=="127.0.0.1"))throw new Error("LAN discovery cannot be combined with server bind/public URL settings");
  const transport=env.GATEWAY_UPSTREAM_SESSION_TRANSPORT||"http";
  if(!["http","websocket"].includes(transport))throw new Error("GATEWAY_UPSTREAM_SESSION_TRANSPORT must be websocket or http");
  const queueWaitMs=Number(env.GATEWAY_QUEUE_WAIT_MS||300000);
  if(!Number.isSafeInteger(queueWaitMs)||queueWaitMs<1)throw new Error("GATEWAY_QUEUE_WAIT_MS must be a positive integer");
  return {port,bindHost,publicUrl,requireAdmin,transport,queueWaitMs,directory:path.resolve(env.GATEWAY_DATA_DIR||path.join(root,".data")),lan:args.includes("--lan")};
}
