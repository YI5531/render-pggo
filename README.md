# Render 免费容器部署指南（PGGO 无头凭证 + Build 反代 + OpenCode 出口中继）

本目录提供针对 **Render Free Web Service (512MB RAM、无持久磁盘)** 定制的轻量级容器方案，一机三用：
1. **PGGO 无头执行器**：内置 `AIStudio2API` 并强制开启 `WAA_BACKEND=go`（纯 Go 虚拟机解算 WAA 签名，不启动 Chromium，常驻内存 `< 80MB`）。
2. **Cloudflare D1 凭证自动恢复**：内置守护进程运行 `pg-node/sync.mjs`（默认开启 `REIMPORT_EXISTING=1`），即使 Render 免费容器重启清空磁盘，也会在启动 3 秒内自动从 Cloudflare D1 拉取加密 Cookie 与浏览器指纹完成无感恢复。
3. **Build 反代 `-build` 通道 & OpenCode `/egress` 换 IP 中继**：
   - 支持直接调用 AIStudio2API 的 `-build` 通道（或在网关配置 `kind = build` 指向本容器）；
   - 提供受令牌保护的 `POST /egress` 端点，供网关在 OpenCode 免费档触发 `429 FreeUsageLimitError` 时借用本容器出口重试。

---

## 1. 部署步骤（Render 控制台）

1. 在 Render 新建 **Web Service**，关联本仓库。
2. 配置项：
   - **Environment**: `Docker`
   - **Dockerfile Path**: `render-pggo/Dockerfile`
   - **Instance Type**: `Free` (512 MB RAM)
3. 环境变量（Environment Variables）：
   | 变量名 | 示例值 | 说明 |
   | --- | --- | --- |
   | `CF_BASE` | `https://你的网关域名.workers.dev` | Cloudflare Worker 网关地址 |
   | `CF_TOKEN` | `yi5531` | 网关主令牌 `ACCESS_KEY`（或 `PG_PULL_TOKEN`） |
   | `WAA_BACKEND` | `go` | 强制使用纯 Go WAA 签名后端（默认已设为 `go`） |
   | `API_KEY` | `yi5531` | 可选，映射为上游 `PROXY_API_KEY`（保护 `/v1/*`；**对外暴露务必设置**） |

---

## 2. 接入网关与自动保活

1. 部署完成后拿到 Render 地址（例如 `https://my-pggo.onrender.com`）。
2. 打开网关控制台 `/stats` → **第三方渠道**，新增：
   - **无头 PGGO 渠道**：类型选 `pggo`，Base URL 填 `https://my-pggo.onrender.com`，密钥填 `API_KEY`。
   - **Build 容器渠道（可选）**：类型选 `build`，Base URL 填 `https://my-pggo.onrender.com`，模型填 `build-gemini-2.5-pro`。
3. **自动保活**：网关的 `*/10 * * * *` Cron 任务会自动扫描所有已启用且 `base_url` 含 `.onrender.com` 的渠道并每 10 分钟请求一次 `/health`，无需手工修改代码即可防止 Render 休眠。
