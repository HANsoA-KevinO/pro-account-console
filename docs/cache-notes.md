# 缓存与 Fast 验证记录

以下为开发阶段的测试记录；文中 `reports/` 原始日志仅保存在本机，未上传到源码仓库。旧的 HTTP 低命中实验没有发送上游 `session-id`，修正后的默认 HTTP/SSE 路由见项目 README 和部署说明。

## 历史实测

网关透传 `service_tier`、`prompt_cache_key`、`prompt_cache_options` 和消息内容块的 `prompt_cache_breakpoint`，不自动开启 Fast，也不改写调用者的缓存设置。Agent 可添加 `"service_tier": "fast"`；是否可用及实际档位由上游决定。终止响应中的 `fast` 或 `priority` 表示 Fast，`default` 表示这次按 Standard 服务，缺失则未确认；不要根据请求成功或耗时缩短推断已生效。

2026-10-10 实测：dev01/dev03 的 `gpt-6-astra` 上，`fast` 返回 400，`priority` 完成但回传 `default`，没有确认启用 Fast。约 4,600 token 的自动缓存试验（完全重复、改尾部、改前缀及换账号，共 8 次）回传 `cached_tokens=0`；只能说明本轮未观察到命中。参数覆盖还返回 `prompt_cache_options is not supported on this model`。报告保存实际请求和回传信息，后续上游能力变化时可重测，不把通用 API 功能当作套餐路线已开放的保证。

2026-10-13 在 Cloudflare 正式部署复测 dev01 的 `gpt-6-astra`，固定账号与会话、65 token 短输入、low 推理、128 个整数输出。Standard 请求回传 `default`，可见输出约 47.5 token/s；`fast` 返回 HTTP 400 / `Unsupported service_tier: fast`；`priority` 完成但仍回传 `default`，约 46.8 token/s。两个完成样本均无排队、无缓存、259 输出 token、0 推理 token。本轮仍未确认 Fast 生效，不能把 `priority` 请求成功视为开启 Fast。调查报告保存在运行机器的 `reports/cloud-fast-research-20261013.json`；报告不包含访问密钥或原始业务对话。

同日云端三次指纹样本约 21～22 可见 token/s，均无排队；它们与上述短输出控样的任务内容和推理设置不同，不能据此计算加速倍率。后台 `/api/status` 的三次查询耗时为 4.2、3.4、2.5 秒。云端兼容层的同步远程 SQLite 查询会等待网络结果，这可能影响主线程处理流式事件；尚未进行隔离对照，不能将全部低 TPS 归因于网关或 Cloudflare。

同日补测其余六个可用模型，dev01/dev03 各自固定会话，low 推理、128 个整数输出：36 次矩阵请求加 6 次顺序对照，共 42 次。12 次 `fast` 均返回 HTTP 400；`priority` 请求完成时仍一律回传 `default`，没有确认官方 Fast 档位。29 次完整样本均无缓存、无排队，且回传模型与请求模型一致。一次 6.1 Sol Standard 顺序对照返回 `server_is_overloaded`，该失败保留在报告中，之后单独补测成功。

| 模型 | Standard 可见 token/s | 请求 priority 后的可见 token/s | 实际回传档位 |
| --- | --- | --- | --- |
| gpt-6.1-sol | 23.4–26.1 | 51.6–53.5 | default |
| gpt-6-sol | 30.2–57.0 | 87.4–88.8 | default |
| gpt-6-luna | 56.9–58.9 | 85.5–86.7 | default |
| gpt-5.6-sol | 40.8–41.5 | 85.9–88.4 | default |
| gpt-5.6-terra | 43.0–44.6 | 42.6–54.7 | default |
| gpt-5.6-luna | 59.7–66.4 | 58.2–88.5 | default |

`priority` 的实际速度效果与“官方 Fast 档位是否确认”应分别表述：5.6 Sol 在反向顺序对照中 priority 为 86.5、随后 Standard 为 41.5 token/s；6.1 Sol 的后续 Standard 为 23.4，而 priority 样本约 52；6 Sol 后续 Standard 为 57，而 priority 约 88。这为部分模型的 priority 提速提供了小样本线索，但没有稳定倍率、真实 Agent 工作负载或额度消耗倍率的验证。不能仅凭回传 default 断言参数完全没有速度影响，也不能把更快的输出标成官方 Fast 已生效。5.6 Terra/Luna 的样本未显示稳定收益。本次仅调查，不修改网关默认档位。

完整矩阵、顺序对照和汇总保存在运行机器 `reports/cloud-fast-model-matrix-20261013.json`、`reports/cloud-fast-order-control-20261013.json`、`reports/cloud-fast-default-recheck-20261013.json`、`reports/cloud-fast-model-summary-20261013.json`；不含接入密钥或原始业务对话。

