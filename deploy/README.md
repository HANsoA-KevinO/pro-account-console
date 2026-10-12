# 服务器部署说明

Pro Account Console 支持 Linux 服务器部署、公网 HTTPS 后台和公网 Responses API。
部署使用一个网关进程和一个持久化数据目录，默认上游为 HTTP/SSE。

## 公网访问与授权入口

| 操作 | 地址或方式 |
| --- | --- |
| 日常管理账号、Key、额度和日志 | `https://gateway.example.com/`，管理员登录 |
| Agent 调用模型 | `https://gateway.example.com/v1` + 接入 Key |
| 首次模型授权、独立 Codex 额度授权、重新授权 | SSH 转发后访问 `http://127.0.0.1:8787/` |

Compose 中的 `127.0.0.1:8787` 是同机 Nginx 的内部上游地址。
Nginx 在服务器 443 端口接收公网 HTTPS 请求，再转发给网关。
日常访问可跨网络进行；SSH 只在上述授权操作期间需要。

## Linux Docker Compose 部署

准备 Docker Engine、Compose 插件、指向服务器的域名，以及该域名的 HTTPS 证书。
服务器还需能访问 OpenAI 的授权与 API 服务。私有仓库使用有访问权限的 GitHub 账号拉取：

```sh
git clone https://github.com/HANsoA-KevinO/pro-account-console.git
cd pro-account-console
cp .env.example .env
```

编辑 `.env`，设置实际 HTTPS 访问源：

```dotenv
GATEWAY_PUBLIC_URL=https://gateway.example.com
```

此值只包含协议、域名和可选端口，无路径、查询参数或用户名密码。
默认网关端口为 8787，如需改动，配置 `GATEWAY_PORT` 并同步调整代理上游及 SSH 转发。

```sh
docker compose up --build -d
docker compose ps
```

镜像包含 Node.js 24 和 Codex CLI 0.159.2，CLI 用于独立额度读取。
Compose 使用 Linux host 网络，网关监听服务器回环地址，Codex 授权回调通常监听 1455。
在 macOS 本机开发时直接运行 Node；Docker Desktop 的 host 网络需要额外的本机支持配置。

## 配置 Nginx 与 HTTPS

使用 [Nginx 模板](nginx.conf.example)，替换：

- `server_name` 和 `proxy_set_header Host` 为实际域名，与 `GATEWAY_PUBLIC_URL` 对应。
- `ssl_certificate`、`ssl_certificate_key` 为有效证书的实际路径。
- `proxy_pass` 端口为实际网关端口，默认 `http://127.0.0.1:8787`。

模板用于同一服务器上的 Nginx。将配置纳入现有站点配置，校验后加载：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

服务器防火墙和云安全组允许 443 端口。模板使用已有证书；若证书签发工具需要 80 端口验证，再按该工具要求配置。
保留 `proxy_buffering off`、`proxy_cache off` 和 500 秒超时，以支持 SSE 和排队后的推理。
修改 `GATEWAY_PUBLIC_URL` 后重新创建网关容器：

```sh
docker compose up -d
curl --fail https://gateway.example.com/healthz
```

`ok:true` 表示进程就绪；尚无已授权账号时 `connected:false` 属于正常状态。
该检查确认域名、HTTPS 和网关连接，不执行模型请求。

## 管理员登录与数据目录

首次启动自动生成管理员用户名和随机密码，保存于
`/var/lib/pro-account-console/lan-admin.json`，文件权限为 0600。在自己的服务器终端读取：

```sh
docker compose exec gateway cat /var/lib/pro-account-console/lan-admin.json
```

打开 `https://gateway.example.com/`，使用管理员凭据登录。
管理员页面和静态资源需要管理员验证及会话 Cookie；HTTPS Cookie 带有 Secure、HttpOnly、SameSite=Strict。
`/v1/*` 使用独立的 Bearer 接入 Key。凭据文件沿用历史名称 `lan-admin.json`，同样用于服务器模式。
修改该文件后即时生效，旧管理员会话失效，接入 Key 不变。

账号授权、Key、SQLite 用量和额度读取状态均保存在 `gateway-data` 命名卷中。
更新或重建容器保留此卷；`docker compose down -v` 会删除数据。
同一运行目录使用一个网关实例，避免多个实例同时刷新同一组轮换令牌。

