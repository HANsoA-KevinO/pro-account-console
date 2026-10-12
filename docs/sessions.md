# 会话与缓存

Agent 在创建对话时生成稳定的 `session_id`，同一对话的后续提问和工具调用续接都复用它，新对话生成新值。例如发送到 `/v1/responses`：

```json
{
  "model": "gpt-6-astra",
  "session_id": "chat-123",
  "input": [{"role": "user", "content": "你好"}],
  "stream": true
}
```

`session_id` 是网关字段，不是 OpenAI 的会话存储参数。网关在转发上游前移除它，并根据 Key 条目、实际账号身份和会话生成稳定的上游 HTTP `session-id`／`thread-id` 请求头。每轮保留调用者提交的完整 `input`、原始 Responses 输出项、工具调用及结果；网关不替调用端保存这些内容。

- 相同接入 key 下的同一 `session_id` 固定到首次选中的账号。不同 key 的相同 ID 分开绑定；轮换同一 key 条目的凭据仍保留绑定。
- 新会话轮询当前可用账号，不带 `session_id` 的请求继续按请求轮询。相同会话的续接不会推进轮询。
- ID 必须是 1–256 字符的非空字符串，不包含控制字符或首尾空格；非法值返回 `400 invalid_session_id`，不会占用额度或创建绑定。
- 绑定保存在 SQLite `session_routes` 表中，不会因重启或空闲自动改绑。账号停用、删除、移除中、授权不可用、模型不可用或登录身份改变时，返回 `409 session_account_unavailable`，不自动切换账号。恢复原账号可继续会话；调用端也可明确开始新会话。
- 上游失败不会触发换号或隐藏重试，原会话绑定保留。模型与 key 的权限、额度及并发检查仍适用。
- 响应头 `x-gateway-account-id` 表示实际账号，`x-gateway-session-routing` 为 `assigned`（首次分配）、`reused`（沿用）或 `none`（无会话标识）。
- 日志详情和 CSV 保存 `session_id` 及分配状态；使用 `/api/usage?session_id=chat-123` 或 `/v1/usage?session_id=chat-123` 可筛选，会话 ID 不会取代每次调用独立的日志 ID。

会话固定有助于保持账号一致，但不保证每轮命中上游缓存，也不替 agent 保存对话内容。

## 默认 HTTP/SSE 会话缓存与工具续接

正式服务默认每轮独立提交完整历史到上游 HTTP/SSE。外部地址与 Key 不变，客户端只需继续携带稳定的 `session_id`。同一 Key 条目、实际账号身份和会话得到同一上游 UUID，重启、令牌刷新或轮换同一 Key 的凭据不会改变它；不同 Key、账号或登录身份分开隔离。缓存命中仍取决于完整渲染前缀、模型设置及上游缓存可用性。

相同会话在已有队列中串行，等待期间不额外占用账号或 Key 的并发位；其他会话按原有并发配置运行。请求体 `prompt_cache_key` 等已有缓存控制字段继续透传，客户端不需要填写缓存键。当前 Pro 路线实测返回的 `prompt_cache_key` 跟随上游 `session-id`，不要将其等同于任意调用者填写的键，也不要将此行为推广到其他 API 路线。

网关接收上游 `x-codex-turn-state` 路由状态。只有下一次完整输入包含上一轮完整输入及原始完整输出、仅追加工具结果，并且参数与授权令牌仍一致时，才将状态原样回传。出现新用户消息、重复或改写历史、设置变化、令牌刷新、流中断或无法确认的续接时重新开始一轮，不将上一轮状态用于整段对话。历史项只保留哈希，路由状态仅在内存中保存，空闲 10 分钟清理，最多保留 128 个已完成会话的状态；这个数量不限制活跃推理并发。

响应头 `x-gateway-upstream-transport=http`、`x-gateway-upstream-session-mode=full_history`、`x-gateway-upstream-session-id` 和 `x-gateway-upstream-turn-routing` 可确认实际路径。日志详情和 CSV 记录上游会话 ID、发送项数、路由状态是否发送／接收、返回缓存键哈希及其是否匹配会话 ID，不保存上游路由状态原文。上游失败、部分流和连接中断不隐藏重试，也不换号。

## 可选 WebSocket 会话续接

明确设置 `GATEWAY_UPSTREAM_SESSION_TRANSPORT=websocket` 后，带 `session_id` 的接入请求使用持久 WebSocket，外部接口仍为 `/v1/responses` 的 HTTP JSON 或 SSE。连接按 Key 条目、实际账号、模型和会话隔离，同会话请求在已有队列中串行；等待期间不会额外占用账号或 Key 的并发位。不同会话继续按配置并发。

Agent 每轮仍提交完整历史，包含原始 Responses 输出项、工具调用与结果。网关检查这些历史是否包含上一轮完整上下文，符合时只向上游发送新增项和内部维护的 `previous_response_id`。历史、工具或推理等设置改变时会发完整上下文建立新响应链，不删除客户端提供的内容。客户端不需要填写 `prompt_cache_key`，已有字段仍透传。

断线、网关重启或令牌刷新后，在原账号用完整历史恢复，首次恢复可能零命中。连接空闲 10 分钟或接近 60 分钟的服务端寿命上限时会清理；内存仅保留上下文哈希，最多优先保留 128 个闲置会话，活跃请求仍由原有并发配置控制。账号或 Key 停用、删除、授权身份改变后，闲置连接会被关闭。未带 `session_id` 的独立请求、管理员连接测试和指纹采样继续使用 HTTP/SSE。

仅当上游首先返回 `previous_response_not_found`、尚未产生任何推理事件时，网关允许一次完整历史恢复；日志中的 `upstreamSession.attempts` 和 `recoveryAttempts` 会记录该过程。连接中断、部分生成和其他模型错误不自动重放，也不自动换号或降回 HTTP。默认传输方式为 `http`，也可用 `GATEWAY_UPSTREAM_SESSION_TRANSPORT=http` 明确指定。

请求详情和 CSV 保存 `upstreamTransport`、连接 ID、续接／恢复方式、父响应 ID、发送项数、恢复次数及返回缓存键哈希。响应头 `x-gateway-upstream-transport` 与 `x-gateway-upstream-session-mode` 可用于确认实际路径。缓存读取仍以原始 `usage.input_tokens_details.cached_tokens` 计量，`prompt_cache_diagnostics.type=unavailable` 不代表缓存未命中。

## 实测记录

缓存与 Fast 的开发实验见 [验证记录](cache-notes.md)。这些样本用于确认可观察到的行为，不构成固定命中率承诺。
