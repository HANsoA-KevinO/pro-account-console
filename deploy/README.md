# 部署 Pro Account Console

发布版本 `0.12.0`，使用一个 Node.js 进程和一个持久化数据目录。
默认上游为 HTTP/SSE，按 Key 和账号隔离稳定的会话标识。

## 本机运行

需要 Node.js 22.13 或更新版本，推荐与镜像一致的 Node.js 24。

```sh
npm ci
npm start
```

本机界面为 `http://127.0.0.1:8787/`。局域网模式使用 `npm run start:lan`。
这两种模式继续使用 `.data/`，兼容原有运行目录。

## Linux 服务器：Docker Compose

需要 Docker Engine 和 Compose 插件。镜像包含 Node.js 24 和固定版本的
官方 Codex CLI 0.159.2，用于独立的账号额度读取。

```sh
cp .env.example .env
docker compose up --build -d
docker compose ps
```

Compose 使用 Linux host 网络，网关和 Codex 授权回调均监听服务器回环地址。
网关默认端口 8787，Codex 浏览器授权通常使用 1455。
Docker Desktop 的 host 网络支持取决于本机配置；在 macOS 本机开发时直接运行 Node。

账号授权、接入 Key、SQLite 用量和管理员凭据保存于 `gateway-data` 命名卷，
容器更新不会清空数据。`docker compose down -v` 会删除该卷，请勿用于普通更新。
同一运行目录只运行一个网关实例，不配置多个副本共享额度授权或刷新令牌。

首次启动自动生成管理员用户名和随机密码，保存于
`/var/lib/pro-account-console/lan-admin.json`，文件权限为 0600。
在自己的终端读取凭据：

```sh
docker compose exec gateway cat /var/lib/pro-account-console/lan-admin.json
```

修改此文件并保存即可更换管理员凭据，已有管理会话会失效；接入 Key 不变。
应用启动日志只显示凭据文件位置，不打印密码。

## 在服务器添加账号

OpenAI 的 Sign in with ChatGPT 流程要求 HTTP 回环回调，不能把首次登录改成公网域名回调。
在自己的电脑建立 SSH 转发，转发端口需与服务器监听端口一致：

```sh
ssh -N -L 8787:127.0.0.1:8787 -L 1455:127.0.0.1:1455 user@server
```

保持 SSH 运行，打开 `http://127.0.0.1:8787/`，输入服务器管理员凭据。
逐个添加并授权模型账号，再为同一账号连接独立 Codex 额度授权。
如果本机已运行另一个网关，先停止它，或为服务器设置另一网关端口并同步修改转发端口。
Codex 如果提示改用另一个回调端口，需要转发授权页面显示的那个端口。

首次授权完成后，正常调用按需续期；需要重新授权时仍使用此转发流程。
新部署默认没有本机电脑上的账号和 Key，源码与镜像均不携带这些数据。
官方说明：[注册与回环授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、
[账号、续期与凭据存储](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)。

## 配置 HTTPS 线上入口

完成域名、证书和反向代理配置后，在 `.env` 中设置：

```dotenv
GATEWAY_PUBLIC_URL=https://gateway.example.com
```

使用 `nginx.conf.example` 作为模板，替换域名、证书路径和上游端口，再重建容器：

```sh
docker compose up --build -d
```

管理员页面和静态资源需要管理员凭据或有效会话 Cookie；HTTPS Cookie 带有 Secure、
HttpOnly、SameSite=Strict。`/v1/*` 继续使用独立接入 Key。
应用只接受配置的 Host 和同源请求，不信任任意 `X-Forwarded-Host`。
反向代理需要关闭响应缓冲和缓存，读取超时应覆盖排队与推理时间。
线上页面可管理已有账号；首次模型与额度授权仍通过回环地址进行。

成员接入形式为：

```text
Base URL: https://gateway.example.com/v1
API Key: 管理后台创建的接入 Key
API: POST /responses
```

同一对话每次携带稳定的 `session_id`，提交完整历史和原始 Responses 输出项。
不同对话使用不同 ID。管理员密码、OpenAI 令牌和接入 Key 各自独立。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `GATEWAY_PORT` | `8787` | 网关监听与回环回调端口；兼容旧 `GATEWAY_DEMO_PORT` |
| `GATEWAY_DATA_DIR` | 项目 `.data/` | 持久化目录；镜像使用 `/var/lib/pro-account-console` |
| `GATEWAY_BIND_HOST` | `127.0.0.1` | 允许 `127.0.0.1` 或 `0.0.0.0` |
| `GATEWAY_PUBLIC_URL` | 未设置 | 配置的 HTTPS 访问源，无路径、查询和用户名密码 |
| `GATEWAY_REQUIRE_ADMIN` | 本机默认 false | 强制管理员验证；服务器、非回环监听或公网配置总是强制开启 |
| `GATEWAY_UPSTREAM_SESSION_TRANSPORT` | `http` | `http` 或明确启用 `websocket` |
| `GATEWAY_QUEUE_WAIT_MS` | `300000` | 队列等待超时；正整数毫秒 |
| `GATEWAY_CODEX_BIN` | 自动查找 | 独立额度读取使用的 Codex CLI 路径 |

直接使用 Node 部署时：

```sh
cp .env.example .env
npm ci --omit=dev
npm run start:server
```

通过 systemd 或已有进程管理器运行一个实例。无需外部数据库。
日志输出到标准输出，凭据和数据库存放于配置的数据目录。

## 检查、更新和备份

`GET /healthz` 用于探测进程，未登录账号时 `connected` 可以为 false，HTTP 200 仍表示进程就绪。
管理员状态页、使用日志和导出 CSV 可查看真实账号、会话、缓存 token 与 HTTP 工具续接状态。

更新代码后先运行验证，再部署：

```sh
npm ci
npm test
npm run release:check
docker compose up --build -d
```

备份需要覆盖整个运行目录。等待模型请求和额度授权流程结束，停止网关后复制命名卷内容：

```sh
mkdir -p backups
docker compose stop gateway
docker compose cp gateway:/var/lib/pro-account-console ./backups/runtime
docker compose start gateway
```

备份包含账号凭据和 Key，保留所有者权限并存放在受保护的位置。
恢复时先停止网关，将备份完整放回原命名卷，确认文件属于容器的 node 用户，再启动。
不要同时运行两个实例使用同一组会轮换的刷新令牌。

## 发布源码包

```sh
npm run release:check
npm run release:build
```

输出 `dist/pro-account-console-0.12.0.tar.gz`，包含部署、测试和固定依赖锁文件。
发布脚本只收集 `package.json` 的白名单文件，并拒绝凭据目录、日志、数据库和符号链接。
Git、Docker 构建上下文和源码包均排除 `.data/`、`reports/`、`.env` 和生成文件。
ModelTrace 原始许可证和来源记录一同保留。
