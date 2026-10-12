import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {PublicError, RESOURCE} from "./oauth.mjs";
import {sessionIdFromRequest} from "./session.mjs";

const UNSUPPORTED = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
  "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature",
  "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];
const HOSTED_TOOLS = new Set(["image_generation", "file_search", "code_interpreter", "computer", "computer_use_preview", "mcp", "tool_search", "programmatic_tool_calling"]);

export function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PublicError(400, "invalid_body", "请求体必须是 JSON 对象。");
  sessionIdFromRequest(body);
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200) throw new PublicError(400, "model_required", "请明确指定有效的模型标识。");
  for (const key of UNSUPPORTED) {
    if (Object.hasOwn(body, key)) throw new PublicError(400, "unsupported_parameter", "套餐接口暂不支持参数：" + key);
  }
  if (body.store === true) throw new PublicError(400, "store_not_supported", "此接口要求 store=false。");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new PublicError(400, "invalid_stream", "stream 必须是布尔值。");
  const input = typeof body.input === "string" ? [{role: "user", content: body.input}] : body.input;
  if (!Array.isArray(input) || !input.length) throw new PublicError(400, "input_required", "input 必须包含文字或消息数组。");
  if (input.some(item => item?.role === "system")) throw new PublicError(400, "system_role_not_supported", "请使用 instructions 或 developer 消息。");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new PublicError(400, "invalid_tools", "tools 必须是数组。");
  if (body.tools?.some(tool => HOSTED_TOOLS.has(tool?.type))) throw new PublicError(400, "unsupported_tool", "此套餐接口不支持请求中的托管工具。");
  const {session_id:localSessionId,...upstreamBody}=body;
  return {...upstreamBody, model: body.model.trim(), input, store: false, stream: true};
}

export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = frame => {
    const lines = frame.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return null;
    try {
      const value = JSON.parse(data);
      // SSE's event name is valid even when the JSON payload omits type.
      const name = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
      if (value && typeof value === "object" && !Array.isArray(value) && !value.type && name) value.type = name;
      return value;
    }
    catch { throw new PublicError(502, "invalid_upstream_event", "上游返回了无法解析的流式事件。"); }
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, {stream: true});
    pending = pending.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const event = parse(frame);
      if (event) yield event;
    }
    if (pending.length > 8 * 1024 * 1024) throw new PublicError(502, "upstream_event_too_large", "上游流式事件过大。");
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const event = parse(pending);
    if (event) yield event;
  }
}

function failureStatus(code) {
  if (code === "subscription_sharing_usage_limit_exceeded") return 429;
  if (code?.endsWith("unavailable")) return 503;
  if (code === "subscription_sharing_user_not_eligible") return 403;
  return 502;
}

