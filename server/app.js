/* 多用户版后端入口：http server + 路由分发 + 静态托管（前端由后端内置托管，单容器）
 * 启动：node app.js（默认 3000，DATA_DIR 默认 ../data）
 * 端口 3000 直出前端静态资源 + /api/* + /health + /share/:token */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const dbModule = require('./db');
const fx = require('./fx');
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

/* ---------- 实时汇率：启动时刷新 + 定时刷新（仅配置 FX_API_URL 时启用） ---------- */
async function refreshFx() {
  if (!config.FX_API_URL) return;
  try {
    const ok = await fx.refreshFromApi(config.FX_API_URL, 4000);
    if (ok) console.log('[fx] 实时汇率已刷新');
  } catch (e) { console.error('[fx] 汇率刷新失败，使用静态兜底:', e.message); }
}
refreshFx();
const fxTimer = setInterval(refreshFx, config.FX_REFRESH_INTERVAL_MS);
fxTimer.unref(); // 不阻止进程退出

/* ---------- 安全响应头（所有响应统一设置） ---------- */
function buildSecurityHeaders() {
  /* 开启跨域客户端（安卓 APP 等独立客户端）时放宽 connect-src：
     WebView 内的 SPA 需向用户自托管的 https 服务器发起跨域请求。
     WebView 本身不加载本服务的 CSP（SPA 由 capacitor://localhost 提供），
     此处放宽同时覆盖「浏览器内配置远程服务器」的客户端场景。 */
  const connectSrc = config.ALLOWED_ORIGINS.length > 0
    ? "connect-src 'self' https:;"
    : "connect-src 'self';";
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    /* CSP：script 仅同源（ES Modules 无内联脚本）；style 允许内联（大量 style 属性）；
       frame-ancestors 'none' 等价 X-Frame-Options DENY */
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ${connectSrc} frame-ancestors 'none'`
  };
  if (config.COOKIE_SECURE) {
    h['Strict-Transport-Security'] = `max-age=${config.HSTS_MAX_AGE}; includeSubDomains`;
  }
  return h;
}
function applySecurityHeaders(res) {
  const h = buildSecurityHeaders();
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

/* ---------- CORS：仅当配置 ALLOWED_ORIGINS 时启用（默认关闭，保持同源 Web 应用不变） ----------
 * 回显请求 Origin（支持带凭证的跨域）；OPTIONS 预检直接 204。 */
function applyCors(req, res) {
  if (config.ALLOWED_ORIGINS.length === 0) return false;
  const origin = (req.headers.origin || '').toLowerCase();
  if (!origin) return false;
  const allowAll = config.ALLOWED_ORIGINS.includes('*');
  if (!allowAll && !config.ALLOWED_ORIGINS.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/* ---------- 访问日志 ---------- */
function accessLog(req, res, startMs, statusCode) {
  if (!config.ACCESS_LOG) return;
  const dur = Date.now() - startMs;
  const ip = req.socket.remoteAddress || '-';
  console.log(`${ip} - ${req.method} ${req.url} -> ${statusCode} (${dur}ms)`);
}

/* 同源校验：写操作需 Origin/Referer 与 Host 同域；无来源头放行（curl/服务端调用）
 * 若配置 TRUSTED_HOSTS，则额外校验 Host 必须在可信列表中（防 Host 头伪造） */
function sameOrigin(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const host = (req.headers.host || '').toLowerCase();
  if (!host) return true;
  /* 跨域客户端来源：命中 ALLOWED_ORIGINS 视为可信，放行写操作（配合 CORS 头） */
  const origin = (req.headers.origin || '').toLowerCase();
  if (config.ALLOWED_ORIGINS.length > 0 && origin &&
      (config.ALLOWED_ORIGINS.includes('*') || config.ALLOWED_ORIGINS.includes(origin))) {
    return true;
  }
  /* 可信主机校验：配置后 Host 必须匹配可信域名（含端口） */
  if (config.TRUSTED_HOSTS.length > 0 && !config.TRUSTED_HOSTS.includes(host)) {
    return false;
  }
  const referer = req.headers.referer;
  if (!origin && !referer) return true;
  const sameHost = (u) => { try { return new URL(u).host.toLowerCase() === host; } catch { return false; } };
  if (origin) return sameHost(origin);
  return sameHost(referer);
}

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();
  applySecurityHeaders(res);
  /* CORS 预检/跨域头：若命中 ALLOWED_ORIGINS，OPTIONS 在此直接结束 */
  if (applyCors(req, res)) { accessLog(req, res, startMs, 204); return; }
  const url = parseUrl(req.url || '/');

  /* 健康检查（含 DB 连通性校验） */
  if (url.pathname === '/health') {
    let dbOk = false;
    try { db.prepare('SELECT 1').get(); dbOk = true; } catch (e) { /* db 不可用 */ }
    const status = dbOk ? 200 : 503;
    accessLog(req, res, startMs, status);
    return send(res, status, { ok: dbOk, ts: Date.now(), db: dbOk ? 'ok' : 'error' });
  }

  /* CSRF 同源加固：写操作（非 GET/HEAD/OPTIONS）要求 Origin/Referer 与 Host 同域
   * 无来源头（curl / 服务端调用 / 同源老客户端）放行，避免阻断合法请求与测试 */
  if (!sameOrigin(req)) {
    accessLog(req, res, startMs, 403);
    return fail(res, 403, '跨站请求被拒绝', { code: 'BAD_ORIGIN' });
  }

  /* 公开站点信息（无需登录） */
  if (url.pathname === '/api/public/site') {
    const s = readSiteSettings();
    accessLog(req, res, startMs, 200);
    return send(res, 200, {
      ok: true,
      data: {
        site_name: s.site_name || '旅行经费工作台',
        allow_register: !!s.allow_register,
        register_mode: s.register_mode || 'all',
        announce_text: s.announce_text || '',
        home_currency: s.home_currency || 'CNY',
        fx_rates: fx.ratesToCny,
        /* 币种符号表的唯一来源（fx.CURRENCY_SYMBOLS），前端复用避免与分享页分叉 */
        currency_symbols: fx.CURRENCY_SYMBOLS
      }
    });
  }

  /* 客户端探测：独立客户端（安卓 APP / 切换服务器）调用，确认该地址是 travel-expense 服务。
   * 返回结构与 /api/public/site 一致：data 内包业务字段。 */
  if (url.pathname === '/api/public/server-check') {
    const s = readSiteSettings();
    accessLog(req, res, startMs, 200);
    return send(res, 200, {
      ok: true,
      data: {
        isTravelExpense: true,
        site_name: s.site_name || '旅行经费工作台',
        allow_register: !!s.allow_register,
        register_mode: s.register_mode || 'all'
      }
    });
  }

  /* 只读分享页：/share/:token（无需登录，纯服务端渲染 + 转义） */
  const shareM = url.pathname.match(/^\/share\/([A-Za-z0-9]+)$/);
  if (shareM) {
    const r = dbModule.findRouteByShareToken(shareM[1]);
    if (!r) { accessLog(req, res, startMs, 404); return send(res, 404, { ok: false, msg: '分享不存在或已失效' }); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    accessLog(req, res, startMs, 200);
    return res.end(renderSharePage(r));
  }

  /* API 路由 */
  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      accessLog(req, res, startMs, 400);
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
      accessLog(req, res, startMs, 404);
      return fail(res, 404, '接口不存在');
    } catch (e) {
      console.error('[api error]', url.pathname, e);
      accessLog(req, res, startMs, 500);
      return fail(res, 500, '服务器内部错误');
    }
  }

  /* 静态资源：由后端内置托管（单容器部署，无需 nginx） */
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  if (fs.existsSync(PUBLIC_DIR)) {
    let f = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(PUBLIC_DIR)) { accessLog(req, res, startMs, 403); return send(res, 403, { ok: false, msg: 'forbidden' }); }
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ext = path.extname(f).toLowerCase();
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
      };
      /* 缓存策略：index.html 不缓存（确保更新即时生效）；JS/CSS 等静态资源缓存 5 分钟 */
      const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=300';
      const data = fs.readFileSync(f);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
      accessLog(req, res, startMs, 200);
      return res.end(data);
    }
    accessLog(req, res, startMs, 404);
    return send(res, 404, { ok: false, msg: 'not found' });
  }
  accessLog(req, res, startMs, 404);
  return send(res, 404, { ok: false, msg: 'not found' });
});

server.listen(config.PORT, () => {
  console.log(`[travel-expense] 多用户后端启动 :${config.PORT}，DB=${path.join(config.DATA_DIR, config.DB_FILE)}`);
});

/* ---------- 优雅关闭：SIGTERM/SIGINT → 停止接受新连接 → 关闭 DB → 退出 ---------- */
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，开始优雅关闭...`);
  server.close(() => {
    try { db.close(); } catch (e) { /* ignore */ }
    console.log('[shutdown] 服务已关闭');
    process.exit(0);
  });
  /* 兜底：10 秒后强制退出 */
  setTimeout(() => { console.error('[shutdown] 优雅关闭超时，强制退出'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/* ---------- 只读分享页渲染 ---------- */
function esc(s) {
  return (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* JPY 用 JP¥ 区分 CNY 的 ¥；日元无小数 */
const JPY_ZERO_DECIMAL = new Set(['JPY', 'KRW']);
function money(n, cur) {
  /* 符号表直接复用 fx.CURRENCY_SYMBOLS（前端经 /api/public/site 下发同一份），删除本地私有副本 */
  const curUp = (cur || 'CNY').toUpperCase();
  const s = fx.CURRENCY_SYMBOLS[curUp] || (cur || 'CNY');
  const v = parseFloat(n);
  const fracDigits = JPY_ZERO_DECIMAL.has(curUp) ? 0 : 2;
  const num = isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: fracDigits, minimumFractionDigits: 0 }) : '0';
  return s + num;
}

/* 站点设置读取（/api/public/site 与 /api/public/server-check 共用，避免重复查询） */
function readSiteSettings() {
  return db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
}
function renderSharePage(r) {
  const rows = [];
  const row = (k, v) => `<tr><td class="k">${esc(k)}</td><td>${v}</td></tr>`;
  const t = dbModule.EXP_KEYS.reduce((s, c) => s + dbModule.num(r.exp[c]), 0);
  rows.push(row('年份 / 类型', esc(r.year || '') + (r.type ? ' · ' + esc(r.type) : '')));
  rows.push(row('出行日期', esc(r.daterange || '') + (r.days ? '（' + esc(r.days) + '天）' : '')));
  rows.push(row('目的地', r.dest ? esc(r.dest) : '—'));
  rows.push(row('住宿', r.hotel ? esc(r.hotel) : '—'));
  rows.push(row('总花费', money(t, r.currency)));
  if (dbModule.num(r.budget_total) > 0) {
    const b = dbModule.num(r.budget_total);
    const over = t > b;
    rows.push(row('预算', money(b, r.currency) + (over ? ` <span class="over">（超支 ${money(t - b, r.currency)}）</span>` : `（剩余 ${money(b - t, r.currency)}）`)));
  }
  const expRows = dbModule.EXP_KEYS
    .filter(c => dbModule.num(r.exp[c]) > 0)
    .map(c => `<tr><td class="k">${esc(c)}</td><td>${money(r.exp[c], r.currency)}</td></tr>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(r.name)} · 旅行经费分享</title>
<style>
  body{margin:0;background:#f4f8f6;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2d2b}
  .wrap{max-width:640px;margin:0 auto;padding:28px 16px 60px}
  .card{background:#fff;border:1px solid #dcebe6;border-radius:16px;padding:22px;box-shadow:0 4px 18px rgba(31,45,43,.06)}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#6b7d79;font-size:13px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  td{padding:9px 4px;border-bottom:1px dashed #e3efeb;vertical-align:top}
  td.k{color:#6b7d79;width:110px;white-space:nowrap}
  .over{color:#d64545;font-weight:600}
  .exp{margin-top:16px}
  .exp h2{font-size:15px;margin:0 0 6px}
  .pre{white-space:pre-wrap;word-break:break-word;background:#f7fbfa;border-radius:10px;padding:10px;font-size:13px;line-height:1.7;margin-top:6px}
  .foot{text-align:center;color:#9db4ae;font-size:12px;margin-top:22px}
</style></head><body><div class="wrap">
  <div class="card">
    <h1>${esc(r.name)}</h1>
    <div class="sub">${esc(r.dest || '旅行路线')} · 只读分享</div>
    <table>${rows.join('')}</table>
    ${r.scenic ? `<div class="exp"><h2>景点路线</h2><div class="pre">${esc(r.scenic)}</div></div>` : ''}
    <div class="exp"><h2>花费明细（${t > 0 ? money(t, r.currency) : '暂无'}）</h2>
      ${expRows ? `<table>${expRows}</table>` : '<div class="pre">暂无花费数据</div>'}
    </div>
    ${r.notes ? `<div class="exp"><h2>备注</h2><div class="pre">${esc(r.notes)}</div></div>` : ''}
  </div>
  <div class="foot">由旅行经费工作台生成 · 数据可能随时更新</div>
</div></body></html>`;
}
