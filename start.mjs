#!/usr/bin/env node
/**
 * Render 免费容器统一入口（start.mjs）：
 *  1. 在 127.0.0.1:2048 启动 AIStudio2API（强制 WAA_BACKEND=go 纯 Go 虚拟机签名，免 Chromium，内存 < 80MB）；
 *  2. 后台周期运行 pg-node/sync.mjs，容器每次冷启动或唤醒时自动从 Cloudflare D1 拉取加密 Cookie + 指纹恢复账号；
 *  3. 对外监听 Render 分配的 PORT（默认 10000）：
 *     - GET /health：健康探针（供 Render 存活检查与 Cloudflare Worker 每 10 分钟 Cron 保活）；
 *     - POST /egress：受令牌保护的透明出口中继（供 OpenCode 免费档 429 换 IP 重试）；
 *     - /v1/* 与 /v1beta/*：反向代理至内部 127.0.0.1:2048（承载 pggo- 模型与 -build 通道）。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { Readable } from "node:stream";

const PUBLIC_PORT = Number(process.env.PORT) || 10000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT) || 2048;
const INTERNAL_BASE = `http://127.0.0.1:${INTERNAL_PORT}`;
const CF_BASE = String(process.env.CF_BASE || "").trim().replace(/\/+$/, "");
const CF_TOKEN = String(process.env.CF_TOKEN || process.env.ACCESS_KEY || "").trim();

function startAiStudio2Api() {
  // 环境变量名对照上游 .env.example / internal/config/config.go 核对：
  // 监听地址是 LISTEN_ADDR（不是 HOST/PORT），API 密钥是 PROXY_API_KEY，账户目录 AISTUDIO_AUTH_STATES，
  // 没有 DATA_DIR；工作目录即数据目录（/data，容器重启清空，由 sync.mjs 从 D1 重新导入）。
  const env = {
    ...process.env,
    LISTEN_ADDR: `127.0.0.1:${INTERNAL_PORT}`,
    PROXY_API_KEY: process.env.PROXY_API_KEY || process.env.API_KEY || "",
    WAA_BACKEND: process.env.WAA_BACKEND || "go",
    UPSTREAM_CHANNELS: process.env.UPSTREAM_CHANNELS || "playground,build",
    BUILD_NATIVE_NONSTREAM: process.env.BUILD_NATIVE_NONSTREAM || "true",
    ADMIN_AUTH_ENABLED: "false",
    AUTO_START: "true",
  };
  console.log(`[render-pggo] 启动 aistudio2api (${env.LISTEN_ADDR}, WAA_BACKEND=${env.WAA_BACKEND})`);
  const child = spawn("aistudio2api", ["-open-ui=false"], { env, cwd: "/data", stdio: "inherit" });
  child.on("exit", (code) => {
    console.error(`[render-pggo] aistudio2api 退出 (code=${code})，3s 后重启`);
    setTimeout(startAiStudio2Api, 3000);
  });
}

function startSyncWorker() {
  if (!CF_BASE || !CF_TOKEN) {
    console.warn("[render-pggo] 未配置 CF_BASE / CF_TOKEN，跳过 D1 Cookie 自动同步");
    return;
  }
  const env = {
    ...process.env,
    CF_BASE,
    CF_TOKEN,
    AISTUDIO_BASE: INTERNAL_BASE,
    REIMPORT_EXISTING: "1",
    POLL_MS: process.env.POLL_MS || "60000",
    SYNC_STATE: "/tmp/.sync-state.json",
  };
  console.log(`[render-pggo] 启动 D1 凭证同步守护进程 (CF_BASE=${CF_BASE})`);
  const child = spawn(process.execPath, ["/app/pg-node/sync.mjs"], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    console.error(`[render-pggo] sync.mjs 退出 (code=${code})，5s 后重启`);
    setTimeout(startSyncWorker, 5000);
  });
}

async function handleEgress(req, res) {
  const token = String(req.headers["x-egress-token"] || "").trim();
  if (CF_TOKEN && token !== CF_TOKEN) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized_egress" }));
    return;
  }
  const target = String(req.headers["x-egress-target"] || "").trim();
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_x_egress_target" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);

  const forwardHeaders = {};
  const skip = new Set([
    "host", "connection", "content-length",
    "x-egress-target", "x-egress-token", "x-egress-no-redirect",
  ]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (skip.has(k.toLowerCase()) || v === undefined) continue;
    forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }

  // 跳转交给调用方判断：Google 的 /sorry 反滥用页会形成
  // gemini.google.com/app → www.google.com/sorry → app?google_abuse=… 的循环，
  // 中继自己 follow 只会拿到最后一页或者 "Too many redirects"。
  const noRedirect = String(req.headers["x-egress-no-redirect"] || "") === "1";

  try {
    const upstream = await fetch(target, {
      method: req.method || "POST",
      headers: forwardHeaders,
      body: bodyBuf.length ? bodyBuf : undefined,
      redirect: noRedirect ? "manual" : "follow",
    });
    const outHeaders = { "x-egress-via": "render-pggo" };
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-encoding" || k.toLowerCase() === "transfer-encoding") return;
      outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message || e) }));
  }
}

// 只放行上游的公开数据面路由（router.go：/v1/、/v1beta/、/upload/、/media/）。
// 控制面 /api/* 由上游按「RemoteAddr 与 Host 均为回环」放行；本代理从 127.0.0.1 转发且改写 Host，
// 若不白名单，外部就能借此直通 /api/accounts 等管理接口——这里必须拦住。
const PUBLIC_PREFIXES = ["/v1/", "/v1beta/", "/upload/", "/media/"];

function proxyToInternal(req, res) {
  const path = String(req.url || "");
  if (!PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: "aistudio2api starting: " + err.message } }));
  });
  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (url === "/health" || url.startsWith("/health?")) {
    // 顺带异步自检：若 aistudio2api 处于 STOPPED 状态且已有账号，自动拉起服务
    fetch(`${INTERNAL_BASE}/api/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        if (st && !st.running && st.state === "STOPPED" && st.accounts?.total > 0) {
          return fetch(`${INTERNAL_BASE}/api/control/start`, { method: "POST" });
        }
      })
      .catch(() => {});
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "render-pggo", uptime: Math.round(process.uptime()), ts: Date.now() }));
    return;
  }
  if (req.method === "POST" && (url === "/start" || url === "/control/start" || url === "/api/control/start")) {
    const token = String(req.headers.authorization || req.headers["x-api-key"] || "").replace(/^Bearer\s+/i, "").trim();
    if (CF_TOKEN && token !== CF_TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: INTERNAL_PORT,
      path: "/api/control/start",
      method: "POST",
      headers: { host: `127.0.0.1:${INTERNAL_PORT}` }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    proxyReq.end();
    return;
  }
  // GET/HEAD 也要放行：Robin 的网页会话要 GET gemini.google.com/app，
  // 只收 POST 时这条链路走不了中继。body 为空就当 GET 转发。
  if ((req.method === "POST" || req.method === "GET" || req.method === "HEAD") && url === "/egress") {
    handleEgress(req, res);
    return;
  }
  proxyToInternal(req, res);
});

startAiStudio2Api();
setTimeout(startSyncWorker, 2500);

server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`[render-pggo] 对外网关已监听 0.0.0.0:${PUBLIC_PORT}`);
});
