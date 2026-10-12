import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),cli=path.join(root,"node_modules/.bin/wrangler");
try{
  const who=JSON.parse(execFileSync(cli,["whoami","--json"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
  const account=who.accounts?.find(x=>x.name===(process.argv[2]||"MUFY AI"));if(!account)throw new Error("Target Cloudflare account is not present in Wrangler authorization");
  const auth=JSON.parse(execFileSync(cli,["auth","token","--json"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
  if(!["oauth","api_token"].includes(auth.type)||typeof auth.token!=="string")throw new Error("OAuth or API-token authorization is required");
  const api=async route=>{
    const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account.id+route,{headers:{authorization:"Bearer "+auth.token},signal:AbortSignal.timeout(20000)});
    const value=await response.json();if(!response.ok||!value.success)throw new Error("Cloudflare account inspection failed (HTTP "+response.status+")");return value.result;
  };
  const [subdomain,scripts]=await Promise.all([api("/workers/subdomain"),api("/workers/scripts")]);
  console.log(JSON.stringify({account:{id:account.id,name:account.name},workersSubdomain:subdomain.subdomain,existingWorkers:scripts.map(x=>x.id)},null,2));
}catch(error){console.error(error.message.startsWith("Cloudflare")||error.message.startsWith("Target")||error.message.startsWith("OAuth")?error.message:"Could not inspect the Cloudflare account; check Wrangler login and network access.");process.exitCode=1;}
