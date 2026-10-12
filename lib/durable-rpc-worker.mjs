import {parentPort} from "node:worker_threads";

parentPort.on("message",async({url,secret,payload,buffer,timeoutMs})=>{
  const control=new Int32Array(buffer,0,2),bytes=new Uint8Array(buffer,8);
  let result;
  try{
    const response=await fetch(url,{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
    result=await response.json();
    if(!response.ok&&!result.error)result={error:{code:"durable_storage_unavailable"}};
  }catch{result={error:{code:"durable_storage_unavailable"}};}
  let encoded=new TextEncoder().encode(JSON.stringify(result));
  if(encoded.length>bytes.length)encoded=new TextEncoder().encode('{"error":{"code":"durable_result_too_large"}}');
  bytes.set(encoded);Atomics.store(control,1,encoded.length);Atomics.store(control,0,1);Atomics.notify(control,0);
});
