# Pro Account Console

多个已授权 Pro 账号的 Responses 网关与管理控制台。一个接入 Key 可以使用统一账号池；同一对话固定账号，账号和 Key 分别管理并发与用量。

**支持 Linux 服务器部署和公网 HTTPS 访问，也支持本机与局域网运行。** 服务器部署后，管理员通过域名管理账号，Agent 使用公网 Base URL + 接入 Key 调用模型。

## 主要功能

- 多账号独立授权、启用、停用、删除，统一轮询可用账号。
- 接入 Key 独立设置模型权限、每日请求限额、token 阈值和并发。
- 账号并发控制、超限排队、同会话串行与持久账号绑定。
- HTTP/SSE Responses 接口，稳定上游会话标识和完整历史提交。
- 全量用量日志、缓存统计、筛选、CSV 导出和操作审计。
- 每账号独立 Codex 额度读取，以及 ModelTrace 指纹排序和疑似差异提醒。

## 部署到服务器并通过公网使用

需要 Linux 服务器、Docker Engine/Compose，以及指向服务器的域名和 HTTPS 证书。
当前版本为 `0.12.0`，镜像包含 Node.js 24 和用于额度读取的 Codex CLI 0.159.2。

### 1. 获取源码并配置访问域名

私有仓库使用有访问权限的 GitHub 账号拉取：

```sh
git clone https://github.com/HANsoA-KevinO/pro-account-console.git
cd pro-account-console
cp .env.example .env
```

在 `.env` 中设置实际域名：

```dotenv
GATEWAY_PUBLIC_URL=https://gateway.example.com
```

### 2. 启动网关并配置 HTTPS 入口

```sh
docker compose up --build -d
docker compose ps
```

参考 [Nginx 模板](deploy/nginx.conf.example)，替换域名、证书路径和上游端口，配置 Nginx 并开放服务器 443 端口。Nginx 的域名必须与 `GATEWAY_PUBLIC_URL` 一致，SSE 转发需关闭响应缓冲和缓存。

默认 Compose 让网关监听服务器的 `127.0.0.1:8787`。公网用户访问 HTTPS 域名，由同一服务器上的 Nginx 转发到这个内部地址，因此公网访问不需要直接开放 8787 端口。

### 3. 登录管理后台

首次启动生成管理员用户名和随机密码，在自己的服务器终端读取：

```sh
docker compose exec gateway cat /var/lib/pro-account-console/lan-admin.json
```

完成 HTTPS 配置后，管理后台为 `https://gateway.example.com/`。管理员登录后可管理账号、接入 Key、额度、日志和指纹检测；Agent 调用使用独立的接入 Key。

账号数据、Key、日志和管理员凭据保存在 Docker 命名卷中，重建容器后保留。完整配置、更新与备份步骤见 [服务器部署说明](deploy/README.md)。

## 首次账号授权

首次连接 OpenAI 账号和独立 Codex 额度读取时，需要在浏览器完成回环授权。服务器部署时，在自己的电脑建立转发：

```sh
ssh -N -L 8787:127.0.0.1:8787 -L 1455:127.0.0.1:1455 user@server
```

保持 SSH 运行，打开 `http://127.0.0.1:8787/`，使用服务器管理员凭据：

1. 添加账号并完成模型授权。
2. 需要查看官方 Codex 限额时，为同一账号连接独立额度授权。
3. 创建接入 Key，配置模型权限与使用限额。

**日常后台管理和模型调用直接使用公网域名，无需一直保持 SSH 连接。** 需要重新授权时再开启转发。回调端口、端口冲突和授权流程详见 [首次账号授权](deploy/README.md#首次账号授权)。

## Agent 接入

| 配置项 | 服务器部署示例 |
| --- | --- |
| Base URL | `https://gateway.example.com/v1` |
| API Key | 管理后台创建的接入 Key |
| 接口 | `POST /v1/responses` |
| 模型 | 从 `GET /v1/models` 返回的可用模型中选择 |

示例请求，替换域名和接入 Key；模型需在当前账号池与 Key 权限中可用：

```sh
export GATEWAY_API_KEY='替换为管理后台创建的接入 Key'
curl -N https://gateway.example.com/v1/responses \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-astra","session_id":"chat-123","input":[{"role":"user","content":"你好"}],"stream":true}'
```

同一对话的后续提问与工具调用复用 `session_id`，并提交完整历史及原始 Responses 输出项。新对话生成新 ID。账号绑定和缓存路由由网关处理；调用者无需填写 `prompt_cache_key`。协议与错误行为见 [会话与缓存](docs/sessions.md)。

## 本机与局域网运行

直接运行需要 Node.js 22.13 或更新版本，推荐 Node.js 24：

```sh
npm ci
npm start
```

本机界面为 `http://127.0.0.1:8787/`。同一局域网的设备访问使用 `npm run start:lan`，终端会显示局域网地址。直接用 Node 运行服务器模式及环境变量见 [部署说明](deploy/README.md#直接使用-node-运行)。

## 文档与验证

- [服务器部署](deploy/README.md)：公网入口、首次授权、环境变量、更新和备份。
- [功能与运维](docs/operations.md)：账号池、Key、额度、使用日志和指纹提醒。
- [会话与缓存](docs/sessions.md)：账号绑定、HTTP 工具续接及可选 WebSocket。
- [缓存与 Fast 验证记录](docs/cache-notes.md)：开发实验和结果边界。
- [第三方来源与许可](THIRD_PARTY_NOTICES.md)：ModelTrace 与运行依赖说明。

```sh
npm test
npm run release:check
```

测试使用临时目录和模拟上游，不请求真实模型。源码、镜像和发布包排除账号凭据、Key、数据库与研究日志。真实连接测试可运行 `npm run smoke`，会消耗所选账号额度。

## 官方接入说明

项目已实现服务器与公网访问能力。OpenAI 的指南给出了自托管 VM 的账号 host 示例；对于向用户提供的付费或远程托管应用，指南要求先申请接入。接入资格以官方授权范围为准，参见 [host 与客户端](https://developers.openai.com/siwc/token-sharing-open-source)、[接入范围](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt#usage-policy-and-terms)。

授权使用 HTTP 回环回调，见 [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。当前 Pro 路线的参数和模型能力见 [接口限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
