/* 运行配置：全部来自环境变量，可被 docker-compose 覆盖 */
'use strict';
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  DB_FILE: process.env.DB_FILE || 'app.db',
  // HTTPS 反向代理（nginx 终结 TLS）时置 true，Cookie 才带 Secure
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  SESSION_TTL_MS: 30 * 24 * 3600 * 1000,   // 会话 30 天
  ONLINE_WINDOW_MS: 15 * 60 * 1000,        // 15 分钟无操作视为离线
  CODE_TTL_MS: 5 * 60 * 1000,              // 验证码 5 分钟
  CODE_DIGITS: 6,
  RATE_LIMIT: { sendCode: 5, login: 10, windowMs: 10 * 60 * 1000 },
  SEED_ADMIN: { username: 'admin', password: '123456', role: 'admin' }
};