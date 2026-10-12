import {readJson} from "../lib/storage.mjs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const settings = await readJson(path.join(process.env.GATEWAY_DATA_DIR || path.join(root, ".data"), "settings.json"));
if (!settings) throw new Error("请先 npm start，并在浏览器中登录。");
const base = "http://127.0.0.1:" + (process.env.GATEWAY_PORT || process.env.GATEWAY_DEMO_PORT || "8787") + "/v1";
const headers = {authorization: "Bearer " + settings.gatewayKey, "content-type": "application/json"};
const catalogResponse = await fetch(base + "/models", {headers});
const catalog = await catalogResponse.json();
if (!catalogResponse.ok) throw new Error(catalog.error?.message || "模型列表请求失败：" + catalogResponse.status);
const model = process.env.GATEWAY_DEMO_MODEL || catalog.data[0]?.id;
if (!model) throw new Error("没有可用模型。");
const response = await fetch(base + "/responses", {
  method: "POST", headers,
  body: JSON.stringify({model, input: [{role: "user", content: "请只回复：网关连接成功。"}], store: false, stream: false}),
});
const result = await response.json();
if (!response.ok || result.status !== "completed") throw new Error(result.error?.message || "推理未完成。");
const output = (result.output || []).flatMap(item => item.content || []).filter(item => item.type === "output_text").map(item => item.text).join("");
if (!output.trim()) throw new Error("请求完成但没有文本输出，不能确认最小测试成功。");
console.log(JSON.stringify({
  verified: true, modelRequested: model, modelReported: result.model, status: result.status,
  output,
  usage: result.usage ? {input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, total_tokens: result.usage.total_tokens} : null,
}, null, 2));
