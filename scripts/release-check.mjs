import {execFileSync} from "node:child_process";
import {readFile,readdir,lstat,mkdir,mkdtemp,cp,rm} from "node:fs/promises";
import os from "node:os";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg=JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error("Release version must have three numeric components");
const entries=[...new Set([...pkg.files,"package.json",".dockerignore",".gitignore"])];
const files=[];
async function visit(relative){
  const location=path.join(root,relative),stat=await lstat(location);
  if(stat.isSymbolicLink())throw new Error("Release symlinks are not allowed: "+relative);
  if(stat.isDirectory()){for(const child of await readdir(location))await visit(relative+"/"+child);}
  else if(stat.isFile())files.push({path:relative,size:stat.size});
  else throw new Error("Unsupported release entry: "+relative);
}
for(const item of entries){if(item.startsWith("/")||item.split("/").includes(".."))throw new Error("Invalid release entry");await visit(item.replace(/\/$/,""));}
const forbidden=/(^|\/)(?:\.data|data|reports|backups|secrets|node_modules|\.git|dist)(\/|$)|(?:^|\/)\.env(?:\.|$)(?!example$)|\.(?:sqlite(?:-[^/]*)?|db|pem|key|log)$/i;
const bad=files.filter(file=>forbidden.test(file.path));
if(bad.length)throw new Error("Release contains private/generated paths: "+bad.map(file=>file.path).join(", "));
for(const required of ["server.mjs","lib/upstream-http-session.mjs","lib/runtime.mjs","public/index.html","vendor/modeltrace/LICENSE","vendor/modeltrace/provenance.json","vendor/modeltrace/unified_bank.json","Dockerfile","compose.yaml","deploy/README.md","package-lock.json"]){
  if(!files.some(file=>file.path===required))throw new Error("Missing release file: "+required);
}
let archive=null;
if(process.argv.includes("--build")){
  const temp=await mkdtemp(path.join(os.tmpdir(),"gateway-release-"));
  try{
    const name="pro-account-console-"+pkg.version,stage=path.join(temp,name);
    for(const file of files){const target=path.join(stage,file.path);await mkdir(path.dirname(target),{recursive:true});await cp(path.join(root,file.path),target);}
    await mkdir(path.join(root,"dist"),{recursive:true});archive=path.join(root,"dist",name+".tar.gz");
    execFileSync("tar",["-czf",archive,"-C",temp,name],{stdio:"pipe"});
  }finally{await rm(temp,{recursive:true,force:true});}
}
console.log(JSON.stringify({name:pkg.name,version:pkg.version,files:files.length,unpackedBytes:files.reduce((sum,file)=>sum+file.size,0),privatePaths:0,archive},null,2));
