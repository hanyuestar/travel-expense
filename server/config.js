/* 运行配置：全部来自环境变量，可被 docker-compose 覆盖 */
'use strict';
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  DB_FILE: process.env.DB_FILE || 'app.db',
  // HTTPS 反向代理（nginx 终结 TLS）时置 true，Cookie 才带 Secure
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  SESSION_TTL_MS: 30 * 24 * 3600 * 1000,   // 会话 30 天（服务端校验，过期自动失效）
  ONLINE_WINDOW_MS: 15 * 60 * 1000,        // 15 分钟无操作视为离线
  CODE_TTL_MS: 5 * 60 * 1000,              // 验证码 5 分钟
  CODE_DIGITS: 6,
  RATE_LIMIT: { sendCode: 5, login: 10, loginByIp: 30, windowMs: 10 * 60 * 1000 },
  SEED_ADMIN: { username: 'admin', password: '123456', role: 'admin' },
  // 可选：实时汇率 API（返回 { rates: { USD: 7.15, ... } } 或扁平 { USD: 7.15 }）
  FX_API_URL: process.env.FX_API_URL || '',
  FX_REFRESH_INTERVAL_MS: 6 * 3600 * 1000, // 汇率刷新间隔 6 小时
  // 可选：可信主机名列表（逗号分隔），配置后 CSRF 校验严格匹配 Host；未配置则用请求 Host
  TRUSTED_HOSTS: (process.env.TRUSTED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // 访问日志：默认开启，设 false 关闭
  ACCESS_LOG: process.env.ACCESS_LOG !== 'false',
  // HSTS：仅在 COOKIE_SECURE=true 时生效
  HSTS_MAX_AGE: process.env.HSTS_MAX_AGE || '31536000'
};
