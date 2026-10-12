import {mkdir, open, readFile, rename, unlink, chmod, rm} from "node:fs/promises";
import path from "node:path";
import {randomBytes, randomUUID, createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {EventEmitter} from "node:events";
import {PublicError} from "./oauth.mjs";
import {validateSessionId} from "./session.mjs";

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await chmod(path.dirname(file), 0o700);
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.settingsFile = path.join(directory, "settings.json");
    this.authFile = path.join(directory, "connection.json");
    this.usageFile = path.join(directory, "usage.json");
    this.recordQueue = Promise.resolve();
    this.teamFile = path.join(directory, "management.json");
    this.connections = new Map();
    this.managementQueue = Promise.resolve();
    this.quotaQueue = Promise.resolve();
    this.connectionQueues = new Map();
    this.removingAccounts = new Set();
    this.routingCursors = new Map();
    this.events=new EventEmitter();
  }
  async init() {
    this.settings = await readJson(this.settingsFile);
    if (!this.settings) {
      this.settings = {
        hostId: "urn:uuid:" + randomUUID(),
        gatewayKey: "gw_" + randomBytes(32).toString("base64url"),
      };
      await writeJson(this.settingsFile, this.settings);
    }
    this.connection = await readJson(this.authFile);
    this.quotaStates = await readJson(path.join(this.directory,"quota-state.json"),{});
    this.management = await readJson(this.teamFile);
    if (!this.management) {
      this.management = {
        version: 2,
        activeAccountId: "account-default",
        accounts: [{id: "account-default", name: "原有 Pro 账号", enabled: true, maxConcurrent:2, officialSnapshot: null, createdAt: new Date().toISOString()}],
        agents: [{id: "agent-default", name: "默认接入", accountId: "account-default", enabled: true, keyHash: hashKey(this.settings.gatewayKey), keyPrefix: this.settings.gatewayKey.slice(0,10), allowedModels: [], dailyRequests: null, dailyTokenThreshold: null, maxConcurrent: 2, createdAt: new Date().toISOString()}],
      };
      await writeJson(this.teamFile, this.management);
    }
    let routingMigrated = false;
    const previousPool=this.management.routes?.find(rule=>rule.id==="route-default");
    if (this.management.version<4 || this.management.routes?.length!==1 || previousPool?.strategy!=="round_robin" || previousPool?.accountScope!=="all" || previousPool?.keyIds?.length || previousPool?.models?.length || !previousPool?.enabled) {
      await writeJson(path.join(this.directory, "backups", "management-before-global-pool.json"), this.management);
      this.management.routes = [{
        id: "route-default", name: "统一账号池", enabled: true, priority: 1000000,
        keyIds: [], models: [], accountScope: "all", accountIds: [],
        strategy: "round_robin", createdAt: new Date().toISOString(),
      }];
      this.management.version = 4;
      for (const agent of this.management.agents) delete agent.accountId;
      await writeJson(this.teamFile, this.management);
      routingMigrated = true;
    }
    if(this.management.accounts.some(account=>!Object.hasOwn(account,"maxConcurrent"))){
      const next=structuredClone(this.management);
      for(const account of next.accounts)if(!Object.hasOwn(account,"maxConcurrent"))account.maxConcurrent=2;
      await writeJson(this.teamFile,next);this.management=next;
    }
    for(const account of this.management.accounts)validateAccountConcurrency(account.maxConcurrent);
    if(this.management.accounts.some(account=>account.id==="account-default"))this.connections.set("account-default", this.connection);
    else this.connection=null;
    for (const account of this.management.accounts) if (account.id !== "account-default") {
      this.connections.set(account.id, await readJson(this.accountFile(account.id)));
    }
    const databaseFile = path.join(this.directory, "ledger.sqlite");
    const handle = await open(databaseFile, "a", 0o600); await handle.close();
    await chmod(databaseFile, 0o600);
    this.db = new DatabaseSync(databaseFile);
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, time TEXT NOT NULL, day TEXT NOT NULL,
        account_id TEXT NOT NULL, agent_id TEXT, source TEXT NOT NULL,
        model TEXT NOT NULL, status TEXT NOT NULL, input_tokens INTEGER,
        output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
        duration_ms INTEGER, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_time ON requests(time);
      CREATE INDEX IF NOT EXISTS request_account_agent_day ON requests(account_id,agent_id,day);
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY, time TEXT NOT NULL, kind TEXT NOT NULL,
        account_id TEXT, agent_id TEXT, model TEXT, message TEXT NOT NULL,
        details TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY, time TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality (
        id TEXT PRIMARY KEY, time TEXT NOT NULL, account_id TEXT NOT NULL,
        model TEXT NOT NULL, config_hash TEXT NOT NULL, score REAL,
        correct INTEGER NOT NULL, total INTEGER NOT NULL, failures INTEGER NOT NULL,
        baseline INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fingerprints (
        id TEXT PRIMARY KEY, time TEXT NOT NULL, account_id TEXT NOT NULL,
        model TEXT NOT NULL, config_hash TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fingerprint_account_time ON fingerprints(account_id,time);
      CREATE TABLE IF NOT EXISTS session_routes (
        agent_id TEXT NOT NULL, session_hash TEXT NOT NULL,
        account_id TEXT NOT NULL, identity_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,session_hash)
      );
      CREATE INDEX IF NOT EXISTS session_route_account ON session_routes(account_id);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id_hash TEXT PRIMARY KEY, origin TEXT NOT NULL, csrf TEXT NOT NULL,
        expires_at INTEGER NOT NULL, auth_fingerprint TEXT
      );
    `);
    this.db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(Date.now());
    if (!this.management.ledgerMigrated) {
      for (const row of await readJson(this.usageFile, [])) this.recordSync({...row, accountId: "account-default", agentId: "agent-default", source: "agent"});
      this.management.ledgerMigrated = true;
      await writeJson(this.teamFile, this.management);
    }
    for (const row of this.db.prepare("SELECT payload FROM requests WHERE status='pending'").all()) {
      this.recordSync({...JSON.parse(row.payload), status: "interrupted", errorCode: "gateway_restarted"});
    }
    if (routingMigrated) this.audit("global_pool_migrated", {mode: "round_robin_all_accounts", keys: this.management.agents.length});
    if(!this.management.fingerprintMigrated){
      const next=structuredClone(this.management);
      for(const account of next.accounts)if(account.qualityPolicy){account.legacyQualityPolicy=account.qualityPolicy;account.qualityPolicy={...account.qualityPolicy,enabled:false};}
      next.fingerprintMigrated=true;await writeJson(this.teamFile,next);this.management=next;
      this.audit("fingerprint_detection_enabled",{legacyHistoryRetained:true,scheduledDetectionEnabled:false});
    }
    if(!this.management.fingerprintAttributionMigrated){
      const next=structuredClone(this.management);let previousOverrides=0;
      for(const account of next.accounts)if(account.fingerprintPolicy&&Object.hasOwn(account.fingerprintPolicy,"expected")){
        if(account.fingerprintPolicy.expected&&account.fingerprintPolicy.expected!=="auto"){
          account.legacyFingerprintReference=account.fingerprintPolicy.expected;previousOverrides++;
        }
        delete account.fingerprintPolicy.expected;
      }
      next.fingerprintAttributionMigrated=true;await writeJson(this.teamFile,next);this.management=next;
      this.audit("fingerprint_direct_attribution",{previousOverrides,historyRetained:true});
    }
    return this;
  }
  adminSession(id) {
    if(typeof id!=="string"||!/^[-\w]{43}$/.test(id))return null;
    const digest=createHash("sha256").update(id).digest("hex");
    const row=this.db.prepare("SELECT * FROM admin_sessions WHERE id_hash=? AND expires_at>?").get(digest,Date.now());
    return row?{id,origin:row.origin,csrf:row.csrf,expiresAt:row.expires_at,authFingerprint:row.auth_fingerprint}:null;
  }
  saveAdminSession(session) {
    this.db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(Date.now());
    const digest=createHash("sha256").update(session.id).digest("hex");
    this.db.prepare("INSERT OR REPLACE INTO admin_sessions VALUES (?,?,?,?,?)").run(digest,session.origin,session.csrf,session.expiresAt,session.authFingerprint??null);
  }
  async setConnection(value) {
    return this.accountStore("account-default").setConnection(value);
  }
  accountFile(id) {
    if (!this.management.accounts.some(account => account.id === id)) throw new PublicError(404, "account_not_found", "账号不存在。");
    return id === "account-default" ? this.authFile : path.join(this.directory, "accounts", id + ".json");
  }
  accountStore(id) {
    const parent = this;
    const account = parent.getAccount(id);
    return {
      settings: parent.settings,
      get connection() {return parent.connections.get(id) ?? null;},
      async setConnection(value) {
        const operation=(parent.connectionQueues.get(id)||Promise.resolve()).then(async()=>{
          parent.assertAccountAvailable(id);
          await writeJson(parent.accountFile(id), value);
          parent.connections.set(id, value);
          if (id === "account-default") parent.connection = value;
          parent.events.emit("capacity");
        });
        parent.connectionQueues.set(id,operation.catch(()=>{}));
        return operation;
      },
      account,
    };
  }
  getAccount(id) {
    const account = this.management.accounts.find(item => item.id === id);
    if (!account) throw new PublicError(404, "account_not_found", "账号不存在。");
    return account;
  }
  assertAccountAvailable(id) {
    const account=this.getAccount(id);
    if(this.removingAccounts.has(id))throw new PublicError(409,"account_deleting","账号正在删除，请稍后再试。");
    return account;
  }
  accountHasActiveRequests(id) {
    return this.accountConcurrency(id).active>0;
  }
  accountConcurrency(id) {
    const account=this.getAccount(id);
    const active=this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE account_id=? AND status='pending'").get(id).count;
    return {active,limit:account.maxConcurrent,remaining:Math.max(0,account.maxConcurrent-active),saturated:active>=account.maxConcurrent};
  }
  assertAccountCapacity(id) {
    const account=this.assertAccountAvailable(id);
    if(!account.enabled)throw new PublicError(403,"account_disabled","账号已停用。");
    const concurrency=this.accountConcurrency(id);
    if(concurrency.saturated)throw new PublicError(429,"account_concurrency_limit","该账号已达到并发上限（"+concurrency.limit+"），请稍后重试。会话不会自动切换账号。");
    return concurrency;
  }
  reserveAccountRequest(record) {
    const accountId=record.accountId||this.management.activeAccountId;
    const existing=this.db.prepare("SELECT account_id,status FROM requests WHERE id=?").get(record.id);
    // An agent request already owns a slot reserved by admit(). Do not count
    // it a second time when forwarding, including after a limit is lowered.
    if(!existing||existing.status!=="pending"||existing.account_id!==accountId)this.assertAccountCapacity(accountId);
    this.recordSync({...record,accountId});
  }
  async manage(change, action, details = {}) {
    const operation = this.managementQueue.then(async () => {
      const next = structuredClone(this.management);
      const result = await change(next);
      await writeJson(this.teamFile, next);
      this.management = next;
      this.audit(action, details);
      this.events.emit("capacity");
      return result;
    });
    this.managementQueue = operation.catch(() => {});
    return operation;
  }
  async addAccount(name) {
    const account = {id: "account-" + randomUUID(), name: cleanName(name), enabled: true, maxConcurrent:2, officialSnapshot: null, createdAt: new Date().toISOString()};
    await this.manage(next => {next.accounts.push(account);if(!next.activeAccountId)next.activeAccountId=account.id;}, "account_created", {accountId: account.id, name: account.name});
    this.connections.set(account.id, null);
    return account;
  }
  async deleteAccount(id) {
    const account=this.getAccount(id),file=this.accountFile(id),ownsLock=!this.removingAccounts.has(id);
    if(this.accountHasActiveRequests(id))throw new PublicError(409,"account_busy","该账号有请求正在执行，请完成后再删除。");
    if(ownsLock)this.removingAccounts.add(id);
    try {
      await this.connectionQueues.get(id);
      await this.quotaQueue;
      await unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;});
      this.connections.delete(id);
      if(id==="account-default")this.connection=null;
      await rm(path.join(this.directory,"quota-runtime",id),{recursive:true,force:true});
      const quotaOperation=this.quotaQueue.then(async()=>{
        const next={...this.quotaStates};delete next[id];
        await writeJson(path.join(this.directory,"quota-state.json"),next);this.quotaStates=next;
      });
      this.quotaQueue=quotaOperation.catch(()=>{});await quotaOperation;
      await this.manage(next=>{
        const index=next.accounts.findIndex(item=>item.id===id);
        if(index<0)throw new PublicError(404,"account_not_found","账号不存在。");
        next.accounts.splice(index,1);
        next.deletedAccounts??=[];
        next.deletedAccounts.push({id,name:account.name,deletedAt:new Date().toISOString()});
        if(next.activeAccountId===id)next.activeAccountId=next.accounts.find(item=>item.enabled)?.id||next.accounts[0]?.id||null;
      },"account_deleted",{accountId:id,name:account.name,historyRetained:true});
      this.connectionQueues.delete(id);
      return {ok:true};
    } finally {if(ownsLock)this.removingAccounts.delete(id);}
  }
  async updateAccount(id, fields) {
    this.assertAccountAvailable(id);
    return this.manage(next => {
      this.assertAccountAvailable(id);
      const account = next.accounts.find(item => item.id === id);
      if (fields.name !== undefined) account.name = cleanName(fields.name);
      if (fields.enabled !== undefined) {
        if(typeof fields.enabled!=="boolean")throw new PublicError(400,"invalid_enabled","启用状态需要是布尔值。");
        account.enabled = fields.enabled;
      }
      if (fields.officialSnapshot !== undefined) account.officialSnapshot = validateSnapshot(fields.officialSnapshot);
      if (Object.hasOwn(fields,"maxConcurrent")) account.maxConcurrent=validateAccountConcurrency(fields.maxConcurrent);
      return account;
    }, "account_updated", {accountId: id, fields: Object.keys(fields)});
  }
  async selectAccount(id) {
    if (!this.assertAccountAvailable(id).enabled) throw new PublicError(403, "account_disabled", "请先启用该账号。");
    return this.manage(next => {
      this.assertAccountAvailable(id);
      next.activeAccountId = id;
    }, "admin_account_view_changed", {accountId: id});
  }
  async addAgent(fields) {
    const agent = validateAgent(fields);
    const key = "gw_" + randomBytes(32).toString("base64url");
    Object.assign(agent, {id: "agent-" + randomUUID(), keyHash: hashKey(key), keyPrefix: key.slice(0,10), createdAt: new Date().toISOString()});
    await this.manage(next => next.agents.push(agent), "key_created", {agentId: agent.id, name: agent.name});
    return {agent: publicAgent(agent), apiKey: key};
  }
  async updateAgent(id, fields) {
    const previous = this.management.agents.find(item => item.id === id);
    if (!previous) throw new PublicError(404, "agent_not_found", "接入 key 不存在。");
    return this.manage(next => {
      const item = next.agents.find(agent => agent.id === id);
      Object.assign(item, validateAgent({...item, ...fields}));
      return publicAgent(item);
    }, "key_updated", {agentId: id, fields: Object.keys(fields)});
  }
  async rotateAgent(id) {
    if (!this.management.agents.some(agent => agent.id === id)) throw new PublicError(404, "agent_not_found", "接入 key 不存在。");
    const key = "gw_" + randomBytes(32).toString("base64url");
    await this.manage(async next => {
      const item = next.agents.find(agent => agent.id === id);
      item.keyHash = hashKey(key);item.keyPrefix = key.slice(0,10);
      if (id === "agent-default") {
        const settings = {...this.settings, gatewayKey: key};
        await writeJson(this.settingsFile, settings);
        this.settings = settings;
      }
    }, "key_rotated", {agentId: id});
    return {apiKey: key};
  }
  authenticate(header) {
    if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new PublicError(401, "invalid_api_key", "本地接入 key 无效。");
    const digest = hashKey(header.slice(7));
    const agent = this.management.agents.find(item => item.keyHash === digest);
    if (!agent) throw new PublicError(401, "invalid_api_key", "本地接入 key 无效。");
    if (!agent.enabled) throw new PublicError(403, "key_disabled", "该接入 key 已停用。");
    return agent;
  }
  publicRoutes() {
    return [...this.management.routes].sort((a,b)=>a.priority-b.priority || a.createdAt.localeCompare(b.createdAt));
  }
  candidateAccounts(rule) {
    return (rule.accountScope === "all" ? this.management.accounts.map(account=>account.id) : rule.accountIds).filter(id=>!this.removingAccounts.has(id));
  }
  matchingRoute(agent, model) {
    if (agent.allowedModels.length && !agent.allowedModels.includes(model)) throw new PublicError(403,"model_not_allowed","该接入 key 未获准使用这个模型。");
    return this.management.routes[0];
  }
  accountIdentityHash(id) {
    const connection=this.connections.get(id);
    return createHash("sha256").update(JSON.stringify([connection?.subject??null,connection?.client_id??null])).digest("hex");
  }
  sessionAccountId(agentId,sessionId){
    const digest=createHash("sha256").update(JSON.stringify(validateSessionId(sessionId))).digest("hex");
    return this.db.prepare("SELECT account_id FROM session_routes WHERE agent_id=? AND session_hash=?").get(agentId,digest)?.account_id??null;
  }
  resolveRoute(agent, model, {eligible=()=>true,advance=false,notify=false,sessionId=null}={}) {
    const rule=this.matchingRoute(agent,model);
    const sessionHash=sessionId===null?null:createHash("sha256").update(JSON.stringify(validateSessionId(sessionId))).digest("hex");
    if(sessionHash){
      const binding=this.db.prepare("SELECT * FROM session_routes WHERE agent_id=? AND session_hash=?").get(agent.id,sessionHash);
      if(binding){
        const account=this.management.accounts.find(item=>item.id===binding.account_id);
        if(!account?.enabled||this.removingAccounts.has(binding.account_id)||this.accountIdentityHash(binding.account_id)!==binding.identity_hash||!eligible(binding.account_id,model))throw new PublicError(409,"session_account_unavailable","该会话绑定的账号当前不可用或授权身份已改变。请恢复原账号，或由调用端显式开始新会话。");
        if(advance)this.assertAccountCapacity(binding.account_id);
        if(advance)this.db.prepare("UPDATE session_routes SET last_used_at=? WHERE agent_id=? AND session_hash=?").run(new Date().toISOString(),agent.id,sessionHash);
        return {accountId:binding.account_id,routeId:rule.id,routeName:rule.name,routingStrategy:"session_affinity",session_id:sessionId,sessionRouting:"reused"};
      }
    }
    const candidates=this.candidateAccounts(rule).filter(id=>this.getAccount(id).enabled&&eligible(id,model));
    if(!candidates.length){
      if(notify)this.alert("routing_unavailable",null,agent.id,model,"统一账号池当前没有可用账号，请检查启用状态和授权。",{});
      throw new PublicError(503,"route_unavailable","统一账号池没有可用账号，请检查账号启用状态、授权和模型可用性。");
    }
    const cursor=this.routingCursors.get(rule.id)??0;
    const start=rule.strategy==="round_robin"?cursor%candidates.length:0;
    let skipped=0;
    while(advance&&skipped<candidates.length&&this.accountConcurrency(candidates[(start+skipped)%candidates.length]).saturated)skipped++;
    if(skipped===candidates.length)throw new PublicError(429,"account_concurrency_limit","所有可用账号均已达到并发上限，请稍后重试。");
    const accountId=candidates[(start+skipped)%candidates.length];
    if(advance&&sessionHash){
      const time=new Date().toISOString();
      this.db.prepare("INSERT INTO session_routes VALUES (?,?,?,?,?,?)").run(agent.id,sessionHash,accountId,this.accountIdentityHash(accountId),time,time);
    }
    if(advance&&rule.strategy==="round_robin")this.routingCursors.set(rule.id,cursor+skipped+1);
    return {accountId,routeId:rule.id,routeName:rule.name,routingStrategy:rule.strategy,session_id:sessionId,sessionRouting:sessionHash?"assigned":"none"};
  }
  relevantRoutes(agent) {
    return this.publicRoutes();
  }
  async addRoute(fields) {
    throw new PublicError(410,"routing_options_removed","已统一为全局账号池轮询，请在账号池页面启用或停用账号。");
  }
  async updateRoute(id,fields) {
    throw new PublicError(410,"routing_options_removed","账号池采用统一轮询，不再设置独立路由规则。");
  }
  async deleteRoute(id) {
    throw new PublicError(410,"routing_options_removed","统一账号池不使用可删除的路由规则。");
  }
  agentUsage(agent, now = new Date()) {
    const day = localDay(now);
    const row = this.db.prepare("SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) AS tokens, SUM(CASE WHEN (input_tokens IS NULL OR output_tokens IS NULL) AND status NOT IN ('pending','auth_failed') THEN 1 ELSE 0 END) AS missing FROM requests WHERE agent_id=? AND day=? AND status!='auth_failed'").get(agent.id, day);
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE agent_id=? AND status='pending'").get(agent.id).count;
    return {
      day, requests: row.requests, tokens: row.tokens, missingUsage: row.missing ?? 0, active,
      requestsRemaining: agent.dailyRequests === null ? null : Math.max(0, agent.dailyRequests - row.requests),
      tokenThresholdRemaining: agent.dailyTokenThreshold === null ? null : Math.max(0, agent.dailyTokenThreshold - row.tokens),
    };
  }
  admit(agent, model, source = "agent", routingOptions = {}) {
    if (!agent.enabled) throw new PublicError(403, "access_disabled", "接入权限已停用。");
    if (agent.allowedModels.length && !agent.allowedModels.includes(model)) throw new PublicError(403, "model_not_allowed", "该接入 key 未获准使用这个模型。");
    const usage = this.agentUsage(agent);
    let rejection;
    if (agent.dailyRequests !== null && usage.requests >= agent.dailyRequests) rejection = ["local_request_limit", "达到平台设置的每日请求上限。"];
    else if (agent.dailyTokenThreshold !== null && (usage.tokens >= agent.dailyTokenThreshold || usage.missingUsage)) rejection = ["local_token_threshold", usage.missingUsage ? "存在用量未知的请求，请管理员核查后调整阈值。" : "达到平台设置的 token 阈值，已暂停后续请求。"];
    else if (usage.active >= agent.maxConcurrent) rejection = ["local_concurrency_limit", "达到该接入 key 的并发上限。"];
    if (rejection) {
      if (rejection[0] !== "local_concurrency_limit") this.alert("local_limit", null, agent.id, model, rejection[1], {day: usage.day, code: rejection[0]});
      throw new PublicError(429, ...rejection);
    }
    const decision=this.resolveRoute(agent,model,{...routingOptions,advance:true,notify:true});
    const reservation = {id: randomUUID(), time: new Date().toISOString(), ...decision, agentId: agent.id, source, requestedModel: model, status: "pending", usage: null};
    this.reserveAccountRequest(reservation);
    return reservation;
  }
  recordSync(value) {
    const row = {...value, accountId: value.accountId || this.management.activeAccountId, source: value.source || "agent"};
    this.db.prepare("INSERT OR REPLACE INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      row.id, row.time, localDay(new Date(row.time)), row.accountId, row.agentId ?? null, row.source,
      row.requestedModel || "", row.status, row.usage?.input_tokens ?? null, row.usage?.output_tokens ?? null,
      row.usage?.input_tokens_details?.cached_tokens ?? null, row.usage?.output_tokens_details?.reasoning_tokens ?? null,
      row.durationMs ?? null, JSON.stringify(row),
    );
    if(row.status!=="pending")this.events.emit("capacity");
  }
  async record(value) {
    this.recordSync(value);
    if (value.status === "pending") return;
    if (value.modelCheck === "different") this.alert("model_id_difference", value.accountId || this.management.activeAccountId, value.agentId, value.requestedModel, "请求与返回模型标识不同，请核查别名或版本映射。", {requested: value.requestedModel, reported: value.reportedModel, requestId: value.requestId});
    if (["sign_in_required", "plan_permission_required"].includes(value.errorCode)) this.alert("authorization_required", value.accountId, value.agentId, value.requestedModel, "该账号需要重新授权；接入 key 不需要更换。", {code: value.errorCode});
    if (value.errorCode === "subscription_sharing_usage_limit_exceeded") this.alert("official_usage_limit", value.accountId, value.agentId, value.requestedModel, "OpenAI 返回套餐或应用额度限制。无法仅据此判断整个账号额度已用尽。", {});
  }
  get records() {return this.db.prepare("SELECT payload FROM requests ORDER BY time,id").all().map(row => JSON.parse(row.payload));}
  query(filters = {}) {
    const clauses = [], values = [];
    const fields = {accountId: "account_id", agentId: "agent_id", model: "model", status: "status", source: "source",routeId:"json_extract(payload,'$.routeId')",session_id:"json_extract(payload,'$.session_id')"};
    for (const [key, column] of Object.entries(fields)) if (filters[key]) {clauses.push(column + "=?");values.push(filters[key]);}
    for (const key of ["from", "to"]) if (filters[key]) {
      if (!Number.isFinite(Date.parse(filters[key]))) throw new PublicError(400, "invalid_date", "时间筛选无效。");
      clauses.push("time" + (key === "from" ? ">=" : "<=") + "?");values.push(new Date(filters[key]).toISOString());
    }
    return {where: clauses.length ? " WHERE " + clauses.join(" AND ") : "", values};
  }
  report(filters = {}) {
    const {where, values} = this.query(filters);
    const totals = this.db.prepare("SELECT COUNT(*) AS requests, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN (input_tokens IS NULL OR output_tokens IS NULL) AND status!='pending' THEN 1 ELSE 0 END) AS missingUsage, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens, COALESCE(SUM(cached_tokens),0) AS cachedTokens, COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens, AVG(duration_ms) AS averageDurationMs FROM requests" + where).get(...values);
    const grouped = column => this.db.prepare("SELECT " + column + " AS id, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens FROM requests" + where + " GROUP BY " + column).all(...values);
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 30));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const rows = this.db.prepare("SELECT payload FROM requests" + where + " ORDER BY time DESC,id DESC LIMIT ? OFFSET ?").all(...values, limit, offset).map(row => JSON.parse(row.payload));
    return {
      ...totals, completed: totals.completed ?? 0, missingUsage: totals.missingUsage ?? 0,
      scope: "经本网关的已保存请求", officialRemaining: null, records: rows,
      byAccount: grouped("account_id"), byAgent: grouped("agent_id"), byModel: grouped("model"),byRoute:grouped("json_extract(payload,'$.routeId')"),
      daily: this.db.prepare("SELECT day, COUNT(*) AS requests, COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM requests" + where + " GROUP BY day ORDER BY day DESC LIMIT 31").all(...values),
      offset, limit, hasMore: offset + rows.length < totals.requests,
    };
  }
  summary() {return this.report({limit: 12});}
  exportRows(filters) {
    const {where, values} = this.query(filters);
    return this.db.prepare("SELECT payload FROM requests" + where + " ORDER BY time DESC").all(...values).map(row => JSON.parse(row.payload));
  }
  alert(kind, accountId, agentId, model, message, details) {
    const recent = this.db.prepare("SELECT id FROM alerts WHERE kind=? AND account_id IS ? AND agent_id IS ? AND model IS ? AND acknowledged=0 AND time>?").get(kind, accountId ?? null, agentId ?? null, model ?? null, new Date(Date.now()-3600000).toISOString());
    if (recent) return;
    this.db.prepare("INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?,0)").run(randomUUID(), new Date().toISOString(), kind, accountId ?? null, agentId ?? null, model ?? null, message, JSON.stringify(details));
  }
  alerts() {return this.db.prepare("SELECT * FROM alerts ORDER BY acknowledged,time DESC LIMIT 100").all().map(row => ({...row, details: JSON.parse(row.details)}));}
  acknowledge(id) {this.db.prepare("UPDATE alerts SET acknowledged=1 WHERE id=?").run(id);this.audit("alert_acknowledged", {alertId: id});}
  audit(action, details) {this.db.prepare("INSERT INTO audit VALUES (?,?,?,?)").run(randomUUID(), new Date().toISOString(), action, JSON.stringify(details));}
  auditLog() {return this.db.prepare("SELECT * FROM audit ORDER BY time DESC LIMIT 50").all().map(row => ({...row, details: JSON.parse(row.details)}));}
  quotaFor(id) {
    const row = this.db.prepare("SELECT payload FROM requests WHERE account_id=? ORDER BY time DESC LIMIT 20").all(id).map(item => JSON.parse(item.payload)).find(item => item.rateLimits);
    const snapshot = this.getAccount(id).officialSnapshot;
    return {
      officialRemaining: null,
      manualSnapshot: snapshot ? {...snapshot, stale: Date.now()-Date.parse(snapshot.observedAt)>3600000 || !!(snapshot.resetAt && Date.parse(snapshot.resetAt)<Date.now())} : null,
      rateLimits: row?.rateLimits ?? null,
      recentQuotaError: this.db.prepare("SELECT time FROM alerts WHERE account_id=? AND kind='official_usage_limit' ORDER BY time DESC LIMIT 1").get(id)?.time ?? null,
    };
  }
  async saveQuotaState(id,fields) {
    this.assertAccountAvailable(id);
    const operation=this.quotaQueue.then(async()=>{
      this.assertAccountAvailable(id);
      const next={...this.quotaStates,[id]:{...this.quotaStates[id],...fields}};
      await writeJson(path.join(this.directory,"quota-state.json"),next);
      this.quotaStates=next;
    });
    this.quotaQueue=operation.catch(()=>{});return operation;
  }
  publicAgents() {return this.management.agents.map(agent => ({...publicAgent(agent), usage: this.agentUsage(agent)}));}
  close() {this.db?.close();}
}

export const hashKey = value => createHash("sha256").update(value).digest("hex");
export function localDay(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts(date).map(part => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}
function cleanName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) throw new PublicError(400, "invalid_name", "名称需要 1–100 个字符。");
  return value.trim();
}
function validateAccountConcurrency(value) {
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1)throw new PublicError(400,"invalid_account_concurrency","账号并发上限需要是有效的正整数。");
  return value;
}
export function publicAgent(agent) {const {keyHash, ...publicData} = agent;return publicData;}
function validateAgent(fields) {
  if (Object.hasOwn(fields,"accountId"))throw new PublicError(400,"key_account_binding_removed","Key 不绑定账号；账号由全局账号池轮询选择。");
  const positive = (value, max, fallback) => {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || (max !== null && number > max)) throw new PublicError(400, "invalid_limit", "限额需要是有效的正整数。");
    return number;
  };
  if (fields.allowedModels !== undefined && (!Array.isArray(fields.allowedModels) || fields.allowedModels.length > 100 || fields.allowedModels.some(model => typeof model !== "string" || !model.trim() || model.length > 200))) throw new PublicError(400, "invalid_models", "模型名单格式无效。");
  if (fields.enabled !== undefined && typeof fields.enabled !== "boolean") throw new PublicError(400, "invalid_enabled", "启用状态需要是布尔值。");
  return {
    name: cleanName(fields.name), enabled: fields.enabled ?? true,
    allowedModels: [...new Set((fields.allowedModels ?? []).map(model => model.trim()))],
    dailyRequests: positive(fields.dailyRequests, 1000000, null),
    dailyTokenThreshold: positive(fields.dailyTokenThreshold, 1000000000, null),
    maxConcurrent: positive(fields.maxConcurrent, null, 2),
  };
}
function validateSnapshot(value) {
  if (value === null) return null;
  const remainingPercent = Number(value.remainingPercent);
  if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) throw new PublicError(400, "invalid_snapshot", "剩余比例必须为 0–100。");
  if (value.resetAt && !Number.isFinite(Date.parse(value.resetAt))) throw new PublicError(400, "invalid_snapshot", "重置时间无效。");
  return {remainingPercent, resetAt: value.resetAt ? new Date(value.resetAt).toISOString() : null, window: cleanName(value.window || "手动记录"), observedAt: new Date().toISOString(), source: "manual"};
}
