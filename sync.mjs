#!/usr/bin/env node
/**
 * pg-node/sync.mjs —— 把 Cloudflare 上的 AI Studio Cookie 库同步到本机 AIStudio2API。
 *
 * 运行在 PC / Termux，与 Worker 之间只走 HTTPS；本机 ← → AIStudio2API 走 loopback。
 *
 * 环境变量
 *   CF_BASE            必填，Worker 地址，例如 https://cfapi.example.workers.dev
 *   CF_TOKEN           必填，Worker 主令牌（或 PG_PULL_TOKEN）
 *   AISTUDIO_BASE      默认 http://127.0.0.1:2048
 *   AISTUDIO_ADMIN_USER / AISTUDIO_ADMIN_PASSWORD
 *                      可选；AIStudio2API 开了 ADMIN_AUTH_ENABLED=true 时填
 *   ACCOUNT_LABEL      可选；只同步这个 label
 *   PROVIDER_ID        可选；只同步绑定该 pggo 渠道的凭据
 *   POLL_MS            默认 60000
 *   ONESHOT            1 = 跑一轮就退出
 *   REIMPORT_EXISTING  1 = 账户已存在时先 DELETE 再重新导入（默认 0，只告警）
 *   LOCALE / TIMEZONE  默认 zh-CN / Asia/Shanghai
 *   SYNC_STATE         状态文件路径（只存 cookie_hash，不存 Cookie）
 *
 * 安全：本脚本从不打印 Cookie 值；状态文件与日志里只有 label / id / hash 前缀。
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CF_BASE = stripSlash(process.env.CF_BASE || "");
const CF_TOKEN = process.env.CF_TOKEN || "";
const AISTUDIO_BASE = stripSlash(process.env.AISTUDIO_BASE || "http://127.0.0.1:2048");
const ADMIN_USER = process.env.AISTUDIO_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.AISTUDIO_ADMIN_PASSWORD || "";
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || "";
const PROVIDER_ID = process.env.PROVIDER_ID || "";
const POLL_MS = Math.max(5000, Number(process.env.POLL_MS) || 60_000);
const ONESHOT = process.env.ONESHOT === "1";
const REIMPORT_EXISTING = process.env.REIMPORT_EXISTING !== "0";
const LOCALE = process.env.LOCALE || "zh-CN";
const TIMEZONE = process.env.TIMEZONE || "Asia/Shanghai";
const STATE_PATH = process.env.SYNC_STATE || fileURLToPath(new URL("./.sync-state.json", import.meta.url));

if (!CF_BASE || !CF_TOKEN) {
  console.error("[sync] 缺少 CF_BASE / CF_TOKEN。示例：");
  console.error("  CF_BASE=https://xxx.workers.dev CF_TOKEN=yi5531 node pg-node/sync.mjs");
  process.exit(2);
}

let sessionCookie = "";
let stopping = false;

process.on("SIGINT", () => { stopping = true; console.log("\n[sync] 收到 SIGINT，退出"); process.exit(0); });
process.on("SIGTERM", () => { stopping = true; process.exit(0); });

if (process.env.PREFIX?.includes("com.termux")) {
  console.log("[sync] Termux 提示：请先执行 termux-wake-lock，并把 Termux 加入电池白名单");
}

// ==================== 主循环 ====================

async function main() {
  let state = await loadState();
  let backoff = 0;
  while (!stopping) {
    try {
      const credentials = await fetchCredentials();
      const changed = credentials.filter((c) => state[c.id] !== c.cookie_hash);
      if (!changed.length) {
        log(`无变化（${credentials.length} 条凭据）`);
      }
      for (const cred of changed) {
        if (stopping) break;
        try {
          await importCredential(cred);
          state[cred.id] = cred.cookie_hash;
          await saveState(state);
          await reportStatus(cred.id, "ok");
          log(`✔ 导入成功 label=${cred.label || cred.id} hash=${short(cred.cookie_hash)}`);
        } catch (e) {
          await reportStatus(cred.id, "error").catch(() => {});
          console.error(`[sync] ✖ label=${cred.label || cred.id} 导入失败：${e.message}`);
        }
      }
      backoff = 0;
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : POLL_MS, 10 * 60_000);
      console.error(`[sync] 轮询失败：${e.message}${backoff > POLL_MS ? `（${Math.round(backoff / 1000)}s 后重试）` : ""}`);
    }
    if (ONESHOT) return;
    await sleep(backoff || POLL_MS);
  }
}

// ==================== Cloudflare 侧 ====================

async function fetchCredentials() {
  const url = new URL(CF_BASE + "/api/pg/credentials");
  if (PROVIDER_ID) url.searchParams.set("provider_id", PROVIDER_ID);
  if (ACCOUNT_LABEL) url.searchParams.set("label", ACCOUNT_LABEL);
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-api-key": CF_TOKEN, authorization: "Bearer " + CF_TOKEN },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api/pg/credentials → ${res.status} ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("凭据接口返回了非 JSON"); }
  return Array.isArray(json.credentials) ? json.credentials.filter((c) => Array.isArray(c.cookies)) : [];
}

async function reportStatus(id, status) {
  const res = await fetch(CF_BASE + "/api/pg/credentials/status", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CF_TOKEN,
      authorization: "Bearer " + CF_TOKEN,
    },
    body: JSON.stringify({ id, status }),
  });
  if (!res.ok) throw new Error(`回报状态失败 HTTP ${res.status}`);
}

// ==================== AIStudio2API 侧 ====================

async function importCredential(cred) {
  // 注意：AIStudio2API 的 `fingerprint` 字段是 **Camoufox(Firefox) 指纹配置**
  // （{firefox_version, locale, timezone, config:{"navigator.*":...}}），由它自己按账户生成；
  // 浏览器脚本采集的 Chrome 指纹格式不兼容，传过去会因 config 为空导致导入失败，所以绝不透传。
  // 源码核对：internal/api/pairing.go AccountStateInput、camoufoxnative.PersistAccountFingerprint。
  const fp = cred.fingerprint && typeof cred.fingerprint === "object" ? cred.fingerprint : null;
  const payload = {
    label: cred.label || "default",
    locale: fp?.language || LOCALE,
    timezone: fp?.timezone || TIMEZONE,
    // AIStudio2API 的 StateCookie 用 `expires`（秒），Playwright 的 storage_state 叫
    // `expirationDate`。这里做一次显式映射，别把两个字段混在一起。
    storage_state: {
      cookies: (cred.cookies || []).map(toStateCookie),
      origins: [],
    },
  };

  let token = await createPairingToken();
  let res = await postAccount(token, payload);
  if (res.status === 409) {
    if (!REIMPORT_EXISTING) {
      throw new Error("account_exists：账户已在 AIStudio2API 里存在。设置 REIMPORT_EXISTING=1 可删除后重建");
    }
    const id = await findAccountId(cred.label);
    if (!id) throw new Error("account_exists，但没在 /api/accounts 里找到对应账户");
    log(`账户已存在，删除后重建：${id}`);
    const del = await adminFetch(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!del.ok) throw new Error(`删除账户失败 HTTP ${del.status}`);
    token = await createPairingToken();
    res = await postAccount(token, payload);
  }
  if (res.status !== 201) {
    const text = await res.text().catch(() => "");
    throw new Error(`pairing/accounts → ${res.status} ${text.slice(0, 300)}`);
  }
}

function toStateCookie(cookie) {
  const expires = Number(cookie.expirationDate ?? cookie.expires);
  return {
    name: String(cookie.name || ""),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain || ".google.com"),
    path: String(cookie.path || "/"),
    expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
    httpOnly: !!cookie.httpOnly,
    secure: !!cookie.secure,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function normalizeSameSite(value) {
  const text = String(value || "").toLowerCase();
  if (text === "none") return "None";
  if (text === "strict") return "Strict";
  if (text === "lax") return "Lax";
  return ""; // AIStudio2API 允许空串；"unspecified" 会被判为非法
}

async function createPairingToken() {
  const res = await adminFetch("/api/pairing", { method: "POST" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /api/pairing → ${res.status} ${text.slice(0, 200)}`
      + "（本地实例需要 ADMIN_AUTH_ENABLED=false 的 loopback 访问，或设置 AISTUDIO_ADMIN_PASSWORD）");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("pairing 返回非 JSON"); }
  if (!json.token) throw new Error("pairing 响应缺少 token");
  return json.token;
}

async function postAccount(token, payload) {
  return fetch(AISTUDIO_BASE + "/api/pairing/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(payload),
  });
}

async function findAccountId(label) {
  const res = await adminFetch("/api/accounts");
  if (!res.ok) return "";
  const json = await res.json().catch(() => null);
  const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
  const wanted = String(label || "").trim().toLowerCase();
  const hit = accounts.find((a) => String(a.label || "").toLowerCase() === wanted)
    || accounts.find((a) => String(a.id || "").toLowerCase() === wanted);
  return hit?.id || "";
}

async function adminFetch(path, init = {}) {
  const cookie = await ensureSession();
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  return fetch(AISTUDIO_BASE + path, { ...init, headers });
}

async function ensureSession() {
  if (sessionCookie || !ADMIN_PASSWORD) return sessionCookie;
  const res = await fetch(AISTUDIO_BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`管理员登录失败 HTTP ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""];
  sessionCookie = cookies.map((line) => String(line).split(";")[0]).filter(Boolean).join("; ");
  return sessionCookie;
}

// ==================== 工具 ====================

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
    // 只接受 hash 表；旧格式/坏文件一律从空开始（最多多导一次）。
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, STATE_PATH);
}

function stripSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function short(hash) {
  return String(hash || "").slice(0, 12) || "-";
}

function log(message) {
  console.log(`[sync] ${new Date().toISOString()} ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("[sync] 致命错误：" + (e?.stack || e));
  process.exit(1);
});
