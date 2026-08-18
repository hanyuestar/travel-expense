# 纯 Node 运行时，零 npm 依赖，镜像极小
FROM node:20-alpine

WORKDIR /app

# 只复制后端与静态资源（无需 npm install）
COPY package.json server.js ./
COPY public ./public

# 数据卷挂载点：宿主机目录映射到 /data，routes.json 持久化在此
ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server.js"]
