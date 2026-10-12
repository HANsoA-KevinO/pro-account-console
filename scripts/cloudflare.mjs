import {readFile,writeFile,mkdir,chmod,access} from "node:fs/promises";
import {spawn,execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {publicOrigin} from "../lib/runtime.mjs";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),directory=path.join(root,".data","cloudflare"),configPath=path.join(directory,"wrangler.jsonc"),wrangler=path.join(root,"node_modules",".bin","wrangler");
const args=process.argv.slice(2),command=args.shift(),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const run=(program,argv,extra={})=>new Promise((resolve,reject)=>{
  const child=spawn(program,argv,{cwd:root,stdio:"inherit",...extra});child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error(program+" exited with status "+code)));
});
const save=async(file,value)=>{await writeFile(file,JSON.stringify(value,null,2)+"\n",{mode:0o600});await chmod(file,0o600);};
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
try{
  if(command==="prepare"){
    const origin=publicOrigin(option("--public-url")),accountId=option("--account-id"),name=option("--name")||"pro-account-console";
    if(!origin||!accountId||!/^\w{32}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))throw new Error("Use prepare --account-id <Cloudflare account ID> --public-url https://<name>.<subdomain>.workers.dev [--name <new Worker name>]");
    await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
    const key=path.join(directory,"ssh-key");try{await access(key);}catch{execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-C","pro-account-console-cloudflare","-f",key]);}
    let secrets;try{secrets=JSON.parse(await readFile(path.join(directory,"secrets.json"),"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;secrets={GATEWAY_STATE_SECRET:randomBytes(32).toString("base64url"),GATEWAY_ADMIN_USERNAME:"admin",GATEWAY_ADMIN_PASSWORD:randomBytes(24).toString("base64url")};await save(path.join(directory,"secrets.json"),secrets);}
    const config=JSON.parse(await readFile(path.join(root,"wrangler.jsonc"),"utf8"));
    config.name=name;config.account_id=accountId;config.main=path.join(root,config.main);config.vars.PUBLIC_ORIGIN=origin;
    config.containers[0].image=path.join(root,"cloudflare.Dockerfile");config.containers[0].image_build_context=root;
    config.containers[0].authorized_keys=[{name:"gateway-authorization",public_key:(await readFile(key+".pub","utf8")).trim()}];
    await save(configPath,config);await save(path.join(directory,"admin.json"),{url:origin,username:secrets.GATEWAY_ADMIN_USERNAME,password:secrets.GATEWAY_ADMIN_PASSWORD});
    console.log("Prepared new Cloudflare deployment: "+name+"\nAccount: "+accountId+"\nPublic URL: "+origin+"\nAdministrator credentials: "+path.join(directory,"admin.json"));
  }else{
    const config=JSON.parse(await readFile(configPath,"utf8"));
    if(command==="check")await run(wrangler,["deploy","--dry-run","--config",configPath,"--outdir",path.join(root,".wrangler","dry-run")]);
    else if(command==="deploy"){
      await run(wrangler,["deploy","--config",configPath]);
      await run(wrangler,["secret","bulk",path.join(directory,"secrets.json"),"--config",configPath]);
      console.log("Deployment uploaded. Check "+config.vars.PUBLIC_ORIGIN+"/healthz after container provisioning completes.");
    }else if(command==="authorize"){
      const instance=option("--instance");if(!instance||!/^[\w-]{1,128}$/.test(instance))throw new Error("Use authorize --instance <running Cloudflare container instance ID>");
      console.log("Keep this connection open, then visit http://127.0.0.1:18787/ to authorize accounts.");
      const proxy=quote(wrangler)+" --config "+quote(configPath)+" containers ssh %h --stdio";
      const warm=setInterval(()=>fetch(config.vars.PUBLIC_ORIGIN+"/healthz",{signal:AbortSignal.timeout(15000)}).catch(()=>{}),60000);warm.unref();
      try{await run("ssh",["-N","-o","ExitOnForwardFailure=yes","-o","StrictHostKeyChecking=accept-new","-o","UserKnownHostsFile="+path.join(directory,"known_hosts"),"-o","ProxyCommand="+proxy,"-i",path.join(directory,"ssh-key"),"-L","127.0.0.1:18787:127.0.0.1:18787","-L","127.0.0.1:1455:127.0.0.1:1455","cloudchamber@"+instance]);}
      finally{clearInterval(warm);}
    }else throw new Error("Unknown command; use prepare, check, deploy or authorize");
  }
}catch(error){console.error(error.message);process.exitCode=1;}