随后对 Astra 补做 priority / Standard / Standard / priority 的四次交替顺序对照，复用原来的账号、会话、输入和 low 推理。四次均完整完成、无排队、无缓存，回传模型均为 `gpt-6-astra`；priority 为 66.3、65.3 token/s，Standard 为 31.5、34.2 token/s，均值之比约 2.0。Astra 上最初的 47.5 / 46.8 两个样本不足以否定后续的提速线索；本轮观察到了明显收益，但实际档位仍全部回传 default，仍不能标为官方 Fast 已确认，也不能保证真实 Agent 或其它时段同样提速。报告为运行机器 `reports/cloud-fast-astra-order-control-20261013.json`，没有修改生产默认档位。

2026-10-12 Sci-Pegasus 真实 Agent 场景：首次两轮请求成功、缓存均为 0；用户回答澄清问题后的下一轮发生 `stream_incomplete`。同账号、同 session 的受控复测收到 `response.completed`，输入 13,142 token，其中 12,928 为缓存 token（98.4%）。这说明该接入能观察到实际缓存命中，不应把较早的零命中样本解释为缓存被禁用。复测只检查模型流，不执行返回的工具。

同日进一步单独测试内容块 `prompt_cache_breakpoint`（未发送 `prompt_cache_options`），上游返回 `400 invalid_parameter`，`error.param=prompt_cache_breakpoint`，提示当前模型不支持。通用 OpenAI API 文档描述 GPT-5.6 及以后支持显式与隐式缓存，但此处的 Pro 授权路线对当前 `gpt-6-astra` 实测拒绝两种显式配置字段；当前仅自动缓存已确认可用。首次两轮正常调用为零命中，98.4% 来自随后受控重放，不能混称为正常多轮命中率。

当日自动缓存复测 18 次全部完成：dev03 合成新上下文/重放/工具结果及用户消息追加共 8 次，dev01 相同合成前缀共 4 次，dev01 原始真实请求重放 3 次，均回传零命中。真实请求增加固定 `prompt_cache_key` 的 3 次回传依次为 0、13,056、0 缓存 token（输入均 13,142），非零样本约 99.3%。各组固定账号和 session，全部缓存值已与网关账本逐条核对。可观察到自动缓存，但复用不稳定；不能把单次非零归因于 cache key 或当作业务命中率保证。详见 `reports/auto-cache-comparison-20261012.json`；样本包含首次请求及改前缀负对照，18 次总体比例不是日常业务命中率。

请求详情的 `streamDiagnostics` 记录上游 HTTP 状态、事件数量/类型、首末事件时间、最后 response 状态、完成输出项数量和终止事件，不保存模型文本或工具参数。未收到终止事件仍明确返回 `stream_incomplete`，不把已生成部分内容当作成功，也不自动换账号重试。SSE JSON 缺少 `type` 时使用其明确的 `event:` 名称，避免遗漏合法终止/错误事件。

测试脚本默认只展示方案，添加 `--run` 才调用模型并消耗账号额度：

```bash
npm run benchmark -- fast
npm run benchmark -- fast --run --model gpt-6-astra --pairs 3
npm run benchmark -- fast --run --fast-tier priority --pairs 3
npm run benchmark -- cache
npm run benchmark -- cache --run --model gpt-6-astra
```

默认读取本地网关 key，不输出凭据；也可用 `GATEWAY_BENCHMARK_URL` / `GATEWAY_BENCHMARK_KEY` 指定网关和 key。报告保存在 `reports/`，每次独立 runId，每个样本完成即保存；失败停止后续请求，不隐藏重试。无需重启服务或改动账号池。记录实际账号、会话分配、模型与档位、排队时间、输入/缓存/缓存写入/输出/推理 token、文本首字和输出时间。

