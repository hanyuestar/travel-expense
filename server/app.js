/* 多用户版后端入口：http server + 路由分发 + 静态托管
 * 启动：node app.js（默认 3000，DATA_DIR 默认 ../data）
 * 前端由 nginx 托管，本服务只响应 /api/* 与健康检查 */
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

/* 同源校验：写操作需 Origin/Referer 与 Host 同域；无来源头放行（curl/服务端调用） */
function sameOrigin(req) {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const host = req.headers.host;
  if (!host) return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (!origin && !referer) return true;
  const sameHost = (u) => { try { return new URL(u).host === host; } catch { return false; } };
  if (origin) return sameHost(origin);
  return sameHost(referer);
}

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req.url || '/');

  /* CORS/安全头 */
  res.setHeader('X-Content-Type-Options', 'nosniff');

  /* 健康检查 */
  if (url.pathname === '/health') {
    return send(res, 200, { ok: true, ts: Date.now() });
  }

  /* CSRF 同源加固：写操作（非 GET/HEAD/OPTIONS）要求 Origin/Referer 与 Host 同域
   * 无来源头（curl / 服务端调用 / 同源老客户端）放行，避免阻断合法请求与测试 */
  if (!sameOrigin(req)) {
    return fail(res, 403, '跨站请求被拒绝', { code: 'BAD_ORIGIN' });
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
        announce_text: s.announce_text || '',
        home_currency: s.home_currency || 'CNY',
        fx_rates: fx.ratesToCny
      }
    });
  }

  /* 只读分享页：/share/:token（无需登录，纯服务端渲染 + 转义） */
  const shareM = url.pathname.match(/^\/share\/([A-Za-z0-9]+)$/);
  if (shareM) {
    const r = dbModule.findRouteByShareToken(shareM[1]);
    if (!r) return send(res, 404, { ok: false, msg: '分享不存在或已失效' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderSharePage(r));
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

/* ---------- 只读分享页渲染 ---------- */
function esc(s) {
  return (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, cur) {
  const SYM = { CNY: '¥', HKD: 'HK$', MOP: 'MOP$', TWD: 'NT$', USD: '$', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', THB: '฿', SGD: 'S$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'Fr', MYR: 'RM' };
  const s = SYM[(cur || 'CNY').toUpperCase()] || (cur || 'CNY');
  const v = parseFloat(n);
  const num = isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
  return s + num;
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
