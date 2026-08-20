#!/bin/sh
# 容器入口：确保数据目录存在，首次启动写入默认示例数据，再启动后端
# （后端 app.js 内置托管前端静态资源 /public，端口 3000 直出）
set -e

mkdir -p "$DATA_DIR"
[ -f "$DATA_DIR/routes.json" ] || cp /opt/seed/routes.json "$DATA_DIR/routes.json"

exec node app.js
