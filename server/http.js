/* 通用 HTTP 工具：JSON 响应 / 请求体解析 / Cookie / URL 解析 */
'use strict';

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function ok(res, data) { send(res, 200, { ok: true, data }); }
function created(res, data) { send(res, 201, { ok: true, data }); }
function fail(res, code, msg, extra) {
  const body = { ok: false, msg };
  if (extra) Object.assign(body, extra);
  send(res, code, body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!b.trim()) return resolve({});
      try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) {
      const key = p.slice(0, i).trim();
      const rawVal = p.slice(i + 1).trim();
      try { out[key] = decodeURIComponent(rawVal); } catch (e) { out[key] = rawVal; }
    }
  });
  return out;
}
function parseUrl(raw) {
  const u = new URL(raw || '/', 'http://localhost');
  const query = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  return { pathname: u.pathname, query };
}

/* 转义 LIKE 通配符 % 和 _（防止用户输入被当作通配符），用户/路线搜索共用单一实现 */
function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

module.exports = { send, ok, created, fail, readBody, parseCookies, parseUrl, escapeLike };