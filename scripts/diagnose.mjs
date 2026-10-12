import {readJson} from "../lib/storage.mjs";
import {parseSSE} from "../lib/responses.mjs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const settings = await readJson(path.join(process.env.GATEWAY_DATA_DIR || path.join(root, ".data"), "settings.json"));
if (!settings) throw new Error("Start and authorize the gateway before running diagnostics");
const base = "http://127.0.0.1:" + (process.env.GATEWAY_PORT || process.env.GATEWAY_DEMO_PORT || "8787") + "/v1";
const headers = {authorization: "Bearer " + settings.gatewayKey, "content-type": "application/json", accept: "text/event-stream"};
const catalogResponse = await fetch(base + "/models", {headers, signal: AbortSignal.timeout(30000)});
const catalog = await catalogResponse.json();
const model = catalog.data?.[0]?.id;
if (!model) throw new Error("No visible model");
const response = await fetch(base + "/responses", {
  method: "POST", headers,
  body: JSON.stringify({model, input: [{role: "user", content: "请只回复：网关连接成功。"}], store: false, stream: true}),
  signal: AbortSignal.timeout(120000),
});
const events = [];
let text = "";
for await (const event of parseSSE(response.body)) {
  if (event.type === "response.output_text.delta") text += event.delta;
  events.push({
    type: event.type, keys: Object.keys(event), deltaType: typeof event.delta,
    itemType: event.item?.type, itemKeys: event.item ? Object.keys(event.item) : undefined,
    partType: event.part?.type, outputIndex: event.output_index, contentIndex: event.content_index,
    responseKeys: event.response ? Object.keys(event.response) : undefined,
    responseOutput: event.response?.output?.map(item => ({type: item.type, keys: Object.keys(item), contentTypes: item.content?.map(part => part.type)})),
    itemContent: event.item?.content?.map(part => ({type: part.type, keys: Object.keys(part)})),
  });
}
console.log(JSON.stringify({
  modelRequested: model, status: response.status,
  contentType: response.headers.get("content-type"),
  requestId: response.headers.get("x-request-id") || response.headers.get("openai-request-id"),
  outputText: text, events,
}, null, 2));
