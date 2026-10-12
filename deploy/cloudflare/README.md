# Cloudflare 全托管部署

网关、管理页面和额度读取进程运行在 Cloudflare Containers；Worker 提供公网 HTTPS 入口，两个 SQLite Durable Objects 分别管理容器生命周期和持久化数据。
电脑只在构建上传镜像、首次账号授权或重新授权时需要参与。日常模型调用使用公网地址。

## 准备账号和工具

需要 Cloudflare Workers Paid、本机 Node.js 和正在运行的 Docker。Workers Paid 基础费用为每月 5 美元，容器、Durable Objects 等超出包含额度的用量另计，见 [Containers 价格](https://developers.cloudflare.com/containers/platform/pricing/)。

```sh
npm ci
npm run cloudflare:login
npm run cloudflare:whoami
```

浏览器完成 OAuth 授权后，核对 CLI 的账户列表。网页控制台和 CLI 必须选中同一个目标账户。
部署工具固定为 Wrangler 4.149.0，登录凭据使用系统钥匙串。

## 创建独立部署配置

先选一个尚未使用的 Worker 名称，例如 `pro-account-console`，并在 Workers 和 Pages 的账户详情中找到自己的 `workers.dev` 子域。
以下示例中的账户 ID 和子域需要替换为实际值：

```sh
npm run cloudflare:prepare -- \
  --account-id YOUR_ACCOUNT_ID \
  --public-url https://pro-account-console.YOUR_SUBDOMAIN.workers.dev
npm run cloudflare:check
npm run cloudflare:deploy
```

`prepare` 创建 `.data/cloudflare/` 中的私有运行配置、独立管理员凭据、状态服务密钥和专用 SSH 密钥。重新执行会保留已生成的凭据。
`check` 本地构建容器镜像并校验 Worker，不上传云资源。
`deploy` 创建 Worker、两个 Durable Object 命名空间和一个容器应用，再上传 Worker Secrets。首次上传和容器准备可能需要几分钟。

本地配置包含 `account_id`，部署明确使用该账户。初次部署前核对名称，避免与已有 Worker 重名。更新同一部署使用原配置执行 `npm run cloudflare:deploy`。

## 管理员登录与就绪检查

```sh
curl --fail https://pro-account-console.YOUR_SUBDOMAIN.workers.dev/healthz
```

`ok:true` 表示网关就绪。初始部署没有已授权的 OpenAI 账号，`connected:false` 属于正常状态。
管理员用户名和密码保存在本机 `.data/cloudflare/admin.json`，以 0600 权限创建。打开公网首页，输入这份独立凭据。

后台与 Responses 接口共享域名：

```text
后台：https://pro-account-console.YOUR_SUBDOMAIN.workers.dev/
Base URL：https://pro-account-console.YOUR_SUBDOMAIN.workers.dev/v1
API Key：管理后台创建的接入 Key
```

管理员凭据、Agent Key 和内部状态服务密钥分别管理。内部状态入口需要独立服务密钥，并拒绝带浏览器 Origin 的请求。源代码、构建上下文和发布包均排除 `.data/`、Wrangler 本地状态及运行凭据。

## 首次 OpenAI 授权

模型授权和独立 Codex 额度授权仍使用 HTTP 回环回调。通过 Cloudflare 的 Wrangler SSH 通道把本机端口转发到运行中的容器。
先访问公网 `/healthz` 使容器启动，再查看容器实例：

```sh
npx wrangler --config .data/cloudflare/wrangler.jsonc containers list
npx wrangler --config .data/cloudflare/wrangler.jsonc containers instances YOUR_APPLICATION_ID
```

先从应用列表找到当前网关应用的 ID，再查询该应用的运行实例。找到实例 ID 后，保持以下命令运行：

```sh
npm run cloudflare:authorize -- --instance YOUR_INSTANCE_ID
```

在浏览器打开 `http://127.0.0.1:18787/`，使用同一份管理员凭据，添加账号并完成模型授权。需要官方 Codex 限额时，再为同一账号连接独立额度读取授权。
18787 转发到云端网关的相同端口，1455 转发 Codex 登录回调。若本机 1455 已被其他登录流程占用，先完成或取消那个流程，再建立转发。
授权辅助命令运行期间每分钟访问一次公网就绪检查，防止本机授权过程中容器因 owner 不活跃而休眠。云端后台使用独立 Cookie 名称，可与本机网关同时打开。
授权成功后可以结束 SSH；日常后台和 Agent 使用公网地址。账号与额度授权需要逐个完成。

每次容器重建可能产生新的实例 ID，重新授权前重新查询。SSH 通过 Cloudflare 账户认证和专用公钥访问，参考 [官方 SSH 说明](https://developers.cloudflare.com/containers/guides/ssh/)。

## 数据、休眠与流式行为

- 账号配置、模型 OAuth 凭据、管理员配置等 JSON 在确认写入 Durable Object 后才更新容器文件；数据库 SQL 直接执行在 SQLite Durable Object 中。数据存储暂不可用时返回错误。
- Key、完整用量日志、指纹记录和 `session_id` 账号绑定保存在持久数据库中。容器临时磁盘中的文件在启动时从私有状态服务恢复。
- Codex CLI 自己管理的额度授权文件在 RPC 前后、登录通知和后台轮询时同步。后台文件轮询约 1.5 秒；如果 CLI 刚换新凭据就遭遇非正常退出，额度读取可能需要重新授权。
- 同一部署始终路由到一个固定容器 owner，应用最多一个容器实例，保留已有账号池、并发排队和同会话串行行为。
- 容器在 owner 不活跃约 10 分钟后可以休眠，下次请求重新启动。休眠期间不会执行 Node 进程里的定时额度和指纹任务；自动同步在运行期间恢复。冷启动可能增加首次请求耗时。
- 云端 `stream:true` 请求在排队和等待上游期间每 15 秒发送 SSE 注释作为保活。注释不代表模型输出或完成。流已开始后的排队／上游错误通过 SSE `error` 事件返回，包含原始 HTTP 状态。
- 非流式 `stream:false` 仍等待完整 JSON；长等待的 Agent 建议使用流式接口。同一对话携带稳定的 `session_id`，提交完整历史，详见 [会话与缓存](../../docs/sessions.md)。

## 部署配置

跟踪的 `wrangler.jsonc` 是通用模板，实际账户、域名和公钥写入本机 `.data/cloudflare/wrangler.jsonc`。
默认容器为 `basic`，最多一个实例，使用 `us` jurisdiction 与 `WNAM` 区域约束运行于美国西部。两个 Durable Object owner 都使用美国子命名空间，生产主库和容器 owner 位于美国。Worker 的公网入口仍全球分发，见 [容器区域约束](https://developers.cloudflare.com/containers/concepts/placement/) 与 [Durable Objects 数据位置](https://developers.cloudflare.com/durable-objects/reference/data-location/)。
运行镜像使用 Node.js 24、Codex CLI 0.159.2，网关内部监听 18787。
云端启动入口为 `lib/cloudflare-start.mjs`，原有本机和服务器启动方式保留。

使用自己的域名时，先为该 Worker 添加 Custom Domain，再按实际 HTTPS origin 重新执行 `prepare` 并部署。账号数据保留在相同命名空间中；管理员会话按访问 origin 重新登录。
更改 Worker 名称或创建新账户下的部署会产生独立资源，原命名空间的数据不会自动迁移。

持久化数据库支持 Cloudflare 的 SQLite 恢复机制，见 [SQLite Durable Objects 文档](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。删除 Durable Object 命名空间会删除其数据。保留本机专用 SSH 密钥和管理员凭据；需要轮换时更新 Worker Secrets 与对应配置。
