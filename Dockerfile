FROM node:alpine3.22

# 使用独立应用目录，避免部分容器平台挂载 /tmp 内存盘时清空代码
WORKDIR /app

# 设置生产环境标识
ENV NODE_ENV=production

# 1. 合并安装系统依赖并引入 tini 处理后台僵尸进程（不留 apk 缓存）
RUN apk upgrade --no-cache && \
    apk add --no-cache \
      tini \
      openssl \
      curl \
      ca-certificates \
      gcompat \
      iproute2 \
      coreutils \
      bash

# 2. 优先单独复制 package.json 以利用 Docker 缓存层
COPY package*.json ./

# 3. 仅安装生产依赖并清理 npm 缓存，大幅减小镜像体积
RUN npm install --omit=dev && \
    npm cache clean --force

# 4. 最后复制经常变动的业务代码（修改 index.js 不会触发上方重新安装）
COPY index.js index.html ./
RUN chmod +x index.js

EXPOSE 3000/tcp

# 使用 tini 作为 PID 1 守护进程，自动回收 Xray/Cloudflared 退出的后台子进程
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]