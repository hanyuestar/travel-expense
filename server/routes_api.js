/* 路线 API：CRUD（owner 隔离 + 种子示例全员可见/只读）+ 统计
 * 鉴权：requireAuth 之后调用；req.user 已注入 */
'use strict';
const crypto = require('crypto');
const { fail, ok, created, escapeLike } = require('./http');
const dbModule = require('./db');
const { authFromReq } = require('./auth');
const { toCsv } = require('./csv');

const db = () => dbModule.db;
const fx = require('./fx');

/* 本位币（站点设置，默认 CNY） */
function homeCurrency() {
  const s = db().prepare('SELECT home_currency FROM site_settings WHERE id = 1').get();
  return (s && s.home_currency) || 'CNY';
}

/* 路由行投影列：与 db.js 单一来源，避免分叉缺列 */
const ROUTE_COLS = dbModule.ROUTE_COLS;

/* 个人导出 CSV 列头（与导入字段对应，可往返） */
const CSV_HEAD = ['name', 'year', 'type', 'daterange', 'start_date', 'end_date', 'days', 'people', 'dest',
  'currency', 'budget_total', 'budget_daily'].concat(dbModule.EXP_KEYS, ['scenic', 'hotel', 'notes']);

/* 查询本人+种子（含个人隐藏开关过滤种子）；返回全量行（统计用） */
function queryRoutes(userId, { year, q, hideSeed }) {
  const args = [userId];
  let where = `(owner_id = ?`;
  if (!hideSeed) where += ` OR is_seed = 1`;
  where += `)`;
  /* 隐藏系统示例：排除所有 is_seed=1 的示例路线（与所有者无关，
   * 否则种子路线归 admin 所有时，管理员勾选「隐藏系统示例」无效） */
  if (hideSeed) where += ` AND is_seed = 0`;
  if (year) { where += ` AND year = ?`; args.push(String(year)); }
  if (q) {
    where += ` AND (name LIKE ? ESCAPE '\\' OR dest LIKE ? ESCAPE '\\' OR scenic LIKE ? ESCAPE '\\')`;
    const like = `%${escapeLike(q)}%`; args.push(like, like, like);
  }
  return db().prepare(`SELECT ${ROUTE_COLS} FROM routes WHERE ${where} ORDER BY year DESC, created_at DESC`).all(...args);
}