## 首次账号授权

当前模型授权使用 OpenAI 的 HTTP 回环回调；首次登录和重新授权从回环地址启动。
在自己的电脑执行：

```sh
ssh -N -L 8787:127.0.0.1:8787 -L 1455:127.0.0.1:1455 user@server
```

保持 SSH 连接，打开 `http://127.0.0.1:8787/`，使用服务器管理员凭据：

1. 添加账号并完成模型授权。
2. 如需查看官方 Codex 限额，为同一账号完成独立额度读取授权。
3. 创建接入 Key，设置模型权限、限额和并发。

完成后可断开 SSH，通过公网域名管理和调用。正常模型调用按需续期；需要重新授权时再开启转发。
新部署不含开发电脑上的账号或 Key，需在服务器运行环境完成授权。

如果自己的电脑上已有网关占用 8787，先停止该本机网关，或为服务器设置另一个端口并按同端口转发。
如果 Codex 提示另一回调端口，转发授权页面实际显示的端口。
模型回调使用 `127.0.0.1`，不要替换为 `localhost` 或公网域名。
官方说明见 [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。

## Agent 接入

```text
Base URL: https://gateway.example.com/v1
API Key: 管理后台创建的接入 Key
```

提供 `GET /v1/models`、`POST /v1/responses` 和 `GET /v1/usage`。
同一对话每轮携带稳定的 `session_id`，提交完整历史及原始 Responses 输出项。
更多协议说明见 [会话与缓存](../docs/sessions.md)。

## 直接使用 Node 运行

需要 Node.js 22.13 或更新版本，推荐 Node.js 24。若需额度读取，还需在该服务器安装 Codex CLI，或配置 `GATEWAY_CODEX_BIN`。

```sh
cp .env.example .env
npm ci --omit=dev
npm run start:server
```

使用 systemd 或现有进程管理器运行一个实例。该方式采用 `.env` 中的 `GATEWAY_DATA_DIR=./data`。
Nginx、公网访问和 SSH 授权步骤与上文相同。
普通本机运行使用 `npm start`，数据默认存放于项目 `.data/`；局域网运行使用 `npm run start:lan`。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `GATEWAY_PUBLIC_URL` | 实际 HTTPS 访问源；Compose 从 `.env` 读取 |
| `GATEWAY_PORT` | 网关与模型回调端口，默认 8787；兼容旧 `GATEWAY_DEMO_PORT` |
| `GATEWAY_DATA_DIR` | 直接 Node 的数据目录；Compose 固定挂载到 `/var/lib/pro-account-console` |
| `GATEWAY_BIND_HOST` | 直接 Node 允许 127.0.0.1 或 0.0.0.0；默认 Compose 固定为 127.0.0.1，由同机代理提供公网入口 |
| `GATEWAY_REQUIRE_ADMIN` | 服务器模式、公网配置或非回环监听强制管理员验证；Compose 固定为 true |
| `GATEWAY_UPSTREAM_SESSION_TRANSPORT` | 默认 http；可明确选择 websocket |
| `GATEWAY_QUEUE_WAIT_MS` | 默认 300000，排队等待的正整数毫秒超时 |
| `GATEWAY_CODEX_BIN` | 直接 Node 的 CLI 路径；镜像已配置内置 CLI |

## 更新与备份

拉取更新、核对配置并重建容器：

```sh
git pull --ff-only
docker compose up --build -d
docker compose ps
```

等待模型请求和额度授权流程结束，停止网关后备份整个运行目录：

```sh
mkdir -p backups
docker compose stop gateway
docker compose cp gateway:/var/lib/pro-account-console ./backups/runtime
docker compose start gateway
```

备份包含账号凭据和 Key，保持所有者权限并存放在受保护的位置。
恢复时停止网关，将完整备份放回原命名卷，确认文件属于容器的 node 用户，再启动。

## 检查与源码发布包

```sh
npm ci
npm test
npm run release:check
npm run release:build
```

源码包输出至 `dist/`，包含锁文件、测试和部署说明。
Git、镜像和发布包排除运行凭据、数据库、研究日志与 `.env`；ModelTrace 许可证和来源记录保留。
官方接入范围见 [项目首页](../README.md#官方接入说明)，运行功能详见 [功能与运维](../docs/operations.md)。
