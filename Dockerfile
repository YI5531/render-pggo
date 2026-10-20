# Render 免费容器：AIStudio2API (WAA_BACKEND=go) + D1 凭证同步 + /egress 中继
# 构建步骤对照上游 Dockerfile（Mag1cFall/AIStudio2API）核对：
#  - 入口是 ./cmd/aistudio2api（不是 cmd/server）
#  - go.mod 要求 go 1.26
#  - internal/webui/dist 不入库，必须先 npm 构建前端再 go build（//go:embed）
FROM node:22-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG AISTUDIO2API_REF=main
RUN git clone --depth=1 --branch ${AISTUDIO2API_REF} https://github.com/Mag1cFall/AIStudio2API.git /src
WORKDIR /src/web
RUN npm ci && npm run build

FROM golang:1.26-bookworm AS build
COPY --from=web /src /src
WORKDIR /src
COPY --from=web /src/internal/webui/dist internal/webui/dist
RUN go mod download && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/aistudio2api ./cmd/aistudio2api

# WAA_BACKEND=go 运行时不下载/不启动浏览器，不需要 GTK/Xvfb 等库
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Shanghai
COPY --from=build /out/aistudio2api /usr/local/bin/aistudio2api
WORKDIR /app
COPY sync.mjs /app/pg-node/sync.mjs
COPY start.mjs /app/start.mjs
RUN mkdir -p /data
EXPOSE 10000
CMD ["node", "/app/start.mjs"]
