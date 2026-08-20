#!/bin/sh
# 容器入口：
#   1. 确保挂载卷 $DATA_DIR 存在
#   2. 首次启动从镜像 /opt/seed/routes.json 拷默认示例数据到挂载卷（不覆盖已有数据）
#   3. 启动后端 node server/app.js（端口 3000 由 PORT 控制；DATA_DIR 默认 /data）
#
# 日志策略：
#   - 后端 stdout/stderr 一边转回容器 stdout（docker logs 可实时看）
#   - 同时通过 tee 追加到 $DATA_DIR/logs/app.log（用户挂载卷即群晖 /volume1/docker/travel/logs/app.log）
#   - 修复部署运维痛点：docker logs 只保留容器最后一次启动的输出，滚屏丢失；
#     落盘文件保留历史所有输出，事后排查直接 `tail -n 500 /data/logs/app.log`
#
# 信号处理：
#   - docker stop 发 SIGTERM 给 entrypoint (PID 1)
#   - trap 转发给 node 子进程，node 优雅退出
#   - wait 把 node 退出码回传 docker

set -u

DATA_DIR="${DATA_DIR:-/data}"
LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/app.log"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# 首次启动写入默认示例数据（不覆盖）
if [ ! -f "$DATA_DIR/routes.json" ]; then
  cp /opt/seed/routes.json "$DATA_DIR/routes.json"
  echo "[entrypoint] seed routes.json -> $DATA_DIR/routes.json"
fi

# 启动标记
printf '[entrypoint %s] boot start (data=%s logs=%s)\n' \
  "$(date -u +%FT%TZ)" "$DATA_DIR" "$LOG_FILE" >> "$LOG_FILE"

# 启动后端 —— 关键：tee 把数据镜像两份
#   1) stdout → 容器 stdout → docker logs
#   2) append → $LOG_FILE → 挂载卷侧 /volume1/docker/travel/logs/app.log
node server/app.js "$@" 2>&1 | tee -a "$LOG_FILE" &
NODE_PID=$!

# 信号转发：docker stop → entrypoint 收到 SIGTERM → 转发给 node
#   重启后 trap 被 shell 自动重置，所以只在这里装一次
trap 'kill -TERM "$NODE_PID" 2>/dev/null || true; exit 0' TERM INT

# 等 node 退出，退出码透传给 docker（容器 exit code 准确反映 app 异常原因）
wait "$NODE_PID"
EXIT_CODE=$?

printf '[entrypoint %s] exit %s\n' "$(date -u +%FT%TZ)" "$EXIT_CODE" >> "$LOG_FILE"
exit "$EXIT_CODE"