- Fast：默认 3 对、6 次串行请求，短输入、256 个整数输出、固定推理 low；Standard/Fast 交替改变先后顺序，同一对输入一致，同一 `session_id` 固定账号。只对实际档位正确、同账号同模型、零排队且零缓存的完整组计算倍率。输出速度按可见输出 token / 首个至最后一个 delta 时间估算，受 SSE 分块影响；推理用量缺失则显示未知。
- 缓存：默认 8 次串行请求，使用合成长上下文，测上游自动缓存，不传 `prompt_cache_options`。包含首次写入、两次完全重复、两次只改尾部、一次改前缀，以及两次候选跨账号请求。必须核对实际账号确实改变，相同账号时不能算跨账号样本。`--no-cross-account` 省略最后两次，`--lines` 控制资料长度。明确支持缓存覆盖的接入可用 `--cache-mode implicit` / `explicit` / `both`；both 为 14 次，explicit 在稳定 developer 文本末尾放断点。当前实测的 gpt-6-astra 套餐路由返回 `prompt_cache_options is not supported on this model`，因此默认采用自动模式；官方通用 API 文档的功能仍需逐接入确认。
- token 命中率 = 已知样本 `sum(cached_tokens)/sum(input_tokens)`；请求命中率 = `cached_tokens>0` 的已知请求占比。首写与复用分开，缺失 metadata 不当作零。前缀必须达到该模型缓存阈值，首写的实际输入用量需要核对；延迟仅作辅助证据。
- 后续可用 3–5 个新 runId 复测各账号，再加入逐轮追加的对话/工具结果、改 tools/推理设置、等待后重用等真实 agent 场景。保持其它变量不变。跨账号与保留时间结果只适用于实际测试的账号、模型、时间和接入方式。

依据：[Fast 参数与实际档位](https://developers.openai.com/api/docs/guides/fast-mode)、[Codex Fast 可用性与额度消耗](https://learn.chatgpt.com/docs/agent-configuration/speed)、[缓存阈值与断点](https://developers.openai.com/api/docs/guides/prompt-caching)、[套餐接入限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。API 价格不直接推算成 Pro 剩余额度，官方额度仍通过独立读取显示。

账号并发名额在出队执行时同步预留，流式请求一直占用到连接完成或中断；成功、失败、授权失败和断开连接都会释放名额。调低上限不取消已在执行的请求，后续按新值调度。手动指纹检测和管理员测试也会排队，取消等待中的检测会立即退出队列；定期检测遇到满额会推迟到后续检查。模型列表和额度同步不占模型并发名额；其他客户端直接使用该账号的请求不在本网关统计范围内。

队列按先到先执行调度，受限于各账号/key的可用名额；一个满额账号不会阻塞其他可用账号。新会话等待期间不提前绑定账号，出队时选取可用账号。同一会话的后续请求仍使用既定账号。

排队期间不调用模型、不占并发名额，也不计入已执行用量。客户端断开或取消即退出；出队前重新检查 key、权限、账号状态与绑定身份。每日请求/token限额仍明确拒绝，不靠排队绕过。默认最多等待 5 分钟，超时返回 `504 queue_wait_timeout`；模型执行的 120 秒超时从出队后开始计算，Agent 的 HTTP 超时应覆盖排队和执行时间。可用 `GATEWAY_QUEUE_WAIT_MS` 设置等待毫秒数。

页面显示总排队数和各账号已绑定/固定账号的等待数；尚未分配账号的新会话计入总队列。日志详情、CSV 和 `x-gateway-queue-wait-ms` 响应头记录实际排队耗时。等待中的请求体仅在内存中，服务停止会取消队列并返回 `503 gateway_stopping`，重启不自动重放模型请求。


## HTTP 会话标识与真实工具验证

2026-10-12 的 12 次合成纯 HTTP 对照中，固定上游会话头的两次重复输入分别命中 95.2%，只填写请求体缓存键或每次更换会话头的组均为零。另三轮每次独立提交完整历史、未填写请求体缓存键的对话，后两轮合计命中 94.4%。此前真实研究的低命中 HTTP 样本缺少此请求头，不能据此认为 HTTP 本身不能稳定复用缓存。详见 `reports/codex-http-caching-findings-20261012.json`。依据：[官方 HTTP/SSE 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)、[Codex 会话与缓存亲和性源码](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/core/src/client.rs#L575-L596)。

同日正式部署后，Sci-Pegasus 使用原有地址和 Key 的 Write → Read → Write 工具流程共 4 次模型请求全部完成。首次缓存为零，后续三次分别命中 97.2%、98.2%、97.3%，后续输入加权合计 97.5%，包括首次输入的整体比例为 73.4%。账本与客户端用量逐条一致，同账号、同上游会话 UUID，三次工具续接均回传本轮路由状态，每次仍提交完整历史。131 项模拟回归全部通过。报告：`reports/http-session-deployment-20261012.json`。这是有界工具流程验证，不是长时间业务命中率保证。


2026-10-12 的较早真实单 Agent 研究中，同账号、相同初始输入和工具定义，未发送上游 `session-id` 的 HTTP 17 次请求整体 token 命中率为 0.79%；持久 WebSocket 16 次为 89.23%，15 次续接全部命中。省略缓存键与填固定键的 WebSocket 小对照均约 94.9%。这些旧 HTTP 数据未包含本次补齐的会话请求头，不代表修正后的 HTTP 命中率。依据：[连接内续接及恢复](https://developers.openai.com/api/docs/guides/websocket-mode)、[套餐接入限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