export async function forwardResponses(body, {oauth, store, res, fetchImpl = fetch, context = {},admissions,signal,validateContext,webSocketPool,httpSessions}) {
  const payload = normalizeRequest(body);
  const streaming = body.stream === true;
  const started = Date.now()-(context.queueWaitMs||0);
  const record = {
    id: randomUUID(), time: new Date().toISOString(), requestedModel: payload.model,
    reportedModel: null, modelCheck: "unavailable", usage: null, status: "pending",
    requestId: null, durationMs: null, errorCode: null,
    firstTokenMs: null, responseId: null, rateLimits: null,
    streamDiagnostics: {upstreamStatus:null,eventCount:0,eventTypes:{},firstEventMs:null,lastEventMs:null,lastEventType:null,lastResponseStatus:null,completedOutputItems:0,terminalEvent:null},
    ...context,
  };
  const controller = new AbortController();
  let timeout,reserved=false,upstreamStarted=false,httpSession=null;
  const cancelWaiting=()=>controller.abort();
  if(signal?.aborted)controller.abort();
  signal?.addEventListener("abort",cancelWaiting,{once:true});
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on("close", disconnected);
  let terminal = null;
  const outputItems = new Map();
  let persisted = false;
  const persist = async () => {
    if (persisted||!reserved) return;
    record.durationMs = Date.now() - started;
    record.modelCheck = !record.reportedModel ? "unavailable" : record.reportedModel === record.requestedModel ? "matching" : "different";
    await store.record(record);
    persisted = true;
  };
  if(context.routeId)res.setHeader?.("x-gateway-route-id",context.routeId);
  if(context.accountId&&context.routeId)res.setHeader?.("x-gateway-account-id",context.accountId);
  if(context.sessionRouting)res.setHeader?.("x-gateway-session-routing",context.sessionRouting);
  try {
    if(admissions){
      Object.assign(record,await admissions.fixed(record,{signal:controller.signal,validate:()=>{
        validateContext?.();
        if(oauth.status&&!oauth.status().sharing)throw new PublicError(401,"sign_in_required","请先完成该账号的模型授权。");
      }}));
    }else if(store.reserveAccountRequest)store.reserveAccountRequest(record);
    else store.recordSync?.(record);
    reserved=true;
    signal?.removeEventListener("abort",cancelWaiting);
    if(controller.signal.aborted)throw new PublicError(499,"request_cancelled","请求已取消。");
    res.setHeader?.("x-gateway-queue-wait-ms",String(record.queueWaitMs||0));
    timeout=setTimeout(()=>controller.abort(),120000);
    let token;
    try {token = await oauth.accessToken();}
    catch (error) {record.status = "auth_failed";throw error;}
    if(controller.signal.aborted)throw new PublicError(499,"request_cancelled","请求已取消。");
    let events;
    if(webSocketPool&&record.session_id&&record.agentId){
      record.upstreamTransport="websocket";
      const upstream=await webSocketPool.open(payload,{token,signal:controller.signal,onSent:()=>{upstreamStarted=true;},reusedSession:record.sessionRouting==="reused",scope:{agentId:record.agentId,accountId:record.accountId,sessionId:record.session_id,model:payload.model,identity:store.accountIdentityHash(record.accountId)}});
      record.upstreamSession=upstream.metadata;record.streamDiagnostics.upstreamStatus=101;events=upstream.events;
      res.setHeader?.("x-gateway-upstream-transport","websocket");res.setHeader?.("x-gateway-upstream-session-mode",upstream.metadata.mode);
      res.setHeader?.("x-gateway-upstream-recovery-attempts",String(upstream.metadata.recoveryAttempts));
    }else{
    record.upstreamTransport="http";res.setHeader?.("x-gateway-upstream-transport","http");
    let sessionHeaders={};
    if(httpSessions&&record.session_id&&record.agentId){
      const upstream=httpSessions.prepare(payload,{token,abort:()=>controller.abort(),scope:{agentId:record.agentId,accountId:record.accountId,sessionId:record.session_id,model:payload.model,identity:store.accountIdentityHash(record.accountId)}});
      httpSession=upstream.request;record.upstreamSession=upstream.metadata;sessionHeaders=upstream.headers;
      res.setHeader?.("x-gateway-upstream-session-mode","full_history");res.setHeader?.("x-gateway-upstream-session-id",upstream.metadata.sessionHeaderId);
      res.setHeader?.("x-gateway-upstream-turn-routing",upstream.metadata.turnRouting);
    }
    upstreamStarted=true;
    const upstream = await fetchImpl(RESOURCE + "/responses", {
      method: "POST",
      headers: {authorization: "Bearer " + token, "content-type": "application/json", accept: "text/event-stream", "x-client-request-id": record.id,...sessionHeaders},
      body: JSON.stringify(payload), signal: controller.signal,
    });
    record.requestId = upstream.headers.get("x-request-id") || upstream.headers.get("openai-request-id");
    if(httpSession)httpSessions.observeHeaders(httpSession,upstream.headers);
    record.streamDiagnostics.upstreamStatus=upstream.status;
    const rates = Object.fromEntries(["limit-requests","limit-tokens","remaining-requests","remaining-tokens","reset-requests","reset-tokens"].map(key => [key, upstream.headers.get("x-ratelimit-" + key)]).filter(([, value]) => value !== null));
    if (Object.keys(rates).length) record.rateLimits = {source: "upstream_headers", observedAt: new Date().toISOString(), values: rates};
    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({error: {code: "upstream_http_error", message: "上游请求失败。"}}));
      record.status = "failed";
      record.errorCode = data.error?.code || "upstream_http_" + upstream.status;
      await persist();
      res.writeHead(upstream.status, {"content-type": "application/json", "cache-control": "no-store"});
      res.end(JSON.stringify(data));
      return;
    }
    const contentType = upstream.headers.get("content-type");
    if (contentType && !contentType.includes("text/event-stream")) throw new PublicError(502, "invalid_upstream_content_type", "上游未返回预期的 SSE 流。");
    events=parseSSE(upstream.body);
    }
    if (streaming) res.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no"});
    for await (const event of events) {
      const trace=record.streamDiagnostics,eventType=typeof event.type==="string"?event.type.slice(0,120):"untyped";
      trace.eventCount++;trace.firstEventMs??=Date.now()-started;trace.lastEventMs=Date.now()-started;trace.lastEventType=eventType;
      if(Object.hasOwn(trace.eventTypes,eventType)||Object.keys(trace.eventTypes).length<48)trace.eventTypes[eventType]=(trace.eventTypes[eventType]||0)+1;
      if(typeof event.response?.status==="string")trace.lastResponseStatus=event.response.status;
      if (event.type === "response.output_text.delta" && record.firstTokenMs === null) record.firstTokenMs = Date.now() - started;
      if (event.response?.id) record.responseId = event.response.id;
      if (event.type === "response.output_item.done" && Number.isInteger(event.output_index) && event.item) {
        outputItems.set(event.output_index, event.item);
        trace.completedOutputItems=outputItems.size;
      }
      // Some upstream streams omit accumulated output from the final snapshot.
      // Reuse completed items from this same response; do not invent output.
      if (event.type === "response.completed" && event.response && !event.response.output?.length && outputItems.size) {
        event.response.output = [...outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
      }
      if (event.response?.model) record.reportedModel = event.response.model;
      if (event.response?.usage) record.usage = event.response.usage;
      if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
        terminal = event;
        trace.terminalEvent=event.type;
        record.status = event.type.split(".")[1];
        record.errorCode = event.response?.error?.code ?? null;
      } else if (event.type === "error") {
        terminal = event;
        trace.terminalEvent=event.type;
        record.status = "failed";
        record.errorCode = event.code || event.error?.code || "upstream_stream_error";
      }
      if (streaming && !res.destroyed) {
        const message = "event: " + (event.type ?? "message") + "\ndata: " + JSON.stringify(event) + "\n\n";
        if (!res.write(message)) await once(res, "drain", {signal: controller.signal});
      }
    }
    if (!terminal) throw new PublicError(502, "stream_incomplete", "流式连接结束，但没有收到完成事件。");
    if(httpSession){httpSessions.finish(httpSession,record.status==="completed"?terminal.response:null);httpSession=null;}
    if (!streaming) {
      if (record.status !== "completed") throw new PublicError(failureStatus(record.errorCode), record.errorCode || "response_incomplete", "上游请求未完成，请查看请求记录。");
      await persist();
      res.writeHead(200, {"content-type": "application/json", "cache-control": "no-store"});
      res.end(JSON.stringify(terminal.response));
    } else {
      await persist();
      res.end();
    }
  } catch (error) {
    if(error.upstreamSession)record.upstreamSession=error.upstreamSession;
    res.gatewayBeforeUpstream=!upstreamStarted;
    if (record.status === "pending" || record.status === "completed") record.status = controller.signal.aborted ? "interrupted" : "failed";
    record.errorCode = error instanceof PublicError ? error.code : controller.signal.aborted ? "request_interrupted" : "upstream_connection_error";
    if(reserved&&!upstreamStarted)record.usage={input_tokens:0,output_tokens:0};
    await persist();
    const message = error instanceof PublicError ? error.message : "上游连接未成功完成，请稍后重试。";
    if (!res.destroyed) {
      if (res.headersSent) {
        res.end("event: error\ndata: " + JSON.stringify({type: "error", code: record.errorCode, message}) + "\n\n");
      } else {
        res.writeHead(error instanceof PublicError ? error.status : 502, {"content-type": "application/json", "cache-control": "no-store"});
        res.end(JSON.stringify({error: {code: record.errorCode, message}}));
      }
    }
  } finally {
    if(httpSession)httpSessions.finish(httpSession);
    clearTimeout(timeout);
    signal?.removeEventListener("abort",cancelWaiting);
    res.off("close", disconnected);
    await persist();
  }
}
