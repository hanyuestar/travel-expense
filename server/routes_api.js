/* 路线 API：CRUD（owner 隔离 + 种子示例全员可见/只读）+ 统计
 * 鉴权：requireAuth 之后调用；req.user 已注入 */
'use strict';
const { fail, ok, created } = require('./http');
const dbModule = require('./db');
const { authFromReq } = require('./auth');

const db = () => dbModule.db;

const ROUTE_COLS = `id, owner_id, is_seed, year, name, daterange, type, days, people, dest, scenic, hotel,
  exp_traffic, exp_flight, exp_train, exp_hotel, exp_meal, exp_ticket, exp_group, exp_shopping, exp_other, notes, created_at, updated_at`;

/* 查询本人+种子（含个人隐藏开关过滤种子） */
function listForUser(userId, { year, q, hideSeed }) {
  let sql = `SELECT ${ROUTE_COLS} FROM routes WHERE (owner_id = ?`;
  const args = [userId];
  if (!hideSeed) sql += ` OR is_seed = 1`;
  sql += `)`;
  if (year) { sql += ` AND year = ?`; args.push(String(year)); }
  if (q) {
    sql += ` AND (name LIKE ? OR dest LIKE ? OR scenic LIKE ?)`;
    const like = `%${q}%`; args.push(like, like, like);
  }
  sql += ` ORDER BY year DESC, created_at DESC`;
  return db().prepare(sql).all(...args);
}

function findVisible(id, userId) {
  return db().prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE id = ? AND (owner_id = ? OR is_seed = 1)`)
    .get(id, userId) || null;
}

async function handle(req, res, url, body) {
  const user = authFromReq(req);
  if (!user) return fail(res, 401, '请先登录', { code: 'UNAUTHORIZED' });

  const { pathname, query } = url;
  const rest = pathname.slice('/api/routes'.length); // '' | '/xxx' | '/stats/summary' ...
  const method = req.method;

  /* 统计接口优先 */
  if (rest === '/stats/summary') return statsSummary(res, user, query);
  if (rest === '/stats/trend') return statsTrend(res, user, query);

  /* GET /api/routes 列表 */
  if (rest === '' && method === 'GET') {
    const hideSeed = query.hideSeed === '1';
    const list = listForUser(user.id, {
      year: query.year || '',
      q: query.q || '',
      hideSeed
    }).map(r => dbModule.routeToJson(r));
    return ok(res, list);
  }

  /* POST /api/routes 新建 */
  if (rest === '' && method === 'POST') {
    if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
    if (!String(body.name || '').trim()) return fail(res, 400, '请填写路线名称');
    const rec = dbModule.insertRoute(user.id, body, false);
    return created(res, rec);
  }

  /* DELETE /api/routes 清空本人全部 */
  if (rest === '' && method === 'DELETE') {
    db().prepare('DELETE FROM routes WHERE owner_id = ? AND is_seed = 0').run(user.id);
    return ok(res, true);
  }

  /* /:id 详情/更新/删除 */
  if (rest.startsWith('/')) {
    const id = decodeURIComponent(rest.slice(1));
    if (!id) return fail(res, 404, '路线不存在');
    const row = findVisible(id, user.id);
    if (!row) return fail(res, 404, '路线不存在');

    if (method === 'GET') {
      return ok(res, dbModule.routeToJson(row));
    }

    /* 写操作：种子示例对普通用户只读；管理员可管理种子 */
    if (row.is_seed && user.role !== 'admin') {
      return fail(res, 403, '示例路线为系统数据，仅可查看', { code: 'FORBIDDEN' });
    }
    const isOwn = row.owner_id === user.id || user.role === 'admin';

    if (method === 'PUT') {
      if (!isOwn) return fail(res, 403, '无权修改该路线', { code: 'FORBIDDEN' });
      if (!body || typeof body !== 'object') return fail(res, 400, '参数不正确');
      if (!String(body.name || '').trim()) return fail(res, 400, '请填写路线名称');
      const rec = dbModule.updateRoute(id, row.owner_id, body);
      return ok(res, rec);
    }
    if (method === 'DELETE') {
      if (!isOwn) return fail(res, 403, '无权删除该路线', { code: 'FORBIDDEN' });
      db().prepare('DELETE FROM routes WHERE id = ?').run(id);
      return ok(res, true);
    }
  }

  return fail(res, 404, '接口不存在');
}

/* ---------- 统计 ---------- */
const CATS = dbModule.EXP_KEYS; // ['交通','机票',...]

function statsSummary(res, user, query) {
  const hideSeed = query.hideSeed === '1';
  const year = query.year || '';
  const rows = listForUser(user.id, { year, hideSeed });
  const byYear = {};
  const totals = {};
  CATS.forEach(c => (totals[c] = 0));
  let grand = 0, count = 0, days = 0;
  for (const r of rows) {
    const y = r.year || '未标注';
    if (!byYear[y]) byYear[y] = { year: y, count: 0, days: 0, total: 0, exp: {} };
    const e = dbModule.routeToJson(r).exp;
    let t = 0;
    for (const c of CATS) {
      const v = dbModule.num(e[c]);
      byYear[y].exp[c] = (byYear[y].exp[c] || 0) + v;
      totals[c] += v; t += v;
    }
    byYear[y].total += t; byYear[y].count += 1; byYear[y].days += (r.days || 0);
    grand += t; count += 1; days += (r.days || 0);
  }
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  return ok(res, {
    grand, count, days,
    totalByCat: totals,
    byYear: years.map(y => byYear[y]),
    years
  });
}

function statsTrend(res, user, query) {
  const hideSeed = query.hideSeed === '1';
  const rows = listForUser(user.id, { hideSeed });
  const byMonth = {};
  for (const r of rows) {
    const d = parseDate(r.daterange, r.year);
    if (!d) continue;
    const key = d.year + '-' + String(d.month).padStart(2, '0');
    const t = dbModule.routeToJson(r).exp;
    let sum = 0;
    for (const c of CATS) sum += dbModule.num(t[c]);
    if (!byMonth[key]) byMonth[key] = { month: key, total: 0 };
    byMonth[key].total += sum;
  }
  const months = Object.keys(byMonth).sort();
  return ok(res, months.map(m => byMonth[m]));
}

/* 解析 daterange 起始日（兼容 M/D 与 YYYY/M/D） */
function parseDate(dr, year) {
  if (!dr) return null;
  let m = dr.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2] };
  m = dr.match(/(\d{1,2})[\/\-.](\d{1,2})/);
  if (m && year) return { year: +year, month: +m[1] };
  return null;
}

module.exports = { handle };
