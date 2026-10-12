import {randomBytes, createHash, timingSafeEqual} from "node:crypto";
import {createRemoteJWKSet, jwtVerify} from "jose";

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export class PublicError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function verifyIdentity(token, clientId, nonce, jwks) {
  const {payload} = await jwtVerify(token, jwks, {
    issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
    algorithms: ["RS256", "ES256"],
  });
  if (typeof payload.sub !== "string" || !payload.sub || payload.nonce !== nonce) {
    throw new PublicError(401, "invalid_identity", "登录身份校验失败，请重新登录。");
  }
  return payload;
}

export class OAuth {
  constructor(store, {redirectUri, fetchImpl = fetch} = {}) {
    this.store = store;
    this.redirectUri = redirectUri;
    this.fetch = fetchImpl;
    this.pending = new Map();
    this.refreshing = null;
    this.loginError = null;
  }
  async metadata() {
    if (!this.discovery) {
      const response = await this.fetch(ISSUER + "/.well-known/openid-configuration", {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new PublicError(502, "discovery_failed", "无法读取 OpenAI 登录配置，请稍后重试。");
      const data = await response.json();
      if (data.issuer !== ISSUER) throw new PublicError(502, "invalid_issuer", "授权服务身份不符合预期。");
      for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri", "revocation_endpoint"]) {
        if (data[field] && new URL(data[field]).origin !== ISSUER) throw new PublicError(502, "invalid_endpoint", "授权服务地址不符合预期。");
      }
      if (!data.authorization_endpoint || !data.token_endpoint || !data.jwks_uri) throw new PublicError(502, "discovery_incomplete", "授权配置缺少必需字段。");
      this.discovery = data;
      this.jwks = createRemoteJWKSet(new URL(data.jwks_uri));
    }
    return this.discovery;
  }
  async start() {
    const metadata = await this.metadata();
    const now = Date.now();
    for (const [state, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(state);
    const random = () => randomBytes(32).toString("base64url");
    const transaction = {
      state: random(), nonce: random(), verifier: random(), browser: random(),
      expiresAt: now + 10 * 60 * 1000,
      clientId: this.store.connection?.client_id ?? null,
      subject: this.store.connection?.subject ?? null,
    };
    this.pending.set(transaction.state, transaction);
    const query = new URLSearchParams({
      client_id: transaction.clientId || "dynamic_agent_client",
      ext_agent_host_id: this.store.settings.hostId,
      response_type: "code", redirect_uri: this.redirectUri, scope: SCOPES,
      resource: RESOURCE, state: transaction.state, nonce: transaction.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(transaction.verifier).digest("base64url"),
    });
    if (!transaction.clientId) query.set("agent_name_hint", "Agent Gateway Demo");
    this.loginError = null;
    return {url: metadata.authorization_endpoint + "?" + query.toString(), browser: transaction.browser};
  }
  consume(parameters, browser) {
    const state = parameters.get("state");
    const transaction = this.pending.get(state);
    this.pending.delete(state);
    if (!transaction || transaction.expiresAt <= Date.now() || !safeEqual(browser, transaction.browser)) {
      throw new PublicError(400, "invalid_state", "登录回调无效或已过期，请从 demo 页面重新登录。");
    }
    if (parameters.has("error")) throw new PublicError(400, "authorization_declined", "登录或套餐授权未完成，请重新授权。");
    const code = parameters.get("code");
    const clientId = parameters.get("client_id") || transaction.clientId;
    if (!code || !clientId || clientId === "dynamic_agent_client") {
      throw new PublicError(400, "registration_incomplete", "授权回调缺少授权码或注册 client_id。");
    }
    if (transaction.clientId && clientId !== transaction.clientId) {
      throw new PublicError(400, "client_changed", "授权回调的应用注册与原连接不一致。");
    }
    return {transaction, code, clientId};
  }
  async tokenRequest(fields) {
    const metadata = await this.metadata();
    const response = await this.fetch(metadata.token_endpoint, {
      method: "POST", headers: {"content-type": "application/x-www-form-urlencoded", accept: "application/json"},
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : "token_exchange_failed";
      const error = new PublicError(502, code, "OpenAI 令牌交换失败，请重新登录或稍后重试。");
      error.tokenCode = code;
      throw error;
    }
    return body;
  }
  async callback(parameters, browser) {
    try {
      const {transaction, code, clientId} = this.consume(parameters, browser);
      if (!transaction.clientId) await this.store.setConnection({client_id: clientId});
      const tokens = await this.tokenRequest({
        grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: transaction.verifier, redirect_uri: this.redirectUri, resource: RESOURCE,
      });
      if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
        throw new PublicError(401, "missing_tokens", "授权结果缺少所需令牌，请确认已授予套餐调用权限。");
      }
      const identity = await verifyIdentity(tokens.id_token, clientId, transaction.nonce, this.jwks);
      if (transaction.subject && identity.sub !== transaction.subject) throw new PublicError(401, "account_changed", "返回的账号与原连接不一致。");
      if (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new PublicError(401, "invalid_expiry", "授权令牌有效期无效。");
      const scopes = String(tokens.scope ?? "").split(/\s+/);
      await this.store.setConnection({
        client_id: clientId, subject: identity.sub, email: identity.email ?? null,
        access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token,
        expires_at: Date.now() + tokens.expires_in * 1000, scopes,
      });
      if (!scopes.includes("chatgpt.tokens.use.direct")) this.loginError = "账号已登录，但没有套餐调用权限。";
    } catch (error) {
      this.loginError = error instanceof PublicError ? error.message : "登录验证失败，请重新登录。";
      throw error;
    }
  }
  status() {
    const auth = this.store.connection;
    return {
      connected: !!auth?.access_token,
      sharing: !!auth?.access_token && !!auth.scopes?.includes("chatgpt.tokens.use.direct"),
      email: auth?.email ?? null,
      expiresAt: auth?.expires_at ?? null,
      error: this.loginError,
    };
  }
  async accessToken() {
    const auth = this.store.connection;
    if (!auth?.access_token) throw new PublicError(401, "sign_in_required", "请先在 demo 页面完成 ChatGPT 登录。");
    if (!auth.scopes?.includes("chatgpt.tokens.use.direct")) throw new PublicError(403, "plan_permission_required", "尚未授予 ChatGPT 套餐调用权限。");
    if (auth.expires_at > Date.now() + 60000) return auth.access_token;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async refresh() {
    const auth = this.store.connection;
    try {
      const tokens = await this.tokenRequest({
        grant_type: "refresh_token", client_id: auth.client_id,
        refresh_token: auth.refresh_token, resource: RESOURCE,
      });
      if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new PublicError(502, "invalid_refresh", "续期结果缺少必需信息，请重新登录。");
      const next = {
        ...auth, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope === undefined ? auth.scopes : String(tokens.scope).split(/\s+/),
        id_token: tokens.id_token || auth.id_token,
      };
      await this.store.setConnection(next);
      if (!next.scopes.includes("chatgpt.tokens.use.direct")) throw new PublicError(403, "plan_permission_required", "套餐调用权限已不再有效。");
      return next.access_token;
    } catch (error) {
      if (TERMINAL_REFRESH.has(error.tokenCode)) {
        await this.store.setConnection({client_id: auth.client_id, subject: auth.subject, email: auth.email});
        throw new PublicError(401, "sign_in_required", "授权已失效，请重新登录。");
      }
      throw error;
    }
  }
  async logout() {
    const auth = this.store.connection;
    let remoteRevoked = !auth?.refresh_token;
    if (auth?.refresh_token) {
      try {
        const metadata = await this.metadata();
        if (metadata.revocation_endpoint) {
          const response = await this.fetch(metadata.revocation_endpoint, {
            method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"},
            body: new URLSearchParams({token: auth.refresh_token, token_type_hint: "refresh_token", client_id: auth.client_id}),
            signal: AbortSignal.timeout(15000),
          });
          remoteRevoked = response.ok;
        }
      } catch {}
    }
    await this.store.setConnection(auth ? {client_id: auth.client_id, subject: auth.subject, email: auth.email} : null);
    this.pending.clear();
    this.loginError = remoteRevoked ? null : "本地已断开；远程撤销未确认，可在 ChatGPT 设置中断开应用。";
    return {remoteRevoked};
  }
}