/* 列表（分页）：返回 {rows, total, page, pageSize} */
function listForUser(userId, { year, q, hideSeed, page, pageSize }) {
  const rows = queryRoutes(userId, { year, q, hideSeed });
  const total = rows.length;
  const lim = Math.min(200, Math.max(1, parseInt(pageSize) || 50));
  const pg = Math.max(1, parseInt(page) || 1);
  const slice = rows.slice((pg - 1) * lim, (pg - 1) * lim + lim);
  return { rows: slice, total, page: pg, pageSize: lim };
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

  /* GET /api/routes 列表（分页） */
  if (rest === '' && method === 'GET') {
    const hideSeed = query.hideSeed === '1';
    const { rows, total, page, pageSize } = listForUser(user.id, {
      year: query.year || '',
      q: query.q || '',
      hideSeed,
      page: query.page,
      pageSize: query.pageSize
    });
    return ok(res, { list: rows.map(r => dbModule.routeToJson(r)), total, page, pageSize });
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

  /* GET /api/routes/export?fmt=csv|json — 个人导出（仅本人数据，不含示例） */
  if (rest === '/export' && method === 'GET') {
    const rows = queryRoutes(user.id, { year: query.year || '', q: '', hideSeed: true });
    if (query.fmt === 'json') return ok(res, { count: rows.length, routes: rows.map(r => dbModule.routeToJson(r)) });
    const head = CSV_HEAD;
    const data = rows.map(r => {
      const j = dbModule.routeToJson(r);
      return CSV_HEAD.map(h => {
        if (dbModule.EXP_KEYS.includes(h)) return dbModule.num(j.exp[h]);
        if (h === 'days' || h === 'people' || h === 'budget_total' || h === 'budget_daily') return dbModule.num(j[h]);
        return j[h];
      });
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="travel-expense.csv"'
    });
    return res.end(toCsv(head, data));
  }

  /* POST /api/routes/import — 个人 JSON 导入（新增为本人路线，仅白名单字段，按名称+年份+目的地去重） */
  if (rest === '/import' && method === 'POST') {
    if (!body || !Array.isArray(body.routes)) return fail(res, 400, '格式应为 { routes: [...] }');
    if (body.routes.length > 2000) return fail(res, 400, '单次导入上限 2000 条');
    let created = 0, skipped = 0, duplicates = 0;
    const errors = [];
    /* 构建已存在的 key 集合用于去重（name|year|dest） */
    const existing = new Set(
      db().prepare('SELECT name, year, dest FROM routes WHERE owner_id = ?').all(user.id)
        .map(r => `${r.name || ''}|${r.year || ''}|${r.dest || ''}`)
    );
    const seenInBatch = new Set();
    body.routes.forEach((item, i) => {
      if (!item || typeof item !== 'object' || !String(item.name || '').trim()) {
        skipped++; errors.push('第 ' + (i + 1) + ' 条缺少名称，已跳过');
        return;
      }
      const key = `${String(item.name).trim()}|${String(item.year || '').trim()}|${String(item.dest || '').trim()}`;
      if (existing.has(key) || seenInBatch.has(key)) {
        duplicates++;
        return;
      }
      seenInBatch.add(key);
      const clean = {
        name: String(item.name), year: String(item.year || ''), type: String(item.type || '自由行'),
        daterange: String(item.daterange || ''), start_date: String(item.start_date || ''), end_date: String(item.end_date || ''),
        days: parseInt(item.days) || 0, people: parseInt(item.people) || 0,
        dest: String(item.dest || ''), scenic: String(item.scenic || ''), hotel: String(item.hotel || ''),
        currency: String(item.currency || 'CNY'), budget_total: dbModule.num(item.budget_total), budget_daily: dbModule.num(item.budget_daily),
        exp: (item.exp && typeof item.exp === 'object') ? item.exp : {},
        notes: String(item.notes || '')
      };
      dbModule.insertRoute(user.id, clean, false);
      existing.add(key);
      created++;
    });
    return ok(res, { created, skipped, duplicates, errors });
  }

  /* /:id 详情/更新/删除 + /:id/share 只读分享 */
  if (rest.startsWith('/')) {
    const isShare = rest.endsWith('/share');
    const id = decodeURIComponent((isShare ? rest.slice(0, -6) : rest).slice(1));
    if (!id) return fail(res, 404, '路线不存在');
    const row = findVisible(id, user.id);
    if (!row) return fail(res, 404, '路线不存在');

    /* 分享令牌管理：仅本人或管理员 */
    if (isShare) {
      const own = row.owner_id === user.id || user.role === 'admin';
      if (method === 'GET') {
        if (!own) return fail(res, 403, '无权查看该路线的分享', { code: 'FORBIDDEN' });
        return ok(res, { token: dbModule.getShareToken(id) });
      }
      if (method === 'POST') {
        if (!own) return fail(res, 403, '无权分享该路线', { code: 'FORBIDDEN' });
        const token = crypto.randomBytes(16).toString('hex');
        dbModule.setShareToken(id, token);
        return ok(res, { token });
      }
      if (method === 'DELETE') {
        if (!own) return fail(res, 403, '无权取消该路线的分享', { code: 'FORBIDDEN' });
        dbModule.clearShareToken(id);
        return ok(res, true);
      }
      return fail(res, 404, '接口不存在');
    }

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
  const home = homeCurrency();
  const rows = queryRoutes(user.id, { year, hideSeed });
  const byYear = {};
  const totals = {};
  CATS.forEach(c => (totals[c] = 0));
  let grand = 0, count = 0, days = 0;
  for (const r of rows) {
    const y = r.year || '未标注';
    if (!byYear[y]) byYear[y] = { year: y, count: 0, days: 0, total: 0, exp: {} };
    const e = dbModule.routeToJson(r).exp;
    const cur = r.currency || 'CNY';
    let t = 0;
    for (const c of CATS) {
      const conv = fx.convert(dbModule.num(e[c]), cur, home).value;
      byYear[y].exp[c] = (byYear[y].exp[c] || 0) + conv;
      totals[c] += conv; t += conv;
    }
    byYear[y].total += t; byYear[y].count += 1; byYear[y].days += (r.days || 0);
    grand += t; count += 1; days += (r.days || 0);
  }
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  let budgetTotal = 0;
  for (const r of rows) budgetTotal += fx.convert(dbModule.num(r.budget_total), r.currency || 'CNY', home).value;
  const remaining = budgetTotal - grand;
  return ok(res, {
    grand, count, days,
    totalByCat: totals,
    byYear: years.map(y => byYear[y]),
    years,
    homeCurrency: home,
    budgetTotal,
    remaining,
    overBudget: grand > budgetTotal && budgetTotal > 0
  });
}

function statsTrend(res, user, query) {
  const hideSeed = query.hideSeed === '1';
  const year = query.year || '';
  const home = homeCurrency();
  const rows = queryRoutes(user.id, { year, hideSeed });
  // 筛选全部年份 → 按年聚合，呈现年消费趋势（标签为具体年份，如 2024）
  if (!year) {
    const byYear = {};
    for (const r of rows) {
      let key = null;
      if (r.start_date) key = r.start_date.slice(0, 4);
      else { const d = parseDate(r.daterange, r.year); if (d) key = String(d.year); }
      if (!key) key = String(r.year || '未标注');
      const t = dbModule.routeToJson(r).exp;
      const cur = r.currency || 'CNY';
      let sum = 0;
      for (const c of CATS) sum += fx.convert(dbModule.num(t[c]), cur, home).value;
      if (!byYear[key]) byYear[key] = { period: key, label: key, total: 0 };
      byYear[key].total += sum;
    }
    const years = Object.keys(byYear).sort();
    return ok(res, years.map(y => byYear[y]));
  }
  // 筛选具体年份 → 按该年月份聚合，呈现月消费趋势（标签为 MM月）
  const byMonth = {};
  for (const r of rows) {
    let key = null;
    if (r.start_date) key = r.start_date.slice(0, 7);
    else { const d = parseDate(r.daterange, r.year); if (d) key = d.year + '-' + String(d.month).padStart(2, '0'); }
    if (!key) continue;
    const t = dbModule.routeToJson(r).exp;
    const cur = r.currency || 'CNY';
    let sum = 0;
    for (const c of CATS) sum += fx.convert(dbModule.num(t[c]), cur, home).value;
    if (!byMonth[key]) byMonth[key] = { period: key, label: key.slice(5) + '月', total: 0 };
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
