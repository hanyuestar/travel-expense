/* 多用户版后端入口：http server + 路由分发 + 静态托管
 * 启动：node app.js（默认 3000，DATA_DIR 默认 ../data）
 * 前端由 nginx 托管，本服务只响应 /api/* 与健康检查 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const dbModule = require('./db');
const { send, fail, readBody, parseUrl } = require('./http');
const auth = require('./auth');
const routesApi = require('./routes_api');
const adminApi = require('./admin_api');

let db;
try {
  db = dbModule.initDb();
} catch (e) {
  console.error('[fatal] DB 初始化失败，阻止启动：', e.message);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req.url || '/');

  /* CORS/安全头 */
  res.setHeader('X-Content-Type-Options', 'nosniff');

  /* 健康检查 */
  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, ts: Date.now() });
  }

  /* 公开站点信息（无需登录） */
  if (url.pathname === '/api/public/site') {
    const s = db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
    return send(res, 200, {
      ok: true,
      data: {
        site_name: s.site_name || '旅行经费工作台',
        allow_register: !!s.allow_register,
        register_mode: s.register_mode || 'all',
        announce_text: s.announce_text || ''
      }
    });
  }

  /* API 路由 */
  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, 400, '请求体解析失败');
    }
    try {
      if (url.pathname.startsWith('/api/auth/')) {
        return await auth.handle(req, res, url, body);
      }
      if (url.pathname.startsWith('/api/routes')) {
        return await routesApi.handle(req, res, url, body);
      }
      if (url.pathname.startsWith('/api/admin')) {
        return await adminApi.handle(req, res, url, body);
      }
      return fail(res, 404, '接口不存在');
    } catch (e) {
      console.error('[api error]', url.pathname, e);
      return fail(res, 500, '服务器内部错误');
    }
  }

  /* 静态资源：仅当同时托管前端时启用（开发模式）；容器内由 nginx 承担 */
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  if (fs.existsSync(PUBLIC_DIR)) {
    let f = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC_DIR)) return send(res, 403, { ok: false, msg: 'forbidden' });
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
      };
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(data);
    }
    return send(res, 404, { ok: false, msg: 'not found' });
  }
  return send(res, 404, { ok: false, msg: 'not found' });
});

server.listen(config.PORT, () => {
  console.log(`[travel-expense] 多用户后端启动 :${config.PORT}，DB=${path.join(config.DATA_DIR, config.DB_FILE)}`);
});
