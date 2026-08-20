# 旅行经费工作台 · 全栈单镜像
# 后端 node（better-sqlite3）内置托管前端静态资源（public/），端口 3000 直出，
# 无需 nginx、无需前后端双容器；数据落在挂载卷 /data。
FROM node:20-alpine

# better-sqlite3 为原生模块，需要编译工具链
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY server/package.json server/package-lock.json ./
RUN npm install --omit=dev

# 后端代码 + 前端静态资源（app.js 通过 __dirname/../public 托管，须与 server/ 同层）
COPY server/ ./
COPY public/ ./public/

# 默认示例数据：首次启动由 entrypoint 复制到挂载卷（不覆盖已有数据）
COPY data/routes.json /opt/seed/routes.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
