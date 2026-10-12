import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,rm,access} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {DurableDatabaseSync,DurableFiles,durableEndpoint} from "../lib/durable-storage.mjs";
import {Store,writeJson} from "../lib/storage.mjs";
import {owner} from "../deploy/cloudflare/state.mjs";

const secret=createHash("sha256").update("cloudflare-state-test-fixture").digest("base64url");
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),"gateway-cloudflare-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const child=spawn(process.execPath,[new URL("./fixtures/cloudflare-state.mjs",import.meta.url).pathname,path.join(directory,"durable")],{stdio:["ignore","pipe","pipe"]});
  let stderr="";child.stderr.on("data",chunk=>{stderr+=chunk.toString();});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,"exit");child.kill("SIGTERM");await done;}});
  const url=await new Promise((resolve,reject)=>{
    let buffer="";const timer=setTimeout(()=>reject(new Error("Cloudflare test runtime startup timed out: "+stderr.slice(-1000))),20000);
    child.stdout.on("data",chunk=>{buffer+=chunk.toString();for(const line of buffer.split("\n"))try{const item=JSON.parse(line);if(item.url){clearTimeout(timer);resolve(item.url);}}catch{}});
    child.on("exit",code=>{clearTimeout(timer);reject(new Error("Cloudflare test runtime stopped: "+code+" "+stderr.slice(-1500)));});
  });
  const options={url:url+"/__gateway/state",secret,allowLoopback:true,timeoutMs:2000};
  const local=async name=>{const dir=path.join(directory,name);await mkdir(dir);return dir;};
  return {directory,url,options,child,local};
}

test("durable endpoint rejects credentials, paths and non-TLS public hosts",()=>{
  assert.equal(durableEndpoint("https://gateway.example.com/__gateway/state"),"https://gateway.example.com/__gateway/state");
  for(const url of ["http://gateway.example.com/__gateway/state","https://u:p@gateway.example.com/__gateway/state","https://gateway.example.com/","https://gateway.example.com/__gateway/state?token=x"])assert.throws(()=>durableEndpoint(url));
});

test("Cloudflare SQLite and credential files survive a fresh container filesystem",async t=>{
  const f=await fixture(t),directory=await f.local("first"),files=new DurableFiles(f.options),unbind=await files.restore(directory),db=new DurableDatabaseSync(f.options);
  t.after(()=>{db.close();unbind();});
  const store=await new Store(directory,{databaseFactory:()=>db}).init();
  const key=store.settings.gatewayKey,host=store.settings.hostId,account=await store.addAccount("Cloud account");
  await store.accountStore(account.id).setConnection({access_token:"fixture-access",subject:"fixture-user",email:"fixture@example.com",scopes:["chatgpt.tokens.use.direct"]});
  store.db.prepare("INSERT INTO session_routes VALUES (?,?,?,?,?,?)").run("agent-default","fixture-session-hash",account.id,"identity","now","now");
  await store.record({id:"completed",time:new Date().toISOString(),accountId:account.id,requestedModel:"m",status:"completed",usage:{input_tokens:100,output_tokens:5,input_tokens_details:{cached_tokens:80}}});
  await assert.rejects(access(path.join(directory,"ledger.sqlite")));store.close();unbind();
  const fresh=await f.local("second"),remove=await files.restore(fresh),newDb=new DurableDatabaseSync(f.options);t.after(()=>{newDb.close();remove();});
  const recovered=await new Store(fresh,{databaseFactory:()=>newDb}).init();
  assert.equal(recovered.settings.gatewayKey,key);assert.equal(recovered.settings.hostId,host);
  assert.equal(recovered.accountStore(account.id).connection.subject,"fixture-user");assert.equal(recovered.report().cachedTokens,80);
  assert.equal(recovered.db.prepare("SELECT account_id FROM session_routes WHERE session_hash=?").get("fixture-session-hash").account_id,account.id);
  await recovered.deleteAccount(account.id);recovered.close();remove();
  const third=await f.local("third"),removeThird=await files.restore(third);t.after(removeThird);
  await assert.rejects(access(path.join(third,"accounts",account.id+".json")));
});

test("Cloudflare writes in a transaction commit atomically and roll back together",async t=>{
  const f=await fixture(t),db=new DurableDatabaseSync(f.options);t.after(()=>db.close());
  db.exec("CREATE TABLE batch_test (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  db.exec("BEGIN");db.prepare("INSERT INTO batch_test VALUES (?,?)").run("a",1);db.prepare("INSERT INTO batch_test VALUES (?,?)").run("b",2);db.exec("COMMIT");
  assert.equal(db.prepare("SELECT SUM(value) AS n FROM batch_test").get().n,3);
  db.exec("BEGIN");db.prepare("UPDATE batch_test SET value=99 WHERE id=?").run("a");db.prepare("INSERT INTO batch_test VALUES (?,?)").run("b",3);assert.throws(()=>db.exec("COMMIT"));
  assert.equal(db.prepare("SELECT value FROM batch_test WHERE id=?").get("a").value,1);
});

test("private state refuses browser access and path traversal; persistence failure has no local fallback",async t=>{
  const f=await fixture(t),headers={authorization:"Bearer "+secret,"content-type":"application/json"};
  assert.equal((await fetch(f.options.url,{method:"POST",body:'{"action":"file_list"}'})).status,403);
  assert.equal((await fetch(f.options.url,{method:"POST",headers:{...headers,origin:f.url},body:'{"action":"file_list"}'})).status,403);
  assert.equal((await fetch(f.options.url,{headers})).status,403);
  const traversal=await fetch(f.options.url,{method:"POST",headers,body:JSON.stringify({action:"file_put",name:"../settings.json",value:"e30="})});assert.equal(traversal.status,503);
  const files=new DurableFiles(f.options),dir=await f.local("failure"),remove=await files.restore(dir);t.after(remove);
  const exited=once(f.child,"exit");f.child.kill("SIGTERM");await exited;
  await assert.rejects(writeJson(path.join(dir,"settings.json"),{secret:"must-not-save-locally"}),error=>error.code==="durable_storage_unavailable");
  await assert.rejects(readFile(path.join(dir,"settings.json")));
});

test("US state and container selection require a jurisdictional namespace and cannot fall back globally",()=>{
  const calls=[],us={getByName:(name,options)=>{calls.push({name,...options});return "us-owner";}},binding={jurisdiction:scope=>{assert.equal(scope,"us");return us;},getByName:()=>{throw new Error("Global owner was reused");}};
  assert.equal(owner(binding,"gateway-state-v1","us"),"us-owner");assert.equal(owner(binding,"gateway-container-v1","us"),"us-owner");
  assert.deepEqual(calls,[{name:"gateway-state-v1",locationHint:"wnam"},{name:"gateway-container-v1",locationHint:"wnam"}]);
  assert.throws(()=>owner({jurisdiction:()=>{throw new Error("US unavailable");},getByName:()=>"global"},"gateway-state-v1","us"));
  assert.throws(()=>owner(binding,"gateway-state-v1","usa"));
});
