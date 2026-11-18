# Render 免费容器：AIStudio2API（WAA_BACKEND=spidermonkey）+ D1 凭证同步 + /egress 中继
#
# 2026-11-03 起不再从源码编译：上游 v0.2.18 换成 CGO + zig + SpiderMonkey 预编译库，
# 在 Render 免费档上从源码编译又慢又容易爆内存。官方镜像里的二进制是 `-static` 全静态链接，
# 直接拷进 node 镜像即可运行（SpiderMonkey 后端不需要 GTK/Xvfb 等浏览器依赖）。
#
# 升级：改 AISTUDIO2API_IMAGE 的 tag（ghcr.io/mag1cfall/aistudio2api 的 tags/list），
# 不要用 latest——Render 只在重新部署时拉取，latest 会让「哪个版本在线上」变得不可知。
ARG AISTUDIO2API_IMAGE=ghcr.io/mag1cfall/aistudio2api:v0.3.11
FROM ${AISTUDIO2API_IMAGE} AS upstream

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Shanghai
COPY --from=upstream /usr/local/bin/aistudio2api /usr/local/bin/aistudio2api
# 临时调试（2026-11-18）：指定 AISTUDIO2API_BIN_URL 时用该二进制覆盖官方二进制，并打开原始帧日志
ARG AISTUDIO2API_BIN_URL=https://github.com/YI5531/render-pggo/releases/download/rawdump-v0.3.11/aistudio2api
RUN if [ -n "$AISTUDIO2API_BIN_URL" ]; then apt-get update && apt-get install -y --no-install-recommends curl && curl -fsSL "$AISTUDIO2API_BIN_URL" -o /usr/local/bin/aistudio2api && chmod +x /usr/local/bin/aistudio2api && rm -rf /var/lib/apt/lists/*; fi
ENV A2A_RAWDUMP=1
WORKDIR /app
COPY sync.mjs /app/pg-node/sync.mjs
COPY start.mjs /app/start.mjs
RUN mkdir -p /data
EXPOSE 10000
CMD ["node", "/app/start.mjs"]
