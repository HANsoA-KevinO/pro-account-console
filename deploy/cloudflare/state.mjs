const files=new Set(["settings.json","management.json","connection.json","quota-state.json","lan-admin.json","usage.json"]);
export const fileName=name=>typeof name==="string"&&(files.has(name)||/^accounts\/account[-\w]*\.json$/.test(name)||/^quota-runtime\/account[-\w]*\/(?:auth\.json|config\.toml)$/.test(name)||/^backups\/[\w-]+\.json$/.test(name));
const deleteName=name=>fileName(name)||/^quota-runtime\/account[-\w]*$/.test(name);
export function owner(binding,name,jurisdiction){
  if(jurisdiction!==undefined&&jurisdiction!=="global"&&jurisdiction!=="us")throw new Error("Unsupported gateway jurisdiction");
  const namespace=jurisdiction==="us"?binding.jurisdiction("us"):binding;
  return namespace.getByName(name,{locationHint:"wnam"});
}
export function stateOperation(storage,payload){
  const query=(sql,args=[])=>{
    if(typeof sql!=="string"||!sql.trim()||sql.length>100000||!Array.isArray(args)||args.length>100||args.some(x=>x!==null&&typeof x!=="string"&&typeof x!=="number"))throw new Error("Invalid statement");
    if(/\b(?:ATTACH|DETACH|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))throw new Error("Unsupported statement");
    const cursor=storage.sql.exec(sql,...args),rows=cursor.toArray();return {rows,changes:cursor.rowsWritten};
  };
  if(payload.action==="sql")return query(payload.sql,payload.args);
  if(payload.action==="batch"){
    if(!Array.isArray(payload.statements)||!payload.statements.length||payload.statements.length>100)throw new Error("Invalid transaction");
    return storage.transactionSync(()=>({results:payload.statements.map(item=>query(item.sql,item.args))}));
  }
  storage.sql.exec("CREATE TABLE IF NOT EXISTS gateway_files (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if(payload.action==="file_list")return {files:storage.sql.exec("SELECT name,value FROM gateway_files ORDER BY name").toArray()};
  if(payload.action==="file_put"){
    if(!fileName(payload.name)||typeof payload.value!=="string"||payload.value.length>2*1024*1024||!/^[-\w+/=]*$/.test(payload.value))throw new Error("Invalid file");
    storage.sql.exec("INSERT OR REPLACE INTO gateway_files VALUES (?,?)",payload.name,payload.value);return {ok:true};
  }
  if(payload.action==="file_delete"){
    if(!deleteName(payload.name))throw new Error("Invalid deletion");
    storage.sql.exec("DELETE FROM gateway_files WHERE name=? OR substr(name,1,?)=?",payload.name,payload.name.length+1,payload.name+"/");return {ok:true};
  }
  throw new Error("Unknown state operation");
}
